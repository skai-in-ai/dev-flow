import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentRunRequest, AgentRunResult, AgentRunner, ReviewVerdict } from "../../agents/contracts.js";
import { DEFAULT_PROMPT_BUDGET, applyBudget, type PromptBudget } from "../../prompt-budget.js";

export interface SpawnedProcess { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; }
export interface PiProcessRunner { run(command: string, args: string[], options: { cwd: string; input: string; timeoutMs: number }): Promise<SpawnedProcess>; }

export class NodePiProcessRunner implements PiProcessRunner {
  async run(command: string, args: string[], options: { cwd: string; input: string; timeoutMs: number }): Promise<SpawnedProcess> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(command, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "", timedOut = false;
      child.stdout.on("data", (x) => { stdout += x; }); child.stderr.on("data", (x) => { stderr += x; });
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (exitCode) => { clearTimeout(timer); resolveResult({ stdout, stderr, exitCode, timedOut }); });
      child.stdin.end(options.input);
    });
  }
}

/** Runs a fresh Pi JSON process per role. No session is ever shared between roles. */
export class PiProcessAdapter implements AgentRunner {
  constructor(private readonly runner: PiProcessRunner = new NodePiProcessRunner(), private readonly piCommand = "pi", private readonly budget: PromptBudget = DEFAULT_PROMPT_BUDGET) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    await mkdir(request.sessionDir, { recursive: true });
    // request.json 寫入的 artifacts 是未截斷的原件，只有 prompt 受預算限制，
    // 這樣事後仍能查出 agent 當時實際看到的內容與完整素材的差異。
    const prompt = renderPrompt(request, this.budget);
    await writeFile(join(request.sessionDir, "request.json"), JSON.stringify({ ...request, prompt }, null, 2));
    const args = ["--mode", "json", "--model", request.model.model, "--thinking", request.model.reasoning, "--session-dir", request.sessionDir, "--no-extensions"];
    const tools = toolsFor(request.role);
    if (request.role === "router") args.push("--no-tools");
    else if (tools) args.push("--tools", tools);
    args.push(prompt);
    const result = await this.runner.run(this.piCommand, args, { cwd: request.cwd, input: "", timeoutMs: request.timeoutMs ?? 15 * 60_000 });
    await writeFile(join(request.sessionDir, "events.jsonl"), result.stdout);
    if (result.timedOut) throw new Error(`Pi ${request.role} timed out`);
    if (result.exitCode !== 0) throw new Error(`Pi ${request.role} exited ${result.exitCode}: ${result.stderr}`);
    const events = parseJsonLines(result.stdout);
    const assistant = lastAssistantText(events);
    const review = parseReview(assistant);
    return { summary: assistant, verdict: review.verdict, findings: review.findings, usage: lastUsage(events), sessionMetadata: { sessionDir: request.sessionDir, eventsPath: join(request.sessionDir, "events.jsonl"), model: request.model.model, reasoning: request.model.reasoning } };
  }
}

