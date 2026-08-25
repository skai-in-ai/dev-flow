import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createHarborAtifFixtures, createHarborRealShapeFixture } from "../benchmark/fixtures/harbor-atif.js";
import { FullDevFlowInstalledAgentSkeleton, type FullDevFlowAgentContext } from "../benchmark/full-dev-flow-agent-contract.js";
import { runHarborPreflight } from "../benchmark/harbor-preflight.js";
import { parseHarborRuntimeConfig, validateHarborRuntimeConfig } from "../benchmark/harbor-runtime.js";
import { createTaskCompatibilityMetadata, validateTaskCompatibilityMetadata } from "../benchmark/task-compatibility.js";
import { migrateBenchmarkTrialTelemetry, normalizeBenchmarkArtifacts } from "../benchmark/telemetry.js";

const execFile = promisify(nodeExecFile);

test("Harbor runtime schema pins version, dataset and baseline session", () => {
  const fixture = createHarborAtifFixtures()["harbor-codex"].config;
  const schema = JSON.parse(readFileSync(resolve("config/harbor/terminal-bench-2-1.schema.json"), "utf8")) as unknown;
  assert.equal(schemaAccepts(schema, fixture), true);
  assert.equal(schemaAccepts(schema, { ...fixture, harborVersion: "latest" }), false);
  assert.equal(schemaAccepts(schema, { ...fixture, dataset: { ...fixture.dataset as object, revision: " Latest " } }), false);
  assert.equal(schemaAccepts(schema, { ...fixture, agent: "pi" }), false);
  assert.equal(schemaAccepts(schema, { ...fixture, maxFixCycles: 3 }), false);
  const config = validateHarborRuntimeConfig(fixture);
  assert.equal(config.harborVersion, "0.20.0");
  assert.throws(() => validateHarborRuntimeConfig({ ...fixture, harborVersion: "latest" }), /Harbor version/);
  assert.throws(() => validateHarborRuntimeConfig({ ...fixture, dataset: { ...fixture.dataset as object, revision: "latest" } }), /pinned/);
  assert.throws(() => validateHarborRuntimeConfig({ ...fixture, sessionMode: "reused" }), /fresh/);
  assert.doesNotThrow(() => parseHarborRuntimeConfig(JSON.stringify({ ...fixture, sessionMode: "reused" }), { executableBaseline: false }));
  assert.throws(() => validateHarborRuntimeConfig({ ...fixture, dataset: { ...fixture.dataset as object, tasks: [{ id: "x", sha256: "bad" }] } }), /sha256/);
  assert.throws(() => validateHarborRuntimeConfig({ ...fixture, dataset: { ...fixture.dataset as object, revision: " Latest " } }), /pinned/);
  assert.throws(() => validateHarborRuntimeConfig({ ...fixture, model: "   " }), /non-empty/);
  assert.throws(() => validateHarborRuntimeConfig({ ...fixture, notes: ["api_key=do-not-store"] }), /non-credential/);
  assert.throws(() => validateHarborRuntimeConfig({ ...fixture, dataset: { ...fixture.dataset as object, tasks: [{ id: "x", sha256: "a".repeat(64) }, { id: "x", sha256: "b".repeat(64) }] } }), /duplicate/);
});

