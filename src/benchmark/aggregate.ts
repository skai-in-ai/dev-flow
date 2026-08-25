import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { migrateBenchmarkTrialTelemetry, normalizeBenchmarkArtifacts, type BenchmarkArtifactInput, type BenchmarkTrialTelemetry, type NormalizedUsage } from "./telemetry.js";
import { readBenchmarkRunManifest } from "./manifest.js";

export type FailureCategory =
  | "configuration-invalid"
  | "infrastructure-invalid"
  | "model-failure"
  | "verifier-failure"
  | "task-failure"
  | "unknown";

export interface ArtifactCostOverride {
  estimatedCostUsd?: number | null;
  actualCostUsd?: number | null;
}

export interface ArtifactLoadOptions extends ArtifactCostOverride {
  /** Explicitly exclude an artifact after human review (for example, a bad manifest). */
  includeInComparison?: boolean;
  failureCategory?: FailureCategory;
  invalidReason?: string;
}

export interface BenchmarkTrialRecord {
  artifactPath: string;
  telemetry: BenchmarkTrialTelemetry;
  includeInComparison: boolean;
  validity: "valid" | "invalid" | "incomplete";
  failureCategory: FailureCategory | null;
  invalidReason: string | null;
  telemetryCompleteness: "complete" | "partial" | "missing";
}

export interface NumericSummary {
  sum: number | null;
  mean: number | null;
  knownCount: number;
  totalCount: number;
  complete: boolean;
}

export interface HarnessAggregate {
  harness: string;
  totalTrials: number;
  includedTrials: number;
  validTrials: number;
  invalidTrials: number;
  incompleteTrials: number;
  passedTrials: number;
  failedTrials: number;
  unknownResultTrials: number;
  successRate: number | null;
  wallTimeMs: NumericSummary;
  estimatedCostUsd: NumericSummary;
  actualCostUsd: NumericSummary;
  tokens: {
    input: NumericSummary;
    uncachedInput: NumericSummary;
    cacheRead: NumericSummary;
    cacheWrite: NumericSummary;
    output: NumericSummary;
    cacheHitRate: number | null;
  };
  cycles: NumericSummary;
  stopReasons: Record<string, number>;
  failureTaxonomy: Record<string, number>;
  warnings: string[];
}

export interface BenchmarkAggregate {
  schemaVersion: "benchmark-aggregate-1";
  trials: BenchmarkTrialRecord[];
  byHarness: Record<string, HarnessAggregate>;
  warnings: string[];
}

type JsonRecord = Record<string, unknown>;

/**
 * Read one Harbor trial directory. This accepts both Harbor's raw result shape
 * and the Full dev-flow wrapper's normalized telemetry. It never turns a
 * missing metric into zero; price overrides are deliberately explicit because
 * Harbor's reported cost is not proof of provider billing.
 */
