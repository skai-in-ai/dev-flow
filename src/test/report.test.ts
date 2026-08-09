import assert from "node:assert/strict";
import test from "node:test";

import { formatDuration, formatMoney, renderReport, type ReportInput } from "../report.js";
import { EMPTY_DECISION_LOG, appendFindings, appendResponse } from "../decision-log.js";

const base: ReportInput = {
  status: "needs_human", tier: 1, maxTier: 1, cycles: 2, maxCycles: 4,
  cost: { total: 0.0248, byRole: { reviewer: 0.0168, implementer: 0.008 } },
  durationMs: 12 * 60_000 + 3_000, runId: "2026-08-04T00-00-00-000Z-abcd1234",
  specTitle: "PTT 推文情緒指標", specPath: "/repo/.agent/specs/2026-08-04-ptt.md",
  decisionLog: EMPTY_DECISION_LOG,
};

test("puts the numbers a human actually asks for at the top", () => {
  const report = renderReport(base);
  assert.match(report, /# 需要人工介入 · PTT 推文情緒指標/);
  assert.match(report, /\| Tier \| 1（上限 1） \|/);
  assert.match(report, /\| Cycle \| 2\/4 \|/);
  assert.match(report, /\| 花費 \| US\$0\.02480 \|/);
  assert.match(report, /\| 耗時 \| 12 分 03 秒 \|/);
});

test("lists the still-open findings in full because that is the payload", () => {
  const log = appendResponse(
    appendFindings(
      appendFindings(EMPTY_DECISION_LOG, [{ round: 1, source: "reviewer", model: "openai-codex/gpt-5.6-luna", text: "**High** — ptt_tickers is never populated" }]),
      [{ round: 2, source: "reviewer", model: "openai-codex/gpt-5.6-luna", text: "**High** — running timeout compares ISO timestamps lexically" }],
    ),
    { round: 1, model: "openai-codex/gpt-5.6-luna", text: "改了 scraper 的 insert，沒有動 pipeline，因為 finding 只提到 scraper" },
  );
  const report = renderReport({ ...base, decisionLog: log });

  assert.match(report, /## 尚未解決（cycle 2）/);
  assert.match(report, /running timeout compares ISO timestamps lexically/, "the open finding must appear verbatim");
  assert.ok(!report.includes("ptt_tickers is never populated\n\n## 歷程"), "the resolved cycle-1 finding is history, not an open item");
  assert.match(report, /\| 1 \| 審查 \| 1 \| 改了 scraper 的 insert/, "the history table pairs each cycle with the implementer's answer");
  assert.match(report, /luna/, "attribution must survive; model ids are shortened, not dropped");
});

test("turns a spec gap into a lettered choice", () => {
  const report = renderReport({ ...base, specGap: { semantic: "清除失敗時下次啟動是否視為已登出，未定義", candidates: ["靠 backend 回 401", "啟動先驗 session"] } });
  assert.match(report, /## 待你決定的產品語意/);
  assert.match(report, /A\. 靠 backend 回 401/);
  assert.match(report, /B\. 啟動先驗 session/);
  assert.match(report, /回答上面的選擇題/);
});

test("a crash explains itself and gives the manual recovery bridge", () => {
  const report = renderReport({ ...base, status: "failed", error: "Pi implementer exited 1: connection reset by peer" });
  assert.match(report, /# 執行中斷/);
  assert.match(report, /connection reset by peer/);
  assert.match(report, /可能停在中間狀態/);
  assert.match(report, /worktree provenance/);
  assert.match(report, /local checkpoint commit/);
  assert.match(report, /narrow fix/);
  assert.match(report, /targeted follow-up review/);
  assert.match(report, /不會自動 commit、push、restart 或 discard/);
});

test("a clean run says there is nothing outstanding rather than staying silent", () => {
  const report = renderReport({ ...base, status: "ready_for_main", cycles: 1 });
  assert.match(report, /## 尚未解決\n\n無。/);
  assert.match(report, /未 commit/);
});

test("shows where the money went, largest first", () => {
  const report = renderReport(base);
  assert.ok(report.indexOf("| 審查 | US$0.01680 | 67.7% |") < report.indexOf("| 實作 | US$0.00800 |"), "the biggest line item must lead");
});

test("formats short runs without a bogus minute count", () => {
  assert.equal(formatDuration(45_000), "45 秒");
  assert.equal(formatDuration(0), "0 秒");
  assert.equal(formatMoney(0), "US$0.00000");
});

test("keeps the resolved findings verbatim in a collapsed block rather than reducing them to a count", () => {
  const log = appendResponse(
    appendFindings(EMPTY_DECISION_LOG, [{ round: 1, source: "reviewer", model: "openai-codex/gpt-5.6-luna", text: "**High** — ptt_tickers is never populated" }]),
    { round: 1, model: "openai-codex/gpt-5.6-luna", text: "改了 scraper 的 insert" },
  );
  const report = renderReport({ ...base, status: "ready_for_main", cycles: 2, decisionLog: log });

  assert.match(report, /<details>/);
  assert.match(report, /ptt_tickers is never populated/, "an outer reviewer often needs to see what was caught");
  assert.match(report, /> implementer（luna）：改了 scraper 的 insert/);
});

test("needs-human guidance uses a manual checkpoint bridge", () => {
  const report = renderReport({ ...base, cycles: 4, maxCycles: 4 });
  assert.match(report, /worktree provenance/);
  assert.match(report, /local checkpoint commit/);
  assert.match(report, /human.*narrow fix|narrow fix/);
  assert.match(report, /targeted follow-up review/);
  assert.match(report, /does not auto|不會自動 commit、push、restart 或 discard/);
  assert.match(report, /Resume.*#10/);
});

test("repeated failures with an error still use checkpoint guidance", () => {
  const decisionLog = appendFindings(EMPTY_DECISION_LOG, [{ round: 2, source: "reviewer", model: "openai-codex/gpt-5.6-luna", text: "same finding" }]);
  const report = renderReport({ ...base, cycles: 2, maxCycles: 4, error: "identical failure repeated", decisionLog });
  assert.match(report, /worktree provenance/);
  assert.match(report, /local checkpoint commit/);
  assert.doesNotMatch(report, /上面的中止原因說明了為什麼再修一次也沒用/);
});

test("does not claim the budget ran out when cycles are left", () => {
  assert.match(renderReport({ ...base, cycles: 2, maxCycles: 4 }), /還剩 2 次修正額度卻提前收斂/);
  assert.match(renderReport({ ...base, cycles: 4, maxCycles: 4 }), /修正次數已用盡/);
});
