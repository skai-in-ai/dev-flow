import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import { Orchestrator, type RunOutcome } from "./orchestrator.js";
import { PiProcessAdapter } from "./adapters/pi/pi-process-adapter.js";
import { ShellTestRunner } from "./test-runner.js";
import { classifierModel } from "./models.js";
import { renderClassifierPrompt } from "./classifier-prompt.js";
import type { ModelClassifier } from "./routing.js";
import { costOf } from "./orchestrator.js";
import { specToHandoff, parseSpec, assertExecutableTestCommands, type TaskSpec } from "./spec.js";
import type { Tier } from "./agents/contracts.js";

const execFileAsync = promisify(execFile);
export interface QueueIssue { number: number; title: string; body: string; labels: string[]; repository: string; createdAt?: string; }
export interface QueueComment { id: number; author: string; body: string; createdAt: string; }
export interface DraftPullRequest { url: string; number?: number; }
export interface QueueClaim { defaultBranch: string; sha: string; attempt?: number; claimRef?: string; }
export interface ResumeContext { attempt: number; decision: string; decisionAuthor: string; previousOutcome: RunOutcome; decisionLog: string; findings: string[]; attemptedFixes: string[]; testEvidence: Array<{ command: string; passed: boolean }>; }
export interface NeedsHumanReport { issueNumber: number; attempt: number; reason: string; findings: string[]; attemptedFixes: string[]; changedFiles: string[]; failedVerification: string[]; costUsd?: number; durationMs?: number; worktree: string; branch: string; resumable: boolean; }

/**
 * The ref lives under the Issue's own repository, so the repository name is not repeated here.
 * Attempt is part of the identity: a finished attempt must not block the next authorized resume,
 * while two workers racing the same attempt must still collide on a single compare-and-set.
 */
export function claimRef(issue: QueueIssue, attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer");
  return `refs/dev-flow-claims/issue-${issue.number}-attempt-${attempt}`;
}
export function nextAttempt(previous: number | undefined): number { return previous === undefined ? 1 : previous + 1; }
export function renderNeedsHumanReport(report: NeedsHumanReport): string {
  const bullet = (items: readonly string[]) => items.length ? items.map((item) => "- " + item).join("\n") : "- 無";
  return [
    "<!-- dev-flow-needs-human-attempt:" + report.attempt + " -->",
    "## dev-flow 需要人工決策",
    "",
    "### Attempt " + report.attempt + " 停止原因", report.reason,
    "", "### 未解 findings", bullet(report.findings),
    "", "### 上一輪實作回應", bullet(report.attemptedFixes),
    "", "### 變更檔案", bullet(report.changedFiles),
    "", "### 失敗驗證", bullet(report.failedVerification),
    "", "### 成本與時間", report.costUsd === undefined || report.durationMs === undefined
      ? "未知：這次在 orchestrator 回報結果之前就中止了，實際花費請查本機 ledger。"
      : "成本：US$" + report.costUsd.toFixed(5) + "；耗時：" + Math.round(report.durationMs) + " ms",
    "", "### 保留現場",
    "- worktree：" + report.worktree,
    "- branch：" + report.branch,
    "", "### 如何 resume",
    report.resumable
      ? [
        "由具 repository 寫入權限的協作者加上 `dev-flow-resume` label，並在本則報告之後留下新的 comment：",
        "",
        "```text",
        "/dev-flow resume narrow fix <要做的窄修>",
        "```",
        "",
        "系統會驗證授權、comment 時效與 retained worktree 的 provenance；對不上就停在 needs-human，不會自動重建或捨棄現場。",
      ].join("\n")
      : "這個 attempt 無法由系統 resume：可能已通過 ready_for_main 或已建立 Draft PR，也可能是現場尚未建立或無法驗證。請依上面的停止原因人工處理。",
  ].join("\n");
}

/**
 * The MVP accepts one decision only: a narrow fix with a non-empty instruction.
 * `rebuild` and `cancel` are deliberately absent; a human who wants either does it by hand,
 * so no automated path can discard a retained worktree.
 */
export function parseResumeDecision(comment: QueueComment, previousAttempt: number, previousAttemptEndedAt?: string): string | undefined {
  if (previousAttempt < 1 || !comment.body.trim() || !Number.isInteger(comment.id)) return undefined;
  const createdAt = Date.parse(comment.createdAt);
  if (!comment.createdAt || !Number.isFinite(createdAt) || createdAt <= 0) return undefined;
  if (previousAttemptEndedAt !== undefined) {
    const endedAt = Date.parse(previousAttemptEndedAt);
    if (!Number.isFinite(endedAt) || endedAt <= 0 || createdAt <= endedAt) return undefined;
  }
  const parts = comment.body.trim().split(/\s+/);
  if (parts.length < 3 || parts[0].toLowerCase() !== "/dev-flow" || parts[1].toLowerCase() !== "resume") return undefined;
  const decision = parts.slice(2).join(" ");
  if (!/^narrow fix .+$/i.test(decision)) return undefined;
  return decision;
}

/**
 * FIFO across repositories. Issue numbers are per-repository, so ordering by number alone
 * lets a newly allowlisted repository (starting at #1) permanently outrank an older one.
 * `createdAt` is used rather than `updatedAt` so that editing an Issue body does not move it
 * to the back of the queue. Repository and number only break exact-timestamp ties, keeping
 * the selection deterministic. Issues with a missing or unparseable timestamp sort last
 * rather than silently jumping the queue.
 */