export async function readHarborArtifactDirectory(path: string, options: ArtifactLoadOptions = {}): Promise<BenchmarkTrialRecord> {
  const artifactPath = resolve(path);
  const files = await listFiles(artifactPath);
  const result = await readFirstJson(files, /(?:^|\/)result\.json$/);
  const config = await readFirstJson(files, /(?:^|\/)config\.json$/);
  const trajectoryPath = files.find((candidate) => /(?:^|\/)agent\/trajectory\.json$/.test(candidate));
  const trajectory = trajectoryPath ? await readFirstJson(files, /(?:^|\/)agent\/trajectory\.json$/) : undefined;
  const piLogPath = files.find((candidate) => /(?:^|\/)agent\/pi\/pi\.txt$/.test(candidate));
  const piCalls = piLogPath ? await readSinglePiCanonicalCalls(piLogPath) : undefined;
  const normalizedTelemetry = await readFirstJson(files, /(?:^|\/)telemetry\.json$/);
  const rawResult = record(result) ?? {};
  const rawConfig = record(config) ?? {};
  const telemetry = isNormalizedTelemetry(normalizedTelemetry)
    ? mergeNormalizedTelemetry(migrateBenchmarkTrialTelemetry(normalizedTelemetry)! as unknown as JsonRecord, normalizeRawHarbor(rawConfig, rawResult, artifactPath, trajectory, piCalls))
    : normalizeRawHarbor(rawConfig, rawResult, artifactPath, trajectory, piCalls);
  const warnings = telemetry.provenance.normalizationWarnings;
  if (normalizedTelemetry === undefined) warnings.push("normalized telemetry.json not found; raw Harbor result shape used");
  applyCostOverrides(telemetry, options, warnings);
  const exceptionText = await readFirstText(files, /(?:^|\/)exception\.txt$/);
  const explicitCategory = options.failureCategory ?? inferFailureCategory(rawResult, exceptionText, options.invalidReason);
  const invalidCategory = explicitCategory === "configuration-invalid" || explicitCategory === "infrastructure-invalid";
  const includeInComparison = options.includeInComparison ?? !invalidCategory;
  const invalidReason = options.invalidReason ?? (!includeInComparison ? exceptionText?.trim() || telemetry.result.stopReason || "artifact marked outside comparison" : null);
  const hasResult = Object.keys(rawResult).length > 0 || isNormalizedTelemetry(normalizedTelemetry);
  const hasOutcome = telemetry.result.passed !== null || telemetry.result.reward !== null || telemetry.result.verifierStatus !== null;
  const validity = !includeInComparison || invalidCategory ? "invalid" : !hasResult || !hasOutcome ? "incomplete" : "valid";
  const telemetryCompleteness = normalizedTelemetry === undefined ? "partial" : telemetry.provenance.normalizationWarnings.some((warning) => /lower-bound|missing|omitted|not found/i.test(warning)) ? "partial" : "complete";
  if (telemetryCompleteness === "partial") warnings.push("telemetry is partial/lower-bound; missing fields were not filled with zero");
  if (telemetry.usage.actualCostUsd === null) warnings.push("actualCostUsd is null: no provider billing evidence supplied");
  return { artifactPath, telemetry, includeInComparison, validity, failureCategory: explicitCategory, invalidReason, telemetryCompleteness };
}

export function aggregateBenchmarkTrials(trials: readonly BenchmarkTrialRecord[]): BenchmarkAggregate {
  const byHarness: Record<string, HarnessAggregate> = {};
  const warnings: string[] = [];
  for (const trial of trials) {
    const harness = trial.telemetry.trial.harness;
    const aggregate = byHarness[harness] ?? createHarnessAggregate(harness);
    byHarness[harness] = aggregate;
    aggregate.totalTrials += 1;
    if (trial.includeInComparison) aggregate.includedTrials += 1;
    if (trial.validity === "valid") aggregate.validTrials += 1;
    if (trial.validity === "invalid") aggregate.invalidTrials += 1;
    if (trial.validity === "incomplete") aggregate.incompleteTrials += 1;
    if (!trial.includeInComparison) warnings.push(`${harness}/${trial.telemetry.trial.taskId} excluded from comparison: ${trial.invalidReason ?? "no reason supplied"}`);
    if (trial.telemetryCompleteness === "partial") aggregate.warnings.push(`${trial.telemetry.trial.trialId}: partial/lower-bound telemetry`);
    const result = trial.telemetry.result;
    countFailure(aggregate.failureTaxonomy, trial.failureCategory);
    if (!trial.includeInComparison) continue;
    if (result.passed === true) aggregate.passedTrials += 1;
    else if (result.passed === false) aggregate.failedTrials += 1;
    else aggregate.unknownResultTrials += 1;
    countStopReason(aggregate.stopReasons, result.stopReason ?? lastCycleStop(trial.telemetry));
  }
  for (const aggregate of Object.values(byHarness)) {
    const included = trials.filter((trial) => trial.telemetry.trial.harness === aggregate.harness && trial.includeInComparison);
    aggregate.successRate = aggregate.unknownResultTrials === 0 && aggregate.includedTrials > 0 ? aggregate.passedTrials / aggregate.includedTrials : null;
    aggregate.wallTimeMs = summarize(included.map((trial) => trial.telemetry.result.durationMs));
    aggregate.estimatedCostUsd = summarize(included.map((trial) => trial.telemetry.usage.estimatedCostUsd));
    aggregate.actualCostUsd = summarize(included.map((trial) => trial.telemetry.usage.actualCostUsd));
    aggregate.tokens = {
      input: summarize(included.map((trial) => trial.telemetry.usage.inputTokens)),
      uncachedInput: summarize(included.map((trial) => trial.telemetry.usage.uncachedInputTokens ?? trial.telemetry.derived.uncachedInputTokens?.value ?? null)),
      cacheRead: summarize(included.map((trial) => trial.telemetry.usage.cacheReadTokens)),
      cacheWrite: summarize(included.map((trial) => trial.telemetry.usage.cacheWriteTokens)),
      output: summarize(included.map((trial) => trial.telemetry.usage.outputTokens)),
      cacheHitRate: cacheHitRate(included),
    };
    aggregate.cycles = summarize(included.map((trial) => trial.telemetry.result.finalCycle ?? trial.telemetry.orchestration.cycles ?? null));
    if (aggregate.unknownResultTrials > 0) aggregate.warnings.push("successRate is null because one or more included trials have unknown passed status");
    if (!aggregate.actualCostUsd.complete) aggregate.warnings.push("actual cost coverage is incomplete; null is not zero and must not be summed as zero");
    if (aggregate.tokens.cacheHitRate === null && included.length > 0) aggregate.warnings.push("cache hit rate omitted because token denominator semantics are missing or incomplete");
  }
  return { schemaVersion: "benchmark-aggregate-1", trials: [...trials], byHarness, warnings };
}

