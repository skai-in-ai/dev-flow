import type { HarborAgent, HarborHarness, ReasoningEffort, SessionMode, VerifierMode } from "./harbor-runtime.js";
import { CACHE_SEMANTICS_SCHEMA_VERSION, findCacheSemantics, type CacheDenominator, type CacheSemanticsDefinition } from "./cache-semantics.js";

export type TelemetrySource = "fake-fixture" | "harbor-artifacts" | "orchestrator-ledger" | "mixed";
type NullableNumber = number | null;
export type EffectiveObservationStatus = "observed" | "not-observed" | "unsupported" | "conflict";
export type SessionScope = "trial" | "role" | "call";
export type SessionEvidence = "preflight-empty-session-dir" | "explicit-reuse" | "runtime-event" | "none";

export interface EffectiveObservation<T> {
  value: T | null;
  status: EffectiveObservationStatus;
  source: string;
  evidenceRefs: string[];
}

export interface RequestedConfiguration {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  tier: number | null;
  maxTier: number | null;
  maxCycles?: number | null;
  /** @deprecated Legacy retry-count field retained for old artifacts. */
  maxFixCycles?: number | null;
  cycleCap?: number | null;
  source: string;
}

export interface EffectiveConfiguration {
  model: EffectiveObservation<string>;
  reasoningEffort: EffectiveObservation<ReasoningEffort>;
  tier: EffectiveObservation<number>;
  maxCycles?: EffectiveObservation<number>;
  /** @deprecated Legacy retry-count field retained for old artifacts. */
  maxFixCycles?: EffectiveObservation<number>;
  cycleCap?: EffectiveObservation<number>;
}

export interface SessionTelemetry {
  mode: SessionMode;
  scope: SessionScope;
  sessionId: null;
  evidence: SessionEvidence;
  evidenceRefs: string[];
}

export interface ProviderPromptCacheTelemetry {
  configured: boolean | null;
  observed: boolean | null;
  scope: "call" | "session" | "provider" | "unknown";
  cacheReadTokens: NullableNumber;
  cacheWriteTokens: NullableNumber;
  semanticsRef: string | null;
  evidenceRefs: string[];
}

export interface DerivedCacheMetric {
  value: number;
  formula: string;
  sourceFields: string[];
  evidenceRefs: string[];
  derivationVersion: typeof CACHE_SEMANTICS_SCHEMA_VERSION;
}

export interface CacheSemanticsTelemetry {
  registryKey: string | null;
  denominator: CacheDenominator;
  unit: "provider-token" | "unknown";
  formula: string | null;
  confidence: "observed" | "derived" | "unknown";
  provenance: {
    source: "provider-contract" | "runtime-usage" | "adapter-contract" | "none";
    evidenceRefs: string[];
  };
  derived: {
    totalPromptTokens: DerivedCacheMetric | null;
    uncachedInputTokens: DerivedCacheMetric | null;
    cacheHitRate: DerivedCacheMetric | null;
  };
}

export interface CanonicalCallTelemetry {
  callId: string | null;
  role: string;
  cycle: number | null;
  sessionId: null;
  requested: RequestedConfiguration;
  effective: EffectiveConfiguration;
  usage: NormalizedUsage;
  cacheSemantics: CacheSemanticsTelemetry;
  session: SessionTelemetry;
  provenance: {
    source: "ledger-file" | "pi-message-end" | "harbor-result" | "runtime-event" | "unknown";
    sourceRef: string | null;
    dedupeKey: string | null;
  };
}

export interface BenchmarkArtifactInput {
  source: TelemetrySource;
  fixtureVersion?: string;
  trialId?: string;
  taskId?: string;
  configuration?: Record<string, unknown>;
  sourceFiles?: readonly string[];
  config: Record<string, unknown>;
  artifactConfig?: Record<string, unknown>;
  artifactManifest?: unknown;
  result?: Record<string, unknown>;
  trajectory?: Record<string, unknown>;
  reward?: string | number | null;
  rewardText?: string | number | null;
  legacyReward?: string | number | null;
  rewardPolicy?: { passAtOrAbove: number };
  pricingSnapshot?: Record<string, unknown>;
  billingEvidence?: Record<string, unknown>;
  orchestrator?: Record<string, unknown>;
  runtimeResolved?: Record<string, unknown>;
  generatedAt?: string;
}

export interface NormalizedUsageSummary {
  role?: string;
  cycle?: number;
  usage: NormalizedUsage;
}

export interface NormalizedUsage {
  inputTokens: NullableNumber;
  totalPromptTokens: NullableNumber;
  outputTokens: NullableNumber;
  cacheReadTokens: NullableNumber;
  cacheWriteTokens: NullableNumber;
  uncachedInputTokens: NullableNumber;
  modelCallCount: NullableNumber;
  estimatedCostUsd: NullableNumber;
  actualCostUsd: NullableNumber;
  rateLimitCount: NullableNumber;
  timeoutCount: NullableNumber;
}

