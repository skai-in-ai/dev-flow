import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import type { AgentRunner, ReviewVerdict, Tier } from "./agents/contracts.js";
export type { ReviewVerdict };
import type { Handoff, RepoConfig } from "./handoff.js";
import { hybridRoute, type ModelClassifier, type RoutingResult } from "./routing.js";
import { modelFor } from "./models.js";
import { DEFAULT_MAX_FIX_CYCLES, maxCyclesFor, nextCycle } from "./policies/completion-policy.js";
import { EMPTY_DECISION_LOG, appendFindings, appendResponse, formatDecisionLog, repeatsPreviousCycle, type DecisionLog, type FindingSource } from "./decision-log.js";
import { runTests, type CommandRunner, type TestResult } from "./test-runner.js";
import { renderReport } from "./report.js";

const execFileAsync = promisify(execFile);
export interface OrchestratorDependencies { agents: AgentRunner; tests: CommandRunner; classifier?: ModelClassifier; config?: RepoConfig; now?: () => Date; }
/** reviewer 判定「handoff 未定義的產品語意」時交回的內容，供討論階段直接使用。 */
export interface SpecGap { semantic: string; candidates: string[]; }
export interface RunOutcome { status: "ready_for_main" | "needs_human" | "failed"; runId: string; tier: Tier; cycles: number; maxCycles: number; routing: RoutingResult; specGap?: SpecGap; cost: RunCost; error?: string; }
/** 依角色分攤的花費；`total` 含 router。單位為美金。 */
export interface RunCost { total: number; byRole: Record<string, number> }
/**
 * 每次 run 的來源資訊。spec 會被流程就地改寫（status 轉為 ready_for_main 或
 * needs_clarification），所以執行當下的原文必須快照，否則事後無從得知這次到底
 * 是對著什麼規格跑的。
 */
export interface RunSource { specPath?: string; specTitle?: string; specMarkdown?: string; maxTier?: Tier }

