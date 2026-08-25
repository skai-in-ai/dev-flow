import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { classifyEntry, runCorpusTriage, validateInventory } from "../benchmark/corpus-triage.js";
import type { CorpusInventory, CorpusInventoryTask } from "../benchmark/corpus-inventory.js";

function task(overrides: Partial<CorpusInventoryTask> = {}): CorpusInventoryTask {
  return {
    taskName: "triage-fixture",
    relativePath: "triage-fixture",
    inventoryDigest: "a".repeat(64),
    sourceDigest: { status: "not-computed", value: null, reason: "protected solution/tests/verifier content intentionally unread" },
    metadata: { version: "1", difficulty: "medium", category: "debugging", tags: [] },
    timeouts: { agentSeconds: 900, verifierSeconds: 900, buildSeconds: null },
    workdir: "/app",
    environment: { files: [{ path: "environment", type: "directory", sizeBytes: null, mode: 493 }], dockerfile: { present: true, dependencyDeclarations: [], workdir: "/app" } },
    indicators: {
      gpu: { value: null, rule: "fixture", provenance: [] }, qemu: { value: null, rule: "fixture", provenance: [] },
      service: { value: null, rule: "fixture", provenance: [] }, network: { value: null, rule: "fixture", provenance: [] },
      buildLarge: { value: null, rule: "fixture", provenance: [] },
    },
    publicCheckCandidates: [{ type: "test", clue: "pytest", confidence: "low", provenance: ["instruction.md#L1"] }],
    compatibilityRiskFacts: [],
    files: [],
    ...overrides,
  };
}

function inventory(tasks: CorpusInventoryTask[] = [task()]): CorpusInventory {
  return { schemaVersion: "terminal-bench-corpus-inventory-1", corpusRoot: "operator-local", digestRule: "inventory identity; protected content is never read", tasks };
}

test("triage is deterministic and ordering is stable", async () => {
  const root = await mkdtemp(join(tmpdir(), "corpus-triage-"));
  const path = join(root, "inventory.json");
  await writeFile(path, JSON.stringify(inventory([task({ taskName: "z-task", relativePath: "z-task", inventoryDigest: "b".repeat(64) }), task({ taskName: "a-task", relativePath: "a-task", inventoryDigest: "c".repeat(64) })])));
  const first = await runCorpusTriage({ inventoryPath: path });
  const second = await runCorpusTriage({ inventoryPath: path });
  assert.deepEqual(first, second);
  assert.deepEqual(first.tasks.map((entry) => `${entry.taskName}:${entry.harness}`), ["a-task:codex", "a-task:single-pi", "a-task:full-dev-flow", "z-task:codex", "z-task:single-pi", "z-task:full-dev-flow"]);
});

test("malformed inventory fails closed and source digest must be not-computed", () => {
  assert.throws(() => validateInventory({ schemaVersion: "terminal-bench-corpus-inventory-1", corpusRoot: "operator-local", digestRule: "inventory identity", tasks: [task({ sourceDigest: { status: "computed", value: "x", reason: "" } as never })] }), /sourceDigest must be not-computed/);
  assert.throws(() => validateInventory({ schemaVersion: "terminal-bench-corpus-inventory-1", corpusRoot: "operator-local", digestRule: "inventory identity" }), /tasks are required/);
});

test("unsupported or incomplete decisions stay unknown or blocked with provenance", () => {
  const known = task();
  const unknown = classifyEntry(known, "future-harness" as never);
  assert.equal(unknown.classification, "unknown");
  assert.match(unknown.provenance.join("\n"), /unknown-on-unsupported-input/);
  const blocked = classifyEntry(task({ workdir: null }), "codex");
  assert.equal(blocked.classification, "blocked-readonly");
  assert.match(blocked.reasons.join("\n"), /missing workdir/);
  assert.ok(blocked.provenance.length > 0);
});

test("classifications preserve harness semantics and previous-task exclusion", async () => {
  const root = await mkdtemp(join(tmpdir(), "corpus-triage-"));
  const path = join(root, "inventory.json");
  await writeFile(path, JSON.stringify(inventory([task({ taskName: "prove-plus-comm", relativePath: "prove-plus-comm" }), task({ taskName: "new-task", relativePath: "new-task" })])));
  const result = await runCorpusTriage({ inventoryPath: path });
  assert.equal(result.tasks.find((entry) => entry.taskName === "new-task" && entry.harness === "codex")?.classification, "direct-compatible");
  assert.equal(result.tasks.find((entry) => entry.taskName === "new-task" && entry.harness === "full-dev-flow")?.classification, "derivative-required");
  assert.ok(result.tasks.every((entry) => entry.provenance.some((ref) => ref.includes("inventoryDigest"))));
  assert.deepEqual(result.batch0Candidates, ["new-task"]);
});

test("triage output does not contain operator paths or protected content", async () => {
  const root = await mkdtemp(join(tmpdir(), "corpus-triage-secret-"));
  const path = join(root, "inventory.json");
  await writeFile(path, JSON.stringify(inventory([task({ taskName: "safe-task", relativePath: "safe-task", sourceDigest: { status: "not-computed", value: null, reason: "protected secret content intentionally unread" } })])));
  const result = await runCorpusTriage({ inventoryPath: path });
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(text, /secret|session|auth|\/Users\/|\/private\/tmp/);
});
