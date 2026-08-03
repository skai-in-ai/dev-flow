import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PROMPT_BUDGET, TRUNCATION_MARKER, applyBudget, truncate } from "../prompt-budget.js";
import { renderPrompt } from "../adapters/pi/pi-process-adapter.js";

test("leaves text within budget untouched", () => {
  assert.equal(truncate("short", 100), "short");
  assert.equal(truncate("x".repeat(100), 100), "x".repeat(100));
});

test("marks the cut explicitly and keeps both ends", () => {
  const text = `HEAD${"m".repeat(5_000)}TAIL`;
  const cut = truncate(text, 500);

  assert.ok(cut.length <= 500, `expected at most 500 chars, got ${cut.length}`);
  assert.ok(cut.includes(TRUNCATION_MARKER), "a silent cut is worse than a visible one");
  assert.ok(cut.startsWith("HEAD"), "the beginning carries the structure");
  assert.ok(cut.endsWith("TAIL"), "the end carries the most recent change");
});

test("caps each artifact and then rebalances when the total is still over budget", () => {
  const artifacts = { diff: "d".repeat(50_000), repo_rules: "r".repeat(50_000), decision_log: "l".repeat(50_000) };
  const budgeted = applyBudget(artifacts, { perArtifactChars: 20_000, totalChars: 30_000 });
  const total = Object.values(budgeted).reduce((sum, value) => sum + value.length, 0);

  assert.ok(total <= 30_000, `expected the total to fit 30000 chars, got ${total}`);
  for (const [name, value] of Object.entries(budgeted)) assert.ok(value.includes(TRUNCATION_MARKER), `${name} must say it was truncated`);
});

test("an artifact that fits is not rewritten just because a sibling is huge", () => {
  const budgeted = applyBudget({ tests: "ok", diff: "d".repeat(1_000) }, { perArtifactChars: 100, totalChars: 10_000 });

  assert.equal(budgeted.tests, "ok");
  assert.ok(budgeted.diff.includes(TRUNCATION_MARKER));
});

test("the rendered prompt is bounded while the request keeps the full artifacts", () => {
  const artifacts = { diff: "d".repeat(200_000) };
  const request = { role: "reviewer" as const, taskId: "x", prompt: "review", artifacts, cwd: "/tmp", sessionDir: "/tmp/s", model: { model: "openai-codex/gpt-5.6-terra", reasoning: "medium" as const } };
  const prompt = renderPrompt(request, DEFAULT_PROMPT_BUDGET);

  assert.ok(prompt.length < 100_000, `expected the prompt to be bounded, got ${prompt.length}`);
  assert.ok(prompt.includes(TRUNCATION_MARKER));
  assert.equal(request.artifacts.diff.length, 200_000, "renderPrompt must not mutate the caller's artifacts; the ledger needs the original");
});
