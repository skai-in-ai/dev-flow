import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { loadHandoff, type Handoff } from "./handoff.js";
import { runOrchestratorFromHandoff } from "./cli-core.js";
import { normalizeBenchmarkArtifacts, type BenchmarkArtifactInput } from "./benchmark/telemetry.js";
import type { RepoConfig } from "./handoff.js";
import type { RunOutcome } from "./orchestrator.js";
import { validatePublicChecks } from "./public-evidence-runner.js";

const execFileAsync = promisify(execFile);
const HARBOR_VERSION = "0.20.0";
const DEFAULT_AGENT_LOG_DIR = "/logs/agent";
const DEFAULT_ARTIFACT_DIR = "/logs/artifacts";
const HELP = "Usage: harbor-dev-flow --handoff <absolute path>";

interface BridgeContext {
  compatibility: Record<string, unknown>;
  taskId: string;
  taskName?: string;
  datasetRef?: string;
  datasetRevision?: string;
  taskDigest?: string;
  agentWorkdir: string;
  agentLogDir?: string;
  artifactDir?: string;
  maxTier?: 0 | 1 | 2;
  /** Canonical total implementation-attempt cap; omitted/null preserves core default. */
  maxCycles?: number | null;
  /** @deprecated Retry-count alias; converted at the boundary only. */
  maxFixCycles?: number | null;
  requestedConfiguration?: Record<string, unknown>;
  effectiveConfiguration?: Record<string, unknown>;
  runtimeResolved?: Record<string, unknown>;
  publicChecks?: unknown;
}

interface BridgeResult {
  status: string;
  runId: string | null;
  startedAt: string;
  finishedAt: string;
  requestedConfiguration: {
    maxCycles?: number | null;
    maxFixCycles?: number | null;
    cycleCap?: number | null;
    source: "harbor-agent-kwarg" | "unspecified";
  };
  effectiveConfiguration: {
    maxCycles?: number | null;
    maxFixCycles?: number | null;
    cycleCap?: number | null;
    source: "orchestrator-outcome" | "none";
    evidenceRefs: string[];
  };
  error?: string;
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(HELP);
    return 0;
  }
  if (argv.length !== 2 || argv[0] !== "--handoff" || !argv[1] || !isAbsolute(argv[1])) {
    console.error(HELP);
    return 1;
  }

  const handoffPath = resolve(argv[1]);
  const contextPath = join(dirname(handoffPath), "bridge-context.json");
  const handoff = await loadHandoff(handoffPath);
  const context = await loadContext(contextPath);
  await assertCompatibility(handoff, context);

  const agentLogDir = safeAbsolutePath(context.agentLogDir ?? DEFAULT_AGENT_LOG_DIR, "agentLogDir");
  const artifactDir = safeAbsolutePath(context.artifactDir ?? DEFAULT_ARTIFACT_DIR, "artifactDir");
  await mkdir(agentLogDir, { recursive: true });
  await mkdir(artifactDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const source = {
    maxTier: context.maxTier,
  };
  const maxCycles = resolveBridgeMaxCycles(context);
  const publicChecks = validatePublicChecks(context.publicChecks);
  const coreConfig: RepoConfig | undefined = maxCycles === null
    ? (publicChecks.length ? { publicChecks } : undefined)
    : { maxCycles, ...(publicChecks.length ? { publicChecks } : {}) };
  let outcome: RunOutcome | undefined;
  let failure: unknown;
  try {
    outcome = await runOrchestratorFromHandoff(handoff, source, (line) => {
      // Progress is intentionally bounded and contains no prompt/artifact payload.
      console.log(line.slice(0, 300));
    }, coreConfig);
  } catch (error) {
    failure = error;
  }
  const finishedAt = new Date().toISOString();
  const bridgeResult = buildBridgeResult(context, outcome, startedAt, finishedAt, failure ? errorMessage(failure).slice(0, 500) : undefined);
  await writeJson(join(agentLogDir, "full-dev-flow", "bridge-result.json"), bridgeResult);
  await writeJson(join(agentLogDir, "full-dev-flow", "handoff.json"), handoff);

  if (outcome) {
    await exportArtifacts({ handoff, context, outcome, startedAt, finishedAt, agentLogDir, artifactDir });
  }
  if (failure) throw failure;
  console.log(`FULL_DEV_FLOW ${bridgeResult.status.toUpperCase()} · run ${bridgeResult.runId ?? "unknown"}`);
  return bridgeResult.status === "failed" ? 1 : 0;
}