export interface DerivedUsage {
  uncachedInputTokens: { value: number; formula: string; sourceFields: string[] } | null;
  cacheSemantics: CacheSemanticsTelemetry;
}

export interface BenchmarkTrialTelemetry {
  schemaVersion: "benchmark-trial-2";
  trial: {
    trialId: string;
    trialName: string | null;
    taskId: string;
    taskName: string | null;
    taskRef: string | null;
    datasetRef: string;
    datasetRevision: string;
    taskDigest: string;
    harness: HarborHarness;
    source: TelemetrySource;
  };
  configuration: {
    harborVersion: string | null;
    agent: HarborAgent | null;
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
    timeoutSeconds: NullableNumber;
    trialCount: NullableNumber;
    maxCycles: NullableNumber;
    maxFixCycles?: NullableNumber;
    cycleCap: NullableNumber;
    verifierMode: VerifierMode | null;
    sessionMode: SessionMode | null;
    reviewerEnabled: boolean | null;
    finalReviewerEnabled: boolean | null;
    routingEnabled: boolean | null;
    promptCacheConfigured: boolean | null;
    requested: RequestedConfiguration;
    effective: EffectiveConfiguration;
  };
  result: {
    passed: boolean | null;
    reward: number | null;
    firstPassingCycle: NullableNumber;
    finalCycle: NullableNumber;
    stopReason: string | null;
    failureCategory: string | null;
    verifierStatus: string | null;
    durationMs: NullableNumber;
  };
  usage: NormalizedUsage;
  derived: DerivedUsage;
  orchestration: {
    runId: string | null;
    cycles: NullableNumber;
    roles: string[];
    tiers: number[];
    retryCount: NullableNumber;
    reviewerVerdicts: string[];
    deterministicTestEvidence: unknown[];
    usageByRole: NormalizedUsageSummary[];
    usageByCycle: NormalizedUsageSummary[];
    calls: CanonicalCallTelemetry[];
    session: SessionTelemetry;
    providerPromptCache: ProviderPromptCacheTelemetry;
    requestedConfiguration?: Record<string, unknown>;
    effectiveConfiguration?: Record<string, unknown>;
  };
  cycles: Array<{
    cycle: number;
    snapshotRef: string | null;
    durationMs: NullableNumber;
    usage: NormalizedUsage;
    tests: unknown[];
    reviewFindingFingerprint: string | null;
    recovered: boolean | null;
    regression: boolean | null;
    stopReason: string | null;
  }>;
  provenance: {
    sourceFiles: string[];
    generatedAt: string;
    usagePrecedence: "final totals > trajectory metrics > step metrics";
    pricingEvidence: boolean;
    billingEvidence: boolean;
    rewardSource: "verifier_result" | "reward_text" | "legacy_flat" | "none";
    passedDerivedFromReward: boolean;
    timing: {
      rawStartedAt: string | null;
      rawFinishedAt: string | null;
      source: "finished_at-started_at" | "phase-span" | "none";
    };
    normalizationWarnings: string[];
    sourceSchemaVersion: string;
  };
}

