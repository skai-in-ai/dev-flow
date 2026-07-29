import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { excludeLedger, formatTests, Orchestrator } from "../orchestrator.js";
import type { AgentRunner, AgentRunRequest, AgentRunResult } from "../agents/contracts.js";
import type { CommandRunner, TestResult } from "../test-runner.js";

const exec = promisify(execFile);
async function repo(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "orch-repo-")); await exec("git", ["init"], { cwd: dir }); await exec("git", ["config", "user.email", "test@example.com"], { cwd: dir }); await exec("git", ["config", "user.name", "Test"], { cwd: dir }); await writeFile(join(dir, "a.ts"), "export const a = 1;\n"); await exec("git", ["add", "."], { cwd: dir }); await exec("git", ["commit", "-m", "base"], { cwd: dir }); return dir; }
class FakeAgents implements AgentRunner { calls: AgentRunRequest[] = []; constructor(private readonly answers: AgentRunResult[]) {} async run(request: AgentRunRequest): Promise<AgentRunResult> { this.calls.push(request); return this.answers.shift() ?? { summary: "VERDICT: pass", verdict: "pass" }; } }
class PassingTests implements CommandRunner { async run(command: string): Promise<TestResult> { return { command, passed: true, output: "ok", exitCode: 0 }; } }
const handoff = (path: string) => ({ repo: path, objective: "normal change", scope: { include: ["a.ts"] }, acceptanceCriteria: ["works"], constraints: [], tests: ["true"], riskNotes: [], delivery: { mode: "direct_main" as const, requireApproval: true } });

test("review escalation upgrades checks without re-running implementation or consuming a round", async () => {
  const path = await repo(); const agents = new FakeAgents([{ summary: "implemented" }, { summary: "VERDICT: escalate", verdict: "escalate" }, { summary: "VERDICT: pass", verdict: "pass" }, { summary: "VERDICT: pass", verdict: "pass" }]);
  const outcome = await new Orchestrator({ agents, tests: new PassingTests() }).run(handoff(path), () => {});
  assert.equal(outcome.status, "ready_for_main"); assert.equal(outcome.rounds, 1); assert.equal(agents.calls.filter((x) => x.role === "implementer").length, 1); assert.equal(agents.calls[2]?.model.model, "openai-codex/gpt-5.6-terra");
});
test("three review failures require a human", async () => {
  const path = await repo(); const agents = new FakeAgents([{ summary: "impl" }, { summary: "bad", verdict: "fail" }, { summary: "impl" }, { summary: "bad", verdict: "fail" }, { summary: "impl" }, { summary: "bad", verdict: "fail" }]);
  const outcome = await new Orchestrator({ agents, tests: new PassingTests() }).run(handoff(path), () => {});
  assert.equal(outcome.status, "needs_human"); assert.equal(outcome.rounds, 3); assert.equal(agents.calls.filter((x) => x.role === "implementer").length, 3);
});

test("makes missing deterministic tests visible in progress and review artifacts", async () => {
  const path = await repo();
  const agents = new FakeAgents([{ summary: "impl" }, { summary: "VERDICT: pass", verdict: "pass" }, { summary: "VERDICT: pass", verdict: "pass" }]);
  const progress: string[] = [];
  await new Orchestrator({ agents, tests: new PassingTests() }).run({ ...handoff(path), tests: [] }, (line) => progress.push(line));
  assert.equal(progress.some((line) => line.includes("no deterministic commands configured")), true);
  assert.equal(agents.calls.find((call) => call.role === "reviewer")?.artifacts.tests, "NO DETERMINISTIC TESTS CONFIGURED");
  assert.equal(formatTests([]), "NO DETERMINISTIC TESTS CONFIGURED");
});

test("stores the ledger exclusion through git's worktree-aware path", async () => {
  const path = await repo();
  const workspace = await mkdtemp(join(tmpdir(), "orch-worktree-"));
  const worktree = join(workspace, "linked");
  await exec("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: path });
  await excludeLedger(worktree);
  const excludePath = (await exec("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: worktree })).stdout.trim();
  const contents = await readFile(resolve(worktree, excludePath), "utf8");
  assert.equal(contents.split("\n").filter((line) => line === ".orchestrator/").length, 1);
  await excludeLedger(worktree);
  const repeated = await readFile(resolve(worktree, excludePath), "utf8");
  assert.equal(repeated.split("\n").filter((line) => line === ".orchestrator/").length, 1);
});
