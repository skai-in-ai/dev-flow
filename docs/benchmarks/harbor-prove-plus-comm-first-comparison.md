# prove-plus-comm first three-harness comparison

Date: 2026-08-21  
Task: official `terminal-bench@2.0` `prove-plus-comm` derivative  
Derivative: `/private/tmp/terminal-bench-formal/prove-plus-comm`  
Derivative canonical SHA-256:
`20d5b530a07a7ee58f56cbd70e4f123b2371522658f5c5a3dc8aeebf83cf9095`

All three valid attempts used Harbor `0.20.0`, one fresh trial, no Harbor retry,
and the same task derivative. Every reported reward below is `1` with zero
exceptions. The runs are valid single-task comparison evidence, not a
success-rate estimate.

| Harness | Artifact | Wall time | Usage evidence | Reported cost |
| --- | --- | ---: | --- | ---: |
| Harbor Codex | `/private/tmp/harbor-first-formal-comparison/prove-plus-comm-codex-formal-1` | 2m35s | input 142,867; cache 117,504; output 1,662; 14 steps | US$0.00941708 estimated |
| Single Pi subscription | `/private/tmp/harbor-first-formal-comparison/prove-plus-comm-single-pi-formal-3` | 1m56s | input/uncached 11,850; cache 6,144; output 1,104; one invocation | US$0.0190884 estimated |
| Full dev-flow | `/private/tmp/harbor-first-formal-comparison/prove-plus-comm-full-dev-flow-formal-3` | 3m17s (inner 1m54s) | ready_for_main, cycle 1, reviewer pass; captured lower bound input 1,736; cache 6,144; output 1,418; 2 captured calls; router call known from role cost | US$0.01691 estimated |

Costs are catalog/subscription estimates, not provider billing evidence. They
must not be reported as actual spend. The Full token/cache figures are a partial
lower bound because the first exporter omitted the router session usage; the
collector now reads `router-initial/events.jsonl`, cycle router directories, and
the compact `trace.jsonl` fallback, while deduplicating message IDs and ignoring
`turn_end` duplicates. Full's reported estimated role-cost breakdown was router
US$0.00605, implementer US$0.00149, reviewer US$0.00937 (sum US$0.01691), so
the model-call count is known to be three even though only two calls had captured
token totals. No rerun was made for this telemetry fix.

Excluded infrastructure/configuration attempts:

- Single Pi formal-1: cleanup incorrectly treated the controlled auth directory
  as a failed credential cleanup (`.../prove-plus-comm-single-pi-formal-1`).
- Single Pi formal-2: Docker/TLS infrastructure failure
  (`.../prove-plus-comm-single-pi-formal-2`).
- Full formal-1: bridge did not source NVM, so `node` exited 127
  (`.../prove-plus-comm-full-dev-flow-formal-1`).
- Full formal-2: configuration-invalid deterministic test required a clean tree
  after the agent changed the proof (`.../prove-plus-comm-full-dev-flow-formal-2`).

These excluded attempts are not rewards to average and do not enter comparison
telemetry. The revised Full compatibility manifest keeps clean-tree validation in
wrapper preflight and checks only the file, `coqc`, and exact Git root as the
task-level deterministic infrastructure test.

This one task cannot establish harness success rate, relative cost distributions,
or three-cycle reliability. The next valid step is a pre-authorized multi-task
smoke with the same locked revisions and telemetry contract; reliability claims
require repeated trials and an explicitly chosen cycle/retry policy.
