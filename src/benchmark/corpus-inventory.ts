import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Offline, conservative inventory of a Terminal-Bench-style corpus.
 *
 * This module deliberately does not open `solution/` or `tests/` files.  It
 * only records their names and metadata while deriving evidence from the task
 * metadata, instruction, and environment Dockerfile.
 */

export const CORPUS_INVENTORY_SCHEMA = "terminal-bench-corpus-inventory-1" as const;
const PROTECTED_TREES = new Set(["solution", "tests", "verifier"]);
const ALLOWED_CONTENT = new Set(["task.toml", "instruction.md", "environment/Dockerfile"]);
const INVENTORY_DIGEST_RULE = "sorted relative path + TAB + entry type + TAB + mode + TAB + size + TAB + permitted content SHA-256 or empty + LF; this is inventory identity, not source integrity; solution/tests/verifier content is never read";
const SOURCE_DIGEST_NOT_COMPUTED_REASON = "protected solution/tests/verifier content intentionally unread";

export interface InventoryOptions { corpusRoot: string }

export interface CorpusInventory {
  schemaVersion: typeof CORPUS_INVENTORY_SCHEMA;
  corpusRoot: "operator-local";
  digestRule: string;
  tasks: CorpusInventoryTask[];
}

export interface CorpusInventoryTask {
  taskName: string;
  relativePath: string;
  inventoryDigest: string;
  sourceDigest: { status: "not-computed"; value: null; reason: string };
  metadata: {
    version: string | null;
    difficulty: string | null;
    category: string | null;
    tags: string[];
  };
  timeouts: { agentSeconds: number | null; verifierSeconds: number | null; buildSeconds: number | null };
  workdir: string | null;
  environment: {
    files: InventoryFile[];
    dockerfile: { present: boolean; dependencyDeclarations: DockerDependency[]; workdir: string | null };
  };
  indicators: Record<EnvironmentIndicatorName, EnvironmentIndicator>;
  publicCheckCandidates: PublicCheckCandidate[];
  compatibilityRiskFacts: string[];
  files: InventoryFile[];
}

export interface InventoryFile {
  path: string;
  type: "file" | "directory";
  sizeBytes: number | null;
  mode: number | null;
}

export type EnvironmentIndicatorName = "gpu" | "qemu" | "service" | "network" | "buildLarge";
export interface EnvironmentIndicator {
  value: boolean | null;
  rule: string;
  provenance: string[];
}

export interface DockerDependency { tool: string; provenance: string }
export interface PublicCheckCandidate {
  type: "build" | "test" | "lint" | "format" | "run" | "parse" | "unknown";
  clue: string;
  confidence: "low" | "medium";
  provenance: string[];
}

interface EntryRecord { path: string; type: "file" | "directory"; sizeBytes: number | null; mode: number | null; contentHash: string }
interface ParsedToml { values: Map<string, unknown> }

export async function runCorpusInventory(options: InventoryOptions): Promise<CorpusInventory> {
  if (!options || typeof options.corpusRoot !== "string" || options.corpusRoot.trim() === "") throw new Error("corpus root is required");
  const rootInput = resolve(options.corpusRoot);
  const rootStat = await lstat(rootInput);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("corpus root must be a real directory");
  const root = await realpath(rootInput);
  const children = await readdir(rootInput, { withFileTypes: true });
  const tasks: CorpusInventoryTask[] = [];
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    const childPath = resolve(root, child.name);
    const childStat = await lstat(childPath);
    if (childStat.isSymbolicLink()) throw new Error(`symlink is not allowed: ${child.name}`);
    if (!childStat.isDirectory()) continue;
    const taskToml = resolve(childPath, "task.toml");
    let taskTomlStat;
    try { taskTomlStat = await lstat(taskToml); } catch (error) { if (isNotFound(error)) continue; throw error; }
    if (taskTomlStat.isSymbolicLink() || !taskTomlStat.isFile()) throw new Error(`invalid task.toml: ${child.name}`);
    tasks.push(await inventoryTask(root, child.name, childPath));
  }
  if (tasks.length === 0) throw new Error("corpus root contains no task directories with task.toml");
  tasks.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { schemaVersion: CORPUS_INVENTORY_SCHEMA, corpusRoot: "operator-local", digestRule: INVENTORY_DIGEST_RULE, tasks };
}

