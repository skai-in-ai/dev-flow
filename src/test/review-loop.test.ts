import assert from "node:assert/strict";
import test from "node:test";

import {
  implementationFinished,
  reviewFinished,
  startReviewLoop,
  testsFinished,
} from "../workflows/review-loop.js";

test("completes after deterministic tests and an isolated reviewer pass", () => {
  const implementing = startReviewLoop();
  const testing = implementationFinished(implementing);
  const reviewing = testsFinished(testing, true, "all tests passed");
  const completed = reviewFinished(reviewing, "pass");

  assert.deepEqual(completed, {
    phase: "completed",
    round: 1,
    maxRounds: 3,
  });
});

test("returns to implementer after a test failure and preserves its evidence", () => {
  const testing = implementationFinished(startReviewLoop());
  const retry = testsFinished(testing, false, "npm test: exit 1");

  assert.deepEqual(retry, {
    phase: "implementing",
    round: 2,
    maxRounds: 3,
    lastFailure: { source: "tests", details: "npm test: exit 1" },
  });
});

test("escalates to a human after the third failed review", () => {
  let state = startReviewLoop();
  for (let round = 1; round <= 3; round += 1) {
    state = implementationFinished(state);
    state = testsFinished(state, true, "passed");
    state = reviewFinished(state, "fail", [`review finding ${round}`]);
  }

  assert.equal(state.phase, "needs_human");
  assert.equal(state.round, 3);
  assert.deepEqual(state.lastFailure, {
    source: "reviewer",
    details: ["review finding 3"],
  });
});

test("rejects transitions that skip the deterministic test gate", () => {
  assert.throws(() => testsFinished(startReviewLoop(), true, "not run"), {
    message: "Expected phase testing, received implementing",
  });
});