test("task compatibility keeps missing evidence unknown and does not infer hidden tests", () => {
  const metadata = createTaskCompatibilityMetadata({
    taskId: "terminal-bench/fix-git",
    datasetRevision: "fixture-revision",
    taskDigest: "a".repeat(64),
    workspaceKind: "unknown",
    requiresGitRepo: "unknown",
    requiresCleanTree: "unknown",
    agentWorkdir: null,
    testsVisibleToAgent: "unknown",
    verifierMode: "unknown",
    internetAllowed: null,
    fullDevFlowCompatible: "unknown",
    incompatibilityReasons: [],
  });
  assert.equal(metadata.testsVisibleToAgent, "unknown");
  assert.doesNotThrow(() => validateTaskCompatibilityMetadata(metadata));
  assert.throws(() => validateTaskCompatibilityMetadata({ ...metadata, testsVisibleToAgent: "hidden" }), /boolean or unknown/);
  assert.throws(() => validateTaskCompatibilityMetadata({ ...metadata, fullDevFlowCompatible: false }), /incompatibilityReasons/);
  assert.doesNotThrow(() => validateTaskCompatibilityMetadata({ ...metadata, fullDevFlowCompatible: false, incompatibilityReasons: ["no deterministic tests"] }));
  assert.doesNotThrow(() => validateTaskCompatibilityMetadata({ ...metadata, scopeInclude: ["src/"], scopeExclude: ["vendor/"], acceptanceCriteria: ["tests pass"], riskNotes: [] }));
  assert.throws(() => validateTaskCompatibilityMetadata({ ...metadata, scopeInclude: ["../escape"] }), /safe relative/);
  assert.throws(() => validateTaskCompatibilityMetadata({ ...metadata, acceptanceCriteria: ["ok", 1] }), /strings/);
});

test("normalizer maps Codex, Pi and Full dev-flow fixtures without fabricating missing values", () => {
  const fixtures = createHarborAtifFixtures();
  const codex = normalizeBenchmarkArtifacts(fixtures["harbor-codex"]);
  assert.equal(codex.trial.source, "fake-fixture");
  assert.equal(codex.usage.inputTokens, 100);
  assert.equal(codex.usage.cacheReadTokens, 25);
  assert.equal(codex.usage.outputTokens, 40);
  assert.equal(codex.derived.uncachedInputTokens, null, "Codex cache denominator is not inferred from field names");
  assert.equal(codex.configuration.effective.model.value, "fixture-model");
  assert.equal(codex.configuration.effective.model.status, "observed");
  assert.equal(codex.configuration.effective.reasoningEffort.status, "not-observed");
  assert.equal(codex.configuration.effective.tier.status, "not-observed");
  assert.equal(codex.provenance.usagePrecedence, "final totals > trajectory metrics > step metrics");
  assert.equal(codex.provenance.normalizationWarnings.some((warning) => warning.includes("usage precedence")), true);
  assert.equal(codex.usage.estimatedCostUsd, null, "generic cost is not pricing evidence");
  assert.equal(codex.usage.actualCostUsd, null);
  assert.equal(codex.result.reward, 1);

  const pi = normalizeBenchmarkArtifacts(fixtures["single-pi"]);
  assert.equal(pi.usage.inputTokens, 80);
  assert.equal(pi.usage.cacheReadTokens, 10);
  assert.equal(pi.usage.cacheWriteTokens, 5);
  assert.equal(pi.usage.uncachedInputTokens, null);
  assert.equal(pi.derived.cacheSemantics.registryKey, "openai-codex/single-pi/@earendil-works/pi-coding-agent@0.82.1");
  assert.equal(pi.derived.cacheSemantics.derived.uncachedInputTokens?.value, 80);
  assert.equal(pi.derived.cacheSemantics.derived.totalPromptTokens?.value, 95);
  assert.equal(pi.derived.cacheSemantics.derived.cacheHitRate?.value, 10 / 95);
  assert.equal(pi.orchestration.session.sessionId, null);

  const full = normalizeBenchmarkArtifacts(fixtures["full-dev-flow"]);
  assert.equal(full.usage.inputTokens, null);
  assert.equal(full.usage.estimatedCostUsd, null);
  assert.equal(full.result.reward, null);
  assert.equal(full.orchestration.runId, "fixture-run-1");
  assert.equal(full.cycles[1]?.recovered, true);
  assert.equal(full.trial.source, "fake-fixture");
  assert.equal(full.orchestration.session.mode, "unknown");

  const priced = normalizeBenchmarkArtifacts({
    source: "harbor-artifacts",
    config: { harness: "harbor-codex" },
    trajectory: { metrics: { estimated_cost_usd: 0.2, actual_cost_usd: 0.3 } },
    pricingSnapshot: { source: "catalog", version: "2026-08-20", inputPerMillion: 1, outputPerMillion: 2 },
    billingEvidence: { provider: "ledger", reference: "invoice-1" },
  });
  assert.equal(priced.usage.estimatedCostUsd, 0.2);
  assert.equal(priced.usage.actualCostUsd, 0.3);
});

