import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

export type PublicCheckMode = "observe" | "blocking";
export type DiagnosticPatternKind = "literal" | "regex";

export interface PublicDiagnosticPattern {
  id: string;
  kind: DiagnosticPatternKind;
  pattern: string;
}

export interface PublicCheck {
  id: string;
  command: string[];
  cwd: string;
  timeoutSeconds: number;
  expectedExitCodes: number[];
  required: boolean;
  mode: PublicCheckMode;
  stdoutMaxBytes: number;
  stderrMaxBytes: number;
  diagnostics?: PublicDiagnosticPattern[];
}

export interface PublicEvidenceCheck {
  id: string;
  required: boolean;
  mode: PublicCheckMode;
  status: "passed" | "failed" | "timed_out";
  failureKind: "none" | "task-outcome" | "execution";
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  truncated: { stdout: boolean; stderr: boolean };
  diagnostics: { id: string; kind: DiagnosticPatternKind; matchCount: number }[];
  output: { stdoutExcerpt: string; stderrExcerpt: string };
  evidenceRef: string;
}

export interface PublicEvidenceArtifact {
  schemaVersion: "build-evidence-1";
  phase: "baseline" | "cycle";
  cycle: number | null;
  checks: PublicEvidenceCheck[];
  summary: { passed: number; failed: number; timedOut: number; blockingFailures: number; blockingOutcomeFailures: number; infrastructureFailures: number; observedFailures: number };
}

export interface PublicEvidenceExecutor {
  run(repo: string, checks: readonly PublicCheck[], phase: "baseline" | "cycle", cycle: number | null): Promise<PublicEvidenceArtifact>;
}

const MAX_CHECKS = 32;
const MAX_ID_LENGTH = 96;
const MAX_PATTERN_LENGTH = 200;
const MAX_OUTPUT_BYTES = 1_000_000;
const ABSOLUTE_PATH = /\/(?:Users|home|private|tmp|var\/folders)\/[^\s"'`]+/g;
const SECRET_VALUE = /((?:api[_ -]?key|access[_ -]?token|auth(?:entication)?|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi;

export function validatePublicChecks(value: unknown): PublicCheck[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CHECKS) throw new Error(`publicChecks must be an array with at most ${MAX_CHECKS} entries`);
  const ids = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`publicChecks[${index}] must be an object`);
    const check = raw as Record<string, unknown>;
    const allowed = new Set(["id", "command", "cwd", "timeoutSeconds", "expectedExitCodes", "required", "mode", "stdoutMaxBytes", "stderrMaxBytes", "diagnostics"]);
    const unknown = Object.keys(check).find((key) => !allowed.has(key));
    if (unknown) throw new Error(`publicChecks[${index}] contains unknown field ${unknown}`);
    const id = stringField(check.id, `publicChecks[${index}].id`, 1, MAX_ID_LENGTH);
    if (ids.has(id)) throw new Error(`publicChecks contains duplicate id: ${id}`);
    ids.add(id);
    if (!Array.isArray(check.command) || check.command.length === 0 || !check.command.every((x) => typeof x === "string" && x.length > 0)) throw new Error(`publicChecks[${index}].command must be a non-empty argv string[]`);
    const cwd = stringField(check.cwd, `publicChecks[${index}].cwd`, 1, 512);
    if (isAbsolute(cwd) || cwd.split("/").includes("..")) throw new Error(`publicChecks[${index}].cwd must be repository-relative and cannot escape the repository`);
    const timeoutSeconds = positiveInteger(check.timeoutSeconds, `publicChecks[${index}].timeoutSeconds`, 3600);
    const expectedExitCodes = check.expectedExitCodes;
    if (!Array.isArray(expectedExitCodes) || expectedExitCodes.length === 0 || !expectedExitCodes.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) throw new Error(`publicChecks[${index}].expectedExitCodes must be a non-empty integer[]`);
    const required = check.required;
    if (typeof required !== "boolean") throw new Error(`publicChecks[${index}].required must be boolean`);
    if (check.mode !== "observe" && check.mode !== "blocking") throw new Error(`publicChecks[${index}].mode must be observe or blocking`);
    const stdoutMaxBytes = boundedBytes(check.stdoutMaxBytes, `publicChecks[${index}].stdoutMaxBytes`);
    const stderrMaxBytes = boundedBytes(check.stderrMaxBytes, `publicChecks[${index}].stderrMaxBytes`);
    const diagnostics = validateDiagnostics(check.diagnostics, index);
    return { id, command: [...check.command] as string[], cwd, timeoutSeconds, expectedExitCodes: [...new Set(expectedExitCodes as number[])], required, mode: check.mode, stdoutMaxBytes, stderrMaxBytes, ...(diagnostics.length ? { diagnostics } : {}) };
  });
}

