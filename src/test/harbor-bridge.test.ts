import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildBridgeResult, exportArtifacts, main, validateBridgeCycleConfig, validateMaxFixCycles } from "../harbor-bridge.js";
import type { RunOutcome } from "../orchestrator.js";

test("Full cap plumbing accepts only explicit non-negative integer maxFixCycles", () => {
  for (const value of [undefined, null, 0, 2, 10]) assert.doesNotThrow(() => validateMaxFixCycles(value));
  for (const value of [true, false, -1, 1.5, "0", {}, []]) {
    assert.throws(() => validateMaxFixCycles(value), /maxFixCycles must be a non-negative integer/);
  }
});

test("bridge result records requested and exact applied cycle cap", () => {
  const context = { maxFixCycles: 2 } as Parameters<typeof buildBridgeResult>[0];
  const outcome = { runId: "run-cap3", maxCycles: 3 } as RunOutcome;
  const result = buildBridgeResult(context, outcome, "start", "finish");
  assert.deepEqual(result.requestedConfiguration, { maxFixCycles: 2, cycleCap: 3, source: "harbor-agent-kwarg" });
  assert.deepEqual(result.effectiveConfiguration, {
    maxFixCycles: 2,
    cycleCap: 3,
    source: "orchestrator-outcome",
    evidenceRefs: ["artifacts/logs/artifacts/orchestrator-runs/run-cap3/summary.json#maxCycles"],
  });
});

test("canonical maxCycles is direct and conflicts with the deprecated alias", () => {
  assert.doesNotThrow(() => validateBridgeCycleConfig(null, null));
  assert.doesNotThrow(() => validateBridgeCycleConfig(1, undefined));
  assert.throws(() => validateBridgeCycleConfig(0, undefined), /maxCycles must be a positive integer/);
  assert.throws(() => validateBridgeCycleConfig(1, 0), /cannot both/);
  const result = buildBridgeResult({ maxCycles: 3 } as Parameters<typeof buildBridgeResult>[0], { runId: "run-cap3-canonical", maxCycles: 3 } as RunOutcome, "start", "finish");
  assert.deepEqual(result.requestedConfiguration, { maxCycles: 3, source: "harbor-agent-kwarg" });
  assert.equal(result.effectiveConfiguration.maxCycles, 3);
});

test("Harbor bridge help is read-only and rejects run-root", async () => {
  assert.equal(await main(["--help"]), 0);
  assert.equal(await main(["--run-root", "/tmp/ledger"]), 1);
  assert.equal(await main(["--handoff", "relative.json"]), 1);
});

