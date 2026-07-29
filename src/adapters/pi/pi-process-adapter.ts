import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentRunRequest, AgentRunResult, AgentRunner } from "../../agents/contracts.js";

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
  constructor(private readonly runner: PiProcessRunner = new NodePiProcessRunner(), private readonly piCommand = "pi") {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    await mkdir(request.sessionDir, { recursive: true });
    const prompt = renderPrompt(request);
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
    return { summary: assistant, verdict: review.verdict, findings: review.findings, events, usage: lastUsage(events), sessionMetadata: { sessionDir: request.sessionDir, model: request.model.model, reasoning: request.model.reasoning } };
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
export function parseReview(text: string): { verdict?: "pass" | "fail" | "escalate"; findings: string[] } {
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
function normalizeVerdict(value: unknown): "pass" | "fail" | "escalate" | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "pass": case "approve": case "approved": return "pass";
    case "fail": case "reject": case "rejected": return "fail";
    case "escalate": case "escalated": return "escalate";
    default: return undefined;
  }
}
export function renderPrompt(request: AgentRunRequest): string {
  const artifacts = Object.entries(request.artifacts).map(([name, body]) => `## ${name}\n${body}`).join("\n\n");
  const reviewInstruction = request.role === "reviewer" || request.role === "final_reviewer"
    ? "Do not edit files. You may list concise findings, then end with exactly one standalone line: VERDICT: pass, VERDICT: fail, or VERDICT: escalate."
    : request.role === "router"
      ? "Return one JSON object only. Do not edit files."
      : "Implement the task, run only safe local checks, and summarize changed files.";
  return `${request.prompt}\n\n${reviewInstruction}\nNever run git commit, git push, git reset, git checkout, or mutate main.\n\nArtifacts:\n${artifacts}`;
}
function toolsFor(role: AgentRunRequest["role"]): string {
  if (role === "router") return "";
  if (role === "reviewer" || role === "final_reviewer") return "read,grep,find,ls";
  return "read,write,edit,bash,grep,find,ls";
}
