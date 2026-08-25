# prove-plus-comm first comparison plan

This plan uses the derivative at `/private/tmp/terminal-bench-formal/prove-plus-comm`
for every harness. The source is the local extraction of official
`terminal-bench@2.0`; source and derivative canonical digests are recorded in the
JSON compatibility manifest. `instruction.md`, `tests/test.sh`,
`tests/test_outputs.py`, `solution/solve.sh`, `task.toml`, and
`environment/partial_proof.v` are byte-for-byte preserved. The only derivative
change is `environment/Dockerfile`: install `git`, then initialize `/workspace`,
configure a deterministic identity, and create one local baseline commit after
copying `plus_comm.v`.

Run policy for the first comparison:

- Harbor `0.20.0`; one task, one trial, one concurrent trial; fresh session.
- `-k 1 -n 1 -r 0`; agent and verifier timeout are the task's locked 900 seconds.
- `--force-build` is required so Harbor builds the derivative Dockerfile (and does
  not silently use the source task's prebuilt `docker_image` without the Git baseline).
- Model `gpt-5.6-luna`, reasoning `medium`, `maxTier=1`.
- No Harbor upload, no retry, no resume, no cross-trial session reuse.
- `allowLocalCommit=false`: current core review evidence is working-tree based.
- The deterministic infrastructure test must pass on the clean baseline; it is not
  the acceptance verifier and must not replace the external verifier.

The commands below are exact one-trial candidates. They are documentation only;
do not execute until the operator confirms the budget and auth. The auth path is
shown only here as operator-local command input, never in telemetry or artifacts.

## Harbor native Codex

```bash
harbor run --path /private/tmp/terminal-bench-formal/prove-plus-comm \
  --agent codex --model gpt-5.6-luna \
  --agent-kwarg reasoning_effort=medium \
  --agent-env CODEX_AUTH_JSON_PATH=/Users/skai.wu/.codex/auth.json \
  --env docker --force-build --n-attempts 1 --n-concurrent 1 --max-retries 0 \
  --job-name prove-plus-comm-codex-one-trial --yes
```

This uses Harbor Codex's verified `CODEX_AUTH_JSON_PATH` injection path and keeps
the Codex subscription auth out of the task artifacts.

## Single Pi subscription wrapper

The thin wrapper preserves Pi's one-shot JSON invocation while pinning the actual
dev-flow fork and handling subscription auth ephemerally. It requires the explicit
host auth path below; the value is never written to a config or artifact:

```bash
harbor run --path /private/tmp/terminal-bench-formal/prove-plus-comm \
  --agent harbor_full_dev_flow.agent:SinglePiSubscriptionAgent \
  --model openai-codex/gpt-5.6-luna --agent-kwarg thinking=medium \
  --agent-kwarg pi_auth_json_path=/Users/skai.wu/.pi/agent/auth.json \
  --env docker --force-build --n-attempts 1 --n-concurrent 1 --max-retries 0 \
  --job-name prove-plus-comm-single-pi-one-trial --yes
```

The wrapper installs nvm `v0.40.2`, Node major `22`, and
`@earendil-works/pi-coding-agent@0.82.1`. It verifies the source auth file before
upload, creates the remote directory before uploading, uses mode `600`, passes
`PI_CODING_AGENT_DIR`, invokes `pi --print --mode json` exactly once, and removes
the remote auth file on success or failure.
The valid formal-3 result is recorded in
`docs/benchmarks/harbor-prove-plus-comm-first-comparison.md`; earlier formal-1
and formal-2 attempts are excluded infrastructure failures.

## Full dev-flow custom wrapper

Build the wheel and install it into the Harbor 0.20.0 Python environment first.
Then pass the compatibility manifest and explicit auth path as agent kwargs:

```bash
harbor run --path /private/tmp/terminal-bench-formal/prove-plus-comm \
  --agent harbor_full_dev_flow.agent:FullDevFlowAgent \
  --model gpt-5.6-luna \
  --agent-kwarg compatibility_manifest_path=/Users/skai.wu/side/agent-orchestrator/config/harbor/prove-plus-comm-full-dev-flow-compatibility.json \
  --agent-kwarg pi_auth_json_path=/Users/skai.wu/.pi/agent/auth.json \
  --env docker --force-build --n-attempts 1 --n-concurrent 1 --max-retries 0 \
  --job-name prove-plus-comm-full-dev-flow-one-trial --yes
```

The wrapper's current core wiring records requested model/reasoning evidence but
only applies supported controls; it does not feed verifier reward back into the
agent. The valid formal-3 result and the partial router-token caveat are recorded
in `docs/benchmarks/harbor-prove-plus-comm-first-comparison.md`.

## Print-config validation (no model, no container trial)

`--print-config` resolves Harbor's `JobConfig` and exits before task execution.
Use it on each command after replacing only the command's run flag with
`--print-config` (or append `--print-config` where the CLI accepts it). Confirm
the output has the same path, agent, model, reasoning kwarg, `n_attempts=1`,
`n_concurrent_trials=1`, and `retry.max_retries=0`; do not save the output because
it may contain operator-local auth paths.

The first formal comparison has now produced three valid one-trial results. The
result table, estimated-cost policy, partial Full telemetry caveat, and excluded
infrastructure/configuration attempts are recorded in
`docs/benchmarks/harbor-prove-plus-comm-first-comparison.md`. One task is not
enough to claim success rate, cost distribution, or three-cycle reliability.
