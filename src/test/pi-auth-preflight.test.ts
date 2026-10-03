import assert from "node:assert/strict";
import test from "node:test";
import { checkPiAuthReadiness, type PiAuthPreflight } from "../pi-auth-preflight.js";
import { pollOnce, type GitHubAdapter, type QueueIssue } from "../github-queue.js";

const credential = (overrides: Record<string, unknown> = {}) => ({
  type: "oauth",
  access: "access-secret",
  refresh: "refresh-secret",
  expires: 2_000,
  ...overrides,
});

test("Pi auth preflight accepts a canonical unexpired OAuth credential without exposing it", async () => {
  const result = await checkPiAuthReadiness({ nowMs: 1_000, readCredential: async () => credential() });
  assert.equal(result.status, "ready");
  assert.equal(result.source, "oauth_access");
  assert.doesNotMatch(JSON.stringify(result), /access-secret|refresh-secret/);
});

test("Pi auth preflight accepts an expired access token when refresh is present, without refreshing", async () => {
  let reads = 0;
  const result = await checkPiAuthReadiness({ nowMs: 3_000, readCredential: async () => { reads += 1; return credential(); } });
  assert.equal(result.status, "ready");
  assert.equal(result.source, "oauth_refresh");
  assert.equal(reads, 1);
  assert.match(result.note, /no refresh was attempted/);
});

test("Pi auth preflight fails closed for missing, malformed, and expired-without-refresh credentials", async () => {
  const missing = await checkPiAuthReadiness({ readCredential: async () => undefined });
  const malformed = await checkPiAuthReadiness({ readCredential: async () => ({ type: "oauth", access: "only" }) });
  assert.equal(missing.status, "blocked");
  assert.equal(missing.reason, "missing");
  assert.equal(malformed.status, "blocked");
  assert.equal(malformed.reason, "malformed");
  const expired = await checkPiAuthReadiness({ nowMs: 3_000, readCredential: async () => credential({ refresh: "" }) });
  assert.equal(expired.status, "blocked");
  assert.equal(expired.reason, "expired");
});

test("blocked auth preflight runs before Issue listing or claim and makes no model call", async () => {
  let listed = 0;
  let claimed = 0;
  const issue: QueueIssue = { number: 1, title: "queued", body: "", labels: ["dev-flow-ready"], repository: "owner/repo" };
  const adapter: GitHubAdapter = {
    async listReadyIssues() { listed += 1; return [issue]; },
    async claim() { claimed += 1; return false; },
    async removeLabel() {},
    async addLabel() {},
    async comment() {},
    async createDraftPullRequest() { throw new Error("model path must not run"); },
  };
  const authPreflight: PiAuthPreflight = async () => ({ status: "blocked", providerId: "openai-codex", reason: "missing", detail: "Pi openai-codex OAuth credential is not present" });
  const result = await pollOnce(adapter, {
    allowedRepos: ["owner/repo"], workspaceRoot: "/tmp/pi-auth-preflight-test", ledgerRoot: "/tmp/pi-auth-preflight-test-ledger",
    maxTier: 1, dryRun: false, workerId: "test", authPreflight,
  });
  assert.equal(result.status, "blocked");
  assert.match(result.error ?? "", /^worker blocked\/auth_required:/);
  assert.equal(listed, 0);
  assert.equal(claimed, 0);
});

test("dry-run keeps the offline queue path usable without auth preflight", async () => {
  let preflightCalls = 0;
  let listed = 0;
  const issue: QueueIssue = { number: 2, title: "offline", body: "", labels: ["dev-flow-ready"], repository: "owner/repo" };
  const adapter: GitHubAdapter = {
    async listReadyIssues() { listed += 1; return [issue]; },
    async claim() { throw new Error("dry-run must not claim"); },
    async removeLabel() {},
    async addLabel() {},
    async comment() {},
    async createDraftPullRequest() { throw new Error("dry-run must not publish"); },
  };
  const result = await pollOnce(adapter, {
    allowedRepos: ["owner/repo"], workspaceRoot: "/tmp/pi-auth-preflight-dry-run", ledgerRoot: "/tmp/pi-auth-preflight-dry-run-ledger",
    maxTier: 1, dryRun: true, workerId: "test", authPreflight: async () => {
      preflightCalls += 1;
      return { status: "blocked", providerId: "openai-codex", reason: "missing", detail: "must not run" };
    },
  });
  assert.equal(result.status, "dry_run");
  assert.equal(listed, 1);
  assert.equal(preflightCalls, 0);
});
