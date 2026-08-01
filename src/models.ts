import type { AgentRole, ModelSelection, Tier } from "./agents/contracts.js";

const codex = (name: string, reasoning: ModelSelection["reasoning"]): ModelSelection => ({ model: `openai-codex/gpt-5.6-${name}`, reasoning });

/** The classifier is intentionally cheap and cannot lower the deterministic floor. */
export function classifierModel(): ModelSelection { return codex("luna", "medium"); }

/**
 * T2 starts with a Luna implementation. A failed T2 round retries with Terra
 * so the expensive implementer is reserved for evidence of difficulty.
 */
export function modelFor(tier: Tier, role: AgentRole, round = 1): ModelSelection {
  if (role === "router") return classifierModel();
  if (tier === 0) return codex("luna", role === "implementer" ? "medium" : "low");
  if (tier === 1) {
    if (role === "implementer" || role === "reviewer") return codex("luna", "high");
    return codex("sol", "low");
  }
  if (role === "implementer") return round === 1 ? codex("luna", "high") : codex("terra", "medium");
  if (role === "reviewer") return codex("terra", "medium");
  return codex("sol", "medium");
}
