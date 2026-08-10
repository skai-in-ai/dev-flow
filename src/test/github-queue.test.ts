import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { specToHandoff } from "../spec.js";
import { acquirePollLock, claimRef, reclaimWorktree, draftPullRequestBody, MAX_DRAFT_PR_BODY_BYTES, MAX_DELIVERY_LIST_ITEM_LENGTH, nextAttempt, orderQueue, parseIssueSpec, parseResumeDecision, pendingResume, postNeedsHumanReport, publicationFiles, queueConfig, renderNeedsHumanReport, validateRetainedWorktree, validateResumeDeliveryPreconditions, worktree, worktreePath, type GitHubAdapter, type QueueClaim, type QueueComment, type QueueIssue } from "../github-queue.js";

const execFileAsync = promisify(execFile);

const issue = (body: string): QueueIssue => ({ number: 12, title: "Safe task", body, labels: ["dev-flow-ready"], repository: "owner/repo" });
const valid = `---\nstatus: approved\nmax_tier: 2\n---\n\n## Objective\nChange the behavior.\nMore detail.\n\n## Background and decisions\nKeep compatibility.\n\n## Scope include\n- src/a.ts\n\n## Scope exclude\n- deployment\n\n## Acceptance criteria\n- Existing tests pass\n\n## Tests\n- npm test\n\n## Risks\n- local shell execution\n\n## Unresolved items\nnone\n`;

test("queue parser requires approved, complete specs and never uses an issue repo path", () => {
  const parsed = parseIssueSpec(issue(valid));
  assert.equal(parsed.spec.objective, "Change the behavior.\nMore detail.");
  assert.equal(parsed.spec.invariantsAndNonGoals, undefined, "legacy Issues may omit the optional section");
  assert.equal(parsed.spec.repo, "/untrusted-issue-repo");
  assert.equal(parsed.maxTier, 2);
  assert.throws(() => parseIssueSpec(issue(valid.replace("none", "- decide later"))), /unresolved/);
  assert.throws(() => parseIssueSpec(issue(valid.replace("none", "Decide API behavior"))), /only bullets/);
  assert.throws(() => parseIssueSpec(issue(valid.replace("- npm test", "- run the tests"))), /raw executable/);
  assert.throws(() => parseIssueSpec(issue(valid.replace("Change the behavior.\nMore detail.", ""))), /Objective/);
  assert.throws(() => parseIssueSpec(issue(valid.replace("Keep compatibility.", ""))), /Background and decisions/);
});

test("queue parser strips Markdown code spans so commands are not run as shell substitutions", () => {
  // Backticked commands are what the Issue template invites and what humans write. Left in,
  // `sh -c` runs the command and then executes its stdout, so preflight silently gates on
  // whether the test output happens to be a runnable command instead of on the exit code.
  const parsed = parseIssueSpec(issue(valid.replace("- npm test", "- `cd webui && uv run pytest -q`")));
  assert.deepEqual(parsed.spec.testRequirements, ["cd webui && uv run pytest -q"]);
  assert.deepEqual(
    parseIssueSpec(issue(valid.replace("- src/a.ts", "- `src/a.ts`"))).spec.modificationScope,
    ["src/a.ts"],
  );
  // A backtick that is not a whole-item code span is still a substitution; reject it loudly.
  assert.throws(
    () => specToHandoff(parseIssueSpec(issue(valid.replace("- npm test", "- npm test `date`"))).spec),
    /backticks/,
  );
});

