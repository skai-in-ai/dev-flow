import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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
export interface QueueIssue { number: number; title: string; body: string; labels: string[]; repository: string; }
export interface QueueComment { id: number; author: string; body: string; createdAt: string; }
export interface DraftPullRequest { url: string; number?: number; }
export interface QueueClaim { defaultBranch: string; sha: string; attempt?: number; claimRef?: string; }
export interface ResumeContext { attempt: number; decision: string; decisionAuthor: string; previousOutcome: RunOutcome; decisionLog: string; findings: string[]; attemptedFixes: string[]; testEvidence: Array<{ command: string; passed: boolean }>; cycles: Array<{ cycle: number; attemptedFix: string; findings: string[] }>; changedFiles: string[]; failedVerification: string[]; }
export interface NeedsHumanReport { issueNumber: number; attempt: number; reason: string; cycles: Array<{ cycle: number; attemptedFix: string; findings: string[] }>; findings: string[]; changedFiles: string[]; failedVerification: string[]; costUsd: number; durationMs: number; worktree: string; branch: string; resumeInstructions: string; }
export interface AttemptEvidence { attempt: number; reason: string; cycles: Array<{ cycle: number; attemptedFix: string; findings: string[] }>; findings: string[]; changedFiles: string[]; failedVerification: string[]; testEvidence: Array<{ command: string; passed: boolean }>; resumeDecision?: string; decisionAuthor?: string; costUsd: number; durationMs: number; }

