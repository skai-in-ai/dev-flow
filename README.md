# dev-flow

**English** | [繁體中文](README.zh-TW.md)

A spec-driven development workflow built specifically on top of [Pi Coding Agent](https://github.com/badlogic/pi-mono). It runs implementation, deterministic tests, and independent review in isolated sessions, then either returns a verified working-tree diff or publishes a Draft PR for human review.

dev-flow is not another coding agent. It is a workflow above coding agents: it decides how a task is routed, verifies results with executable gates, preserves review context across repair cycles, and stops at an explicit human boundary.

> **Status:** Experimental MVP. Best suited to small or medium changes in an existing Git repository with meaningful tests and requirements that fit in one approved spec.

## What it demonstrates

- **Context isolation:** implementers and reviewers run in fresh Pi sessions and never share conversational history.
- **Deterministic verification:** test success comes from shell exit codes, not model claims.
- **Risk-aware routing:** deterministic risk floors and an LLM classifier select the review tier; the actual diff is classified again after implementation.
- **Bounded repair:** findings and responses survive across cycles, while repeated identical failures trip an early circuit breaker.
- **Recoverable human checkpoints:** a `needs_human` run can resume from the same retained worktree only after authorization and provenance checks.
- **Auditable execution:** each run records its diff, tests, routing decisions, cost, and a deterministic report.

```text
approved spec / handoff
  → baseline test preflight
  → deterministic risk floor + Luna classifier
  → isolated implementation
  → actual diff reclassification
  → deterministic tests
  → isolated review
  → fix / escalate / needs_spec
  → ready_for_main or needs_human
```

dev-flow deliberately targets Pi Coding Agent. The adapter boundary keeps Pi invocation and event handling out of the orchestration core; it does not imply that other agent providers are currently supported.

## Two entry points

Both entry points use the same core orchestrator. They differ in where a task comes from and what happens after all gates pass.

### A. GitHub Issue queue → Draft PR

Use this path to dispatch work from a phone or an external ChatGPT session, queue multiple tasks, and review the result later on GitHub.

```text
Create a Dev-flow task Issue
  → status: approved + dev-flow-ready
  → Mac worker claims the Issue
  → isolated worktree and branch from the claimed remote SHA
  → core orchestrator
  ├─ ready_for_main: commit + push + Draft PR
  └─ needs_human: report on the Issue + retained worktree
       → dev-flow-resume + a new authorized comment
       → next attempt on the same Issue and worktree
```

- The worker only processes allowlisted repositories.
- Each Issue gets an isolated worktree and a `codex/issue-*` branch.
- It commits, pushes, and opens a Draft PR only after all gates pass.
- It never merges or deploys automatically.

#### Resume a `needs_human` task

There is no need to open a new Issue. After confirming that the retained worktree has no unexplained changes:

1. A collaborator with repository write access comments after the latest needs-human report:

   ```text
   /dev-flow resume narrow fix <what to change in this attempt>
   ```

2. Add the `dev-flow-resume` label.
3. The worker validates the comment, attempt claim, worktree path, origin, branch, HEAD, and Git state before continuing.

The agent does not run without a new decision, sufficient permission, and trusted provenance. Resume does not rebuild or discard the worktree and does not accept `rebuild` or `cancel` commands.

See [GitHub Issue queue](docs/modules/github-issue-queue.md) for labels, claims, resume behavior, publication, and launchd setup. The detailed documentation is currently written in Traditional Chinese.

### B. Pi / Remote Pi / CLI → working-tree diff

Use this path when you are discussing a change in a Pi session and want to turn the conclusion into a spec and start work in the current repository.

```text
Discuss the change in a Pi / Remote Pi session
  → /dev-flow
  ├─ incomplete: save draft / needs_clarification → continue discussion
  └─ complete: save approved spec → core orchestrator
       ├─ ready_for_main: leave changes in the current working tree
       └─ needs_human: return control to the current session
```

- `/dev-flow` distills the current conversation and starts only when the spec is complete.
- `/dev` starts from an existing approved spec without rebuilding it from the conversation.
- `bin/dev-flow`, `--spec`, and `--handoff` expose the same path through the CLI.
- This path does not commit, push, open a PR, merge, or deploy.

See [Mobile and Pi entry point](docs/modules/mobile-entrypoint.md) for session-pointer details.

## Which path should I use?

| Situation | Entry point |
|:---|:---|
| Dispatch from a phone or external ChatGPT and review later on GitHub | A: Issue queue |
| Queue multiple tasks with isolated branches and Draft PRs | A: Issue queue |
| Continue directly from a Pi / Remote Pi discussion | B: `/dev-flow` |
| Start from an approved spec or handoff | B: `/dev` or CLI |
| Build a new project from scratch, explore unclear requirements, or work without meaningful tests | Do not use the orchestrator yet |

## Core behavior

- Every role gets a new Pi session; reviewers do not inherit the implementer's conversation.
- `decisions.json` preserves findings and implementer responses across cycles.
- Test outcomes are determined by shell exit codes.
- A run allows up to three repair rounds and four implementation attempts; repeated identical failures stop early.
- The default is `max-tier 1`; Tier 2 adds a Terra reviewer and Sol final review.
- Every run writes its diff, tests, routing, cost, and `report.md` under `.orchestrator/runs/`.

See [Orchestration](docs/modules/orchestration.md), [Routing](docs/modules/routing.md), and [Architecture](docs/architecture.md) for the implementation details.

## Installation

Requirements: Node.js, Pi Coding Agent CLI, and a working Codex OAuth login.

```bash
git clone git@github.com:skai-in-ai/dev-flow.git
cd dev-flow
npm install
npm test
```

`npm install` only creates the local `node_modules`; it does not install or enable a LaunchAgent.

## Quick start

### Pi / Remote Pi / CLI

Link `extensions/orchestrate.ts` into your Pi workspace's `.pi/extensions/`, run `/reload`, then continue in the same session:

```text
Discuss the requirement with the agent
/dev-flow
```

### Existing spec

```bash
/path/to/dev-flow/bin/dev-flow /absolute/path/to/spec.md
```

### Existing handoff

```bash
npm run orchestrate -- --handoff /absolute/path/to/handoff.json
```

### GitHub Issue queue

Before adding an existing checkout to the queue, explicitly onboard it once. Onboarding creates missing workflow labels and updates the local worker allowlist, but it **never** adds `dev-flow-ready` to an Issue:

```bash
/path/to/dev-flow/bin/dev-flow-onboard /absolute/path/to/checkout
```

Use `--dry-run` first to inspect the labels and LaunchAgent reload. Onboarding is a local operator trust decision; the worker never expands its own allowlist.

```bash
export DEV_FLOW_ALLOWED_REPOS=OWNER/REPOSITORY
export DEV_FLOW_WORKSPACE_ROOT=/Users/skai.wu/side
export DEV_FLOW_MAX_TIER=1

/path/to/dev-flow/bin/dev-flow-worker
```

The GitHub **Dev-flow task** template starts with `status: draft`. Complete all required sections, remove the official placeholders, change the status to `approved`, and then add `dev-flow-ready`. For periodic polling on macOS, use the [launchd example](deployment/dev-flow-worker.plist.example).

## Security boundaries

- The implementer gets read/write/edit/bash tools; reviewers get read/grep/find/ls only. This is a tool allowlist, not an OS sandbox.
- Test commands in an approved spec are executed by a shell. Approval is not sandboxing, so specs must come from trusted sources.
- `scope.include/exclude` is a prompt and review contract, not deterministic path enforcement.
- The GitHub queue protects worktree creation with a repository allowlist, workspace containment, origin matching, remote SHA verification, and atomic claims. A human must explicitly onboard each new repository; onboarding verifies a queue-addressable checkout and SSH origin, and never authorizes an Issue.
- The stale scan checks only open `dev-flow-running` Issues in allowlisted repositories. It trusts claim comments only when they were posted by the verified worker identity and match the local `claim.json`, while remaining compatible with the legacy claim format. Because markers and fixed text can be copied, author identity and ledger matching are required gates. The scan only adds `dev-flow-needs-human` and a reminder comment; it never recovers work, changes existing labels, worktrees, branches, or claim refs, or infers process liveness.
- After a resume claim succeeds and before any agent call, the worker fetches a missing claimed SHA and compares the retained worktree—including uncommitted changes—with the default branch using a temporary Git index. It continues only when the change is mergeable; conflicts or an overlong authorization decision return to `needs_human` without modifying the retained worktree.
- Draft PR bodies accept only typed spec, Git, and verification evidence. Raw agent events, prompts, full reports, and ledgers are not published.
- The core orchestrator never commits or pushes. Only the optional Issue queue wrapper publishes an isolated branch and Draft PR after all gates pass.
- The system has no HTTP API, webhook, dashboard, automatic merge, or deployment.

See [Testing and safety](docs/rules/testing-and-safety.md) and the [threat model](docs/architecture.md#isolation-邊界) for the complete rules.

## Documentation

Detailed documentation is currently maintained in Traditional Chinese.

| Topic | Document |
|:---|:---|
| Positioning, scope, and both entry points | [Overview](docs/overview.md) |
| Pi / Remote Pi / mobile entry | [Mobile entry point](docs/modules/mobile-entrypoint.md) |
| GitHub Issue queue, resume, and launchd | [GitHub Issue queue](docs/modules/github-issue-queue.md) |
| Core retry and review flow | [Orchestration](docs/modules/orchestration.md) |
| Tier and model routing | [Routing](docs/modules/routing.md) |
| Spec and handoff contracts | [Spec](docs/contracts/spec.md), [Handoff](docs/contracts/handoff.md) |
| Architecture and artifacts | [Architecture](docs/architecture.md) |
| Testing and safety rules | [Testing and safety](docs/rules/testing-and-safety.md) |

## License

[MIT](LICENSE)