export async function aggregateHarborArtifactDirectories(paths: readonly string[], overrides: Record<string, ArtifactLoadOptions> = {}): Promise<BenchmarkAggregate> {
  const trials = await Promise.all(paths.map((path) => readHarborArtifactDirectory(path, overrides[path] ?? overrides[resolve(path)] ?? {})));
  return aggregateBenchmarkTrials(trials);
}

function normalizeRawHarbor(config: JsonRecord, result: JsonRecord, artifactPath: string, trajectoryOverride?: unknown, singlePiCalls?: readonly JsonRecord[]): BenchmarkTrialTelemetry {
  const configuredAgents = Array.isArray(config.agents) ? config.agents : [];
  const agent = record(config.agent) ?? configuredAgents.map(record).find((candidate) => candidate !== undefined);
  const agentName = stringValue(agent?.name);
  const importPath = agentName ?? "";
  const harness = importPath.includes("SinglePiSubscriptionAgent") || importPath.includes("single-pi") ? "single-pi" : importPath.includes("FullDevFlowAgent") || importPath.includes("full-dev-flow") ? "full-dev-flow" : "harbor-codex";
  const model = stringValue(agent?.model_name) ?? stringValue(record(config.agent_info)?.model);
  const kwargs = record(agent?.kwargs);
  const trajectory = record(trajectoryOverride) ?? readEmbeddedTrajectory(result);
  const agentResult = record(result.agent_result);
  const agentMetadata = record(agentResult?.metadata);
  const runtimeAgent = record(trajectory?.agent);
  const runtimeModel = harness === "single-pi"
    ? singlePiEffectiveModel(singlePiCalls)
    : stringValue(runtimeAgent?.model_name) ?? stringValue(runtimeAgent?.model);
  const effectiveConfiguration = runtimeModel
    ? { model: { value: runtimeModel, status: "observed", source: harness === "single-pi" ? "pi-message-end.model" : "harbor-atif.agent.model_name", evidenceRefs: [harness === "single-pi" ? "agent/pi/pi.txt" : "agent/trajectory.json"] } }
    : undefined;
  const trajectoryCalls = harness === "harbor-codex" ? nativeCodexTrajectoryCalls(trajectory, effectiveConfiguration) : [];
  const agentUsage = record(agentResult);
  const metadataUsage = record(agentMetadata?.usage);
  const usage = trajectoryCalls.length > 0
    ? { ...(agentUsage ?? {}), model_call_count: trajectoryCalls.length }
    : harness === "single-pi" && metadataUsage && singlePiCalls !== undefined
      ? { ...metadataUsage, model_call_count: singlePiCalls.length }
      : undefined;
  const canonicalCalls = harness === "single-pi"
    ? singlePiCalls ?? []
    : Array.isArray(agentMetadata?.calls)
      ? agentMetadata.calls
      : trajectoryCalls;
  const usageWarnings = harness === "single-pi" && singlePiCalls === undefined
    ? ["single-pi pi/pi.txt not found; canonical call evidence unavailable"]
    : harness === "single-pi" && singlePiCalls?.length === 0
      ? ["single-pi pi/pi.txt has no assistant message_end usage records; canonical call evidence unavailable"]
      : [];
  const input: BenchmarkArtifactInput = {
    source: "harbor-artifacts",
    trialId: stringValue(result.id) ?? undefined,
    taskId: stringValue(result.task_name) ?? undefined,
    sourceFiles: [join(artifactPath, "config.json"), join(artifactPath, "result.json"), ...(trajectory ? [join(artifactPath, "agent", "trajectory.json")] : []), ...(singlePiCalls !== undefined ? [join(artifactPath, "agent", "pi", "pi.txt")] : [])],
    config: {
      harness,
      agent: harness === "harbor-codex" ? "codex" : harness === "single-pi" ? "pi" : "custom-full-dev-flow",
      model,
      reasoningEffort: stringValue(kwargs?.reasoning_effort) ?? stringValue(kwargs?.thinking),
      harborVersion: "0.20.0",
      datasetRef: "terminal-bench@2.0",
      datasetRevision: "unknown",
      taskDigest: stringValue(result.task_checksum),
      verifierMode: "unknown",
      sessionMode: "fresh",
      provider: harness === "single-pi" ? stringValue(agentMetadata?.provider) : null,
      adapter: harness === "single-pi" ? "single-pi" : harness,
      packageVersion: harness === "single-pi" ? stringValue(agentMetadata?.packageVersion) : null,
    },
    result: metadataUsage
      ? { ...result, usage: usage ?? metadataUsage }
      : usage
        ? { ...result, usage }
        : result,
    trajectory,
    orchestrator: {
      ...(effectiveConfiguration ? { effectiveConfiguration } : {}),
      ...(agentMetadata?.session ? { session: agentMetadata.session } : {}),
      ...(agentMetadata?.providerPromptCache ? { providerPromptCache: agentMetadata.providerPromptCache } : {}),
      ...(canonicalCalls.length > 0 || harness === "single-pi" ? { calls: canonicalCalls } : {}),
      ...(usageWarnings.length > 0 ? { usageWarnings } : {}),
    },
    rewardPolicy: { passAtOrAbove: 1 },
  };
  return normalizeBenchmarkArtifacts(input);
}

