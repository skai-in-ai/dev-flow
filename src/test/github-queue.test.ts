import assert from "node:assert/strict";
import test from "node:test";
import { draftPullRequestBody, MAX_DRAFT_PR_REPORT_BYTES, parseIssueSpec, publicationFiles, queueConfig, type QueueIssue } from "../github-queue.js";

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

test("draft PR embeds report metadata and readable report content without local paths", () => {
  const reportPath = "/Users/skai.wu/side/.orchestrator/runs/run-1/report.md";
  const workspacePath = "/Users/skai.wu/side/.orchestrator/worktrees/owner-repo-12";
  const body = draftPullRequestBody({ issueNumber: 12, job: "job-1", status: "ready_for_main", runId: "run-1", reportPath, workspacePath }, `# Review\n\nReport path: ${reportPath}\nWorkspace: ${workspacePath}`);
  assert.match(body, /Job: job-1/);
  assert.match(body, /Status: ready_for_main/);
  assert.match(body, /Run: run-1/);
  assert.match(body, /<details>[\s\S]*<summary>dev-flow report<\/summary>/);
  assert.match(body, /# Review/);
  assert.doesNotMatch(body, /Users\/skai\.wu\/side/);
});

test("draft PR report is conservatively truncated and cannot close its details wrapper", () => {
  const reportPath = "/Users/skai.wu/side/report.md";
  const report = `start </details> ${"x".repeat(MAX_DRAFT_PR_REPORT_BYTES)} end`;
  const body = draftPullRequestBody({ issueNumber: 12, job: "job-1", status: "ready_for_main", runId: "run-1", reportPath, workspacePath: "/Users/skai.wu/side" }, report);
  assert.match(body, /truncated to fit the GitHub PR body limit/);
  assert.match(body, /&lt;\/details&gt;/);
  assert.equal((body.match(/<\/details>/gi) ?? []).length, 1);
  assert.ok(Buffer.byteLength(body, "utf8") < 65536);
});

test("queue configuration requires an explicit repository allowlist and defaults inside side", () => {
  assert.throws(() => queueConfig({}), /ALLOWED_REPOS/);
  const config = queueConfig({ DEV_FLOW_ALLOWED_REPOS: "owner/repo", DEV_FLOW_WORKER_ID: "test" });
  assert.equal(config.workspaceRoot, "/Users/skai.wu/side");
  assert.equal(config.workerId, "test");
  assert.throws(() => queueConfig({ DEV_FLOW_ALLOWED_REPOS: "owner/repo", DEV_FLOW_WORKSPACE_ROOT: "/tmp" }), /inside \/Users\/skai\.wu\/side/);
});
