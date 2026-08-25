/**
 * Versioned provider/adapter token semantics.  This registry is deliberately
 * closed-world: an unknown package or provider version returns undefined and
 * callers must keep derived cache metrics null.
 */
export const CACHE_SEMANTICS_SCHEMA_VERSION = "cache-semantics-1" as const;

export type CacheDenominator = "totalPromptTokens" | "uncachedPlusCacheRead" | "unknown";
export type CacheSemanticsConfidence = "observed" | "derived" | "unknown";

export interface CacheSemanticsDefinition {
  schemaVersion: typeof CACHE_SEMANTICS_SCHEMA_VERSION;
  key: string;
  provider: string;
  adapter: string;
  packageVersion: string;
  unit: "provider-token";
  inputMeaning: "uncached-input" | "total-prompt";
  totalPromptFormula: string;
  uncachedInputFormula: string;
  cacheHitRateFormula: string;
  denominator: CacheDenominator;
  evidence: string;
}

/**
 * Pi 0.82.1 reports input, cacheRead and cacheWrite as separate buckets.  The
 * package's prompt-token calculation is their sum; `input` is the uncached
 * bucket and cacheWrite is not a cache-read denominator.
 */
export const CACHE_SEMANTICS_REGISTRY: readonly CacheSemanticsDefinition[] = [
  {
    schemaVersion: CACHE_SEMANTICS_SCHEMA_VERSION,
    key: "openai-codex/single-pi/@earendil-works/pi-coding-agent@0.82.1",
    provider: "openai-codex",
    adapter: "single-pi",
    packageVersion: "0.82.1",
    unit: "provider-token",
    inputMeaning: "uncached-input",
    totalPromptFormula: "inputTokens + cacheReadTokens + cacheWriteTokens",
    uncachedInputFormula: "inputTokens",
    cacheHitRateFormula: "cacheReadTokens / totalPromptTokens",
    denominator: "totalPromptTokens",
    evidence: "@earendil-works/pi-coding-agent@0.82.1 usage prompt-token calculation",
  },
  {
    schemaVersion: CACHE_SEMANTICS_SCHEMA_VERSION,
    key: "openai-codex/full-dev-flow/pi-process-adapter@0.82.1",
    provider: "openai-codex",
    adapter: "full-dev-flow",
    packageVersion: "0.82.1",
    unit: "provider-token",
    inputMeaning: "uncached-input",
    totalPromptFormula: "inputTokens + cacheReadTokens + cacheWriteTokens",
    uncachedInputFormula: "inputTokens",
    cacheHitRateFormula: "cacheReadTokens / totalPromptTokens",
    denominator: "totalPromptTokens",
    evidence: "@earendil-works/pi-coding-agent@0.82.1 usage prompt-token calculation",
  },
];

export interface CacheSemanticsLookup {
  provider: string | null;
  adapter: string | null;
  packageVersion: string | null;
}

export function findCacheSemantics(input: CacheSemanticsLookup): CacheSemanticsDefinition | null {
  if (!input.provider || !input.adapter || !input.packageVersion) return null;
  return CACHE_SEMANTICS_REGISTRY.find((entry) =>
    entry.provider === input.provider && entry.adapter === input.adapter && entry.packageVersion === input.packageVersion,
  ) ?? null;
}
