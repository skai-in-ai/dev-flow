import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseCorpusInventoryArgs, runCorpusInventory } from "../benchmark/corpus-inventory.js";

async function fixture(options: { dockerfile?: string; instruction?: string; taskToml?: string } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "corpus-inventory-"));
  const task = join(root, "task-b");
  await mkdir(join(task, "environment"), { recursive: true });
  await mkdir(join(task, "solution"));
  await mkdir(join(task, "tests"));
  await writeFile(join(task, "task.toml"), options.taskToml ?? '[metadata]\ndifficulty = "easy"\ntags = ["z", "a",]\n[agent]\ntimeout_sec = 12\n[verifier]\ntimeout_sec = 20\n');
  if (options.instruction !== undefined) await writeFile(join(task, "instruction.md"), options.instruction);
  if (options.dockerfile !== undefined) await writeFile(join(task, "environment", "Dockerfile"), options.dockerfile);
  await writeFile(join(task, "solution", "secret.txt"), "DO_NOT_READ_SECRET");
  await writeFile(join(task, "tests", "secret.txt"), "DO_NOT_READ_TEST_SECRET");
  await chmod(join(task, "solution", "secret.txt"), 0);
  await chmod(join(task, "tests", "secret.txt"), 0);
  return root;
}

test("inventory is deterministic, sorted, and emits no operator-local absolute paths", async () => {
  const root = await fixture({ instruction: "Run `pytest -q` and inspect with vim.", dockerfile: "FROM python:3.13\nWORKDIR /workspace\nRUN apt-get update && apt-get install -y git\n" });
  const first = await runCorpusInventory({ corpusRoot: root });
  const second = await runCorpusInventory({ corpusRoot: root });
  assert.deepEqual(first, second);
  assert.equal(first.tasks[0]?.metadata.tags.join(","), "a,z");
  assert.equal(first.tasks[0]?.workdir, "/workspace");
  assert.equal(first.tasks[0]?.timeouts.agentSeconds, 12);
  assert.equal(first.tasks[0]?.environment.dockerfile.dependencyDeclarations[0]?.tool, "apt-get");
  assert.equal(first.tasks[0]?.publicCheckCandidates.some((candidate) => candidate.type === "test" && candidate.clue === "pytest"), true);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(serialized, /DO_NOT_READ/);
  assert.equal(first.tasks[0]?.files.some((file) => "contentHash" in file), false);
});

test("inventory leaves unknown values null when public evidence is absent", async () => {
  const root = await fixture();
  const inventory = await runCorpusInventory({ corpusRoot: root });
  const task = inventory.tasks[0]!;
  assert.equal(task.metadata.version, null);
  assert.equal(task.metadata.category, null);
  assert.equal(task.timeouts.buildSeconds, null);
  assert.equal(task.workdir, null);
  assert.equal(task.environment.dockerfile.present, false);
  assert.equal(task.indicators.gpu.value, null);
  assert.equal(task.indicators.network.value, null);
  assert.deepEqual(task.publicCheckCandidates, []);
});

test("inventory fails closed on malformed metadata and unknown CLI arguments", async () => {
  const root = await fixture({ taskToml: "[metadata]\ndifficulty = [unterminated\n" });
  await assert.rejects(runCorpusInventory({ corpusRoot: root }), /malformed|unsupported|unterminated/);
  assert.throws(() => parseCorpusInventoryArgs([]), /usage/);
  assert.throws(() => parseCorpusInventoryArgs([root, "--json"]), /usage/);
  assert.throws(() => parseCorpusInventoryArgs(["--help"]), /usage/);
});

test("inventory fails closed on symlink escape without opening the target", async () => {
  const root = await fixture();
  await symlink(tmpdir(), join(root, "escape-task"));
  await assert.rejects(runCorpusInventory({ corpusRoot: root }), /symlink/);
  const taskRoot = await fixture();
  await symlink(tmpdir(), join(taskRoot, "task-b", "environment", "outside"));
  await assert.rejects(runCorpusInventory({ corpusRoot: taskRoot }), /symlink/);
});

test("permitted content changes digest while protected content is not read", async () => {
  const root = await fixture({ instruction: "Run `true`." });
  const before = await runCorpusInventory({ corpusRoot: root });
  await chmod(join(root, "task-b", "solution", "secret.txt"), 0o644);
  await writeFile(join(root, "task-b", "solution", "secret.txt"), "CHANGED_SECRET");
  const protectedChange = await runCorpusInventory({ corpusRoot: root });
  assert.equal(protectedChange.tasks[0]?.inventoryDigest, before.tasks[0]?.inventoryDigest);
  assert.deepEqual(protectedChange.tasks[0]?.sourceDigest, { status: "not-computed", value: null, reason: "protected solution/tests/verifier content intentionally unread" });
  await writeFile(join(root, "task-b", "instruction.md"), "Run `false`.");
  const permittedChange = await runCorpusInventory({ corpusRoot: root });
  assert.notEqual(permittedChange.tasks[0]?.inventoryDigest, before.tasks[0]?.inventoryDigest);
  assert.equal(await readFile(join(root, "task-b", "solution", "secret.txt"), "utf8"), "CHANGED_SECRET");
});
