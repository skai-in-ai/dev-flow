import type { AgentRole, ModelSelection, Tier } from "./agents/contracts.js";

const codex = (name: string, reasoning: "low" | "medium"): ModelSelection => ({ model: `openai-codex/gpt-5.6-${name}`, reasoning });
export function modelFor(tier: Tier, role: AgentRole): ModelSelection {
  if (tier === 0) return role === "final_reviewer" ? codex("luna", "low") : codex("luna", "low");
  if (tier === 1) {
    if (role === "implementer") return codex("luna", "medium");
    if (role === "reviewer") return codex("terra", "low");
    return codex("sol", "low");
  }
  if (role === "implementer" || role === "reviewer") return codex("terra", "medium");
  return codex("sol", "medium");
}
