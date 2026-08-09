---
status: approved
max_tier: 0
---

# Update public setup and deployed queue documentation

## Objective
Update README, GitHub queue documentation, and the launchd example so public setup instructions use the canonical dev-flow repository name and accurately explain installation, operation, health checks, and the currently deployed Mac worker pattern.

## Background and decisions
- The canonical repository is git@github.com:skai-in-ai/dev-flow.git; the old WuSKai403/agent-orchestrator repository is archived.
- The local historical checkout may still be named agent-orchestrator. The deployed worker uses an in-workspace symlink ~/side/dev-flow pointing to that checkout because queue lookup maps OWNER/REPOSITORY to a same-named checkout.
- The production LaunchAgent label is tw.lifestay.dev-flow-worker, polls every 300 seconds, and writes stdout/stderr to /tmp/dev-flow-worker.out and /tmp/dev-flow-worker.err.
- Public documentation must distinguish reusable example configuration from this maintainer's deployed instance. Do not present a machine-specific deployment as automatic install behavior.
- Internal package name and AGENT_ORCHESTRATOR_* compatibility variables remain unchanged for now and should be documented as compatibility names, not renamed in this task.
- Do not add a CI badge until the CI workflow has successfully run on GitHub.

## Scope include
- README.md
- docs/modules/github-issue-queue.md
- docs/rules/testing-and-safety.md
- deployment/dev-flow-worker.plist.example

## Scope exclude
- package.json
- src/
- tests/
- Runtime behavior, queue semantics, environment variable names, and launchd installation on the current machine
- CI workflow or badge

## Acceptance criteria
- Clone and directory examples use git@github.com:skai-in-ai/dev-flow.git and dev-flow.
- CLI path examples use /path/to/dev-flow.
- launchd example uses a generic canonical dev-flow checkout path rather than the retired repo name.
- Documentation explains the same-name checkout requirement and the safe symlink compatibility option for an older local directory.
- Documentation includes install, bootstrap, health inspection, log inspection, reload, and uninstall commands using the current user's dynamic UID rather than hard-coded 501 or 502.
- Documentation states polling is every 300 seconds in the example and that the worker processes at most one Issue per poll.
- Documentation accurately states npm/build does not auto-install the LaunchAgent.
- Maintainer-specific deployed values are clearly labeled as an example/current instance, not portable defaults.
- Internal agent-orchestrator package and environment variable names are identified as compatibility names pending a separate migration.

## Tests
- npm ci && npm test
- git diff --check

## Risks
- Shell snippets for launchctl must remain copy-pasteable and must not hard-code a user UID.
- Documentation must not imply the first real Issue-to-PR E2E has already passed before that evidence exists.

## Unresolved items
none
