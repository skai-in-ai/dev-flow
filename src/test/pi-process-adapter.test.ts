import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProcessAdapter, parseJsonLines, parseReview, renderPrompt, type PiProcessRunner } from "../adapters/pi/pi-process-adapter.js";
import { renderClassifierPrompt } from "../classifier-prompt.js";

test("parses Pi JSON, message_end content blocks, and Pi CLI args", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-adapter-"));
  let received: string[] = [];
  const adapter = new PiProcessAdapter({ run: async (_cmd, args) => { received = args; return { exitCode: 0, stderr: "", timedOut: false, stdout: '{"type":"message_end","message":{"content":[{"type":"text","text":"VERDICT: pass\\n- looks good"}]}}\n{"type":"result","usage":{"input":12}}\n' }; } });
  const result = await adapter.run({ role: "reviewer", taskId: "x", prompt: "review", artifacts: {}, cwd: dir, sessionDir: join(dir, "session"), model: { model: "openai-codex/gpt-5.6-terra", reasoning: "low" } });
  assert.equal(result.verdict, "pass"); assert.deepEqual(result.findings, ["looks good"]); assert.deepEqual(result.usage, { input: 12 });
  assert.equal(received.includes("--thinking"), true); assert.equal(received.includes("--reasoning"), false); assert.equal(received.includes("--session-dir"), true); assert.equal(received.includes("--no-extensions"), true); assert.equal(received.includes("read,grep,find,ls"), true);
});
test("reports Pi timeout and preserves malformed JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-adapter-"));
  assert.deepEqual(parseJsonLines("oops\n")[0], { type: "unparsed", raw: "oops" });
  const adapter = new PiProcessAdapter({ run: async () => ({ exitCode: null, stderr: "", timedOut: true, stdout: "" }) });
  await assert.rejects(adapter.run({ role: "implementer", taskId: "x", prompt: "do", artifacts: {}, cwd: dir, sessionDir: join(dir, "session"), model: { model: "openai-codex/gpt-5.6-luna", reasoning: "low" } }), /timed out/);
});

test("router is explicitly started without tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-adapter-router-"));
  let received: string[] = [];
  const adapter = new PiProcessAdapter({ run: async (_cmd, args) => {
    received = args;
    return { exitCode: 0, stderr: "", timedOut: false, stdout: '{"type":"message_end","message":{"content":[{"type":"text","text":"{}"}]}}\n' };
  } });
  await adapter.run({ role: "router", taskId: "route", prompt: "classify", artifacts: {}, cwd: dir, sessionDir: join(dir, "session"), model: { model: "openai-codex/gpt-5.6-terra", reasoning: "low" } });
  assert.equal(received.includes("--no-tools"), true);
  assert.equal(received.includes("--tools"), false);
});

test("accepts JSON reviewer verdict aliases and requires a standalone verdict line", () => {
  assert.deepEqual(parseReview('{"verdict":"approve","findings":["covered"]}'), { verdict: "pass", findings: ["covered"] });
  assert.deepEqual(parseReview('```json\n{"verdict":"reject","findings":["missing test"]}\n```'), { verdict: "fail", findings: ["missing test"] });
  assert.deepEqual(parseReview('{"verdict":"escalate"}'), { verdict: "escalate", findings: [] });
  assert.deepEqual(parseReview('{"verdict":"spec_gap"}'), { verdict: "needs_spec", findings: [] });
  assert.deepEqual(parseReview("VERDICT: needs spec"), { verdict: "needs_spec", findings: [] });
  const prompt = renderPrompt({ role: "final_reviewer", taskId: "x", prompt: "review", artifacts: {}, cwd: "/tmp", sessionDir: "/tmp/session", model: { model: "openai-codex/gpt-5.6-sol", reasoning: "low" } });
  assert.match(prompt, /VERDICT: pass, VERDICT: fail, VERDICT: escalate, or VERDICT: needs_spec/);
  assert.match(prompt, /not a substitute for fail/);
  assert.match(prompt, /Batch same-category sibling findings in one review round/);
  assert.match(prompt, /reachable approved paths/);
  assert.match(prompt, /explicit non-goals/);
});

test("the implementer is told to stay in scope and to answer prior findings one by one", () => {
  const prompt = renderPrompt({ role: "implementer", taskId: "x", prompt: "build", artifacts: {}, cwd: "/tmp", sessionDir: "/tmp/session", model: { model: "openai-codex/gpt-5.6-luna", reasoning: "medium" } });
  assert.match(prompt, /Do not refactor, do not reformat, and do not touch files unrelated to the requested change/);
  assert.match(prompt, /Respond to every prior finding explicitly/);
  assert.match(prompt, /inspect reasonable sibling cases in the same reachable invariant category/);
  assert.match(prompt, /regression tests/);
});

test("classifier prompt excludes incomplete implementation from risk assessment", () => {
  const prompt = renderClassifierPrompt({ repo: "/tmp/repo", objective: "rename a file", scope: { include: ["README.md"] }, acceptanceCriteria: ["renamed"], constraints: [], tests: [], riskNotes: [], delivery: { mode: "direct_main", requireApproval: true } });
  assert.match(prompt, /Do not treat a missing initial diff, unfinished acceptance criteria, or the fact that implementation has not begun as risk/);
});

test("the result carries no raw event payload, only a pointer to the ledger file", async () => {
  // 迴歸守門：events 曾經同時存在 events.jsonl 與 result 內，orchestrator 把 result
  // 寫進 ledger 時造成同一份資料存兩次。實測一次 run 佔 527 MB，其中單一 implementer
  // 的 JSON 有 100% 是重複的 events。
  const bulky = Array.from({ length: 200 }, (_, index) => JSON.stringify({ type: "tool", payload: "x".repeat(500), index })).join("\n");
  const stdout = `${bulky}\n${JSON.stringify({ type: "message_end", text: "VERDICT: pass" })}\n`;
  const dir = await mkdtemp(join(tmpdir(), "adapter-events-"));
  const runner: PiProcessRunner = { run: async () => ({ stdout, stderr: "", exitCode: 0, timedOut: false }) };

  const result = await new PiProcessAdapter(runner).run({ role: "reviewer", taskId: "x", prompt: "review", artifacts: {}, cwd: dir, sessionDir: dir, model: { model: "openai-codex/gpt-5.6-terra", reasoning: "medium" } });

  assert.equal((result as unknown as Record<string, unknown>).events, undefined, "raw events must never travel back in the result");
  assert.ok(JSON.stringify(result).length < 2_000, `the ledger payload must stay small, got ${JSON.stringify(result).length}`);
  assert.equal(result.sessionMetadata?.eventsPath, join(dir, "events.jsonl"), "the pointer must let a reader find the full events");
  assert.ok((await readFile(join(dir, "events.jsonl"), "utf8")).length > 90_000, "the full events must still be preserved on disk");
  assert.equal(result.verdict, "pass", "the summary and verdict are still derived from those events");
});
