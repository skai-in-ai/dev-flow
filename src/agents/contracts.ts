export type Tier = 0 | 1 | 2;
export type AgentRole = "implementer" | "reviewer" | "final_reviewer" | "router";
export type ReviewVerdict = "pass" | "fail" | "escalate";

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