async function inventoryTask(root: string, taskName: string, taskPath: string): Promise<CorpusInventoryTask> {
  const taskRelative = safeRelative(root, taskPath);
  const entries = await collectEntries(root, taskPath, taskRelative);
  const taskTomlText = await readPermitted(taskPath, "task.toml");
  const parsed = parseTaskToml(taskTomlText);
  let instructionText: string | null = null;
  try { instructionText = await readPermitted(taskPath, "instruction.md"); } catch (error) { if (!isNotFound(error)) throw error; }
  let dockerfileText: string | null = null;
  try { dockerfileText = await readPermitted(taskPath, "environment/Dockerfile"); } catch (error) { if (!isNotFound(error)) throw error; }
  const docker = dockerfileText === null ? { present: false, dependencyDeclarations: [], workdir: null } : parseDockerfile(dockerfileText);
  const metadata = selectedMetadata(parsed);
  const timeouts = selectedTimeouts(parsed);
  const workdir = selectedWorkdir(parsed, docker.workdir);
  const candidates = collectPublicCandidates(instructionText, dockerfileText);
  const indicators = collectIndicators(dockerfileText, entries, candidates);
  const risks = collectRisks(parsed, dockerfileText, entries, instructionText);
  const digest = digestEntries(entries);
  const environmentFiles = entries.filter((entry) => entry.path === `${taskRelative}/environment` || entry.path.startsWith(`${taskRelative}/environment/`)).map((entry) => toPublicFile(entry, relative(taskPath, resolve(root, entry.path)).split(sep).join("/")));
  const taskFiles = entries.map((entry) => toPublicFile(entry, relative(taskPath, resolve(root, entry.path)).split(sep).join("/")));
  return {
    taskName,
    relativePath: taskRelative,
    inventoryDigest: digest,
    sourceDigest: { status: "not-computed", value: null, reason: SOURCE_DIGEST_NOT_COMPUTED_REASON },
    metadata,
    timeouts,
    workdir,
    environment: { files: environmentFiles.sort(fileOrder), dockerfile: docker },
    indicators,
    publicCheckCandidates: candidates,
    compatibilityRiskFacts: risks,
    files: taskFiles.sort(fileOrder),
  };
}

function fileOrder(a: InventoryFile, b: InventoryFile): number { return a.path.localeCompare(b.path); }
function toPublicFile(entry: EntryRecord, path: string): InventoryFile { return { path, type: entry.type, sizeBytes: entry.sizeBytes, mode: entry.mode }; }

