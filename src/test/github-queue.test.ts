import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquirePollLock, claimRef, cumulativeResumeEvidence, draftPullRequestBody, MAX_DRAFT_PR_BODY_BYTES, nextAttempt, parseIssueSpec, parseResumeDecision, publicationFiles, queueConfig, renderNeedsHumanReport, validateRetainedWorktree, worktree, worktreePath, type QueueComment, type QueueIssue } from "../github-queue.js";

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

test("attempt claims are repository/Issue scoped and resume decisions fail closed", () => {
  assert.equal(nextAttempt(undefined), 1);
  assert.equal(nextAttempt(1), 2);
  const first = claimRef(issue(valid), 1);
  const second = claimRef({ ...issue(valid), repository: "other/repo" }, 1);
  assert.match(first, /5-owner_4-repo-issue-12-attempt-1$/);
  assert.notEqual(first, second);
  const comment: QueueComment = { id: 7, author: "maintainer", body: "/dev-flow resume narrow fix the failing verification", createdAt: new Date().toISOString() };
  assert.equal(parseResumeDecision(comment, 1), "narrow fix the failing verification");
  assert.equal(parseResumeDecision({ ...comment, body: " /dev-flow resume " }, 1), undefined);
  assert.equal(parseResumeDecision({ ...comment, body: "/dev-flow resume rebuild" }, 1), "rebuild");
  assert.equal(parseResumeDecision({ ...comment, body: "/dev-flow resume cancel" }, 1), "cancel");
  assert.equal(parseResumeDecision({ ...comment, body: "/dev-flow resume please decide" }, 1), undefined);
  assert.equal(parseResumeDecision({ ...comment, createdAt: "stale" }, 1), undefined);
  assert.equal(parseResumeDecision(comment, 1, new Date(Date.now() + 1_000).toISOString()), undefined);
  assert.equal(parseResumeDecision(comment, 1, new Date(Date.now() - 1_000).toISOString()), "narrow fix the failing verification");
});

test("needs-human report renders the required Traditional Chinese recovery evidence", () => {
  const report = renderNeedsHumanReport({ issueNumber: 12, attempt: 2, reason: "identical failure repeated in cycle 3 and 4", cycles: [{ cycle: 1, attemptedFix: "補上驗證", findings: ["仍失敗"] }], findings: ["仍失敗"], changedFiles: ["src/a.ts"], failedVerification: ["npm test"], costUsd: 0.12, durationMs: 1234, worktree: "/tmp/tree", branch: "codex/issue-12/task", resumeInstructions: "" });
  assert.match(report, /identical failure repeated in cycle 3 and 4/); assert.match(report, /Attempt 2/); assert.match(report, /變更檔案/); assert.match(report, /失敗驗證/); assert.match(report, /dev-flow-resume/); assert.match(report, /繁體中文|人工決策/);
});

test("resume context includes every retained attempt's evidence and decision", () => {
  const evidence = cumulativeResumeEvidence({
    repository: "owner/repo", issueNumber: 12, branch: "codex/issue-12/safe-task", cwd: "/tmp/tree", baselineSha: "0".repeat(40), status: " M src/a.ts", recordedAt: new Date().toISOString(),
    findings: ["latest finding"], attemptedFixes: ["latest fix"], testEvidence: [{ command: "npm test", passed: true }], cycles: [{ cycle: 2, attemptedFix: "latest cycle", findings: ["latest finding"] }], changedFiles: ["src/a.ts"], failedVerification: [], decisionLog: "latest decision",
    attempts: [
      { attempt: 1, reason: "first stop", cycles: [{ cycle: 1, attemptedFix: "first fix", findings: ["first finding"] }], findings: ["first finding"], changedFiles: ["src/a.ts"], failedVerification: ["npm test"], testEvidence: [{ command: "npm test", passed: false }], costUsd: 0, durationMs: 1 },
      { attempt: 2, reason: "second stop", cycles: [{ cycle: 1, attemptedFix: "second fix", findings: ["second finding"] }], findings: ["second finding"], changedFiles: ["src/b.ts"], failedVerification: [], testEvidence: [{ command: "npm test", passed: false }], resumeDecision: "narrow fix second", decisionAuthor: "maintainer", costUsd: 0, durationMs: 1 },
    ],
  });
  assert.match(evidence.findings.join("\n"), /first finding/); assert.match(evidence.attemptedFixes.join("\n"), /first fix/); assert.match(evidence.testEvidence.map((test) => test.passed).join(","), /false/); assert.match(evidence.decisionLog, /narrow fix second/);
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
  const cumulative = draftPullRequestBody({ ...payload, attempts: [
    { attempt: 1, reason: "第一次 review 未通過", cycles: [{ cycle: 1, attemptedFix: "補上驗證", findings: ["仍有 finding"] }], findings: ["仍有 finding"], changedFiles: ["src/a.ts"], failedVerification: ["npm test"], testEvidence: [{ command: "npm test", passed: false }], costUsd: 0.05, durationMs: 100 },
    { attempt: 2, reason: "完成修正", cycles: [], findings: [], changedFiles: ["src/a.ts"], failedVerification: [], testEvidence: [{ command: "npm test", passed: true }], resumeDecision: "narrow fix 修正測試", decisionAuthor: "maintainer", costUsd: 0.12, durationMs: 1234 },
  ] });
  assert.match(cumulative, /## 累積 Attempts/); assert.match(cumulative, /Attempt 1/); assert.match(cumulative, /第一次 review 未通過/); assert.match(cumulative, /narrow fix 修正測試/); assert.match(cumulative, /FAIL npm test/);
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

test("worktree paths cannot collide when owner and repository names contain hyphens", () => {
  const config = { allowedRepos: ["owner/repo-a", "owner-repo/a"], workspaceRoot: "/Users/skai.wu/side", ledgerRoot: "/tmp/ledger", maxTier: 1 as const, dryRun: false, workerId: "test" };
  assert.notEqual(worktreePath(config, { ...issue(valid), repository: "owner/repo-a" }), worktreePath(config, { ...issue(valid), repository: "owner-repo/a" }));
});

test("retained provenance is bound to the expected Issue worktree path and branch", async () => {
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
    await assert.rejects(() => validateRetainedWorktree({ ...provenance, cwd: repo }, issue(valid), expected, provenance.branch), /path/);
    await assert.rejects(() => worktree(config, repo, issue(valid), { defaultBranch: "main", sha }, undefined, true), /provenance validation/);
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
    await assert.rejects(() => worktree(config, repo, { ...issue(valid), number: 13 }, { defaultBranch: "main", sha: oldSha }), /does not match claimed SHA/);
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
