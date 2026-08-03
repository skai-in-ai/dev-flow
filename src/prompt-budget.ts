/**
 * Prompt 長度預算。
 *
 * 沒有這層時，送進 Pi 的 prompt 沒有任何上限：`workingDiff()` 對 untracked 檔案用
 * `git diff --no-index /dev/null <file>`，會把整個檔案內容原封不動印出來，而新功能
 * 通常帶一批新檔案；`repo_rules` 是整份 CLAUDE.md；`decision_log` 隨 cycle 增長。
 * 三者疊加會靜默溢出。
 *
 * 設計原則：
 * 1. **顯式截斷優於靜默溢出。** 截斷處插入明確標記，reviewer 有 read/grep 工具，
 *    看到標記可以自己去撈需要的部分。
 * 2. **完整內容一律留在 ledger。** `applyBudget` 只作用在算繪出來的 prompt 字串，
 *    不得原地改寫 `request.artifacts`，否則 `<sessionDir>/request.json` 也會一起被
 *    截斷，事後就無法追溯 agent 當時到底看到什麼。
 * 3. **以字元數而非 token 數計算。** 各模型的實際 context 上限未經實測，不在此
 *    寫死任何模型的數字；預設值是保守猜測，待實測調整。
 */

export interface PromptBudget {
  /** 單一 artifact 的字元上限。 */
  readonly perArtifactChars: number;
  /** 所有 artifact 合計的字元上限。 */
  readonly totalChars: number;
}

/** 待實測調整：保守預設值，未對照任何特定模型的實際上限。 */
export const DEFAULT_PROMPT_BUDGET: PromptBudget = { perArtifactChars: 20_000, totalChars: 80_000 };

export const TRUNCATION_MARKER = "…[TRUNCATED — full content preserved in the run ledger]…";

/** 保留頭尾兩端；開頭通常是結構，結尾通常是最新的變更，中間最適合捨棄。 */
export function truncate(text: string, maxChars: number, marker = TRUNCATION_MARKER): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  const budget = maxChars - marker.length - 2;
  const head = Math.max(0, Math.floor(budget * 0.7));
  const tail = Math.max(0, budget - head);
  return `${text.slice(0, head)}\n${marker}\n${tail ? text.slice(text.length - tail) : ""}`;
}

/**
 * 兩層預算：先各自套用單一上限，總量仍超出時再依比例縮減。
 *
 * 比例縮減刻意不保護任何特定 artifact：與其猜哪一個比較重要而寫死優先序，
 * 不如讓每個 artifact 都留下開頭與結尾，agent 自行決定要去撈哪一段。
 */
export function applyBudget(artifacts: Readonly<Record<string, string>>, budget: PromptBudget = DEFAULT_PROMPT_BUDGET): Record<string, string> {
  const capped: Record<string, string> = {};
  for (const [key, value] of Object.entries(artifacts)) capped[key] = truncate(value, budget.perArtifactChars);

  const total = Object.values(capped).reduce((sum, value) => sum + value.length, 0);
  if (total <= budget.totalChars) return capped;

  const ratio = budget.totalChars / total;
  const rebalanced: Record<string, string> = {};
  for (const [key, value] of Object.entries(capped)) rebalanced[key] = truncate(value, Math.max(TRUNCATION_MARKER.length, Math.floor(value.length * ratio)));
  return rebalanced;
}