async function loadContext(path: string): Promise<BridgeContext> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bridge context must be an object");
  const context = parsed as Record<string, unknown>;
  if (typeof context.taskId !== "string" || !context.taskId.trim()) throw new Error("bridge context taskId is required");
  if (typeof context.agentWorkdir !== "string" || !isAbsolute(context.agentWorkdir)) throw new Error("bridge context agentWorkdir must be absolute");
  if (!context.compatibility || typeof context.compatibility !== "object" || Array.isArray(context.compatibility)) throw new Error("bridge context compatibility is required");
  validateBridgeCycleConfig(context.maxCycles, context.maxFixCycles);
  return context as unknown as BridgeContext;
}

export function validateBridgeCycleConfig(maxCycles: unknown, maxFixCycles: unknown): void {
  if (maxCycles !== undefined && maxCycles !== null && (typeof maxCycles !== "number" || !Number.isInteger(maxCycles) || maxCycles < 1)) {
    throw new Error("bridge context maxCycles must be a positive integer or null");
  }
  if (maxFixCycles !== undefined && maxFixCycles !== null && (typeof maxFixCycles !== "number" || !Number.isInteger(maxFixCycles) || maxFixCycles < 0)) {
    throw new Error("bridge context maxFixCycles must be a non-negative integer or null");
  }
  if (maxCycles !== undefined && maxCycles !== null && maxFixCycles !== undefined && maxFixCycles !== null) {
    throw new Error("bridge context maxCycles and deprecated maxFixCycles cannot both be configured");
  }
}

/** @deprecated Validate the legacy retry alias. */
export function validateMaxFixCycles(value: unknown): asserts value is number | null | undefined {
  validateBridgeCycleConfig(undefined, value);
}

export function resolveBridgeMaxCycles(context: Pick<BridgeContext, "maxCycles" | "maxFixCycles">): number | null {
  validateBridgeCycleConfig(context.maxCycles, context.maxFixCycles);
  if (context.maxCycles !== undefined && context.maxCycles !== null) return context.maxCycles;
  if (context.maxFixCycles !== undefined && context.maxFixCycles !== null) return context.maxFixCycles + 1;
  return null;
}

export function buildBridgeResult(
  context: BridgeContext,
  outcome: RunOutcome | undefined,
  startedAt: string,
  finishedAt: string,
  error?: string,
): BridgeResult {
  return {
    status: outcome?.status ?? "failed",
    runId: outcome?.runId ?? null,
    startedAt,
    finishedAt,
    requestedConfiguration: context.maxCycles !== undefined
      ? { maxCycles: context.maxCycles ?? null, source: context.maxCycles === null ? "unspecified" : "harbor-agent-kwarg" }
      : { maxFixCycles: context.maxFixCycles ?? null, cycleCap: context.maxFixCycles === null || context.maxFixCycles === undefined ? null : context.maxFixCycles + 1, source: context.maxFixCycles === null || context.maxFixCycles === undefined ? "unspecified" : "harbor-agent-kwarg" },
    effectiveConfiguration: {
      ...(context.maxCycles !== undefined ? { maxCycles: outcome?.maxCycles ?? null } : { maxFixCycles: outcome ? outcome.maxCycles - 1 : null, cycleCap: outcome?.maxCycles ?? null }),
      source: outcome ? "orchestrator-outcome" : "none",
      evidenceRefs: outcome ? [`artifacts/logs/artifacts/orchestrator-runs/${outcome.runId}/summary.json#maxCycles`] : [],
    },
    ...(error ? { error: error.slice(0, 500) } : {}),
  };
}