export function normalizeBenchmarkArtifacts(input: BenchmarkArtifactInput): BenchmarkTrialTelemetry {
  const config = input.config;
  const telemetryConfig = input.configuration ?? config;
  const result = input.result ?? {};
  const orchestrator = input.orchestrator ?? {};
  const agentResult = record(result.agent_result);
  const verifierResult = record(result.verifier_result);
  const taskIdentity = record(result.task_id);
  const dataset = record(config.dataset);
  const task = Array.isArray(dataset?.tasks) ? record(dataset?.tasks[0]) : undefined;
  const harness = oneOf(config.harness, ["harbor-codex", "single-pi", "full-dev-flow"] as const, "harness");
  const sourceFiles = [...(input.sourceFiles ?? [])];
  const warnings: string[] = [];
  const requested = normalizeRequestedConfiguration(orchestrator.requestedConfiguration ?? config, "config");
  const runtimeAgent = record(input.trajectory?.agent);
  const runtimeModel = stringOrNull(runtimeAgent?.model_name) ?? stringOrNull(runtimeAgent?.model);
  const runtimeEffective = runtimeModel ? { model: { value: runtimeModel, status: "observed", source: "harbor-atif.agent.model_name", evidenceRefs: ["agent/trajectory.json"] } } : undefined;
  const effective = normalizeEffectiveConfiguration(orchestrator.effectiveConfiguration ?? runtimeEffective ?? config.effectiveConfiguration);
  const session = normalizeSession(orchestrator.session ?? telemetryConfig.session, "trial");
  const providerPromptCache = normalizeProviderPromptCache(orchestrator.providerPromptCache ?? telemetryConfig.providerPromptCache);
  // Step metrics are the lowest-precedence fallback. Explicit final totals win
  // over trajectory totals, which win over individual steps.
  const stepMetrics = trajectoryStepMetrics(input.trajectory);
  const finalRecords = [record(input.trajectory?.metrics), record(input.trajectory?.usage), record(result.usage), record(config.usage), agentResult].filter((value): value is Record<string, unknown> => value !== undefined);
  const usageRecords = [...stepMetrics, ...finalRecords];
  if (!usageRecords.length) warnings.push("no usage record supplied");
  if (stepMetrics.length && finalRecords.length) warnings.push("usage precedence: final totals > trajectory metrics > step metrics");
  const pricingEvidence = isPricingSnapshot(input.pricingSnapshot ?? record(config.pricingSnapshot));
  const billingEvidence = isBillingEvidence(input.billingEvidence ?? record(config.billingEvidence));
  const usage = normalizeUsage(usageRecords, pricingEvidence, billingEvidence);
  for (const warning of stringArray(orchestrator.usageWarnings)) warnings.push(warning);
  const cacheDefinition = resolveCacheDefinition(config, input.runtimeResolved);
  const cacheSemantics = deriveCacheSemantics(usage, cacheDefinition, config, warnings);
  const derived: DerivedUsage = { uncachedInputTokens: cacheSemantics.derived.uncachedInputTokens ? {
    value: cacheSemantics.derived.uncachedInputTokens.value,
    formula: cacheSemantics.derived.uncachedInputTokens.formula,
    sourceFields: cacheSemantics.derived.uncachedInputTokens.sourceFields,
  } : null, cacheSemantics };
  const calls = normalizeCalls(orchestrator.calls, requested, effective, session, cacheDefinition, pricingEvidence, billingEvidence, warnings);
  const cycles = normalizeCycles(orchestrator.cycles);
  const rewardInfo = resolveReward(input, result, verifierResult);
  const reward = rewardInfo.value;
  const explicitPassed = booleanOrNull(result.passed) ?? booleanOrNull(result.success);
  const passedDerivedFromReward = explicitPassed === null && reward !== null && input.rewardPolicy !== undefined;
  const passed = explicitPassed ?? (passedDerivedFromReward ? reward >= input.rewardPolicy!.passAtOrAbove : null);
  const timing = deriveTiming(result, warnings);
  const trialId = stringOrNull(input.trialId) ?? stringOrNull(result.id) ?? stringOrNull(config.trialId) ?? stringOrNull(orchestrator.runId) ?? "unknown-trial";
  const taskName = stringOrNull(result.task_name) ?? stringOrNull(config.taskName);
  const taskId = stringOrNull(input.taskId) ?? taskName ?? stringOrNull(taskIdentity?.name) ?? stringOrNull(config.taskId) ?? stringOrNull(task?.id) ?? "unknown-task";
  const taskRef = stringOrNull(taskIdentity?.ref) ?? stringOrNull(config.taskRef);
  if (result.exception_info !== undefined && result.exception_info !== null) warnings.push("exception_info present; failure category and stop reason remain null unless explicitly supplied");
  return {
    schemaVersion: "benchmark-trial-2",
    trial: {
      trialId,
      trialName: stringOrNull(result.trial_name),
      taskId,
      taskName,
      taskRef,
      datasetRef: stringOrNull(dataset?.ref) ?? stringOrNull(config.datasetRef) ?? "unknown-dataset",
      datasetRevision: stringOrNull(dataset?.revision) ?? stringOrNull(config.datasetRevision) ?? "unknown-revision",
      taskDigest: stringOrNull(result.task_checksum) ?? stringOrNull(config.taskDigest) ?? stringOrNull(task?.sha256) ?? "unknown-digest",
      harness,
      source: input.source,
    },
    configuration: {
      harborVersion: stringOrNull(config.harborVersion),
      agent: oneOfOrNull(config.agent, ["codex", "pi", "custom-full-dev-flow"] as const),
      model: stringOrNull(config.model),
      reasoningEffort: oneOfOrNull(config.reasoningEffort, ["low", "medium", "high", "xhigh"] as const),
      timeoutSeconds: numberOrNull(config.timeoutSeconds),
      trialCount: numberOrNull(config.trialCount),
      maxCycles: canonicalMaxCycles(config),
      maxFixCycles: numberOrNull(config.maxFixCycles),
      cycleCap: numberOrNull(config.cycleCap),
      verifierMode: oneOfOrNull(config.verifierMode, ["shared", "separate", "unknown"] as const),
      sessionMode: oneOfOrNull(config.sessionMode, ["fresh", "reused", "unknown"] as const),
      reviewerEnabled: booleanOrNull(telemetryConfig.reviewerEnabled),
      finalReviewerEnabled: booleanOrNull(telemetryConfig.finalReviewerEnabled),
      routingEnabled: booleanOrNull(telemetryConfig.routingEnabled),
      promptCacheConfigured: booleanOrNull(telemetryConfig.promptCacheConfigured),
      requested,
      effective,
    },
    result: {
      passed,
      reward,
      firstPassingCycle: numberOrNull(result.firstPassingCycle),
      finalCycle: numberOrNull(result.finalCycle),
      stopReason: stringOrNull(result.stopReason),
      failureCategory: stringOrNull(result.failureCategory),
      verifierStatus: stringOrNull(result.verifierStatus) ?? (result.exception_info !== undefined && result.exception_info !== null ? "exception" : null),
      durationMs: timing.durationMs,
    },
    usage,
    derived,
    orchestration: {
      runId: stringOrNull(orchestrator.runId),
      cycles: numberOrNull(orchestrator.cycles) ?? (cycles.length ? cycles.length : null),
      roles: stringArray(orchestrator.roles),
      tiers: numberArray(orchestrator.tiers),
      retryCount: numberOrNull(orchestrator.retryCount),
      reviewerVerdicts: stringArray(orchestrator.reviewerVerdicts),
      deterministicTestEvidence: unknownArray(orchestrator.deterministicTestEvidence),
      usageByRole: normalizeUsageSummaries(orchestrator.usageByRole, pricingEvidence, billingEvidence, "role"),
      usageByCycle: normalizeUsageSummaries(orchestrator.usageByCycle, pricingEvidence, billingEvidence, "cycle"),
      calls,
      session,
      providerPromptCache,
      ...(record(orchestrator.requestedConfiguration) ? { requestedConfiguration: record(orchestrator.requestedConfiguration) } : {}),
      ...(record(orchestrator.effectiveConfiguration) ? { effectiveConfiguration: record(orchestrator.effectiveConfiguration) } : {}),
    },
    cycles,
    provenance: { sourceFiles, generatedAt: input.generatedAt ?? new Date().toISOString(), usagePrecedence: "final totals > trajectory metrics > step metrics", pricingEvidence, billingEvidence, rewardSource: rewardInfo.source, passedDerivedFromReward, timing: { rawStartedAt: timing.rawStartedAt, rawFinishedAt: timing.rawFinishedAt, source: timing.source }, normalizationWarnings: warnings, sourceSchemaVersion: stringOrNull(config.schemaVersion) ?? "unknown" },
  };
}