async function collectEntries(root: string, taskPath: string, taskRelative: string): Promise<EntryRecord[]> {
  const result: EntryRecord[] = [];
  async function visit(current: string, relativeDir: string): Promise<void> {
    const items = await readdir(current, { withFileTypes: true });
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.includes("\0") || item.name === "." || item.name === "..") throw new Error(`unsafe entry name: ${item.name}`);
      const absolute = resolve(current, item.name);
      const rel = `${relativeDir}/${item.name}`;
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed: ${rel}`);
      if (stat.isDirectory()) {
        result.push({ path: rel, type: "directory", sizeBytes: null, mode: stat.mode & 0o7777, contentHash: "" });
        const base = item.name;
        if (!PROTECTED_TREES.has(base) && !relativeDir.endsWith("/solution") && !relativeDir.endsWith("/tests") && !relativeDir.endsWith("/verifier")) await visit(absolute, rel);
      } else if (stat.isFile()) {
        let contentHash = "";
        const fromTask = rel.slice(taskRelative.length + 1);
        if (ALLOWED_CONTENT.has(fromTask)) contentHash = sha256(await readFile(absolute));
        result.push({ path: rel, type: "file", sizeBytes: stat.size, mode: stat.mode & 0o7777, contentHash });
      } else throw new Error(`unsupported filesystem entry: ${rel}`);
    }
  }
  await visit(taskPath, taskRelative);
  assertWithin(root, resolve(root, taskRelative));
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function readPermitted(taskPath: string, relativePath: string): Promise<string> {
  const absolute = resolve(taskPath, relativePath);
  const rel = relative(taskPath, absolute);
  if (isAbsolute(rel) || rel.split(sep).includes("..")) throw new Error(`path escapes task: ${relativePath}`);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`permitted file is not a regular file: ${relativePath}`);
  return readFile(absolute, "utf8");
}

function digestEntries(entries: EntryRecord[]): string {
  const canonical = entries.slice().sort((a, b) => a.path.localeCompare(b.path)).map((entry) => `${entry.path}\t${entry.type}\t${entry.mode ?? ""}\t${entry.sizeBytes ?? ""}\t${entry.contentHash}\n`).join("");
  return sha256(canonical);
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function parseTaskToml(text: string): ParsedToml {
  const values = new Map<string, unknown>();
  let section = "";
  for (const [index, original] of text.split(/\r?\n/).entries()) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (sectionMatch) { section = sectionMatch[1]!; continue; }
    const match = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!match) throw new Error(`malformed task.toml line ${index + 1}`);
    const key = section ? `${section}.${match[1]}` : match[1]!;
    if (values.has(key)) throw new Error(`duplicate task.toml key: ${key}`);
    values.set(key, parseTomlValue(match[2]!, index + 1));
  }
  return { values };
}

function parseTomlValue(raw: string, line: number): unknown {
  const value = raw.replace(/\s+#.*$/, "").trim();
  if (value === "true" || value === "false") return value === "true";
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { throw new Error(`malformed string in task.toml line ${line}`); }
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const body = value.slice(1, -1).trim(); if (!body) return [];
    return splitArray(body).filter((part) => part.trim() !== "").map((part) => parseTomlValue(part.trim(), line));
  }
  throw new Error(`unsupported task.toml value on line ${line}`);
}

function splitArray(value: string): string[] {
  const result: string[] = []; let start = 0; let quote = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"' && value[index - 1] !== "\\") quote = !quote;
    if (value[index] === "," && !quote) { result.push(value.slice(start, index)); start = index + 1; }
  }
  if (quote) throw new Error("unterminated task.toml string");
  result.push(value.slice(start)); return result;
}

function selectedMetadata(parsed: ParsedToml): CorpusInventoryTask["metadata"] {
  const stringValue = (key: string): string | null => { const value = parsed.values.get(`metadata.${key}`); return value === undefined ? null : typeof value === "string" ? value : invalidMetadata(key); };
  const tagsValue = parsed.values.get("metadata.tags");
  if (tagsValue !== undefined && (!Array.isArray(tagsValue) || tagsValue.some((tag) => typeof tag !== "string"))) throw new Error("metadata.tags must be a string array");
  const versionValue = parsed.values.get("version");
  if (versionValue !== undefined && typeof versionValue !== "string") throw new Error("version must be a string");
  return { version: (versionValue as string | undefined) ?? null, difficulty: stringValue("difficulty"), category: stringValue("category"), tags: ((tagsValue as string[] | undefined) ?? []).slice().sort() };
}

function invalidMetadata(key: string): never { throw new Error(`metadata.${key} must be a string`); }

function selectedTimeouts(parsed: ParsedToml): CorpusInventoryTask["timeouts"] {
  const numberValue = (key: string): number | null => { const value = parsed.values.get(key); if (value === undefined) return null; if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number`); return value; };
  return { agentSeconds: numberValue("agent.timeout_sec"), verifierSeconds: numberValue("verifier.timeout_sec"), buildSeconds: numberValue("environment.build_timeout_sec") };
}