async function assertCompatibility(handoff: Handoff, context: BridgeContext): Promise<void> {
  const metadata = context.compatibility;
  if (metadata.fullDevFlowCompatible !== true) throw new Error("harness_incompatibility: full-dev-flow compatibility is not true");
  if (metadata.workspaceKind !== "git-repo" || metadata.requiresGitRepo !== true) throw new Error("harness_incompatibility: workspace is not an approved git repo");
  if (metadata.requiresCleanTree !== true) throw new Error("harness_incompatibility: clean-tree requirement is not explicit");
  if (metadata.testsVisibleToAgent !== true) throw new Error("harness_incompatibility: deterministic test visibility is not explicit");
  if (metadata.verifierMode !== "shared" && metadata.verifierMode !== "separate") throw new Error("harness_incompatibility: verifier mode is unknown");
  if (Array.isArray(metadata.incompatibilityReasons) && metadata.incompatibilityReasons.length > 0) throw new Error("harness_incompatibility: compatibility metadata has incompatibility reasons");
  const revision = String(context.datasetRevision ?? metadata.datasetRevision ?? "").trim();
  if (!revision || revision.toLowerCase() === "latest") throw new Error("harness_incompatibility: dataset revision must be locked");
  const digest = String(context.taskDigest ?? metadata.taskDigest ?? "");
  if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error("harness_incompatibility: task digest must be a SHA-256");
  if (context.taskId !== metadata.taskId) throw new Error("harness_incompatibility: task identity mismatch");

  const workspace = resolve(context.agentWorkdir);
  if (resolve(handoff.repo) !== workspace) throw new Error("harness_incompatibility: handoff repo does not match task workdir");
  const topLevel = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: workspace })).stdout.trim();
  if (resolve(topLevel) !== workspace) throw new Error("harness_incompatibility: workspace is not the approved git root");
  const status = (await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: workspace })).stdout.trim();
  if (status) throw new Error("harness_incompatibility: workspace tree is not clean");
  if (!handoff.tests.length) throw new Error("harness_incompatibility: no deterministic tests are configured");
  if (handoff.tests.some((command) => /[\r\n]/.test(command) || !command.trim())) throw new Error("harness_incompatibility: invalid deterministic test command");
}

function safeAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes("\0")) throw new Error(`${label} must be an absolute path`);
  return resolve(value);
}

