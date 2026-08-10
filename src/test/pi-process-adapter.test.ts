import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePiProcessRunner, PiProcessAdapter, parseJsonLines, parseReview, renderPrompt, type PiProcessRunner } from "../adapters/pi/pi-process-adapter.js";
import { renderClassifierPrompt } from "../classifier-prompt.js";

test("parses Pi JSON, message_end content blocks, and Pi CLI args", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-adapter-"));
  let received: string[] = [];
  const adapter = new PiProcessAdapter({ run: async (_cmd, args) => { received = args; return { exitCode: 0, stderr: "", timedOut: false, stdout: '{"type":"message_end","message":{"content":[{"type":"text","text":"VERDICT: pass\\n- looks good"}]}}\n{"type":"result","usage":{"input":12}}\n' }; } });
  const result = await adapter.run({ role: "reviewer", taskId: "x", prompt: "review", artifacts: {}, cwd: dir, sessionDir: join(dir, "session"), model: { model: "openai-codex/gpt-5.6-terra", reasoning: "low" } });
  assert.equal(result.verdict, "pass"); assert.deepEqual(result.findings, ["looks good"]); assert.deepEqual(result.usage, { input: 12 });
  assert.equal(received.includes("--thinking"), true); assert.equal(received.includes("--reasoning"), false); assert.equal(received.includes("--session-dir"), true); assert.equal(received.includes("--no-extensions"), true); assert.equal(received.includes("read,grep,find,ls"), true);
});
test("streams cumulative updates with bounded compact retention and keeps final fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-stream-"));
  const script = `for (let i = 0; i < 200; i++) process.stdout.write(JSON.stringify({type:"message_update",message:{content:[{type:"text",text:"x".repeat(i * 100)}]}})+String.fromCharCode(10)); process.stdout.write(JSON.stringify({type:"message_end",message:{content:[{type:"text",text:"VERDICT: pass"+String.fromCharCode(10)+"- final"}]}})+String.fromCharCode(10)); process.stdout.write(JSON.stringify({type:"result",usage:{input:42}})+String.fromCharCode(10));`;
  const tracePath = join(dir, "trace.jsonl");
  const result = await new NodePiProcessRunner({ maxTraceBytes: 64, maxPartialLineBytes: 1_000_000 }).run(process.execPath, ["-e", script], { cwd: dir, input: "", timeoutMs: 1_000, tracePath });
  assert.equal(parseReview(result.assistant ?? "").verdict, "pass");
  assert.deepEqual(parseReview(result.assistant ?? "").findings, ["final"]);
  assert.deepEqual(result.usage, { input: 42 });
  const trace = await readFile(tracePath, "utf8");
  assert.ok(trace.includes("trace_truncated"));
  assert.ok(Buffer.byteLength(trace, "utf8") <= 64);
});

test("reassembles split JSONL and fails closed on an overlong record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-stream-"));
  const split = `const x=JSON.stringify({type:"message_end",text:"VERDICT: pass"}); process.stdout.write(x.slice(0,3)); setTimeout(()=>process.stdout.write(x.slice(3)+"\\n"),10);`;
  const runner = new NodePiProcessRunner({ maxPartialLineBytes: 100 });
  const ok = await runner.run(process.execPath, ["-e", split], { cwd: dir, input: "", timeoutMs: 1_000 });
  assert.match(ok.assistant ?? "", /VERDICT: pass/);
  const tooLong = new NodePiProcessRunner({ maxPartialLineBytes: 32 });
  await assert.rejects(tooLong.run(process.execPath, ["-e", "process.stdout.write('x'.repeat(100))"], { cwd: dir, input: "", timeoutMs: 1_000 }), /JSONL record exceeds/);
});

test("preserves UTF-8 when an event is split in the middle of a code point", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-stream-"));
  const script = `const bytes=Buffer.from(JSON.stringify({type:"message_end",text:"VERDICT: pass — 臺灣"})+"\\n"); const split=bytes.indexOf(Buffer.from("臺"))+1; process.stdout.write(bytes.subarray(0,split)); setTimeout(()=>process.stdout.write(bytes.subarray(split)),20);`;
  const result = await new NodePiProcessRunner().run(process.execPath, ["-e", script], { cwd: dir, input: "", timeoutMs: 1_000 });
  assert.equal(result.assistant, "VERDICT: pass — 臺灣");
});

test("fails closed when the final assistant text exceeds its bound", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-stream-"));
  const script = `process.stdout.write(JSON.stringify({type:"message_end",text:"x".repeat(1_048_577)})+String.fromCharCode(10));`;
  await assert.rejects(new NodePiProcessRunner().run(process.execPath, ["-e", script], { cwd: dir, input: "", timeoutMs: 1_000 }), /assistant text exceeds/);
});