export function parseJsonLines(text: string): unknown[] {
  return text.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) as unknown; } catch { return { type: "unparsed", raw: line }; } });
}
export function lastAssistantText(events: unknown[]): string {
  const texts: string[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const e = event as Record<string, unknown>;
    const candidate = e.text ?? (e.message && typeof e.message === "object" ? (e.message as Record<string, unknown>).content : undefined);
    if (e.type === "message_end" || e.type === "assistant" || e.type === "message" || e.role === "assistant") {
      if (typeof candidate === "string") texts.push(candidate);
      else if (Array.isArray(candidate)) texts.push(candidate.filter((b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "text").map((b) => String((b as Record<string, unknown>).text ?? "")).join(""));
    }
  }
  return texts.at(-1) ?? "";
}
function lastUsage(events: unknown[]): Record<string, unknown> | undefined {
  for (const event of [...events].reverse()) if (event && typeof event === "object") { const e = event as { usage?: Record<string, unknown>; message?: { usage?: Record<string, unknown> } }; if (e.usage) return e.usage; if (e.message?.usage) return e.message.usage; }
  return undefined;
}
export function parseReview(text: string): { verdict?: ReviewVerdict; findings: string[] } {
  const json = parseReviewJson(text);
  const rawVerdict = /VERDICT:\s*([a-z_ -]+)/i.exec(text)?.[1] ?? json?.verdict;
  const findings = json?.findings?.filter((finding): finding is string => typeof finding === "string")
    ?? text.split("\n").filter((line) => /^[-*]\s+/.test(line)).map((line) => line.replace(/^[-*]\s+/, ""));
  return { verdict: normalizeVerdict(rawVerdict), findings };
}
function parseReviewJson(text: string): { verdict?: unknown; findings?: unknown[] } | undefined {
  const candidates = [
    ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]),
    text.trim(),
  ];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as { verdict?: unknown; findings?: unknown[] };
    } catch { /* A prose review may still contain a VERDICT line. */ }
  }
  const verdict = /["']verdict["']\s*:\s*["']([^"']+)["']/i.exec(text)?.[1];
  return verdict ? { verdict } : undefined;
}
function normalizeVerdict(value: unknown): ReviewVerdict | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase().replace(/[\s-]+/g, "_")) {
    case "pass": case "approve": case "approved": return "pass";
    case "fail": case "reject": case "rejected": return "fail";
    case "escalate": case "escalated": return "escalate";
    case "needs_spec": case "spec_gap": case "needs_clarification": return "needs_spec";
    default: return undefined;
  }
}
export function renderPrompt(request: AgentRunRequest, budget: PromptBudget = DEFAULT_PROMPT_BUDGET): string {
  const artifacts = Object.entries(applyBudget(request.artifacts, budget)).map(([name, body]) => `## ${name}\n${body}`).join("\n\n");
  const reviewInstruction = request.role === "reviewer" || request.role === "final_reviewer"
    ? reviewerInstruction()
    : request.role === "router"
      ? "Return one JSON object only. Do not edit files."
      : implementerInstruction();
  return `${request.prompt}\n\n${reviewInstruction}\nNever run git commit, git push, git reset, git checkout, or mutate main.\n\nArtifacts:\n${artifacts}`;
}
/**
 * reviewer 指示。`needs_spec` 是給「缺陷不在實作，而在 handoff 沒定義的產品語意」用的，
 * 因為重試對這種缺陷沒有意義。強制附上缺口描述與至少兩個候選答案，是為了讓停下來變成
 * 一道選擇題而非一場討論；`orchestrator.ts` 端會驗證數量，不足者降級為 fail。
 */
export function reviewerInstruction(): string {
  return [
    "Do not edit files. You may list concise findings, then end with exactly one standalone line: VERDICT: pass, VERDICT: fail, VERDICT: escalate, or VERDICT: needs_spec.",
    "Use the handoff's declared invariantsAndNonGoals as a boundary: respect explicit non-goals and preserve declared invariants.",
    "Batch same-category sibling findings in one review round, but check only reasonable, reachable approved paths; do not require every theoretical sibling case.",
    "Use VERDICT: needs_spec only when the correct behavior is undefined in the handoff, such that any implementation choice could be wrong. It is not a substitute for fail.",
    "When you answer needs_spec, your findings must contain at least three entries: the first states exactly which semantic is undefined, and the rest are concrete candidate answers for what it should do (at least two)."
  ].join(" ");
}
/**
 * implementer 指示分三段：
 * 1. 原有指示。
 * 2. scope 硬性條款，每輪都套用。這是目前唯一的範圍漂移防線（偵測面的 scope judge
 *    尚未實作），措辭用 "unrelated to the requested change" 而非「不在 scope.include 內」，
 *    以保留合理修正擴散的判斷空間。
 * 3. 增量修正與逐條回應，只在 decision_log 有歷史時才有意義。
 */
export function implementerInstruction(): string {
  return [
    "Implement the task, run only safe local checks, and summarize changed files.",
    "Do only what the handoff and the listed findings require. Do not refactor, do not reformat, and do not touch files unrelated to the requested change.",
    "Read the handoff's invariantsAndNonGoals before changing behavior; respect explicit non-goals and preserve declared invariants.",
    "When addressing a finding, inspect reasonable sibling cases in the same reachable invariant category and add regression tests for the relevant cases; do not attempt every theoretical sibling.",
    "If the decision_log artifact contains prior rounds: this is an incremental fix, not a rewrite. Do not rewrite the existing implementation. Respond to every prior finding explicitly, stating either what you changed to address it or why you intentionally left it unchanged.",
  ].join(" ");
}

function toolsFor(role: AgentRunRequest["role"]): string {
  if (role === "router") return "";
  if (role === "reviewer" || role === "final_reviewer") return "read,grep,find,ls";
  return "read,write,edit,bash,grep,find,ls";
}
