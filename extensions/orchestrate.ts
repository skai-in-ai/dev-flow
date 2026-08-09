import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, appendFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 沒有任何路徑依賴 pi 的啟動目錄，因此從哪裡呼叫都一樣。
 *
 * - ORCHESTRATOR：由本檔案自己的位置推導（Node 預設會解開 symlink，因此
 *   從 <workspace>/.pi/extensions 連過來也會指回 repo 本體）。
 *   複製而非連結、導致推導不到 repo 時，可用 AGENT_ORCHESTRATOR_HOME 指定。
 * - STATE_ROOT：session pointer 放在使用者家目錄，與 cwd 無關。
 * - WORKSPACE_ROOT：選用的安全邊界。設了就限制只能分派該目錄下的 repo；
 *   不設則不限制目錄，只要求目標是 Git repo，相對名稱以呼叫端 cwd 解析。
 */
const SELF_DIR = dirname(fileURLToPath(import.meta.url));
function looksLikeOrchestrator(path: string): boolean { return existsSync(resolve(path, "package.json")) && existsSync(resolve(path, "src/cli.ts")); }
const DERIVED_HOME = resolve(SELF_DIR, "..");
const ORCHESTRATOR_ENV = process.env.AGENT_ORCHESTRATOR_HOME;
const ORCHESTRATOR = ORCHESTRATOR_ENV ? resolve(ORCHESTRATOR_ENV) : DERIVED_HOME;
const STATE_ROOT = resolve(process.env.AGENT_ORCHESTRATOR_STATE_DIR ?? resolve(homedir(), ".pi/agent-orchestrator"));
const WORKSPACE_ROOT = process.env.AGENT_ORCHESTRATOR_WORKSPACE_ROOT ? resolve(process.env.AGENT_ORCHESTRATOR_WORKSPACE_ROOT) : undefined;
const POINTER_ROOT = STATE_ROOT;
function assertOrchestratorHome(): string {
	if (looksLikeOrchestrator(ORCHESTRATOR)) return ORCHESTRATOR;
	throw new Error(`Could not locate the agent-orchestrator repo at ${ORCHESTRATOR}. Set AGENT_ORCHESTRATOR_HOME to its absolute path.`);
}
type Pointer = { repo: string; specPath: string; updatedAt: string };
type DevFlowRequest = { requestId: string; requestedAt: string };
const DEV_FLOW_MARKER = "[agent-orchestrator-dev-flow:";

