import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { ArtifactLoadOptions, FailureCategory } from "./aggregate.js";

export const BENCHMARK_RUN_MANIFEST_SCHEMA = "benchmark-run-manifest-1" as const;

const FAILURE_CATEGORIES = [
  "configuration-invalid",
  "infrastructure-invalid",
  "model-failure",
  "verifier-failure",
  "task-failure",
  "unknown",
] as const satisfies readonly FailureCategory[];

export interface BenchmarkRunManifestEntry {
  path: string;
  includeInComparison: boolean;
  failureCategory: FailureCategory | null;
  invalidReason: string | null;
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
}

export interface BenchmarkRunManifest {
  schemaVersion: typeof BENCHMARK_RUN_MANIFEST_SCHEMA;
  /** A relative directory is resolved from the manifest. An env reference is operator-local. */
  artifactRoot?: string | { env: string };
  artifacts: BenchmarkRunManifestEntry[];
}

export interface LoadedBenchmarkRunManifest {
  manifestPath: string;
  manifest: BenchmarkRunManifest;
  artifactPaths: string[];
  overrides: Record<string, ArtifactLoadOptions>;
}

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "artifactRoot", "artifacts"]);
const ENTRY_KEYS = new Set(["path", "includeInComparison", "failureCategory", "invalidReason", "estimatedCostUsd", "actualCostUsd"]);

/**
 * Read and strictly validate an operator-authored manifest. This function only
 * reads the manifest and resolves artifact paths; it never reads an artifact,
 * auth file, environment secret, or serializes the parsed input.
 */
export async function readBenchmarkRunManifest(path: string): Promise<LoadedBenchmarkRunManifest> {
  const manifestPath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`cannot read benchmark manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = validateManifest(parsed, manifestPath);
  const manifestDir = resolve(manifestPath, "..");
  const artifactRoot = resolveArtifactRoot(manifest.artifactRoot, manifestDir);
  const artifactPaths: string[] = [];
  const overrides: Record<string, ArtifactLoadOptions> = {};
  const seen = new Set<string>();
  for (const [index, entry] of manifest.artifacts.entries()) {
    const artifactPath = resolve(artifactRoot, entry.path);
    const outsideRoot = relative(artifactRoot, artifactPath).startsWith("..") || isAbsolute(relative(artifactRoot, artifactPath));
    if (outsideRoot) throw new Error(`manifest artifacts[${index}].path escapes artifactRoot`);
    if (seen.has(artifactPath)) throw new Error(`manifest contains duplicate artifact path: ${entry.path}`);
    seen.add(artifactPath);
    artifactPaths.push(artifactPath);
    overrides[artifactPath] = {
      includeInComparison: entry.includeInComparison,
      failureCategory: entry.failureCategory ?? undefined,
      invalidReason: entry.invalidReason ?? undefined,
      estimatedCostUsd: entry.estimatedCostUsd,
      actualCostUsd: entry.actualCostUsd,
    };
  }
  return { manifestPath, manifest, artifactPaths, overrides };
}

function validateManifest(value: unknown, manifestPath: string): BenchmarkRunManifest {
  const root = object(value, "manifest root");
  rejectUnknown(root, TOP_LEVEL_KEYS, "manifest");
  exactString(root.schemaVersion, BENCHMARK_RUN_MANIFEST_SCHEMA, "schemaVersion");
  if (!Array.isArray(root.artifacts) || root.artifacts.length === 0) throw new Error("manifest.artifacts must be a non-empty array");
  const artifactRoot = root.artifactRoot === undefined ? undefined : validateArtifactRoot(root.artifactRoot);
  const artifacts = root.artifacts.map((entry, index) => validateEntry(entry, index));
  // Validate the path shape before any path resolution, including env roots.
  for (const [index, entry] of artifacts.entries()) {
    if (isAbsolute(entry.path)) throw new Error(`manifest artifacts[${index}].path must be relative`);
    if (entry.path === "." || entry.path === ".." || entry.path.trim() === "") throw new Error(`manifest artifacts[${index}].path must name an artifact directory`);
  }
  void manifestPath;
  return { schemaVersion: BENCHMARK_RUN_MANIFEST_SCHEMA, ...(artifactRoot === undefined ? {} : { artifactRoot }), artifacts };
}

function validateArtifactRoot(value: unknown): string | { env: string } {
  if (typeof value === "string") {
    if (!value.trim() || isAbsolute(value)) throw new Error("manifest.artifactRoot must be a non-empty relative path");
    return value;
  }
  const root = object(value, "manifest.artifactRoot");
  rejectUnknown(root, new Set(["env"]), "manifest.artifactRoot");
  if (typeof root.env !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(root.env)) throw new Error("manifest.artifactRoot.env must be an uppercase environment variable name");
  return { env: root.env };
}

function validateEntry(value: unknown, index: number): BenchmarkRunManifestEntry {
  const entry = object(value, `manifest artifacts[${index}]`);
  rejectUnknown(entry, ENTRY_KEYS, `manifest artifacts[${index}]`);
  for (const key of ["path", "includeInComparison", "failureCategory", "invalidReason", "estimatedCostUsd", "actualCostUsd"] as const) {
    if (!(key in entry)) throw new Error(`manifest artifacts[${index}] missing required field ${key}`);
  }
  if (typeof entry.path !== "string" || entry.path.trim() !== entry.path || entry.path.length === 0) throw new Error(`manifest artifacts[${index}].path must be a non-empty string`);
  if (typeof entry.includeInComparison !== "boolean") throw new Error(`manifest artifacts[${index}].includeInComparison must be boolean`);
  const failureCategory = entry.failureCategory === null ? null : validFailureCategory(entry.failureCategory, index);
  const invalidReason = entry.invalidReason === null ? null : validReason(entry.invalidReason, index);
  if (entry.includeInComparison && (failureCategory !== null || invalidReason !== null)) throw new Error(`manifest artifacts[${index}] included artifacts cannot have failureCategory or invalidReason`);
  if (!entry.includeInComparison && (failureCategory === null || invalidReason === null)) throw new Error(`manifest artifacts[${index}] excluded artifacts require failureCategory and invalidReason`);
  return {
    path: entry.path,
    includeInComparison: entry.includeInComparison,
    failureCategory,
    invalidReason,
    estimatedCostUsd: nullableCost(entry.estimatedCostUsd, index, "estimatedCostUsd"),
    actualCostUsd: nullableCost(entry.actualCostUsd, index, "actualCostUsd"),
  };
}

function validFailureCategory(value: unknown, index: number): FailureCategory {
  if (typeof value !== "string" || !(FAILURE_CATEGORIES as readonly string[]).includes(value)) throw new Error(`manifest artifacts[${index}].failureCategory is unknown`);
  return value as FailureCategory;
}
function validReason(value: unknown, index: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`manifest artifacts[${index}].invalidReason must be null or a non-empty string`);
  return value;
}
function nullableCost(value: unknown, index: number, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`manifest artifacts[${index}].${field} must be a non-negative number or null`);
  return value;
}
function resolveArtifactRoot(root: BenchmarkRunManifest["artifactRoot"], manifestDir: string): string {
  if (root === undefined) return manifestDir;
  if (typeof root === "string") return resolve(manifestDir, root);
  const value = process.env[root.env];
  if (!value) throw new Error(`environment variable ${root.env} is required by benchmark manifest`);
  if (!isAbsolute(value)) return resolve(manifestDir, value);
  return resolve(value);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown field ${unknown[0]}`);
}
function exactString(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw new Error(`${label} must be ${expected}`);
}