async function readSinglePiCanonicalCalls(path: string): Promise<JsonRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const calls: JsonRecord[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event: JsonRecord | undefined;
    try { event = record(JSON.parse(line)); } catch { continue; }
    const message = record(event?.message);
    const usage = record(message?.usage);
    if (event?.type !== "message_end" || message?.role !== "assistant" || !usage) continue;
    const sourceRef = `agent/pi/pi.txt#L${index + 1}`;
    const model = stringValue(message.model);
    calls.push({
      callId: `pi-message-end-line-${index + 1}`,
      role: "implementer",
      cycle: 1,
      usage: {
        inputTokens: usage.input,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        outputTokens: usage.output,
        costUsd: record(usage.cost)?.total,
      },
      session: { mode: "unknown", scope: "call", sessionId: null, evidence: "none", evidenceRefs: [] },
      ...(model ? { effective: { model: { value: model, status: "observed", source: "pi-message-end.model", evidenceRefs: [sourceRef] } } } : {}),
      provenance: { source: "pi-message-end", sourceRef, dedupeKey: `pi-message-end-line:${index + 1}` },
    });
  }
  return calls;
}

function singlePiEffectiveModel(calls: readonly JsonRecord[] | undefined): string | null {
  const models = [...new Set((calls ?? []).map((call) => stringValue(record(record(call.effective)?.model)?.value)).filter((value): value is string => value !== null))];
  return models.length === 1 ? models[0]! : null;
}

/**
 * Harbor Codex exposes one ATIF step with metrics per model call.  The final
 * metrics are the authoritative run total, while these bounded step records
 * provide the only call-level usage identity available in the artifact.
 * Keep the raw metric names so cache semantics stay unknown for this harness.
 */