/** Upgrade legacy normalized telemetry in memory without rewriting its source artifact. */
export function migrateBenchmarkTrialTelemetry(value: unknown): BenchmarkTrialTelemetry | null {
  const item = record(value);
  if (!item || !record(item.trial)) return null;
  if (item.schemaVersion === "benchmark-trial-2") return item as unknown as BenchmarkTrialTelemetry;
  if (item.schemaVersion !== "benchmark-trial-1") return null;
  const configuration = record(item.configuration) ?? {};
  const orchestration = record(item.orchestration) ?? {};
  const usage = record(item.usage) ?? {};
  const derived = record(item.derived) ?? {};
  const provenance = record(item.provenance) ?? {};
  const migrated = structuredClone(item) as Record<string, unknown>;
  migrated.schemaVersion = "benchmark-trial-2";
  migrated.configuration = {
    ...configuration,
    requested: normalizeRequestedConfiguration(orchestration.requestedConfiguration ?? configuration, "legacy-v1"),
    effective: normalizeEffectiveConfiguration(undefined),
  };
  migrated.usage = { ...usage, totalPromptTokens: numberOrNull(usage.totalPromptTokens) };
  migrated.derived = { ...derived, cacheSemantics: unknownCacheSemantics() };
  migrated.orchestration = {
    ...orchestration,
    calls: [],
    session: { mode: "unknown", scope: "trial", sessionId: null, evidence: "none", evidenceRefs: [] },
    providerPromptCache: normalizeProviderPromptCache(undefined),
  };
  migrated.provenance = {
    ...provenance,
    sourceSchemaVersion: "benchmark-trial-1",
    normalizationWarnings: [...stringArray(provenance.normalizationWarnings), "legacy benchmark-trial-1 migrated in memory; effective/cache/session evidence missing and remains unknown"],
  };
  return migrated as unknown as BenchmarkTrialTelemetry;
}