test("normalizer reports missing usage and preserves null instead of zero", () => {
  const normalized = normalizeBenchmarkArtifacts({ source: "fake-fixture", config: { harness: "full-dev-flow" } });
  assert.equal(normalized.usage.inputTokens, null);
  assert.equal(normalized.usage.outputTokens, null);
  assert.equal(normalized.provenance.normalizationWarnings.includes("no usage record supplied"), true);
});

test("telemetry keeps unknown cache versions null and migrates v1 without backfilling", () => {
  const unknown = normalizeBenchmarkArtifacts({
    source: "fake-fixture",
    config: { harness: "single-pi", provider: "openai-codex", adapter: "single-pi", packageVersion: "0.82.0" },
    trajectory: { usage: { input: 10, cacheRead: 2, cacheWrite: 1 } },
  });
  assert.equal(unknown.derived.cacheSemantics.registryKey, null);
  assert.equal(unknown.derived.cacheSemantics.derived.totalPromptTokens, null);
  assert.equal(unknown.derived.cacheSemantics.derived.cacheHitRate, null);
  const legacy = migrateBenchmarkTrialTelemetry({
    schemaVersion: "benchmark-trial-1",
    trial: { trialId: "legacy", taskId: "task", taskName: null, taskRef: null, datasetRef: "dataset", datasetRevision: "rev", taskDigest: "a".repeat(64), harness: "harbor-codex", source: "fake-fixture" },
    configuration: { model: "requested", reasoningEffort: "medium", sessionMode: "fresh" },
    result: { passed: true, reward: 1, firstPassingCycle: null, finalCycle: 1, stopReason: null, failureCategory: null, verifierStatus: "passed", durationMs: 1 },
    usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: null, uncachedInputTokens: 8, modelCallCount: 1, estimatedCostUsd: null, actualCostUsd: null, rateLimitCount: null, timeoutCount: null },
    derived: { uncachedInputTokens: { value: 8, formula: "legacy", sourceFields: ["inputTokens"] } },
    orchestration: { runId: null, cycles: 1, roles: [], tiers: [], retryCount: null, reviewerVerdicts: [], deterministicTestEvidence: [], usageByRole: [], usageByCycle: [] },
    cycles: [],
    provenance: { sourceFiles: [], generatedAt: "2026-08-22T00:00:00Z", usagePrecedence: "final totals > trajectory metrics > step metrics", pricingEvidence: false, billingEvidence: false, rewardSource: "verifier_result", passedDerivedFromReward: false, timing: { rawStartedAt: null, rawFinishedAt: null, source: "none" }, normalizationWarnings: [] },
  });
  assert.equal(legacy?.schemaVersion, "benchmark-trial-2");
  assert.equal(legacy?.derived.cacheSemantics.derived.cacheHitRate, null);
  assert.equal(legacy?.orchestration.session.sessionId, null);
  assert.equal(legacy?.provenance.normalizationWarnings.some((warning) => warning.includes("legacy benchmark-trial-1 migrated")), true);
});

test("canonical calls deduplicate by source key and never persist session IDs or secrets", () => {
  const normalized = normalizeBenchmarkArtifacts({
    source: "orchestrator-ledger",
    config: { harness: "full-dev-flow" },
    orchestrator: {
      calls: [
        { callId: "provider-1", role: "implementer", cycle: 1, requested: { model: "requested", reasoningEffort: "medium", maxTier: 1, source: "wrapper-args" }, effective: { model: { value: "effective", status: "observed", source: "runtime-event", evidenceRefs: ["calls/1"] } }, usage: { input: 2, output: 1 }, session: { mode: "reused", scope: "call", sessionId: "refresh_token=secret", evidence: "explicit-reuse", evidenceRefs: ["session/1"] }, provenance: { source: "runtime-event", sourceRef: "calls/1", dedupeKey: "same-event" } },
        { callId: "provider-duplicate", role: "implementer", cycle: 1, usage: { input: 99, output: 99 }, provenance: { source: "runtime-event", sourceRef: "calls/duplicate", dedupeKey: "same-event" } },
      ],
    },
  });
  assert.equal(normalized.orchestration.calls.length, 1);
  assert.equal(normalized.orchestration.calls[0]?.session.sessionId, null);
  assert.equal(normalized.orchestration.calls[0]?.effective.model.value, "effective");
  assert.equal(normalized.provenance.normalizationWarnings.some((warning) => warning.includes("duplicate canonical model call")), true);
  const serialized = JSON.stringify(normalized);
  assert.equal(serialized.includes("refresh_token=secret"), false);
});

