---
title: Terminal-Bench full-corpus Phase 1 compatibility triage
status: approved
created: 2026-08-25
---

# Goal

Produce a deterministic, read-only compatibility matrix for each locked
Terminal-Bench task × `codex`, `single-pi`, and `full-dev-flow`. This phase
does not create derivatives and does not run Harbor, Docker, a verifier,
network access, or a model.

# Scope and evidence boundary

- Input is the operator-provided `terminal-bench-corpus-inventory-1` JSON.
- Only inventory facts and their relative provenance may affect classification.
- `solution/`, `tests/`, and verifier content remain unread.
- `inventoryDigest` is inventory identity only. `sourceDigest` is always
  `not-computed`; no source-equality claim is permitted.
- Network clues are risk strata, not automatic blockers.
- Previous task names are excluded from the Batch 0 recommendation only; they
  remain in the complete triage matrix.

# Classification contract

- `direct-compatible`: workdir, Dockerfile, and agent/verifier timeouts are
  observed; no explicit GPU, QEMU, service/port, or large-build/resource
  blocker is observed. This applies to Codex and Single Pi.
- `derivative-required`: the same facts are observed for Full dev-flow, whose
  clean Git baseline is supplied by a separately controlled workspace-
  compatible derivative. Triage never creates that derivative.
- `blocked-readonly`: an explicit GPU, QEMU/VM, service/port, large
  build/resource indicator, or missing workdir/Dockerfile/timeout fact is
  present.
- `unknown`: the input does not support a conservative rule (including an
  unsupported harness supplied to the pure classifier). Unknown is never
  promoted by task-name intuition.

# Batch 0 recommendation

Recommend 5–8 Full candidates only when they are not among the seven already
run tasks, are not blocked, have known workdir and Dockerfile, and have at
least one observed public-check candidate. Selection is deterministic,
category-diverse, and sorted. It is a recommendation, not trial
authorization; a later preregistration must fix revision, derivative policy,
budget, and setup/runtime multipliers.

# Acceptance

`npm test`, JSON validation, `git diff --check`, and two CLI invocations over
the same inventory must produce byte-identical output. The output must contain
no operator-local absolute path, prompt, secret, session, or protected file
content.
