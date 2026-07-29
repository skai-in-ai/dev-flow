import assert from "node:assert/strict";
import test from "node:test";
import { ShellTestRunner } from "../test-runner.js";
test("runs deterministic externally supplied command", async () => {
  const result = await new ShellTestRunner().run("node -e \"process.exit(0)\"", process.cwd());
  assert.equal(result.passed, true);
});