export function parseOrchestrateArgs(args: string): { kind: "handoff"; path: string } | { kind: "draft"; repo: string; objective: string } | { kind: "invalid" } {
	const trimmed = args.trim(); if (!trimmed) return { kind: "invalid" };
	if (trimmed.endsWith(".json")) return { kind: "handoff", path: trimmed };
	const [repo, ...objective] = trimmed.split(/\s+/); return repo && objective.length ? { kind: "draft", repo, objective: objective.join(" ") } : { kind: "invalid" };
}
/** 未設定 WORKSPACE_ROOT 時不限制目錄，一律視為在界內。 */
function withinWorkspace(path: string): boolean {
	if (!WORKSPACE_ROOT) return true;
	const value = relative(WORKSPACE_ROOT, path); return value !== "" && !value.startsWith("..") && !value.includes("../");
}
function resolvedRepo(input: string, cwd: string): string {
	const base = WORKSPACE_ROOT ?? cwd;
	const repo = resolve(input.startsWith("/") ? input : input === "." ? cwd : resolve(base, input));
	if (!withinWorkspace(repo)) throw new Error(`repo must be under ${WORKSPACE_ROOT} (unset AGENT_ORCHESTRATOR_WORKSPACE_ROOT to allow any Git repo)`);
	return repo;
}
async function exists(path: string): Promise<boolean> { return access(path).then(() => true).catch(() => false); }
async function assertRepo(repo: string): Promise<void> { if (!await exists(resolve(repo, ".git"))) throw new Error(`not a Git repo: ${repo}`); }
async function ensureLedgerExcluded(repo: string): Promise<void> {
	const exclude = resolve(repo, ".git/info/exclude"); const current = await readFile(exclude, "utf8").catch(() => "");
	if (!current.split("\n").includes(".orchestrator/")) await appendFile(exclude, `${current.endsWith("\n") || !current ? "" : "\n"}.orchestrator/\n`);
}
export async function createDraft(repoInput: string, objective: string, cwd: string): Promise<string> {
	const repo = resolvedRepo(repoInput, cwd); await assertRepo(repo); await ensureLedgerExcluded(repo); const dir = resolve(repo, ".orchestrator/handoffs"); await mkdir(dir, { recursive: true });
	const packageJson = await readFile(resolve(repo, "package.json"), "utf8").then(JSON.parse).catch(() => ({}));
	const scripts = packageJson.scripts ?? {}; const tests = ["test", "build"].filter((name) => typeof scripts[name] === "string").map((name) => `npm run ${name}`);
	const path = resolve(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
	await writeFile(path, `${JSON.stringify({ repo, objective, scope: { include: ["."] }, acceptanceCriteria: [objective], constraints: [], tests, riskNotes: [], delivery: { mode: "direct_main", requireApproval: true } }, null, 2)}\n`);
	return path;
}
function list(items: string[]): string { return items.length ? items.map((item) => `- ${item}`).join("\n") : "無"; }
function assertRawCommands(commands: string[]): void { for (const command of commands) if (!command.trim() || /[\u3400-\u9fff]/.test(command) || /^(?:please\s+)?(?:run|execute)\s+(?:the\s+)?(?:tests?|build)\b/i.test(command.trim())) throw new Error(`testRequirements must contain raw executable shell commands (for example: npm test), not prose: ${command}`); }
function renderSpec(params: any, repo: string): string {
	const title = String(params.title).trim(); const createdAt = new Date().toISOString(); const status = String(params.status ?? "draft");
	const commands = (params.testRequirements ?? []).length ? (params.testRequirements ?? []).map((command: string) => `- \`${command}\``).join("\n") : "無";
	const invariantsAndNonGoals = list(params.invariantsAndNonGoals ?? []).replace(/^無$/, "none");
	return `---\nrepo: ${JSON.stringify(repo)}\nstatus: ${status}\ntitle: ${JSON.stringify(title)}\ncreated_at: ${JSON.stringify(createdAt)}\n---\n\n# ${title}\n\n## 目標\n${String(params.objective).trim()}\n\n## 背景與決策\n${String(params.backgroundAndDecisions ?? "無").trim() || "無"}\n\n## Invariants and non-goals\n${invariantsAndNonGoals}\n\n## 修改範圍\n${list(params.modificationScope ?? [])}\n\n## 排除範圍\n${list(params.excludedScope ?? [])}\n\n## 驗收條件\n${list(params.acceptanceCriteria ?? [])}\n\n## 測試要求\n${commands}\n\n## 風險\n${list(params.risks ?? [])}\n\n## 未決事項\n${list(params.unresolvedItems ?? [])}\n`;
}
async function writePointer(sessionId: string, pointer: Pointer): Promise<void> {
	await mkdir(resolve(POINTER_ROOT, "sessions"), { recursive: true });
	const data = `${JSON.stringify(pointer, null, 2)}\n`;
	await writeFile(resolve(POINTER_ROOT, "sessions", `${sessionId}.json`), data);
}
async function readPointer(sessionId: string): Promise<Pointer | undefined> {
	try { const pointer = JSON.parse(await readFile(resolve(POINTER_ROOT, "sessions", `${sessionId}.json`), "utf8")) as Pointer; if (withinWorkspace(resolve(pointer.repo)) && withinWorkspace(resolve(pointer.specPath))) return pointer; } catch { /* no session pointer */ }
}
function devFlowPendingPath(sessionId: string): string { return resolve(POINTER_ROOT, "sessions", `${sessionId}.dev-flow-pending.json`); }
function requestId(): string { return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
export function devFlowPrompt(): string {
	return `請根據本 session 到目前為止的討論，整理出可執行的開發 spec。這是 /dev-flow：
1. 先從討論確認目標 repo、目標、背景與決策、不變量與非目標、修改範圍、排除範圍、驗收條件、測試命令、風險與未決事項。不變量與非目標若討論未宣告，可省略不填；不得自行杜撰。
2. 資訊完整且使用者已確認決策時，必須呼叫 save_agent_spec，使用 status: approved、unresolvedItems: []；測試要求只能填原始可執行 shell command（例如 npm test）。保存後不要自行實作，也不要叫使用者再輸入 /dev；extension 會自動啟動隔離的 dev → review 流程。
3. 只要有一項關鍵資訊不足、repo 不明、或使用者尚未確認決策，就不得猜測或開始實作。若 repo 已知，呼叫 save_agent_spec 並使用 draft 或 needs_clarification，將已知內容保存；接著用條列提出具體、最少必要的問題。若 repo 也不明，直接提出問題即可。
請只根據本 session 已有資訊判斷，不要讀取或沿用其他 session 的 spec。`;
}
export function shouldAutoStartDevFlow(pendingDevFlow: boolean, status: string, unresolvedItems: string[]): boolean {
	return pendingDevFlow && status === "approved" && unresolvedItems.length === 0;
}
async function requestDevFlow(sessionId: string, cwd: string): Promise<DevFlowRequest> {
	const resolvedCwd = resolve(cwd);
	if (WORKSPACE_ROOT && resolvedCwd !== WORKSPACE_ROOT && !withinWorkspace(resolvedCwd)) throw new Error(`/dev-flow must run from ${WORKSPACE_ROOT} or a directory under it (unset AGENT_ORCHESTRATOR_WORKSPACE_ROOT to allow any directory)`);
	const request: DevFlowRequest = { requestId: requestId(), requestedAt: new Date().toISOString() };
	await mkdir(resolve(POINTER_ROOT, "sessions"), { recursive: true });
	await writeFile(devFlowPendingPath(sessionId), `${JSON.stringify(request)}\n`);
	return request;
}
async function readDevFlowRequest(sessionId: string): Promise<DevFlowRequest | undefined> {
	try { const request = JSON.parse(await readFile(devFlowPendingPath(sessionId), "utf8")) as DevFlowRequest; return request.requestId ? request : undefined; } catch { return undefined; }
}
async function clearDevFlowRequest(sessionId: string, expectedRequestId?: string): Promise<void> {
	if (expectedRequestId && (await readDevFlowRequest(sessionId))?.requestId !== expectedRequestId) return;
	await unlink(devFlowPendingPath(sessionId)).catch(() => {});
}
async function latestApprovedSpec(cwd: string): Promise<string | undefined> {
	const directory = resolve(cwd, ".agent/specs");
	if (!withinWorkspace(directory) || !await exists(directory)) return undefined;
	const names = (await readdir(directory)).filter((name) => name.endsWith(".md")).sort().reverse();
	for (const name of names) { const path = resolve(directory, name); if ((await readFile(path, "utf8")).match(/^status:\s*approved\s*$/m)) return path; }
}
function run(commandArgs: string[], ctx: { ui: { notify(message: string, level?: "info" | "warning" | "error"): void } }): void {
	let home: string;
	try { home = assertOrchestratorHome(); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); return; }
	const child = spawn("npm", ["run", "orchestrate", "--", ...commandArgs], { cwd: home, stdio: ["ignore", "pipe", "pipe"] }); let done = false;
	const notify = (chunk: unknown, level: "info" | "error") => { const text = String(chunk).trim(); if (text) ctx.ui.notify(text, level); };
	child.stdout.on("data", (chunk) => notify(chunk, "info")); child.stderr.on("data", (chunk) => notify(chunk, "error"));
	child.on("error", (error) => { if (!done) { done = true; ctx.ui.notify(error.message, "error"); } }); child.on("close", (code) => { if (!done) { done = true; ctx.ui.notify(code === 0 ? "Orchestrator finished." : `Orchestrator stopped: ${code}`, code === 0 ? "info" : "error"); } });
}

function createSaveSpecTool() { return defineTool({
	name: "save_agent_spec", label: "Save agent spec", description: "Save the agreed development spec and set it as the current session pointer. Use after discussion; set status to approved only when unresolvedItems is empty and the user has confirmed it.", promptSnippet: "Save an agreed development spec for the later /dev workflow.", promptGuidelines: ["When the user says「把結論整理成 spec」or asks to save a spec, call save_agent_spec instead of merely describing a spec in chat.", "Write status: approved only after the user has confirmed the decision and unresolvedItems is empty.", "testRequirements must be raw executable shell commands only, such as npm test or npm run build; never write prose such as「在目標 repo 執行 npm test」.", "When invoked by /dev-flow, an approved spec starts the workflow automatically. Do not start implementation yourself or ask the user to enter /dev."],
	parameters: Type.Object({ repo: Type.String({ description: WORKSPACE_ROOT ? `Target repo name under the workspace root (${WORKSPACE_ROOT}), or its absolute path` : "Absolute path to the target Git repo, or a name/relative path resolved against the current working directory" }), title: Type.String(), status: Type.Union([Type.Literal("draft"), Type.Literal("approved"), Type.Literal("needs_clarification")]), objective: Type.String(), backgroundAndDecisions: Type.String(), invariantsAndNonGoals: Type.Optional(Type.Array(Type.String({ description: "Declared invariant to preserve or explicit non-goal; omit when none was discussed" }))), modificationScope: Type.Array(Type.String()), excludedScope: Type.Array(Type.String()), acceptanceCriteria: Type.Array(Type.String()), testRequirements: Type.Array(Type.String({ description: "Raw executable shell command only, e.g. npm test; never natural-language prose" })), risks: Type.Array(Type.String()), unresolvedItems: Type.Array(Type.String()) }),
	async execute(_id: string, params: any, _signal: AbortSignal, _update: unknown, ctx: { cwd: string; sessionManager: { getSessionId(): string }; ui: { notify(message: string, level?: "info" | "warning" | "error"): void } }) {
		const sessionId = ctx.sessionManager.getSessionId();
		try {
			if (params.status === "approved" && params.unresolvedItems.length) throw new Error("An approved spec cannot have unresolvedItems");
			assertRawCommands(params.testRequirements);
			const repo = resolvedRepo(params.repo, ctx.cwd); await assertRepo(repo); const dir = resolve(repo, ".agent/specs"); await mkdir(dir, { recursive: true });
			const slug = params.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-+|-+$/g, "") || "task"; const specPath = resolve(dir, `${new Date().toISOString().slice(0, 10)}-${slug}.md`);
			const pendingDevFlow = await readDevFlowRequest(sessionId);
			await writeFile(specPath, renderSpec(params, repo)); await writePointer(sessionId, { repo, specPath, updatedAt: new Date().toISOString() }); await clearDevFlowRequest(sessionId);
			if (shouldAutoStartDevFlow(Boolean(pendingDevFlow), params.status, params.unresolvedItems)) {
				run(["--spec", specPath], ctx);
				return { content: [{ type: "text" as const, text: `Spec saved: ${specPath}\nStatus: approved\n/dev-flow has started the isolated dev → review flow automatically.` }], details: { repo, specPath, status: params.status, started: true } };
			}
			return { content: [{ type: "text" as const, text: `Spec saved: ${specPath}\nStatus: ${params.status}${pendingDevFlow ? "\nThe flow is paused; ask the user the unresolved questions, then they can run /dev-flow again." : "\nUse /dev when it is approved and has no unresolved items."}` }], details: { repo, specPath, status: params.status, started: false } };
		} catch (error) { await clearDevFlowRequest(sessionId); return { content: [{ type: "text" as const, text: `Could not save spec: ${error instanceof Error ? error.message : String(error)}` }], details: { error: String(error) } }; }
	},
	}); }

