import { PiProcessAdapter } from "./adapters/pi/pi-process-adapter.js";
import type { AgentRunner } from "./agents/contracts.js";
import type { Handoff, RepoConfig } from "./handoff.js";
import { classifierModel } from "./models.js";
import { costOf, Orchestrator, type RunOutcome, type RunSource } from "./orchestrator.js";
import { renderClassifierPrompt } from "./classifier-prompt.js";
import type { ModelClassifier } from "./routing.js";
import { ShellTestRunner } from "./test-runner.js";

/**
 * Shared wiring for the normal CLI and the Harbor bridge.
 *
 * The bridge deliberately delegates here instead of constructing a second
 * orchestration loop. Keeping the adapter, classifier and test runner in one
 * place also makes changes to the normal CLI and the evaluation harness
 * fail together at compile/test time.
 */
export function createCoreRunner(config?: RepoConfig): {
  agents: AgentRunner;
  run: (handoff: Handoff, source?: RunSource, onProgress?: (line: string) => void) => Promise<RunOutcome>;
} {
  const agents = new PiProcessAdapter();
  const classifier: ModelClassifier = {
    classify: async ({ handoff: routingHandoff, diff, sessionDir }) => {
      const result = await agents.run({
        role: "router",
        taskId: "routing",
        cwd: routingHandoff.repo,
        sessionDir,
        model: classifierModel(),
        prompt: renderClassifierPrompt(routingHandoff, diff),
        artifacts: {},
      });
      return { ...parseClassifierResult(result.summary), costUsd: costOf(result.usage) };
    },
  };
  const orchestrator = new Orchestrator({ agents, tests: new ShellTestRunner(), classifier, config });
  return {
    agents,
    run: (handoff, source = {}, onProgress = console.log) => orchestrator.run(handoff, onProgress, source),
  };
}

export async function runOrchestratorFromHandoff(
  handoff: Handoff,
  source: RunSource = {},
  onProgress: (line: string) => void = console.log,
  config?: RepoConfig,
): Promise<RunOutcome> {
  return createCoreRunner(config).run(handoff, source, onProgress);
}

export function parseClassifierResult(text: string): Awaited<ReturnType<ModelClassifier["classify"]>> {
  const candidate = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  try {
    return JSON.parse(candidate ?? "") as Awaited<ReturnType<ModelClassifier["classify"]>>;
  } catch {
    return { reasons: ["Luna router returned invalid JSON; deterministic floor retained"], riskFlags: [] };
  }
}
