import { access, constants, stat } from "node:fs/promises";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(nodeExecFile);
const REQUIRED_HARBOR_VERSION = "0.20.0";
type Status = "ready" | "missing" | "unavailable" | "mismatch" | "present" | "absent" | "unknown";

export interface PreflightCommandResult { exitCode: number; stdout: string; }
export type PreflightCommandRunner = (command: string, args: readonly string[]) => Promise<PreflightCommandResult>;

export interface HarborPreflightResult {
  harborBinary: Status;
  harborVersion: Status;
  dockerBinary: Status;
  dockerDaemon: Status;
  piBinary: Status;
  codexBinary: Status;
  codexAuth: Status;
  piAuth: Status;
  ready: boolean;
  exitCode: 0 | 1;
}

export interface HarborPreflightOptions {
  env?: NodeJS.ProcessEnv;
  commandRunner?: PreflightCommandRunner;
}

export async function runHarborPreflight(options: HarborPreflightOptions = {}): Promise<HarborPreflightResult> {
  const env = options.env ?? process.env;
  const command = options.commandRunner ?? createCommandRunner(env);
  const harbor = await versionCheck(command, "harbor", ["--version"], REQUIRED_HARBOR_VERSION);
  const docker = await versionCheck(command, "docker", ["--version"]);
  const dockerDaemon = docker.binary === "ready" ? (await command("docker", ["info"])).exitCode === 0 ? "ready" : "unavailable" : "unknown";
  const pi = await versionCheck(command, "pi", ["--version"]);
  const codex = await versionCheck(command, "codex", ["--version"]);
  const codexAuth = await authPresence(env);
  const piAuth = await piAuthPresence(env, codexAuth);
  const ready = harbor.binary === "ready" && harbor.version === "ready" && docker.binary === "ready" && dockerDaemon === "ready" && pi.binary === "ready" && codex.binary === "ready" && codexAuth === "present";
  return { harborBinary: harbor.binary, harborVersion: harbor.version, dockerBinary: docker.binary, dockerDaemon, piBinary: pi.binary, codexBinary: codex.binary, codexAuth, piAuth, ready, exitCode: ready ? 0 : 1 };
}

export function formatHarborPreflight(result: HarborPreflightResult): string {
  return [
    `harbor_binary=${result.harborBinary}`,
    `harbor_version=${result.harborVersion}`,
    `docker_binary=${result.dockerBinary}`,
    `docker_daemon=${result.dockerDaemon}`,
    `pi_binary=${result.piBinary}`,
    `codex_binary=${result.codexBinary}`,
    `codex_auth=${result.codexAuth}`,
    `pi_auth=${result.piAuth}`,
    `ready=${result.ready ? "true" : "false"}`,
  ].join("\n") + "\n";
}

async function versionCheck(command: PreflightCommandRunner, binary: string, args: readonly string[], expected?: string): Promise<{ binary: Status; version: Status }> {
  const result = await command(binary, args);
  if (result.exitCode !== 0) return { binary: "missing", version: "unknown" };
  if (!expected) return { binary: "ready", version: "ready" };
  return { binary: "ready", version: new RegExp(`(?:^|\\s)v?${escapeRegExp(expected)}(?:\\s|$)`).test(result.stdout) ? "ready" : "mismatch" };
}

function createCommandRunner(env: NodeJS.ProcessEnv): PreflightCommandRunner {
  return async (command, args) => {
    try {
      const result = await execFile(command, [...args], { env, encoding: "utf8", maxBuffer: 16 * 1024 });
      return { exitCode: 0, stdout: typeof result.stdout === "string" ? result.stdout : "" };
    } catch (error) {
      const candidate = error as { code?: unknown; stdout?: unknown };
      const exitCode = typeof candidate.code === "number" ? candidate.code : 1;
      return { exitCode, stdout: typeof candidate.stdout === "string" ? candidate.stdout : "" };
    }
  };
}

async function authPresence(env: NodeJS.ProcessEnv): Promise<Status> {
  if (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length > 0) return "present";
  const explicit = env.CODEX_AUTH_JSON_PATH;
  if (explicit && await readableFile(explicit)) return "present";
  if (env.CODEX_HOME && await readableFile(resolve(env.CODEX_HOME, "auth.json"))) return "present";
  if (env.HOME && await readableFile(resolve(env.HOME, ".codex", "auth.json"))) return "present";
  return "absent";
}

async function piAuthPresence(env: NodeJS.ProcessEnv, codexAuth: Status): Promise<Status> {
  if (env.PI_CODING_AGENT_DIR) return await readableDirectory(env.PI_CODING_AGENT_DIR) ? "present" : "unknown";
  if (codexAuth === "present" || (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length > 0)) return "present";
  return "unknown";
}

async function readableFile(path: string): Promise<boolean> { return access(path, constants.R_OK).then(() => true).catch(() => false); }
async function readableDirectory(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isDirectory() ? access(path, constants.R_OK).then(() => true).catch(() => false) : false).catch(() => false);
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export async function main(): Promise<void> {
  if (process.argv.length > 2) {
    process.stderr.write("harbor-preflight: no arguments accepted\n");
    process.exitCode = 1;
    return;
  }
  const result = await runHarborPreflight();
  process.stdout.write(formatHarborPreflight(result));
  process.exitCode = result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

// Keep the module's path available to bundlers without importing any Harbor code.
export const preflightModuleRoot = dirname(fileURLToPath(import.meta.url));
