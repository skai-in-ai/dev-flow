/**
 * 失敗後是否重試的唯一判斷來源。
 *
 * `orchestrator.ts` 的每個失敗分支（測試失敗、reviewer fail、降級的 needs_spec、
 * final reviewer fail）都必須呼叫 `nextCycle`，不得自行比較上限。上限數字只允許
 * 出現在本檔案的 `DEFAULT_MAX_FIX_CYCLES`。
 *
 * 一個 cycle 是一次完整的 implement → tests → reviewer →（tier 2）final。
 * `maxFixCycles` 計的是「因失敗而重新實作」的次數，所以 3 對應最多 4 次實作
 * （cycle 1 是原始實作，cycle 2 至 4 是三次修正）。
 *
 * 關鍵不變量：**失敗計數點在失敗當下，不在進入時**。因此最後一次修正（cycle 4）
 * 仍會完整跑完 tests、reviewer 與必要的 final review，只有在它也失敗時才收斂為
 * needs_human。舊版在進入第三輪前就判定放棄，導致最後一次修正從未被驗證。
 */

export const DEFAULT_MAX_FIX_CYCLES = 3;

export interface CycleState {
  readonly cycle: number;
  readonly maxFixCycles: number;
}

export type CycleDecision =
  | { readonly action: "retry"; readonly state: CycleState }
  | { readonly action: "give_up"; readonly state: CycleState };

/** 於失敗當下呼叫：修正次數已用盡則放棄，否則前進到下一個 cycle。 */
export function nextCycle(state: CycleState): CycleDecision {
  assertValid(state);
  if (state.cycle > state.maxFixCycles) return { action: "give_up", state };
  return { action: "retry", state: { ...state, cycle: state.cycle + 1 } };
}

/** cycle 上限（含原始實作），即允許的最大實作次數。 */
export function maxCyclesFor(maxFixCycles: number): number {
  return maxFixCycles + 1;
}

function assertValid(state: CycleState): void {
  if (!Number.isInteger(state.maxFixCycles) || state.maxFixCycles < 0) {
    throw new Error("maxFixCycles must be a non-negative integer");
  }
  if (!Number.isInteger(state.cycle) || state.cycle < 1) {
    throw new Error("cycle must be a positive integer");
  }
}