function normalizeUsage(records: Record<string, unknown>[], pricingEvidence = false, billingEvidence = false): NormalizedUsage {
  const merged = Object.assign({}, ...records);
  return {
    inputTokens: firstNumber(merged, ["n_input_tokens", "input_tokens", "prompt_tokens", "inputTokens", "promptTokens", "input"]),
    totalPromptTokens: firstNumber(merged, ["total_prompt_tokens", "totalPromptTokens", "total_prompt"]),
    outputTokens: firstNumber(merged, ["n_output_tokens", "output_tokens", "completion_tokens", "outputTokens", "completionTokens", "output"]),
    cacheReadTokens: firstNumber(merged, ["n_cache_tokens", "cached_input_tokens", "cache_read_tokens", "cached_tokens", "cachedInputTokens", "cacheReadTokens", "cacheRead"]),
    cacheWriteTokens: firstNumber(merged, ["cache_write_input_tokens", "cache_write_tokens", "cacheWriteInputTokens", "cacheWriteTokens", "cacheWrite"]),
    uncachedInputTokens: firstNumber(merged, ["uncached_input_tokens", "uncachedInputTokens"]),
    modelCallCount: firstNumber(merged, ["llm_call_count", "model_call_count", "llmCallCount", "modelCallCount"]),
    estimatedCostUsd: pricingEvidence ? firstNumber(merged, ["estimated_cost_usd", "estimatedCostUsd", "cost_usd"]) : null,
    actualCostUsd: billingEvidence ? firstNumber(merged, ["actual_cost_usd", "actualCostUsd", "cost_usd"]) : null,
    rateLimitCount: firstNumber(merged, ["rate_limit_count", "rateLimitCount"]),
    timeoutCount: firstNumber(merged, ["timeout_count", "timeoutCount"]),
  };
}

function normalizeRequestedConfiguration(value: unknown, fallbackSource: string): RequestedConfiguration {
  const item = record(value) ?? {};
  const requested: RequestedConfiguration = {
    model: stringOrNull(item.model),
    reasoningEffort: oneOfOrNull(item.reasoningEffort, ["low", "medium", "high", "xhigh"] as const),
    tier: numberOrNull(item.tier),
    maxTier: numberOrNull(item.maxTier),
    source: stringOrNull(item.source) ?? fallbackSource,
  };
  if (Object.prototype.hasOwnProperty.call(item, "maxCycles")) requested.maxCycles = numberOrNull(item.maxCycles);
  if (Object.prototype.hasOwnProperty.call(item, "maxFixCycles")) requested.maxFixCycles = numberOrNull(item.maxFixCycles);
  if (!Object.prototype.hasOwnProperty.call(item, "maxCycles") && typeof requested.maxFixCycles === "number") {
    requested.maxCycles = requested.maxFixCycles + 1;
  }
  if (Object.prototype.hasOwnProperty.call(item, "cycleCap")) requested.cycleCap = numberOrNull(item.cycleCap);
  return requested;
}

function normalizeEffectiveConfiguration(value: unknown): EffectiveConfiguration {
  const item = record(value);
  const effective: EffectiveConfiguration = {
    model: normalizeEffectiveField(item?.model, "model"),
    reasoningEffort: normalizeEffectiveField(item?.reasoningEffort, "reasoningEffort"),
    tier: normalizeEffectiveField(item?.tier, "tier"),
  };
  if (item && Object.prototype.hasOwnProperty.call(item, "maxCycles")) effective.maxCycles = normalizeEffectiveField(item.maxCycles, "maxCycles");
  if (item && Object.prototype.hasOwnProperty.call(item, "maxFixCycles")) effective.maxFixCycles = normalizeEffectiveField(item.maxFixCycles, "maxFixCycles");
  if (item && !Object.prototype.hasOwnProperty.call(item, "maxCycles") && Object.prototype.hasOwnProperty.call(item, "maxFixCycles")) {
    const legacy = normalizeEffectiveField(item.maxFixCycles, "maxFixCycles");
    effective.maxCycles = {
      value: typeof legacy.value === "number" ? legacy.value + 1 : null,
      status: legacy.status,
      source: "legacy-normalization",
      evidenceRefs: legacy.evidenceRefs,
    };
  }
  if (item && Object.prototype.hasOwnProperty.call(item, "cycleCap")) effective.cycleCap = normalizeEffectiveField(item.cycleCap, "cycleCap");
  return effective;
}

function canonicalMaxCycles(config: Record<string, unknown>): number | null {
  if (Object.prototype.hasOwnProperty.call(config, "maxCycles")) return numberOrNull(config.maxCycles);
  const legacy = numberOrNull(config.maxFixCycles);
  return legacy === null ? null : legacy + 1;
}