async function exportArtifacts(args: {
  handoff: Handoff;
  context: BridgeContext;
  outcome: RunOutcome;
  startedAt: string;
  finishedAt: string;
  agentLogDir: string;
  artifactDir: string;
}): Promise<void> {
  const { context, outcome, startedAt, finishedAt, agentLogDir, artifactDir } = args;
  const fullLogDir = join(agentLogDir, "full-dev-flow");
  await mkdir(fullLogDir, { recursive: true });
  const ledgerRoot = join(args.handoff.repo, ".orchestrator", "runs", outcome.runId);
  const ledgerEntries = await readdir(ledgerRoot).catch(() => [] as string[]);
  const safeFiles = ["summary.json", "summary.md", "report.md", "run.json", "build-evidence-baseline.json", ...ledgerEntries.filter((entry) => /^build-evidence-cycle-\d+\.json$/.test(entry))];
  const exported: Array<{ source: string; destination: string; sha256: string }> = [];
  const destinationRoot = join(artifactDir, "orchestrator-runs", outcome.runId);
  await mkdir(destinationRoot, { recursive: true });
  for (const name of safeFiles) {
    const source = join(ledgerRoot, name);
    try {
      const destination = join(destinationRoot, name);
      await copyFile(source, destination);
      exported.push({ source: `${ledgerRoot}/${name}`, destination: `${destinationRoot}/${name}`, sha256: await sha256(destination) });
    } catch {
      // Some terminal outcomes may not have every optional ledger file. The
      // allowlist remains explicit and the manifest records only what exists.
    }
  }
  const ledgerUsage = await collectLedgerUsage(ledgerRoot);
  const exportedArtifactPrefix = "artifacts/logs/artifacts";
  const callEvidenceRef = `${exportedArtifactPrefix}/orchestrator-runs/${outcome.runId}/call-evidence.json`;
  const calls = ledgerUsage.calls.map((call, index) => sanitizeCall(call, callEvidenceRef, index));
  const callEvidencePath = join(destinationRoot, "call-evidence.json");
  await writeJson(callEvidencePath, {
    schemaVersion: "full-dev-flow-call-evidence-1",
    calls: calls.map((call) => sanitizeCallEvidence(call)),
  });
  exported.push({
    source: "sanitized-ledger-call-evidence",
    destination: callEvidencePath,
    sha256: await sha256(callEvidencePath),
  });
  const legacyCycleInput = context.maxCycles === undefined && context.maxFixCycles !== undefined;
  const effectiveConfiguration = {
    ...deriveEffectiveConfiguration(calls),
    maxCycles: {
      value: outcome.maxCycles,
      status: "observed",
      source: "orchestrator-outcome",
      evidenceRefs: [`${exportedArtifactPrefix}/orchestrator-runs/${outcome.runId}/summary.json#maxCycles`],
    },
    ...(legacyCycleInput ? {
      maxFixCycles: {
        value: outcome.maxCycles - 1,
        status: "observed" as const,
        source: "orchestrator-outcome",
        evidenceRefs: [`${exportedArtifactPrefix}/orchestrator-runs/${outcome.runId}/summary.json#maxCycles`],
      },
      cycleCap: {
        value: outcome.maxCycles,
        status: "observed" as const,
        source: "orchestrator-outcome",
        evidenceRefs: [`${exportedArtifactPrefix}/orchestrator-runs/${outcome.runId}/summary.json#maxCycles`],
      },
    } : {}),
  };
  const requestedConfiguration = {
    ...(context.requestedConfiguration ?? {}),
    maxCycles: resolveBridgeMaxCycles(context),
  };
  const telemetryInput: BenchmarkArtifactInput = {
    source: "orchestrator-ledger",
    taskId: context.taskId,
    sourceFiles: exported.map((entry) => `${exportedArtifactPrefix}/${relative(artifactDir, entry.destination)}`),
    config: {
      harborVersion: HARBOR_VERSION,
      harness: "full-dev-flow",
      agent: "custom-full-dev-flow",
      datasetRef: context.datasetRef,
      datasetRevision: context.datasetRevision,
      taskDigest: context.taskDigest,
      taskRef: context.compatibility.taskRef,
      verifierMode: context.compatibility.verifierMode,
      sessionMode: "fresh",
      provider: "openai-codex",
      adapter: "full-dev-flow",
      packageVersion: typeof context.runtimeResolved?.piVersion === "string" ? context.runtimeResolved.piVersion : null,
      runtimeResolved: context.runtimeResolved,
      maxCycles: outcome.maxCycles,
      ...(legacyCycleInput ? { maxFixCycles: outcome.maxCycles - 1, cycleCap: outcome.maxCycles } : {}),
    },
    result: {
      id: outcome.runId,
      started_at: startedAt,
      finished_at: finishedAt,
      passed: outcome.status === "ready_for_main" ? true : outcome.status === "failed" ? false : null,
      finalCycle: outcome.cycles,
      stopReason: outcome.error ?? null,
      verifierStatus: null,
      usage: ledgerUsage.total,
    },
    orchestrator: {
      runId: outcome.runId,
      cycles: outcome.cycles,
      roles: ["router", "implementer", "reviewer", "final_reviewer"],
      tiers: [outcome.tier],
      requestedConfiguration,
      effectiveConfiguration,
      deterministicTestEvidence: outcome.verification.tests,
      usageByRole: ledgerUsage.byRole,
      usageByCycle: ledgerUsage.byCycle,
      calls,
      session: { mode: "unknown", scope: "trial", sessionId: null, evidence: "none", evidenceRefs: [] },
      providerPromptCache: { configured: null, observed: ledgerUsage.total.cacheReadTokens !== null || ledgerUsage.total.cacheWriteTokens !== null, scope: "provider", cacheReadTokens: ledgerUsage.total.cacheReadTokens, cacheWriteTokens: ledgerUsage.total.cacheWriteTokens, semanticsRef: "openai-codex/full-dev-flow/pi-process-adapter@0.82.1", evidenceRefs: calls.map((call) => String(call.provenance.sourceRef ?? "")).filter(Boolean) },
      usageWarnings: ledgerUsage.warnings,
      reviewerVerdicts: [outcome.verification.reviewerVerdict, outcome.verification.finalReviewerVerdict],
    },
    generatedAt: finishedAt,
  };
  const telemetry = normalizeBenchmarkArtifacts(telemetryInput);
  const atif = {
    schema_version: "ATIF-v1.0",
    agent: { name: "full-dev-flow", version: String(context.runtimeResolved?.devFlowBundleVersion ?? "unknown") },
    steps: [],
    final_metrics: {
      input_tokens: ledgerUsage.total.inputTokens ?? null,
      cached_tokens: ledgerUsage.total.cacheReadTokens ?? null,
      output_tokens: ledgerUsage.total.outputTokens ?? null,
      cost_usd: null,
    },
  };
  await writeJson(join(fullLogDir, "telemetry.json"), telemetry);
  await writeJson(join(fullLogDir, "trajectory.json"), atif);
  await writeJson(join(agentLogDir, "trajectory.json"), atif);
  await writeJson(join(fullLogDir, "artifact-manifest.json"), exported);
  await writeJson(join(fullLogDir, "runtime-resolved.json"), context.runtimeResolved ?? {});
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

type UsageMetric = { sum: number; seen: boolean; missing: boolean };
type UsageAccumulator = { calls: number; metrics: Record<string, UsageMetric> };
type EffectiveObservationRecord = { value: string | number | null; status: "observed" | "not-observed" | "unsupported" | "conflict"; source: string; evidenceRefs: string[] };
type CallEffectiveConfiguration = {
  model: EffectiveObservationRecord;
  reasoningEffort: EffectiveObservationRecord;
  tier: EffectiveObservationRecord;
};
type LedgerUsage = {
  total: Record<string, unknown>;
  byRole: Array<{ role: string; usage: Record<string, unknown> }>;
  byCycle: Array<{ cycle: number; usage: Record<string, unknown> }>;
  calls: Array<{ callId: string | null; role: string; cycle: number; usage: Record<string, unknown>; effective: CallEffectiveConfiguration; session: Record<string, unknown>; provenance: Record<string, unknown> }>;
  warnings: string[];
  sourceFiles: string[];
};

const USAGE_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const;

async function collectLedgerUsage(ledgerRoot: string): Promise<LedgerUsage> {
  const total = newAccumulator();
  const roles = new Map<string, UsageAccumulator>();
  const cycles = new Map<number, UsageAccumulator>();
  const warnings: string[] = [];
  const sourceFiles: string[] = [];
  const calls: LedgerUsage["calls"] = [];
  const seenEventIds = new Set<string>();
  const entries = await readdir(ledgerRoot).catch(() => [] as string[]);

  const add = (usage: Record<string, unknown>, role: string, cycle: number, source: string, callId: string | null, sourceKind: "ledger-file" | "runtime-event", effective: CallEffectiveConfiguration = unknownEffectiveConfiguration()): void => {
    addUsage(total, usage);
    const roleAccumulator = roles.get(role) ?? newAccumulator();
    addUsage(roleAccumulator, usage);
    roles.set(role, roleAccumulator);
    const cycleAccumulator = cycles.get(cycle) ?? newAccumulator();
    addUsage(cycleAccumulator, usage);
    cycles.set(cycle, cycleAccumulator);
    if (!sourceFiles.includes(source)) sourceFiles.push(source);
    calls.push({
      callId,
      role,
      cycle,
      usage,
      effective,
      // The adapter receives a role-scoped session directory, but the ledger
      // does not retain a preflight proving that it was empty. Keep this
      // unknown instead of reporting an orchestration convention as evidence.
      session: { mode: "unknown", scope: "role", sessionId: null, evidence: "none", evidenceRefs: [] },
      provenance: { source: sourceKind, sourceRef: relative(ledgerRoot, source), dedupeKey: callId ?? relative(ledgerRoot, source) },
    });
  };

  for (const name of entries) {
    const match = /^cycle-(\d+)-(implementer|reviewer|final|final_reviewer)\.json$/.exec(name);
    if (!match) continue;
    const source = join(ledgerRoot, name);
    const parsed = await readJsonRecord(source);
    const usage = usageRecord(parsed?.usage);
    if (!usage) {
      warnings.push(`missing usage in ${name}`);
      continue;
    }
    const role = match[2] === "final" ? "final_reviewer" : match[2];
    add(usage, role, Number(match[1]), source, relative(ledgerRoot, source), "ledger-file", effectiveFromAdapterInvocation(asRecord(parsed?.sessionMetadata), relative(ledgerRoot, source)));
  }

  for (const name of entries.filter((entry) => entry === "router-initial" || /^cycle-\d+-router$/.test(entry))) {
    const cycleMatch = /^cycle-(\d+)-router$/.exec(name);
    const cycle = cycleMatch ? Number(cycleMatch[1]) : 0;
    for (const filename of ["events.jsonl", "trace.jsonl"]) {
      const source = join(ledgerRoot, name, filename);
      let text: string;
      try { text = await readFile(source, "utf8"); } catch { continue; }
      for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
      if (!line) continue;
      const event = parseJsonRecord(line);
      if (event?.type !== "message_end") continue;
      const message = asRecord(event.message);
      const usage = usageRecord(event.usage) ?? usageRecord(message?.usage);
      if (!usage) {
        warnings.push(`message_end without usage in ${name}`);
        continue;
      }
      const eventId = event.messageId ?? event.id ?? message?.id;
      if (typeof eventId === "string" && eventId && seenEventIds.has(`${name}:${eventId}`)) continue;
      if (typeof eventId === "string" && eventId) seenEventIds.add(`${name}:${eventId}`);
      const eventRef = `${relative(ledgerRoot, source)}#line-${lineIndex + 1}`;
      add(usage, "router", cycle, source, typeof eventId === "string" && eventId ? `${name}:${eventId}` : eventRef, "runtime-event", effectiveFromRuntimeEvent(event, message, eventRef));
      }
    }
  }

  for (const field of USAGE_FIELDS) {
    if (total.metrics[field].missing) warnings.push(`aggregate usage missing ${field} for one or more model calls`);
  }
  if (total.calls === 0) warnings.push("no ledger model usage records found");
  return {
    total: finishUsage(total),
    byRole: [...roles.entries()].map(([role, accumulator]) => ({ role, usage: finishUsage(accumulator) })),
    byCycle: [...cycles.entries()].sort(([left], [right]) => left - right).map(([cycle, accumulator]) => ({ cycle, usage: finishUsage(accumulator) })),
    calls,
    warnings,
    sourceFiles,
  };
}

