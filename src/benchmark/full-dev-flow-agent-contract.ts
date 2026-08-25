import type { TaskCompatibilityMetadata } from "./task-compatibility.js";

export interface FullDevFlowAgentEnvironment {
  cwd: string;
  artifactRoot: string;
}

export interface FullDevFlowAgentContext {
  taskId: string;
  taskMetadata: TaskCompatibilityMetadata;
  artifactRefs: string[];
  runId: string | null;
}

export interface FullDevFlowRunRequest {
  instruction: string;
  cwd: string;
  taskId: string;
  taskMetadata: TaskCompatibilityMetadata;
}

export interface FullDevFlowRunResult {
  runId: string;
  status: string;
  ledgerRoot: string;
  artifactRefs: string[];
}

export interface FullDevFlowRunner {
  run(request: FullDevFlowRunRequest): Promise<FullDevFlowRunResult>;
}

/**
 * Local contract-shaped skeleton for a future Harbor BaseInstalledAgent wrapper.
 * It intentionally has no Harbor dependency and no subprocess/orchestration loop.
 */
export class FullDevFlowInstalledAgentSkeleton {
  constructor(private readonly runner: FullDevFlowRunner) {}

  async install(environment: FullDevFlowAgentEnvironment): Promise<void> {
    assertEnvironment(environment);
  }

  async run(instruction: string, environment: FullDevFlowAgentEnvironment, context: FullDevFlowAgentContext): Promise<FullDevFlowRunResult> {
    assertEnvironment(environment);
    if (!instruction.trim()) throw new Error("Full dev-flow instruction must be non-empty");
    if (context.taskId !== context.taskMetadata.taskId) throw new Error("Full dev-flow context taskId does not match metadata");
    // The only workflow call is the injected existing core runner. No verifier
    // result is accepted here, so a later Harbor wrapper cannot leak reward back.
    return this.runner.run({ instruction, cwd: environment.cwd, taskId: context.taskId, taskMetadata: context.taskMetadata });
  }

  populateContextPostRun(context: FullDevFlowAgentContext, result: FullDevFlowRunResult): FullDevFlowAgentContext {
    return { ...context, runId: result.runId, artifactRefs: [...context.artifactRefs, ...result.artifactRefs] };
  }
}

function assertEnvironment(environment: FullDevFlowAgentEnvironment): void {
  if (!environment || typeof environment.cwd !== "string" || !environment.cwd.trim()) throw new Error("Full dev-flow environment requires cwd");
  if (typeof environment.artifactRoot !== "string" || !environment.artifactRoot.trim()) throw new Error("Full dev-flow environment requires artifactRoot");
}
