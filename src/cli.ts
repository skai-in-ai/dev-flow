import { PiProcessAdapter } from "./adapters/pi/pi-process-adapter.js";
import { loadHandoff } from "./handoff.js";
import { loadSpec, specToHandoff, updateSpecStatus } from "./spec.js";
import { Orchestrator } from "./orchestrator.js";
import { ShellTestRunner } from "./test-runner.js";
import { classifierModel } from "./models.js";
import type { ModelClassifier } from "./routing.js";
import { renderClassifierPrompt } from "./classifier-prompt.js";

const handoffIndex = process.argv.indexOf("--handoff");
const specIndex = process.argv.indexOf("--spec");
if ((handoffIndex < 0 || !process.argv[handoffIndex + 1]) && (specIndex < 0 || !process.argv[specIndex + 1])) { console.error("Usage: npm run orchestrate -- --handoff path/to/handoff.json OR --spec path/to/spec.md"); process.exitCode = 2; }
else {
  const specPath = specIndex >= 0 ? process.argv[specIndex + 1] : undefined;
  const handoff = handoffIndex >= 0 ? await loadHandoff(process.argv[handoffIndex + 1]) : specToHandoff(await loadSpec(specPath!));
  const agents = new PiProcessAdapter();
  const classifier: ModelClassifier = { classify: async ({ handoff: routingHandoff, diff }) => {
    const result = await agents.run({ role: "router", taskId: "routing", cwd: routingHandoff.repo, sessionDir: `${routingHandoff.repo}/.orchestrator/router-${Date.now()}`, model: classifierModel(), prompt: renderClassifierPrompt(routingHandoff, diff), artifacts: {} });
    return parseClassifierResult(result.summary);
  } };
  const result = await new Orchestrator({ agents, tests: new ShellTestRunner(), classifier }).run(handoff);
  if (specPath && result.status === "ready_for_main") await updateSpecStatus(specPath, "ready_for_main");
  if (specPath && result.status === "needs_human") await updateSpecStatus(specPath, "needs_clarification");
  console.log(`\n${result.status.toUpperCase()} · Tier ${result.tier} · ${result.rounds}/3 rounds · run ${result.runId}`);
  process.exitCode = result.status === "failed" ? 1 : 0;
}

export function parseClassifierResult(text: string): Awaited<ReturnType<ModelClassifier["classify"]>> {
  const candidate = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  try { return JSON.parse(candidate ?? "") as Awaited<ReturnType<ModelClassifier["classify"]>>; } catch { return { reasons: ["Luna router returned invalid JSON; deterministic floor retained"], riskFlags: [] }; }
}