function validateDiagnostics(value: unknown, index: number): PublicDiagnosticPattern[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error(`publicChecks[${index}].diagnostics must contain at most 32 entries`);
  const ids = new Set<string>();
  return value.map((raw, diagnosticIndex) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`publicChecks[${index}].diagnostics[${diagnosticIndex}] must be an object`);
    const item = raw as Record<string, unknown>;
    const unknown = Object.keys(item).find((key) => !new Set(["id", "kind", "pattern"]).has(key));
    if (unknown) throw new Error(`publicChecks[${index}].diagnostics[${diagnosticIndex}] contains unknown field ${unknown}`);
    const id = stringField(item.id, `publicChecks[${index}].diagnostics[${diagnosticIndex}].id`, 1, MAX_ID_LENGTH);
    if (ids.has(id)) throw new Error(`publicChecks[${index}] contains duplicate diagnostic id: ${id}`);
    ids.add(id);
    if (item.kind !== "literal" && item.kind !== "regex") throw new Error(`publicChecks[${index}].diagnostics[${diagnosticIndex}].kind must be literal or regex`);
    const pattern = stringField(item.pattern, `publicChecks[${index}].diagnostics[${diagnosticIndex}].pattern`, 1, MAX_PATTERN_LENGTH);
    if (item.kind === "regex") {
      if (/\(\?[=!<]|\\\d|\\k</.test(pattern)) throw new Error(`publicChecks[${index}].diagnostics[${diagnosticIndex}].pattern uses unsupported regex features`);
      try {
        const regex = new RegExp(pattern, "g");
        if (regex.test("")) throw new Error("matches empty string");
      } catch (error) {
        if (error instanceof Error && error.message === "matches empty string") throw new Error(`publicChecks[${index}].diagnostics[${diagnosticIndex}].pattern must not match an empty string`);
        throw new Error(`publicChecks[${index}].diagnostics[${diagnosticIndex}].pattern is not a valid regex`);
      }
    }
    return { id, kind: item.kind, pattern };
  });
}

function stringField(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max || value.trim() !== value) throw new Error(`${label} must be a trimmed string of length ${min}-${max}`);
  return value;
}
function positiveInteger(value: unknown, label: string, max: number): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error(`${label} must be an integer from 1 to ${max}`);
  return value as number;
}
function boundedBytes(value: unknown, label: string): number {
  return positiveInteger(value, label, MAX_OUTPUT_BYTES);
}

export class PublicBuildEvidenceRunner implements PublicEvidenceExecutor {
  async run(repo: string, rawChecks: readonly PublicCheck[], phase: "baseline" | "cycle", cycle: number | null): Promise<PublicEvidenceArtifact> {
    const checks = validatePublicChecks(rawChecks);
    const results: PublicEvidenceCheck[] = [];
    for (const check of checks) results.push(await this.runCheck(repo, check, phase, cycle, results.length));
    const blockingFailures = results.filter((result) => result.required && result.mode === "blocking" && result.status !== "passed").length;
    const blockingOutcomeFailures = results.filter((result) => result.required && result.mode === "blocking" && result.failureKind === "task-outcome").length;
    const infrastructureFailures = results.filter((result) => result.failureKind === "execution").length;
    const observedFailures = results.filter((result) => result.status !== "passed" && !(result.required && result.mode === "blocking")).length;
    return {
      schemaVersion: "build-evidence-1", phase, cycle, checks: results,
      summary: { passed: results.filter((result) => result.status === "passed").length, failed: results.filter((result) => result.status === "failed").length, timedOut: results.filter((result) => result.status === "timed_out").length, blockingFailures, blockingOutcomeFailures, infrastructureFailures, observedFailures },
    };
  }

