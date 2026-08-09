import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquirePollLock, draftPullRequestBody, MAX_DRAFT_PR_BODY_BYTES, parseIssueSpec, publicationFiles, queueConfig, worktree, type QueueIssue } from "../github-queue.js";

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
  assert.match(body, /## Why/); assert.match(body, /## How/); assert.match(body, /M src\/a\\\.ts/); assert.match(body, /\\~\\~secret\\~\\~/); assert.match(body, /\\#shell/); assert.match(body, /2 insertions/);
  assert.ok(!body.includes("RAW_REPORT")); assert.ok(!body.includes("prompt=secret")); assert.ok(!body.includes("/Users/skai.wu/side")); assert.ok(!body.includes("https://localhost")); assert.ok(body.includes("https&#58;//localhost"));
  assert.match(body, /## Approved scope/); assert.match(body, /## Verification result/); assert.match(body, /PASS: npm test/); assert.match(body, /## Intentionally excluded/);
  const escalatedAtTierTwo = draftPullRequestBody({
    issueNumber: 12, objective: "Change behavior", backgroundAndDecisions: "Keep compatibility", risks: [], acceptanceCriteria: ["tests pass"],
    approvedInclude: ["src/a.ts"], approvedExclude: [], git: { files: [{ path: "src/a.ts", status: "M" }], filesChanged: 1, insertions: 2, deletions: 1 },
    tests: [{ command: "npm test", passed: true }], reviewerVerdict: "escalate", finalReviewerVerdict: "pass", status: "ready_for_main", tier: 2, cycles: 2, costUsd: 0.12, durationMs: 1234, runId: "run-2",
  });
  assert.match(escalatedAtTierTwo, /Reviewer verdict: escalate/);
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