test("keeps bounded stderr diagnostics and marks truncation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-stream-"));
  const runner = new NodePiProcessRunner({ maxStderrBytes: 8 });
  const result = await runner.run(process.execPath, ["-e", "process.stderr.write('0123456789'); process.exit(3)"], { cwd: dir, input: "", timeoutMs: 1_000 });
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /\[stderr truncated; showing last 8 bytes\]/);
  assert.ok(result.stderr.length < 128);
});

test("reports spawn errors as normal rejections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-stream-"));
  await assert.rejects(new NodePiProcessRunner().run(join(dir, "missing-pi"), [], { cwd: dir, input: "", timeoutMs: 1_000 }), /ENOENT/);
});

test("terminates a timed out child and reports the timeout state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-stream-"));
  const result = await new NodePiProcessRunner().run(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { cwd: dir, input: "", timeoutMs: 20 });
  assert.equal(result.timedOut, true);
});

test("reports Pi timeout and preserves malformed JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-adapter-"));
  assert.deepEqual(parseJsonLines("oops\n")[0], { type: "unparsed", raw: "oops" });
  const adapter = new PiProcessAdapter({ run: async () => ({ exitCode: null, stderr: "tail [stderr truncated; showing last 8 bytes]", timedOut: true, stdout: "" }) });
  await assert.rejects(adapter.run({ role: "implementer", taskId: "x", prompt: "do", artifacts: {}, cwd: dir, sessionDir: join(dir, "session"), model: { model: "openai-codex/gpt-5.6-luna", reasoning: "low" } }), /timed out.*stderr truncated/);
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

test("neither the result nor the disk keeps the raw event payload", async () => {
  // 迴歸守門一：events 曾經同時存在檔案與 result 內，orchestrator 把 result 寫進 ledger
  // 時造成同一份資料存兩次。實測一次 run 佔 527 MB，其中單一 implementer 的 JSON 有
  // 100% 是重複的 events。
  // 迴歸守門二：落地的 trace 只留骨架。原始 stdout 的 message_update 是累積快照而非
  // delta，保存整份會隨模型輸出長度呈平方成長（實測單一 implementer 315 MB）。
  const bulky = Array.from({ length: 200 }, (_, index) => JSON.stringify({ type: "tool", payload: "x".repeat(500), index })).join("\n");
  const snapshots = Array.from({ length: 50 }, (_, index) => JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(index * 100) }] } })).join("\n");
  const stdout = `${bulky}\n${snapshots}\n${JSON.stringify({ type: "message_end", text: "VERDICT: pass" })}\n`;
  const dir = await mkdtemp(join(tmpdir(), "adapter-events-"));
  const piSessionLog = join(dir, "2026-08-09T16-28-43-991Z_019fe75a-ee57-7acf-b1a0-07db35dc472a.jsonl");
  await writeFile(piSessionLog, "pi writes its own transcript here\n");
  const runner: PiProcessRunner = { run: async () => ({ stdout, stderr: "", exitCode: 0, timedOut: false }) };

  const result = await new PiProcessAdapter(runner).run({ role: "reviewer", taskId: "x", prompt: "review", artifacts: {}, cwd: dir, sessionDir: dir, model: { model: "openai-codex/gpt-5.6-terra", reasoning: "medium" } });

  assert.equal((result as unknown as Record<string, unknown>).events, undefined, "raw events must never travel back in the result");
  assert.ok(JSON.stringify(result).length < 2_000, `the ledger payload must stay small, got ${JSON.stringify(result).length}`);
  assert.equal(result.sessionMetadata?.tracePath, join(dir, "trace.jsonl"), "the pointer must name the artifact that actually exists");

  const trace = await readFile(join(dir, "trace.jsonl"), "utf8");
  assert.ok(!trace.includes("message_update"), "accumulated snapshots are the whole reason the ledger exploded");
  assert.ok(!trace.includes("x".repeat(300)), "content is not retained, only structure");
  assert.ok(trace.length < stdout.length / 4, `expected a large reduction, got ${stdout.length} → ${trace.length}`);
  assert.ok(!existsSync(piSessionLog), "Pi's own transcript duplicates the trace and is removed with it");
  assert.ok(!existsSync(join(dir, "events.jsonl")), "the raw stream is never written in the first place");

  assert.equal(result.verdict, "pass", "the summary and verdict are still derived from the in-memory events");
});
