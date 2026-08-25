import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { CorpusInventory, CorpusInventoryTask, EnvironmentIndicatorName } from "./corpus-inventory.js";

export const CORPUS_TRIAGE_SCHEMA = "terminal-bench-corpus-phase1-triage-1" as const;
export const TRIAGE_RULE_VERSION = "phase1-conservative-harness-compatibility-1" as const;
export const HARNESSES = ["codex", "single-pi", "full-dev-flow"] as const;
export type TriageHarness = (typeof HARNESSES)[number];
export type TriageClassification = "direct-compatible" | "derivative-required" | "blocked-readonly" | "unknown";

export const PREVIOUS_TASKS = [
  "prove-plus-comm",
  "overfull-hbox",
  "regex-log",
  "log-summary-date-ranges",
  "polyglot-c-py",
  "large-scale-text-editing",
  "sqlite-db-truncate",
] as const;

export interface CorpusTriageOptions { inventoryPath: string }

export interface CorpusTriage {
  schemaVersion: typeof CORPUS_TRIAGE_SCHEMA;
  ruleVersion: typeof TRIAGE_RULE_VERSION;
  inventorySchemaVersion: string;
  inventoryDigest: string;
  sourceIntegrity: { status: "not-computed"; reason: string };
  harnesses: readonly TriageHarness[];
  excludedPreviouslyRunTasks: readonly string[];
  summary: {
    taskCount: number;
    entries: number;
    byClassification: Record<TriageClassification, number>;
    byHarness: Record<TriageHarness, Record<TriageClassification, number>>;
    riskStrata: Record<string, number>;
  };
  batch0Candidates: string[];
  tasks: CorpusTriageEntry[];
}

export interface CorpusTriageEntry {
  taskName: string;
  relativePath: string;
  inventoryDigest: string;
  harness: TriageHarness;
  classification: TriageClassification;
  reasons: string[];
  risks: string[];
  provenance: string[];
  metadata: { category: string | null; difficulty: string | null };
  workdirKnown: boolean;
  dockerfileObserved: boolean;
  publicCheckTypes: string[];
  adaptationPlan: "none" | "workspace-compatible-derivative" | "not-authorized";
}

const SOURCE_REASON = "protected solution/tests/verifier content intentionally unread; triage is not source integrity";
const REQUIRED_METADATA_REASON = "missing required inventory metadata for compatibility decision";

