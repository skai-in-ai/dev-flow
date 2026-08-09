/**
 * 每次 run 結束時產出的人類可讀報告。
 *
 * 存在的理由：讀 run 結果原本要開 `summary.json` 加 `decisions.json`，findings 是
 * reviewer 的英文散文，分散在多個檔案裡。實務上這件事被外包給一個外層 agent 去讀、
 * 整理、翻譯，等於每次都花一次模型錢做純機械的字串組裝。
 *
 * 這裡刻意**不呼叫任何模型**。findings 已經帶嚴重度標記與 file:line，結構化資料
 * 也都在，組裝成報告是決定性的。外層的判斷（這個結果能不能收、要不要重派）仍然
 * 留給人或外層 agent，那才是需要判斷力的部分。
 */

import type { DecisionLog } from "./decision-log.js";
import type { Tier } from "./agents/contracts.js";

export interface ReportInput {
  readonly status: "ready_for_main" | "needs_human" | "failed";
  readonly tier: Tier;
  readonly maxTier?: Tier;
  readonly cycles: number;
  readonly maxCycles: number;
  readonly cost: { total: number; byRole: Record<string, number> };
  readonly durationMs: number;
  readonly runId: string;
  readonly specTitle?: string;
  readonly specPath?: string;
  readonly decisionLog: DecisionLog;
  readonly specGap?: { semantic: string; candidates: string[] };
  readonly error?: string;
}

const STATUS_TEXT: Record<ReportInput["status"], string> = {
  ready_for_main: "可以合併",
  needs_human: "需要人工介入",
  failed: "執行中斷",
};

const ROLE_TEXT: Record<string, string> = {
  implementer: "實作",
  reviewer: "審查",
  final_reviewer: "最終審查",
  router: "風險判斷",
};

const SOURCE_TEXT: Record<string, string> = {
  tests: "測試",
  reviewer: "審查",
  final_reviewer: "最終審查",
};

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes} 分 ${String(total % 60).padStart(2, "0")} 秒` : `${total} 秒`;
}

export function formatMoney(usd: number): string {
  return `US$${usd.toFixed(5)}`;
}

export function renderReport(input: ReportInput): string {
  const out: string[] = [];
  out.push(`# ${STATUS_TEXT[input.status]}${input.specTitle ? ` · ${input.specTitle}` : ""}`, "");

  const tierNote = input.maxTier !== undefined ? `${input.tier}（上限 ${input.maxTier}）` : String(input.tier);
  out.push("| 項目 | 值 |", "|:---|:---|");
  out.push(`| 狀態 | \`${input.status}\` |`);
  out.push(`| Tier | ${tierNote} |`);
  out.push(`| Cycle | ${input.cycles}/${input.maxCycles} |`);
  out.push(`| 花費 | ${formatMoney(input.cost.total)} |`);
  out.push(`| 耗時 | ${formatDuration(input.durationMs)} |`);
  if (input.specPath) out.push(`| Spec | \`${input.specPath}\` |`);
  out.push(`| Run | \`${input.runId}\` |`, "");

  if (input.error) out.push("## 中止原因", "", "```", input.error.trim(), "```", "");

  if (input.specGap) {
    out.push("## 待你決定的產品語意", "", input.specGap.semantic, "");
    out.push(...input.specGap.candidates.map((candidate, index) => `${String.fromCharCode(65 + index)}. ${candidate}`), "");
    out.push("回答之後把 spec 的未決事項清掉、status 改回 approved，再重跑。", "");
  }

  const open = input.decisionLog.findings.filter((finding) => finding.round === input.cycles);
  if (open.length) {
    out.push(`## 尚未解決（cycle ${input.cycles}）`, "");
    out.push(...open.map((finding, index) => `${index + 1}. **[${SOURCE_TEXT[finding.source] ?? finding.source} · ${short(finding.model)}]** ${finding.text.trim()}`), "");
  } else if (input.status === "ready_for_main") {
    out.push("## 尚未解決", "", "無。測試與該 tier 所需的 review 全數通過。", "");
  }

  const rounds = [...new Set(input.decisionLog.findings.map((finding) => finding.round))].sort((a, b) => a - b);
  if (rounds.length) {
    out.push("## 歷程", "", "| Cycle | 失敗來源 | 條數 | implementer 如何回應 |", "|:---:|:---|:---:|:---|");
    for (const round of rounds) {
      const findings = input.decisionLog.findings.filter((finding) => finding.round === round);
      const sources = [...new Set(findings.map((finding) => SOURCE_TEXT[finding.source] ?? finding.source))].join("、");
      const response = input.decisionLog.responses.find((entry) => entry.round === round);
      out.push(`| ${round} | ${sources} | ${findings.length} | ${response ? oneLine(response.text) : "（未再修正）"} |`);
    }
    out.push("");

    // 已解決的 findings 收在摺疊區：不佔版面，但不丟掉原文。
    // 外層審查者常需要回頭看「reviewer 到底抓到什麼」，只留條數等於把那個資訊丟了。
    const resolved = rounds.filter((round) => round !== input.cycles || input.status === "ready_for_main");
    if (resolved.length) {
      out.push("<details>", "<summary>完整歷程（每條 finding 的原文）</summary>", "");
      for (const round of resolved) {
        out.push(`### Cycle ${round}`, "");
        for (const finding of input.decisionLog.findings.filter((entry) => entry.round === round)) {
          out.push(`- **[${SOURCE_TEXT[finding.source] ?? finding.source} · ${short(finding.model)}]** ${finding.text.trim()}`);
        }
        const response = input.decisionLog.responses.find((entry) => entry.round === round);
        if (response) out.push("", `> implementer（${short(response.model)}）：${response.text.trim()}`);
        out.push("");
      }
      out.push("</details>", "");
    }
  }

  const roles = Object.entries(input.cost.byRole).filter(([, amount]) => amount > 0).sort((a, b) => b[1] - a[1]);
  if (roles.length) {
    out.push("## 花在哪裡", "", "| 角色 | 花費 | 佔比 |", "|:---|---:|---:|");
    for (const [role, amount] of roles) {
      const share = input.cost.total ? `${((amount / input.cost.total) * 100).toFixed(1)}%` : "-";
      out.push(`| ${ROLE_TEXT[role] ?? role} | ${formatMoney(amount)} | ${share} |`);
    }
    out.push("");
  }

  out.push("## 下一步", "", nextStep(input), "");
  return out.join("\n");
}