export function orderQueue(issues: readonly QueueIssue[]): QueueIssue[] {
  const readyAt = (issue: QueueIssue): number => {
    const parsed = Date.parse(issue.createdAt ?? "");
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  // Plain code-unit comparison, not localeCompare: tie-breaking must not depend on the
  // host locale, or two workers on different machines could order the same queue differently.
  const byRepository = (a: QueueIssue, b: QueueIssue): number => (a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0);
  return [...issues].sort((a, b) => readyAt(a) - readyAt(b) || byRepository(a, b) || a.number - b.number);
}

export interface GitHubAdapter {
  /** Any order; `pollOnce` owns selection order via `orderQueue`. */
  listReadyIssues(): Promise<QueueIssue[]>;
  listComments?(issue: QueueIssue): Promise<QueueComment[]>;
  isAuthorized?(issue: QueueIssue, author: string): Promise<boolean>;
  /** Returns false when another worker has already atomically claimed this Issue. */
  claim(issue: QueueIssue, attempt?: number): Promise<QueueClaim | false>;
  removeLabel(issue: QueueIssue, label: string): Promise<void>;
  addLabel(issue: QueueIssue, label: string): Promise<void>;
  comment(issue: QueueIssue, body: string): Promise<void>;
  createDraftPullRequest(repo: string, branch: string, title: string, body: string): Promise<DraftPullRequest>;
}

async function gh(args: string[]): Promise<string> {
  const result = await execFileAsync("gh", args, { maxBuffer: 4 * 1024 * 1024 });
  return result.stdout;
}
export class GhCliAdapter implements GitHubAdapter {
  constructor(private readonly repos: readonly string[]) {}
  async listReadyIssues(): Promise<QueueIssue[]> {
    const all: QueueIssue[] = [];
    for (const repo of this.repos) {
      for (const label of ["dev-flow-ready", "dev-flow-resume"]) {
        const json = await gh(["issue", "list", "--repo", repo, "--state", "open", "--label", label, "--json", "number,title,body,labels,createdAt"]);
        const issues = JSON.parse(json) as Array<{ number: number; title: string; body?: string; labels?: Array<{ name: string }>; createdAt?: string }>;
        all.push(...issues.map((issue) => ({ number: issue.number, title: issue.title, body: issue.body ?? "", labels: (issue.labels ?? []).map((label) => label.name), repository: repo, createdAt: issue.createdAt })));
      }
    }
    // An Issue carrying both labels is listed twice; selection order is decided by `orderQueue`.
    return [...new Map(all.map((item) => [`${item.repository}#${item.number}`, item])).values()];
  }
  async listComments(issue: QueueIssue): Promise<QueueComment[]> {
    const json = await gh(["issue", "view", String(issue.number), "--repo", issue.repository, "--json", "comments"]);
    const value = JSON.parse(json) as { comments?: Array<{ id?: number; author?: { login?: string }; body?: string; createdAt?: string }> };
    return (value.comments ?? []).map((comment) => ({ id: comment.id ?? 0, author: comment.author?.login ?? "", body: comment.body ?? "", createdAt: comment.createdAt ?? "" }));
  }
  /**
   * `permission` is GitHub's legacy string and is one of `admin` / `write` / `read` / `none`;
   * `push` only ever appears as a boolean inside `user.permissions`, never as this string.
   * The boolean is the authoritative write capability, so it is checked first and the string
   * is only a fallback. `read`, `triage` and `none` are never write-capable.
   */
  async isAuthorized(issue: QueueIssue, author: string): Promise<boolean> {
    try {
      const endpoint = "repos/" + issue.repository + "/collaborators/" + encodeURIComponent(author) + "/permission";
      const value = JSON.parse(await gh(["api", endpoint])) as { permission?: string; user?: { permissions?: { push?: boolean } } };
      if (value.user?.permissions?.push === true) return true;
      return value.permission === "write" || value.permission === "maintain" || value.permission === "admin";
    } catch { return false; }
  }
  async claim(issue: QueueIssue, attempt = 1): Promise<QueueClaim | false> {
    // A Git ref creation is a GitHub-side compare-and-set: unlike a label edit it
    // fails if another Mac has already created this attempt's claim ref.
    const repo = JSON.parse(await gh(["api", `repos/${issue.repository}`])) as { default_branch?: string };
    if (!repo.default_branch || !validBranchName(repo.default_branch)) throw new Error(`GitHub returned an invalid default branch for ${issue.repository}`);
    const head = JSON.parse(await gh(["api", `repos/${issue.repository}/git/ref/heads/${repo.default_branch}`])) as { object?: { sha?: string } };
    const sha = head.object?.sha;
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`GitHub returned an invalid default branch SHA for ${issue.repository}`);
    try {
      await gh(["api", "--method", "POST", `repos/${issue.repository}/git/refs`, "-f", `ref=${claimRef(issue, attempt)}`, "-f", `sha=${sha}`]);
    } catch (error) {
      const detail = error instanceof Error ? `${error.message}\n${(error as { stderr?: string }).stderr ?? ""}` : String(error);
      if (/Reference already exists|already exists/i.test(detail)) return false;
      throw error;
    }
    await gh(["issue", "edit", String(issue.number), "--repo", issue.repository, "--remove-label", "dev-flow-ready", "--remove-label", "dev-flow-resume", "--remove-label", "dev-flow-needs-human", "--add-label", "dev-flow-running"]);
    return { defaultBranch: repo.default_branch, sha: sha.toLowerCase(), attempt, claimRef: claimRef(issue, attempt) };
  }
  async removeLabel(issue: QueueIssue, label: string): Promise<void> { await gh(["issue", "edit", String(issue.number), "--repo", issue.repository, "--remove-label", label]); }
  async addLabel(issue: QueueIssue, label: string): Promise<void> { await gh(["issue", "edit", String(issue.number), "--repo", issue.repository, "--add-label", label]); }
  async comment(issue: QueueIssue, body: string): Promise<void> { await gh(["issue", "comment", String(issue.number), "--repo", issue.repository, "--body", body]); }
  async createDraftPullRequest(repo: string, branch: string, title: string, body: string): Promise<DraftPullRequest> {
    const url = (await gh(["pr", "create", "--repo", repo, "--head", branch, "--title", title, "--body", body, "--draft"])).trim().split("\n").at(-1) ?? "";
    if (!/^https:\/\/github\.com\//.test(url)) throw new Error(`gh returned an invalid pull request URL: ${url}`);
    return { url };
  }
}

export interface QueueConfig { allowedRepos: readonly string[]; workspaceRoot: string; ledgerRoot: string; maxTier: Tier; dryRun: boolean; workerId: string; }
const allowedWorkspaceRoot = resolve("/Users/skai.wu/side");
export function queueConfig(env: NodeJS.ProcessEnv = process.env): QueueConfig {
  const allowedRepos = (env.DEV_FLOW_ALLOWED_REPOS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!allowedRepos.length) throw new Error("DEV_FLOW_ALLOWED_REPOS must contain owner/repository entries");
  const root = resolve(env.DEV_FLOW_WORKSPACE_ROOT ?? allowedWorkspaceRoot);
  const rootRelative = relative(allowedWorkspaceRoot, root);
  if (rootRelative === ".." || rootRelative.startsWith("../") || isAbsolute(rootRelative)) throw new Error("DEV_FLOW_WORKSPACE_ROOT must be inside /Users/skai.wu/side");
  const ledgerRoot = resolve(env.DEV_FLOW_QUEUE_LEDGER ?? join(root, ".orchestrator", "queue-jobs"));
  const rawTier = env.DEV_FLOW_MAX_TIER ?? "1";
  if (!/^[012]$/.test(rawTier)) throw new Error("DEV_FLOW_MAX_TIER must be 0, 1, or 2");
  return { allowedRepos, workspaceRoot: root, ledgerRoot, maxTier: Number(rawTier) as Tier, dryRun: env.DEV_FLOW_DRY_RUN === "1", workerId: env.DEV_FLOW_WORKER_ID ?? `${process.pid}-${randomUUID().slice(0, 8)}` };
}

function section(body: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = body.indexOf(`${marker}\n`);
  if (start < 0) throw new Error(`issue spec requires ## ${heading}`);
  const contentStart = start + marker.length + 1;
  const next = body.slice(contentStart).search(/^## /m);
  return body.slice(contentStart, next < 0 ? undefined : contentStart + next).trim();
}
function bullets(text: string, required = true): string[] {
  const trimmed = text.trim();
  if (!required && /^(?:none|n\/a|無)$/i.test(trimmed)) return [];
  const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  const values = lines.map((line) => line.match(/^-\s+(.+)$/)?.[1]?.trim());
  if (values.some((value) => !value)) throw new Error("issue spec list sections must contain only bullets (or none when optional)");
  if (required && !values.length) throw new Error("issue spec requires at least one bullet");
  return values as string[];
}
/** Parses the queue contract. The repository path is deliberately never taken from the Issue. */
export function parseIssueSpec(issue: QueueIssue): { spec: TaskSpec; maxTier: Tier } {
  const front = issue.body.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!front) throw new Error("issue body must start with the approved queue spec frontmatter");
  const value = (key: string): string => { const match = front[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m")); if (!match) throw new Error(`issue spec requires ${key}`); return match[1].trim().replace(/^['"]|['"]$/g, ""); };
  if (value("status") !== "approved") throw new Error("issue spec status must be approved");
  const tier = value("max_tier"); if (!/^[012]$/.test(tier)) throw new Error("issue spec max_tier must be 0, 1, or 2");
  const text = issue.body.slice(front[0].length);
  if (/<!--\s*dev-flow-required:/i.test(text)) throw new Error("issue spec contains incomplete template placeholders");
  const objective = section(text, "Objective");
  const backgroundAndDecisions = section(text, "Background and decisions");
  if (!objective) throw new Error("issue spec requires a non-empty Objective");
  if (!backgroundAndDecisions) throw new Error("issue spec requires non-empty Background and decisions");
  const spec: TaskSpec = {
    repo: "/untrusted-issue-repo", status: "approved", title: issue.title, createdAt: new Date().toISOString(),
    objective, backgroundAndDecisions,
    ...(text.includes("## Invariants and non-goals\n") ? { invariantsAndNonGoals: bullets(section(text, "Invariants and non-goals"), false) } : {}),
    modificationScope: bullets(section(text, "Scope include")), excludedScope: bullets(section(text, "Scope exclude"), false),
    acceptanceCriteria: bullets(section(text, "Acceptance criteria")), testRequirements: bullets(section(text, "Tests")),
    risks: bullets(section(text, "Risks"), false), unresolvedItems: bullets(section(text, "Unresolved items"), false),
  };
  assertExecutableTestCommands(spec.testRequirements);
  if (spec.unresolvedItems.length) throw new Error("issue spec has unresolved items; resolve them before adding dev-flow-ready");
  return { spec, maxTier: Number(tier) as Tier };
}

function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0,  fifty); }
const fifty = 50;
function canonicalRepository(value: string): string {
  const match = value.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  if (!match) throw new Error(`unsafe repository name: ${value}`);
  return `${match[1]}/${match[2]}`.toLowerCase();
}
function canonicalOrigin(value: string): string {
  const match = value.trim().match(/^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!match) throw new Error(`checkout origin is not a GitHub repository: ${value.trim()}`);
  return canonicalRepository(`${match[1]}/${match[2]}`);
}
async function repoPath(config: QueueConfig, repository: string): Promise<string> {
  const canonical = canonicalRepository(repository);
  if (!config.allowedRepos.some((allowed) => canonicalRepository(allowed) === canonical)) throw new Error(`repository is not allowlisted: ${repository}`);
  const name = repository.split("/")[1];
  const root = await realpath(config.workspaceRoot);
  const rootRelative = relative(allowedWorkspaceRoot, root);
  if (rootRelative === ".." || rootRelative.startsWith("../") || isAbsolute(rootRelative)) throw new Error("repository escapes allowed workspace root");
  const path = await realpath(resolve(root, name));
  if (relative(root, path).startsWith("..")) throw new Error("repository escapes workspace root");
  await git(path, ["rev-parse", "--is-inside-work-tree"]);
  const origin = await git(path, ["remote", "get-url", "origin"]);
  if (canonicalOrigin(origin) !== canonical) throw new Error(`checkout origin does not match allowlisted repository ${repository}`);
  return path;
}
async function git(cwd: string, args: string[]): Promise<string> { return (await execFileAsync("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 })).stdout; }
const pollLockStaleMs = 30 * 60 * 1000;
function validBranchName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes("..") && !value.includes("//") && !value.endsWith("/") && !value.endsWith(".") && !value.includes("@{");
}
export const MAX_DRAFT_PR_BODY_BYTES = 60 * 1024;
const MAX_DELIVERY_FIELD_LENGTH = 4 * 1024;
const MAX_DELIVERY_LIST_ITEMS = 100;
const MAX_DELIVERY_LIST_ITEM_LENGTH = 512;
export interface DeliveryChangedFile { path: string; status: string; }
export interface DeliveryGitEvidence { files: DeliveryChangedFile[]; filesChanged: number; insertions: number; deletions: number; }
export interface DraftPullRequestDelivery {
  issueNumber: number;
  objective: string;
  backgroundAndDecisions: string;
  risks: string[];
  acceptanceCriteria: string[];
  approvedInclude: string[];
  approvedExclude: string[];
  git: DeliveryGitEvidence;
  tests: Array<{ command: string; passed: boolean }>;
  reviewerVerdict: string;
  finalReviewerVerdict: string;
  status: RunOutcome["status"];
  tier: number;
  cycles: number;
  costUsd: number;
  durationMs: number;
  runId: string;
  /** Current attempt only. Cumulative history across attempts stays in the local ledger. */
  attempt?: number;
  resumeDecision?: string;
}
function plain(value: string, limit = MAX_DELIVERY_FIELD_LENGTH): string {
  const text = value.replace(/[\r\n\t]+/g, " ").trim();
  if (!text || text.length > limit) throw new Error("delivery payload contains a missing or oversized field");
  const escaped = text.replace(/[&<>`*_\\[\]{}()#+\-.!|>~]/g, (character) => `\\${character}`);
  return escaped.replace(/\b(?:https?|ftp):\/\//gi, (prefix) => prefix.replace(":", "&#58;"));
}
function list(values: readonly string[], name: string): string[] {
  if (values.length > MAX_DELIVERY_LIST_ITEMS) throw new Error(`delivery payload ${name} list is too large`);
  return values.map((value) => plain(value, MAX_DELIVERY_LIST_ITEM_LENGTH));
}
function validateDelivery(payload: DraftPullRequestDelivery): void {
  if (!Number.isInteger(payload.issueNumber) || payload.issueNumber <= 0 || payload.status !== "ready_for_main" || (payload.reviewerVerdict !== "pass" && !(payload.reviewerVerdict === "escalate" && payload.tier === 2)) || (payload.tier < 2 && payload.finalReviewerVerdict !== "not_run") || (payload.tier === 2 && payload.finalReviewerVerdict !== "pass")) throw new Error("incomplete delivery evidence; no PR was published");
  if (!Number.isFinite(payload.costUsd) || payload.costUsd < 0 || !Number.isFinite(payload.durationMs) || payload.durationMs < 0 || !Number.isInteger(payload.tier) || ![0, 1, 2].includes(payload.tier) || !Number.isInteger(payload.cycles) || payload.cycles < 0) throw new Error("malformed delivery result; no PR was published");
  plain(payload.objective); plain(payload.backgroundAndDecisions); list(payload.risks, "risks"); list(payload.acceptanceCriteria, "acceptanceCriteria"); list(payload.approvedInclude, "approvedInclude"); list(payload.approvedExclude, "approvedExclude");
  if (payload.attempt !== undefined && (!Number.isSafeInteger(payload.attempt) || payload.attempt < 1)) throw new Error("malformed attempt number; no PR was published");
  if (payload.resumeDecision !== undefined) plain(payload.resumeDecision, MAX_DELIVERY_LIST_ITEM_LENGTH);
  if (!payload.git.files.length || payload.git.files.length > MAX_DELIVERY_LIST_ITEMS || !Number.isSafeInteger(payload.git.filesChanged) || payload.git.filesChanged !== payload.git.files.length || !Number.isSafeInteger(payload.git.insertions) || payload.git.insertions < 0 || !Number.isSafeInteger(payload.git.deletions) || payload.git.deletions < 0) throw new Error("missing Git delivery evidence; no PR was published");
  payload.git.files.forEach((file) => { plain(file.path, MAX_DELIVERY_LIST_ITEM_LENGTH); plain(file.status, 32); });
  if (!payload.tests.length || payload.tests.length > MAX_DELIVERY_LIST_ITEMS || payload.tests.some((test) => !plain(test.command, MAX_DELIVERY_LIST_ITEM_LENGTH) || test.passed !== true)) throw new Error("unsuccessful test evidence; no PR was published");
  plain(payload.runId, 256);
}
/** The only PR-body boundary: explicit structured delivery evidence, never a report or agent text. */
export function draftPullRequestBody(payload: DraftPullRequestDelivery): string {
  validateDelivery(payload);
  const bullets = (values: readonly string[]) => values.length ? values.map((value) => `- ${value}`).join("\n") : "- 無";
  const files = payload.git.files.map((file) => `- ${plain(file.status, 32)} ${plain(file.path, MAX_DELIVERY_LIST_ITEM_LENGTH)}`).join("\n");
  const tests = payload.tests.map((test) => `- PASS: ${plain(test.command, MAX_DELIVERY_LIST_ITEM_LENGTH)}`).join("\n");
  const attempt = payload.attempt === undefined || payload.attempt === 1
    ? "初次執行"
    : `第 ${payload.attempt} 次 attempt；授權 resume 決策：${plain(payload.resumeDecision ?? "未記錄", MAX_DELIVERY_LIST_ITEM_LENGTH)}`;
  // `Closes #N` is a GitHub keyword, not prose: it is what closes the Issue when a human merges
  // this PR. It must never be translated, however Traditional Chinese the rest of the body is.
  const body = `Closes #${payload.issueNumber}（僅供 review；本 PR 不會自動 merge）\n\n## 執行歷程\n${attempt}\n\n完整的 attempt 歷程、findings 與成本留在本機 ledger，不寫進 PR。\n\n## 為何\n目標：${plain(payload.objective)}\n\n背景與決策：${plain(payload.backgroundAndDecisions)}\n\n風險：\n${bullets(list(payload.risks, "risks"))}\n\n驗收條件：\n${bullets(list(payload.acceptanceCriteria, "acceptanceCriteria"))}\n\n## 如何完成\n實際 Git 變更：\n${files}\n\nGit diff 統計：${payload.git.filesChanged} 個檔案變更，新增 ${payload.git.insertions} 行，刪除 ${payload.git.deletions} 行\n\n## 核准範圍\n包含：\n${bullets(list(payload.approvedInclude, "approvedInclude"))}\n\n實際變更檔案列於上方，供檢查是否超出範圍。\n\n## 驗證結果\n測試：\n${tests}\n審查 verdict：${plain(payload.reviewerVerdict, 32)}\n最終審查 verdict：${plain(payload.finalReviewerVerdict, 32)}\n狀態：${plain(payload.status, 32)}\nTier：${payload.tier}\nCycles：${payload.cycles}\n成本：US$${payload.costUsd.toFixed(5)}\n耗時：${Math.round(payload.durationMs)} ms\nRun ID：${plain(payload.runId, 256)}\n\n## 刻意排除\n${bullets(list(payload.approvedExclude, "approvedExclude"))}\n\n本機報告與 ledger 僅保留作非公開追溯資料。`;
  if (Buffer.byteLength(body, "utf8") > MAX_DRAFT_PR_BODY_BYTES) throw new Error("delivery PR body exceeds conservative GitHub limit; no PR was published");
  return body;
}

export async function acquirePollLock(config: QueueConfig, lockPath: string): Promise<boolean> {
  try {
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), createdAt: new Date().toISOString(), workerId: config.workerId }));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let stale = false;
  try {
    const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as { pid?: number; host?: string; createdAt?: string };
    const age = Date.now() - Date.parse(owner.createdAt ?? "");
    const ageExpired = !Number.isFinite(age) || age > pollLockStaleMs;
    if (owner.host === hostname() && Number.isInteger(owner.pid) && owner.pid! > 0) {
      try {
        process.kill(owner.pid!, 0);
        stale = false;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        stale = code === "ESRCH" ? true : ageExpired;
      }
    } else {
      stale = ageExpired;
    }
  } catch {
    stale = Date.now() - (await stat(lockPath)).mtimeMs > pollLockStaleMs;
  }
  if (!stale) return false;
  const recovered = `${lockPath}.stale-${randomUUID()}`;
  try { await rename(lockPath, recovered); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return acquirePollLock(config, lockPath); throw error; }
  await writeFile(join(config.ledgerRoot, `stale-poll-lock-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ lockPath, recoveredAt: new Date().toISOString() }, null, 2));
  await rm(recovered, { recursive: true, force: true });
  return acquirePollLock(config, lockPath);
}

/**
 * Everything a later attempt needs to prove it is looking at the same retained worktree,
 * plus the evidence a human and the next implementer need to continue. Written on every
 * non-`ready_for_main` exit; never used to rebuild anything.
 */
export interface RetainedWorktreeProvenance {
  repository: string; issueNumber: number; branch: string; cwd: string; baselineSha: string; status: string; recordedAt: string;
  attempt?: number; previousOutcome?: RunOutcome; decisionLog?: string; findings?: string[]; attemptedFixes?: string[];
  testEvidence?: Array<{ command: string; passed: boolean }>;
  changedFiles?: string[]; failedVerification?: string[]; costUsd?: number; durationMs?: number;
}

/**
 * The historical `<owner>-<repository>-<number>` layout, normalized so that a repository written
 * with different casing cannot resolve to two different retained worktrees. Known limitation:
 * `owner/repo-a` and `owner-repo/a` still map to the same directory. It fails closed (the origin
 * check and `git worktree add` both reject it) and no allowlist here uses such a pair, so the
 * layout stays compatible with the worktrees already on disk instead of being re-encoded.
 */
export function worktreePath(config: QueueConfig, issue: QueueIssue): string {
  return join(resolve(config.workspaceRoot), ".orchestrator", "worktrees", `${canonicalRepository(issue.repository).replace("/", "-")}-${issue.number}`);
}
async function validateWorktreeIdentity(cwd: string, issue: QueueIssue, expectedBranch?: string): Promise<void> {
  const actualCwd = await realpath(cwd);
  const topLevel = await realpath((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
  if (actualCwd !== topLevel) throw new Error("保留的路徑不是 Git worktree 根目錄");
  if (canonicalOrigin(await git(cwd, ["remote", "get-url", "origin"])) !== canonicalRepository(issue.repository)) throw new Error("保留的 worktree origin 與 Issue 的 repository 不符");
  const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (expectedBranch !== undefined && branch !== expectedBranch) throw new Error("保留的 worktree branch 與 Issue 的 branch 不符");
}

export async function validateRetainedWorktree(provenance: RetainedWorktreeProvenance, issue: QueueIssue, expectedCwd?: string, expectedBranch?: string): Promise<void> {
  if (provenance.repository !== issue.repository || provenance.issueNumber !== issue.number || !validBranchName(provenance.branch) || !isAbsolute(provenance.cwd) || !/^[0-9a-f]{40}$/i.test(provenance.baselineSha)) throw new Error("保留的 worktree provenance 內容不合法");
  if (provenance.previousOutcome?.status === "ready_for_main") throw new Error("已達 ready_for_main 的 provenance 不可 resume");
  if (expectedCwd === undefined) throw new Error("缺少保留 worktree 的預期路徑，無法驗證");
  if (await realpath(provenance.cwd) !== await realpath(expectedCwd)) throw new Error("保留的 worktree 路徑與該 Issue 的預期路徑不符");
  await validateWorktreeIdentity(provenance.cwd, issue, expectedBranch ?? provenance.branch);
  const actual = (await git(provenance.cwd, ["status", "--porcelain", "--untracked-files=all"])).trim();
  if (actual !== provenance.status.trim()) throw new Error("保留的 worktree 有 provenance 未記錄的變動，拒絕 resume");
  if ((await git(provenance.cwd, ["rev-parse", "HEAD"])).trim().toLowerCase() !== provenance.baselineSha.toLowerCase()) throw new Error("保留的 worktree HEAD 與 provenance 不符");
}

function retainedPath(config: QueueConfig, issue: QueueIssue): string {
  return join(worktreePath(config, issue), ".orchestrator", "queue-provenance.json");
}

function reportAttempt(comment: QueueComment): number | undefined {
  const marker = comment.body.match(/<!--\s*dev-flow-needs-human-attempt:(\d+)\s*-->/i) ?? comment.body.match(/### Attempt (\d+) 停止原因/i);
  const attempt = Number(marker?.[1] ?? 0);
  return Number.isSafeInteger(attempt) && attempt > 0 ? attempt : undefined;
}

function hasPublishedPullRequestComment(comments: readonly QueueComment[]): boolean {
  return comments.some((comment) => /(?:Draft PR|PR).*(?:https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+)/i.test(comment.body));
}

/**
 * Deterministic evidence from the last run in the retained worktree: the reviewer findings that
 * were never resolved, what the implementer said it did about them, and the test evidence.
 * Every read is best-effort because a crashed run may not have written every artifact; a missing
 * artifact degrades the report, it must never be reconstructed or invented.
 */
async function latestRunEvidence(cwd: string, outcome: RunOutcome | undefined): Promise<{ outcome?: RunOutcome; decisionLog: string; findings: string[]; attemptedFixes: string[]; changedFiles: string[]; failedVerification: string[]; testEvidence: Array<{ command: string; passed: boolean }> }> {
  const runsRoot = join(cwd, ".orchestrator", "runs");
  const runNames = await readdir(runsRoot).catch(() => [] as string[]);
  const latest = runNames.sort().at(-1);
  let previousOutcome = outcome;
  if (!previousOutcome && latest) {
    try { previousOutcome = JSON.parse(await readFile(join(runsRoot, latest, "summary.json"), "utf8")) as RunOutcome; } catch { /* summary is best-effort diagnostic evidence */ }
  }
  let decisionLog = "";
  let findings: string[] = [];
  let attemptedFixes: string[] = [];
  let findingRecords: Array<{ round: number; text: string; source?: string }> = [];
  let responseRecords: Array<{ round: number; text: string }> = [];
  const implementerRecords: Array<{ cycle: number; summary: string }> = [];
  if (latest) {
    try {
      const parsed = JSON.parse(await readFile(join(runsRoot, latest, "decisions.json"), "utf8")) as { findings?: Array<{ round?: number; source?: string; text?: string }>; responses?: Array<{ round?: number; text?: string }> };
      findingRecords = (parsed.findings ?? []).filter((entry) => Number.isSafeInteger(entry.round) && Boolean(entry.text)).map((entry) => ({ round: entry.round as number, source: entry.source, text: entry.text as string }));
      responseRecords = (parsed.responses ?? []).filter((entry) => Number.isSafeInteger(entry.round) && Boolean(entry.text)).map((entry) => ({ round: entry.round as number, text: entry.text as string }));
      findings = findingRecords.map((entry) => entry.text);
      decisionLog = JSON.stringify(parsed);
    } catch { /* a runtime failure may happen before decisions.json exists */ }
  }
  if (latest) {
    const runFiles = await readdir(join(runsRoot, latest)).catch(() => [] as string[]);
    for (const file of runFiles) {
      const match = file.match(/^cycle-(\d+)-implementer\.json$/);
      if (!match) continue;
      try {
        const parsed = JSON.parse(await readFile(join(runsRoot, latest, file), "utf8")) as { summary?: string };
        if (parsed.summary?.trim()) implementerRecords.push({ cycle: Number(match[1]), summary: parsed.summary.trim() });
      } catch { /* preserve the remaining deterministic evidence when a cycle crashed */ }
    }
    implementerRecords.sort((a, b) => a.cycle - b.cycle);
  }
  const testEvidence = previousOutcome?.verification.tests.map(({ command, passed }) => ({ command, passed })) ?? [];
  const failedVerification = [...testEvidence.filter((test) => !test.passed).map((test) => test.command), ...findingRecords.filter((entry) => entry.source === "tests").map((entry) => entry.text)];
  attemptedFixes = implementerRecords.map((entry) => entry.summary);
  if (!attemptedFixes.length) attemptedFixes = responseRecords.map((entry) => entry.text);
  const status = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  const changedFiles = status.split("\n").filter(Boolean).map((line) => line.slice(3).split(" -> ").at(-1) ?? "").filter((file) => file && !file.startsWith(".orchestrator/") && !file.startsWith(".agent/specs/"));
  return { outcome: previousOutcome, decisionLog, findings, attemptedFixes, changedFiles, failedVerification, testEvidence };
}

async function writeRetainedProvenance(cwd: string, issue: QueueIssue, branch: string, attempt: number, outcome: RunOutcome | undefined): Promise<RetainedWorktreeProvenance> {
  const evidence = await latestRunEvidence(cwd, outcome);
  const provenance: RetainedWorktreeProvenance = {
    repository: issue.repository, issueNumber: issue.number, branch, cwd,
    baselineSha: (await git(cwd, ["rev-parse", "HEAD"])).trim(),
    status: (await git(cwd, ["status", "--porcelain", "--untracked-files=all"])).trim(), recordedAt: new Date().toISOString(), attempt,
    previousOutcome: evidence.outcome, decisionLog: evidence.decisionLog, findings: evidence.findings, attemptedFixes: evidence.attemptedFixes,
    testEvidence: evidence.testEvidence, changedFiles: evidence.changedFiles, failedVerification: evidence.failedVerification,
    costUsd: evidence.outcome?.cost.total ?? 0, durationMs: evidence.outcome?.durationMs ?? 0,
  };
  await writeFile(join(cwd, ".orchestrator", "queue-provenance.json"), JSON.stringify(provenance, null, 2));
  return provenance;
}

/**
 * 交付成功後回收隔離 worktree。
 *
 * 只在 Draft PR 已建立之後呼叫：那一刻 branch 已經在遠端，worktree 純粹是副本。`needs_human`
 * 的 worktree 絕不能走這裡，那正是「保留現場」的定義，而且變更只存在本機。
 *
 * run ledger 住在 worktree 裡面，所以先搬到 workspace 層的 job ledger 再刪，否則
 * `report.md`、`decisions.json`、`cycle-<n>.diff` 與 trace 會跟著消失。
 *
 * 全程 best-effort：回收失敗只是佔空間，不該把一次已經成功的交付變成 needs-human。
 */
export async function reclaimWorktree(repo: string, tree: { cwd: string; branch: string }, ledger: string): Promise<{ reclaimed: boolean; error?: string }> {
  try {
    const runs = join(tree.cwd, ".orchestrator", "runs");
    if (await stat(runs).then((info) => info.isDirectory()).catch(() => false)) {
      await mkdir(join(ledger, "runs"), { recursive: true });
      await rename(runs, join(ledger, "runs", "archived")).catch(async (error) => {
        // 跨檔案系統時 rename 會失敗；此時複製，複製不成就整個放棄回收，不刪任何東西。
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        await cp(runs, join(ledger, "runs", "archived"), { recursive: true });
      });
    }
    await git(repo, ["worktree", "remove", "--force", tree.cwd]);
    await git(repo, ["worktree", "prune"]);
    return { reclaimed: true };
  } catch (error) {
    return { reclaimed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function worktree(config: QueueConfig, repo: string, issue: QueueIssue, claim: QueueClaim, retained?: RetainedWorktreeProvenance): Promise<{ cwd: string; branch: string }> {
  if (!validBranchName(claim.defaultBranch) || !/^[0-9a-f]{40}$/i.test(claim.sha)) throw new Error("claim 到的遠端基準不合法");
  const branch = `codex/issue-${issue.number}-${slug(issue.title) || "task"}`;
  const cwd = worktreePath(config, issue);
  // A resume never creates or moves a worktree: it only proves the retained one is unchanged.
  if (retained) { await validateRetainedWorktree(retained, issue, cwd, branch); return { cwd, branch }; }
  await mkdir(dirname(cwd), { recursive: true });
  const remoteRef = `refs/remotes/origin/${claim.defaultBranch}`;
  await git(repo, ["fetch", "origin", `+refs/heads/${claim.defaultBranch}:${remoteRef}`]);
  const fetchedSha = (await git(repo, ["rev-parse", remoteRef])).trim().toLowerCase();
  if (fetchedSha !== claim.sha.toLowerCase()) throw new Error("fetch 到的 default branch 與 claim 的 SHA 不符");
  await git(repo, ["worktree", "add", "-b", branch, cwd, claim.sha]);
  return { cwd, branch };
}

/** Build the explicit publication allowlist from every Git index state. */
export function publicationFiles(unstaged: string, staged: string, untracked: string): string[] {
  const lines = (value: string) => value.trim().split("\n").map((file) => file.trim()).filter(Boolean);
  return [...new Set([...lines(unstaged), ...lines(staged), ...lines(untracked)])];
}
async function gitDeliveryEvidence(cwd: string): Promise<DeliveryGitEvidence> {
  const names = (await git(cwd, ["diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"])).trim().split("\n").filter(Boolean).map((line) => { const [status, ...parts] = line.split("\t"); return { status, path: parts.at(-1) ?? "" }; });
  const stats = (await git(cwd, ["show", "--format=", "--numstat", "HEAD"])).trim().split("\n").filter(Boolean).reduce((total, line) => { const [insertions, deletions] = line.split("\t"); return { filesChanged: total.filesChanged + 1, insertions: total.insertions + (Number(insertions) || 0), deletions: total.deletions + (Number(deletions) || 0) }; }, { filesChanged: 0, insertions: 0, deletions: 0 });
  return { files: names, ...stats };
}

export interface PendingResume { previousAttempt: number; decision: string; author: string; }

/**
 * Decides whether a `dev-flow-resume` Issue is actually actionable *before* it consumes the
 * single per-poll slot. An Issue waits on a human for as long as it takes, and during that time
 * it must neither be claimed nor written to: a needs-human report posted here would repost on
 * every poll and, being FIFO-first, starve every other queued Issue behind it.
 *
 * Returns undefined for "not actionable yet, skip silently". Anything an authorized human can
 * still get wrong *after* a valid decision (provenance, worktree state) is left to the caller,
 * because that failure deserves exactly one report — and that report makes the decision stale,
 * so it cannot loop.
 */
export async function pendingResume(adapter: GitHubAdapter, issue: QueueIssue): Promise<PendingResume | undefined> {
  if (!adapter.listComments || !adapter.isAuthorized) return undefined;
  if (issue.labels.includes("dev-flow-pr-ready")) return undefined;
  const comments = await adapter.listComments(issue);
  if (hasPublishedPullRequestComment(comments)) return undefined;
  const reports = comments.map((comment) => ({ comment, attempt: reportAttempt(comment), at: Date.parse(comment.createdAt) })).filter((entry): entry is { comment: QueueComment; attempt: number; at: number } => entry.attempt !== undefined && Number.isFinite(entry.at)).sort((a, b) => a.at - b.at);
  const previous = reports.at(-1);
  if (!previous) return undefined;
  const candidate = [...comments].reverse().find((comment) => parseResumeDecision(comment, previous.attempt, previous.comment.createdAt));
  if (!candidate) return undefined;
  // Authorization is checked against the comment author, never the Issue author or assignee.
  if (!(await adapter.isAuthorized(issue, candidate.author))) return undefined;
  const decision = parseResumeDecision(candidate, previous.attempt, previous.comment.createdAt);
  return decision ? { previousAttempt: previous.attempt, decision, author: candidate.author } : undefined;
}

export async function pollOnce(adapter: GitHubAdapter, config: QueueConfig): Promise<{ status: "idle" | "dry_run" | "success" | "failed"; issue?: QueueIssue; error?: string }> {
  await mkdir(config.ledgerRoot, { recursive: true });
  const lockPath = join(config.workspaceRoot, ".orchestrator", "queue-poll.lock");
  await mkdir(dirname(lockPath), { recursive: true });
  if (!await acquirePollLock(config, lockPath)) return { status: "idle" };
  try {
    // Selection order is owned here, not by the adapter, so every adapter selects identically.
    const issues = orderQueue((await adapter.listReadyIssues()).filter((issue) => !issue.labels.includes("dev-flow-running") && !issue.labels.includes("dev-flow-pr-ready") && (issue.labels.includes("dev-flow-ready") || issue.labels.includes("dev-flow-resume")) && config.allowedRepos.includes(issue.repository)));
  // A resume Issue waiting on its human is skipped rather than selected, so it cannot hold the
  // head of a FIFO queue for as long as the human takes to answer.
  let issue: QueueIssue | undefined; let resume: PendingResume | undefined;
  for (const candidate of issues) {
    if (!candidate.labels.includes("dev-flow-resume")) { issue = candidate; break; }
    if (config.dryRun) { issue = candidate; break; }
    resume = await pendingResume(adapter, candidate);
    if (resume) { issue = candidate; break; }
  }
  if (!issue) return { status: "idle" };
  const job = `${new Date().toISOString().replace(/[:.]/g, "-")}-${issue.number}-${config.workerId}`;
  const ledger = join(config.ledgerRoot, job); await mkdir(ledger, { recursive: true });
  const record = async (name: string, value: unknown) => writeFile(join(ledger, name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
  await record("issue.json", issue);
  if (config.dryRun) { await record("summary.json", { status: "dry_run", workerId: config.workerId }); return { status: "dry_run", issue }; }
  let claimed = false;
  let prReadyLabelApplied = false;
  let draftPrCreated = false;
  let pushedBranch: { cwd: string; branch: string } | undefined;
  let tree: { cwd: string; branch: string } | undefined;
  let outcome: RunOutcome | undefined;
  let resumeContext: ResumeContext | undefined;
  let attemptNumber = 1;
  let previousAttemptNumber: number | undefined;
  try {
    const parsed = parseIssueSpec(issue); const repo = await repoPath(config, issue.repository);
    await git(repo, ["rev-parse", "--is-inside-work-tree"]);
    let retained: RetainedWorktreeProvenance | undefined;
    if (resume) {
      previousAttemptNumber = resume.previousAttempt;
      attemptNumber = nextAttempt(resume.previousAttempt);
      // Everything below runs only after an authorized human asked for this attempt, so a failure
      // here produces exactly one needs-human report; that report makes the decision stale and
      // the Issue returns to waiting rather than retrying on the next poll.
      // Missing or corrupt provenance stops here. Rebuilding the worktree would silently discard
      // whatever the previous attempt produced, and that decision belongs to a human, not here.
      let provenance: RetainedWorktreeProvenance;
      try { provenance = JSON.parse(await readFile(retainedPath(config, issue), "utf8")) as RetainedWorktreeProvenance; }
      catch (error) { throw new Error(`保留的 worktree provenance 遺失或損壞，請人工處理：${error instanceof Error ? error.message : String(error)}`); }
      const expectedBranch = `codex/issue-${issue.number}-${slug(issue.title) || "task"}`;
      if (provenance.attempt !== undefined && provenance.attempt !== resume.previousAttempt) throw new Error("保留的 provenance 所記錄的 attempt 與最新 needs-human 報告不一致");
      await validateRetainedWorktree(provenance, issue, worktreePath(config, issue), expectedBranch);
      retained = provenance;
      const previousOutcome = provenance.previousOutcome;
      if (!previousOutcome) throw new Error("保留的 provenance 缺少上一輪 outcome 證據，拒絕 resume");
      if (previousOutcome.status === "ready_for_main") throw new Error("已達 ready_for_main 的 attempt 不可 resume");
      resumeContext = {
        attempt: attemptNumber, decision: resume.decision, decisionAuthor: resume.author, previousOutcome,
        decisionLog: provenance.decisionLog || "NO PRIOR ROUNDS.",
        findings: provenance.findings ?? [], attemptedFixes: provenance.attemptedFixes ?? [],
        testEvidence: provenance.testEvidence?.length ? provenance.testEvidence : previousOutcome.verification.tests,
      };
    }
    const claim = await adapter.claim(issue, attemptNumber);
    if (!claim) {
      await record("claim-lost.json", { job, workerId: config.workerId });
      return { status: "idle" };
    }
    claimed = true;
    await adapter.comment(issue, `dev-flow worker 已 claim 此 Issue。job：${job}；Attempt：${claim.attempt ?? attemptNumber}`);
    await record("claim.json", { job, workerId: config.workerId, repository: issue.repository, issueNumber: issue.number, attempt: claim.attempt ?? attemptNumber, ...claim });
    tree = await worktree(config, repo, issue, claim, retained);
    const specMarkdown = issue.body;
    await mkdir(join(tree.cwd, ".agent", "specs"), { recursive: true });
    await writeFile(join(tree.cwd, ".agent", "specs", `issue-${issue.number}.md`), specMarkdown);
    const handoff = specToHandoff({ ...parsed.spec, repo: tree.cwd });
    const agents = new PiProcessAdapter();
    const classifier: ModelClassifier = { classify: async ({ handoff: h, diff, sessionDir }) => { const result = await agents.run({ role: "router", taskId: "queue-routing", cwd: h.repo, sessionDir, model: classifierModel(), prompt: renderClassifierPrompt(h, diff), artifacts: {} }); const candidate = result.summary.match(/\{[\s\S]*\}/)?.[0]; let parsed: Record<string, unknown> = {}; try { parsed = JSON.parse(candidate ?? "{}"); } catch { parsed = { reasons: ["invalid router JSON"], riskFlags: [] }; } return { ...parsed, costUsd: costOf(result.usage) } as Awaited<ReturnType<ModelClassifier["classify"]>>; } };
    outcome = await new Orchestrator({ agents, tests: new ShellTestRunner(), classifier }).run(handoff, console.log, { specMarkdown, specTitle: issue.title, maxTier: Math.min(config.maxTier, parsed.maxTier) as Tier, ...(resumeContext ? { resume: { attempt: resumeContext.attempt, decision: resumeContext.decision, decisionLog: resumeContext.decisionLog, findings: resumeContext.findings, attemptedFixes: resumeContext.attemptedFixes, testEvidence: resumeContext.testEvidence }, allowRetainedChanges: true } : {}) });
    await record("outcome.json", outcome);
    // The catch block writes provenance for every retained failure, including this one.
    if (outcome.status !== "ready_for_main") throw new Error(`orchestrator 以 ${outcome.status} 結束，未 push 也未建立 PR`);
    const files = publicationFiles(
      await git(tree.cwd, ["diff", "--name-only"]),
      await git(tree.cwd, ["diff", "--cached", "--name-only"]),
      await git(tree.cwd, ["ls-files", "--others", "--exclude-standard"]),
    );
    if (!files.length || files.some((file) => file.startsWith("../") || file.startsWith("/"))) throw new Error("沒有可安全發布的變更");
    await git(tree.cwd, ["add", "--", ...files]); await git(tree.cwd, ["commit", "--only", "-m", `codex: issue #${issue.number}`, "--", ...files]);
    const prBody = draftPullRequestBody({
      issueNumber: issue.number, objective: parsed.spec.objective, backgroundAndDecisions: parsed.spec.backgroundAndDecisions,
      risks: parsed.spec.risks, acceptanceCriteria: parsed.spec.acceptanceCriteria, approvedInclude: parsed.spec.modificationScope,
      approvedExclude: parsed.spec.excludedScope, git: await gitDeliveryEvidence(tree.cwd), tests: outcome.verification.tests,
      reviewerVerdict: outcome.verification.reviewerVerdict, finalReviewerVerdict: outcome.verification.finalReviewerVerdict, status: outcome.status, tier: outcome.tier, cycles: outcome.cycles,
      costUsd: outcome.cost.total, durationMs: outcome.durationMs, runId: outcome.runId,
      attempt: attemptNumber, ...(resumeContext ? { resumeDecision: resumeContext.decision } : {}),
    });
    await git(tree.cwd, ["push", "--set-upstream", "origin", tree.branch]); pushedBranch = tree;
    const pr = await adapter.createDraftPullRequest(issue.repository, tree.branch, `Draft: ${issue.title}`, prBody);
    draftPrCreated = true;
    await adapter.removeLabel(issue, "dev-flow-running"); await adapter.addLabel(issue, "dev-flow-pr-ready"); prReadyLabelApplied = true; await adapter.comment(issue, `Draft PR 已建立：${pr.url}\nJob：${job}\n此 Issue 不可再次 resume。`);
    // 交付完成，現場不再需要：branch 已在遠端，ledger 搬到 job 目錄後回收 worktree。
    const reclaim = await reclaimWorktree(repo, tree, ledger);
    if (!reclaim.reclaimed) await record("worktree-reclaim-error.txt", reclaim.error ?? "unknown");
    await record("summary.json", { status: "success", pr, outcome, worktreeReclaimed: reclaim.reclaimed }); return { status: "success", issue };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let cleanupError: string | undefined;
    if (pushedBranch) {
      try {
        await git(pushedBranch.cwd, ["push", "origin", "--delete", pushedBranch.branch]);
        await record("remote-branch-deleted.txt", pushedBranch.branch);
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error);
        await record("remote-cleanup-error.txt", cleanupError);
      }
    }
    const failure = cleanupError ? `執行中止：${message}；遠端 branch 清理失敗：${cleanupError}` : `執行中止：${message}`;
    await record("error.txt", failure); await record("summary.json", { status: "failed", error: failure, outcome });
    const resumable = Boolean(tree) && !draftPrCreated && outcome?.status !== "ready_for_main";
    let evidence: Awaited<ReturnType<typeof latestRunEvidence>> = { outcome, decisionLog: "", findings: [], attemptedFixes: [], changedFiles: [], failedVerification: [], testEvidence: [] };
    try {
      if (tree && resumable) {
        const retainedEvidence = await writeRetainedProvenance(tree.cwd, issue, tree.branch, attemptNumber, outcome);
        evidence = { outcome: retainedEvidence.previousOutcome, decisionLog: retainedEvidence.decisionLog ?? "", findings: retainedEvidence.findings ?? [], attemptedFixes: retainedEvidence.attemptedFixes ?? [], changedFiles: retainedEvidence.changedFiles ?? [], failedVerification: retainedEvidence.failedVerification ?? [], testEvidence: retainedEvidence.testEvidence ?? [] };
        await record("retained-provenance.json", retainedEvidence);
      } else if (tree) {
        evidence = await latestRunEvidence(tree.cwd, outcome);
      }
      if (claimed) {
        await adapter.removeLabel(issue, "dev-flow-running");
        // If success writeback partially completed, remove its terminal label before
        // publishing the failure terminal label; never leave both terminal states.
        if (prReadyLabelApplied) await adapter.removeLabel(issue, "dev-flow-pr-ready");
        await adapter.addLabel(issue, "dev-flow-needs-human");
        // Only a retained worktree with freshly written provenance can be resumed;
        // anything past publication is a human-only recovery.
        if (resumable) await adapter.addLabel(issue, "dev-flow-resume");
      } else {
        await adapter.removeLabel(issue, "dev-flow-ready");
        // A resume that failed its own preconditions must not stay selectable, or the next poll
        // reposts this same report; the human re-adds the label together with a fresh decision.
        if (issue.labels.includes("dev-flow-resume")) await adapter.removeLabel(issue, "dev-flow-resume");
        await adapter.addLabel(issue, "dev-flow-needs-human");
      }
      const attempt = claimed ? attemptNumber : (previousAttemptNumber ?? 1);
      const reportOutcome = evidence.outcome;
      const report = renderNeedsHumanReport({
        issueNumber: issue.number, attempt, reason: reportOutcome?.error ?? failure,
        findings: evidence.findings.length ? evidence.findings : [reportOutcome?.error ?? failure],
        attemptedFixes: evidence.attemptedFixes, changedFiles: evidence.changedFiles,
        failedVerification: evidence.failedVerification.length ? evidence.failedVerification : (reportOutcome?.error ? [reportOutcome.error] : [failure]),
        costUsd: reportOutcome?.cost.total, durationMs: reportOutcome?.durationMs,
        // Without a tree this attempt never got that far; report the deterministic path it would
        // have used rather than asserting a state nobody verified.
        worktree: tree?.cwd ?? pushedBranch?.cwd ?? `${worktreePath(config, issue)}（本次未驗證，可能不存在）`,
        branch: tree?.branch ?? pushedBranch?.branch ?? `codex/issue-${issue.number}-${slug(issue.title) || "task"}（本次未驗證，可能不存在）`,
        resumable,
      });
      await adapter.comment(issue, report);
    } catch (writebackError) { await record("writeback-error.txt", String(writebackError)); return { status: "failed", issue, error: `${failure}; issue writeback failed` }; }
    return { status: "failed", issue, error: failure };
    }
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
