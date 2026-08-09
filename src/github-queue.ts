import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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
export interface DraftPullRequest { url: string; number?: number; }
export interface GitHubAdapter {
  listReadyIssues(): Promise<QueueIssue[]>;
  /** Returns false when another worker has already atomically claimed this Issue. */
  claim(issue: QueueIssue): Promise<boolean>;
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
      const json = await gh(["issue", "list", "--repo", repo, "--state", "open", "--label", "dev-flow-ready", "--json", "number,title,body,labels"]);
      const issues = JSON.parse(json) as Array<{ number: number; title: string; body?: string; labels?: Array<{ name: string }> }>;
      all.push(...issues.map((issue) => ({ number: issue.number, title: issue.title, body: issue.body ?? "", labels: (issue.labels ?? []).map((label) => label.name), repository: repo })));
    }
    return all.sort((a, b) => a.number - b.number);
  }
  async claim(issue: QueueIssue): Promise<boolean> {
    // A Git ref creation is a GitHub-side compare-and-set: unlike a label edit it
    // fails if another Mac has already created this Issue's claim ref.
    const repo = JSON.parse(await gh(["api", `repos/${issue.repository}`])) as { default_branch?: string };
    if (!repo.default_branch || !/^[A-Za-z0-9._/-]+$/.test(repo.default_branch)) throw new Error(`GitHub returned an invalid default branch for ${issue.repository}`);
    const head = JSON.parse(await gh(["api", `repos/${issue.repository}/git/ref/heads/${repo.default_branch}`])) as { object?: { sha?: string } };
    const sha = head.object?.sha;
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`GitHub returned an invalid default branch SHA for ${issue.repository}`);
    try {
      await gh(["api", "--method", "POST", `repos/${issue.repository}/git/refs`, "-f", `ref=refs/dev-flow-claims/issue-${issue.number}`, "-f", `sha=${sha}`]);
    } catch (error) {
      const detail = error instanceof Error ? `${error.message}\n${(error as { stderr?: string }).stderr ?? ""}` : String(error);
      if (/Reference already exists|already exists/i.test(detail)) return false;
      throw error;
    }
    await gh(["issue", "edit", String(issue.number), "--repo", issue.repository, "--remove-label", "dev-flow-ready", "--add-label", "dev-flow-running"]);
    return true;
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
  const spec: TaskSpec = {
    repo: "/untrusted-issue-repo", status: "approved", title: issue.title, createdAt: new Date().toISOString(),
    objective: section(text, "Objective"), backgroundAndDecisions: section(text, "Background and decisions"),
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
  if (!payload.git.files.length || payload.git.files.length > MAX_DELIVERY_LIST_ITEMS || !Number.isSafeInteger(payload.git.filesChanged) || payload.git.filesChanged !== payload.git.files.length || !Number.isSafeInteger(payload.git.insertions) || payload.git.insertions < 0 || !Number.isSafeInteger(payload.git.deletions) || payload.git.deletions < 0) throw new Error("missing Git delivery evidence; no PR was published");
  payload.git.files.forEach((file) => { plain(file.path, MAX_DELIVERY_LIST_ITEM_LENGTH); plain(file.status, 32); });
  if (!payload.tests.length || payload.tests.length > MAX_DELIVERY_LIST_ITEMS || payload.tests.some((test) => !plain(test.command, MAX_DELIVERY_LIST_ITEM_LENGTH) || test.passed !== true)) throw new Error("unsuccessful test evidence; no PR was published");
  plain(payload.runId, 256);
}
/** The only PR-body boundary: explicit structured delivery evidence, never a report or agent text. */
export function draftPullRequestBody(payload: DraftPullRequestDelivery): string {
  validateDelivery(payload);
  const bullets = (values: readonly string[]) => values.length ? values.map((value) => `- ${value}`).join("\n") : "- None";
  const files = payload.git.files.map((file) => `- ${plain(file.status, 32)} ${plain(file.path, MAX_DELIVERY_LIST_ITEM_LENGTH)}`).join("\n");
  const tests = payload.tests.map((test) => `- PASS: ${plain(test.command, MAX_DELIVERY_LIST_ITEM_LENGTH)}`).join("\n");
  const body = `Closes #${payload.issueNumber} (review only; not merged)\n\n## Why\nObjective: ${plain(payload.objective)}\n\nBackground and decisions: ${plain(payload.backgroundAndDecisions)}\n\nRisks:\n${bullets(list(payload.risks, "risks"))}\n\nAcceptance criteria:\n${bullets(list(payload.acceptanceCriteria, "acceptanceCriteria"))}\n\n## How\nActual Git changes:\n${files}\n\nGit diff statistics: ${payload.git.filesChanged} files changed, ${payload.git.insertions} insertions(+), ${payload.git.deletions} deletions(-)\n\n## Approved scope\nInclude:\n${bullets(list(payload.approvedInclude, "approvedInclude"))}\n\nActual changed files are listed above for scope-drift review.\n\n## Verification result\nTests:\n${tests}\nReviewer verdict: ${plain(payload.reviewerVerdict, 32)}\nFinal-review verdict: ${plain(payload.finalReviewerVerdict, 32)}\nStatus: ${plain(payload.status, 32)}\nTier: ${payload.tier}\nCycles: ${payload.cycles}\nCost: US$${payload.costUsd.toFixed(5)}\nDuration: ${Math.round(payload.durationMs)} ms\nRun ID: ${plain(payload.runId, 256)}\n\n## Intentionally excluded\n${bullets(list(payload.approvedExclude, "approvedExclude"))}\n\nLocal reports and ledgers remain available only as non-public traceability artifacts.`;
  if (Buffer.byteLength(body, "utf8") > MAX_DRAFT_PR_BODY_BYTES) throw new Error("delivery PR body exceeds conservative GitHub limit; no PR was published");
  return body;
}

