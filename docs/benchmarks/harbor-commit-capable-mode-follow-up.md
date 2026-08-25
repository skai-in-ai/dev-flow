# Follow-up: Harbor commit-capable benchmark mode

Status: deferred. This is an evaluation-only follow-up proposal; it does not
change either production dev-flow entry or the current Full dev-flow wrapper.

The first `prove-plus-comm` comparison locks `allowLocalCommit=false` because the
current core review evidence is derived from the working-tree diff. Allowing the
agent to commit without changing evidence capture could make a successful change
appear empty to review.

Before any task sets `allowLocalCommit=true`, the evaluation adapter must:

1. Capture and persist the clean baseline commit SHA immediately after task
   initialization, bound to the locked disposable workspace and task digest.
2. Compose review input from both `baseline..HEAD` and the current working-tree
   diff, including staged and unstaged changes, without resetting or discarding
   either state.
3. Preserve deterministic tests, reviewer attribution, and artifact provenance
   across the commit boundary; add regression tests for commit-only, working-tree-
   only, and mixed changes.
4. Keep `push`, remote mutation, merge, deploy, credential disclosure, and other
   external side effects forbidden. A local commit is the only additional
   permission, and only inside the locked disposable workspace.
5. Gate the feature behind an explicit evaluation-only source/configuration flag;
   ordinary dev-flow delivery remains `allowLocalCommit=false` and unchanged.

Until those checks are implemented and reviewed, the wrapper rejects
`allowLocalCommit=true` before auth installation or any model call.
