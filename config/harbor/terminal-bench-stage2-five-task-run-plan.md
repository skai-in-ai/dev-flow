# Terminal-Bench stage-2 five-task smoke plan

Status: prepared; no stage-2 model trial or install-only run has been executed.

This is a five-task extension of the first `prove-plus-comm` comparison. The four
new tasks are local extractions of official `terminal-bench@2.0` sources:

| task | derivative | workdir | Full manifest | derivative SHA-256 |
| --- | --- | --- | --- | --- |
| prove-plus-comm | `/private/tmp/terminal-bench-formal/prove-plus-comm` | `/workspace` | `config/harbor/prove-plus-comm-full-dev-flow-compatibility.json` | `20d5b530a07a7ee58f56cbd70e4f123b2371522658f5c5a3dc8aeebf83cf9095` |
| overfull-hbox | `/private/tmp/terminal-bench-formal/overfull-hbox` | `/app` | `config/harbor/overfull-hbox-full-dev-flow-compatibility.json` | `2c20a07c54acefbe303074ef5a99e915fd8b86eecc3d232c248c6927b1dfa5d8` |
| regex-log | `/private/tmp/terminal-bench-formal/regex-log` | `/app` | `config/harbor/regex-log-full-dev-flow-compatibility.json` | `edfdccd39cc8ccd0385727bf0064af8bf431f975c79f79e2c408296aa168ff78` |
| log-summary-date-ranges | `/private/tmp/terminal-bench-formal/log-summary-date-ranges` | `/app` | `config/harbor/log-summary-date-ranges-full-dev-flow-compatibility.json` | `57a85f9dd3d746eedcb6bf815f61332024a16bef1169b8222f3ae37e666a9e8a` |
| polyglot-c-py | `/private/tmp/terminal-bench-formal/polyglot-c-py` | `/app` | `config/harbor/polyglot-c-py-full-dev-flow-compatibility.json` | `181d54b4308aff50f4814232d369e78f314ba6de7874d6230bd64883c20ba10f` |

Each derivative differs from its source only in `environment/Dockerfile`: git is
installed and a clean baseline repository is initialized at the task workdir after
the deterministic task inputs are present. The source instruction, tests,
verifier, solution, metadata, and non-Docker environment files are byte-for-byte
preserved. The canonical digest rule is sorted relative path + TAB + file SHA-256
and LF over all files. `allowLocalCommit=false` for this smoke: local commits,
pushes, merges, deploys, remote mutation, and other external side effects remain
forbidden.

## Locked policy

- Harbor `0.20.0`; dataset source `terminal-bench@2.0`; all three harnesses use
  the same derivative path and unchanged external `tests/test.sh` verifier.
- Model `gpt-5.6-luna`, reasoning `medium`, Full `maxTier=1`.
- One trial per task, one concurrent trial, fresh session, Harbor retry `0`.
- The comparison timeout ceiling is 900 seconds. Where the source `task.toml`
  has a lower locked agent/verifier timeout (for example `overfull-hbox`), retain
  that source timeout; do not silently rewrite task metadata.
- The deterministic test in each compatibility manifest checks only baseline
  infrastructure (tools, task inputs, and exact Git root). It must pass before
  the model call and after handoff; the external Harbor verifier remains the
  acceptance result. It must not assert a post-run clean tree because that would
  reject valid working-tree evidence.
- No auth path is stored in JSON. The paths below are operator-local command
  arguments only and must not be copied into artifacts, telemetry, or configs.

## No-model print-config checks

Run these after confirming the derivative path and manifest, but do not redirect
the output to a file. `--print-config` resolves `JobConfig` and exits before a
container or model trial. Inspect that the output has the intended path, agent,
model, reasoning kwarg, one attempt, one concurrent trial, and zero retries. It
may contain operator-local auth paths; do not paste it into the repository.

For each row, set `TASK_PATH` to the derivative and `TASK_NAME` to the task name:

```bash
harbor run --path "$TASK_PATH" --agent codex --model gpt-5.6-luna \
  --agent-kwarg reasoning_effort=medium \
  --agent-env CODEX_AUTH_JSON_PATH=/Users/skai.wu/.codex/auth.json \
  --env docker --force-build -k 1 -n 1 -r 0 --print-config

harbor run --path "$TASK_PATH" \
  --agent harbor_full_dev_flow.agent:SinglePiSubscriptionAgent \
  --model openai-codex/gpt-5.6-luna --agent-kwarg thinking=medium \
  --agent-kwarg pi_auth_json_path=/Users/skai.wu/.pi/agent/auth.json \
  --env docker --force-build -k 1 -n 1 -r 0 --print-config

harbor run --path "$TASK_PATH" \
  --agent harbor_full_dev_flow.agent:FullDevFlowAgent --model gpt-5.6-luna \
  --agent-kwarg compatibility_manifest_path=/Users/skai.wu/side/agent-orchestrator/$MANIFEST \
  --agent-kwarg pi_auth_json_path=/Users/skai.wu/.pi/agent/auth.json \
  --env docker --force-build -k 1 -n 1 -r 0 --print-config
```

The Full wrapper's manifest path is the matching table entry. The native Codex
agent receives `CODEX_AUTH_JSON_PATH`; the Pi wrappers receive the explicit Pi
auth kwarg and upload it ephemerally only after pure validation. No secret value
is parsed or serialized.

## Trial command templates (operator approval required)

The following are templates, not executed commands. Replace `TASK_PATH`,
`TASK_NAME`, and `MANIFEST` with one row at a time. Run all three harnesses
against the same derivative before comparing rewards or cost. `--force-build`
is intentional: using a cached source image would bypass the Git baseline.

```bash
harbor run --path "$TASK_PATH" --agent codex --model gpt-5.6-luna \
  --agent-kwarg reasoning_effort=medium \
  --agent-env CODEX_AUTH_JSON_PATH=/Users/skai.wu/.codex/auth.json \
  --env docker --force-build -k 1 -n 1 -r 0 \
  --job-name "stage2-${TASK_NAME}-codex" --yes

harbor run --path "$TASK_PATH" \
  --agent harbor_full_dev_flow.agent:SinglePiSubscriptionAgent \
  --model openai-codex/gpt-5.6-luna --agent-kwarg thinking=medium \
  --agent-kwarg pi_auth_json_path=/Users/skai.wu/.pi/agent/auth.json \
  --env docker --force-build -k 1 -n 1 -r 0 \
  --job-name "stage2-${TASK_NAME}-single-pi" --yes

harbor run --path "$TASK_PATH" \
  --agent harbor_full_dev_flow.agent:FullDevFlowAgent --model gpt-5.6-luna \
  --agent-kwarg compatibility_manifest_path=/Users/skai.wu/side/agent-orchestrator/$MANIFEST \
  --agent-kwarg pi_auth_json_path=/Users/skai.wu/.pi/agent/auth.json \
  --env docker --force-build -k 1 -n 1 -r 0 \
  --job-name "stage2-${TASK_NAME}-full-dev-flow" --yes
```

## Known risks and interpretation boundary

This preparation did not build any Docker image, invoke a verifier, or call a
model. The first real run may expose apt/Docker registry, task-image, or verifier
network requirements; classify those as infrastructure-invalid rather than as
agent failures. The source tasks also have different resource and timeout values,
so the result report must retain task-level limits and not pool raw wall time
without qualification. Five tasks provide a first smoke distribution, not a
statistically stable success rate, three-cycle reliability claim, or a conclusion
about 0..10 rounds/session reuse.
