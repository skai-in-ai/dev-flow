import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyTierCap, excludeLedger, formatTests, meaningfulStatus, Orchestrator } from "../orchestrator.js";
import type { AgentRunner, AgentRunRequest, AgentRunResult } from "../agents/contracts.js";
import type { CommandRunner, TestResult } from "../test-runner.js";

const exec = promisify(execFile);
async function repo(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "orch-repo-")); await exec("git", ["init"], { cwd: dir }); await exec("git", ["config", "user.email", "test@example.com"], { cwd: dir }); await exec("git", ["config", "user.name", "Test"], { cwd: dir }); await writeFile(join(dir, "a.ts"), "export const a = 1;\n"); await exec("git", ["add", "."], { cwd: dir }); await exec("git", ["commit", "-m", "base"], { cwd: dir }); return dir; }
class FakeAgents implements AgentRunner { calls: AgentRunRequest[] = []; constructor(protected readonly answers: AgentRunResult[]) {} async run(request: AgentRunRequest): Promise<AgentRunResult> { this.calls.push(request); return this.answers.shift() ?? { summary: "VERDICT: pass", verdict: "pass" }; } }
class PassingTests implements CommandRunner { async run(command: string): Promise<TestResult> { return { command, passed: true, output: "ok", exitCode: 0 }; } }
async function latestRun(path: string): Promise<string> { const runs = await readdir(join(path, ".orchestrator", "runs")); return runs.sort().at(-1)!; }
const handoff = (path: string) => ({ repo: path, objective: "normal change", scope: { include: ["a.ts"] }, acceptanceCriteria: ["works"], constraints: [], tests: ["true"], riskNotes: [], delivery: { mode: "direct_main" as const, requireApproval: true } });

test("review escalation upgrades checks without re-running implementation or consuming a round", async () => {
  const path = await repo(); const agents = new FakeAgents([{ summary: "implemented" }, { summary: "VERDICT: escalate", verdict: "escalate" }, { summary: "VERDICT: pass", verdict: "pass" }, { summary: "VERDICT: pass", verdict: "pass" }]);
  const outcome = await new Orchestrator({ agents, tests: new PassingTests() }).run(handoff(path), () => {});
  assert.equal(outcome.status, "ready_for_main"); assert.equal(outcome.cycles, 1); assert.equal(agents.calls.filter((x) => x.role === "implementer").length, 1); assert.deepEqual(agents.calls[2]?.model, { model: "openai-codex/gpt-5.6-terra", reasoning: "medium" });
});
test("max-tier cap clamps high-risk routing and blocks reviewer escalation without silently passing", async () => {
  const path = await repo();
  const agents = new FakeAgents([{ summary: "implemented" }, { summary: "needs stronger review", verdict: "escalate" }]);
  const outcome = await new Orchestrator({ agents, tests: new PassingTests() }).run(
    { ...handoff(path), objective: "add database schema migration" },
    () => {},
    { maxTier: 1 },
  );
  assert.equal(outcome.status, "needs_human");
  assert.equal(outcome.tier, 1);
  assert.match(outcome.routing.reasons.join("\n"), /max-tier cap applied: 1/);
  assert.deepEqual(agents.calls.map((call) => call.role), ["implementer", "reviewer"]);
});

test("applyTierCap leaves uncapped routing unchanged", () => {
  const routing = { tier: 2 as const, confidence: 0.9, reasons: ["risk"], riskFlags: ["db"] };
  assert.equal(applyTierCap(routing, undefined), routing);
  assert.equal(applyTierCap(routing, 1).tier, 1);
});
test("the last fix is reviewed before a human is asked for", async () => {
  const path = await repo(); const agents = new FakeAgents([{ summary: "impl" }, { summary: "bad 1", verdict: "fail" }, { summary: "impl" }, { summary: "bad 2", verdict: "fail" }, { summary: "impl" }, { summary: "bad 3", verdict: "fail" }, { summary: "impl" }, { summary: "bad 4", verdict: "fail" }]);
  const outcome = await new Orchestrator({ agents, tests: new PassingTests() }).run(handoff(path), () => {});
  assert.equal(outcome.status, "needs_human"); assert.equal(outcome.cycles, 4); assert.equal(agents.calls.filter((x) => x.role === "implementer").length, 4);
});

