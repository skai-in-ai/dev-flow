import assert from "node:assert/strict";
import test from "node:test";

import { EMPTY_DECISION_LOG, appendFindings, appendResponse, formatDecisionLog } from "../decision-log.js";

test("accumulates findings across rounds instead of overwriting them", () => {
  const first = appendFindings(EMPTY_DECISION_LOG, [{ round: 1, source: "reviewer", model: "terra", text: "SecureStore error is swallowed" }]);
  const second = appendFindings(first, [{ round: 2, source: "final_reviewer", model: "sol", text: "runtime must log out regardless" }]);

  assert.equal(second.findings.length, 2, "round 2 must not replace round 1");
  assert.equal(first.findings.length, 1, "appendFindings must not mutate its input");
});

test("keeps the implementer response attached to the round it answers", () => {
  const log = appendResponse(
    appendFindings(EMPTY_DECISION_LOG, [{ round: 1, source: "reviewer", model: "terra", text: "finding one" }]),
    { round: 1, model: "luna", text: "changed session.ts; left storage.ts alone because it is best-effort" },
  );

  assert.equal(log.responses[0]?.round, 1);
  assert.equal(log.findings.length, 1, "recording a response must not touch findings");
});

test("formats history grouped by round with source and model attribution", () => {
  const log = appendResponse(
    appendFindings(
      appendFindings(EMPTY_DECISION_LOG, [{ round: 1, source: "reviewer", model: "terra", text: "finding one" }]),
      [{ round: 2, source: "final_reviewer", model: "sol", text: "finding two" }],
    ),
    { round: 1, model: "luna", text: "response to round one" },
  );
  const rendered = formatDecisionLog(log);

  assert.match(rendered, /## Round 1/);
  assert.match(rendered, /\[reviewer · terra\] finding one/);
  assert.match(rendered, /IMPLEMENTER RESPONSE \(luna\):\nresponse to round one/);
  assert.match(rendered, /## Round 2/);
  assert.match(rendered, /\[final_reviewer · sol\] finding two/);
  assert.ok(rendered.indexOf("## Round 1") < rendered.indexOf("## Round 2"), "rounds must render in chronological order");
});

test("states explicitly that there is no history on the first attempt", () => {
  assert.match(formatDecisionLog(EMPTY_DECISION_LOG), /NO PRIOR ROUNDS/);
});