test("normalizer preserves requested versus effective core configuration", () => {
  const normalized = normalizeBenchmarkArtifacts({
    source: "orchestrator-ledger",
    config: { harness: "full-dev-flow", agent: "custom-full-dev-flow" },
    orchestrator: {
      requestedConfiguration: { model: "requested-model", reasoningEffort: "high", timeoutSeconds: 900 },
      effectiveConfiguration: { model: null, reasoningEffort: null, timeoutSeconds: null, maxTier: 1 },
    },
  });
  assert.equal(normalized.orchestration.requestedConfiguration?.model, "requested-model");
  assert.equal(normalized.orchestration.effectiveConfiguration?.model, null);
  assert.equal(normalized.configuration.model, null, "unsupported model settings must not be reported as applied");
});

test("legacy maxFixCycles is normalized to canonical maxCycles with provenance", () => {
  const normalized = normalizeBenchmarkArtifacts({
    source: "fake-fixture",
    taskId: "terminal-bench/fix-git",
    config: { harness: "full-dev-flow", maxFixCycles: 2, sessionMode: "fresh" },
    result: { passed: true },
    orchestrator: {
      requestedConfiguration: { maxFixCycles: 2, source: "legacy-wrapper" },
      effectiveConfiguration: { maxFixCycles: { value: 2, status: "observed", source: "old-runtime", evidenceRefs: ["old#1"] } },
    },
  });
  assert.equal(normalized.configuration.maxCycles, 3);
  assert.equal(normalized.configuration.requested.maxCycles, 3);
  assert.equal(normalized.configuration.effective.maxCycles?.value, 3);
  assert.equal(normalized.configuration.effective.maxCycles?.source, "legacy-normalization");
});

test("normalizer matches captured Harbor 0.20.0 nested result shape conservatively", () => {
  const normalized = normalizeBenchmarkArtifacts(createHarborRealShapeFixture());
  assert.equal(normalized.trial.trialId, "fixture-real-result-id");
  assert.equal(normalized.trial.trialName, "fix-git__sanitized");
  assert.equal(normalized.trial.taskId, "terminal-bench/fix-git");
  assert.equal(normalized.trial.taskName, "terminal-bench/fix-git");
  assert.equal(normalized.trial.taskRef, "latest");
  assert.equal(normalized.trial.taskDigest, "d".repeat(64));
  assert.equal(normalized.usage.inputTokens, 111);
  assert.equal(normalized.usage.cacheReadTokens, 22);
  assert.equal(normalized.usage.cacheWriteTokens, null, "n_cache_tokens is aggregate cache, not cache write");
  assert.equal(normalized.usage.outputTokens, 33);
  assert.equal(normalized.usage.estimatedCostUsd, null, "cost_usd has no pricing evidence");
  assert.equal(normalized.usage.actualCostUsd, null, "cost_usd has no billing evidence");
  assert.equal(normalized.result.reward, 1);
  assert.equal(normalized.result.passed, true);
  assert.equal(normalized.result.durationMs, 36_000);
  assert.equal(normalized.provenance.rewardSource, "verifier_result");
  assert.equal(normalized.provenance.passedDerivedFromReward, true);
  assert.equal(normalized.provenance.timing.source, "finished_at-started_at");
  assert.equal(normalized.provenance.normalizationWarnings.includes("usage precedence: final totals > trajectory metrics > step metrics"), false);
});