function nextStep(input: ReportInput): string {
  if (input.status === "ready_for_main") {
    return "變更留在 working tree，未 commit。看過 diff 後自行合併。";
  }
  if (input.status === "failed") {
    return "流程中斷，變更可能停在中間狀態。先看上面的中止原因；若要保留實作或 review 變更，先確認仍保留且來源正確的 worktree provenance，建立 local checkpoint commit，再由人選擇 narrow fix，最後執行 targeted follow-up review。這是手動 checkpoint bridge，不會自動 commit、push、restart 或 discard。經 GitHub Issue queue 執行時，另有需要人工授權的 Same-Issue Resume。";
  }
  if (input.specGap) return "回答上面的選擇題，更新 spec 後重跑。";
  if (input.status === "needs_human" && (input.cycles >= input.maxCycles || (input.error && input.decisionLog.findings.length > 0))) return "修正次數已用盡或失敗重複。先確認仍保留且來源正確的 worktree provenance，建立 local checkpoint commit；再由人選擇一個 narrow fix，最後執行 targeted follow-up review。這是手動 checkpoint bridge，不會自動 commit、push、restart 或 discard。經 GitHub Issue queue 執行時，另有需要人工授權的 Same-Issue Resume。";
  if (input.error) return "上面的中止原因說明了為什麼再修一次也沒用。先處理它，再重跑。";
  if (input.cycles >= input.maxCycles) return "修正次數已用盡。先確認仍保留且來源正確的 worktree provenance，建立 local checkpoint commit；再由人選擇一個 narrow fix，最後執行 targeted follow-up review。這是手動 checkpoint bridge，不會自動 commit、push、restart 或 discard。經 GitHub Issue queue 執行時，另有需要人工授權的 Same-Issue Resume。";
  // 還有 cycle 卻停下來，代表被別的規則收斂（例如 reviewer 要求升 tier 但撞到 --max-tier 上限）。
  return `還剩 ${input.maxCycles - input.cycles} 次修正額度卻提前收斂，通常是 reviewer 要求升 tier 但撞到上限。先確認仍保留且來源正確的 worktree provenance，建立 local checkpoint commit；再由人選擇 narrow fix 並執行 targeted follow-up review。這是手動 checkpoint bridge，不會自動 commit、push、restart 或 discard。經 GitHub Issue queue 執行時，另有需要人工授權的 Same-Issue Resume。`;
}

function short(model: string): string {
  return model.split("/").at(-1)?.replace(/^gpt-[\d.]+-/, "") ?? model;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat || "（無回應）";
}