function selectedWorkdir(parsed: ParsedToml, dockerWorkdir: string | null): string | null {
  const value = parsed.values.get("environment.workdir");
  if (value !== undefined && (typeof value !== "string" || !value.startsWith("/") || value.includes(".."))) throw new Error("environment.workdir must be an absolute non-escaping path");
  return (value as string | undefined) ?? dockerWorkdir;
}

function parseDockerfile(text: string): { present: true; dependencyDeclarations: DockerDependency[]; workdir: string | null } {
  const dependencies: DockerDependency[] = []; let workdir: string | null = null;
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim(); const provenance = `environment/Dockerfile#L${index + 1}`;
    const workdirMatch = /^WORKDIR\s+([^\s#]+)\s*$/i.exec(line); if (workdirMatch) workdir = sanitizeContainerPath(workdirMatch[1]!);
    if (/^FROM\s+[^\s#]+/i.test(line)) dependencies.push({ tool: "docker-base-image", provenance });
    for (const tool of ["apt-get", "apk", "pip", "pip3", "npm", "yarn", "pnpm", "cargo", "gem", "conda", "go install"]) if (new RegExp(`\\b${escapeRegExp(tool)}\\b`, "i").test(line)) dependencies.push({ tool, provenance });
  }
  return { present: true, dependencyDeclarations: dedupeDependencies(dependencies), workdir };
}

function sanitizeContainerPath(value: string): string | null { return value.startsWith("/") && !value.split("/").includes("..") ? value : null; }
function dedupeDependencies(values: DockerDependency[]): DockerDependency[] { return values.filter((item, index, all) => all.findIndex((other) => other.tool === item.tool && other.provenance === item.provenance) === index).sort((a, b) => `${a.tool}${a.provenance}`.localeCompare(`${b.tool}${b.provenance}`)); }

function collectPublicCandidates(instruction: string | null, dockerfile: string | null): PublicCheckCandidate[] {
  const result: PublicCheckCandidate[] = []; const add = (type: PublicCheckCandidate["type"], clue: string, confidence: "low" | "medium", provenance: string): void => { if (!result.some((item) => item.type === type && item.clue === clue && item.provenance.includes(provenance))) result.push({ type, clue, confidence, provenance: [provenance] }); };
  if (instruction !== null) {
    for (const [index, line] of instruction.split(/\r?\n/).entries()) {
      const ref = `instruction.md#L${index + 1}`;
      for (const match of line.matchAll(/`([^`]+)`/g)) { const clue = match[1]!.trim().split(/\s+/)[0]!; if (/^[A-Za-z][A-Za-z0-9_.+-]*$/.test(clue)) add(classifyClue(clue), clue, "medium", ref); }
      for (const clue of ["pytest", "npm", "cargo", "go", "gcc", "coqc", "pdflatex", "vim", "sqlite3", "python3", "git"]) if (new RegExp(`\\b${escapeRegExp(clue)}\\b`, "i").test(line)) add(classifyClue(clue), clue, "low", ref);
    }
  }
  if (dockerfile !== null) for (const [index, line] of dockerfile.split(/\r?\n/).entries()) for (const clue of ["make", "cmake", "gcc", "g++", "cargo", "npm", "pytest", "pdflatex", "coqc"]) if (new RegExp(`\\b${escapeRegExp(clue)}\\b`, "i").test(line)) add(classifyClue(clue), clue, "low", `environment/Dockerfile#L${index + 1}`);
  return result.sort((a, b) => `${a.type}\0${a.clue}\0${a.provenance[0]}`.localeCompare(`${b.type}\0${b.clue}\0${b.provenance[0]}`));
}

function classifyClue(clue: string): PublicCheckCandidate["type"] { if (/test|pytest|npm/i.test(clue)) return "test"; if (/lint/i.test(clue)) return "lint"; if (/format/i.test(clue)) return "format"; if (/parse|json|sqlite/i.test(clue)) return "parse"; if (/build|make|cmake|gcc|g\+\+|cargo|coqc|pdflatex/i.test(clue)) return "build"; return "run"; }

function collectIndicators(dockerfile: string | null, entries: EntryRecord[], candidates: PublicCheckCandidate[]): Record<EnvironmentIndicatorName, EnvironmentIndicator> {
  const text = dockerfile ?? ""; const refs = (patterns: RegExp[]): string[] => text.split(/\r?\n/).flatMap((line, index) => patterns.some((pattern) => pattern.test(line)) ? [`environment/Dockerfile#L${index + 1}`] : []);
  const make = (value: boolean | null, rule: string, provenance: string[]): EnvironmentIndicator => ({ value, rule, provenance: provenance.sort() });
  const gpu = refs([/cuda|nvidia|rocm|gpu/i]); const qemu = refs([/qemu|binfmt/i]); const service = refs([/^EXPOSE\b/i, /systemctl|service\s|uvicorn|gunicorn|node\s+server/i]); const network = refs([/apt-get|apk|pip3?|npm|yarn|pnpm|cargo|curl|wget|git\s+clone/i]); const buildLarge = refs([/make|cmake|cargo\s+build|go\s+build|gcc|g\+\+|nvcc/i]);
  const fileRefs = entries.filter((entry) => entry.type === "file" && /\.so$|\.a$|\.whl$/.test(entry.path)).map((entry) => entry.path);
  if (fileRefs.length) buildLarge.push(...fileRefs);
  return {
    gpu: make(gpu.length ? true : null, "true only when Dockerfile contains an explicit GPU runtime/tool clue; absence remains unknown", gpu),
    qemu: make(qemu.length ? true : null, "true only when Dockerfile contains an explicit QEMU/binfmt clue; absence remains unknown", qemu),
    service: make(service.length ? true : null, "true only when Dockerfile contains an explicit service/port clue; absence remains unknown", service),
    network: make(network.length ? true : null, "true only when Dockerfile contains a dependency download or network command clue; absence remains unknown", network),
    buildLarge: make(buildLarge.length ? true : null, "true only when Dockerfile or file metadata contains an explicit build/compiled-artifact clue; absence remains unknown", buildLarge),
  };
}

function collectRisks(parsed: ParsedToml, dockerfile: string | null, entries: EntryRecord[], instruction: string | null): string[] {
  const risks: string[] = []; if (dockerfile === null) risks.push("environment Dockerfile not observed"); if (instruction === null) risks.push("instruction.md not observed"); if (parsed.values.get("environment.cpus") !== undefined || parsed.values.get("environment.memory") !== undefined) risks.push("resource limits are declared in task metadata"); if (entries.some((entry) => entry.path.endsWith("/solution") || entry.path.includes("/solution/"))) risks.push("solution tree present; content intentionally not read"); if (entries.some((entry) => entry.path.endsWith("/tests") || entry.path.includes("/tests/"))) risks.push("tests tree present; content intentionally not read"); return risks.sort();
}

function safeRelative(root: string, target: string): string { const value = relative(root, target).split(sep).join("/"); if (!value || value.startsWith("../") || value === ".." || isAbsolute(value)) throw new Error("path escapes corpus root"); return value; }
function assertWithin(root: string, target: string): void { const rel = relative(root, target); if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("path escapes corpus root"); }
function isNotFound(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT"); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function parseCorpusInventoryArgs(argv: readonly string[]): string {
  if (argv.length !== 1 || argv[0] === "--help" || argv[0]!.startsWith("-")) throw new Error("usage: harbor-corpus-inventory /absolute/path/to/corpus-root");
  return argv[0]!;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const corpusRoot = parseCorpusInventoryArgs(argv);
  const inventory = await runCorpusInventory({ corpusRoot });
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