/** Copy/link into <workspace>/.pi/extensions. /dev intentionally reads only an approved spec, never the chat transcript. */
export default function (pi: ExtensionAPI) {
	const activeDevFlowTurns = new Map<string, string>();
	pi.on("before_agent_start", (event, ctx) => {
		const match = event.prompt.match(/\[agent-orchestrator-dev-flow:([^\]]+)\]/);
		if (match) activeDevFlowTurns.set(ctx.sessionManager.getSessionId(), match[1]);
	});
	pi.on("agent_end", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId(); const id = activeDevFlowTurns.get(sessionId);
		if (!id) return;
		activeDevFlowTurns.delete(sessionId); await clearDevFlowRequest(sessionId, id);
	});
	pi.registerTool(createSaveSpecTool());
	pi.registerCommand("dev-flow", { description: "Turn this discussion into a spec, then auto-run isolated dev → review when ready", handler: async (args, ctx) => {
		if (args.trim()) { ctx.ui.notify("/dev-flow uses the current discussion; it does not accept arguments.", "warning"); return; }
		try {
			const request = await requestDevFlow(ctx.sessionManager.getSessionId(), ctx.cwd);
			ctx.ui.notify("Reviewing this session's discussion and preparing a spec…", "info");
			pi.sendUserMessage(`${devFlowPrompt()}\n${DEV_FLOW_MARKER}${request.requestId}]`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		} catch (error) { await clearDevFlowRequest(ctx.sessionManager.getSessionId()); ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
	} });
	pi.registerCommand("dev", { description: "Run the current approved spec through isolated dev → review", handler: async (args, ctx) => {
		if (args.trim()) { ctx.ui.notify("/dev uses the current approved spec; discuss normally, ask the agent to save the spec, then run /dev.", "warning"); return; }
		const pointer = await readPointer(ctx.sessionManager.getSessionId()); const specPath = pointer?.specPath ?? await latestApprovedSpec(ctx.cwd);
		if (!specPath) { ctx.ui.notify("No approved spec is selected. Ask the agent:「把結論整理成 spec」; it will save the pointer, then use /dev.", "warning"); return; }
		ctx.ui.notify(`Starting from spec: ${specPath}`, "info"); run(["--spec", specPath], ctx);
	} });
	pi.registerCommand("orchestrate", { description: "Run isolated dev → review flow from handoff JSON", handler: async (args, ctx) => {
		try { const parsed = parseOrchestrateArgs(args); if (parsed.kind === "invalid") { ctx.ui.notify("Usage: /orchestrate /absolute/path/handoff.json OR /orchestrate <repo-path-without-spaces> <objective>", "error"); return; } const handoff = parsed.kind === "handoff" ? resolve(parsed.path) : await createDraft(parsed.repo, parsed.objective, ctx.cwd); ctx.ui.notify(`Using handoff: ${handoff}`, "info"); run(["--handoff", handoff], ctx); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
	} });
}