function normalizeEffectiveField<T extends string | number>(value: unknown, field: string): EffectiveObservation<T> {
  const item = record(value);
  if (item) {
    const rawValue = item.value;
    const status = oneOfOrNull(item.status, ["observed", "not-observed", "unsupported", "conflict"] as const) ?? (rawValue === null || rawValue === undefined ? "not-observed" : "observed");
    const normalized = typeof rawValue === "string" || (typeof rawValue === "number" && Number.isFinite(rawValue)) ? rawValue as T : null;
    return {
      value: normalized,
      status,
      source: stringOrNull(item.source) ?? (status === "not-observed" ? "none" : "runtime-event"),
      evidenceRefs: stringArray(item.evidenceRefs),
    };
  }
  if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
    return { value: value as T, status: "observed", source: `runtime-${field}`, evidenceRefs: [] };
  }
  return { value: null, status: "not-observed", source: "none", evidenceRefs: [] };
}

function normalizeSession(value: unknown, scope: SessionScope): SessionTelemetry {
  const item = record(value);
  const mode = oneOfOrNull(item?.mode, ["fresh", "reused", "unknown"] as const) ?? "unknown";
  const evidence = oneOfOrNull(item?.evidence, ["preflight-empty-session-dir", "explicit-reuse", "runtime-event", "none"] as const) ?? "none";
  return {
    // Session IDs are intentionally never persisted, even if a source provides one.
    mode: mode === "fresh" && evidence === "none" ? "unknown" : mode,
    scope: oneOfOrNull(item?.scope, ["trial", "role", "call"] as const) ?? scope,
    sessionId: null,
    evidence,
    evidenceRefs: stringArray(item?.evidenceRefs),
  };
}

function normalizeProviderPromptCache(value: unknown): ProviderPromptCacheTelemetry {
  const item = record(value);
  return {
    configured: booleanOrNull(item?.configured),
    observed: booleanOrNull(item?.observed),
    scope: oneOfOrNull(item?.scope, ["call", "session", "provider", "unknown"] as const) ?? "unknown",
    cacheReadTokens: numberOrNull(item?.cacheReadTokens),
    cacheWriteTokens: numberOrNull(item?.cacheWriteTokens),
    semanticsRef: stringOrNull(item?.semanticsRef),
    evidenceRefs: stringArray(item?.evidenceRefs),
  };
}

function resolveCacheDefinition(config: Record<string, unknown>, runtimeResolved?: Record<string, unknown>): CacheSemanticsDefinition | null {
  const runtime = runtimeResolved ?? record(config.runtimeResolved);
  const provider = stringOrNull(config.provider) ?? stringOrNull(runtime?.provider);
  const adapter = stringOrNull(config.adapter) ?? stringOrNull(runtime?.adapter);
  const packageVersion = stringOrNull(config.packageVersion) ?? stringOrNull(runtime?.piVersion) ?? stringOrNull(runtime?.packageVersion);
  return findCacheSemantics({ provider, adapter, packageVersion });
}

function deriveCacheSemantics(usage: NormalizedUsage, definition: CacheSemanticsDefinition | null, config: Record<string, unknown>, warnings: string[]): CacheSemanticsTelemetry {
  if (!definition) {
    warnings.push("cache semantics registry key unknown; derived prompt/cache metrics omitted");
    return unknownCacheSemantics();
  }
  const input = usage.inputTokens;
  const read = usage.cacheReadTokens;
  const write = usage.cacheWriteTokens;
  const evidenceRefs = [definition.key];
  const totalPromptTokens = input !== null && read !== null && write !== null
    ? metric(input + read + write, definition.totalPromptFormula, ["inputTokens", "cacheReadTokens", "cacheWriteTokens"], evidenceRefs)
    : null;
  const uncachedInputTokens = input !== null
    ? metric(input, definition.uncachedInputFormula, ["inputTokens"], evidenceRefs)
    : null;
  const cacheHitRate = totalPromptTokens && read !== null && read >= 0 && read <= totalPromptTokens.value
    ? metric(read / totalPromptTokens.value, definition.cacheHitRateFormula, ["cacheReadTokens", "totalPromptTokens"], evidenceRefs)
    : null;
  if (input !== null && input < 0 || read !== null && read < 0 || write !== null && write < 0) warnings.push("negative cache usage metric; derived prompt/cache metrics omitted");
  if (totalPromptTokens === null) warnings.push("cache semantics known but cacheWriteTokens is missing; total prompt and hit rate omitted");
  return {
    registryKey: definition.key,
    denominator: definition.denominator,
    unit: definition.unit,
    formula: definition.totalPromptFormula,
    confidence: "derived",
    provenance: { source: "adapter-contract", evidenceRefs },
    derived: {
      totalPromptTokens: totalPromptTokens && input !== null && input >= 0 && (read ?? 0) >= 0 && (write ?? 0) >= 0 ? totalPromptTokens : null,
      uncachedInputTokens: uncachedInputTokens && input !== null && input >= 0 ? uncachedInputTokens : null,
      cacheHitRate: cacheHitRate && input !== null && input >= 0 && (read ?? 0) >= 0 && (write ?? 0) >= 0 ? cacheHitRate : null,
    },
  };
}

