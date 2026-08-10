import assert from "node:assert/strict";
import test from "node:test";

import { compactPiEvents, isPiSessionLog } from "../ledger-retention.js";

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

test("streaming snapshots are dropped and the structural skeleton is kept", () => {
  const stdout = [
    { type: "session", version: 3, id: "019fe75a", timestamp: "2026-08-09T16:28:43.991Z" },
    { type: "turn_start" },
    { type: "message_update", assistantMessageEvent: { type: "thinking_start" }, message: { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(50_000) }] } },
    { type: "message_update", assistantMessageEvent: { type: "thinking_start" }, message: { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(90_000) }] } },
    { type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "/repo/AGENTS.md" } },
    { type: "tool_execution_update", toolCallId: "call_1", partial: "x".repeat(10_000) },
    { type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result: { content: [{ type: "text", text: "y".repeat(80_000) }] }, isError: false },
    { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "z".repeat(40_000) }], model: "gpt-5.6-luna", stopReason: "toolUse", usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.5 } } }, toolResults: [{ toolName: "read", isError: false, content: [{ text: "z".repeat(40_000) }] }] },
  ].map(line).join("");

  const compacted = compactPiEvents(stdout);
  const events = compacted.split("\n").filter(Boolean).map((entry) => JSON.parse(entry) as Record<string, any>);

  assert.deepEqual(events.map((event) => event.type), ["session", "turn_start", "tool_execution_start", "tool_execution_end", "turn_end"], "progress-only events are dropped, everything else keeps its place in order");

  // 「跑了幾次、過了沒、中間發生什麼事」所需的欄位必須完好。
  assert.equal(events[0].id, "019fe75a");
  assert.equal(events[2].toolName, "read");
  assert.equal(events[2].args.path, "/repo/AGENTS.md", "small arguments stay readable; they answer which file was touched");
  assert.equal(events[3].isError, false);
  assert.deepEqual(events[4].message.usage, { input: 10, output: 20, totalTokens: 30, cost: { total: 0.5 } }, "usage is the whole point of keeping turn_end");
  assert.equal(events[4].message.stopReason, "toolUse");
  assert.deepEqual(events[4].toolResults, [{ toolName: "read", isError: false }], "which tools ran and whether they failed is structure, their output is content");

  // 內容一律不留。
  assert.ok(!compacted.includes("x".repeat(300)));
  assert.ok(!compacted.includes("y".repeat(300)));
  assert.ok(!compacted.includes("z".repeat(300)));
  assert.equal(events[3].result, undefined);
  assert.equal(events[4].message.content, undefined);

  assert.ok(compacted.length < stdout.length / 100, `expected a two-orders-of-magnitude reduction, got ${stdout.length} → ${compacted.length}`);
});

test("JSON null is compacted without a callback exception", () => {
  assert.equal(compactPiEvents("null\n"), "null\n");
});

test("a line that cannot be parsed is kept rather than silently discarded", () => {
  const compacted = compactPiEvents(`not json\n${line({ type: "turn_start" })}`);
  const events = compacted.split("\n").filter(Boolean).map((entry) => JSON.parse(entry) as Record<string, unknown>);
  assert.equal(events[0].type, "unparsed", "an unreadable line is the only clue to an unknown failure; truncate it, do not drop it");
  assert.equal(events[0].raw, "not json");
  assert.equal(events[1].type, "turn_start");
  assert.equal(compactPiEvents(""), "");
});

test("an unknown event type survives compaction with its content stripped", () => {
  const events = compactPiEvents(line({ type: "some_future_event", id: "abc", payload: "q".repeat(9_000) })).split("\n").filter(Boolean).map((entry) => JSON.parse(entry) as Record<string, unknown>);
  assert.equal(events[0].type, "some_future_event");
  assert.equal(events[0].id, "abc");
  assert.match(String(events[0].payload), /^q{200}…\(truncated\)$/, "unknown fields are truncated, not removed: the retention rule must not need updating for every new event type");
});

test("Pi's own session log is recognised by name only", () => {
  assert.ok(isPiSessionLog("2026-08-09T16-28-43-991Z_019fe75a-ee57-7acf-b1a0-07db35dc472a.jsonl"));
  assert.ok(!isPiSessionLog("trace.jsonl"));
  assert.ok(!isPiSessionLog("request.json"));
  assert.ok(!isPiSessionLog("events.jsonl"));
});
