import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { aggregateBenchmarkTrials, readHarborArtifactDirectory, type BenchmarkTrialRecord } from "../benchmark/aggregate.js";
import { createHarborAtifFixtures } from "../benchmark/fixtures/harbor-atif.js";
import { normalizeBenchmarkArtifacts } from "../benchmark/telemetry.js";
import { readBenchmarkRunManifest } from "../benchmark/manifest.js";

test("aggregator preserves null metrics, separates cost evidence, and computes success rate", () => {
  const fixtures = createHarborAtifFixtures();
  const records = Object.values(fixtures).map((fixture): BenchmarkTrialRecord => ({
    artifactPath: "/fixture",
    telemetry: normalizeBenchmarkArtifacts(fixture),
    includeInComparison: true,
    validity: "valid",
    failureCategory: null,
    invalidReason: null,
    telemetryCompleteness: "complete",
  }));
  const aggregate = aggregateBenchmarkTrials(records);
  const codex = aggregate.byHarness["harbor-codex"];
  assert.equal(codex.successRate, 1);
  assert.equal(codex.estimatedCostUsd.sum, null, "generic fixture cost is not pricing evidence");
  assert.equal(codex.actualCostUsd.sum, null, "missing billing is not zero");
  assert.equal(codex.tokens.input.sum, 100);
  assert.equal(codex.tokens.cacheRead.sum, 25);
  assert.equal(codex.tokens.cacheWrite.sum, null);
  assert.equal(aggregate.byHarness["full-dev-flow"].successRate, null, "unknown verifier result is not a failure or pass");
});

