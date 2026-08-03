import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MAX_FIX_CYCLES, maxCyclesFor, nextCycle } from "../policies/completion-policy.js";

test("three fix cycles allow four implementations in total", () => {
  assert.equal(maxCyclesFor(DEFAULT_MAX_FIX_CYCLES), 4);
  assert.deepEqual(nextCycle({ cycle: 1, maxFixCycles: 3 }), { action: "retry", state: { cycle: 2, maxFixCycles: 3 } });
  assert.deepEqual(nextCycle({ cycle: 2, maxFixCycles: 3 }), { action: "retry", state: { cycle: 3, maxFixCycles: 3 } });
  assert.deepEqual(nextCycle({ cycle: 3, maxFixCycles: 3 }), { action: "retry", state: { cycle: 4, maxFixCycles: 3 } });
});

test("the last fix is still fully verified before giving up", () => {
  // 關鍵不變量：cycle 4 的失敗發生在它已跑完 tests 與 review 之後，計數點在失敗當下。
  const decision = nextCycle({ cycle: 4, maxFixCycles: 3 });
  assert.equal(decision.action, "give_up");
  assert.equal(decision.state.cycle, 4, "the reported cycle must stay at the failing cycle");
});

test("zero fix cycles means a single unretried implementation", () => {
  assert.equal(maxCyclesFor(0), 1);
  assert.equal(nextCycle({ cycle: 1, maxFixCycles: 0 }).action, "give_up");
});

test("rejects a negative or non-integer limit", () => {
  assert.throws(() => nextCycle({ cycle: 1, maxFixCycles: -1 }), /maxFixCycles must be a non-negative integer/);
  assert.throws(() => nextCycle({ cycle: 1, maxFixCycles: 1.5 }), /maxFixCycles must be a non-negative integer/);
  assert.throws(() => nextCycle({ cycle: 0, maxFixCycles: 3 }), /cycle must be a positive integer/);
});
