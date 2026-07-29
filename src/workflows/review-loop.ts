import { DEFAULT_MAX_ROUNDS, mayRetry } from "../policies/completion-policy.js";

export type WorkflowPhase =
  | "implementing"
  | "testing"
  | "reviewing"
  | "completed"
  | "needs_human";

export type Failure =
  | { source: "tests"; details: string }
  | { source: "reviewer"; details: readonly string[] };

export interface WorkflowState {
  readonly phase: WorkflowPhase;
  readonly round: number;
  readonly maxRounds: number;
  readonly lastFailure?: Failure;
}

export function startReviewLoop(maxRounds = DEFAULT_MAX_ROUNDS): WorkflowState {
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error("maxRounds must be a positive integer");
  }

  return { phase: "implementing", round: 1, maxRounds };
}

export function implementationFinished(state: WorkflowState): WorkflowState {
  assertPhase(state, "implementing");
  return { ...state, phase: "testing" };
}

/** Test results are deterministic command output supplied by the caller, not an LLM judgement. */
export function testsFinished(state: WorkflowState, passed: boolean, output: string): WorkflowState {
  assertPhase(state, "testing");
  if (passed) return { ...state, phase: "reviewing" };

  return retryOrEscalate(state, { source: "tests", details: output });
}

/** Reviewer verdict must come from a fresh, isolated agent invocation. */
export function reviewFinished(
  state: WorkflowState,
  verdict: "pass" | "fail",
  findings: readonly string[] = [],
): WorkflowState {
  assertPhase(state, "reviewing");
  if (verdict === "pass") return { ...state, phase: "completed" };

  return retryOrEscalate(state, { source: "reviewer", details: findings });
}

function retryOrEscalate(state: WorkflowState, failure: Failure): WorkflowState {
  if (!mayRetry(state.round, state.maxRounds)) {
    return { ...state, phase: "needs_human", lastFailure: failure };
  }

  return {
    ...state,
    phase: "implementing",
    round: state.round + 1,
    lastFailure: failure,
  };
}

function assertPhase(state: WorkflowState, expected: WorkflowPhase): void {
  if (state.phase !== expected) {
    throw new Error(`Expected phase ${expected}, received ${state.phase}`);
  }
}

