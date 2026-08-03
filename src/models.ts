import type { AgentRole, ModelSelection, Tier } from "./agents/contracts.js";

const codex = (name: string, reasoning: ModelSelection["reasoning"]): ModelSelection => ({ model: `openai-codex/gpt-5.6-${name}`, reasoning });

/** The classifier is intentionally cheap and cannot lower the deterministic floor. */
export function classifierModel(): ModelSelection { return codex("luna", "medium"); }

/**
 * implementer 的模型只看 cycle，不看 tier；tier 只決定 reviewer 是誰。
 * 這讓成本可預期，並符合「實作盡量留在便宜的 Luna」的目標。
 *
 * | cycle | 模型 | 理由 |
 * |-------|------|------|
 * | 1 首次實作 | Luna Medium | handoff 已寫清楚要做什麼，High 的多餘推理正是範圍漂移的來源 |
 * | 2 第一次修正 | Luna High | 需要理解 finding 背後的意圖 |
 * | 3 第二次修正 | Luna High | 同上 |
 * | 4 第三次修正 | Terra Medium | Luna 連兩次修不好才升級，昂貴模型保留給有困難證據的情況 |
 */
export function modelFor(tier: Tier, role: AgentRole, cycle = 1): ModelSelection {
  if (role === "router") return classifierModel();
  if (role === "implementer") {
    if (cycle <= 1) return codex("luna", "medium");
    if (cycle <= 3) return codex("luna", "high");
    return codex("terra", "medium");
  }
  if (tier === 0) return codex("luna", "low");
  // tier 1 的 final_reviewer 走 Sol Low；不可簡化為單一 return，否則這一格會被靜默改掉。
  if (tier === 1) return role === "reviewer" ? codex("luna", "high") : codex("sol", "low");
  if (role === "reviewer") return codex("terra", "medium");
  return codex("sol", "medium");
}
