import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { DEV_FLOW_LABELS } from "./github-queue.js";

const execFileAsync = promisify(execFile);
export const DEFAULT_WORKSPACE_ROOT = "/Users/skai.wu/side";
export const DEFAULT_LAUNCH_AGENT_LABEL = "tw.lifestay.dev-flow-worker";

export interface CheckoutIdentity { repository: string; checkout: string; workspaceRoot: string; }
export interface LaunchAgentState { path: string; allowlist: readonly string[]; raw: Uint8Array; }
export interface OnboardingAdapter {
  inspectCheckout(checkout: string, workspaceRoot: string): Promise<CheckoutIdentity>;
  assertRepositoryAccess(repository: string): Promise<void>;
  listLabelNames(repository: string): Promise<readonly string[]>;
  createLabel(repository: string, label: (typeof DEV_FLOW_LABELS)[number]): Promise<void>;
  readLaunchAgent(path: string, workspaceRoot: string): Promise<LaunchAgentState>;
  replaceLaunchAgent(state: LaunchAgentState, allowlist: readonly string[]): Promise<void>;
  reloadAndVerify(path: string, repository: string): Promise<void>;
  restoreLaunchAgent(state: LaunchAgentState): Promise<void>;
}
export interface OnboardingOptions { checkout: string; workspaceRoot?: string; plistPath?: string; dryRun?: boolean; }
export interface OnboardingResult { repository: string; createdLabels: string[]; allowlistChanged: boolean; reloaded: boolean; dryRun: boolean; }