test("Harbor bridge exports only allowlisted ledger files and no reward", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-bridge-artifacts-"));
  const repo = join(root, "repo");
  const logs = join(root, "logs", "agent");
  const artifacts = join(root, "logs", "artifacts");
  const runId = "run-1";
  const ledger = join(repo, ".orchestrator", "runs", runId);
  await mkdir(ledger, { recursive: true });
  await writeFile(join(ledger, "summary.json"), JSON.stringify({ status: "ready_for_main" }));
  await writeFile(join(ledger, "summary.md"), "# ready_for_main\n");
  await writeFile(join(ledger, "report.md"), "No verifier reward is available to the agent.\n");
  await writeFile(join(ledger, "run.json"), JSON.stringify({ runId }));
  await writeFile(join(ledger, "build-evidence-baseline.json"), JSON.stringify({ schemaVersion: "build-evidence-1", phase: "baseline", checks: [] }));
  await writeFile(join(ledger, "cycle-1-implementer.json"), JSON.stringify({ secret: "must-not-copy" }));

  await exportArtifacts({
    handoff: { repo, objective: "test", scope: { include: ["."] }, acceptanceCriteria: ["ok"], constraints: [], tests: ["true"], riskNotes: [], delivery: { mode: "direct_main", requireApproval: true } },
    context: {
      taskId: "org/task",
      datasetRef: "dataset",
      datasetRevision: "rev-1",
      taskDigest: "a".repeat(64),
      agentWorkdir: repo,
      agentLogDir: logs,
      artifactDir: artifacts,
      compatibility: { taskId: "org/task", verifierMode: "shared" },
    },
    outcome: {
      status: "ready_for_main", runId, tier: 1, cycles: 1, maxCycles: 3,
      routing: { tier: 1, confidence: 1, reasons: [], riskFlags: [] },
      cost: { total: 0, byRole: {} }, durationMs: 1,
      verification: { tests: [{ command: "true", passed: true }], reviewerVerdict: "pass", finalReviewerVerdict: "not_run" },
    },
    startedAt: "2026-08-21T00:00:00.000Z",
    finishedAt: "2026-08-21T00:00:00.001Z",
    agentLogDir: logs,
    artifactDir: artifacts,
  });

  const telemetry = JSON.parse(await readFile(join(logs, "full-dev-flow", "telemetry.json"), "utf8")) as Record<string, unknown>;
  assert.equal((telemetry.result as Record<string, unknown>).reward, null);
  assert.equal((telemetry.usage as Record<string, unknown>).inputTokens, null);
  assert.equal((telemetry.provenance as Record<string, unknown>).billingEvidence, false);
  assert.equal((telemetry.provenance as Record<string, unknown>).pricingEvidence, false);
  await assert.rejects(access(join(artifacts, "orchestrator-runs", runId, "cycle-1-implementer.json")));
  assert.deepEqual(JSON.parse(await readFile(join(artifacts, "orchestrator-runs", runId, "build-evidence-baseline.json"), "utf8")), { schemaVersion: "build-evidence-1", phase: "baseline", checks: [] });
});