function unknownObservation(): EffectiveObservationRecord {
  return { value: null, status: "not-observed", source: "none", evidenceRefs: [] };
}

function unknownEffectiveConfiguration(): CallEffectiveConfiguration {
  return { model: unknownObservation(), reasoningEffort: unknownObservation(), tier: unknownObservation() };
}

function observedObservation(value: string | number, source: string, evidenceRef: string): EffectiveObservationRecord {
  return { value, status: "observed", source, evidenceRefs: [evidenceRef] };
}

function effectiveFromAdapterInvocation(metadata: Record<string, unknown> | undefined, evidenceRef: string): CallEffectiveConfiguration {
  if (!metadata) return unknownEffectiveConfiguration();
  const effective = unknownEffectiveConfiguration();
  const model = stringValue(metadata.model);
  const reasoning = reasoningValue(metadata.reasoning);
  if (model) effective.model = observedObservation(model, "adapter-invocation", evidenceRef);
  if (reasoning) effective.reasoningEffort = observedObservation(reasoning, "adapter-invocation", evidenceRef);
  return effective;
}

function effectiveFromRuntimeEvent(event: Record<string, unknown> | undefined, message: Record<string, unknown> | undefined, evidenceRef: string): CallEffectiveConfiguration {
  const effective = unknownEffectiveConfiguration();
  if (!event && !message) return effective;
  const eventRecord = event ?? {};
  const messageRecord = message ?? {};
  const rawModel = stringValue(eventRecord.model) ?? stringValue(messageRecord.model);
  const provider = stringValue(eventRecord.provider) ?? stringValue(messageRecord.provider);
  const model = rawModel && provider && !rawModel.includes("/") ? `${provider}/${rawModel}` : rawModel;
  const reasoning = reasoningValue(eventRecord.thinking) ?? reasoningValue(messageRecord.thinking) ?? reasoningValue(eventRecord.reasoning) ?? reasoningValue(messageRecord.reasoning);
  const tier = tierValue(eventRecord.tier) ?? tierValue(messageRecord.tier) ?? tierValue(eventRecord.selectedTier) ?? tierValue(messageRecord.selectedTier);
  if (model) effective.model = observedObservation(model, "runtime-event", evidenceRef);
  if (reasoning) effective.reasoningEffort = observedObservation(reasoning, "runtime-event", evidenceRef);
  if (tier !== null) effective.tier = observedObservation(tier, "runtime-event", evidenceRef);
  return effective;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function reasoningValue(value: unknown): "low" | "medium" | "high" | "xhigh" | null {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : null;
}

function tierValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2 ? value : null;
}