test("normalizer leaves passed null without an explicit reward policy and warns on invalid timestamps", () => {
  const fixture = createHarborRealShapeFixture();
  const result = fixture.result as Record<string, unknown>;
  const normalized = normalizeBenchmarkArtifacts({ ...fixture, rewardPolicy: undefined, result: { ...result, started_at: "not-a-time", finished_at: "also-not-a-time", environment_setup: { started_at: "2026-08-21T00:00:00Z", finished_at: "2026-08-21T00:00:02Z" }, agent_setup: undefined, agent_execution: undefined, verifier: undefined } });
  assert.equal(normalized.result.passed, null);
  assert.equal(normalized.result.durationMs, 2_000);
  assert.equal(normalized.provenance.timing.source, "phase-span");
  assert.equal(normalized.provenance.normalizationWarnings.some((warning) => warning.includes("invalid top-level timestamps")), true);

  const exception = normalizeBenchmarkArtifacts({ ...fixture, result: { ...result, exception_info: { message: "verifier failed" }, verifier_result: undefined }, rewardPolicy: undefined });
  assert.equal(exception.result.verifierStatus, "exception");
  assert.equal(exception.result.failureCategory, null);
  assert.equal(exception.result.stopReason, null);
});

test("Full dev-flow contract calls the injected core once and never accepts verifier reward", async () => {
  const metadata = createTaskCompatibilityMetadata({
    taskId: "terminal-bench/fix-git",
    datasetRevision: "fixture-revision",
    taskDigest: "a".repeat(64),
    workspaceKind: "git-repo",
    requiresGitRepo: true,
    requiresCleanTree: true,
    agentWorkdir: "/workspace",
    testsVisibleToAgent: "unknown",
    verifierMode: "separate",
    internetAllowed: true,
    fullDevFlowCompatible: true,
    incompatibilityReasons: [],
  });
  let calls = 0;
  let captured: unknown;
  const agent = new FullDevFlowInstalledAgentSkeleton({ run: async (request) => { calls += 1; captured = request; return { runId: "run-1", status: "ready_for_main", ledgerRoot: "/artifacts/run-1", artifactRefs: ["summary.json"] }; } });
  const environment = { cwd: "/workspace", artifactRoot: "/artifacts" };
  const context: FullDevFlowAgentContext = { taskId: metadata.taskId, taskMetadata: metadata, artifactRefs: [], runId: null };
  await agent.install(environment);
  const result = await agent.run("repair the task", environment, context);
  assert.equal(calls, 1);
  assert.equal((captured as { instruction: string }).instruction, "repair the task");
  assert.equal("reward" in (captured as object), false);
  assert.deepEqual(agent.populateContextPostRun(context, result), { ...context, runId: "run-1", artifactRefs: ["summary.json"] });
});

