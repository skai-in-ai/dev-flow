export type Tier = 0 | 1 | 2;
export type AgentRole = "implementer" | "reviewer" | "final_reviewer" | "router";
/**
 * `needs_spec` 表示「缺陷不在實作，而在 handoff 沒定義的產品語意」。
 * 它不是失敗，重試沒有意義，正確動作是帶著具體問題回到討論階段。
 */
export type ReviewVerdict = "pass" | "fail" | "escalate" | "needs_spec";

export interface ModelSelection {
  model: string;
  reasoning: "low" | "medium" | "high";
}

export interface AgentRunRequest {
  role: AgentRole;
  taskId: string;
  prompt: string;
  /** A reviewer gets only supplied artifacts, never another agent's conversation. */
  artifacts: Readonly<Record<string, string>>;
  model: ModelSelection;
  cwd: string;
  sessionDir: string;
  timeoutMs?: number;
}

export interface AgentRunResult {
  summary: string;
  verdict?: ReviewVerdict;
  findings?: readonly string[];
  // 刻意不回傳原始 events。它們已由 adapter 寫成 <sessionDir>/events.jsonl，
  // 再放進 result 會被 orchestrator 一併寫入 ledger，造成同一份資料存兩次。
  // 實測一次 run 因此佔用 527 MB，其中單一 implementer 的 JSON 有 100% 是重複的 events。
  // 需要原始事件時讀 sessionMetadata.eventsPath。
  usage?: Record<string, unknown>;
  sessionMetadata?: Record<string, unknown>;
}

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