function nativeCodexTrajectoryCalls(trajectory: JsonRecord | undefined, effectiveConfiguration: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  if (!trajectory || !Array.isArray(trajectory.steps)) return [];
  return trajectory.steps.flatMap((value, index) => {
    const step = record(value);
    const metrics = record(step?.metrics);
    if (!metrics) return [];
    const stepId = numberValue(step?.step_id) ?? index + 1;
    const callId = `trajectory-step-${stepId}`;
    return [{
      callId,
      role: "agent",
      cycle: null,
      usage: metrics,
      session: { mode: "unknown", scope: "call", sessionId: null, evidence: "none", evidenceRefs: [] },
      ...(effectiveConfiguration ? { effective: effectiveConfiguration } : {}),
      provenance: {
        source: "harbor-result",
        sourceRef: `agent/trajectory.json#steps[${index}]`,
        dedupeKey: `trajectory-step:${stepId}`,
      },
    }];
  });
}

function mergeNormalizedTelemetry(raw: JsonRecord, fallback: BenchmarkTrialTelemetry): BenchmarkTrialTelemetry {
  const candidate = raw as unknown as BenchmarkTrialTelemetry;
  const merged = structuredClone(candidate);
  merged.trial = { ...fallback.trial, ...candidate.trial, taskDigest: fallback.trial.taskDigest !== "unknown-digest" ? fallback.trial.taskDigest : candidate.trial.taskDigest };
  merged.result = { ...candidate.result, reward: fallback.result.reward ?? candidate.result.reward, passed: fallback.result.passed ?? candidate.result.passed, durationMs: fallback.result.durationMs ?? candidate.result.durationMs };
  merged.provenance = { ...candidate.provenance, sourceFiles: [...new Set([...(candidate.provenance?.sourceFiles ?? []), ...fallback.provenance.sourceFiles])] };
  return merged;
}

function applyCostOverrides(telemetry: BenchmarkTrialTelemetry, options: ArtifactLoadOptions, warnings: string[]): void {
  if (options.estimatedCostUsd !== undefined) telemetry.usage.estimatedCostUsd = options.estimatedCostUsd;
  if (options.actualCostUsd !== undefined) telemetry.usage.actualCostUsd = options.actualCostUsd;
  if (options.estimatedCostUsd !== undefined) warnings.push("estimatedCostUsd supplied by explicit operator override; it is not actual billing");
  if (options.actualCostUsd !== undefined) warnings.push("actualCostUsd supplied by explicit billing override");
}

function inferFailureCategory(result: JsonRecord, exceptionText: string | undefined, explicitReason?: string): FailureCategory | null {
  if (explicitReason) return /config/i.test(explicitReason) ? "configuration-invalid" : /infra|docker|node|nvm|auth|network|tls|install/i.test(explicitReason) ? "infrastructure-invalid" : "unknown";
  const text = `${exceptionText ?? ""} ${JSON.stringify(result.exception_info ?? "")}`.toLowerCase();
  if (!text.trim() && result.verifier_result === undefined) return null;
  if (/configuration-invalid|bad manifest|clean tree|unsupported.*config/.test(text)) return "configuration-invalid";
  // An agent execution timeout happens after setup and model invocation. It is
  // a valid included trial with a model failure, unlike setup/install timeout
  // which is infrastructure-invalid. Keep verifier timeouts distinct too.
  if (/agenttimeouterror|agent execution timed out/.test(text)) return "model-failure";
  if (/verifier.*timeout|verifiertimeouterror/.test(text)) return "verifier-failure";
  if (/agent setup.*timeout|setup.*timed out|setup.*timeout/.test(text)) return "infrastructure-invalid";
  if (/docker|node|nvm|auth|tls|network|timeout|install|permission|connection/.test(text)) return "infrastructure-invalid";
  if (result.exception_info !== undefined && result.exception_info !== null) return "model-failure";
  if (record(result.verifier_result)?.rewards === undefined && result.verifier_result !== undefined) return "verifier-failure";
  if (numberValue(record(record(result.verifier_result)?.rewards)?.reward) !== null && numberValue(record(record(result.verifier_result)?.rewards)?.reward) === 0) return "task-failure";
  return null;
}

