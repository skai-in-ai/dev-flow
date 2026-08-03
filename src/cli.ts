import { PiProcessAdapter } from "./adapters/pi/pi-process-adapter.js";
import { loadHandoff } from "./handoff.js";
import { loadSpec, returnSpecToDiscussion, specToHandoff, updateSpecStatus } from "./spec.js";
import { SpecNotReady, resolveTarget } from "./dev-flow.js";
import { Orchestrator, costOf } from "./orchestrator.js";
import { readFile } from "node:fs/promises";
import { ShellTestRunner } from "./test-runner.js";
import { classifierModel } from "./models.js";
import type { ModelClassifier } from "./routing.js";
import { renderClassifierPrompt } from "./classifier-prompt.js";

const handoffIndex = process.argv.indexOf("--handoff");
const specIndex = process.argv.indexOf("--spec");
// dev-flow 模式：不給任何旗標時，跑目前 repo 最新一份已定案的 spec。
const devFlow = handoffIndex < 0 && specIndex < 0;
const positional = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
if (!devFlow && (handoffIndex < 0 || !process.argv[handoffIndex + 1]) && (specIndex < 0 || !process.argv[specIndex + 1])) { console.error("Usage: dev-flow [path/to/spec.md] OR npm run orchestrate -- --handoff path/to/handoff.json OR --spec path/to/spec.md"); process.exitCode = 2; }
else {
  let specPath = specIndex >= 0 ? process.argv[specIndex + 1] : undefined;
  if (devFlow) {
    try {
      const target = await resolveTarget(process.cwd(), positional[0]);
      specPath = target.path;
      console.log(`dev-flow · ${target.spec.title}\n  ${target.path}`);
    } catch (error) {
      // 資訊不齊全就停在討論階段，不進實作。這是隨手分派能安全存在的前提。
      console.error(error instanceof SpecNotReady ? error.render() : error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
  if (process.exitCode === 2) { /* dev-flow gating 已阻擋，不啟動流程 */ } else {
  const handoff = handoffIndex >= 0 ? await loadHandoff(process.argv[handoffIndex + 1]) : specToHandoff(await loadSpec(specPath!));
  const agents = new PiProcessAdapter();
  const classifier: ModelClassifier = { classify: async ({ handoff: routingHandoff, diff, sessionDir }) => {
    const result = await agents.run({ role: "router", taskId: "routing", cwd: routingHandoff.repo, sessionDir, model: classifierModel(), prompt: renderClassifierPrompt(routingHandoff, diff), artifacts: {} });
    return { ...parseClassifierResult(result.summary), costUsd: costOf(result.usage) };
  } };
  const spec = specPath ? await readFile(specPath, "utf8") : undefined;
  const result = await new Orchestrator({ agents, tests: new ShellTestRunner(), classifier }).run(handoff, console.log, {
    specPath, specTitle: specPath ? await loadSpec(specPath).then((parsed) => parsed.title) : undefined, specMarkdown: spec,
  });
  if (specPath && result.status === "ready_for_main") await updateSpecStatus(specPath, "ready_for_main");
  if (specPath && result.status === "needs_human") {
    if (result.specGap) await returnSpecToDiscussion(specPath, result.specGap.semantic, result.specGap.candidates);
    else await updateSpecStatus(specPath, "needs_clarification");
  }
  console.log(`\n${result.status.toUpperCase()} · Tier ${result.tier} · ${result.cycles}/${result.maxCycles} cycles · US$${result.cost.total.toFixed(5)} · run ${result.runId}`);
  if (result.specGap) console.log(`\n缺的語意：${result.specGap.semantic}\n候選答案：\n${result.specGap.candidates.map((candidate, index) => `  ${String.fromCharCode(65 + index)}. ${candidate}`).join("\n")}`);
  process.exitCode = result.status === "failed" ? 1 : 0;
  }
}

export function parseClassifierResult(text: string): Awaited<ReturnType<ModelClassifier["classify"]>> {
  const candidate = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  try { return JSON.parse(candidate ?? "") as Awaited<ReturnType<ModelClassifier["classify"]>>; } catch { return { reasons: ["Luna router returned invalid JSON; deterministic floor retained"], riskFlags: [] }; }
}