export function applyTierCap<T extends RoutingResult>(routing: T, maxTier: Tier | undefined): T {
  if (maxTier === undefined || routing.tier <= maxTier) return routing;
  return {
    ...routing,
    tier: maxTier,
    reasons: [...routing.reasons, `operator max-tier cap applied: ${maxTier}`],
    riskFlags: [...routing.riskFlags, `tier capped from ${routing.tier} to ${maxTier}`],
  } as T;
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDependencies) {}
  async run(handoff: Handoff, onProgress: (line: string) => void = console.log, source: RunSource = {}): Promise<RunOutcome> {
    const repo = resolve(handoff.repo); const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    await excludeLedger(repo);
    const status = await git(repo, ["status", "--porcelain", "--untracked-files=all"]);
    if (meaningfulStatus(status).length) throw new Error("Target repo working tree must be clean before orchestration");
    const root = join(repo, ".orchestrator", "runs", runId); await mkdir(root, { recursive: true });
    const baseline = await git(repo, ["rev-parse", "HEAD"]).catch(() => "unborn");
    const startedAt = this.deps.now?.() ?? new Date();
    const cost: RunCost = { total: 0, byRole: {} };
    const charge = (role: string, amount: number | undefined): void => {
      if (!amount) return;
      cost.byRole[role] = Number(((cost.byRole[role] ?? 0) + amount).toFixed(6));
      cost.total = Number((cost.total + amount).toFixed(6));
    };
    // spec 會被就地改寫，執行當下的原文必須快照。
    if (source.specMarkdown) await writeFile(join(root, "spec.md"), source.specMarkdown);
    const maxFixCyclesEarly = this.deps.config?.maxFixCycles ?? DEFAULT_MAX_FIX_CYCLES;
    const preflightCommands = preflightTestCommands(handoff, this.deps.config);
    if (preflightCommands.length && this.deps.config?.skipPreflight !== true) {
      const preflight = await runTests(this.deps.tests, preflightCommands, repo);
      await ledger(root, "preflight-tests.json", preflight);
      const broken = preflight.filter((test) => !test.passed);
      if (broken.length) {
        // baseline 是乾淨的 HEAD，此時測試就不過代表環境或既有程式碼有問題，
        // 不是這次要做的事造成的。implementer 修不好「pytest 沒安裝」這種事，
        // 實測有一個 run 因此連燒四個 cycle。在花任何模型錢之前就停。
        const reason = `preflight failed on a clean tree; the environment or the existing code is broken before this task starts:\n${broken.map((test) => `${test.command}: ${test.output}`).join("\n")}`;
        onProgress("Preflight: deterministic tests fail on the untouched baseline; refusing to start.");
        return this.finish(root, "needs_human", runId, initialTierGuess(source), 0, maxCyclesFor(maxFixCyclesEarly), await hybridRoute(handoff, this.deps.config, undefined), { total: 0, byRole: {} }, startedAt, source, undefined, reason);
      }
    }
    const initial = applyTierCap(await hybridRoute(handoff, this.deps.config, this.deps.classifier, "", join(root, "router-initial")), source.maxTier);
    charge("router", initial.costUsd);
    await ledger(root, "run.json", { runId, handoff, baseline, initialRouting: initial, startedAt: startedAt.toISOString(), source: { specPath: source.specPath, specTitle: source.specTitle, maxTier: source.maxTier } });
    const maxFixCycles = this.deps.config?.maxFixCycles ?? DEFAULT_MAX_FIX_CYCLES;
    let effective = initial, cycle = 1, implementationNeeded = true, lastFindings: string[] = [];
    let decisionLog: DecisionLog = EMPTY_DECISION_LOG;
    /** 累積失敗紀錄並落盤。歷史一律保留，不覆寫，也不標記任何 finding 為已推翻。 */
    const record = async (source: FindingSource, model: string, texts: readonly string[]): Promise<void> => {
      decisionLog = appendFindings(decisionLog, texts.filter(Boolean).map((text) => ({ round: cycle, source, model, text })));
      await ledger(root, "decisions.json", decisionLog);
    };
    let stallReason: string | undefined;
    /**
     * 失敗當下呼叫。回傳 false 代表本次 run 應收斂為 needs_human，原因是修正次數
     * 用盡，或這個 cycle 的失敗與上一個 cycle 逐字元相同（再修一次也不會變）。
     */
    const advance = (): boolean => {
      if (repeatsPreviousCycle(decisionLog, cycle)) {
        stallReason = `identical failure repeated in cycle ${cycle - 1} and ${cycle}; another implementation attempt cannot change it`;
        onProgress(`Stalled: ${stallReason}`);
        return false;
      }
      const decision = nextCycle({ cycle, maxFixCycles });
      if (decision.action === "give_up") return false;
      cycle = decision.state.cycle;
      implementationNeeded = true;
      return true;
    };
    try {
    while (cycle <= maxCyclesFor(maxFixCycles)) {
      onProgress(`Cycle ${cycle}/${maxCyclesFor(maxFixCycles)} · Tier ${effective.tier}`);
      if (implementationNeeded) {
        const implementerModel = modelFor(effective.tier, "implementer", cycle, source.maxTier);
        const result = await this.deps.agents.run({ role: "implementer", taskId: runId, cwd: repo, sessionDir: join(root, `cycle-${cycle}-implementer`), model: implementerModel, timeoutMs: 25 * 60_000, prompt: `Implement this handoff:\n${JSON.stringify(handoff, null, 2)}${lastFindings.length ? `\nFix these findings:\n${lastFindings.join("\n")}` : ""}`, artifacts: { handoff: JSON.stringify(handoff, null, 2), baseline, findings: lastFindings.join("\n"), decision_log: formatDecisionLog(decisionLog) } });
        await ledger(root, `cycle-${cycle}-implementer.json`, result); charge("implementer", costOf(result.usage)); onProgress(`Implementer: ${result.summary.slice(0, 160)}`);
        if (cycle > 1) { decisionLog = appendResponse(decisionLog, { round: cycle - 1, model: implementerModel.model, text: result.summary }); await ledger(root, "decisions.json", decisionLog); }
        if (await git(repo, ["rev-parse", "HEAD"]).then((head) => head.trim()) !== baseline.trim()) throw new Error("Implementer changed HEAD; commit/push is forbidden");
      }
      const diff = await workingDiff(repo);
      // diff 存成第一級檔案：收 needs_human 而使用者丟棄 working tree 時，這是唯一的產出紀錄。
      await writeFile(join(root, `cycle-${cycle}.diff`), diff);
      const assessed = applyTierCap(await hybridRoute(handoff, this.deps.config, this.deps.classifier, diff, join(root, `cycle-${cycle}-router`)), source.maxTier);
      charge("router", assessed.costUsd);
      const escalated = assessed.tier > effective.tier;
      effective = { ...assessed, tier: Math.max(effective.tier, assessed.tier) as Tier };
      if (escalated) onProgress(`Risk escalation: Tier ${effective.tier}; retaining implementation and strengthening checks.`);
      const baseTests = handoff.tests.length ? handoff.tests : (this.deps.config?.tests ?? []);
      const testCommands = [...new Set([...baseTests, ...(this.deps.config?.testsByTier?.[effective.tier] ?? [])])];
      if (testCommands.length === 0) onProgress("Tests: no deterministic commands configured; reviewers will receive this explicitly.");
      const testResults = await runTests(this.deps.tests, testCommands, repo); await ledger(root, `cycle-${cycle}-tests.json`, testResults);
      if (testResults.some((test) => !test.passed)) { lastFindings = testResults.filter((test) => !test.passed).map((test) => `${test.command}: ${test.output}`); await record("tests", "deterministic", lastFindings); if (!advance()) return this.finish(root, "needs_human", runId, effective.tier, cycle, maxCyclesFor(maxFixCycles), effective, cost, startedAt, source, undefined, stallReason, decisionLog); continue; }
      const artifacts = { handoff: JSON.stringify(handoff, null, 2), diff, tests: formatTests(testResults), repo_rules: await repoRules(repo), decision_log: formatDecisionLog(decisionLog) };
      const reviewerModel = modelFor(effective.tier, "reviewer");
      const review = await this.deps.agents.run({ role: "reviewer", taskId: runId, cwd: repo, sessionDir: join(root, `cycle-${cycle}-reviewer`), model: reviewerModel, prompt: "Review the supplied final diff against the handoff. You are read-only.", artifacts });
      await ledger(root, `cycle-${cycle}-reviewer.json`, review); charge("reviewer", costOf(review.usage));
      const verdict = review.verdict ?? "fail";
      const reviewGap = specGap(verdict, review.findings);
      if (reviewGap) { await record("reviewer", reviewerModel.model, [reviewGap.semantic, ...reviewGap.candidates]); onProgress(`Reviewer reports an undefined product semantic; returning to discussion without consuming a cycle.`); return this.finish(root, "needs_human", runId, effective.tier, cycle, maxCyclesFor(maxFixCycles), effective, cost, startedAt, source, reviewGap, undefined, decisionLog); }
      if (verdict === "escalate" && effective.tier < 2 && (source.maxTier === undefined || effective.tier < source.maxTier)) { effective = applyTierCap({ ...effective, tier: (effective.tier + 1) as Tier, reasons: [...effective.reasons, "reviewer escalation"] }, source.maxTier); implementationNeeded = false; onProgress(`Reviewer escalated to Tier ${effective.tier}; re-reviewing without reimplementation.`); continue; }
      if (verdict === "escalate" && source.maxTier !== undefined && effective.tier >= source.maxTier && source.maxTier < 2) {
        const finding = `reviewer requested escalation beyond operator max-tier cap ${source.maxTier}`;
        await record("reviewer", reviewerModel.model, [finding]);
        onProgress(`Reviewer escalation blocked by --max-tier ${source.maxTier}; returning for human review.`);
        return this.finish(root, "needs_human", runId, effective.tier, cycle, maxCyclesFor(maxFixCycles), effective, cost, startedAt, source, undefined, undefined, decisionLog);
      }
      // 已達最高 tier 仍 escalate：reviewer 說的是「這超出我的判斷」而非「實作有錯」，
      // 正確動作是交給 Sol 裁決，不是叫 implementer 再改一次。不消耗 cycle，不重新實作。
      const deferredToFinal = verdict === "escalate";
      if (deferredToFinal) onProgress("Reviewer escalated at the highest tier; deferring the decision to the final reviewer without consuming a cycle.");
      // pass 與上述 escalate 以外一律走失敗路徑，包含降級的 needs_spec（候選答案不足）。
      // 白名單而非黑名單：新增 verdict 時預設是「不放行」，不會靜默地把不合格的 review 當成通過。
      if (verdict !== "pass" && !deferredToFinal) { lastFindings = [...(review.findings ?? []), review.summary]; await record("reviewer", reviewerModel.model, signal(review.findings, review.summary)); if (!advance()) return this.finish(root, "needs_human", runId, effective.tier, cycle, maxCyclesFor(maxFixCycles), effective, cost, startedAt, source, undefined, stallReason, decisionLog); continue; }
      if (effective.tier === 2) {
        const finalModel = modelFor(effective.tier, "final_reviewer");
        const final = await this.deps.agents.run({ role: "final_reviewer", taskId: runId, cwd: repo, sessionDir: join(root, `cycle-${cycle}-final`), model: finalModel, prompt: "Perform the final, read-only release review. Verify requirement coverage and risk.", artifacts });
        await ledger(root, `cycle-${cycle}-final.json`, final); charge("final_reviewer", costOf(final.usage));
        const finalGap = specGap(final.verdict, final.findings);
        if (finalGap) { await record("final_reviewer", finalModel.model, [finalGap.semantic, ...finalGap.candidates]); onProgress(`Final reviewer reports an undefined product semantic; returning to discussion without consuming a cycle.`); return this.finish(root, "needs_human", runId, effective.tier, cycle, maxCyclesFor(maxFixCycles), effective, cost, startedAt, source, finalGap, undefined, decisionLog); }
        if ((final.verdict ?? "fail") !== "pass") { lastFindings = [...(final.findings ?? []), final.summary]; await record("final_reviewer", finalModel.model, signal(final.findings, final.summary)); if (!advance()) return this.finish(root, "needs_human", runId, effective.tier, cycle, maxCyclesFor(maxFixCycles), effective, cost, startedAt, source, undefined, stallReason, decisionLog); continue; }
      }
      return this.finish(root, "ready_for_main", runId, effective.tier, cycle, maxCyclesFor(maxFixCycles), effective, cost, startedAt, source, undefined, undefined, decisionLog);
    }
    } catch (thrown) {
      // Runtime exception 以前直接往外拋，結果是整個 run 沒有 summary、沒有成本歸戶、
      // spec status 也不會回寫。實測 11 個 run 有 3 個因此完全查不到發生什麼事。
      // 這裡把它落地成 `failed`，保留已累積的成本與錯誤訊息（含子程序 stderr）。
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      onProgress(`Run failed: ${message.slice(0, 300)}`);
      await this.finish(root, "failed", runId, effective.tier, cycle, maxCyclesFor(maxFixCycles), effective, cost, startedAt, source, undefined, message, decisionLog);
      throw thrown;
    }
    return this.finish(root, "needs_human", runId, effective.tier, cycle, maxCyclesFor(maxFixCycles), effective, cost, startedAt, source, undefined, stallReason, decisionLog);
  }
  private async finish(root: string, status: RunOutcome["status"], runId: string, tier: Tier, cycles: number, maxCycles: number, routing: RoutingResult, cost: RunCost, startedAt: Date, source: RunSource, gap?: SpecGap, error?: string, decisionLog: DecisionLog = EMPTY_DECISION_LOG): Promise<RunOutcome> {
    const outcome: RunOutcome = { status, runId, tier, cycles, maxCycles, routing, cost, ...(gap ? { specGap: gap } : {}), ...(error ? { error } : {}) };
    await ledger(root, "summary.json", outcome);
    const money = `US$${cost.total.toFixed(5)}`;
    await writeFile(join(root, "summary.md"), `# ${status}\n\nTier: ${tier}\nCycles: ${cycles}/${maxCycles}\nCost: ${money}\n${error ? `\n## 中止原因\n${error}\n` : ""}${gap ? `\n${renderSpecGap(gap)}` : ""}`);
    const durationMs = Math.max(0, (this.deps.now?.() ?? new Date()).getTime() - startedAt.getTime());
    // 決定性報告：讓「這次跑了什麼、卡在哪、花多少」不必開多個 JSON 也不必再花一次模型錢去整理。
    await writeFile(join(root, "report.md"), renderReport({
      status, tier, maxTier: source.maxTier, cycles, maxCycles, cost, durationMs, runId,
      specTitle: source.specTitle, specPath: source.specPath, decisionLog, specGap: gap, error,
    }));
    await appendIndex(root, {
      runId, startedAt: startedAt.toISOString(),
      durationMs,
      status, tier, cycles, maxCycles, cost, error,
      specPath: source.specPath, specTitle: source.specTitle,
      specGap: gap ? gap.semantic : undefined,
    });
    return outcome;
  }
}
/** 預檢用的測試命令：只取與 tier 無關的基礎命令，因為此時尚未決定 tier。 */
export function preflightTestCommands(handoff: Handoff, config: RepoConfig | undefined): string[] {
  return [...new Set(handoff.tests.length ? handoff.tests : (config?.tests ?? []))];
}
function initialTierGuess(source: RunSource): Tier { return source.maxTier ?? 0; }
async function ledger(root: string, name: string, value: unknown): Promise<void> { await writeFile(join(root, name), `${JSON.stringify(value, null, 2)}\n`); }
/** Pi usage 的成本欄位；缺漏時回傳 undefined，不讓統計因格式變動而爆掉。 */
export function costOf(usage: Record<string, unknown> | undefined): number | undefined {
  const total = (usage?.cost as { total?: unknown } | undefined)?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : undefined;
}
/**
 * 每次 run 結束時 append 一行到 `.orchestrator/index.jsonl`。
 *
 * 放在 `runs/` 之外，因為 `runs/` 應該只含 run 目錄，讀取端才能直接 readdir 而不必過濾。
 * 目的是讓「跑過幾次、成功率、每次多少錢、平均幾個 cycle」不必開動輒上百 MB 的 events 檔。
 * 這裡只捕捉資料，不做分析；報表與保留政策等實際跑過幾次、知道要問什麼再做。
 */
