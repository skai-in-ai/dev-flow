import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicBuildEvidenceRunner, validatePublicChecks } from "../public-evidence-runner.js";

const base = (command: string[]) => ({ id: "check", command, cwd: ".", timeoutSeconds: 2, expectedExitCodes: [0], required: true, mode: "blocking" as const, stdoutMaxBytes: 128, stderrMaxBytes: 128 });

test("public checks fail closed for shell strings, escaping cwd, invalid timeout and unsafe regex", () => {
  assert.throws(() => validatePublicChecks([{ ...base(["echo ok"]), command: "echo ok" }]), /argv string/);
  assert.throws(() => validatePublicChecks([{ ...base(["true"]), cwd: "../outside" }]), /cannot escape/);
  assert.throws(() => validatePublicChecks([{ ...base(["true"]), timeoutSeconds: 0 }]), /timeoutSeconds/);
  assert.throws(() => validatePublicChecks([{ ...base(["true"]), diagnostics: [{ id: "x", kind: "regex", pattern: "(?=secret)" }] }]), /unsupported regex/);
  assert.throws(() => validatePublicChecks([{ ...base(["true"]), diagnostics: [{ id: "x", kind: "regex", pattern: "^" }] }]), /empty string/);
});

test("runner passes argv literally, bounds output, records provenance and redacts sensitive output", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-evidence-"));
  const result = await new PublicBuildEvidenceRunner().run(root, [
    { ...base([process.execPath, "-e", "console.log(process.argv[1]); console.log('token=super-secret /Users/skai.wu/.codex/auth.json');", "$(touch SHOULD_NOT_EXIST)"]), id: "literal", diagnostics: [{ id: "token", kind: "literal", pattern: "token=" }] },
  ], "cycle", 2);
  const check = result.checks[0]!;
  assert.equal(result.schemaVersion, "build-evidence-1");
  assert.equal(result.phase, "cycle");
  assert.equal(result.cycle, 2);
  assert.equal(check.status, "failed", "diagnostic is prohibited even when command exits zero");
  assert.match(check.output.stdoutExcerpt, /\$\(touch SHOULD_NOT_EXIST\)/);
  assert.doesNotMatch(check.output.stdoutExcerpt, /super-secret|\/Users\/skai/);
  assert.equal(check.diagnostics[0]?.matchCount, 1);
  assert.match(check.evidenceRef, /cycle-2\.json#checks\[0\]/);
});

test("runner distinguishes timeout and output truncation without shell execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-evidence-timeout-"));
  const timeout = await new PublicBuildEvidenceRunner().run(root, [{ ...base([process.execPath, "-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 10000)" ]), timeoutSeconds: 1 }], "baseline", null);
  assert.equal(timeout.checks[0]?.status, "timed_out");
  assert.equal(timeout.checks[0]?.failureKind, "execution");
  const output = await new PublicBuildEvidenceRunner().run(root, [{ ...base([process.execPath, "-e", "process.stdout.write('x'.repeat(1000))"]), stdoutMaxBytes: 20 }], "baseline", null);
  assert.equal(output.checks[0]?.status, "passed");
  assert.equal(output.checks[0]?.truncated.stdout, true);
  assert.equal(output.checks[0]?.output.stdoutExcerpt.length, 20);
});

test("runner does not expose raw artifact file paths or environment contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-evidence-redaction-"));
  const result = await new PublicBuildEvidenceRunner().run(root, [{ ...base([process.execPath, "-e", "console.error('HOME=/Users/skai.wu/.codex/session secret=abc')"]), id: "redact" }], "baseline", null);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /skai\.wu|secret=abc/);
  assert.equal(await readFile(join(root, "missing"), "utf8").catch(() => "missing"), "missing");
});

test("missing executable is recorded as baseline execution infrastructure failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-evidence-spawn-"));
  const result = await new PublicBuildEvidenceRunner().run(root, [{ ...base([join(root, "does-not-exist")]), id: "missing" }], "baseline", null);
  assert.equal(result.checks[0]?.failureKind, "execution");
  assert.equal(result.checks[0]?.exitCode, null);
  assert.equal(result.summary.infrastructureFailures, 1);
  assert.equal(result.summary.blockingOutcomeFailures, 0);
});
