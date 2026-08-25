export const HARBOR_VERSION = "0.20.0" as const;
export const TERMINAL_BENCH_DATASET = "terminal-bench/terminal-bench-2-1" as const;

export type HarborHarness = "harbor-codex" | "single-pi" | "full-dev-flow";
export type HarborAgent = "codex" | "pi" | "custom-full-dev-flow";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type VerifierMode = "shared" | "separate" | "unknown";
export type SessionMode = "fresh" | "reused" | "unknown";

export interface HarborTaskRef {
  id: string;
  sha256: string;
}

export interface HarborRuntimeConfig {
  schemaVersion: "harbor-runtime-1";
  harborVersion: typeof HARBOR_VERSION;
  dataset: {
    ref: typeof TERMINAL_BENCH_DATASET;
    revision: string;
    tasks: HarborTaskRef[];
  };
  harness: HarborHarness;
  agent: HarborAgent;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  timeoutSeconds: number;
  trialCount: number;
  verifierMode: VerifierMode;
  allowInternet: boolean | null;
  maxCycles: number | null;
  /** @deprecated Legacy retry-count field accepted only for old manifests. */
  maxFixCycles?: number | null;
  sessionMode: SessionMode;
  notes?: string[];
}

export interface RuntimeValidationOptions {
  /** The foundation only permits a fresh, non-paid baseline. */
  executableBaseline?: boolean;
}

export function validateHarborRuntimeConfig(
  value: unknown,
  options: RuntimeValidationOptions = {},
): HarborRuntimeConfig {
  const executableBaseline = options.executableBaseline ?? true;
  if (!isRecord(value)) throw new Error("Harbor runtime config must be an object");
  assertKnownKeys(value, ["schemaVersion", "harborVersion", "dataset", "harness", "agent", "model", "reasoningEffort", "timeoutSeconds", "trialCount", "verifierMode", "allowInternet", "maxCycles", "maxFixCycles", "sessionMode", "notes"], "runtime config");
  if (value.schemaVersion !== "harbor-runtime-1") throw new Error("unsupported Harbor runtime schemaVersion");
  if (value.harborVersion !== HARBOR_VERSION) throw new Error(`Harbor version must be ${HARBOR_VERSION}`);
  if (!isRecord(value.dataset) || value.dataset.ref !== TERMINAL_BENCH_DATASET) throw new Error(`dataset.ref must be ${TERMINAL_BENCH_DATASET}`);
  assertKnownKeys(value.dataset, ["ref", "revision", "tasks"], "dataset");
  if (typeof value.dataset.revision !== "string" || !value.dataset.revision.trim() || value.dataset.revision !== value.dataset.revision.trim() || value.dataset.revision.trim().toLowerCase() === "latest") {
    throw new Error("dataset.revision must be a pinned, non-empty value (not latest)");
  }
  if (!Array.isArray(value.dataset.tasks) || value.dataset.tasks.length === 0) throw new Error("dataset.tasks must contain at least one task");
  const taskIds = new Set<string>();
  for (const task of value.dataset.tasks) {
    assertKnownKeys(task, ["id", "sha256"], "dataset task");
    if (!isRecord(task) || typeof task.id !== "string" || !task.id.trim()) throw new Error("dataset task id must be non-empty");
    if (taskIds.has(task.id)) throw new Error(`duplicate dataset task: ${task.id}`);
    taskIds.add(task.id);
    if (typeof task.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(task.sha256)) throw new Error(`invalid sha256 for dataset task: ${task.id}`);
  }
  if (!isOneOf(value.harness, ["harbor-codex", "single-pi", "full-dev-flow"] as const)) throw new Error("unsupported harness");
  if (!isOneOf(value.agent, ["codex", "pi", "custom-full-dev-flow"] as const)) throw new Error("unsupported agent");
  const expectedAgent: Record<HarborHarness, HarborAgent> = { "harbor-codex": "codex", "single-pi": "pi", "full-dev-flow": "custom-full-dev-flow" };
  if (value.agent !== expectedAgent[value.harness]) throw new Error(`agent ${String(value.agent)} does not match harness ${value.harness}`);
  if (value.model !== null && (typeof value.model !== "string" || !value.model.trim())) throw new Error("model must be a non-empty string or null");
  if (value.reasoningEffort !== null && !isOneOf(value.reasoningEffort, ["low", "medium", "high", "xhigh"] as const)) throw new Error("unsupported reasoningEffort");
  if (!positiveInteger(value.timeoutSeconds)) throw new Error("timeoutSeconds must be a positive integer");
  if (!positiveInteger(value.trialCount)) throw new Error("trialCount must be a positive integer");
  if (!isOneOf(value.verifierMode, ["shared", "separate", "unknown"] as const)) throw new Error("unsupported verifierMode");
  if (value.allowInternet !== null && typeof value.allowInternet !== "boolean") throw new Error("allowInternet must be boolean or null");
  if (value.maxCycles !== undefined && value.maxCycles !== null && !positiveInteger(value.maxCycles)) throw new Error("maxCycles must be a positive integer or null");
  if (value.maxFixCycles !== undefined && value.maxFixCycles !== null && !nonNegativeInteger(value.maxFixCycles)) throw new Error("maxFixCycles must be a non-negative integer or null");
  if (Object.prototype.hasOwnProperty.call(value, "maxCycles") && Object.prototype.hasOwnProperty.call(value, "maxFixCycles")) throw new Error("maxCycles and maxFixCycles cannot both be configured");
  if (value.harness !== "full-dev-flow" && ((value.maxCycles !== undefined && value.maxCycles !== null) || (value.maxFixCycles !== undefined && value.maxFixCycles !== null))) throw new Error("baseline harnesses must not configure maxCycles");
  if (!isOneOf(value.sessionMode, ["fresh", "reused", "unknown"] as const)) throw new Error("unsupported sessionMode");
  if (executableBaseline && value.sessionMode !== "fresh") throw new Error("foundation executable baseline requires fresh sessionMode");
  if (value.notes !== undefined && (!Array.isArray(value.notes) || value.notes.some((note) => typeof note !== "string" || credentialLike(note)))) throw new Error("notes must be non-credential strings");
  const legacy = value.maxFixCycles;
  const normalized = {
    ...value,
    maxCycles: value.maxCycles !== undefined ? value.maxCycles : (typeof legacy === "number" ? legacy + 1 : null),
  };
  return normalized as unknown as HarborRuntimeConfig;
}

export function parseHarborRuntimeConfig(json: string, options: RuntimeValidationOptions = {}): HarborRuntimeConfig {
  let value: unknown;
  try { value = JSON.parse(json) as unknown; } catch (error) { throw new Error(`invalid Harbor runtime JSON: ${error instanceof Error ? error.message : String(error)}`); }
  return validateHarborRuntimeConfig(value, options);
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function assertKnownKeys(value: Record<string, unknown>, allowed: string[], label: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} has unknown key: ${key}`); }
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0; }
function nonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0; }
function isOneOf<const T extends string>(value: unknown, values: readonly T[]): value is T { return typeof value === "string" && values.includes(value as T); }
function credentialLike(value: string): boolean { return /(?:api[_-]?key|secret|password|bearer|credential|auth(?:entication)?|token)\s*[:=]/i.test(value); }
