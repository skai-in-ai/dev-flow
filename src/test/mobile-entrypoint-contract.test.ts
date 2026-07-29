import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extensionPath = fileURLToPath(new URL("../../extensions/orchestrate.ts", import.meta.url));

async function extensionSource(): Promise<string> { return readFile(extensionPath, "utf8"); }

test("dev-flow agent prompt requires a complete spec or explicit clarification", async () => {
  const source = await extensionSource();
  const prompt = source.match(/export function devFlowPrompt\(\): string \{\n\treturn `([\s\S]*?)`;\n\}/)?.[1];
  assert.ok(prompt, "devFlowPrompt must remain an inspectable, session-local instruction");
  assert.match(prompt, /目標 repo、目標、修改範圍、排除範圍、驗收條件、測試命令、風險與未決事項/);
  assert.match(prompt, /status: approved、unresolvedItems: \[\]/);
  assert.match(prompt, /不得猜測或開始實作/);
  assert.match(prompt, /draft 或 needs_clarification/);
});

test("dev-flow only auto-starts an approved spec with no unresolved items", async () => {
  const source = await extensionSource();
  const expression = source.match(/export function shouldAutoStartDevFlow\([^)]*\): boolean \{\n\treturn (.+);\n\}/)?.[1];
  assert.ok(expression, "shouldAutoStartDevFlow must remain a pure predicate");
  const shouldStart = new Function("pendingDevFlow", "status", "unresolvedItems", `return ${expression};`) as (pending: boolean, status: string, unresolved: string[]) => boolean;
  assert.equal(shouldStart(true, "approved", []), true);
  assert.equal(shouldStart(true, "draft", []), false);
  assert.equal(shouldStart(true, "approved", ["confirm scope"]), false);
  assert.equal(shouldStart(false, "approved", []), false);
  assert.match(source, /if \(shouldAutoStartDevFlow\(Boolean\(pendingDevFlow\), params\.status, params\.unresolvedItems\)\)/);
  assert.match(source, /catch \(error\) \{ await clearDevFlowRequest\(sessionId\);/);
});

test("dev-flow pending state is scoped to the injected agent turn", async () => {
  const source = await extensionSource();
  assert.match(source, /type DevFlowRequest = \{ requestId: string; requestedAt: string \}/);
  assert.match(source, /const DEV_FLOW_MARKER = "\[agent-orchestrator-dev-flow:"/);
  assert.match(source, /pi\.on\("before_agent_start"/);
  assert.match(source, /activeDevFlowTurns\.set\(ctx\.sessionManager\.getSessionId\(\), match\[1\]\)/);
  assert.match(source, /pi\.on\("agent_end"/);
  assert.match(source, /await clearDevFlowRequest\(sessionId, id\)/);
  assert.match(source, /clearDevFlowRequest\(sessionId: string, expectedRequestId\?: string\)/);
});