test("aggregator reads Harbor raw result directories and accepts explicit cost overrides", async () => {
  const root = await mkdtemp(join("/tmp", "harbor-aggregate-test-"));
  try {
    await mkdir(join(root, "verifier"), { recursive: true });
    await writeFile(join(root, "config.json"), JSON.stringify({ agent: { name: "codex", model_name: "gpt-5.6-luna", kwargs: { reasoning_effort: "medium" } } }));
    await writeFile(join(root, "result.json"), JSON.stringify({ id: "trial-1", task_name: "regex-log", task_checksum: "a".repeat(64), verifier_result: { rewards: { reward: 1 } }, agent_result: { n_input_tokens: 10, n_cache_tokens: 4, n_output_tokens: 3 }, started_at: "2026-08-21T00:00:00Z", finished_at: "2026-08-21T00:00:02Z" }));
    const trial = await readHarborArtifactDirectory(root, { estimatedCostUsd: 0.25 });
    assert.equal(trial.telemetry.trial.harness, "harbor-codex");
    assert.equal(trial.telemetry.result.passed, true);
    assert.equal(trial.telemetry.result.durationMs, 2000);
    assert.equal(trial.telemetry.usage.estimatedCostUsd, 0.25);
    assert.equal(trial.telemetry.usage.actualCostUsd, null);
    const aggregate = aggregateBenchmarkTrials([trial]);
    assert.equal(aggregate.byHarness["harbor-codex"].estimatedCostUsd.sum, 0.25);
    assert.equal(aggregate.byHarness["harbor-codex"].actualCostUsd.sum, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aggregator ingests native Codex ATIF trajectory as effective model and canonical calls", async () => {
  const root = await mkdtemp(join("/tmp", "harbor-aggregate-codex-trajectory-test-"));
  try {
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(join(root, "config.json"), JSON.stringify({
      agent: { name: "codex", model_name: "gpt-5.6-luna", kwargs: { reasoning_effort: "medium" } },
    }));
    await writeFile(join(root, "result.json"), JSON.stringify({
      id: "trial-codex-trajectory",
      task_name: "prove-plus-comm",
      task_checksum: "a".repeat(64),
      verifier_result: { rewards: { reward: 1 } },
      agent_result: { n_input_tokens: 30, n_cache_tokens: 20, n_output_tokens: 5, cost_usd: 0.1 },
      started_at: "2026-08-22T00:00:00Z",
      finished_at: "2026-08-22T00:00:02Z",
    }));
    await writeFile(join(root, "agent", "trajectory.json"), JSON.stringify({
      schema_version: "ATIF-v1.7",
      session_id: "must-not-be-exported",
      agent: { name: "codex", version: "0.149.0", model_name: "gpt-5.6-luna" },
      steps: [
        { step_id: 1, source: "agent", metrics: { prompt_tokens: 12, completion_tokens: 3, cached_tokens: 8 } },
        { step_id: 2, source: "system" },
        { step_id: 3, source: "agent", metrics: { prompt_tokens: 18, completion_tokens: 2, cached_tokens: 12 } },
      ],
      final_metrics: { total_prompt_tokens: 30, total_completion_tokens: 5, total_cached_tokens: 20, total_steps: 3 },
    }));

    const trial = await readHarborArtifactDirectory(root);
    const telemetry = trial.telemetry;
    assert.equal(telemetry.configuration.effective.model.value, "gpt-5.6-luna");
    assert.equal(telemetry.configuration.effective.model.status, "observed");
    assert.deepEqual(telemetry.configuration.effective.reasoningEffort.status, "not-observed");
    assert.equal(telemetry.usage.modelCallCount, 2);
    assert.equal(telemetry.orchestration.calls.length, 2);
    assert.deepEqual(telemetry.orchestration.calls.map((call) => call.callId), ["trajectory-step-1", "trajectory-step-3"]);
    assert.deepEqual(telemetry.orchestration.calls.map((call) => call.usage.inputTokens), [12, 18]);
    assert.deepEqual(telemetry.orchestration.calls.map((call) => call.usage.cacheReadTokens), [8, 12]);
    assert.equal(telemetry.orchestration.calls.every((call) => call.effective.model.status === "observed"), true);
    assert.equal(telemetry.orchestration.calls.every((call) => call.sessionId === null && call.session.sessionId === null && call.session.scope === "call"), true);
    assert.equal(telemetry.orchestration.calls[0]?.provenance.source, "harbor-result");
    assert.equal(telemetry.orchestration.calls[0]?.provenance.sourceRef, "agent/trajectory.json#steps[0]");
    assert.equal(telemetry.derived.cacheSemantics.denominator, "unknown");
    assert.equal(telemetry.derived.cacheSemantics.derived.cacheHitRate, null);
    assert.equal(JSON.stringify(telemetry).includes("must-not-be-exported"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aggregator reads Harbor 0.20 agents array and distinguishes Single Pi", async () => {
  const root = await mkdtemp(join("/tmp", "harbor-aggregate-agent-array-test-"));
  try {
    await writeFile(join(root, "config.json"), JSON.stringify({ agents: [{ name: "harbor_full_dev_flow.agent:SinglePiSubscriptionAgent", model_name: "openai-codex/gpt-5.6-luna", kwargs: { thinking: "medium" } }] }));
    await writeFile(join(root, "result.json"), JSON.stringify({ id: "trial-pi", task_name: "prove-plus-comm", verifier_result: { rewards: { reward: 1 } } }));
    const trial = await readHarborArtifactDirectory(root);
    assert.equal(trial.telemetry.trial.harness, "single-pi");
    assert.equal(trial.telemetry.configuration.agent, "pi");
    assert.equal(trial.telemetry.configuration.model, "openai-codex/gpt-5.6-luna");
    assert.equal(trial.telemetry.configuration.reasoningEffort, "medium");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Single Pi canonical calls come only from assistant message_end lines", async () => {
  const root = await mkdtemp(join("/tmp", "harbor-aggregate-single-pi-duplicate-test-"));
  try {
    await mkdir(join(root, "agent", "pi"), { recursive: true });
    await writeFile(join(root, "config.json"), JSON.stringify({ agents: [{
      name: "harbor_full_dev_flow.agent:SinglePiSubscriptionAgent",
      model_name: "openai-codex/gpt-5.6-luna",
      kwargs: { thinking: "medium" },
    }] }));
    const metadataCalls = Array.from({ length: 6 }, () => ({
      callId: null,
      role: "implementer",
      cycle: 1,
      usage: { inputTokens: 99, outputTokens: 99 },
      provenance: { source: "pi-message-end", sourceRef: "pi/pi.txt", dedupeKey: null },
    }));
    await writeFile(join(root, "result.json"), JSON.stringify({
      id: "trial-single-pi-duplicate",
      task_name: "prove-plus-comm",
      task_checksum: "b".repeat(64),
      verifier_result: { rewards: { reward: 1 } },
      agent_result: {
        metadata: {
          usage: { inputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 5, costUsd: 0.1 },
          calls: metadataCalls,
          provider: "openai-codex",
          adapter: "single-pi",
          packageVersion: "0.82.1",
          session: { mode: "fresh", scope: "trial", sessionId: null, evidence: "preflight-empty-session-dir", evidenceRefs: ["pi/session-preflight"] },
          providerPromptCache: { configured: null, observed: true, scope: "provider", cacheReadTokens: 20, cacheWriteTokens: 0, semanticsRef: "openai-codex/single-pi/@earendil-works/pi-coding-agent@0.82.1", evidenceRefs: ["pi/pi.txt"] },
        },
      },
    }));
    const events = [
      { type: "message_start", message: { role: "assistant", model: "gpt-5.6-luna", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      { type: "message_end", message: { role: "assistant", model: "gpt-5.6-luna", usage: { input: 12, cacheRead: 8, cacheWrite: 0, output: 3, cost: { total: 0.04 } } } },
      { type: "turn_end", message: { role: "assistant", model: "gpt-5.6-luna", usage: { input: 12, cacheRead: 8, cacheWrite: 0, output: 3, cost: { total: 0.04 } } } },
      { type: "message_start", message: { role: "assistant", model: "gpt-5.6-luna", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      { type: "message_end", message: { role: "assistant", model: "gpt-5.6-luna", usage: { input: 18, cacheRead: 12, cacheWrite: 0, output: 2, cost: { total: 0.06 } } } },
      { type: "turn_end", message: { role: "assistant", model: "gpt-5.6-luna", usage: { input: 18, cacheRead: 12, cacheWrite: 0, output: 2, cost: { total: 0.06 } } } },
    ];
    await writeFile(join(root, "agent", "pi", "pi.txt"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

    const trial = await readHarborArtifactDirectory(root);
    const telemetry = trial.telemetry;
    assert.equal(telemetry.trial.harness, "single-pi");
    assert.equal(telemetry.configuration.effective.model.value, "gpt-5.6-luna");
    assert.equal(telemetry.configuration.effective.model.status, "observed");
    assert.equal(telemetry.usage.inputTokens, 30, "metadata totals remain authoritative");
    assert.equal(telemetry.usage.modelCallCount, 2, "call count comes from pi.txt canonical records");
    assert.equal(telemetry.orchestration.calls.length, 2, "message_start and turn_end snapshots are ignored");
    assert.deepEqual(telemetry.orchestration.calls.map((call) => call.callId), ["pi-message-end-line-2", "pi-message-end-line-5"]);
    assert.deepEqual(telemetry.orchestration.calls.map((call) => call.usage.inputTokens), [12, 18]);
    assert.deepEqual(telemetry.orchestration.calls.map((call) => call.usage.cacheReadTokens), [8, 12]);
    assert.equal(telemetry.orchestration.session.mode, "fresh");
    assert.equal(telemetry.orchestration.providerPromptCache.cacheReadTokens, 20);
    assert.equal(telemetry.orchestration.calls[0]?.provenance.sourceRef, "agent/pi/pi.txt#L2");
    assert.equal(telemetry.orchestration.calls.every((call) => call.provenance.dedupeKey?.startsWith("pi-message-end-line:")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aggregator classifies and excludes infrastructure/configuration failures", () => {
  const fixture = normalizeBenchmarkArtifacts({ source: "harbor-artifacts", config: { harness: "harbor-codex" }, result: { exception_info: { message: "Docker TLS connection failed" } } });
  const infra: BenchmarkTrialRecord = { artifactPath: "/infra", telemetry: fixture, includeInComparison: false, validity: "invalid", failureCategory: "infrastructure-invalid", invalidReason: "Docker TLS connection failed", telemetryCompleteness: "partial" };
  const config: BenchmarkTrialRecord = { ...infra, artifactPath: "/config", failureCategory: "configuration-invalid", invalidReason: "bad manifest" };
  const aggregate = aggregateBenchmarkTrials([infra, config]);
  const codex = aggregate.byHarness["harbor-codex"];
  assert.equal(codex.includedTrials, 0);
  assert.equal(codex.invalidTrials, 2);
  assert.equal(codex.successRate, null);
  assert.deepEqual(codex.failureTaxonomy, { "infrastructure-invalid": 1, "configuration-invalid": 1 });
  assert.equal(aggregate.warnings.length, 2);
});

test("agent execution timeout remains a valid included model failure", async () => {
  const root = await mkdtemp(join("/tmp", "harbor-aggregate-agent-timeout-test-"));
  try {
    await writeFile(join(root, "config.json"), JSON.stringify({
      agent: { name: "codex", model_name: "gpt-5.6-luna" },
      task: { path: "/private/tmp/terminal-bench-formal/large-scale-text-editing" },
      agent_setup_timeout_multiplier: 2,
      agent_timeout_multiplier: 1,
      verifier_timeout_multiplier: 1,
    }));
    await writeFile(join(root, "result.json"), JSON.stringify({
      id: "trial-agent-timeout",
      task_name: "large-scale-text-editing",
      started_at: "2026-08-22T10:48:28.673916Z",
      finished_at: "2026-08-22T12:24:41.943759Z",
      agent_result: { n_input_tokens: 12966, n_cache_tokens: 9984, n_output_tokens: 200, cost_usd: 0.00103608 },
      verifier_result: { rewards: { reward: 0 } },
      exception_info: { exception_type: "AgentTimeoutError", exception_message: "Agent execution timed out after 1200.0 seconds" },
    }));
    const trial = await readHarborArtifactDirectory(root);
    assert.equal(trial.includeInComparison, true);
    assert.equal(trial.validity, "valid");
    assert.equal(trial.failureCategory, "model-failure");
    assert.equal(trial.invalidReason, null);
    assert.equal(trial.telemetry.result.passed, false);
    assert.equal(trial.telemetry.usage.inputTokens, 12966);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task failures remain valid included benchmark trials", async () => {
  const root = await mkdtemp(join("/tmp", "harbor-aggregate-task-failure-test-"));
  try {
    await writeFile(join(root, "config.json"), JSON.stringify({ agents: [{ name: "codex" }] }));
    await writeFile(join(root, "result.json"), JSON.stringify({ id: "trial-fail", task_name: "polyglot-c-py", verifier_result: { rewards: { reward: 0 } } }));
    const trial = await readHarborArtifactDirectory(root);
    assert.equal(trial.includeInComparison, true);
    assert.equal(trial.validity, "valid");
    assert.equal(trial.failureCategory, "task-failure");
    assert.equal(trial.invalidReason, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run manifest resolves paths from an operator-local root and preserves explicit null costs", async () => {
  const root = await mkdtemp(join("/tmp", "harbor-manifest-test-"));
  const previous = process.env.HARBOR_MANIFEST_FIXTURE_ROOT;
  try {
    const artifact = join(root, "artifacts", "trial-1");
    await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, "config.json"), JSON.stringify({ agent: { name: "codex" } }));
    await writeFile(join(artifact, "result.json"), JSON.stringify({ id: "trial-1", task_name: "regex-log", verifier_result: { rewards: { reward: 1 } } }));
    process.env.HARBOR_MANIFEST_FIXTURE_ROOT = join(root, "artifacts");
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: "benchmark-run-manifest-1",
      artifactRoot: { env: "HARBOR_MANIFEST_FIXTURE_ROOT" },
      artifacts: [{ path: "trial-1", includeInComparison: true, failureCategory: null, invalidReason: null, estimatedCostUsd: 0.2, actualCostUsd: null }],
    }));
    const loaded = await readBenchmarkRunManifest(manifestPath);
    assert.deepEqual(loaded.artifactPaths, [artifact]);
    const aggregate = aggregateBenchmarkTrials([await readHarborArtifactDirectory(loaded.artifactPaths[0]!, loaded.overrides[artifact])]);
    assert.equal(aggregate.byHarness["harbor-codex"].estimatedCostUsd.sum, 0.2);
    assert.equal(aggregate.byHarness["harbor-codex"].actualCostUsd.sum, null);
  } finally {
    if (previous === undefined) delete process.env.HARBOR_MANIFEST_FIXTURE_ROOT;
    else process.env.HARBOR_MANIFEST_FIXTURE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("run manifest fails closed on unknown fields, invalid categories, and duplicate artifacts", async () => {
  const root = await mkdtemp(join("/tmp", "harbor-manifest-invalid-test-"));
  try {
    const entry = { path: "trial", includeInComparison: true, failureCategory: null, invalidReason: null, estimatedCostUsd: null, actualCostUsd: null };
    const cases = [
      { schemaVersion: "benchmark-run-manifest-1", artifacts: [{ ...entry, extra: true }] },
      { schemaVersion: "benchmark-run-manifest-1", artifacts: [{ ...entry, failureCategory: "not-a-category" }] },
      { schemaVersion: "benchmark-run-manifest-1", artifacts: [entry, entry] },
    ];
    for (const [index, value] of cases.entries()) {
      const path = join(root, `manifest-${index}.json`);
      await writeFile(path, JSON.stringify(value));
      await assert.rejects(readBenchmarkRunManifest(path), /unknown field|unknown$|duplicate artifact/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
