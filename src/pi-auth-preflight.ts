import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The provider used by the worker's Pi model selections. */
export const PI_PROVIDER_ID = "openai-codex";

export type PiAuthBlocked = { status: "blocked"; providerId: typeof PI_PROVIDER_ID; reason: "missing" | "malformed" | "expired" | "unreadable"; detail: string };
export type PiAuthReadiness =
  | { status: "ready"; providerId: typeof PI_PROVIDER_ID; source: "oauth_access" | "oauth_refresh"; note: string }
  | PiAuthBlocked;

export interface PiAuthPreflightOptions {
  /** Explicit path is useful for tests and controlled workers; otherwise match Pi's config path. */
  authPath?: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  /** Injectable reader keeps tests offline and makes the no-token boundary explicit. */
  readCredential?: (providerId: string, authPath: string) => Promise<unknown | undefined>;
}

/**
 * Read one credential using the same one-off, read-only shape as Pi's official
 * `readStoredCredential`. It intentionally does not instantiate AuthStorage:
 * AuthStorage.read() may resolve configured API-key commands, whereas a queue
 * readiness check must not execute commands or refresh anything.
 */
export async function readStoredCredential(providerId: string, authPath: string): Promise<unknown | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(authPath, "utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
    return (data as Record<string, unknown>)[providerId];
  } catch {
    return undefined;
  }
}

export function piAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim();
  return join(agentDir || join(env.HOME?.trim() || homedir(), ".pi", "agent"), "auth.json");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function blocked(reason: PiAuthBlocked["reason"], detail: string): PiAuthBlocked {
  return { status: "blocked", providerId: PI_PROVIDER_ID, reason, detail };
}

/**
 * Check only local Pi auth material. This makes no provider request, invokes no
 * model, and never returns credential values. An expired OAuth access token is
 * usable when the official stored refresh field is present; no refresh is
 * attempted here. A later runtime 401 remains authoritative for remote validity.
 */
export async function checkPiAuthReadiness(options: PiAuthPreflightOptions = {}): Promise<PiAuthReadiness> {
  const authPath = options.authPath ?? piAuthPath(options.env);
  let value: unknown;
  try {
    value = await (options.readCredential ?? readStoredCredential)(PI_PROVIDER_ID, authPath);
  } catch {
    return blocked("unreadable", "Pi auth storage could not be read");
  }
  if (value === undefined) return blocked("missing", "Pi openai-codex OAuth credential is not present");
  if (!record(value) || value.type !== "oauth") return blocked("malformed", "Pi openai-codex credential is not a canonical OAuth record");

  const access = value.access;
  const refresh = value.refresh;
  const expires = value.expires;
  if (!nonEmptyString(access) || typeof expires !== "number" || !Number.isFinite(expires)) {
    return blocked("malformed", "Pi openai-codex OAuth record is missing canonical access or expires fields");
  }
  const nowMs = options.nowMs ?? Date.now();
  if (expires > nowMs && !nonEmptyString(refresh)) {
    return blocked("malformed", "Pi openai-codex OAuth record is missing its canonical refresh field");
  }
  if (expires > nowMs) {
    return { status: "ready", providerId: PI_PROVIDER_ID, source: "oauth_access", note: "local OAuth access credential is present; remote validity is unverified" };
  }
  // Do not call the refresh endpoint. Presence of a canonical refresh value is
  // enough to let Pi perform its normal runtime refresh when it starts a call.
  if (!nonEmptyString(refresh)) return blocked("expired", "Pi openai-codex access credential is expired and no refresh credential is present");
  return { status: "ready", providerId: PI_PROVIDER_ID, source: "oauth_refresh", note: "local OAuth access is expired but a refresh credential is present; no refresh was attempted and remote validity is unverified" };
}

export type PiAuthPreflight = () => Promise<PiAuthReadiness>;
