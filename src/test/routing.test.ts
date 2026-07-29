import assert from "node:assert/strict";
import test from "node:test";
import { modelFor } from "../models.js";
import { deterministicRoute, hybridRoute } from "../routing.js";
import { validateHandoff } from "../handoff.js";

const base = validateHandoff({ repo: "/tmp/repo", objective: "update docs", scope: { include: ["README.md"] }, acceptanceCriteria: ["clear"], constraints: [], tests: [], riskNotes: [], delivery: { mode: "direct_main", requireApproval: true } });
test("routes mechanical work to tier 0", () => assert.equal(deterministicRoute(base).tier, 0));
test("deterministic floor beats a model downgrade", async () => {
  const result = await hybridRoute({ ...base, objective: "add database migration" }, {}, { classify: async () => ({ tier: 0, confidence: 1 }) });
  assert.equal(result.tier, 2);
});
test("model and reasoning mapping is fixed", () => {
  assert.deepEqual(modelFor(1, "implementer"), { model: "openai-codex/gpt-5.6-luna", reasoning: "medium" });
  assert.deepEqual(modelFor(1, "reviewer"), { model: "openai-codex/gpt-5.6-terra", reasoning: "low" });
  assert.deepEqual(modelFor(2, "final_reviewer"), { model: "openai-codex/gpt-5.6-sol", reasoning: "medium" });
});