export function claimRef(issue: QueueIssue, attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer");
  return `refs/dev-flow-claims/${worktreeKey(issue.repository)}-issue-${issue.number}-attempt-${attempt}`;
}
export function nextAttempt(previous: number | undefined): number { return previous === undefined ? 1 : previous + 1; }
export function renderNeedsHumanReport(report: NeedsHumanReport): string {
  const bullet = (items: readonly string[]) => items.length ? items.map((item) => "- " + item).join("\n") : "- 無";
  const resume = report.resumeInstructions.trim() || "請由具 repository 寫入權限的協作者在本 Issue 新增 label dev-flow-resume，並留下新的 /dev-flow resume <decision> comment。decision 必須明確選擇 narrow fix、rebuild 或 cancel；系統會驗證授權、時效與 retained worktree provenance。";
  const cycles = report.cycles.map((cycle) => [
    "#### Cycle " + cycle.cycle,
    "嘗試：" + cycle.attemptedFix,
    "未解 findings：",
    bullet(cycle.findings),
  ].join("\n")).join("\n\n") || "- 無";
  return [
    "<!-- dev-flow-needs-human-attempt:" + report.attempt + " -->",
    "## dev-flow 需要人工決策",
    "",
    "### Attempt " + report.attempt + " 停止原因", report.reason,
    "", "### 每個 cycle 嘗試修法", cycles,
    "", "### 累積未解 findings", bullet(report.findings),
    "", "### 變更檔案", bullet(report.changedFiles),
    "", "### 失敗驗證", bullet(report.failedVerification),
    "", "### 成本與時間", "成本：US$" + report.costUsd.toFixed(5) + "；耗時：" + Math.round(report.durationMs) + " ms",
    "", "### Resume", resume,
    "", "保留 worktree：" + report.worktree + "；branch：" + report.branch + "。",
  ].join("\n");
}

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
  if (decision.toLowerCase() !== "cancel" && decision.toLowerCase() !== "rebuild" && !/^narrow fix(?: .+)?$/i.test(decision)) return undefined;
  return decision;
}
export interface GitHubAdapter {
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
      const queries = ["dev-flow-ready", "dev-flow-resume"];
      for (const label of queries) {
        const json = await gh(["issue", "list", "--repo", repo, "--state", "open", "--label", label, "--json", "number,title,body,labels"]);
        const issues = JSON.parse(json) as Array<{ number: number; title: string; body?: string; labels?: Array<{ name: string }> }>;
        all.push(...issues.map((issue) => ({ number: issue.number, title: issue.title, body: issue.body ?? "", labels: (issue.labels ?? []).map((label) => label.name), repository: repo })));
      }
    }
    return [...new Map(all.map((item) => [`${item.repository}#${item.number}`, item])).values()].sort((a, b) => a.number - b.number);
  }
  async listComments(issue: QueueIssue): Promise<QueueComment[]> {
    const json = await gh(["issue", "view", String(issue.number), "--repo", issue.repository, "--json", "comments"]);
    const value = JSON.parse(json) as { comments?: Array<{ id?: number; author?: { login?: string }; body?: string; createdAt?: string }> };
    return (value.comments ?? []).map((comment) => ({ id: comment.id ?? 0, author: comment.author?.login ?? "", body: comment.body ?? "", createdAt: comment.createdAt ?? "" }));
  }
  async isAuthorized(issue: QueueIssue, author: string): Promise<boolean> {
    try {
      const endpoint = "repos/" + issue.repository + "/collaborators/" + encodeURIComponent(author) + "/permission";
      const value = JSON.parse(await gh(["api", endpoint])) as { permission?: string };
      return value.permission === "push" || value.permission === "maintain" || value.permission === "admin";
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
  attempts?: AttemptEvidence[];
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
  if (payload.attempts !== undefined) {
    if (!payload.attempts.length || payload.attempts.length > MAX_DELIVERY_LIST_ITEMS || payload.attempts.some((attempt) => !Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1 || !Number.isFinite(attempt.costUsd) || attempt.costUsd < 0 || !Number.isFinite(attempt.durationMs) || attempt.durationMs < 0 || !Array.isArray(attempt.testEvidence))) throw new Error("malformed cumulative attempt evidence; no PR was published");
    payload.attempts.forEach((attempt) => { plain(attempt.reason); list(attempt.findings, "attempt findings"); list(attempt.changedFiles, "attempt changedFiles"); list(attempt.failedVerification, "attempt failedVerification"); attempt.testEvidence.forEach((test) => { plain(test.command, MAX_DELIVERY_LIST_ITEM_LENGTH); if (typeof test.passed !== "boolean") throw new Error("malformed cumulative attempt test evidence; no PR was published"); }); if (attempt.resumeDecision !== undefined) plain(attempt.resumeDecision, MAX_DELIVERY_LIST_ITEM_LENGTH); if (attempt.decisionAuthor !== undefined) plain(attempt.decisionAuthor, MAX_DELIVERY_LIST_ITEM_LENGTH); });
  }
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
  const attempts = (payload.attempts ?? [{ attempt: 1, reason: payload.status, cycles: [], findings: [], changedFiles: [], failedVerification: [], testEvidence: payload.tests, costUsd: payload.costUsd, durationMs: payload.durationMs }]).map((attempt) => {
    const evidence = attempt.testEvidence.map((test) => `${test.passed ? "PASS" : "FAIL"} ${plain(test.command, MAX_DELIVERY_LIST_ITEM_LENGTH)}`).join("；") || "無";
    return `### Attempt ${attempt.attempt}\n原因：${plain(attempt.reason)}\nResume 決策：${plain(attempt.resumeDecision ?? "初次執行", MAX_DELIVERY_LIST_ITEM_LENGTH)}\nFindings：${bullets(list(attempt.findings, "attempt findings"))}\n變更檔案：${bullets(list(attempt.changedFiles, "attempt changedFiles"))}\n失敗驗證：${bullets(list(attempt.failedVerification, "attempt failedVerification"))}\n測試證據：${evidence}\nCycles：${attempt.cycles.length}\n成本：US$${attempt.costUsd.toFixed(5)}；耗時：${Math.round(attempt.durationMs)} ms`;
  }).join("\n\n");
  const body = `Issue #${payload.issueNumber}（僅供 review；不會 merge）\n\n## 累積 Attempts\n${attempts}\n\n## 為何\n目標：${plain(payload.objective)}\n\n背景與決策：${plain(payload.backgroundAndDecisions)}\n\n風險：\n${bullets(list(payload.risks, "risks"))}\n\n驗收條件：\n${bullets(list(payload.acceptanceCriteria, "acceptanceCriteria"))}\n\n## 如何完成\n實際 Git 變更：\n${files}\n\nGit diff 統計：${payload.git.filesChanged} 個檔案變更，新增 ${payload.git.insertions} 行，刪除 ${payload.git.deletions} 行\n\n## 核准範圍\n包含：\n${bullets(list(payload.approvedInclude, "approvedInclude"))}\n\n實際變更檔案列於上方，供檢查是否超出範圍。\n\n## 驗證結果\n測試：\n${tests}\n審查 verdict：${plain(payload.reviewerVerdict, 32)}\n最終審查 verdict：${plain(payload.finalReviewerVerdict, 32)}\n狀態：${plain(payload.status, 32)}\nTier：${payload.tier}\nCycles：${payload.cycles}\n成本：US$${payload.costUsd.toFixed(5)}\n耗時：${Math.round(payload.durationMs)} ms\nRun ID：${plain(payload.runId, 256)}\n\n## 刻意排除\n${bullets(list(payload.approvedExclude, "approvedExclude"))}\n\n本機報告與 ledger 僅保留作非公開追溯資料。`;
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

export interface RetainedWorktreeProvenance {
  repository: string; issueNumber: number; branch: string; cwd: string; baselineSha: string; status: string; recordedAt: string;
  attempt?: number; previousOutcome?: RunOutcome; decisionLog?: string; findings?: string[]; attemptedFixes?: string[];
  testEvidence?: Array<{ command: string; passed: boolean }>; cycles?: Array<{ cycle: number; attemptedFix: string; findings: string[] }>;
  changedFiles?: string[]; failedVerification?: string[]; costUsd?: number; durationMs?: number; attempts?: AttemptEvidence[];
}

function worktreeKey(repository: string): string {
  return canonicalRepository(repository).split("/").map((part) => `${part.length}-${part}`).join("_");
}
export function worktreePath(config: QueueConfig, issue: QueueIssue): string {
  return join(resolve(config.workspaceRoot), ".orchestrator", "worktrees", `${worktreeKey(issue.repository)}-issue-${issue.number}`);
}
async function validateWorktreeIdentity(cwd: string, issue: QueueIssue, expectedBranch?: string): Promise<void> {
  const actualCwd = await realpath(cwd);
  const topLevel = await realpath((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
  if (actualCwd !== topLevel) throw new Error("retained path is not the Git worktree root");
  if (canonicalOrigin(await git(cwd, ["remote", "get-url", "origin"])) !== canonicalRepository(issue.repository)) throw new Error("retained worktree origin does not match the Issue repository");
  const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (expectedBranch !== undefined && branch !== expectedBranch) throw new Error("retained worktree branch does not match the Issue branch");
}

export async function validateRetainedWorktree(provenance: RetainedWorktreeProvenance, issue: QueueIssue, expectedCwd?: string, expectedBranch?: string): Promise<void> {
  if (provenance.repository !== issue.repository || provenance.issueNumber !== issue.number || !validBranchName(provenance.branch) || !isAbsolute(provenance.cwd) || !/^[0-9a-f]{40}$/i.test(provenance.baselineSha)) throw new Error("retained worktree provenance is invalid");
  if (provenance.previousOutcome?.status === "ready_for_main") throw new Error("ready_for_main provenance cannot be resumed");
  if (expectedCwd === undefined) throw new Error("retained worktree expected path is required");
  if (await realpath(provenance.cwd) !== await realpath(expectedCwd)) throw new Error("retained worktree path does not match the Issue worktree");
  await validateWorktreeIdentity(provenance.cwd, issue, expectedBranch ?? provenance.branch);
  const actual = (await git(provenance.cwd, ["status", "--porcelain", "--untracked-files=all"])).trim();
  if (actual !== provenance.status.trim()) throw new Error("retained worktree changed outside the recorded checkpoint");
  if ((await git(provenance.cwd, ["rev-parse", "HEAD"])).trim().toLowerCase() !== provenance.baselineSha.toLowerCase()) throw new Error("retained worktree HEAD does not match provenance");
}

async function retainedPath(config: QueueConfig, issue: QueueIssue): Promise<string> {
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

async function priorQueueLedger(config: QueueConfig, issue: QueueIssue, attempt: number): Promise<{ path: string; outcome?: RunOutcome }> {
  const entries = await readdir(config.ledgerRoot, { withFileTypes: true }).catch(() => []);
  let matching: { path: string; outcome?: RunOutcome } | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = join(config.ledgerRoot, entry.name);
    let priorIssue: QueueIssue;
    try { priorIssue = JSON.parse(await readFile(join(root, "issue.json"), "utf8")) as QueueIssue; } catch (error) {
      throw new Error(`prior queue ledger is corrupt: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (canonicalRepository(priorIssue.repository) !== canonicalRepository(issue.repository) || priorIssue.number !== issue.number) continue;
    let claim: QueueClaim & { repository?: string; issueNumber?: number; attempt?: number };
    try { claim = JSON.parse(await readFile(join(root, "claim.json"), "utf8")) as QueueClaim & { repository?: string; issueNumber?: number; attempt?: number }; } catch (error) {
      throw new Error(`prior queue claim ledger is corrupt: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (claim.repository !== issue.repository || claim.issueNumber !== issue.number || claim.attempt !== attempt) continue;
    if (claim.claimRef !== undefined && claim.claimRef !== claimRef(issue, attempt)) throw new Error("prior queue claim identity is corrupt");
    let summary: { status?: string; outcome?: RunOutcome };
    try { summary = JSON.parse(await readFile(join(root, "summary.json"), "utf8")) as { status?: string; outcome?: RunOutcome }; } catch (error) {
      throw new Error(`prior queue summary ledger is corrupt: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (summary.status !== "failed" && summary.status !== "success") throw new Error("prior queue summary ledger is incomplete");
    let outcome = summary.outcome;
    try {
      const rawOutcome = await readFile(join(root, "outcome.json"), "utf8");
      outcome = JSON.parse(rawOutcome) as RunOutcome;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`prior queue outcome ledger is corrupt: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!outcome) {
      const runsRoot = join(worktreePath(config, issue), ".orchestrator", "runs");
      const runs = await readdir(runsRoot).catch(() => [] as string[]);
      const latest = runs.sort().at(-1);
      if (latest) {
        try { outcome = JSON.parse(await readFile(join(runsRoot, latest, "summary.json"), "utf8")) as RunOutcome; }
        catch (error) { throw new Error(`prior run ledger is corrupt: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    if (summary.status === "success" || outcome?.status === "ready_for_main") throw new Error("prior attempt already reached ready_for_main; resume is forbidden");
    matching = { path: root, outcome };
  }
  if (!matching) throw new Error("prior queue ledger is missing; choose rebuild or cancel explicitly");
  return matching;
}

export function cumulativeResumeEvidence(provenance: RetainedWorktreeProvenance): Pick<ResumeContext, "decisionLog" | "findings" | "attemptedFixes" | "testEvidence" | "cycles" | "changedFiles" | "failedVerification"> {
  const attempts = [...(provenance.attempts ?? [])].sort((a, b) => a.attempt - b.attempt);
  const unique = (values: readonly string[]) => [...new Set(values.filter(Boolean))];
  const decisions = attempts.filter((attempt) => attempt.resumeDecision).map((attempt) => `Attempt ${attempt.attempt} resume decision by ${attempt.decisionAuthor ?? "unknown"}: ${attempt.resumeDecision}`);
  return {
    decisionLog: [provenance.decisionLog, ...decisions].filter(Boolean).join("\n\n"),
    findings: unique([...attempts.flatMap((attempt) => attempt.findings), ...(provenance.findings ?? [])]),
    attemptedFixes: unique([...attempts.flatMap((attempt) => attempt.cycles.map((cycle) => cycle.attemptedFix)), ...(provenance.attemptedFixes ?? [])]),
    testEvidence: attempts.flatMap((attempt) => attempt.testEvidence).concat(provenance.testEvidence ?? []),
    cycles: attempts.flatMap((attempt) => attempt.cycles).concat(provenance.cycles ?? []),
    changedFiles: unique([...attempts.flatMap((attempt) => attempt.changedFiles), ...(provenance.changedFiles ?? [])]),
    failedVerification: unique([...attempts.flatMap((attempt) => attempt.failedVerification), ...(provenance.failedVerification ?? [])]),
  };
}

async function latestRunEvidence(cwd: string, outcome: RunOutcome | undefined): Promise<{ outcome?: RunOutcome; decisionLog: string; findings: string[]; attemptedFixes: string[]; cycles: Array<{ cycle: number; attemptedFix: string; findings: string[] }>; changedFiles: string[]; failedVerification: string[]; testEvidence: Array<{ command: string; passed: boolean }> }> {
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
      attemptedFixes = responseRecords.map((entry) => entry.text);
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
  const attemptedByCycle = (cycle: number): string => implementerRecords.find((entry) => entry.cycle === cycle)?.summary ?? responseRecords.find((entry) => entry.round === cycle)?.text ?? "依 handoff 執行實作與 review";
  const cycles = [...new Set([...(previousOutcome ? Array.from({ length: previousOutcome.cycles }, (_, index) => index + 1) : []), ...findingRecords.map((entry) => entry.round), ...responseRecords.map((entry) => entry.round), ...implementerRecords.map((entry) => entry.cycle)])].sort((a, b) => a - b).map((cycle) => ({ cycle, attemptedFix: attemptedByCycle(cycle), findings: findingRecords.filter((entry) => entry.round === cycle).map((entry) => entry.text) }));
  attemptedFixes = implementerRecords.map((entry) => entry.summary);
  if (!attemptedFixes.length) attemptedFixes = responseRecords.map((entry) => entry.text);
  const status = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  const changedFiles = status.split("\n").filter(Boolean).map((line) => line.slice(3).split(" -> ").at(-1) ?? "").filter((file) => file && !file.startsWith(".orchestrator/") && !file.startsWith(".agent/specs/"));
  return { outcome: previousOutcome, decisionLog, findings, attemptedFixes, cycles, changedFiles, failedVerification, testEvidence };
}

async function writeRetainedProvenance(cwd: string, issue: QueueIssue, branch: string, attempt: number, outcome: RunOutcome | undefined, reason = "流程停止", resumeDecision?: { decision: string; author: string }): Promise<RetainedWorktreeProvenance> {
  const evidence = await latestRunEvidence(cwd, outcome);
  let priorAttempts: AttemptEvidence[] = [];
  try {
    const previous = JSON.parse(await readFile(join(cwd, ".orchestrator", "queue-provenance.json"), "utf8")) as RetainedWorktreeProvenance;
    priorAttempts = (previous.attempts ?? []).filter((entry) => entry.attempt < attempt);
  } catch { /* first attempt or an explicitly recovered provenance */ }
  const currentAttempt: AttemptEvidence = {
    attempt, reason, cycles: evidence.cycles, findings: evidence.findings, changedFiles: evidence.changedFiles,
    failedVerification: evidence.failedVerification, testEvidence: evidence.testEvidence,
    ...(resumeDecision ? { resumeDecision: resumeDecision.decision, decisionAuthor: resumeDecision.author } : {}),
    costUsd: evidence.outcome?.cost.total ?? 0, durationMs: evidence.outcome?.durationMs ?? 0,
  };
  const provenance: RetainedWorktreeProvenance = {
    repository: issue.repository, issueNumber: issue.number, branch, cwd,
    baselineSha: (await git(cwd, ["rev-parse", "HEAD"])).trim(),
    status: (await git(cwd, ["status", "--porcelain", "--untracked-files=all"])).trim(), recordedAt: new Date().toISOString(), attempt,
    previousOutcome: evidence.outcome, decisionLog: evidence.decisionLog, findings: evidence.findings, attemptedFixes: evidence.attemptedFixes,
    testEvidence: evidence.testEvidence, cycles: evidence.cycles, changedFiles: evidence.changedFiles, failedVerification: evidence.failedVerification,
    costUsd: evidence.outcome?.cost.total ?? 0, durationMs: evidence.outcome?.durationMs ?? 0, attempts: [...priorAttempts, currentAttempt],
  };
  await writeFile(join(cwd, ".orchestrator", "queue-provenance.json"), JSON.stringify(provenance, null, 2));
  return provenance;
}

export async function worktree(config: QueueConfig, repo: string, issue: QueueIssue, claim: QueueClaim, retained?: RetainedWorktreeProvenance, rebuild = false): Promise<{ cwd: string; branch: string }> {
  if (!validBranchName(claim.defaultBranch) || !/^[0-9a-f]{40}$/i.test(claim.sha)) throw new Error("invalid claimed remote base");
  const branch = `codex/issue-${issue.number}-${slug(issue.title) || "task"}`;
  const cwd = worktreePath(config, issue);
  if (retained) { await validateRetainedWorktree(retained, issue, cwd, branch); return { cwd, branch }; }
  if (rebuild && await realpath(cwd).then(() => true).catch(() => false)) {
    throw new Error("explicit rebuild cannot use an existing worktree without retained provenance validation");
  }
  await mkdir(dirname(cwd), { recursive: true });
  const remoteRef = `refs/remotes/origin/${claim.defaultBranch}`;
  await git(repo, ["fetch", "origin", `+refs/heads/${claim.defaultBranch}:${remoteRef}`]);
  const fetchedSha = (await git(repo, ["rev-parse", remoteRef])).trim().toLowerCase();
  if (fetchedSha !== claim.sha.toLowerCase()) throw new Error("fetched default branch does not match claimed SHA");
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

export async function pollOnce(adapter: GitHubAdapter, config: QueueConfig): Promise<{ status: "idle" | "dry_run" | "success" | "failed"; issue?: QueueIssue; error?: string }> {
  await mkdir(config.ledgerRoot, { recursive: true });
  const lockPath = join(config.workspaceRoot, ".orchestrator", "queue-poll.lock");
  await mkdir(dirname(lockPath), { recursive: true });
  if (!await acquirePollLock(config, lockPath)) return { status: "idle" };
  try {
    const issues = (await adapter.listReadyIssues()).filter((issue) => !issue.labels.includes("dev-flow-running") && !issue.labels.includes("dev-flow-pr-ready") && (issue.labels.includes("dev-flow-ready") || issue.labels.includes("dev-flow-resume")) && config.allowedRepos.includes(issue.repository));
  const issue = issues[0]; if (!issue) return { status: "idle" };
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
  let rebuild = false;
  try {
    const parsed = parseIssueSpec(issue); const repo = await repoPath(config, issue.repository);
    await git(repo, ["rev-parse", "--is-inside-work-tree"]);
    const isResume = issue.labels.includes("dev-flow-resume");
    let retained: RetainedWorktreeProvenance | undefined;
    if (isResume) {
      if (issue.labels.includes("dev-flow-pr-ready")) throw new Error("此 Issue 已有 Draft PR，禁止再次 resume");
      if (!adapter.listComments || !adapter.isAuthorized) throw new Error("resume requires GitHub comment authorization support");
      const comments = await adapter.listComments(issue);
      if (hasPublishedPullRequestComment(comments)) throw new Error("此 Issue 已有 Draft PR 歷程，禁止再次 resume");
      const reports = comments.map((comment) => ({ comment, attempt: reportAttempt(comment) })).filter((entry): entry is { comment: QueueComment; attempt: number } => entry.attempt !== undefined).sort((a, b) => Date.parse(a.comment.createdAt) - Date.parse(b.comment.createdAt));
      const previous = reports.at(-1);
      if (!previous) throw new Error("找不到上一個 needs-human attempt 報告，拒絕 resume");
      const previousAttempt = previous.attempt;
      previousAttemptNumber = previousAttempt;
      attemptNumber = nextAttempt(previousAttempt);
      const candidate = [...comments].reverse().find((comment) => parseResumeDecision(comment, previousAttempt, previous.comment.createdAt));
      if (!candidate || !(await adapter.isAuthorized(issue, candidate.author))) throw new Error("resume decision is unauthorized, stale, empty, or ambiguous");
      const decision = parseResumeDecision(candidate, previousAttempt, previous.comment.createdAt);
      if (!decision) throw new Error("resume decision is invalid");
      if (decision.toLowerCase() === "cancel") {
        await adapter.removeLabel(issue, "dev-flow-resume");
        await adapter.addLabel(issue, "dev-flow-needs-human");
        await adapter.comment(issue, `已依授權的 Attempt ${previousAttempt} resume cancel 決策停止；未呼叫 agent，也未修改 retained worktree。`);
        await record("summary.json", { status: "cancelled", attempt: previousAttempt, decision, decisionAuthor: candidate.author });
        return { status: "failed", issue, error: "resume cancelled by authorized decision" };
      }
      const prior = await priorQueueLedger(config, issue, previousAttempt);
      let provenance: RetainedWorktreeProvenance | undefined;
      let provenanceError: string | undefined;
      try { provenance = JSON.parse(await readFile(await retainedPath(config, issue), "utf8")) as RetainedWorktreeProvenance; }
      catch (error) { provenanceError = error instanceof Error ? error.message : String(error); }
      const expectedBranch = `codex/issue-${issue.number}-${slug(issue.title) || "task"}`;
      if (provenance && provenance.attempt !== undefined && provenance.attempt !== previousAttempt) throw new Error("retained attempt identity does not match the latest needs-human report");
      if (decision.toLowerCase() !== "rebuild") {
        if (provenanceError) throw new Error(`retained worktree provenance is missing or corrupt; choose rebuild or cancel explicitly: ${provenanceError}`);
        await validateRetainedWorktree(provenance as RetainedWorktreeProvenance, issue, worktreePath(config, issue), expectedBranch);
        retained = provenance;
      } else {
        rebuild = true;
        if (provenance) {
          await validateRetainedWorktree(provenance, issue, worktreePath(config, issue), expectedBranch);
          retained = provenance;
        }
      }
      const previousOutcome = provenance?.previousOutcome ?? prior.outcome;
      if (!previousOutcome) throw new Error("prior outcome evidence is missing; choose cancel explicitly");
      if (previousOutcome.status === "ready_for_main") throw new Error("ready_for_main attempt or published PR cannot be resumed");
      const history = provenance ? cumulativeResumeEvidence(provenance) : undefined;
      resumeContext = {
        attempt: nextAttempt(previousAttempt), decision, decisionAuthor: candidate.author, previousOutcome,
        decisionLog: history?.decisionLog || "NO PRIOR ROUNDS.", findings: history?.findings ?? [], attemptedFixes: history?.attemptedFixes ?? [],
        testEvidence: history?.testEvidence.length ? history.testEvidence : previousOutcome.verification.tests, cycles: history?.cycles ?? [], changedFiles: history?.changedFiles ?? [], failedVerification: history?.failedVerification ?? [],
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
    tree = await worktree(config, repo, issue, claim, retained, rebuild);
    const specMarkdown = issue.body;
    await mkdir(join(tree.cwd, ".agent", "specs"), { recursive: true });
    await writeFile(join(tree.cwd, ".agent", "specs", `issue-${issue.number}.md`), specMarkdown);
    const handoff = specToHandoff({ ...parsed.spec, repo: tree.cwd });
    const agents = new PiProcessAdapter();
    const classifier: ModelClassifier = { classify: async ({ handoff: h, diff, sessionDir }) => { const result = await agents.run({ role: "router", taskId: "queue-routing", cwd: h.repo, sessionDir, model: classifierModel(), prompt: renderClassifierPrompt(h, diff), artifacts: {} }); const candidate = result.summary.match(/\{[\s\S]*\}/)?.[0]; let parsed: Record<string, unknown> = {}; try { parsed = JSON.parse(candidate ?? "{}"); } catch { parsed = { reasons: ["invalid router JSON"], riskFlags: [] }; } return { ...parsed, costUsd: costOf(result.usage) } as Awaited<ReturnType<ModelClassifier["classify"]>>; } };
    outcome = await new Orchestrator({ agents, tests: new ShellTestRunner(), classifier }).run(handoff, console.log, { specMarkdown, specTitle: issue.title, maxTier: Math.min(config.maxTier, parsed.maxTier) as Tier, ...(resumeContext ? { resume: { attempt: resumeContext.attempt, decision: resumeContext.decision, decisionLog: resumeContext.decisionLog, findings: resumeContext.findings, attemptedFixes: resumeContext.attemptedFixes, testEvidence: resumeContext.testEvidence }, allowRetainedChanges: true } : {}) });
    await record("outcome.json", outcome);
    if (outcome.status !== "ready_for_main") {
      await writeRetainedProvenance(tree.cwd, issue, tree.branch, attemptNumber, outcome, outcome.error ?? `orchestrator ended with ${outcome.status}; no push or PR was made`);
      throw new Error(`orchestrator ended with ${outcome.status}; no push or PR was made`);
    }
    const files = publicationFiles(
      await git(tree.cwd, ["diff", "--name-only"]),
      await git(tree.cwd, ["diff", "--cached", "--name-only"]),
      await git(tree.cwd, ["ls-files", "--others", "--exclude-standard"]),
    );
    if (!files.length || files.some((file) => file.startsWith("../") || file.startsWith("/"))) throw new Error("no safe changes to publish");
    await git(tree.cwd, ["add", "--", ...files]); await git(tree.cwd, ["commit", "--only", "-m", `codex: issue #${issue.number}`, "--", ...files]);
    const currentEvidence = await latestRunEvidence(tree.cwd, outcome);
    const currentAttemptEvidence: AttemptEvidence = {
      attempt: resumeContext?.attempt ?? 1, reason: outcome.error ?? "ready_for_main", cycles: currentEvidence.cycles,
      findings: currentEvidence.findings, changedFiles: currentEvidence.changedFiles, failedVerification: currentEvidence.failedVerification,
      testEvidence: currentEvidence.testEvidence, ...(resumeContext ? { resumeDecision: resumeContext.decision, decisionAuthor: resumeContext.decisionAuthor } : {}),
      costUsd: outcome.cost.total, durationMs: outcome.durationMs,
    };
    const cumulativeAttempts = [...(retained?.attempts ?? []), currentAttemptEvidence];
    const prBody = draftPullRequestBody({
      issueNumber: issue.number, objective: parsed.spec.objective, backgroundAndDecisions: parsed.spec.backgroundAndDecisions,
      risks: parsed.spec.risks, acceptanceCriteria: parsed.spec.acceptanceCriteria, approvedInclude: parsed.spec.modificationScope,
      approvedExclude: parsed.spec.excludedScope, git: await gitDeliveryEvidence(tree.cwd), tests: outcome.verification.tests,
      reviewerVerdict: outcome.verification.reviewerVerdict, finalReviewerVerdict: outcome.verification.finalReviewerVerdict, status: outcome.status, tier: outcome.tier, cycles: outcome.cycles,
      costUsd: outcome.cost.total, durationMs: outcome.durationMs, runId: outcome.runId, attempts: cumulativeAttempts,
    });
    await git(tree.cwd, ["push", "--set-upstream", "origin", tree.branch]); pushedBranch = tree;
    const pr = await adapter.createDraftPullRequest(issue.repository, tree.branch, `Draft: ${issue.title}`, prBody);
    draftPrCreated = true;
    await adapter.removeLabel(issue, "dev-flow-running"); await adapter.addLabel(issue, "dev-flow-pr-ready"); prReadyLabelApplied = true; await adapter.comment(issue, `Draft PR 已建立：${pr.url}\nJob：${job}\n此 Issue 不可再次 resume。`); await record("summary.json", { status: "success", pr, outcome }); return { status: "success", issue };
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
    let evidence: Awaited<ReturnType<typeof latestRunEvidence>> = { outcome, decisionLog: "", findings: [], attemptedFixes: [], cycles: [], changedFiles: [], failedVerification: [], testEvidence: [] };
    try {
      if (tree && !draftPrCreated && outcome?.status !== "ready_for_main") {
        const retainedEvidence = await writeRetainedProvenance(tree.cwd, issue, tree.branch, attemptNumber, outcome, outcome?.error ?? failure, resumeContext ? { decision: resumeContext.decision, author: resumeContext.decisionAuthor } : undefined);
        evidence = { outcome: retainedEvidence.previousOutcome, decisionLog: retainedEvidence.decisionLog ?? "", findings: retainedEvidence.findings ?? [], attemptedFixes: retainedEvidence.attemptedFixes ?? [], cycles: retainedEvidence.cycles ?? [], changedFiles: retainedEvidence.changedFiles ?? [], failedVerification: retainedEvidence.failedVerification ?? [], testEvidence: retainedEvidence.testEvidence ?? [] };
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
        if (!draftPrCreated && outcome?.status !== "ready_for_main") await adapter.addLabel(issue, "dev-flow-resume");
      } else { await adapter.removeLabel(issue, "dev-flow-ready"); await adapter.addLabel(issue, "dev-flow-needs-human"); }
      const attempt = claimed ? attemptNumber : (previousAttemptNumber ?? 1);
      const reportOutcome = evidence.outcome;
      const report = renderNeedsHumanReport({
        issueNumber: issue.number, attempt, reason: reportOutcome?.error ?? failure, cycles: evidence.cycles.length ? evidence.cycles : [{ cycle: attempt, attemptedFix: evidence.attemptedFixes.at(-1) ?? "依 handoff 執行實作與 review", findings: evidence.findings.length ? evidence.findings : [reportOutcome?.error ?? failure] }],
        findings: evidence.findings.length ? evidence.findings : [reportOutcome?.error ?? failure], changedFiles: evidence.changedFiles, failedVerification: evidence.failedVerification.length ? evidence.failedVerification : (reportOutcome?.error ? [reportOutcome.error] : [failure]),
        costUsd: reportOutcome?.cost.total ?? 0, durationMs: reportOutcome?.durationMs ?? 0, worktree: tree?.cwd ?? pushedBranch?.cwd ?? "保留 worktree 狀態待 provenance 驗證", branch: tree?.branch ?? pushedBranch?.branch ?? "保留 branch", resumeInstructions: outcome?.status === "ready_for_main" ? "此 Attempt 已通過 ready_for_main；publication/writeback 需要人工處理，不可再次 resume。" : "請確認 retained worktree provenance 未被外部修改；若選擇 narrow fix，請新增 label `dev-flow-resume` 並留下新的 `/dev-flow resume narrow fix <說明>` comment。若 provenance 遺失或損壞，請明確選擇 rebuild 或 cancel；系統不會靜默重建。",
      });
      await adapter.comment(issue, report);
    } catch (writebackError) { await record("writeback-error.txt", String(writebackError)); return { status: "failed", issue, error: `${failure}; issue writeback failed` }; }
    return { status: "failed", issue, error: failure };
    }
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
