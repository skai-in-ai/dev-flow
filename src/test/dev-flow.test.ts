import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SPEC_DIR, SpecNotReady, listSpecs, resolveTarget } from "../dev-flow.js";
import { renderSpec, type SpecStatus, type TaskSpec } from "../spec.js";

async function repoWithSpecs(specs: { name: string; status: SpecStatus; title: string; unresolved?: string[] }[]): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "dev-flow-"));
  await mkdir(join(repo, SPEC_DIR), { recursive: true });
  for (const spec of specs) {
    const body: TaskSpec = {
      repo, status: spec.status, title: spec.title, createdAt: "2026-08-03T00:00:00.000Z",
      objective: "做一件事", backgroundAndDecisions: "無", modificationScope: ["src/"], excludedScope: [],
      acceptanceCriteria: ["完成"], testRequirements: ["npm test"], risks: [], unresolvedItems: spec.unresolved ?? [],
    };
    await writeFile(join(repo, SPEC_DIR, spec.name), renderSpec(body));
  }
  return repo;
}

test("picks the newest spec when no path is given", async () => {
  const repo = await repoWithSpecs([
    { name: "2026-08-01-old.md", status: "approved", title: "舊的" },
    { name: "2026-08-03-new.md", status: "approved", title: "新的" },
  ]);

  assert.equal((await listSpecs(repo)).length, 2);
  assert.equal((await resolveTarget(repo)).spec.title, "新的");
});

test("refuses to start when the newest spec is still being discussed", async () => {
  const repo = await repoWithSpecs([
    { name: "2026-08-01-old.md", status: "approved", title: "舊的" },
    { name: "2026-08-03-new.md", status: "needs_clarification", title: "新的", unresolved: ["SecureStore 清除失敗時的語意未定義"] },
  ]);

  const error = await resolveTarget(repo).catch((thrown: unknown) => thrown);
  assert.ok(error instanceof SpecNotReady, "an undecided spec must not be dispatched");
  // 不可退回去跑更舊的那份：使用者以為在跑新任務，安靜地跑了舊的比報錯更糟。
  assert.match(error.path, /2026-08-03-new\.md$/);
  assert.match(error.render(), /SecureStore 清除失敗時的語意未定義/, "the pending questions must be shown");
  assert.match(error.render(), /改為 approved/);
});

test("refuses an approved spec that still carries unresolved items", async () => {
  const repo = await repoWithSpecs([{ name: "2026-08-03-a.md", status: "approved", title: "有未決", unresolved: ["價格帶未定"] }]);

  const error = await resolveTarget(repo).catch((thrown: unknown) => thrown);
  assert.ok(error instanceof SpecNotReady);
  assert.match(error.render(), /價格帶未定/);
});

test("an explicit path overrides the newest-spec rule", async () => {
  const repo = await repoWithSpecs([
    { name: "2026-08-01-old.md", status: "approved", title: "舊的" },
    { name: "2026-08-03-new.md", status: "approved", title: "新的" },
  ]);

  assert.equal((await resolveTarget(repo, join(repo, SPEC_DIR, "2026-08-01-old.md"))).spec.title, "舊的");
});

test("says where specs are expected when the repo has none", async () => {
  const repo = await mkdtemp(join(tmpdir(), "dev-flow-empty-"));
  await assert.rejects(resolveTarget(repo), /找不到任何 spec/);
});