function sanitizeCall(call: LedgerUsage["calls"][number], evidenceRef: string, index: number): LedgerUsage["calls"][number] {
  const ref = `${evidenceRef}#calls[${index}]`;
  const effective = Object.fromEntries(Object.entries(call.effective).map(([field, observation]) => [field, {
    ...observation,
    evidenceRefs: observation.status === "observed" ? [ref] : [],
  }])) as CallEffectiveConfiguration;
  return {
    ...call,
    callId: ref,
    effective,
    provenance: { ...call.provenance, sourceRef: ref, dedupeKey: ref },
  };
}

function sanitizeCallEvidence(call: LedgerUsage["calls"][number]): Record<string, unknown> {
  const value = (field: keyof CallEffectiveConfiguration): string | number | null => call.effective[field].status === "observed" ? call.effective[field].value : null;
  return {
    role: call.role,
    cycle: call.cycle,
    model: value("model"),
    reasoning: value("reasoningEffort"),
    tier: value("tier"),
    usage: sanitizedUsage(call.usage),
    session: {
      mode: call.session.mode ?? "unknown",
      evidence: call.session.evidence ?? "none",
    },
  };
}

function sanitizedUsage(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    inputTokens: usageNumber(usage, "inputTokens"),
    outputTokens: usageNumber(usage, "outputTokens"),
    cacheReadTokens: usageNumber(usage, "cacheReadTokens"),
    cacheWriteTokens: usageNumber(usage, "cacheWriteTokens"),
    costUsd: usageNumber(usage, "costUsd"),
  };
}