async function acquirePollLock(config: QueueConfig, lockPath: string): Promise<boolean> {
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
    let ownerAlive = true;
    if (owner.host === hostname() && Number.isInteger(owner.pid) && owner.pid! > 0) {
      try { process.kill(owner.pid!, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") ownerAlive = false; }
    }
    stale = !ownerAlive || !Number.isFinite(age) || age > pollLockStaleMs;
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

async function worktree(config: QueueConfig, repo: string, issue: QueueIssue): Promise<{ cwd: string; branch: string }> {
  const branch = `codex/issue-${issue.number}-${slug(issue.title) || "task"}`;
  const cwd = join(config.workspaceRoot, ".orchestrator", "worktrees", `${issue.repository.replace("/", "-")}-${issue.number}`);
  await mkdir(dirname(cwd), { recursive: true });
  await git(repo, ["worktree", "add", "-b", branch, cwd, "HEAD"]);
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
    const issues = (await adapter.listReadyIssues()).filter((issue) => !issue.labels.includes("dev-flow-running") && config.allowedRepos.includes(issue.repository));
  const issue = issues[0]; if (!issue) return { status: "idle" };
  const job = `${new Date().toISOString().replace(/[:.]/g, "-")}-${issue.number}-${config.workerId}`;
  const ledger = join(config.ledgerRoot, job); await mkdir(ledger, { recursive: true });
  const record = async (name: string, value: unknown) => writeFile(join(ledger, name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
  await record("issue.json", issue);
  if (config.dryRun) { await record("summary.json", { status: "dry_run", workerId: config.workerId }); return { status: "dry_run", issue }; }
  let claimed = false;
  let prReadyLabelApplied = false;
  let pushedBranch: { cwd: string; branch: string } | undefined;
  try {
    const parsed = parseIssueSpec(issue); const repo = await repoPath(config, issue.repository);
    await git(repo, ["rev-parse", "--is-inside-work-tree"]);
    if (!await adapter.claim(issue)) {
      await record("claim-lost.json", { job, workerId: config.workerId });
      return { status: "idle" };
    }
    claimed = true;
    await adapter.comment(issue, `dev-flow worker claimed this issue. job: ${job}`);
    await record("claim.json", { job, workerId: config.workerId });
    const tree = await worktree(config, repo, issue);
    const specMarkdown = issue.body;
    await mkdir(join(tree.cwd, ".agent", "specs"), { recursive: true });
    await writeFile(join(tree.cwd, ".agent", "specs", `issue-${issue.number}.md`), specMarkdown);
    const handoff = specToHandoff({ ...parsed.spec, repo: tree.cwd });
    const agents = new PiProcessAdapter();
    const classifier: ModelClassifier = { classify: async ({ handoff: h, diff, sessionDir }) => { const result = await agents.run({ role: "router", taskId: "queue-routing", cwd: h.repo, sessionDir, model: classifierModel(), prompt: renderClassifierPrompt(h, diff), artifacts: {} }); const candidate = result.summary.match(/\{[\s\S]*\}/)?.[0]; let parsed: Record<string, unknown> = {}; try { parsed = JSON.parse(candidate ?? "{}"); } catch { parsed = { reasons: ["invalid router JSON"], riskFlags: [] }; } return { ...parsed, costUsd: costOf(result.usage) } as Awaited<ReturnType<ModelClassifier["classify"]>>; } };
    const outcome = await new Orchestrator({ agents, tests: new ShellTestRunner(), classifier }).run(handoff, console.log, { specMarkdown, specTitle: issue.title, maxTier: Math.min(config.maxTier, parsed.maxTier) as Tier });
    await record("outcome.json", outcome);
    if (outcome.status !== "ready_for_main") throw new Error(`orchestrator ended with ${outcome.status}; no push or PR was made`);
    const files = publicationFiles(
      await git(tree.cwd, ["diff", "--name-only"]),
      await git(tree.cwd, ["diff", "--cached", "--name-only"]),
      await git(tree.cwd, ["ls-files", "--others", "--exclude-standard"]),
    );
    if (!files.length || files.some((file) => file.startsWith("../") || file.startsWith("/"))) throw new Error("no safe changes to publish");
    await git(tree.cwd, ["add", "--", ...files]); await git(tree.cwd, ["commit", "--only", "-m", `codex: issue #${issue.number}`, "--", ...files]);
    const prBody = draftPullRequestBody({
      issueNumber: issue.number, objective: parsed.spec.objective, backgroundAndDecisions: parsed.spec.backgroundAndDecisions,
      risks: parsed.spec.risks, acceptanceCriteria: parsed.spec.acceptanceCriteria, approvedInclude: parsed.spec.modificationScope,
      approvedExclude: parsed.spec.excludedScope, git: await gitDeliveryEvidence(tree.cwd), tests: outcome.verification.tests,
      reviewerVerdict: outcome.verification.reviewerVerdict, finalReviewerVerdict: outcome.verification.finalReviewerVerdict, status: outcome.status, tier: outcome.tier, cycles: outcome.cycles,
      costUsd: outcome.cost.total, durationMs: outcome.durationMs, runId: outcome.runId,
    });
    await git(tree.cwd, ["push", "--set-upstream", "origin", tree.branch]); pushedBranch = tree;
    const pr = await adapter.createDraftPullRequest(issue.repository, tree.branch, `Draft: ${issue.title}`, prBody);
    await adapter.removeLabel(issue, "dev-flow-running"); await adapter.addLabel(issue, "dev-flow-pr-ready"); prReadyLabelApplied = true; await adapter.comment(issue, `Draft PR ready for review: ${pr.url}\nJob: ${job}`); await record("summary.json", { status: "success", pr, outcome }); return { status: "success", issue };
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
    const failure = cleanupError ? `${message}; remote branch cleanup failed: ${cleanupError}` : message;
    await record("error.txt", failure); await record("summary.json", { status: "failed", error: failure });
    try {
      if (claimed) {
        await adapter.removeLabel(issue, "dev-flow-running");
        // If success writeback partially completed, remove its terminal label before
        // publishing the failure terminal label; never leave both terminal states.
        if (prReadyLabelApplied) await adapter.removeLabel(issue, "dev-flow-pr-ready");
        await adapter.addLabel(issue, "dev-flow-needs-human");
      } else { await adapter.removeLabel(issue, "dev-flow-ready"); await adapter.addLabel(issue, "dev-flow-needs-human"); }
      await adapter.comment(issue, `dev-flow needs human attention. job: ${job}\n\n${failure}`);
    } catch (writebackError) { await record("writeback-error.txt", String(writebackError)); return { status: "failed", issue, error: `${failure}; issue writeback failed` }; }
    return { status: "failed", issue, error: failure };
    }
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