test("carries every prior cycle's findings and responses into the later reviewer's artifacts", async () => {
  const path = await repo();
  const agents = new FakeAgents([
    { summary: "impl one" }, { summary: "round one verdict", verdict: "fail", findings: ["SecureStore error is swallowed"] },
    { summary: "impl two: fixed storage, left session alone" }, { summary: "round two verdict", verdict: "fail", findings: ["runtime must log out regardless"] },
    { summary: "impl three" }, { summary: "round three verdict", verdict: "fail", findings: ["startup still loads a stale token"] },
    { summary: "impl four" }, { summary: "round four verdict", verdict: "fail", findings: ["still not covered"] },
  ]);
  await new Orchestrator({ agents, tests: new PassingTests() }).run(handoff(path), () => {});

  const reviewers = agents.calls.filter((call) => call.role === "reviewer");
  const thirdReviewerLog = reviewers[2]?.artifacts.decision_log ?? "";
  assert.match(thirdReviewerLog, /SecureStore error is swallowed/, "the later reviewer must see the cycle 1 finding");
  assert.match(thirdReviewerLog, /runtime must log out regardless/, "the later reviewer must see the cycle 2 finding");
  assert.match(thirdReviewerLog, /impl two: fixed storage, left session alone/, "the later reviewer must see how the implementer responded");

  assert.match(reviewers[0]?.artifacts.decision_log ?? "", /NO PRIOR ROUNDS/, "the first reviewer has no history to show");

  const implementers = agents.calls.filter((call) => call.role === "implementer");
  assert.match(implementers[3]?.artifacts.decision_log ?? "", /SecureStore error is swallowed/, "the last fixing implementer must still see the very first finding");

  const decisions = JSON.parse(await readFile(join(path, ".orchestrator", "runs", await latestRun(path), "decisions.json"), "utf8")) as { findings: unknown[]; responses: unknown[] };
  assert.equal(decisions.findings.length, 4, "every failed cycle contributes a finding to the ledger");
  assert.equal(decisions.responses.length, 3, "each fixing implementer records a response to the cycle it answered");
});