export function canonicalRepository(value: string): string {
  const match = value.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  if (!match) throw new Error(`unsafe repository name: ${value}`);
  return `${match[1]}/${match[2]}`.toLowerCase();
}
export function mergeAllowlist(existing: readonly string[], repository: string): string[] {
  const wanted = canonicalRepository(repository);
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of existing) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const canonical = canonicalRepository(trimmed);
    if (!seen.has(canonical)) { seen.add(canonical); output.push(trimmed); }
  }
  if (!seen.has(wanted)) output.push(repository);
  return output;
}
export function assertQueueCheckoutPath(checkout: string, workspaceRoot: string, repository: string): void {
  if (!isWithin(workspaceRoot, checkout)) throw new Error("checkout escapes workspace root");
  const repositoryName = canonicalRepository(repository).split("/")[1];
  if (resolve(checkout) !== resolve(workspaceRoot, repositoryName)) throw new Error("checkout 必須位於 queue 的 <workspace>/<repository-name> 路徑");
}
export function parseGitHubSshOrigin(origin: string): string {
  const match = origin.trim().match(/^git@github\.com:([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\.git$/i);
  if (!match) throw new Error("checkout origin 必須是 git@github.com:OWNER/REPOSITORY.git");
  return canonicalRepository(`${match[1]}/${match[2]}`);
}
export function parseLoadedAllowlist(output: string): string[] {
  const match = output.match(/^\s*DEV_FLOW_ALLOWED_REPOS\s*=>\s*(.*?)\s*$/m);
  if (!match) throw new Error("launchctl output 缺少 DEV_FLOW_ALLOWED_REPOS");
  return match[1].split(",").map((item) => item.trim()).filter(Boolean);
}

export async function onboardRepository(adapter: OnboardingAdapter, options: OnboardingOptions): Promise<OnboardingResult> {
  const workspaceRoot = options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const plistPath = options.plistPath ?? join(homedir(), "Library", "LaunchAgents", `${DEFAULT_LAUNCH_AGENT_LABEL}.plist`);
  const identity = await adapter.inspectCheckout(options.checkout, workspaceRoot);
  await adapter.assertRepositoryAccess(identity.repository);
  // Validate every local prerequisite before creating even an additive remote label.
  const launchAgent = await adapter.readLaunchAgent(plistPath, identity.workspaceRoot);
  const existingLabels = new Set(await adapter.listLabelNames(identity.repository));
  const missing = DEV_FLOW_LABELS.filter((label) => !existingLabels.has(label.name));
  const targetAlreadyAllowed = launchAgent.allowlist.some((item) => canonicalRepository(item.trim()) === identity.repository);
  // Re-running onboarding must not rewrite or reload an already-authorized worker, even if an
  // older manually-maintained allowlist contains unrelated duplicates.
  const allowlist = targetAlreadyAllowed ? [...launchAgent.allowlist] : mergeAllowlist(launchAgent.allowlist, identity.repository);
  const allowlistChanged = !targetAlreadyAllowed && allowlist.join("\u0000") !== launchAgent.allowlist.join("\u0000");
  if (options.dryRun) return { repository: identity.repository, createdLabels: missing.map((label) => label.name), allowlistChanged, reloaded: allowlistChanged, dryRun: true };

  for (const label of missing) {
    try { await adapter.createLabel(identity.repository, label); }
    catch (error) {
      // GitHub label creation may race a second explicit onboarding command. Re-read once;
      // never force-update a label another maintainer already owns.
      if (!(await adapter.listLabelNames(identity.repository)).includes(label.name)) throw error;
    }
  }
  if (!allowlistChanged) return { repository: identity.repository, createdLabels: missing.map((label) => label.name), allowlistChanged: false, reloaded: false, dryRun: false };
  try {
    await adapter.replaceLaunchAgent(launchAgent, allowlist);
    await adapter.reloadAndVerify(plistPath, identity.repository);
  } catch (error) {
    let rollback = "已復原原始 plist 並嘗試重載舊設定";
    try { await adapter.restoreLaunchAgent(launchAgent); }
    catch (rollbackError) { rollback = `復原失敗：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`; }
    throw new Error(`LaunchAgent 更新失敗；${rollback}。已建立的 labels 會保留，可安全重試。原始錯誤：${error instanceof Error ? error.message : String(error)}`);
  }
  return { repository: identity.repository, createdLabels: missing.map((label) => label.name), allowlistChanged: true, reloaded: true, dryRun: false };
}

async function command(command: string, args: string[], cwd?: string): Promise<string> {
  return (await execFileAsync(command, args, { cwd, maxBuffer: 4 * 1024 * 1024 })).stdout;
}
function isWithin(root: string, path: string): boolean { const value = relative(root, path); return value === "" || (!value.startsWith("..") && !isAbsolute(value)); }

/** Real host adapter. Tests use a fake and never touch GitHub or launchd. */
export class SystemOnboardingAdapter implements OnboardingAdapter {
  async inspectCheckout(checkout: string, workspaceRoot: string): Promise<CheckoutIdentity> {
    const allowed = await import("node:fs/promises").then(({ realpath }) => realpath(DEFAULT_WORKSPACE_ROOT));
    const root = await import("node:fs/promises").then(({ realpath }) => realpath(workspaceRoot));
    if (!isWithin(allowed, root)) throw new Error(`workspace root 必須位於 ${DEFAULT_WORKSPACE_ROOT}`);
    const path = await import("node:fs/promises").then(({ realpath }) => realpath(checkout));
    if (!isWithin(root, path)) throw new Error("checkout escapes workspace root");
    const topLevel = await import("node:fs/promises").then(async ({ realpath }) => realpath((await command("git", ["rev-parse", "--show-toplevel"], path)).trim()));
    if (path !== topLevel) throw new Error("checkout 必須是 Git worktree 根目錄");
    const repository = parseGitHubSshOrigin(await command("git", ["remote", "get-url", "origin"], path));
    assertQueueCheckoutPath(path, root, repository);
    return { repository, checkout: path, workspaceRoot: root };
  }
  async assertRepositoryAccess(repository: string): Promise<void> { await command("gh", ["api", `repos/${repository}`]); }
  async listLabelNames(repository: string): Promise<readonly string[]> {
    const raw = await command("gh", ["label", "list", "--repo", repository, "--limit", "1000", "--json", "name"]);
    return (JSON.parse(raw) as Array<{ name?: string }>).map((label) => label.name).filter((name): name is string => Boolean(name));
  }
  async createLabel(repository: string, label: (typeof DEV_FLOW_LABELS)[number]): Promise<void> {
    await command("gh", ["label", "create", label.name, "--repo", repository, "--color", label.color, "--description", label.description]);
  }
  async readLaunchAgent(path: string, workspaceRoot: string): Promise<LaunchAgentState> {
    const raw = await readFile(path);
    const json = await command("plutil", ["-convert", "json", "-o", "-", path]);
    const plist = JSON.parse(json) as { Label?: unknown; ProgramArguments?: unknown; EnvironmentVariables?: Record<string, unknown> };
    if (plist.Label !== DEFAULT_LAUNCH_AGENT_LABEL || !Array.isArray(plist.ProgramArguments) || plist.ProgramArguments[0] !== "/Users/skai.wu/side/dev-flow/bin/dev-flow-worker") throw new Error("plist 不是預期的 dev-flow worker LaunchAgent");
    const variable = plist.EnvironmentVariables?.DEV_FLOW_ALLOWED_REPOS;
    if (typeof variable !== "string") throw new Error("plist 缺少 EnvironmentVariables.DEV_FLOW_ALLOWED_REPOS");
    if (plist.EnvironmentVariables?.DEV_FLOW_WORKSPACE_ROOT !== workspaceRoot) throw new Error("plist workspace root 與 checkout workspace root 不符");
    return { path, allowlist: variable.split(","), raw };
  }
  async replaceLaunchAgent(state: LaunchAgentState, allowlist: readonly string[]): Promise<void> {
    const directory = await mkdtemp(join(dirname(state.path), ".dev-flow-onboard-"));
    const temporary = join(directory, basename(state.path));
    try {
      await copyFile(state.path, temporary);
      await command("plutil", ["-replace", "EnvironmentVariables.DEV_FLOW_ALLOWED_REPOS", "-string", allowlist.join(","), temporary]);
      await command("plutil", ["-lint", temporary]);
      await rename(temporary, state.path);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async reloadAndVerify(path: string, repository: string): Promise<void> {
    const domain = `gui/${userInfo().uid}`;
    await command("launchctl", ["bootout", domain, path]);
    await command("launchctl", ["bootstrap", domain, path]);
    const loaded = await command("launchctl", ["print", `${domain}/${DEFAULT_LAUNCH_AGENT_LABEL}`]);
    const allowlist = parseLoadedAllowlist(loaded).map(canonicalRepository);
    if (!allowlist.includes(canonicalRepository(repository))) throw new Error("launchctl reload 後未載入目標 repository");
  }
  async restoreLaunchAgent(state: LaunchAgentState): Promise<void> {
    const temporary = `${state.path}.restore-${process.pid}`;
    await writeFile(temporary, state.raw);
    await rename(temporary, state.path);
    const domain = `gui/${userInfo().uid}`;
    await command("launchctl", ["bootout", domain, state.path]).catch(() => undefined);
    await command("launchctl", ["bootstrap", domain, state.path]);
  }
}