function deriveEffectiveConfiguration(calls: LedgerUsage["calls"]): Record<string, unknown> {
  return {
    model: deriveEffectiveField(calls, "model"),
    reasoningEffort: deriveEffectiveField(calls, "reasoningEffort"),
    tier: deriveEffectiveField(calls, "tier"),
  };
}

function deriveEffectiveField(calls: LedgerUsage["calls"], field: keyof CallEffectiveConfiguration): EffectiveObservationRecord {
  const observations = calls.map((call) => call.effective[field]);
  const observed = observations.filter((item) => item.status === "observed" && item.value !== null);
  const values = [...new Set(observed.map((item) => item.value))];
  const evidenceRefs = observations.flatMap((item) => item.evidenceRefs);
  if (values.length > 1) return { value: null, status: "conflict", source: "conflicting-call-observations", evidenceRefs: [...new Set(evidenceRefs)] };
  if (values.length === 1 && observed.length === observations.length && observations.length > 0) {
    return { value: values[0]!, status: "observed", source: "derived-consistent-call-observations", evidenceRefs: [...new Set(evidenceRefs)] };
  }
  return { value: null, status: "not-observed", source: "none", evidenceRefs: [...new Set(evidenceRefs)] };
}

function newAccumulator(): UsageAccumulator {
  return { calls: 0, metrics: Object.fromEntries(USAGE_FIELDS.map((field) => [field, { sum: 0, seen: false, missing: false }])) as Record<string, UsageMetric> };
}