function readEmbeddedTrajectory(result: JsonRecord): JsonRecord | undefined { return record(record(result.agent_result)?.trajectory); }
function lastCycleStop(telemetry: BenchmarkTrialTelemetry): string | null { return telemetry.cycles.at(-1)?.stopReason ?? null; }
function countStopReason(target: Record<string, number>, reason: string | null): void { if (reason) target[reason] = (target[reason] ?? 0) + 1; }
function countFailure(target: Record<string, number>, category: FailureCategory | null): void { if (category) target[category] = (target[category] ?? 0) + 1; }
function createHarnessAggregate(harness: string): HarnessAggregate { return { harness, totalTrials: 0, includedTrials: 0, validTrials: 0, invalidTrials: 0, incompleteTrials: 0, passedTrials: 0, failedTrials: 0, unknownResultTrials: 0, successRate: null, wallTimeMs: emptySummary(), estimatedCostUsd: emptySummary(), actualCostUsd: emptySummary(), tokens: { input: emptySummary(), uncachedInput: emptySummary(), cacheRead: emptySummary(), cacheWrite: emptySummary(), output: emptySummary(), cacheHitRate: null }, cycles: emptySummary(), stopReasons: {}, failureTaxonomy: {}, warnings: [] }; }
function summarize(values: readonly (number | null)[]): NumericSummary { const known = values.filter((value): value is number => value !== null && Number.isFinite(value)); const sum = known.length ? known.reduce((total, value) => total + value, 0) : null; return { sum, mean: sum === null ? null : sum / known.length, knownCount: known.length, totalCount: values.length, complete: known.length === values.length }; }
function emptySummary(): NumericSummary { return { sum: null, mean: null, knownCount: 0, totalCount: 0, complete: false }; }
function cacheHitRate(trials: readonly BenchmarkTrialRecord[]): number | null {
  const pairs = trials.map((trial) => {
    const derived = trial.telemetry.derived.cacheSemantics?.derived.cacheHitRate;
    const denominator = trial.telemetry.derived.cacheSemantics?.denominator;
    return denominator === "totalPromptTokens" && derived?.value !== undefined && Number.isFinite(derived.value) ? derived.value : null;
  });
  if (!pairs.length || pairs.some((pair) => pair === null)) return null;
  const known = pairs.filter((pair): pair is number => pair !== null);
  return known.reduce((sum, pair) => sum + pair, 0) / known.length;
}
function isNormalizedTelemetry(value: unknown): value is JsonRecord { const schema = record(value)?.schemaVersion; return Boolean((schema === "benchmark-trial-1" || schema === "benchmark-trial-2") && record(record(value)?.trial)); }
function record(value: unknown): JsonRecord | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
async function listFiles(root: string): Promise<string[]> { const entries = await readdir(root, { withFileTypes: true }); const files: string[] = []; for (const entry of entries) { const path = join(root, entry.name); if (entry.isDirectory()) files.push(...await listFiles(path)); else if (entry.isFile()) files.push(path); } return files; }
async function readFirstJson(files: readonly string[], pattern: RegExp): Promise<unknown> { const path = files.find((candidate) => pattern.test(candidate)); return path ? JSON.parse(await readFile(path, "utf8")) as unknown : undefined; }
async function readFirstText(files: readonly string[], pattern: RegExp): Promise<string | undefined> { const path = files.find((candidate) => pattern.test(candidate)); return path ? readFile(path, "utf8") : undefined; }

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    const manifestIndex = args.indexOf("--manifest");
    if (manifestIndex >= 0) {
      if (args.filter((arg) => arg === "--manifest").length !== 1 || !args[manifestIndex + 1] || args.length !== 2) {
        throw new Error("usage: harbor-aggregate --manifest MANIFEST_PATH");
      }
      const loaded = await readBenchmarkRunManifest(args[manifestIndex + 1]!);
      process.stdout.write(`${JSON.stringify(await aggregateHarborArtifactDirectories(loaded.artifactPaths, loaded.overrides), null, 2)}\n`);
      return;
    }
    if (!args.length || args.some((arg) => arg.startsWith("-"))) throw new Error("usage: harbor-aggregate ARTIFACT_DIR [...ARTIFACT_DIR] or --manifest MANIFEST_PATH");
    process.stdout.write(`${JSON.stringify(await aggregateHarborArtifactDirectories(args), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
