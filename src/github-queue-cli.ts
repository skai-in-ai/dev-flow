import { readFile } from "node:fs/promises";
import { GhCliAdapter, pollOnce, queueConfig, type DraftPullRequest, type GitHubAdapter, type QueueIssue } from "./github-queue.js";

class FakeAdapter implements GitHubAdapter {
  constructor(private readonly issues: QueueIssue[]) {}
  async listReadyIssues(): Promise<QueueIssue[]> { return this.issues; }
  async claim(issue: QueueIssue): Promise<{ defaultBranch: string; sha: string } | false> { issue.labels = issue.labels.filter((label) => label !== "dev-flow-ready"); issue.labels.push("dev-flow-running"); return { defaultBranch: "main", sha: "0000000000000000000000000000000000000000" }; }
  async removeLabel(issue: QueueIssue, label: string): Promise<void> { issue.labels = issue.labels.filter((item) => item !== label); }
  async addLabel(issue: QueueIssue, label: string): Promise<void> { if (!issue.labels.includes(label)) issue.labels.push(label); }
  async comment(_issue: QueueIssue, _body: string): Promise<void> {}
  async createDraftPullRequest(_repo: string, _branch: string, _title: string, _body: string): Promise<DraftPullRequest> { return { url: "https://example.invalid/draft/0" }; }
}

const dryRun = process.argv.includes("--dry-run");
const config = queueConfig({ ...process.env, ...(dryRun ? { DEV_FLOW_DRY_RUN: "1" } : {}) });
let adapter: GitHubAdapter;
if (dryRun) {
  const fakePath = process.env.DEV_FLOW_FAKE_ISSUES;
  if (!fakePath) throw new Error("--dry-run requires DEV_FLOW_FAKE_ISSUES pointing to a local JSON fixture");
  adapter = new FakeAdapter(JSON.parse(await readFile(fakePath, "utf8")) as QueueIssue[]);
} else adapter = new GhCliAdapter(config.allowedRepos);
const result = await pollOnce(adapter, config);
console.log(JSON.stringify(result, null, 2));
if (result.status === "failed") process.exitCode = 1;