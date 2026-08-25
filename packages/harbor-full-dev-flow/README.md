# Harbor Full dev-flow wrapper

This package is an evaluation-only thin `BaseInstalledAgent` wrapper for Harbor
`0.20.0`:

```text
harbor_full_dev_flow.agent:FullDevFlowAgent
```

The one-shot Pi subscription comparison entrypoint is:

```text
harbor_full_dev_flow.agent:SinglePiSubscriptionAgent
```

It preserves Pi's native single invocation semantics (no router, reviewer, or
test loop), but pins the dev-flow fork `@earendil-works/pi-coding-agent@0.82.1`
and accepts the explicit `pi_auth_json_path` required for Codex subscription
auth. The requested model must be provider-qualified
`openai-codex/gpt-5.6-luna` with Harbor `thinking=medium`.

For evaluation-only cycle-cap experiments, `FullDevFlowAgent` accepts the
optional `max_cycles` agent kwarg. It must be a positive integer and means the
total number of implementation cycles, including the first implementation: a
cap of 1 uses `max_cycles=1`, and a cap of 3 uses `max_cycles=3`. The legacy
`max_fix_cycles` kwarg remains a deprecated compatibility alias when used
alone; it is converted to `max_cycles=max_fix_cycles+1`, and cannot be combined
with `max_cycles`. The bridge records canonical requested and applied values in
`bridge-result.json` and normalized telemetry. Cycle caps are rejected by the
Single Pi entrypoint and do not change production A/B defaults.

Build the TypeScript bundle first, then build a wheel without adding Harbor or
Python dependencies to the repository test gate:

```bash
npm run build
python3 packages/harbor-full-dev-flow/build-wheel.py --repo-root . --output /tmp/harbor-wheelhouse
```

The wheel embeds the built `dist` bundle and verifies its manifest SHA-256. The
real Harbor setup follows the pinned dev-flow Pi strategy (nvm `v0.40.2`, Node
major `22`, `@earendil-works/pi-coding-agent` `0.82.1`); setup may download those
pinned versions, but does not use `latest`. Missing task compatibility evidence, Git/workdir, deterministic
tests, or runtime prerequisites fails before a model command. See the approved
spec and repository benchmark documentation for the manual `--install-only`
boundary.

Pi 0.82.1 reads auth from `PI_CODING_AGENT_DIR/auth.json`. A real run must pass
an explicit host `pi_auth_json_path`; the wrapper validates it as a restrictive
regular file, uploads only that file to an ephemeral non-`/logs` container path,
sets mode `0600`, passes the explicit `PI_CODING_AGENT_DIR` to the bridge, and
removes the file afterward. It never parses, serializes, or logs credential
contents or the host source path. Missing or unsafe auth fails before a model
command.