export async function appendIndex(root: string, entry: Record<string, unknown>): Promise<void> {
  const path = join(dirname(dirname(root)), "index.jsonl");
  await appendFile(path, `${JSON.stringify(entry)}\n`);
}
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
/**
 * decision log 只收結構化 findings；沒有 findings 時才退回整段 summary。
 * implementer 的 prompt 仍會收到 summary（見 lastFindings），但歷史紀錄若把每輪的
 * 散文全文都留下，後續 reviewer 讀到的訊噪比會迅速惡化。
 */
/**
 * `needs_spec` 的防濫用檢查。
 *
 * reviewer 可能把 needs_spec 當成遇到難題就丟人工的偷懶出口，所以要求它必須交出
 * 「缺的語意 + 至少兩個候選答案」才算數，湊不出來就退回一般 fail 路徑重試。
 * 回傳 undefined 代表這不是（或不合格的）spec 缺口，呼叫端應照原本的 verdict 處理。
 */
export function specGap(verdict: ReviewVerdict | undefined, findings: readonly string[] | undefined): SpecGap | undefined {
  if (verdict !== "needs_spec") return undefined;
  const entries = (findings ?? []).map((finding) => finding.trim()).filter(Boolean);
  if (entries.length < 3) return undefined;
  return { semantic: entries[0], candidates: entries.slice(1) };
}
export function renderSpecGap(gap: SpecGap): string {
  return `## 缺的語意\n${gap.semantic}\n\n## 候選答案\n${gap.candidates.map((candidate) => `- ${candidate}`).join("\n")}\n`;
}
export function signal(findings: readonly string[] | undefined, summary: string): readonly string[] {
  const structured = (findings ?? []).filter((finding) => finding.trim());
  return structured.length ? structured : [summary];
}