function unknownCacheSemantics(): CacheSemanticsTelemetry {
  return {
    registryKey: null,
    denominator: "unknown",
    unit: "unknown",
    formula: null,
    confidence: "unknown",
    provenance: { source: "none", evidenceRefs: [] },
    derived: { totalPromptTokens: null, uncachedInputTokens: null, cacheHitRate: null },
  };
}

function metric(value: number, formula: string, sourceFields: string[], evidenceRefs: string[]): DerivedCacheMetric {
  return { value, formula, sourceFields, evidenceRefs, derivationVersion: CACHE_SEMANTICS_SCHEMA_VERSION };
}

function normalizeCalls(value: unknown, requested: RequestedConfiguration, effective: EffectiveConfiguration, session: SessionTelemetry, cacheDefinition: CacheSemanticsDefinition | null, pricingEvidence: boolean, billingEvidence: boolean, warnings: string[]): CanonicalCallTelemetry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const calls: CanonicalCallTelemetry[] = [];
  for (const entry of value) {
    const item = record(entry);
    if (!item) continue;
    const provenanceItem = record(item.provenance);
    const dedupeKey = stringOrNull(provenanceItem?.dedupeKey) ?? stringOrNull(item.dedupeKey);
    if (dedupeKey && seen.has(dedupeKey)) {
      warnings.push(`duplicate canonical model call omitted: ${dedupeKey}`);
      continue;
    }
    if (dedupeKey) seen.add(dedupeKey);
    const callId = stringOrNull(item.callId);
    if (!callId && !dedupeKey) warnings.push("canonical model call has no stable callId or dedupeKey");
    const callSession = normalizeSession(item.session ?? session, "call");
    const callUsage = normalizeUsage([record(item.usage) ?? {}], pricingEvidence, billingEvidence);
    calls.push({
      callId,
      role: stringOrNull(item.role) ?? "unknown",
      cycle: numberOrNull(item.cycle),
      sessionId: null,
      requested: normalizeRequestedConfiguration(item.requested ?? requested, requested.source),
      effective: normalizeEffectiveConfiguration(item.effective ?? effective),
      usage: callUsage,
      cacheSemantics: deriveCacheSemantics(callUsage, cacheDefinition, {}, []),
      session: callSession,
      provenance: {
        source: oneOfOrNull(provenanceItem?.source, ["ledger-file", "pi-message-end", "harbor-result", "runtime-event", "unknown"] as const) ?? "unknown",
        sourceRef: stringOrNull(provenanceItem?.sourceRef),
        dedupeKey,
      },
    });
  }
  return calls;
}

function resolveReward(input: BenchmarkArtifactInput, result: Record<string, unknown>, verifierResult: Record<string, unknown> | undefined): { value: number | null; source: "verifier_result" | "reward_text" | "legacy_flat" | "none" } {
  const rewards = record(verifierResult?.rewards);
  const verifierReward = numberOrNull(rewards?.reward);
  if (verifierReward !== null) return { value: verifierReward, source: "verifier_result" };
  const rewardText = numberOrNull(input.rewardText ?? input.reward);
  if (rewardText !== null) return { value: rewardText, source: "reward_text" };
  const legacy = numberOrNull(input.legacyReward ?? result.reward);
  if (legacy !== null) return { value: legacy, source: "legacy_flat" };
  return { value: null, source: "none" };
}

function deriveTiming(result: Record<string, unknown>, warnings: string[]): { durationMs: number | null; rawStartedAt: string | null; rawFinishedAt: string | null; source: "finished_at-started_at" | "phase-span" | "none" } {
  const rawStartedAt = stringOrNull(result.started_at);
  const rawFinishedAt = stringOrNull(result.finished_at);
  const direct = elapsedMs(rawStartedAt, rawFinishedAt);
  if (direct.status === "valid") return { durationMs: direct.durationMs, rawStartedAt, rawFinishedAt, source: "finished_at-started_at" };
  if (rawStartedAt !== null || rawFinishedAt !== null) warnings.push(`invalid top-level timestamps: ${direct.reason}`);
  const phaseTimes: number[] = [];
  for (const [name, value] of Object.entries(result)) {
    if (!isPhaseName(name)) continue;
    const phase = record(value);
    if (!phase) continue;
    const phaseElapsed = elapsedMs(stringOrNull(phase.started_at), stringOrNull(phase.finished_at));
    if (phaseElapsed.status === "valid") {
      const start = Date.parse(String(phase.started_at));
      const finish = Date.parse(String(phase.finished_at));
      phaseTimes.push(start, finish);
    } else if (phase.started_at !== undefined || phase.finished_at !== undefined) warnings.push(`invalid ${name} timestamps: ${phaseElapsed.reason}`);
  }
  if (phaseTimes.length >= 2) return { durationMs: Math.max(...phaseTimes) - Math.min(...phaseTimes), rawStartedAt, rawFinishedAt, source: "phase-span" };
  return { durationMs: null, rawStartedAt, rawFinishedAt, source: "none" };
}