export async function runCorpusTriage(options: CorpusTriageOptions): Promise<CorpusTriage> {
  if (!options || typeof options.inventoryPath !== "string" || options.inventoryPath.trim() === "") throw new Error("inventory path is required");
  const raw = await readFile(options.inventoryPath, "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("inventory JSON is malformed"); }
  const inventory = validateInventory(parsed);
  const inventoryDigest = digestInventory(inventory);
  const tasks = inventory.tasks.flatMap((task) => HARNESSES.map((harness) => classifyEntry(task, harness))).sort((a, b) => a.relativePath.localeCompare(b.relativePath) || HARNESSES.indexOf(a.harness) - HARNESSES.indexOf(b.harness));
  const batch0Candidates = selectBatch0(tasks);
  const byClassification = emptyClassificationCounts();
  const byHarness = Object.fromEntries(HARNESSES.map((harness) => [harness, emptyClassificationCounts()])) as CorpusTriage["summary"]["byHarness"];
  const riskStrata: Record<string, number> = {};
  for (const entry of tasks) {
    byClassification[entry.classification] += 1;
    byHarness[entry.harness][entry.classification] += 1;
    for (const risk of entry.risks) riskStrata[risk] = (riskStrata[risk] ?? 0) + 1;
  }
  return {
    schemaVersion: CORPUS_TRIAGE_SCHEMA,
    ruleVersion: TRIAGE_RULE_VERSION,
    inventorySchemaVersion: inventory.schemaVersion,
    inventoryDigest,
    sourceIntegrity: { status: "not-computed", reason: SOURCE_REASON },
    harnesses: HARNESSES,
    excludedPreviouslyRunTasks: PREVIOUS_TASKS,
    summary: { taskCount: inventory.tasks.length, entries: tasks.length, byClassification, byHarness, riskStrata },
    batch0Candidates,
    tasks,
  };
}

export function validateInventory(value: unknown): CorpusInventory {
  if (!value || typeof value !== "object") throw new Error("inventory must be an object");
  const inventory = value as Partial<CorpusInventory>;
  if (inventory.schemaVersion !== "terminal-bench-corpus-inventory-1") throw new Error("unsupported inventory schema");
  if (inventory.corpusRoot !== "operator-local") throw new Error("inventory corpusRoot must be operator-local");
  if (typeof inventory.digestRule !== "string" || !inventory.digestRule.includes("inventory identity")) throw new Error("inventory digest rule is missing or not an inventory identity rule");
  if (!Array.isArray(inventory.tasks) || inventory.tasks.length === 0) throw new Error("inventory tasks are required");
  const paths = new Set<string>();
  for (const task of inventory.tasks) { validateTask(task); if (paths.has(task.relativePath)) throw new Error(`duplicate inventory task path: ${task.relativePath}`); paths.add(task.relativePath); }
  return inventory as CorpusInventory;
}

function validateTask(value: unknown): asserts value is CorpusInventoryTask {
  if (!value || typeof value !== "object") throw new Error("inventory task is malformed");
  const task = value as Partial<CorpusInventoryTask>;
  if (typeof task.taskName !== "string" || !task.taskName || task.taskName.includes("/") || task.taskName.includes("\\") || task.taskName === "." || task.taskName === ".." || typeof task.relativePath !== "string" || !task.relativePath || task.relativePath.startsWith("/") || task.relativePath.split(/[\\/]/).includes("..")) throw new Error("inventory task path is malformed");
  if (typeof task.inventoryDigest !== "string" || !/^[a-f0-9]{64}$/.test(task.inventoryDigest)) throw new Error(`inventoryDigest missing for ${task.taskName}`);
  if (!task.sourceDigest || task.sourceDigest.status !== "not-computed" || task.sourceDigest.value !== null || typeof task.sourceDigest.reason !== "string") throw new Error(`sourceDigest must be not-computed for ${task.taskName}`);
  if (!task.metadata || !task.timeouts || !task.environment || !task.indicators || !task.files || !Array.isArray(task.publicCheckCandidates)) throw new Error(`inventory facts missing for ${task.taskName}`);
  if (typeof task.environment.dockerfile?.present !== "boolean") throw new Error(`Dockerfile fact missing for ${task.taskName}`);
  for (const name of ["gpu", "qemu", "service", "network", "buildLarge"] as const) if (!task.indicators[name] || ![true, false, null].includes(task.indicators[name].value)) throw new Error(`indicator ${name} missing for ${task.taskName}`);
}

export function classifyEntry(task: CorpusInventoryTask, harness: TriageHarness): CorpusTriageEntry {
  const reasons: string[] = [];
  const risks: string[] = [];
  const provenance: string[] = [`task:${task.relativePath}#inventoryDigest`, "rule:phase1-conservative-harness-compatibility-1"];
  const publicCheckTypes = [...new Set(task.publicCheckCandidates.map((candidate) => candidate.type))].sort();
  const addBlocked = (reason: string, refs: string[]): void => { reasons.push(reason); provenance.push(...refs); };
  const indicator = (name: EnvironmentIndicatorName): boolean => task.indicators[name].value === true;
  if (indicator("gpu")) addBlocked("gpu", task.indicators.gpu.provenance);
  if (indicator("qemu")) addBlocked("qemu/vm", task.indicators.qemu.provenance);
  if (indicator("service")) addBlocked("service/port", task.indicators.service.provenance);
  if (indicator("buildLarge")) addBlocked("large build/resource", task.indicators.buildLarge.provenance);
  if (task.compatibilityRiskFacts.some((fact) => fact === "resource limits are declared in task metadata")) { risks.push("resource limits declared"); provenance.push("task:compatibilityRiskFacts"); }
  const missing: string[] = [];
  if (!task.workdir) missing.push("workdir");
  if (!task.environment.dockerfile.present) missing.push("Dockerfile");
  if (task.timeouts.agentSeconds === null || task.timeouts.verifierSeconds === null) missing.push("timeout metadata");
  if (missing.length > 0) addBlocked(`missing ${missing.join(", ")}/metadata`, ["task:inventory-facts"]);
  if (task.indicators.network.value === true) { risks.push("network dependency clue"); provenance.push(...task.indicators.network.provenance); }
  if (publicCheckTypes.length === 0) risks.push("no public check candidate observed");
  if (task.metadata.category === null || task.metadata.difficulty === null) risks.push(REQUIRED_METADATA_REASON);
  let classification: TriageClassification;
  let adaptationPlan: CorpusTriageEntry["adaptationPlan"] = "none";
  if (!HARNESSES.includes(harness as TriageHarness)) { classification = "unknown"; adaptationPlan = "not-authorized"; reasons.push("unsupported harness remains unknown"); provenance.push("rule:unknown-on-unsupported-input"); }
  else if (reasons.length > 0) classification = "blocked-readonly";
  else if (harness === "full-dev-flow") { classification = "derivative-required"; adaptationPlan = "workspace-compatible-derivative"; reasons.push("Full dev-flow requires a clean Git baseline; no derivative is created during triage"); provenance.push("rule:full-dev-flow-clean-git-baseline"); }
  else if (task.workdir && task.environment.dockerfile.present && task.timeouts.agentSeconds !== null && task.timeouts.verifierSeconds !== null) { classification = "direct-compatible"; reasons.push("workdir, Dockerfile, and agent/verifier timeouts are observed"); }
  else { classification = "unknown"; adaptationPlan = "not-authorized"; reasons.push("compatibility facts are insufficient for a conservative decision"); }
  return {
    taskName: task.taskName,
    relativePath: task.relativePath,
    inventoryDigest: task.inventoryDigest,
    harness,
    classification,
    reasons: [...new Set(reasons)].sort(),
    risks: [...new Set(risks)].sort(),
    provenance: [...new Set(provenance)].sort(),
    metadata: { category: task.metadata.category, difficulty: task.metadata.difficulty },
    workdirKnown: Boolean(task.workdir),
    dockerfileObserved: task.environment.dockerfile.present,
    publicCheckTypes,
    adaptationPlan,
  };
}

function selectBatch0(entries: CorpusTriageEntry[]): string[] {
  const eligible = entries.filter((entry) => entry.harness === "full-dev-flow" && entry.classification === "derivative-required" && !PREVIOUS_TASKS.includes(entry.taskName as typeof PREVIOUS_TASKS[number]) && entry.workdirKnown && entry.dockerfileObserved && entry.publicCheckTypes.length > 0 && entry.risks.every((risk) => risk !== "no public check candidate observed" && risk !== REQUIRED_METADATA_REASON));
  const unique = [...new Map(eligible.map((entry) => [entry.taskName, entry])).values()];
  unique.sort((a, b) => `${a.metadata.category ?? "~"}\0${a.metadata.difficulty ?? "~"}\0${a.taskName}`.localeCompare(`${b.metadata.category ?? "~"}\0${b.metadata.difficulty ?? "~"}\0${b.taskName}`));
  const selected: CorpusTriageEntry[] = [];
  const categories = new Set<string>();
  for (const entry of unique) if (selected.length < 8 && !categories.has(entry.metadata.category ?? "~")) { selected.push(entry); categories.add(entry.metadata.category ?? "~"); }
  for (const entry of unique) if (selected.length < 5 && !selected.some((item) => item.taskName === entry.taskName)) selected.push(entry);
  return selected.map((entry) => entry.taskName).sort();
}

function emptyClassificationCounts(): Record<TriageClassification, number> { return { "direct-compatible": 0, "derivative-required": 0, "blocked-readonly": 0, unknown: 0 }; }

function digestInventory(inventory: CorpusInventory): string {
  const identity = inventory.tasks.slice().sort((a, b) => a.relativePath.localeCompare(b.relativePath)).map((task) => ({ relativePath: task.relativePath, inventoryDigest: task.inventoryDigest })).map((item) => JSON.stringify(item)).join("\n") + "\n";
  return createHash("sha256").update(identity).digest("hex");
}

export function parseCorpusTriageArgs(argv: readonly string[]): string {
  if (argv.length !== 1 || argv[0] === "--help" || argv[0]!.startsWith("-")) throw new Error("usage: harbor-corpus-triage /absolute/path/to/inventory.json");
  return argv[0]!;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const inventoryPath = parseCorpusTriageArgs(argv);
  const triage = await runCorpusTriage({ inventoryPath });
  process.stdout.write(`${JSON.stringify(triage, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
