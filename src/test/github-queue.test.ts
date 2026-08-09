import assert from "node:assert/strict";
import test from "node:test";
import { draftPullRequestBody, MAX_DRAFT_PR_BODY_BYTES, parseIssueSpec, publicationFiles, queueConfig, type QueueIssue } from "../github-queue.js";

const issue = (body: string): QueueIssue => ({ number: 12, title: "Safe task", body, labels: ["dev-flow-ready"], repository: "owner/repo" });
const valid = `---\nstatus: approved\nmax_tier: 2\n---\n\n## Objective\nChange the behavior.\nMore detail.\n\n## Background and decisions\nKeep compatibility.\n\n## Scope include\n- src/a.ts\n\n## Scope exclude\n- deployment\n\n## Acceptance criteria\n- Existing tests pass\n\n## Tests\n- npm test\n\n## Risks\n- local shell execution\n\n## Unresolved items\nnone\n`;

test("queue parser requires approved, complete specs and never uses an issue repo path", () => {
  const parsed = parseIssueSpec(issue(valid));
  assert.equal(parsed.spec.objective, "Change the behavior.\nMore detail.");
  assert.equal(parsed.spec.repo, "/untrusted-issue-repo");
  assert.equal(parsed.maxTier, 2);
  assert.throws(() => parseIssueSpec(issue(valid.replace("none", "- decide later"))), /unresolved/);
  assert.throws(() => parseIssueSpec(issue(valid.replace("none", "Decide API behavior"))), /only bullets/);
  assert.throws(() => parseIssueSpec(issue(valid.replace("- npm test", "- run the tests"))), /raw executable/);
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
