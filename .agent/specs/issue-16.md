---
status: approved
max_tier: 1
---

# Build queue worktrees from the claimed remote base and preserve live poll locks

## Objective
Prevent queue jobs from starting on a stale local main and prevent a long-running live worker from losing its single-writer poll lock merely because the lock is older than 30 minutes.

## Background and decisions
- The GitHub claim currently reads the remote default-branch SHA, but worktree creation still uses the local checkout `HEAD`; a recently merged PR can therefore be absent from the next job unless a human manually pulls first.
- The claimed remote default branch and SHA must become the authoritative base for that job.
- Before agent execution, fetch the exact allowlisted repository default branch, verify the fetched commit matches the SHA associated with the claim, and create the worktree from that verified commit/ref rather than local `HEAD`.
- Fetching must not merge, reset, clean, or otherwise mutate the primary checkout's branch or working tree.
- A fetch failure, missing/mismatched SHA, or unsafe default-branch name must stop before agent execution and produce the existing needs-human failure path.
- Poll-lock recovery currently treats age greater than 30 minutes as stale even when a same-host owner PID is still alive.
- For a well-formed same-host lock with a valid PID, process liveness is authoritative: live means not stale regardless of age; dead means recoverable.
- Age remains a fallback only when owner liveness cannot be established, such as a foreign host, malformed owner metadata, or an unverifiable PID.
- Keep this change deterministic and local; do not add another model call or change queue ordering.

## Invariants and non-goals
- Never run an agent from a commit different from the remote default-branch commit validated for the claim.
- Never reclaim a well-formed same-host lock while its owner PID is alive.
- Do not merge, reset, clean, or overwrite the primary checkout.
- Do not implement Issue #10 Resume, attempt-based claims, garbage collection, orphan PR cleanup, merge, or deployment.

## Scope include
- src/github-queue.ts
- GitHub adapter/claim types only as needed to carry the validated default branch and SHA
- Worktree creation and poll-lock stale detection
- Deterministic queue tests for remote-base and lock behavior
- docs/architecture.md
- docs/modules/github-issue-queue.md
- docs/rules/testing-and-safety.md
- README.md only if its threat model or deployed workflow statement is affected

## Scope exclude
- Same-Issue Resume or attempt numbering
- Claim-ref deletion or garbage collection
- Closing orphan PRs after writeback failure
- Queue ordering, multiple concurrent jobs, HTTP API, dashboard, merge, or deployment
- Routing, model selection, cycle limits, prompts, report rendering, or PR delivery payload
- Automatic `git pull` or mutation of the primary checkout branch

## Acceptance criteria
- A queue claim exposes the validated remote default-branch name and 40-character commit SHA needed by worktree creation.
- Before worktree creation, the worker fetches the claimed default branch from `origin` without merging it into the primary checkout.
- The fetched commit is verified to equal the claim SHA; mismatch or fetch failure stops before any agent invocation.
- The isolated worktree starts exactly at the verified claimed commit even when local `main`/`HEAD` is behind or points elsewhere.
- Dirty or differently checked-out primary worktrees are not reset, cleaned, merged, or overwritten.
- Unsafe remote/default-branch/ref values remain rejected and are never interpolated through a shell command.
- A same-host lock with a valid live PID remains active even when older than 30 minutes.
- A same-host lock with a dead PID is recoverable without waiting 30 minutes.
- A foreign-host or unverifiable lock uses the documented age threshold as fallback.
- Malformed metadata recovery remains deterministic and recorded in the queue ledger.
- Deterministic tests cover stale local HEAD, exact claimed SHA, SHA mismatch/fetch failure before agent work, live old lock, dead young lock, foreign-host young/old locks, and malformed metadata.
- Existing first-attempt queue, publication gates, and full test suite remain passing.

## Tests
- npm ci && npm test
- git diff --check

## Risks
- Fetch and claim can observe different remote states if the default branch advances between calls; binding worktree creation to the claim SHA must fail closed rather than silently switching commits.
- Process IDs can be reused; same-host liveness improves the current behavior but does not replace future stronger owner identity or lease semantics.
- Tests must not depend on real GitHub access or kill real processes; use deterministic adapters/fixtures or injectable liveness/time boundaries.

## Unresolved items
none