function elapsedMs(start: string | null, finish: string | null): { status: "valid" | "invalid" | "missing"; durationMs: number | null; reason: string } {
  if (start === null && finish === null) return { status: "missing", durationMs: null, reason: "missing" };
  if (start === null || finish === null) return { status: "invalid", durationMs: null, reason: "one timestamp missing" };
  const startMs = Date.parse(start);
  const finishMs = Date.parse(finish);
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs)) return { status: "invalid", durationMs: null, reason: "unparseable timestamp" };
  if (finishMs < startMs) return { status: "invalid", durationMs: null, reason: "finish precedes start" };
  return { status: "valid", durationMs: finishMs - startMs, reason: "" };
}

function isPhaseName(value: string): boolean { return /^(environment_setup|agent_setup|agent_execution|verifier)$/.test(value); }

function normalizeCycles(value: unknown): BenchmarkTrialTelemetry["cycles"] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const cycle = record(entry) ?? {};
    const usageRecords = [record(cycle.usage)].filter((item): item is Record<string, unknown> => item !== undefined);
    return {
      cycle: numberOrNull(cycle.cycle) ?? index + 1,
      snapshotRef: stringOrNull(cycle.snapshotRef),
      durationMs: numberOrNull(cycle.durationMs),
      usage: normalizeUsage(usageRecords),
      tests: unknownArray(cycle.tests),
      reviewFindingFingerprint: stringOrNull(cycle.reviewFindingFingerprint),
      recovered: booleanOrNull(cycle.recovered),
      regression: booleanOrNull(cycle.regression),
      stopReason: stringOrNull(cycle.stopReason),
    };
  });
}

function normalizeUsageSummaries(value: unknown, pricingEvidence: boolean, billingEvidence: boolean, key: "role" | "cycle"): NormalizedUsageSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = record(entry);
    const rawUsage = record(item?.usage);
    if (!rawUsage) return [];
    const summary: NormalizedUsageSummary = { usage: normalizeUsage([rawUsage], pricingEvidence, billingEvidence) };
    if (key === "role" && typeof item?.role === "string") summary.role = item.role;
    if (key === "cycle") {
      const cycle = numberOrNull(item?.cycle);
      if (cycle !== null) summary.cycle = cycle;
    }
    return [summary];
  });
}

function trajectoryStepMetrics(value: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (!value || !Array.isArray(value.steps)) return [];
  return value.steps.map((step) => record(step)?.metrics).filter((item): item is Record<string, unknown> => item !== undefined);
}
function isPricingSnapshot(value: unknown): boolean {
  const snapshot = record(value);
  return Boolean(snapshot && typeof snapshot.source === "string" && snapshot.source.trim() && typeof snapshot.version === "string" && snapshot.version.trim() && numberOrNull(snapshot.inputPerMillion) !== null && numberOrNull(snapshot.outputPerMillion) !== null);
}
function isBillingEvidence(value: unknown): boolean {
  const evidence = record(value);
  return Boolean(evidence && typeof evidence.provider === "string" && evidence.provider.trim() && typeof evidence.reference === "string" && evidence.reference.trim());
}
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function stringOrNull(value: unknown): string | null { return typeof value === "string" && value.length ? value : null; }
function numberOrNull(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null; }
function booleanOrNull(value: unknown): boolean | null { return typeof value === "boolean" ? value : null; }
function numberArray(value: unknown): number[] { return Array.isArray(value) ? value.map(numberOrNull).filter((item): item is number => item !== null) : []; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function unknownArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function firstNumber(recordValue: Record<string, unknown>, keys: string[]): number | null { for (const key of keys) { const value = numberOrNull(recordValue[key]); if (value !== null) return value; } return null; }
function oneOf<const T extends string>(value: unknown, values: readonly T[], field: string): T { const result = oneOfOrNull(value, values); if (!result) throw new Error(`${field} is required and must be one of ${values.join(", ")}`); return result; }
function oneOfOrNull<const T extends string>(value: unknown, values: readonly T[]): T | null { return typeof value === "string" && values.includes(value as T) ? value as T : null; }
