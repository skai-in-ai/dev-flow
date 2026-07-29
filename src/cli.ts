import { PiProcessAdapter } from "./adapters/pi/pi-process-adapter.js";
import { loadHandoff } from "./handoff.js";
import { Orchestrator } from "./orchestrator.js";
import { ShellTestRunner } from "./test-runner.js";
import { modelFor } from "./models.js";
import type { ModelClassifier } from "./routing.js";
import { renderClassifierPrompt } from "./classifier-prompt.js";

const index = process.argv.indexOf("--handoff");
if (index < 0 || !process.argv[index + 1]) { console.error("Usage: npm run orchestrate -- --handoff path/to/handoff.json"); process.exitCode = 2; }
else {
  const handoff = await loadHandoff(process.argv[index + 1]);
  const agents = new PiProcessAdapter();
  const classifier: ModelClassifier = { classify: async ({ handoff: routingHandoff, diff }) => {
    const result = await agents.run({ role: "router", taskId: "routing", cwd: routingHandoff.repo, sessionDir: `${routingHandoff.repo}/.orchestrator/router-${Date.now()}`, model: modelFor(1, "reviewer"), prompt: renderClassifierPrompt(routingHandoff, diff), artifacts: {} });
    return parseClassifierResult(result.summary);
  } };
  const result = await new Orchestrator({ agents, tests: new ShellTestRunner(), classifier }).run(handoff);
  console.log(`\n${result.status.toUpperCase()} · Tier ${result.tier} · ${result.rounds}/3 rounds · run ${result.runId}`);
  process.exitCode = result.status === "failed" ? 1 : 0;
}

export function parseClassifierResult(text: string): Awaited<ReturnType<ModelClassifier["classify"]>> {
  const candidate = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  try { return JSON.parse(candidate ?? "") as Awaited<ReturnType<ModelClassifier["classify"]>>; } catch { return { reasons: ["Terra router returned invalid JSON; deterministic floor retained"], riskFlags: [] }; }
}
