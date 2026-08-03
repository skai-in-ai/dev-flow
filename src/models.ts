import type { AgentRole, ModelSelection, Tier } from "./agents/contracts.js";

const codex = (name: string, reasoning: ModelSelection["reasoning"]): ModelSelection => ({ model: `openai-codex/gpt-5.6-${name}`, reasoning });

/**
 * 未指定 `--max-tier` 時的預設上限。
 *
 * 實測依據（2026-08-03，8 個真實 run）：review 佔總支出 79%（reviewer 44%、Sol final 35%），
 * implementer 只佔 16%。把上限壓到 1 會把 reviewer 從 Terra Medium 換成 Luna High
 * （單次約 1/3 價），並整個略過 Sol final，實測單次 run 從 $0.10~$0.21 降到約 $0.023。
 * 同批資料裡 Luna High 的 findings 有嚴重度分級與 file:line 引用，看不出品質降級。
 *
 * 這不等於放棄 Sol 那道網，而是把它移到更划算的位置：流程停在 `ready_for_main` 之後，
 * 由迴圈外的一個 Sol Low 讀最終 diff 與 report 並提出處置，人只做關鍵裁決。同一道 gate
 * 從「每個 cycle 跑一次中間態」變成「整個 run 結束後跑一次最終版」，更便宜也審得更準。
 * 真的動到金流或下單時再手動 `--max-tier 2`，把 gate 拉回迴圈內。
 */
export const DEFAULT_MAX_TIER: Tier = 1;

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
export function modelFor(tier: Tier, role: AgentRole, cycle = 1, maxTier?: Tier): ModelSelection {
  if (role === "router") return classifierModel();
  if (role === "implementer") {
    if (cycle <= 1) return codex("luna", "medium");
    // 操作者把 tier 壓在 2 以下時，那是一道成本上限，implementer 也必須遵守。
    // 舊行為只約束 reviewer，於是 cap=1 的 run 在 cycle 4 仍會叫出 Terra，
    // 使用者以為設了天花板其實沒有。
    if (cycle <= 3 || (maxTier !== undefined && maxTier < 2)) return codex("luna", "high");
    return codex("terra", "medium");
  }
  if (tier === 0) return codex("luna", "low");
  // tier 1 的 final_reviewer 走 Sol Low；不可簡化為單一 return，否則這一格會被靜默改掉。
  if (tier === 1) return role === "reviewer" ? codex("luna", "high") : codex("sol", "low");
  if (role === "reviewer") return codex("terra", "medium");
  return codex("sol", "medium");
}