test("installed GitHub template and example preserve the queue contract", () => {
  const template = readFileSync(join(process.cwd(), ".github/ISSUE_TEMPLATE/dev-flow.md"), "utf8");
  const example = readFileSync(join(process.cwd(), "examples/github-issue-template.md"), "utf8");
  const requiredHeadings = ["Objective", "Background and decisions", "Scope include", "Scope exclude", "Acceptance criteria", "Tests", "Risks", "Unresolved items"];
  assert.match(template, /^---\nname: Dev-flow task/m);
  assert.match(template, /^labels: \"\"$/m);
  assert.match(template, /^---\nstatus: draft\nmax_tier: 1\n---$/m);
  assert.match(readFileSync(join(process.cwd(), ".github/ISSUE_TEMPLATE/config.yml"), "utf8"), /blank_issues_enabled: true/);
  for (const heading of requiredHeadings) {
    assert.match(template, new RegExp(`^## ${heading}$`, "m"));
    assert.match(example, new RegExp(`^## ${heading}$`, "m"));
  }
  const parsedExample = parseIssueSpec(issue(example));
  assert.equal(parsedExample.spec.status, "approved");
  assert.equal(parsedExample.maxTier, 1);
  const body = template.replace(/^---[\s\S]*?---\n/, "");
  assert.match(body, /^---\nstatus: draft\nmax_tier: 1\n---\n/);
  assert.throws(() => parseIssueSpec(issue(body)), /status must be approved/);
  const approvedTemplate = body.replace("status: draft", "status: approved").replace(/(## Unresolved items\n)[\s\S]*$/, "$1none\n");
  assert.throws(() => parseIssueSpec(issue(approvedTemplate)), /incomplete template placeholders/);
});

test("queue parser fails closed for draft, empty sections, and official template markers only", () => {
  assert.throws(() => parseIssueSpec(issue(valid.replace("status: approved", "status: draft"))), /status must be approved/);
  assert.throws(() => parseIssueSpec(issue(valid.replace("- src\/a.ts", ""))), /at least one bullet/);
  assert.throws(() => parseIssueSpec(issue(valid.replace("Change the behavior.\nMore detail.", "<!-- dev-flow-required: fill this in -->"))), /incomplete template placeholders/);
  const arbitraryProse = valid.replace("Change the behavior.\nMore detail.", "TODO: decide later after discovery.");
  assert.equal(parseIssueSpec(issue(arbitraryProse)).spec.objective, "TODO: decide later after discovery.");
});

test("queue parser carries the optional invariants and non-goals section", () => {
  const parsed = parseIssueSpec(issue(valid.replace("## Scope include", "## Invariants and non-goals\n- Preserve existing login behavior\n- Do not change the public API\n\n## Scope include")));
  assert.deepEqual(parsed.spec.invariantsAndNonGoals, ["Preserve existing login behavior", "Do not change the public API"]);
});

test("attempt claim refs stay one-per-attempt and reject invalid attempt numbers", () => {
  assert.equal(nextAttempt(undefined), 1);
  assert.equal(nextAttempt(1), 2);
  // The ref is created inside the Issue's own repository, so the repository is not part of it;
  // the attempt is, or a finished attempt would block every later resume.
  assert.equal(claimRef(issue(valid), 1), "refs/dev-flow-claims/issue-12-attempt-1");
  assert.notEqual(claimRef(issue(valid), 1), claimRef(issue(valid), 2));
  assert.throws(() => claimRef(issue(valid), 0), /positive integer/);
  assert.throws(() => claimRef(issue(valid), 1.5), /positive integer/);
});

test("resume decisions accept only an authorized, fresh, non-empty narrow fix", () => {
  const comment: QueueComment = { id: 7, author: "maintainer", body: "/dev-flow resume narrow fix the failing verification", createdAt: new Date().toISOString() };
  assert.equal(parseResumeDecision(comment, 1), "narrow fix the failing verification");
  assert.equal(parseResumeDecision({ ...comment, body: " /dev-flow resume " }, 1), undefined);
  assert.equal(parseResumeDecision({ ...comment, body: "/dev-flow resume narrow fix" }, 1), undefined, "a narrow fix with no instruction is not a decision");
  // rebuild and cancel are deliberately outside the MVP: no automated path may discard a worktree.
  assert.equal(parseResumeDecision({ ...comment, body: "/dev-flow resume rebuild" }, 1), undefined);
  assert.equal(parseResumeDecision({ ...comment, body: "/dev-flow resume cancel" }, 1), undefined);
  assert.equal(parseResumeDecision({ ...comment, body: "/dev-flow resume please decide" }, 1), undefined);
  assert.equal(parseResumeDecision({ ...comment, createdAt: "stale" }, 1), undefined);
  assert.equal(parseResumeDecision(comment, 1, new Date(Date.now() + 1_000).toISOString()), undefined, "a comment older than the attempt report is stale");
  assert.equal(parseResumeDecision(comment, 1, new Date(Date.now() - 1_000).toISOString()), "narrow fix the failing verification");
  // `gh issue view --json comments` returns GraphQL node IDs, so an integer-only identity check
  // rejects every real decision and resume silently never fires.
  assert.equal(parseResumeDecision({ ...comment, id: "IC_kwDOS6Y-s88AAAABOA-oNg" }, 1), "narrow fix the failing verification");
  assert.equal(parseResumeDecision({ ...comment, id: "  " }, 1), undefined);
});

test("needs-human report carries the retained evidence and only offers resume when resumable", () => {
  const base = { issueNumber: 12, attempt: 2, reason: "identical failure repeated in cycle 3 and 4", findings: ["仍失敗"], attemptedFixes: ["補上驗證"], changedFiles: ["src/a.ts"], failedVerification: ["npm test"], costUsd: 0.12, durationMs: 1234, worktree: "/tmp/tree", branch: "codex/issue-12-task" };
  const report = renderNeedsHumanReport({ ...base, resumable: true });
  assert.match(report, /identical failure repeated in cycle 3 and 4/); assert.match(report, /Attempt 2/); assert.match(report, /補上驗證/); assert.match(report, /變更檔案/); assert.match(report, /失敗驗證/);
  assert.match(report, /dev-flow-resume/); assert.match(report, /\/dev-flow resume narrow fix/); assert.match(report, /人工決策/);
  assert.match(report, /<!-- dev-flow-needs-human-attempt:2 -->/, "the attempt marker is how the next resume finds this report");
  const published = renderNeedsHumanReport({ ...base, resumable: false });
  assert.ok(!published.includes("/dev-flow resume narrow fix"), "a published attempt must not advertise resume");
  assert.match(published, /無法由系統 resume/);
});

test("queue order is FIFO across repositories, not by per-repository issue number", () => {
  const queued = (repository: string, number: number, createdAt?: string): QueueIssue => ({ number, title: "t", body: "b", labels: ["dev-flow-ready"], repository, createdAt });
  const ordered = orderQueue([
    queued("owner/new-repo", 1, "2026-08-10T00:00:00Z"),
    queued("owner/old-repo", 90, "2026-08-01T00:00:00Z"),
    queued("owner/old-repo", 91, "2026-08-05T00:00:00Z"),
  ]).map((issue) => `${issue.repository}#${issue.number}`);
  assert.deepEqual(ordered, ["owner/old-repo#90", "owner/old-repo#91", "owner/new-repo#1"], "the older queued Issue wins even though its number is far higher");

  const tied = orderQueue([
    queued("owner/b", 2, "2026-08-01T00:00:00Z"),
    queued("owner/a", 7, "2026-08-01T00:00:00Z"),
    queued("owner/a", 3, "2026-08-01T00:00:00Z"),
  ]).map((issue) => `${issue.repository}#${issue.number}`);
  assert.deepEqual(tied, ["owner/a#3", "owner/a#7", "owner/b#2"], "identical timestamps fall back to a deterministic repository and number order");

  const missing = orderQueue([
    queued("owner/a", 5),
    queued("owner/a", 6, "not-a-date"),
    queued("owner/a", 7, "2026-08-09T00:00:00Z"),
  ]).map((issue) => issue.number);
  assert.deepEqual(missing, [7, 5, 6], "issues without a usable timestamp sort last instead of jumping the queue");

  assert.deepEqual(orderQueue([]), [], "an empty queue stays empty");

  // A resume-labelled Issue takes the same place in line as any other queued Issue.
  const withResume = orderQueue([
    { ...queued("owner/a", 9, "2026-08-09T00:00:00Z"), labels: ["dev-flow-resume"] },
    queued("owner/a", 4, "2026-08-01T00:00:00Z"),
  ]).map((issue) => issue.number);
  assert.deepEqual(withResume, [4, 9]);
});

class FakeAdapter implements GitHubAdapter {
  readonly comments: QueueComment[] = [];
  readonly posted: string[] = [];
  readonly labelsAdded: string[] = [];
  readonly labelsRemoved: string[] = [];
  readonly claims: number[] = [];
  commentFailure: Error | undefined;
  removeLabelFailure: Error | undefined;
  constructor(private readonly issues: QueueIssue[], private readonly writers: readonly string[] = ["maintainer"]) {}
  async listReadyIssues(): Promise<QueueIssue[]> { return this.issues; }
  async listComments(): Promise<QueueComment[]> { return this.comments; }
  async isAuthorized(_issue: QueueIssue, author: string): Promise<boolean> { return this.writers.includes(author); }
  async claim(_issue: QueueIssue, attempt = 1): Promise<QueueClaim | false> { this.claims.push(attempt); return { defaultBranch: "main", sha: "a".repeat(40), attempt }; }
  async removeLabel(_issue: QueueIssue, label: string): Promise<void> { if (this.removeLabelFailure) throw this.removeLabelFailure; this.labelsRemoved.push(label); }
  async addLabel(_issue: QueueIssue, label: string): Promise<void> { this.labelsAdded.push(label); }
  async comment(_issue: QueueIssue, body: string): Promise<void> { if (this.commentFailure) throw this.commentFailure; this.posted.push(body); }
  async createDraftPullRequest(): Promise<{ url: string }> { throw new Error("not reachable in these tests"); }
}

const resumeIssue = (): QueueIssue => ({ ...issue(valid), labels: ["dev-flow-resume", "dev-flow-needs-human"], createdAt: "2026-08-01T00:00:00Z" });
const report = (attempt: number, at: string): QueueComment => ({ id: 1, author: "worker", body: renderNeedsHumanReport({ issueNumber: 12, attempt, reason: "reviewer 未通過", findings: ["f"], attemptedFixes: ["a"], changedFiles: ["src/a.ts"], failedVerification: [], worktree: "/tmp/tree", branch: "codex/issue-12-safe-task", resumable: true }), createdAt: at });

test("a resume Issue is not actionable until an authorized, fresh decision exists", async () => {
  const target = resumeIssue();
  const adapter = new FakeAdapter([target]);

  // Waiting on the human: the needs-human report is posted, nothing has answered it yet.
  adapter.comments.push(report(1, "2026-08-02T00:00:00Z"));
  assert.equal(await pendingResume(adapter, target), undefined, "an unanswered report must not be actionable");

  // A decision that predates the report is stale, not an instruction for this attempt.
  adapter.comments.push({ id: 2, author: "maintainer", body: "/dev-flow resume narrow fix old", createdAt: "2026-08-01T12:00:00Z" });
  assert.equal(await pendingResume(adapter, target), undefined, "a decision older than the latest report is stale");

  // Anyone can comment on a public Issue; only repository writers can drive the worker.
  adapter.comments.push({ id: 3, author: "stranger", body: "/dev-flow resume narrow fix untrusted", createdAt: "2026-08-03T00:00:00Z" });
  assert.equal(await pendingResume(adapter, target), undefined, "an unauthorized author must not be able to resume");

  adapter.comments.push({ id: 4, author: "maintainer", body: "/dev-flow resume narrow fix 修正授權判斷", createdAt: "2026-08-04T00:00:00Z" });
  assert.deepEqual(await pendingResume(adapter, target), { previousAttempt: 1, decision: "narrow fix 修正授權判斷", author: "maintainer" });

  // Publication is terminal: a Draft PR comment closes the Issue to further resumes.
  adapter.comments.push({ id: 5, author: "worker", body: "Draft PR 已建立：https://github.com/owner/repo/pull/7", createdAt: "2026-08-05T00:00:00Z" });
  assert.equal(await pendingResume(adapter, target), undefined, "an Issue with a published PR must not resume");
});

test("a failed needs-human report removes the resumable label", async () => {
  const adapter = new FakeAdapter([resumeIssue()]);
  adapter.commentFailure = new Error("rate limit");
  const recorded: string[] = [];
  const record = async (name: string, _value: unknown): Promise<unknown> => { recorded.push(name); return undefined; };

  await assert.rejects(
    () => postNeedsHumanReport(adapter, resumeIssue(), "report", true, record),
    /rate limit/,
  );
  assert.deepEqual(adapter.labelsRemoved, ["dev-flow-resume"]);
  assert.deepEqual(recorded, []);

  adapter.removeLabelFailure = new Error("permission denied");
  await assert.rejects(
    () => postNeedsHumanReport(adapter, resumeIssue(), "report", true, record),
    /permission denied/,
  );
  assert.deepEqual(recorded, ["writeback-error.txt"]);

  const successful = new FakeAdapter([resumeIssue()]);
  await postNeedsHumanReport(successful, resumeIssue(), "report", true, async () => {});
  assert.deepEqual(successful.labelsRemoved, []);
  assert.deepEqual(successful.posted, ["report"]);
});

test("a resume Issue waiting on its human is skipped, and never written to", async () => {
  const waiting = resumeIssue();
  const adapter = new FakeAdapter([waiting]);
  adapter.comments.push(report(1, "2026-08-02T00:00:00Z"));
  assert.equal(await pendingResume(adapter, waiting), undefined);
  // Nothing above may touch the Issue: a report posted per poll would repost every interval and,
  // being FIFO-first, would starve every other queued Issue behind it.
  assert.deepEqual(adapter.posted, []);
  assert.deepEqual(adapter.labelsAdded, []);
  assert.deepEqual(adapter.labelsRemoved, []);
  assert.deepEqual(adapter.claims, []);
});

test("an adapter without comment support can never resume", async () => {
  const target = resumeIssue();
  const bare: GitHubAdapter = {
    listReadyIssues: async () => [target],
    claim: async () => ({ defaultBranch: "main", sha: "a".repeat(40) }),
    removeLabel: async () => {}, addLabel: async () => {}, comment: async () => {},
    createDraftPullRequest: async () => ({ url: "https://github.com/owner/repo/pull/1" }),
  };
  assert.equal(await pendingResume(bare, target), undefined);
});

test("a delivered worktree is reclaimed, but only after its ledger is moved out", async () => {
  const root = await mkdtemp("/tmp/dev-flow-reclaim-");
  try {
    const repo = join(root, "repo");
    await execFileAsync("git", ["init", repo]);
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repo });
    await writeFile(join(repo, "file.txt"), "x\n");
    await execFileAsync("git", ["add", "file.txt"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: repo });
    const tree = { cwd: join(root, "tree"), branch: "codex/issue-12-safe-task" };
    await execFileAsync("git", ["worktree", "add", "-b", tree.branch, tree.cwd], { cwd: repo });

    // run ledger 住在 worktree 裡；沒搬走就刪，等於把整份稽核紀錄一起丟掉。
    await mkdirSync(join(tree.cwd, ".orchestrator", "runs", "run-1"), { recursive: true });
    await writeFile(join(tree.cwd, ".orchestrator", "runs", "run-1", "report.md"), "# 報告\n");
    // 交付後 worktree 仍是 dirty 很正常：node_modules、未追蹤的 spec 副本都還在。
    await writeFile(join(tree.cwd, "untracked.txt"), "left over\n");
    const ledger = join(root, "ledger", "job-1");
    await mkdirSync(ledger, { recursive: true });

    const result = await reclaimWorktree(repo, tree, ledger);

    assert.equal(result.reclaimed, true, result.error);
    assert.equal(readFileSync(join(ledger, "runs", "archived", "run-1", "report.md"), "utf8"), "# 報告\n", "the ledger must survive the worktree that produced it");
    assert.ok(!existsSync(tree.cwd), "a delivered worktree is a copy of the pushed branch; keeping it only costs disk");
    assert.ok(!(await execFileAsync("git", ["worktree", "list"], { cwd: repo })).stdout.includes(tree.cwd), "the worktree registration is pruned, not left dangling");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed reclaim is reported rather than thrown, so a delivered PR still counts as success", async () => {
  const result = await reclaimWorktree("/nonexistent-repo", { cwd: "/nonexistent-tree", branch: "codex/x" }, "/nonexistent-ledger");
  assert.equal(result.reclaimed, false);
  assert.ok(result.error, "the reason belongs in the job ledger");
});

test("publication includes staged, unstaged, and untracked files without duplicates", () => {
  assert.deepEqual(
    publicationFiles("src/a.ts\nshared.ts\n", "src/b.ts\nshared.ts\n", "new.ts\n"),
    ["src/a.ts", "shared.ts", "src/b.ts", "new.ts"],
  );
});

test("draft PR renders only typed reason, Git, scope, and verification evidence", () => {
  const raw = "RAW_REPORT <details> prompt=secret events={\\\"type\\\":\\\"agent\\\"} /Users/skai.wu/side";
  const payload = {
    issueNumber: 12, objective: "Change behavior https://localhost:3000", backgroundAndDecisions: "Keep compatibility", risks: ["~~secret~~", "#shell"], acceptanceCriteria: ["tests pass"],
    approvedInclude: ["src/a.ts"], approvedExclude: ["deployment"], git: { files: [{ path: "src/a.ts", status: "M" }], filesChanged: 1, insertions: 2, deletions: 1 },
    tests: [{ command: "npm test", passed: true }], reviewerVerdict: "pass", finalReviewerVerdict: "not_run", status: "ready_for_main" as const, tier: 1, cycles: 2, costUsd: 0.12, durationMs: 1234, runId: "run-1",
    report: raw, events: raw, agentOutput: raw, ledger: raw,
  };
  const body = draftPullRequestBody(payload);
  assert.match(body, /## 為何/); assert.match(body, /## 如何完成/); assert.match(body, /M src\/a\\\.ts/); assert.match(body, /\\~\\~secret\\~\\~/); assert.match(body, /\\#shell/); assert.match(body, /新增 2 行/);
  assert.ok(!body.includes("RAW_REPORT")); assert.ok(!body.includes("prompt=secret")); assert.ok(!body.includes("/Users/skai.wu/side")); assert.ok(!body.includes("https://localhost")); assert.ok(body.includes("https&#58;//localhost"));
  assert.match(body, /## 核准範圍/); assert.match(body, /## 驗證結果/); assert.match(body, /PASS: npm test/); assert.match(body, /## 刻意排除/);
  // A GitHub keyword, not prose: without it a merged PR leaves its Issue open forever.
  assert.match(body, /^Closes #12/, "the Issue-closing keyword must survive Traditional Chinese rendering");
  assert.match(body, /## 執行歷程/); assert.match(body, /初次執行/);
  const resumed = draftPullRequestBody({ ...payload, attempt: 2, resumeDecision: "narrow fix 修正測試" });
  assert.match(resumed, /第 2 次 attempt/); assert.match(resumed, /narrow fix 修正測試/);
  assert.throws(() => draftPullRequestBody({ ...payload, attempt: 0 }), /attempt/);
  const escalatedAtTierTwo = draftPullRequestBody({
    issueNumber: 12, objective: "Change behavior", backgroundAndDecisions: "Keep compatibility", risks: [], acceptanceCriteria: ["tests pass"],
    approvedInclude: ["src/a.ts"], approvedExclude: [], git: { files: [{ path: "src/a.ts", status: "M" }], filesChanged: 1, insertions: 2, deletions: 1 },
    tests: [{ command: "npm test", passed: true }], reviewerVerdict: "escalate", finalReviewerVerdict: "pass", status: "ready_for_main", tier: 2, cycles: 2, costUsd: 0.12, durationMs: 1234, runId: "run-2",
  });
  assert.match(escalatedAtTierTwo, /審查 verdict：escalate/);
});

test("draft PR rejects unsuccessful evidence and cannot accept arbitrary report text", () => {
  const payload = { issueNumber: 12, objective: "x", backgroundAndDecisions: "x", risks: [], acceptanceCriteria: ["x"], approvedInclude: ["a"], approvedExclude: [], git: { files: [{ path: "a", status: "M" }], filesChanged: 1, insertions: 0, deletions: 0 }, tests: [{ command: "npm test", passed: false }], reviewerVerdict: "pass", finalReviewerVerdict: "not_run", status: "ready_for_main" as const, tier: 1, cycles: 1, costUsd: 0, durationMs: 1, runId: "run" };
  assert.throws(() => draftPullRequestBody(payload), /test evidence/);
  assert.equal("report" in payload, false);
  assert.ok(MAX_DRAFT_PR_BODY_BYTES < 65536);
});

test("draft PR rejects malformed numeric evidence and oversized Git/test lists", () => {
  const payload = {
    issueNumber: 12, objective: "x", backgroundAndDecisions: "x", risks: [], acceptanceCriteria: ["x"], approvedInclude: ["a"], approvedExclude: [],
    git: { files: [{ path: "a", status: "M" }], filesChanged: 1, insertions: 0, deletions: 0 }, tests: [{ command: "npm test", passed: true }], reviewerVerdict: "pass", finalReviewerVerdict: "not_run", status: "ready_for_main" as const, tier: 1, cycles: 1, costUsd: 0, durationMs: 1, runId: "run",
  };
  assert.throws(() => draftPullRequestBody({ ...payload, git: { ...payload.git, insertions: Number.NaN } }), /Git delivery/);
  assert.throws(() => draftPullRequestBody({ ...payload, git: { ...payload.git, deletions: Number.POSITIVE_INFINITY } }), /Git delivery/);
  assert.throws(() => draftPullRequestBody({ ...payload, git: { ...payload.git, insertions: 1.5 } }), /Git delivery/);
  assert.throws(() => draftPullRequestBody({ ...payload, git: { ...payload.git, deletions: 1.5 } }), /Git delivery/);
  assert.throws(() => draftPullRequestBody({ ...payload, git: { ...payload.git, filesChanged: Number.MAX_VALUE } }), /Git delivery/);
  assert.throws(() => draftPullRequestBody({ ...payload, git: { ...payload.git, insertions: Number.MAX_SAFE_INTEGER + 1 } }), /Git delivery/);
  assert.throws(() => draftPullRequestBody({ ...payload, git: { ...payload.git, deletions: Number.MAX_SAFE_INTEGER + 1 } }), /Git delivery/);
  assert.throws(() => draftPullRequestBody({ ...payload, reviewerVerdict: "escalate" }), /incomplete delivery evidence/);
  assert.throws(() => draftPullRequestBody({ ...payload, finalReviewerVerdict: "pass" }), /incomplete delivery evidence/);
  assert.throws(() => draftPullRequestBody({ ...payload, tier: 0, finalReviewerVerdict: "pass" }), /incomplete delivery evidence/);
  assert.throws(() => draftPullRequestBody({ ...payload, tier: 3 }), /malformed delivery result/);
  assert.throws(() => draftPullRequestBody({ ...payload, cycles: -1 }), /malformed delivery result/);
  assert.throws(() => draftPullRequestBody({ ...payload, git: { files: Array.from({ length: 101 }, (_, index) => ({ path: `a-${index}`, status: "M" })), filesChanged: 101, insertions: 0, deletions: 0 } }), /Git delivery/);
  assert.throws(() => draftPullRequestBody({ ...payload, tests: Array.from({ length: 101 }, () => ({ command: "npm test", passed: true })) }), /test evidence/);
});

test("queue configuration requires an explicit repository allowlist and defaults inside side", () => {
  assert.throws(() => queueConfig({}), /ALLOWED_REPOS/);
  const config = queueConfig({ DEV_FLOW_ALLOWED_REPOS: "owner/repo", DEV_FLOW_WORKER_ID: "test" });
  assert.equal(config.workspaceRoot, "/Users/skai.wu/side");
  assert.equal(config.workerId, "test");
  assert.throws(() => queueConfig({ DEV_FLOW_ALLOWED_REPOS: "owner/repo", DEV_FLOW_WORKSPACE_ROOT: "/tmp" }), /inside \/Users\/skai\.wu\/side/);
});

test("retained provenance is bound to the expected Issue worktree path, branch, HEAD and status", async () => {
  const root = await mkdtemp("/tmp/dev-flow-retained-");
  try {
    const remote = join(root, "remote.git"); const repo = join(root, "repo");
    await execFileAsync("git", ["init", "--bare", remote]); await execFileAsync("git", ["init", repo]);
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo }); await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repo });
    await writeFile(join(repo, "file.txt"), "x\n"); await execFileAsync("git", ["add", "file.txt"], { cwd: repo }); await execFileAsync("git", ["commit", "-m", "base"], { cwd: repo });
    const sha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await execFileAsync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: repo });
    const config = { allowedRepos: ["owner/repo"], workspaceRoot: root, ledgerRoot: join(root, "ledger"), maxTier: 1 as const, dryRun: false, workerId: "test" };
    const expected = worktreePath(config, issue(valid)); await mkdirSync(join(root, ".orchestrator", "worktrees"), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "-b", "codex/issue-12-safe-task", expected, sha], { cwd: repo });
    const provenance = { repository: "owner/repo", issueNumber: 12, branch: "codex/issue-12-safe-task", cwd: expected, baselineSha: sha, status: "", recordedAt: new Date().toISOString() };
    await validateRetainedWorktree(provenance, issue(valid), expected, provenance.branch);
    // A resume reuses the retained worktree as-is; it never fetches or re-creates it.
    assert.deepEqual(await worktree(config, repo, issue(valid), { defaultBranch: "main", sha }, provenance), { cwd: expected, branch: "codex/issue-12-safe-task" });
    await assert.rejects(() => validateRetainedWorktree({ ...provenance, cwd: repo }, issue(valid), expected, provenance.branch), /路徑/);
    await assert.rejects(() => validateRetainedWorktree(provenance, issue(valid), expected, "codex/issue-12-other"), /branch 不符/);
    await assert.rejects(() => validateRetainedWorktree({ ...provenance, baselineSha: "1".repeat(40) }, issue(valid), expected, provenance.branch), /HEAD 與 provenance 不符/);
    await assert.rejects(() => validateRetainedWorktree({ ...provenance, repository: "other/repo" }, issue(valid), expected, provenance.branch), /provenance 內容不合法/);
    await assert.rejects(() => validateRetainedWorktree({ ...provenance, previousOutcome: { status: "ready_for_main" } as never }, issue(valid), expected, provenance.branch), /ready_for_main/);
    // Anything the previous attempt did not record is unexplained state; it must fail closed.
    await writeFile(join(expected, "stray.txt"), "unexplained\n");
    await assert.rejects(() => validateRetainedWorktree(provenance, issue(valid), expected, provenance.branch), /未記錄的變動/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("resume delivery preconditions reject oversized decisions and readonly merge conflicts", async () => {
  const root = await mkdtemp("/tmp/dev-flow-resume-preflight-");
  try {
    await execFileAsync("git", ["init", root]);
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "file.txt"), "base\\n");
    await execFileAsync("git", ["add", "file.txt"], { cwd: root }); await execFileAsync("git", ["commit", "-m", "base"], { cwd: root });
    const commonBase = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await execFileAsync("git", ["checkout", "-b", "default"], { cwd: root });
    await writeFile(join(root, "file.txt"), "default\\n"); await execFileAsync("git", ["commit", "-am", "default"], { cwd: root });
    const defaultSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await execFileAsync("git", ["checkout", "-b", "retained", commonBase], { cwd: root });
    const baselineSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await writeFile(join(root, "file.txt"), "retained\\n");
    const beforeStatus = (await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root })).stdout;
    const retained = { repository: "owner/repo", issueNumber: 12, branch: "codex/issue-12-safe-task", cwd: root, baselineSha, status: beforeStatus.trim(), recordedAt: new Date().toISOString() };
    const claim = { defaultBranch: "main", sha: defaultSha };
    const beforeHead = baselineSha;
    await assert.rejects(() => validateResumeDeliveryPreconditions(root, claim, retained, "narrow fix"), /落後 1 個 commit.*file\.txt/);
    assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(), beforeHead);
    assert.equal((await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root })).stdout, beforeStatus);
    await assert.rejects(() => validateResumeDeliveryPreconditions(root, { ...claim, sha: baselineSha }, retained, "x".repeat(MAX_DELIVERY_LIST_ITEM_LENGTH + 1)), /長度 513 超過上限 512/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("resume delivery preconditions preserve staged-only retained changes when checking conflicts", async () => {
  const root = await mkdtemp("/tmp/dev-flow-resume-staged-conflict-");
  try {
    await execFileAsync("git", ["init", root]);
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: root }); await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "file.txt"), "base\\n"); await execFileAsync("git", ["add", "file.txt"], { cwd: root }); await execFileAsync("git", ["commit", "-m", "base"], { cwd: root });
    const commonBase = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await execFileAsync("git", ["checkout", "-b", "default"], { cwd: root });
    await writeFile(join(root, "file.txt"), "default\\n"); await execFileAsync("git", ["commit", "-am", "default"], { cwd: root });
    const claimSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await execFileAsync("git", ["checkout", "-b", "retained", commonBase], { cwd: root });
    await writeFile(join(root, "file.txt"), "retained\\n"); await execFileAsync("git", ["add", "file.txt"], { cwd: root });
    await writeFile(join(root, "file.txt"), "base\\n");
    const baselineSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const beforeHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const beforeStatus = (await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root })).stdout;
    const retained = { repository: "owner/repo", issueNumber: 12, branch: "codex/issue-12-safe-task", cwd: root, baselineSha, status: beforeStatus.trim(), recordedAt: new Date().toISOString() };
    await assert.rejects(() => validateResumeDeliveryPreconditions(root, { defaultBranch: "main", sha: claimSha }, retained, "narrow fix"), /落後 1 個 commit.*file\.txt/);
    assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(), beforeHead);
    assert.equal((await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root })).stdout, beforeStatus);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("resume delivery preconditions reject divergent non-conflicting histories", async () => {
  const root = await mkdtemp("/tmp/dev-flow-resume-divergent-");
  try {
    await execFileAsync("git", ["init", root]);
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: root }); await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\\n"); await execFileAsync("git", ["add", "base.txt"], { cwd: root }); await execFileAsync("git", ["commit", "-m", "base"], { cwd: root });
    const commonBase = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await execFileAsync("git", ["checkout", "-b", "default"], { cwd: root });
    await writeFile(join(root, "default.txt"), "default\\n"); await execFileAsync("git", ["add", "default.txt"], { cwd: root }); await execFileAsync("git", ["commit", "-m", "default"], { cwd: root });
    const claimSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await execFileAsync("git", ["checkout", "-b", "retained", commonBase], { cwd: root });
    await writeFile(join(root, "retained.txt"), "retained\\n"); await execFileAsync("git", ["add", "retained.txt"], { cwd: root }); await execFileAsync("git", ["commit", "-m", "retained"], { cwd: root });
    const baselineSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const beforeStatus = (await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root })).stdout;
    await assert.rejects(() => validateResumeDeliveryPreconditions(root, { defaultBranch: "main", sha: claimSha }, { repository: "owner/repo", issueNumber: 12, branch: "codex/issue-12-safe-task", cwd: root, baselineSha, status: "", recordedAt: new Date().toISOString() }, "narrow fix"), /不是 claim default branch SHA 的 ancestor.*fast-forward/);
    assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(), baselineSha);
    assert.equal((await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root })).stdout, beforeStatus);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("resume delivery preconditions allow a non-conflicting default branch advance", async () => {
  const root = await mkdtemp("/tmp/dev-flow-resume-mergeable-");
  try {
    await execFileAsync("git", ["init", root]);
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: root }); await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\\n"); await execFileAsync("git", ["add", "base.txt"], { cwd: root }); await execFileAsync("git", ["commit", "-m", "base"], { cwd: root });
    const baselineSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await writeFile(join(root, "new.txt"), "new\\n"); await execFileAsync("git", ["add", "new.txt"], { cwd: root }); await execFileAsync("git", ["commit", "-m", "advance"], { cwd: root });
    const claimSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await validateResumeDeliveryPreconditions(root, { defaultBranch: "main", sha: claimSha }, { repository: "owner/repo", issueNumber: 12, branch: "codex/issue-12-safe-task", cwd: root, baselineSha, status: "", recordedAt: new Date().toISOString() }, "narrow fix");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("resume delivery preconditions fetch a claimed SHA missing from the local checkout", async () => {
  const root = await mkdtemp("/tmp/dev-flow-resume-fetch-");
  try {
    const remote = join(root, "remote.git"); const seed = join(root, "seed"); const repo = join(root, "repo");
    await execFileAsync("git", ["init", "--bare", remote]); await execFileAsync("git", ["init", seed]);
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: seed }); await execFileAsync("git", ["config", "user.name", "Test"], { cwd: seed });
    await writeFile(join(seed, "base.txt"), "base\\n"); await execFileAsync("git", ["add", "base.txt"], { cwd: seed }); await execFileAsync("git", ["commit", "-m", "base"], { cwd: seed });
    await execFileAsync("git", ["branch", "-M", "main"], { cwd: seed }); await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: seed }); await execFileAsync("git", ["push", "origin", "main"], { cwd: seed });
    await execFileAsync("git", ["clone", "--branch", "main", remote, repo]);
    const baselineSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await writeFile(join(seed, "new.txt"), "new\\n"); await execFileAsync("git", ["add", "new.txt"], { cwd: seed }); await execFileAsync("git", ["commit", "-m", "advance"], { cwd: seed }); await execFileAsync("git", ["push", "origin", "main"], { cwd: seed });
    const claimSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: seed })).stdout.trim();
    const locallyAvailable = await execFileAsync("git", ["cat-file", "-e", `${claimSha}^{commit}`], { cwd: repo }).then(() => true).catch(() => false);
    assert.equal(locallyAvailable, false);
    const retained = { repository: "owner/repo", issueNumber: 12, branch: "codex/issue-12-safe-task", cwd: repo, baselineSha, status: "", recordedAt: new Date().toISOString() };
    await validateResumeDeliveryPreconditions(repo, { defaultBranch: "main", sha: claimSha }, retained, "narrow fix");
    assert.equal((await execFileAsync("git", ["cat-file", "-e", `${claimSha}^{commit}`], { cwd: repo })).stdout, "");
    assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(), baselineSha);
    assert.equal((await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo })).stdout, "");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worktree fetches and starts at the claimed SHA rather than local HEAD", async () => {
  const root = await mkdtemp("/tmp/dev-flow-queue-");
  try {
    const remote = join(root, "remote.git"); const seed = join(root, "seed"); const repo = join(root, "repo");
    const git = async (cwd: string, args: string[]) => (await execFileAsync("git", args, { cwd })).stdout.trim();
    await execFileAsync("git", ["init", "--bare", remote]); await execFileAsync("git", ["init", seed]);
    await git(seed, ["config", "user.email", "test@example.invalid"]); await git(seed, ["config", "user.name", "Test"]);
    await writeFile(join(seed, "file.txt"), "old\n"); await git(seed, ["add", "file.txt"]); await git(seed, ["commit", "-m", "old"]); await git(seed, ["branch", "-M", "main"]); await git(seed, ["remote", "add", "origin", remote]); await git(seed, ["push", "origin", "main"]);
    await execFileAsync("git", ["clone", "--branch", "main", remote, repo]); const oldSha = await git(repo, ["rev-parse", "HEAD"]);
    await writeFile(join(seed, "file.txt"), "new\n"); await git(seed, ["commit", "-am", "new"]); await git(seed, ["push", "origin", "main"]); const claimedSha = await git(seed, ["rev-parse", "HEAD"]);
    const config = { allowedRepos: ["owner/repo"], workspaceRoot: root, ledgerRoot: join(root, "ledger"), maxTier: 1 as const, dryRun: false, workerId: "test" };
    const tree = await worktree(config, repo, issue(valid), { defaultBranch: "main", sha: claimedSha });
    assert.notEqual(oldSha, claimedSha); assert.equal(await git(tree.cwd, ["rev-parse", "HEAD"]), claimedSha);
    assert.equal(await git(repo, ["rev-parse", "HEAD"]), oldSha);
    await assert.rejects(() => worktree(config, repo, { ...issue(valid), number: 13 }, { defaultBranch: "main", sha: oldSha }), /與 claim 的 SHA 不符/);
    await assert.rejects(() => worktree(config, repo, { ...issue(valid), number: 14 }, { defaultBranch: "missing", sha: claimedSha }), /fetch|Could not resolve/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("poll lock preserves live same-host owners and recovers dead or aged fallback owners", async () => {
  const root = await mkdtemp("/tmp/dev-flow-lock-");
  try {
    const config = { allowedRepos: ["owner/repo"], workspaceRoot: root, ledgerRoot: join(root, "ledger"), maxTier: 1 as const, dryRun: false, workerId: "test" };
    const lock = join(root, "lock"); await mkdirSync(lock, { recursive: true }); await mkdirSync(config.ledgerRoot, { recursive: true });
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() }));
    assert.equal(await acquirePollLock(config, lock), false);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 999999999, host: hostname(), createdAt: new Date().toISOString() }));
    assert.equal(await acquirePollLock(config, lock), true);
    await rm(lock, { recursive: true, force: true }); await mkdirSync(lock, { recursive: true });
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 1, host: "foreign-host", createdAt: new Date().toISOString() }));
    assert.equal(await acquirePollLock(config, lock), false);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 1, host: "foreign-host", createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() }));
    assert.equal(await acquirePollLock(config, lock), true);
    await rm(lock, { recursive: true, force: true }); await mkdirSync(lock, { recursive: true }); await writeFile(join(lock, "owner.json"), "not-json");
    assert.equal(await acquirePollLock(config, lock), false);
    utimesSync(lock, new Date(0), new Date(0));
    assert.equal(await acquirePollLock(config, lock), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
