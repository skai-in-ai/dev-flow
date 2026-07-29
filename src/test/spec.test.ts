import assert from "node:assert/strict";
import test from "node:test";

import { assertRunnableSpec, parseSpec, renderSpec, specToHandoff, withSpecStatus, type TaskSpec } from "../spec.js";

const base = (): TaskSpec => ({ repo: "/tmp/example", status: "approved", title: "修正登入提示", createdAt: "2026-07-29T00:00:00.000Z", objective: "權限被拒絕時顯示可操作提示。", backgroundAndDecisions: "採用頁面內提示；不改 auth flow。", modificationScope: ["apps/mobile/login.tsx"], excludedScope: ["db/", "auth/"], acceptanceCriteria: ["拒絕權限時顯示提示", "既有登入不受影響"], testRequirements: ["npm test", "npm run build"], risks: ["auth boundary"], unresolvedItems: [] });

test("spec round-trips required frontmatter and all sections", () => {
  const parsed = parseSpec(renderSpec(base()));
  assert.deepEqual(parsed, base());
});
test("only approved specs without unresolved items can become a handoff", () => {
  const spec = base();
  assert.equal(specToHandoff(spec).scope.include[0], "apps/mobile/login.tsx");
  assert.throws(() => assertRunnableSpec({ ...spec, status: "draft" }), /approved/);
  assert.throws(() => assertRunnableSpec({ ...spec, unresolvedItems: ["confirm browser coverage"] }), /unresolved/);
});
test("spec parser rejects a missing required section", () => {
  assert.throws(() => parseSpec(renderSpec(base()).replace("## 風險\n- auth boundary\n\n", "")), /風險/);
});
test("spec lifecycle only replaces frontmatter status", () => {
  const rendered = renderSpec(base());
  const updated = withSpecStatus(rendered, "ready_for_main");
  assert.equal(parseSpec(updated).status, "ready_for_main");
  assert.equal(updated.includes("## 目標\n權限被拒絕時顯示可操作提示。"), true);
});
test("spec test requirements preserve code-formatted shell commands and reject prose", () => {
  const rendered = renderSpec(base());
  assert.equal(rendered.includes("- `npm test`"), true);
  assert.deepEqual(parseSpec(rendered).testRequirements, ["npm test", "npm run build"]);
  assert.throws(() => specToHandoff({ ...base(), testRequirements: ["在目標 repo 執行 npm test"] }), /raw executable shell command/);
});
