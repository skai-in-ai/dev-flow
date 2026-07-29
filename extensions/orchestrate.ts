import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ORCHESTRATOR = "/Users/skai.wu/side/agent-orchestrator";

export function parseOrchestrateArgs(args: string): { kind: "handoff"; path: string } | { kind: "draft"; repo: string; objective: string } | { kind: "invalid" } {
	const trimmed = args.trim(); if (!trimmed) return { kind: "invalid" };
	if (trimmed.endsWith(".json")) return { kind: "handoff", path: trimmed };
	const [repo, ...objective] = trimmed.split(/\s+/); return repo && objective.length ? { kind: "draft", repo, objective: objective.join(" ") } : { kind: "invalid" };
}
export async function createDraft(repoInput: string, objective: string): Promise<string> {
	const repo = resolve(repoInput); const exclude = resolve(repo, ".git/info/exclude"); const current = await readFile(exclude, "utf8").catch(() => ""); if (!current.split("\n").includes(".orchestrator/")) await appendFile(exclude, `${current.endsWith("\n") || !current ? "" : "\n"}.orchestrator/\n`); const dir = resolve(repo, ".orchestrator/handoffs"); await mkdir(dir, { recursive: true });
	const packageJson = await readFile(resolve(repo, "package.json"), "utf8").then(JSON.parse).catch(() => ({}));
	const scripts = packageJson.scripts ?? {}; const tests = ["test", "build"].filter((name) => typeof scripts[name] === "string").map((name) => `npm run ${name}`);
	const path = resolve(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
	await writeFile(path, `${JSON.stringify({ repo, objective, scope: { include: ["."] }, acceptanceCriteria: [objective], constraints: [], tests, riskNotes: [], delivery: { mode: "direct_main", requireApproval: true } }, null, 2)}\n`);
	return path;
}

/** Copy/link into ~/side/.pi/extensions; command remains non-blocking and never pushes. */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("orchestrate", {
		description: "Run isolated dev → review flow from handoff JSON",
		handler: async (args, ctx) => {
			const parsed = parseOrchestrateArgs(args);
			if (parsed.kind === "invalid") { ctx.ui.notify("Usage: /orchestrate /absolute/path/handoff.json OR /orchestrate <repo-path-without-spaces> <objective>", "error"); return; }
			const handoff = parsed.kind === "handoff" ? resolve(parsed.path) : await createDraft(parsed.repo, parsed.objective);
			ctx.ui.notify(`Using handoff: ${handoff}`, "info");
			const child = spawn("npm", ["run", "orchestrate", "--", "--handoff", handoff], { cwd: ORCHESTRATOR, stdio: ["ignore", "pipe", "pipe"] });
			let done = false;
			const notify = (chunk: unknown, level: "info" | "error") => { const text = String(chunk).trim(); if (text) ctx.ui.notify(text, level); };
			child.stdout.on("data", (chunk) => notify(chunk, "info")); child.stderr.on("data", (chunk) => notify(chunk, "error"));
			child.on("error", (error) => { if (!done) { done = true; ctx.ui.notify(error.message, "error"); } });
			child.on("close", (code) => { if (!done) { done = true; ctx.ui.notify(code === 0 ? "Orchestrator finished." : `Orchestrator stopped: ${code}`, code === 0 ? "info" : "error"); } });
		},
	});
}