test("harbor-preflight uses fake PATH binaries, reports status only, and never prints a secret", async () => {
  const root = await mkdtemp(join("/tmp", "harbor-preflight-test-"));
  try {
    const binDir = join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const script = async (name: string, body: string): Promise<void> => { const path = join(binDir, name); await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 }); await chmod(path, 0o700); };
    await script("harbor", 'if [ "$1" = "--version" ]; then echo "harbor 0.20.0"; fi');
    await script("docker", 'if [ "$1" = "info" ]; then echo "ready"; else echo "Docker 28.0"; fi');
    await script("pi", 'echo "pi 0.82.1"');
    await script("codex", 'echo "codex-cli 0.144.4"');
    const home = join(root, "home");
    const piDir = join(root, "pi");
    await mkdir(home, { recursive: true });
    await mkdir(piDir, { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "auth.json"), "not inspected by preflight");
    const env = { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, HOME: home, PI_CODING_AGENT_DIR: piDir, OPENAI_API_KEY: "super-secret-value" };
    const result = await execFile(process.execPath, [resolve("dist/benchmark/harbor-preflight.js")], { cwd: resolve("."), env, encoding: "utf8" });
    assert.equal(result.stdout.includes("ready=true"), true);
    assert.equal(result.stdout.includes("super-secret-value"), false);
    assert.equal(result.stdout.includes("auth.json"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("harbor-preflight fails closed for missing required checks without running a trial", async () => {
  const result = await runHarborPreflight({
    env: {},
    commandRunner: async () => ({ exitCode: 127, stdout: "secret-output-must-not-be-rendered" }),
  });
  assert.equal(result.ready, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.codexAuth, "absent");
});

test("harbor-preflight distinguishes CODEX_HOME auth, HOME fallback, and directory type", async () => {
  const root = await mkdtemp(join("/tmp", "harbor-auth-path-test-"));
  try {
    const commandRunner = async (command: string, args: readonly string[]) => ({ exitCode: command === "docker" && args[0] === "info" ? 0 : 0, stdout: command === "harbor" ? "harbor 0.20.0" : "version" });
    const codexHome = join(root, "codex-home");
    const home = join(root, "home");
    await mkdir(codexHome, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(codexHome, "auth.json"), "not read");
    const baseEnv = { PATH: "/no-real-checks", CODEX_HOME: codexHome, HOME: home, OPENAI_API_KEY: "", PI_CODING_AGENT_DIR: join(root, "pi-file") };
    await writeFile(baseEnv.PI_CODING_AGENT_DIR, "regular file");
    const codexHomeResult = await runHarborPreflight({ env: baseEnv, commandRunner });
    assert.equal(codexHomeResult.codexAuth, "present");
    assert.equal(codexHomeResult.piAuth, "unknown");
    await rm(join(codexHome, "auth.json"));
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "auth.json"), "not read");
    const homeResult = await runHarborPreflight({ env: { ...baseEnv, CODEX_HOME: undefined }, commandRunner });
    assert.equal(homeResult.codexAuth, "present");
    assert.equal(homeResult.piAuth, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("harbor-preflight rejects --run and unknown arguments before checks", async () => {
  for (const arg of ["--run", "--unknown"]) {
    await assert.rejects(
      () => execFile(process.execPath, [resolve("dist/benchmark/harbor-preflight.js"), arg], { env: { PATH: "/definitely/missing", HOME: "/definitely/missing" }, encoding: "utf8" }),
      (error: unknown) => {
        const result = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
        assert.equal(result.code, 1);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "harbor-preflight: no arguments accepted\n");
        return true;
      },
    );
  }
});

function schemaAccepts(schema: unknown, value: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return true;
  const rule = schema as Record<string, unknown>;
  if ("const" in rule && !Object.is(rule.const, value)) return false;
  if (Array.isArray(rule.enum) && !rule.enum.some((item) => Object.is(item, value))) return false;
  if (typeof rule.type === "string" && !typeMatches(rule.type, value)) return false;
  if (Array.isArray(rule.type) && !rule.type.some((type) => typeof type === "string" && typeMatches(type, value))) return false;
  if (typeof rule.minLength === "number" && (typeof value !== "string" || value.length < rule.minLength)) return false;
  if (typeof rule.pattern === "string" && (typeof value !== "string" || !new RegExp(rule.pattern).test(value))) return false;
  if (rule.not !== undefined && schemaAccepts(rule.not, value)) return false;
  if (Array.isArray(rule.required) && (!value || typeof value !== "object" || Array.isArray(value) || rule.required.some((key) => !(key in value)))) return false;
  if (rule.properties && value && typeof value === "object" && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    const properties = rule.properties && typeof rule.properties === "object" ? rule.properties as Record<string, unknown> : {};
    if (rule.additionalProperties === false && Object.keys(objectValue).some((key) => !(key in properties))) return false;
    for (const [key, propertySchema] of Object.entries(properties)) if (key in objectValue && !schemaAccepts(propertySchema, objectValue[key])) return false;
  }
  if (rule.type === "array" && Array.isArray(value)) {
    if (typeof rule.minItems === "number" && value.length < rule.minItems) return false;
    if (rule.items !== undefined && value.some((item) => !schemaAccepts(rule.items, item))) return false;
  }
  if (Array.isArray(rule.allOf) && rule.allOf.some((item) => !schemaAccepts(item, value))) return false;
  if (rule.if !== undefined && schemaAccepts(rule.if, value) && rule.then !== undefined && !schemaAccepts(rule.then, value)) return false;
  return true;
}

function typeMatches(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return true;
}
