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
  events?: readonly unknown[];
  usage?: Record<string, unknown>;
  sessionMetadata?: Record<string, unknown>;
}

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
