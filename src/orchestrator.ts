import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import type { AgentRunner, ReviewVerdict, Tier } from "./agents/contracts.js";
import type { Handoff, RepoConfig } from "./handoff.js";
import { hybridRoute, type ModelClassifier, type RoutingResult } from "./routing.js";
import { modelFor } from "./models.js";
import { runTests, type CommandRunner, type TestResult } from "./test-runner.js";

const execFileAsync = promisify(execFile);
export interface OrchestratorDependencies { agents: AgentRunner; tests: CommandRunner; classifier?: ModelClassifier; config?: RepoConfig; now?: () => Date; }
export interface RunOutcome { status: "ready_for_main" | "needs_human" | "failed"; runId: string; tier: Tier; rounds: number; routing: RoutingResult; }

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDependencies) {}
  async run(handoff: Handoff, onProgress: (line: string) => void = console.log): Promise<RunOutcome> {
    const repo = resolve(handoff.repo); const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    await excludeLedger(repo);
    const status = await git(repo, ["status", "--porcelain", "--untracked-files=all"]);
    if (meaningfulStatus(status).length) throw new Error("Target repo working tree must be clean before orchestration");
    const root = join(repo, ".orchestrator", "runs", runId); await mkdir(root, { recursive: true });
    const baseline = await git(repo, ["rev-parse", "HEAD"]).catch(() => "unborn");
    const initial = await hybridRoute(handoff, this.deps.config, this.deps.classifier);
    await ledger(root, "run.json", { runId, handoff, baseline, initialRouting: initial, startedAt: (this.deps.now?.() ?? new Date()).toISOString() });
    let effective = initial, round = 1, implementationNeeded = true, lastFindings: string[] = [];
    while (round <= 3) {
      onProgress(`Round ${round}/3 · Tier ${effective.tier}`);
      if (implementationNeeded) {
        const result = await this.deps.agents.run({ role: "implementer", taskId: runId, cwd: repo, sessionDir: join(root, `round-${round}-implementer`), model: modelFor(effective.tier, "implementer"), prompt: `Implement this handoff:\n${JSON.stringify(handoff, null, 2)}${lastFindings.length ? `\nFix these findings:\n${lastFindings.join("\n")}` : ""}`, artifacts: { handoff: JSON.stringify(handoff, null, 2), baseline, findings: lastFindings.join("\n") } });
        await ledger(root, `round-${round}-implementer.json`, result); onProgress(`Implementer: ${result.summary.slice(0, 160)}`);
        if (await git(repo, ["rev-parse", "HEAD"]).then((head) => head.trim()) !== baseline.trim()) throw new Error("Implementer changed HEAD; commit/push is forbidden");
      }
      const diff = await workingDiff(repo);
      const assessed = await hybridRoute(handoff, this.deps.config, this.deps.classifier, diff);
      const escalated = assessed.tier > effective.tier;
      effective = { ...assessed, tier: Math.max(effective.tier, assessed.tier) as Tier };
      if (escalated) onProgress(`Risk escalation: Tier ${effective.tier}; retaining implementation and strengthening checks.`);
      const baseTests = handoff.tests.length ? handoff.tests : (this.deps.config?.tests ?? []);
      const testCommands = [...new Set([...baseTests, ...(this.deps.config?.testsByTier?.[effective.tier] ?? [])])];
      if (testCommands.length === 0) onProgress("Tests: no deterministic commands configured; reviewers will receive this explicitly.");
      const testResults = await runTests(this.deps.tests, testCommands, repo); await ledger(root, `round-${round}-tests.json`, testResults);
      if (testResults.some((test) => !test.passed)) { lastFindings = testResults.filter((test) => !test.passed).map((test) => `${test.command}: ${test.output}`); if (round === 3) return this.finish(root, "needs_human", runId, effective.tier, round, effective); round++; implementationNeeded = true; continue; }
      const artifacts = { handoff: JSON.stringify(handoff, null, 2), diff, tests: formatTests(testResults), repo_rules: await repoRules(repo) };
      const review = await this.deps.agents.run({ role: "reviewer", taskId: runId, cwd: repo, sessionDir: join(root, `round-${round}-reviewer`), model: modelFor(effective.tier, "reviewer"), prompt: "Review the supplied final diff against the handoff. You are read-only.", artifacts });
      await ledger(root, `round-${round}-reviewer.json`, review);
      const verdict = review.verdict ?? "fail";
      if (verdict === "escalate" && effective.tier < 2) { effective = { ...effective, tier: (effective.tier + 1) as Tier, reasons: [...effective.reasons, "reviewer escalation"] }; implementationNeeded = false; onProgress(`Reviewer escalated to Tier ${effective.tier}; re-reviewing without reimplementation.`); continue; }
      if (verdict === "escalate") { lastFindings = [...(review.findings ?? []), review.summary]; if (round === 3) return this.finish(root, "needs_human", runId, effective.tier, round, effective); round++; implementationNeeded = true; continue; }
      if (verdict === "fail") { lastFindings = [...(review.findings ?? []), review.summary]; if (round === 3) return this.finish(root, "needs_human", runId, effective.tier, round, effective); round++; implementationNeeded = true; continue; }
      if (effective.tier > 0) {
        const final = await this.deps.agents.run({ role: "final_reviewer", taskId: runId, cwd: repo, sessionDir: join(root, `round-${round}-final`), model: modelFor(effective.tier, "final_reviewer"), prompt: "Perform the final, read-only release review. Verify requirement coverage and risk.", artifacts });
        await ledger(root, `round-${round}-final.json`, final);
        if ((final.verdict ?? "fail") !== "pass") { lastFindings = [...(final.findings ?? []), final.summary]; if (round === 3) return this.finish(root, "needs_human", runId, effective.tier, round, effective); round++; implementationNeeded = true; continue; }
      }
      return this.finish(root, "ready_for_main", runId, effective.tier, round, effective);
    }
    return this.finish(root, "needs_human", runId, effective.tier, round, effective);
  }
  private async finish(root: string, status: RunOutcome["status"], runId: string, tier: Tier, rounds: number, routing: RoutingResult): Promise<RunOutcome> { const outcome = { status, runId, tier, rounds, routing }; await ledger(root, "summary.json", outcome); await writeFile(join(root, "summary.md"), `# ${status}\n\nTier: ${tier}\nRounds: ${rounds}\n`); return outcome; }
}
async function ledger(root: string, name: string, value: unknown): Promise<void> { await writeFile(join(root, name), `${JSON.stringify(value, null, 2)}\n`); }
async function git(cwd: string, args: string[]): Promise<string> { const { stdout } = await execFileAsync("git", args, { cwd }); return stdout; }
async function workingDiff(repo: string): Promise<string> {
  const tracked = await git(repo, ["diff", "--", ".", ":(exclude).orchestrator/**", ":(exclude).agent/specs/**"]);
  const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard", "--", ".", ":(exclude).orchestrator/**", ":(exclude).agent/specs/**"])).trim().split("\n").filter(Boolean);
  const parts = [tracked];
  for (const file of untracked) parts.push(await git(repo, ["diff", "--no-index", "/dev/null", file]).catch((error: { stdout?: string }) => error.stdout ?? ""));
  return parts.filter(Boolean).join("\n");
}
function isSpecStatusLine(line: string): boolean {
  const path = line.slice(3).split(" -> ").at(-1)?.replace(/^"|"$/g, "") ?? "";
  return path === ".agent/specs" || path.startsWith(".agent/specs/");
}
export function meaningfulStatus(status: string): string[] { return status.split("\n").filter(Boolean).filter((line) => !isSpecStatusLine(line)); }
export async function excludeLedger(repo: string): Promise<void> {
  const gitPath = (await git(repo, ["rev-parse", "--git-path", "info/exclude"])).trim();
  const path = resolve(repo, gitPath);
  await mkdir(dirname(path), { recursive: true });
  const current = await readFile(path, "utf8").catch(() => "");
  if (!current.split("\n").includes(".orchestrator/")) await appendFile(path, `${current.endsWith("\n") || !current ? "" : "\n"}.orchestrator/\n`);
}
export function formatTests(results: TestResult[]): string {
  if (results.length === 0) return "NO DETERMINISTIC TESTS CONFIGURED";
  return results.map((result) => `${result.passed ? "PASS" : "FAIL"} ${result.command}\n${result.output}`).join("\n");
}
async function repoRules(repo: string): Promise<string> { try { return await readFile(join(repo, "CLAUDE.md"), "utf8"); } catch { return ""; } }
