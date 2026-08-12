import assert from "node:assert/strict";
import test from "node:test";

import { DEV_FLOW_LABELS } from "../github-queue.js";
import { assertQueueCheckoutPath, canonicalRepository, mergeAllowlist, onboardRepository, parseGitHubSshOrigin, parseLoadedAllowlist, type CheckoutIdentity, type LaunchAgentState, type OnboardingAdapter } from "../repository-onboarding.js";

const identity: CheckoutIdentity = { repository: "owner/repo", checkout: "/Users/skai.wu/side/repo", workspaceRoot: "/Users/skai.wu/side" };
class FakeAdapter implements OnboardingAdapter {
  labels = new Set<string>(); created: string[] = []; issueMutations = 0; replaced = 0; reloaded = 0; restored = 0; failReload = false;
  state: LaunchAgentState = { path: "/tmp/worker.plist", allowlist: ["old/repo", "old/repo"], raw: new Uint8Array([1]) }; readError: Error | undefined;
  async inspectCheckout(): Promise<CheckoutIdentity> { return identity; }
  async assertRepositoryAccess(): Promise<void> {}
  async listLabelNames(): Promise<readonly string[]> { return [...this.labels]; }
  async createLabel(_repository: string, label: (typeof DEV_FLOW_LABELS)[number]): Promise<void> { this.created.push(label.name); this.labels.add(label.name); }
  async readLaunchAgent(): Promise<LaunchAgentState> { if (this.readError) throw this.readError; return this.state; }
  async replaceLaunchAgent(_state: LaunchAgentState, allowlist: readonly string[]): Promise<void> { this.replaced += 1; this.state = { ...this.state, allowlist: [...allowlist] }; }
  async reloadAndVerify(): Promise<void> { this.reloaded += 1; if (this.failReload) throw new Error("reload failed"); }
  async restoreLaunchAgent(): Promise<void> { this.restored += 1; }
}

test("onboarding creates only missing labels, preserves existing labels, and never mutates an Issue", async () => {
  const adapter = new FakeAdapter(); adapter.labels.add("dev-flow-ready");
  const result = await onboardRepository(adapter, { checkout: identity.checkout });
  assert.deepEqual(result.createdLabels, DEV_FLOW_LABELS.slice(1).map((label) => label.name));
  assert.equal(adapter.created.includes("dev-flow-ready"), false);
  assert.equal(adapter.issueMutations, 0, "the onboarding adapter exposes no Issue mutation method");
  assert.equal(adapter.replaced, 1); assert.equal(adapter.reloaded, 1);
});

test("onboarding is fully idempotent once labels and allowlist exist", async () => {
  const adapter = new FakeAdapter(); for (const label of DEV_FLOW_LABELS) adapter.labels.add(label.name);
  adapter.state = { ...adapter.state, allowlist: ["old/repo", "owner/repo", "owner/repo"] };
  const result = await onboardRepository(adapter, { checkout: identity.checkout });
  assert.deepEqual(result.createdLabels, []); assert.equal(result.allowlistChanged, false); assert.equal(result.reloaded, false);
  assert.equal(adapter.created.length, 0); assert.equal(adapter.replaced, 0); assert.equal(adapter.reloaded, 0);
});

test("dry run has no GitHub, plist, or launchd writes", async () => {
  const adapter = new FakeAdapter();
  const result = await onboardRepository(adapter, { checkout: identity.checkout, dryRun: true });
  assert.equal(result.dryRun, true); assert.deepEqual(result.createdLabels, DEV_FLOW_LABELS.map((label) => label.name));
  assert.equal(adapter.created.length, 0); assert.equal(adapter.replaced, 0); assert.equal(adapter.reloaded, 0);
});

test("a reload failure restores the original LaunchAgent and reports safe partial completion", async () => {
  const adapter = new FakeAdapter(); adapter.failReload = true;
  await assert.rejects(() => onboardRepository(adapter, { checkout: identity.checkout }), /已建立的 labels 會保留/);
  assert.equal(adapter.replaced, 1); assert.equal(adapter.restored, 1);
});

test("a malformed plist fails before label writes", async () => {
  const adapter = new FakeAdapter(); adapter.readError = new Error("malformed plist");
  await assert.rejects(() => onboardRepository(adapter, { checkout: identity.checkout }), /malformed plist/);
  assert.equal(adapter.created.length, 0); assert.equal(adapter.replaced, 0);
});

test("repository and allowlist normalization reject unsafe values and retain stable order", () => {
  assert.equal(canonicalRepository("Owner/Repo"), "owner/repo");
  assert.throws(() => canonicalRepository("owner/repo/extra"), /unsafe/);
  assert.deepEqual(mergeAllowlist(["first/repo", " first/repo ", "second/repo"], "OWNER/NEW"), ["first/repo", "second/repo", "OWNER/NEW"]);
  assert.equal(parseGitHubSshOrigin("git@github.com:Owner/Repo.git"), "owner/repo");
  assert.throws(() => parseGitHubSshOrigin("https://github.com/owner/repo.git"), /git@github/);
  assert.throws(() => assertQueueCheckoutPath("/Users/skai.wu/side/nested/repo", "/Users/skai.wu/side", "owner/repo"), /<workspace>/);
  assert.throws(() => assertQueueCheckoutPath("/Users/skai.wu/side/other", "/Users/skai.wu/side", "owner/repo"), /<workspace>/);
  assert.throws(() => assertQueueCheckoutPath("/tmp/repo", "/Users/skai.wu/side", "owner/repo"), /escapes/);
  assert.doesNotThrow(() => assertQueueCheckoutPath("/Users/skai.wu/side/repo", "/Users/skai.wu/side", "owner/repo"));
  assert.deepEqual(parseLoadedAllowlist("environment = {\n  OTHER => owner/repo\n  DEV_FLOW_ALLOWED_REPOS => first/repo,Owner/Repo\n}"), ["first/repo", "Owner/Repo"]);
  assert.throws(() => parseLoadedAllowlist("environment = {\n  OTHER => owner/repo\n}"), /缺少/);
});