  private async runCheck(repo: string, check: PublicCheck, phase: "baseline" | "cycle", cycle: number | null, index: number): Promise<PublicEvidenceCheck> {
    const cwd = resolve(repo, check.cwd);
    const outsideRepo = relative(resolve(repo), cwd).startsWith("..") || isAbsolute(relative(resolve(repo), cwd));
    if (outsideRepo) throw new Error(`public check cwd escapes repository: ${check.id}`);
    const started = Date.now();
    const output = await spawnBounded(check.command, cwd, check.timeoutSeconds * 1000, check.stdoutMaxBytes, check.stderrMaxBytes);
    const combined = `${output.stdout}\n${output.stderr}`;
    const diagnostics = (check.diagnostics ?? []).map((diagnostic) => ({ id: diagnostic.id, kind: diagnostic.kind, matchCount: countMatches(combined, diagnostic) })).filter((diagnostic) => diagnostic.matchCount > 0);
    const status = output.timedOut ? "timed_out" : output.exitCode === null || !check.expectedExitCodes.includes(output.exitCode) || diagnostics.some((diagnostic) => diagnostic.matchCount > 0) ? "failed" : "passed";
    const failureKind = status === "passed" ? "none" : output.timedOut || output.spawnError ? "execution" : "task-outcome";
    const ref = `build-evidence-${phase}${cycle === null ? "" : `-cycle-${cycle}`}.json#checks[${index}]`;
    return { id: check.id, required: check.required, mode: check.mode, status, failureKind, durationMs: Date.now() - started, exitCode: output.exitCode, timedOut: output.timedOut, truncated: { stdout: output.stdoutTruncated, stderr: output.stderrTruncated }, diagnostics, output: { stdoutExcerpt: redact(output.stdout), stderrExcerpt: redact(output.stderr) }, evidenceRef: ref };
  }
}

interface SpawnResult { stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean; exitCode: number | null; timedOut: boolean; spawnError: boolean }
function spawnBounded(argv: string[], cwd: string, timeoutMs: number, stdoutMaxBytes: number, stderrMaxBytes: number): Promise<SpawnResult> {
  return new Promise((resolveResult) => {
    let stdout = ""; let stderr = ""; let stdoutTruncated = false; let stderrTruncated = false; let timedOut = false; let spawnError = false; let settled = false;
    const child = spawn(argv[0]!, argv.slice(1), { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const append = (current: string, chunk: Buffer, max: number, setTruncated: (value: boolean) => void): string => {
      const next = Buffer.concat([Buffer.from(current), chunk]);
      if (next.length > max) { setTruncated(true); return next.subarray(0, max).toString("utf8"); }
      return next.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk, stdoutMaxBytes, (value) => { stdoutTruncated = value; }); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk, stderrMaxBytes, (value) => { stderrTruncated = value; }); });
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null): void => { if (settled) return; settled = true; clearTimeout(timer); if (graceTimer) clearTimeout(graceTimer); if (hardTimer) clearTimeout(hardTimer); resolveResult({ stdout, stderr, stdoutTruncated, stderrTruncated, exitCode, timedOut, spawnError }); };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      graceTimer = setTimeout(() => { child.kill("SIGKILL"); }, 200);
      hardTimer = setTimeout(() => { finish(null); }, 1_000);
    }, timeoutMs);
    child.once("error", (error) => { spawnError = !timedOut; stderr = append(stderr, Buffer.from(error.message), stderrMaxBytes, (value) => { stderrTruncated = value; }); finish(null); });
    child.once("close", (code) => finish(code));
  });
}
function countMatches(text: string, diagnostic: PublicDiagnosticPattern): number {
  if (diagnostic.kind === "literal") return text.split(diagnostic.pattern).length - 1;
  const regex = new RegExp(diagnostic.pattern, "g"); let count = 0; while (regex.exec(text)) { count += 1; if (count >= 1000) break; } return count;
}
export function redact(value: string): string { return value.replace(SECRET_VALUE, "$1[REDACTED]").replace(ABSOLUTE_PATH, "[absolute-path]"); }
export function publicEvidenceSummary(evidence: PublicEvidenceArtifact | undefined): string {
  if (!evidence) return "NO PUBLIC BUILD EVIDENCE CONFIGURED";
  return JSON.stringify({ schemaVersion: evidence.schemaVersion, phase: evidence.phase, cycle: evidence.cycle, summary: evidence.summary, checks: evidence.checks.map(({ id, required, mode, status, failureKind, durationMs, exitCode, timedOut, truncated, diagnostics, output, evidenceRef }) => ({ id, required, mode, status, failureKind, durationMs, exitCode, timedOut, truncated, diagnostics, output, evidenceRef })) }, null, 2);
}
