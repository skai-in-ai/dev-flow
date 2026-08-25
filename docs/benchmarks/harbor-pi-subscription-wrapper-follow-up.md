# Follow-up: Harbor Pi subscription wrapper

Status: ready_for_main. The narrow wrapper is implemented as
`harbor_full_dev_flow.agent:SinglePiSubscriptionAgent`. Harbor `0.20.0` native
`Pi` does not expose `pi_auth_json_path`; its `run()` only builds provider
API-key environment values, and its installer pins the upstream
`@mariozechner/pi-coding-agent`. The wrapper preserves the native Pi lifecycle
and JSON invocation while correcting those two dev-flow subscription
requirements.

The implemented third-harness adapter is a thin `BaseInstalledAgent` wrapper
that preserves Harbor lifecycle and Pi's invocation semantics:

- pin nvm `v0.40.2`, Node major `22`, and
  `@earendil-works/pi-coding-agent@0.82.1`;
- accept only an explicit host `pi_auth_json_path`, validate it as a restrictive
  regular file, and inject it into a temporary container `PI_CODING_AGENT_DIR`
  with mode `0600` before the model command;
- pass `openai-codex/gpt-5.6-luna` and `--thinking medium`, keep fresh sessions,
  and remove the auth file in a cleanup lifecycle;
- never serialize auth path/value into handoff, trajectory, telemetry or logs;
  never feed verifier reward back to Pi;
- invokes Pi exactly once per trial (no router, reviewer, or test loop);
- parses Pi `message_end` usage when present into Harbor context and a minimal
  ATIF artifact, with null/empty metrics when Pi emits no usage;
- has fake-environment import/auth lifecycle tests and a no-model install-only
  contract. A real Harbor install-only remains the final runtime check; no model
  trial is implied by that check.

A generic read-only Docker bind mount plus `PI_CODING_AGENT_DIR` overlay was
validated by Harbor `--print-config` as a possible operator mechanism, but it
does not fix native Pi's wrong package pin. It is therefore not used by the
formal Single Pi command; the wrapper validates and uploads the explicit host
file ephemerally, then removes it in cleanup.

The explicit host path is an operator-local argument only. The source must be a
non-symlink regular file with mode `0600` (no group/world read bits). The path
and contents are excluded from handoff, context, telemetry, runtime metadata,
and logs. Missing or invalid auth fails closed before model execution.

The artifact directory
`/private/tmp/harbor-first-formal-comparison/prove-plus-comm-single-pi-formal-1`
is an invalid infrastructure attempt, not a benchmark result: the model command
completed but cleanup incorrectly treated a controlled auth directory that could
not be removed as a credential cleanup failure. Its reward must not be included
in comparison telemetry. Cleanup now gates only on removal of `auth.json`;
directory removal is best effort.
