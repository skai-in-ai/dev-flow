---
name: Dev-flow task
about: Draft an approved-spec task for the local dev-flow queue
title: ""
labels: ""
assignees: ""
---
---
status: draft
max_tier: 1
---

# Dev-flow task

Replace every `dev-flow-required` placeholder, then change `status` to `approved` and add the `dev-flow-ready` label when the task is authorized for execution. Creating or editing an Issue is only a draft; the template never adds that label automatically. Tests are raw, trusted shell commands executed verbatim; review them before authorization. The queue deterministically checks status, required-section structure, official placeholders, unresolved items, and test-command format; it does not infer whether arbitrary prose is semantically complete.

## Objective
<!-- dev-flow-required: replace this placeholder with the concrete desired change. -->

## Background and decisions
<!-- dev-flow-required: replace this placeholder with repo-aware context, constraints, and decisions. -->

## Invariants and non-goals
none

## Scope include
<!-- dev-flow-required: replace this placeholder with at least one bullet. -->

## Scope exclude
<!-- dev-flow-required: replace this placeholder with bullets, or write `none`. -->

## Acceptance criteria
<!-- dev-flow-required: replace this placeholder with deterministic, observable outcomes. -->

## Tests
<!-- dev-flow-required: replace this placeholder with raw, trusted shell command bullets.

     These commands run twice: once on the untouched baseline before any work starts, and
     again after the change. They run in a fresh worktree created from the default branch,
     with no dependencies installed and no gitignored files such as .env, so:

     - Include the install step. Write `npm ci && npm test`, not `npm test`. For a repository
       with several service directories, write `cd <service> && uv run pytest`.
     - Do not name a file that this task is going to create. The baseline run happens before
       the file exists, so the task can never start.
     - The commands must not depend on secrets or local state. A test that only passes because
       your machine has a real .env will fail here and stop the task before any work begins. -->

## Risks
<!-- dev-flow-required: replace this placeholder with risks, or write `none`. -->

## Unresolved items
<!-- dev-flow-required: resolve every open question before approval; write `none` only when there are no unresolved items. -->
