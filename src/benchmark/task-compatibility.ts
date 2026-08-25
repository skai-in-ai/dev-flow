import type { VerifierMode } from "./harbor-runtime.js";

export type WorkspaceKind = "git-repo" | "directory" | "unknown";
export type TriState = boolean | "unknown";

export interface TaskCompatibilityMetadata {
  schemaVersion: "task-compatibility-1";
  taskId: string;
  datasetRevision: string;
  taskDigest: string;
  workspaceKind: WorkspaceKind;
  requiresGitRepo: TriState;
  requiresCleanTree: TriState;
  agentWorkdir: string | null;
  testsVisibleToAgent: TriState;
  verifierMode: VerifierMode;
  internetAllowed: boolean | null;
  fullDevFlowCompatible: TriState;
  incompatibilityReasons: string[];
  /** Locked handoff boundaries; required by the real Python wrapper. */
  scopeInclude?: string[];
  scopeExclude?: string[];
  acceptanceCriteria?: string[];
  riskNotes?: string[];
}

export function validateTaskCompatibilityMetadata(value: unknown): TaskCompatibilityMetadata {
  if (!isRecord(value)) throw new Error("task compatibility metadata must be an object");
  if (value.schemaVersion !== "task-compatibility-1") throw new Error("unsupported task compatibility schemaVersion");
  for (const key of ["taskId", "datasetRevision", "taskDigest"]) if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`${key} must be non-empty`);
  if (!isOneOf(value.workspaceKind, ["git-repo", "directory", "unknown"] as const)) throw new Error("unsupported workspaceKind");
  if (!isTriState(value.requiresGitRepo) || !isTriState(value.requiresCleanTree) || !isTriState(value.testsVisibleToAgent) || !isTriState(value.fullDevFlowCompatible)) throw new Error("compatibility booleans must be boolean or unknown");
  if (value.agentWorkdir !== null && typeof value.agentWorkdir !== "string") throw new Error("agentWorkdir must be a string or null");
  if (!isOneOf(value.verifierMode, ["shared", "separate", "unknown"] as const)) throw new Error("unsupported verifierMode");
  if (value.internetAllowed !== null && typeof value.internetAllowed !== "boolean") throw new Error("internetAllowed must be boolean or null");
  if (!Array.isArray(value.incompatibilityReasons) || value.incompatibilityReasons.some((reason) => typeof reason !== "string" || !reason.trim())) throw new Error("incompatibilityReasons must contain non-empty strings");
  if (value.fullDevFlowCompatible === false && value.incompatibilityReasons.length === 0) throw new Error("incompatibilityReasons is required when fullDevFlowCompatible is false");
  validateStringListIfPresent(value.scopeInclude, "scopeInclude", true, true);
  validateStringListIfPresent(value.scopeExclude, "scopeExclude", false, true);
  validateStringListIfPresent(value.acceptanceCriteria, "acceptanceCriteria", true, false);
  validateStringListIfPresent(value.riskNotes, "riskNotes", false, false);
  return value as unknown as TaskCompatibilityMetadata;
}

/**
 * Evidence is intentionally explicit. This helper does not infer hidden tests
 * or Git requirements from a task name; absent evidence stays `unknown`.
 */
export function createTaskCompatibilityMetadata(input: Omit<TaskCompatibilityMetadata, "schemaVersion">): TaskCompatibilityMetadata {
  return validateTaskCompatibilityMetadata({ schemaVersion: "task-compatibility-1", ...input });
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isTriState(value: unknown): value is TriState { return value === true || value === false || value === "unknown"; }
function isOneOf<const T extends string>(value: unknown, values: readonly T[]): value is T { return typeof value === "string" && values.includes(value as T); }
function validateStringListIfPresent(value: unknown, field: string, nonEmpty: boolean, relativePaths: boolean): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || (nonEmpty && value.length === 0) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${field} must contain ${nonEmpty ? "non-empty " : ""}strings`);
  if (relativePaths && value.some((item) => {
    const path = item as string;
    return path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || path.includes("\0");
  })) throw new Error(`${field} must contain safe relative paths`);
}
