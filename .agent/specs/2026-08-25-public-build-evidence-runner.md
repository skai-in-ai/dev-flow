---
title: Public build-output evidence runner
status: approved
created: 2026-08-25
---

## Objective

Add a small orchestrator-owned runner for operator-declared public build/test
checks. It executes bounded argv commands, stores a sanitized `build-evidence-1`
artifact, and gives the reviewer a structured summary. Existing handoffs and
repositories with no public checks retain their current behavior.

## Scope

- Add a validated `RepoConfig.publicChecks` contract.
- Support checks with an `id`, argv-array `command`, explicit relative `cwd`,
  timeout, expected exit codes, `required`, `mode` (`observe` or `blocking`),
  bounded stdout/stderr limits, and constrained literal/regex diagnostics.
- Execute checks at baseline/preflight and after every implementation cycle.
- Persist only sanitized, bounded evidence and inject its summary into reviewer
  artifacts and prompts.
- In blocking mode, a required public check failure follows the existing
  deterministic-test failure path; observe-only checks never change completion.
- Keep the Harbor external verifier as the sole benchmark acceptance decision.

## Threat model and non-goals

The command/configuration is trusted local operator input, but command output,
task files, repository contents, and environment variables are untrusted. The
runner must not invoke a shell, expand arbitrary environment values, emit auth,
prompt, session, or secret material, or read a hidden verifier. It uses argv
direct execution, a repository-relative allowlisted cwd, output byte caps,
literal or bounded regular-expression diagnostics, and redaction before writing
artifacts. It does not sandbox processes, infer benchmark answers, mutate the
workspace, install dependencies, run network checks, summarize raw logs with an
LLM, or replace Harbor verification.

## Semantics

- `baseline` evidence is recorded before model invocation. A required blocking
  check's normal non-zero exit or diagnostic match is a task-outcome observation
  and does not stop the agent (the untouched baseline may intentionally fail the
  task). Only execution failures (spawn error or timeout) are classified as
  infrastructure failure and stop before an agent call.
- `cycle-N` evidence is recorded after implementation and before reviewer. A
  required blocking task-outcome failure records a finding and may consume the
  next cycle. An execution failure is infrastructure evidence and fails closed.
- Observe checks are recorded and shown to reviewers but never affect the
  completion verdict.
- A check is passed only when it does not time out, exits with an expected code,
  and has no matching prohibited diagnostic pattern. Diagnostics are opt-in;
  no pattern means no diagnostic-based failure.
- Evidence includes only schema version, check identity, phase/cycle,
  durations, exit/timed-out/truncated state, bounded sanitized excerpts,
  diagnostic counts, and artifact-relative references.

## Acceptance criteria

- Invalid public-check manifests fail closed before execution.
- Shell metacharacters in an argv element are passed literally and cannot cause
  shell evaluation.
- Timeout and stdout/stderr caps terminate/bound execution without unhandled
  child-process errors.
- Secrets and absolute auth/session/home paths are redacted from evidence.
- Baseline task-outcome failure still invokes an agent; baseline execution
  failure does not invoke an agent and is classified as infrastructure failure.
- A timed-out child is terminated with SIGTERM, bounded grace, SIGKILL, and a
  final settlement fallback.
- Zero-length regex diagnostics fail validation and cannot hang matching.
- Observe failures do not alter `ready_for_main` behavior; blocking failures do.
- Reviewer receives bounded structured evidence with cycle provenance.
- Existing configs without `publicChecks` produce no new checks or behavior.
- TypeScript and affected Python tests pass; `git diff --check` passes.

## Non-goals / follow-ups

- No task-specific hidden-test gate or custom acceptance implementation.
- No PR, commit, merge, deployment, model invocation, or network trial.
- A later change may promote individually validated observe checks to blocking,
  but this change does not alter Harbor verifier semantics.