test("Harbor bridge aggregates role and router usage without exporting prompts or turn_end duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-bridge-usage-"));
  const repo = join(root, "repo");
  const logs = join(root, "logs", "agent");
  const artifacts = join(root, "logs", "artifacts");
  const runId = "run-usage";
  const ledger = join(repo, ".orchestrator", "runs", runId);
  await mkdir(join(ledger, "router-initial"), { recursive: true });
  await mkdir(join(ledger, "cycle-1-router"), { recursive: true });
  await writeFile(join(ledger, "summary.json"), JSON.stringify({ status: "ready_for_main" }));
  const invocation = { model: "openai-codex/gpt-5.6-luna", reasoning: "medium", sessionDir: "/secret/session", tracePath: "/secret/trace.jsonl" };
  await writeFile(join(ledger, "cycle-1-implementer.json"), JSON.stringify({ prompt: "do not export", sessionMetadata: invocation, usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.1 } } }));
  await writeFile(join(ledger, "cycle-1-reviewer.json"), JSON.stringify({ sessionMetadata: invocation, usage: { input: 20, output: 7, cacheRead: 4, cacheWrite: 1, cost: { total: 0.2 } } }));
  const initialEvents = [
    { type: "message_end", id: "initial-1", model: "gpt-5.6-luna", provider: "openai-codex", thinking: "medium", message: { role: "assistant", usage: { input: 3, output: 1, cacheRead: 1, cacheWrite: 1, cost: { total: 0.03 } } } },
    { type: "turn_end", message: { role: "assistant", usage: { input: 3, output: 1, cacheRead: 1, cacheWrite: 1, cost: { total: 0.03 } } } },
    { type: "message_end", id: "initial-2", model: "gpt-5.6-luna", provider: "openai-codex", thinking: "medium", message: { role: "assistant", usage: { input: 3, output: 1, cacheRead: 1, cacheWrite: 1, cost: { total: 0.03 } } } },
  ];
  await writeFile(join(ledger, "router-initial", "events.jsonl"), `${initialEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await writeFile(join(ledger, "cycle-1-router", "events.jsonl"), `${JSON.stringify({ type: "message_end", id: "follow-up-1", model: "gpt-5.6-luna", provider: "openai-codex", thinking: "medium", usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 1, cost: { total: 0.04 } } })}\n`);
  await writeFile(join(ledger, "cycle-1-router", "trace.jsonl"), `${JSON.stringify({ type: "message_end", id: "follow-up-1", usage: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999, cost: { total: 9.99 } } })}\n`);

  await exportArtifacts({
    handoff: { repo, objective: "test", scope: { include: ["."] }, acceptanceCriteria: ["ok"], constraints: [], tests: ["true"], riskNotes: [], delivery: { mode: "direct_main", requireApproval: true } },
    context: { taskId: "org/task", datasetRef: "dataset", datasetRevision: "rev-1", taskDigest: "a".repeat(64), agentWorkdir: repo, agentLogDir: logs, artifactDir: artifacts, maxFixCycles: 2, requestedConfiguration: { maxFixCycles: 2 }, compatibility: { taskId: "org/task", verifierMode: "shared" } },
    outcome: { status: "ready_for_main", runId, tier: 1, cycles: 1, maxCycles: 3, routing: { tier: 1, confidence: 1, reasons: [], riskFlags: [] }, cost: { total: 0, byRole: {} }, durationMs: 1, verification: { tests: [{ command: "true", passed: true }], reviewerVerdict: "pass", finalReviewerVerdict: "not_run" } },
    startedAt: "2026-08-21T00:00:00.000Z",
    finishedAt: "2026-08-21T00:00:00.001Z",
    agentLogDir: logs,
    artifactDir: artifacts,
  });

  const telemetry = JSON.parse(await readFile(join(logs, "full-dev-flow", "telemetry.json"), "utf8")) as Record<string, unknown>;
  const usage = telemetry.usage as Record<string, unknown>;
  const configuration = telemetry.configuration as Record<string, unknown>;
  assert.equal(configuration.maxFixCycles, 2);
  assert.equal(configuration.cycleCap, 3);
  const orchestration = telemetry.orchestration as Record<string, unknown>;
  assert.equal((orchestration.requestedConfiguration as Record<string, unknown>).maxFixCycles, 2);
  assert.equal((orchestration.effectiveConfiguration as Record<string, unknown>).maxFixCycles instanceof Object, true);
  assert.equal(usage.inputTokens, 40);
  assert.equal(usage.outputTokens, 16);
  assert.equal(usage.cacheReadTokens, 8);
  assert.equal(usage.cacheWriteTokens, 5);
  assert.equal(usage.modelCallCount, 5);
  assert.equal(usage.actualCostUsd, null);
  assert.equal((telemetry.orchestration as Record<string, unknown>).usageByRole instanceof Array, true);
  assert.equal((telemetry.orchestration as Record<string, unknown>).usageByCycle instanceof Array, true);
  const calls = (telemetry.orchestration as Record<string, unknown>).calls as Array<Record<string, unknown>>;
  assert.equal(calls.length, 5);
  assert.equal(calls.every((call) => call.sessionId === null && (call.provenance as Record<string, unknown>).sourceRef?.toString().startsWith("/") === false), true);
  assert.equal(calls.every((call) => (call.session as Record<string, unknown>).mode === "unknown"), true);
  const effective = (telemetry.configuration as Record<string, unknown>).effective as Record<string, unknown>;
  assert.deepEqual(effective.maxFixCycles, { value: 2, status: "observed", source: "orchestrator-outcome", evidenceRefs: ["artifacts/logs/artifacts/orchestrator-runs/run-usage/summary.json#maxCycles"] });
  assert.deepEqual(effective.cycleCap, { value: 3, status: "observed", source: "orchestrator-outcome", evidenceRefs: ["artifacts/logs/artifacts/orchestrator-runs/run-usage/summary.json#maxCycles"] });
  assert.deepEqual(effective.model, { value: "openai-codex/gpt-5.6-luna", status: "observed", source: "derived-consistent-call-observations", evidenceRefs: calls.map((call) => (call.provenance as Record<string, unknown>).sourceRef) });
  assert.deepEqual(effective.reasoningEffort, { value: "medium", status: "observed", source: "derived-consistent-call-observations", evidenceRefs: calls.map((call) => (call.provenance as Record<string, unknown>).sourceRef) });
  assert.equal((effective.tier as Record<string, unknown>).status, "not-observed");
  const roleCall = calls.find((call) => call.role === "implementer")!;
  const routerCall = calls.find((call) => call.role === "router")!;
  assert.equal((((roleCall.effective as Record<string, unknown>).model as Record<string, unknown>).source), "adapter-invocation");
  assert.equal((((routerCall.effective as Record<string, unknown>).model as Record<string, unknown>).source), "runtime-event");
  const evidencePath = join(artifacts, "orchestrator-runs", runId, "call-evidence.json");
  const evidence = await readFile(evidencePath, "utf8");
  assert.equal((JSON.parse(evidence) as Record<string, unknown>).calls instanceof Array, true);
  assert.equal(evidence.includes("/secret/session"), false);
  assert.equal(evidence.includes("/secret/trace.jsonl"), false);
  assert.equal(evidence.includes("do not export"), false);
  assert.equal(calls.every((call) => (call.provenance as Record<string, unknown>).sourceRef?.toString().startsWith(`artifacts/logs/artifacts/orchestrator-runs/${runId}/call-evidence.json#calls[`)), true);
  const serialized = JSON.stringify(telemetry);
  assert.equal(serialized.includes("do not export"), false);
  assert.equal(serialized.includes("message_end"), false);
  assert.equal(serialized.includes("turn_end"), false);
});