test("records failing test output in the decision log so the next reviewer sees it", async () => {
  const path = await repo();
  class OneFailingRun implements CommandRunner {
    private calls = 0;
    // 第 1 次是 baseline 預檢（必須過，否則流程會拒絕啟動），第 2 次才是 cycle 1 的失敗。
    async run(command: string): Promise<TestResult> { this.calls += 1; const passed = this.calls !== 2; return { command, passed, output: passed ? "ok" : "AssertionError: expected 2", exitCode: passed ? 0 : 1 }; }
  }
  const agents = new FakeAgents([{ summary: "impl one" }, { summary: "impl two" }, { summary: "VERDICT: pass", verdict: "pass" }]);
  await new Orchestrator({ agents, tests: new OneFailingRun() }).run(handoff(path), () => {});

  assert.match(agents.calls.find((call) => call.role === "reviewer")?.artifacts.decision_log ?? "", /AssertionError: expected 2/);
  assert.match(agents.calls.find((call) => call.role === "reviewer")?.artifacts.decision_log ?? "", /\[tests · deterministic\]/);
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

test("tier 1 finishes after the isolated Luna review without a fixed Sol gate", async () => {
  const path = await repo();
  const agents = new FakeAgents([{ summary: "impl" }, { summary: "VERDICT: pass", verdict: "pass" }]);
  const outcome = await new Orchestrator({ agents, tests: new PassingTests() }).run(handoff(path), () => {});
  assert.equal(outcome.status, "ready_for_main");
  assert.deepEqual(agents.calls.map((call) => call.role), ["implementer", "reviewer"]);
  assert.deepEqual(agents.calls[0]?.model, { model: "openai-codex/gpt-5.6-luna", reasoning: "medium" }, "first implementation stays on Luna Medium");
  assert.equal(agents.calls[0]?.timeoutMs, 25 * 60_000, "implementers get enough wall time for edits and deterministic tests");
  assert.deepEqual(agents.calls[1]?.model, { model: "openai-codex/gpt-5.6-luna", reasoning: "high" });
});

test("a failed tier 2 cycle retries implementation with Luna High, not Terra", async () => {
  const path = await repo();
  const highRisk = { ...handoff(path), objective: "add database migration" };
  const agents = new FakeAgents([
    { summary: "Luna impl" }, { summary: "bad", verdict: "fail" },
    { summary: "Terra impl" }, { summary: "pass", verdict: "pass" }, { summary: "pass", verdict: "pass" },
  ]);
  const outcome = await new Orchestrator({ agents, tests: new PassingTests() }).run(highRisk, () => {});
  assert.equal(outcome.status, "ready_for_main");
  const implementers = agents.calls.filter((call) => call.role === "implementer");
  assert.deepEqual(implementers.map((call) => call.model), [
    { model: "openai-codex/gpt-5.6-luna", reasoning: "medium" },
    { model: "openai-codex/gpt-5.6-luna", reasoning: "high" },
  ], "the expensive implementer is reserved until Luna has failed twice");
  assert.deepEqual(agents.calls.filter((call) => call.role === "reviewer").map((call) => call.model), [
    { model: "openai-codex/gpt-5.6-terra", reasoning: "medium" },
    { model: "openai-codex/gpt-5.6-terra", reasoning: "medium" },
  ]);
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

test("an untracked approved spec neither blocks preflight nor enters review diff", async () => {
  const path = await repo();
  await mkdir(join(path, ".agent/specs"), { recursive: true });
  await writeFile(join(path, ".agent/specs/task.md"), "---\nstatus: approved\n---\n");
  const agents = new FakeAgents([{ summary: "impl" }, { summary: "VERDICT: pass", verdict: "pass" }, { summary: "VERDICT: pass", verdict: "pass" }]);
  const outcome = await new Orchestrator({ agents, tests: new PassingTests() }).run(handoff(path), () => {});
  assert.equal(outcome.status, "ready_for_main");
  const reviewer = agents.calls.find((call) => call.role === "reviewer");
  assert.equal(reviewer?.artifacts.diff.includes("task.md"), false);
  const status = await exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: path });
  assert.deepEqual(meaningfulStatus(status.stdout), []);
});

test("an undefined product semantic returns to discussion without consuming a round", async () => {
  const path = await repo();
  const agents = new FakeAgents([
    { summary: "impl" },
    { summary: "VERDICT: needs_spec", verdict: "needs_spec", findings: [
      "刪帳號後 SecureStore 清除失敗時，下次啟動是否視為已登出，handoff 未定義",
      "只要有 token 就視為已登入，靠 backend 回 401 才登出",
      "啟動一定先驗 session，驗不過就清 token",
    ] },
  ]);
  const outcome = await new Orchestrator({ agents, tests: new PassingTests() }).run(handoff(path), () => {});

  assert.equal(outcome.status, "needs_human");
  assert.equal(outcome.cycles, 1, "a spec gap must not consume a cycle");
  assert.equal(agents.calls.filter((call) => call.role === "implementer").length, 1, "no retry may be attempted");
  assert.equal(outcome.specGap?.candidates.length, 2);
  assert.match(outcome.specGap?.semantic ?? "", /未定義/);

  const summary = await readFile(join(path, ".orchestrator", "runs", await latestRun(path), "summary.md"), "utf8");
  assert.match(summary, /## 缺的語意/);
  assert.match(summary, /啟動一定先驗 session/);
});

test("needs_spec without candidate answers degrades to an ordinary failure", async () => {
  const path = await repo();
  const agents = new FakeAgents([
    { summary: "impl" }, { summary: "VERDICT: needs_spec", verdict: "needs_spec", findings: ["something is unclear"] },
    { summary: "impl" }, { summary: "VERDICT: pass", verdict: "pass" },
  ]);
  const outcome = await new Orchestrator({ agents, tests: new PassingTests() }).run(handoff(path), () => {});

  assert.equal(outcome.status, "ready_for_main", "an unusable needs_spec must fall back to the retry path");
  assert.equal(outcome.cycles, 2, "the degraded verdict consumes a cycle like any other failure");
  assert.equal(outcome.specGap, undefined);
});

test("an escalation at the highest tier defers to Sol instead of burning a cycle", async () => {
  const path = await repo();
  const highRisk = { ...handoff(path), objective: "add database migration" };
  const agents = new FakeAgents([
    { summary: "impl" },
    { summary: "beyond my judgement", verdict: "escalate" },
    { summary: "VERDICT: pass", verdict: "pass" },
  ]);
  const outcome = await new Orchestrator({ agents, tests: new PassingTests() }).run(highRisk, () => {});

  assert.equal(outcome.status, "ready_for_main");
  assert.equal(outcome.cycles, 1, "handing the decision to Sol must not consume a cycle");
  assert.equal(agents.calls.filter((call) => call.role === "implementer").length, 1, "no reimplementation may be triggered");
  assert.deepEqual(agents.calls.map((call) => call.role), ["implementer", "reviewer", "final_reviewer"]);
});

test("the final fix is reviewed by every required gate before a human is asked", async () => {
  const path = await repo();
  const highRisk = { ...handoff(path), objective: "add database migration" };
  const agents = new FakeAgents([
    { summary: "impl 1" }, { summary: "no 1", verdict: "fail" },
    { summary: "impl 2" }, { summary: "no 2", verdict: "fail" },
    { summary: "impl 3" }, { summary: "no 3", verdict: "fail" },
    { summary: "impl 4" }, { summary: "VERDICT: pass", verdict: "pass" }, { summary: "still no", verdict: "fail" },
  ]);
  const outcome = await new Orchestrator({ agents, tests: new PassingTests() }).run(highRisk, () => {});

  assert.equal(outcome.status, "needs_human");
  assert.equal(outcome.cycles, 4);
  assert.equal(outcome.maxCycles, 4);
  assert.equal(agents.calls.filter((call) => call.role === "final_reviewer").length, 1, "the last fix must still reach the Sol gate");
});

test("a repo may shorten the fix budget", async () => {
  const path = await repo();
  const agents = new FakeAgents([{ summary: "impl" }, { summary: "no", verdict: "fail" }]);
  const outcome = await new Orchestrator({ agents, tests: new PassingTests(), config: { maxFixCycles: 0 } }).run(handoff(path), () => {});

  assert.equal(outcome.status, "needs_human");
  assert.equal(outcome.maxCycles, 1);
  assert.equal(agents.calls.filter((call) => call.role === "implementer").length, 1, "no fix may be attempted when the budget is zero");
});

test("captures what cannot be recovered later: spec snapshot, diff, router session and an index row", async () => {
  const path = await repo();
  // spec 會被流程就地改寫，執行當下的原文若不快照就永遠補不回來。
  const specMarkdown = "---\nstatus: approved\n---\n\n# 當下的規格";
  const routerCalls: string[] = [];
  const classifier = { classify: async ({ sessionDir }: { sessionDir: string }) => { routerCalls.push(sessionDir); return { costUsd: 0.001 }; } };
  // implementer 必須真的改檔案，否則 diff 是空的，測不出「diff 有被完整寫下」。
  class WritingAgents extends FakeAgents {
    private edits = 0;
    override async run(request: AgentRunRequest): Promise<AgentRunResult> {
      if (request.role === "implementer") { this.edits += 1; await writeFile(join(request.cwd, "a.ts"), `export const a = ${this.edits + 1};\n`); }
      return super.run(request);
    }
  }
  const agents = new WritingAgents([
    { summary: "impl", usage: { cost: { total: 0.002 } } },
    { summary: "no", verdict: "fail", usage: { cost: { total: 0.05 } } },
    { summary: "impl 2", usage: { cost: { total: 0.003 } } },
    { summary: "VERDICT: pass", verdict: "pass", usage: { cost: { total: 0.015 } } },
  ]);
  const outcome = await new Orchestrator({ agents, tests: new PassingTests(), classifier }).run(
    handoff(path), () => {}, { specPath: "/somewhere/task.md", specTitle: "當下的規格", specMarkdown },
  );

  const root = join(path, ".orchestrator", "runs", await latestRun(path));
  assert.equal(await readFile(join(root, "spec.md"), "utf8"), specMarkdown, "the spec as executed must be snapshotted");
  assert.ok((await readFile(join(root, "cycle-1.diff"), "utf8")).includes("a.ts"), "each cycle's diff must be a first-class file");
  await readFile(join(root, "cycle-2.diff"), "utf8");

  // router session 必須落在該次 run 底下，否則事後對不回是哪一次 run。
  assert.equal(routerCalls.length, 3, "one initial routing plus one per cycle");
  for (const dir of routerCalls) assert.ok(dir.startsWith(root), `router session must live under the run, got ${dir}`);

  assert.equal(outcome.cost.byRole.implementer, 0.005);
  assert.equal(outcome.cost.byRole.reviewer, 0.065);
  assert.equal(outcome.cost.byRole.router, 0.003);
  assert.equal(outcome.cost.total, 0.073);
  assert.ok(typeof outcome.durationMs === "number");
  assert.equal(outcome.verification.reviewerVerdict, "pass");
  assert.ok(outcome.verification.tests.every((test) => test.passed));

  const index = (await readFile(join(path, ".orchestrator", "index.jsonl"), "utf8")).trim().split("\n");
  const row = JSON.parse(index.at(-1)!) as Record<string, unknown>;
  assert.equal(row.runId, outcome.runId);
  assert.equal(row.status, "ready_for_main");
  assert.equal(row.specTitle, "當下的規格");
  assert.deepEqual(row.cost, outcome.cost);
  assert.ok(typeof row.durationMs === "number");
});

test("the index accumulates one row per run and stays outside runs/", async () => {
  const path = await repo();
  for (let i = 0; i < 2; i += 1) {
    const agents = new FakeAgents([{ summary: "impl" }, { summary: "VERDICT: pass", verdict: "pass" }]);
    await new Orchestrator({ agents, tests: new PassingTests() }).run(handoff(path), () => {});
    await exec("git", ["stash", "-u"], { cwd: path }).catch(() => undefined);
  }

  const index = (await readFile(join(path, ".orchestrator", "index.jsonl"), "utf8")).trim().split("\n");
  assert.equal(index.length, 2, "每次 run append 一行，不覆寫");
  // runs/ 只能有 run 目錄，讀取端才能直接 readdir 而不必過濾出檔案。
  const entries = await readdir(join(path, ".orchestrator", "runs"));
  assert.ok(entries.every((entry) => !entry.endsWith(".jsonl")), "the index must not sit among the run directories");
});

test("stops as soon as a failure repeats verbatim instead of burning the remaining cycles", async () => {
  const path = await repo();
  // 實測案例：`Failed to spawn: pytest` 連續四個 cycle 逐字元相同，四次實作全部白費。
  class MissingBinary implements CommandRunner {
    private calls = 0;
    async run(command: string): Promise<TestResult> {
      this.calls += 1;
      const passed = this.calls === 1; // 預檢過，之後每次都是同一個錯誤
      return { command, passed, output: passed ? "ok" : "Failed to spawn: `pytest`\n  No such file or directory", exitCode: passed ? 0 : 1 };
    }
  }
  const agents = new FakeAgents([]);
  const outcome = await new Orchestrator({ agents, tests: new MissingBinary() }).run(handoff(path), () => {});

  assert.equal(outcome.status, "needs_human");
  assert.equal(outcome.cycles, 2, "the identical second failure must end the run, not continue to cycle 4");
  assert.equal(agents.calls.filter((call) => call.role === "implementer").length, 2);
  const summary = await readFile(join(path, ".orchestrator", "runs", await latestRun(path), "summary.md"), "utf8");
  assert.match(summary, /identical failure repeated/);
});

test("refuses to spend anything when the tests already fail on an untouched baseline", async () => {
  const path = await repo();
  class BrokenEnvironment implements CommandRunner {
    async run(command: string): Promise<TestResult> { return { command, passed: false, output: "Failed to spawn: `pytest`", exitCode: 1 }; }
  }
  const agents = new FakeAgents([]);
  const outcome = await new Orchestrator({ agents, tests: new BrokenEnvironment() }).run(handoff(path), () => {});

  assert.equal(outcome.status, "needs_human");
  assert.equal(outcome.cost.total, 0, "not a single model call may be paid for");
  assert.equal(agents.calls.length, 0, "no agent may be started, not even the router");
  const summary = await readFile(join(path, ".orchestrator", "runs", await latestRun(path), "summary.md"), "utf8");
  assert.match(summary, /preflight failed on a clean tree/);
});

test("a crash is recorded as a failed run instead of vanishing", async () => {
  const path = await repo();
  class ExplodingAgents implements AgentRunner {
    calls: AgentRunRequest[] = [];
    async run(request: AgentRunRequest): Promise<AgentRunResult> {
      this.calls.push(request);
      throw new Error("Pi implementer exited 1: connection reset by peer");
    }
  }
  const agents = new ExplodingAgents();
  await assert.rejects(new Orchestrator({ agents, tests: new PassingTests() }).run(handoff(path), () => {}), /connection reset by peer/);

  const dir = join(path, ".orchestrator", "runs", await latestRun(path));
  const summary = JSON.parse(await readFile(join(dir, "summary.json"), "utf8")) as { status: string; error?: string; cost: { total: number } };
  assert.equal(summary.status, "failed", "the run must leave a record; three real runs previously vanished without one");
  assert.match(summary.error ?? "", /connection reset by peer/, "the child process stderr is the only clue to the root cause");
  assert.equal(typeof summary.cost.total, "number", "accumulated cost must still be accounted for");
});

test("an operator tier cap also caps the implementer ladder", async () => {
  const path = await repo();
  const agents = new FakeAgents([
    { summary: "impl 1" }, { summary: "no 1", verdict: "fail" },
    { summary: "impl 2" }, { summary: "no 2", verdict: "fail" },
    { summary: "impl 3" }, { summary: "no 3", verdict: "fail" },
    { summary: "impl 4" }, { summary: "no 4", verdict: "fail" },
  ]);
  await new Orchestrator({ agents, tests: new PassingTests() }).run(handoff(path), () => {}, { maxTier: 1 });

  const implementers = agents.calls.filter((call) => call.role === "implementer").map((call) => call.model.model);
  assert.equal(implementers.length, 4);
  assert.ok(!implementers.some((model) => model.includes("terra")), `a tier cap is a cost ceiling; Terra must not appear: ${implementers.join(", ")}`);
});

test("every run leaves a readable report next to the machine-readable ledger", async () => {
  const path = await repo();
  const agents = new FakeAgents([
    { summary: "impl 1" }, { summary: "verdict", verdict: "fail", findings: ["**High** — ptt_tickers is never populated"] },
    { summary: "改了 scraper，沒動 pipeline" }, { summary: "VERDICT: pass", verdict: "pass" },
  ]);
  const outcome = await new Orchestrator({ agents, tests: new PassingTests() }).run(handoff(path), () => {}, { maxTier: 1, specTitle: "PTT 推文情緒指標" });

  assert.equal(outcome.status, "ready_for_main");
  const report = await readFile(join(path, ".orchestrator", "runs", await latestRun(path), "report.md"), "utf8");
  assert.match(report, /# 可以合併 · PTT 推文情緒指標/);
  assert.match(report, /\| Cycle \| 2\/4 \|/);
  assert.match(report, /ptt_tickers is never populated/, "the history must still show what was raised along the way");
  assert.match(report, /改了 scraper，沒動 pipeline/, "and how the implementer answered it");
  assert.match(report, /## 尚未解決\n\n無。/);
});
