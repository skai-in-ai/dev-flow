import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAX_TIER, classifierModel, modelFor } from "../models.js";
import { deterministicRoute, hybridRoute } from "../routing.js";
import { validateHandoff } from "../handoff.js";

const base = validateHandoff({ repo: "/tmp/repo", objective: "update docs", scope: { include: ["README.md"] }, acceptanceCriteria: ["clear"], constraints: [], tests: [], riskNotes: [], delivery: { mode: "direct_main", requireApproval: true } });
test("routes mechanical work to tier 0", () => assert.equal(deterministicRoute(base).tier, 0));
test("deterministic floor beats a model downgrade", async () => {
  const result = await hybridRoute({ ...base, objective: "add database migration" }, {}, { classify: async () => ({ tier: 0, confidence: 1 }) });
  assert.equal(result.tier, 2);
});
test("model and reasoning mapping is Luna-first", () => {
  assert.deepEqual(classifierModel(), { model: "openai-codex/gpt-5.6-luna", reasoning: "medium" });
  assert.deepEqual(modelFor(0, "implementer"), { model: "openai-codex/gpt-5.6-luna", reasoning: "medium" });
  assert.deepEqual(modelFor(0, "reviewer"), { model: "openai-codex/gpt-5.6-luna", reasoning: "low" });
  assert.deepEqual(modelFor(1, "reviewer"), { model: "openai-codex/gpt-5.6-luna", reasoning: "high" });
  assert.deepEqual(modelFor(1, "final_reviewer"), { model: "openai-codex/gpt-5.6-sol", reasoning: "low" }, "tier 1 final review must stay on Sol Low");
  assert.deepEqual(modelFor(2, "reviewer"), { model: "openai-codex/gpt-5.6-terra", reasoning: "medium" });
  assert.deepEqual(modelFor(2, "final_reviewer"), { model: "openai-codex/gpt-5.6-sol", reasoning: "medium" });
});

test("the implementer ladder follows the cycle, not the tier", () => {
  // 首次實作用 Medium：handoff 已寫清楚要做什麼，High 的多餘推理正是範圍漂移的來源。
  // Terra 只在 Luna 連兩次修不好之後才出場。
  for (const tier of [0, 1, 2] as const) {
    assert.deepEqual(modelFor(tier, "implementer", 1), { model: "openai-codex/gpt-5.6-luna", reasoning: "medium" });
    assert.deepEqual(modelFor(tier, "implementer", 2), { model: "openai-codex/gpt-5.6-luna", reasoning: "high" });
    assert.deepEqual(modelFor(tier, "implementer", 3), { model: "openai-codex/gpt-5.6-luna", reasoning: "high" });
    assert.deepEqual(modelFor(tier, "implementer", 4), { model: "openai-codex/gpt-5.6-terra", reasoning: "medium" });
  }
});

test("the default tier cap keeps everyday runs on the cheap reviewers", () => {
  // 實測（2026-08-03，8 個真實 run）：review 佔總支出 79%，implementer 只佔 16%。
  assert.equal(DEFAULT_MAX_TIER, 1);
  assert.deepEqual(modelFor(DEFAULT_MAX_TIER, "reviewer"), { model: "openai-codex/gpt-5.6-luna", reasoning: "high" });
  // 上限 1 時 implementer 永遠不升到 Terra，否則設的成本天花板等於沒設。
  for (const cycle of [1, 2, 3, 4, 5]) {
    assert.ok(!modelFor(1, "implementer", cycle, DEFAULT_MAX_TIER).model.includes("terra"), `cycle ${cycle} escaped the cap`);
  }
  // 未設上限時，第三次修正仍會升級。
  assert.deepEqual(modelFor(2, "implementer", 4), { model: "openai-codex/gpt-5.6-terra", reasoning: "medium" });
});