test("Full effective configuration is conflict or unknown without runtime evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-bridge-effective-"));
  const repo = join(root, "repo");
  const logs = join(root, "logs", "agent");
  const artifacts = join(root, "logs", "artifacts");
  const runId = "run-effective";
  const ledger = join(repo, ".orchestrator", "runs", runId);
  await mkdir(ledger, { recursive: true });
  await writeFile(join(ledger, "cycle-1-implementer.json"), JSON.stringify({ sessionMetadata: { model: "openai-codex/gpt-5.6-luna", reasoning: "medium", tier: 1 }, usage: { input: 1, output: 1 } }));
  await writeFile(join(ledger, "cycle-1-reviewer.json"), JSON.stringify({ sessionMetadata: { model: "openai-codex/gpt-5.6-terra", reasoning: "high", tier: 1 }, usage: { input: 1, output: 1 } }));

  await exportArtifacts({
    handoff: { repo, objective: "test", scope: { include: ["."] }, acceptanceCriteria: ["ok"], constraints: [], tests: ["true"], riskNotes: [], delivery: { mode: "direct_main", requireApproval: true } },
    context: { taskId: "org/task", datasetRef: "dataset", datasetRevision: "rev-1", taskDigest: "a".repeat(64), agentWorkdir: repo, agentLogDir: logs, artifactDir: artifacts, requestedConfiguration: { model: "requested-model", reasoningEffort: "low", tier: 0, maxTier: 1 }, compatibility: { taskId: "org/task", verifierMode: "shared" } },
    outcome: { status: "ready_for_main", runId, tier: 1, cycles: 1, maxCycles: 3, routing: { tier: 1, confidence: 1, reasons: [], riskFlags: [] }, cost: { total: 0, byRole: {} }, durationMs: 1, verification: { tests: [{ command: "true", passed: true }], reviewerVerdict: "pass", finalReviewerVerdict: "not_run" } },
    startedAt: "2026-08-21T00:00:00.000Z",
    finishedAt: "2026-08-21T00:00:00.001Z",
    agentLogDir: logs,
    artifactDir: artifacts,
  });

  const telemetry = JSON.parse(await readFile(join(logs, "full-dev-flow", "telemetry.json"), "utf8")) as Record<string, unknown>;
  const effective = (telemetry.configuration as Record<string, unknown>).effective as Record<string, unknown>;
  assert.equal((effective.model as Record<string, unknown>).status, "conflict");
  assert.equal((effective.reasoningEffort as Record<string, unknown>).status, "conflict");
  assert.deepEqual(effective.tier, { value: null, status: "not-observed", source: "none", evidenceRefs: [] });
  assert.equal((effective.model as Record<string, unknown>).value, null);
  assert.equal(((telemetry.orchestration as Record<string, unknown>).requestedConfiguration as Record<string, unknown>).model, "requested-model");
});