function addUsage(accumulator: UsageAccumulator, usage: Record<string, unknown>): void {
  accumulator.calls += 1;
  for (const field of USAGE_FIELDS) {
    const value = usageNumber(usage, field);
    if (value === null) accumulator.metrics[field].missing = true;
    else { accumulator.metrics[field].seen = true; accumulator.metrics[field].sum += value; }
  }
}

function finishUsage(accumulator: UsageAccumulator): Record<string, unknown> {
  const output: Record<string, unknown> = { modelCallCount: accumulator.calls || null };
  for (const field of USAGE_FIELDS) output[field] = accumulator.metrics[field].seen && !accumulator.metrics[field].missing ? accumulator.metrics[field].sum : null;
  return output;
}

function usageNumber(usage: Record<string, unknown>, field: (typeof USAGE_FIELDS)[number]): number | null {
  const candidates: Record<string, string[]> = {
    inputTokens: ["n_input_tokens", "input_tokens", "inputTokens", "input", "prompt_tokens"],
    outputTokens: ["n_output_tokens", "output_tokens", "outputTokens", "output", "completion_tokens"],
    cacheReadTokens: ["n_cache_tokens", "cache_read_tokens", "cacheReadTokens", "cacheRead", "cached_tokens"],
    cacheWriteTokens: ["cache_write_tokens", "cacheWriteTokens", "cacheWrite"],
    costUsd: ["cost_usd", "costUsd"],
  };
  for (const key of candidates[field]) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  if (field === "costUsd") {
    const cost = asRecord(usage.cost);
    if (typeof cost?.total === "number" && Number.isFinite(cost.total)) return cost.total;
  }
  return null;
}

function usageRecord(value: unknown): Record<string, unknown> | undefined {
  const result = asRecord(value);
  return result && Object.keys(result).length ? result : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function readJsonRecord(path: string): Promise<Record<string, unknown> | undefined> {
  try { return parseJsonRecord(await readFile(path, "utf8")); } catch { return undefined; }
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try { return asRecord(JSON.parse(text)); } catch { return undefined; }
}


async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1]?.endsWith("harbor-bridge.js")) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(errorMessage(error).slice(0, 500));
    process.exitCode = 1;
  });
}

export { assertCompatibility, exportArtifacts, main };
