# Fresh cycle-cap experiment: preregistered run plan

Status: `approved`
Spec: `.agent/specs/2026-08-22-terminal-bench-fresh-cycle-caps.md`
Preregistration: `config/harbor/terminal-bench-fresh-cycle-caps-preregistration.json`
Amendment: `.agent/specs/2026-08-22-terminal-bench-fresh-cycle-caps-timeout-amendment.md`

這是兩個尚未出現在既有結果中的 Terminal-Bench `2.0` local derivative。準備階段
已完成 source/derivative digest 與 compatibility manifest；沒有讀 solution、hidden
verifier/expected output，沒有 build image、連網或呼叫模型。

## Locked matrix

| task | derivative | timeout | Codex | Single Pi | Full cap 1 | Full cap 3 |
| --- | --- | ---: | --- | --- | --- | --- |
| `large-scale-text-editing` | `/private/tmp/terminal-bench-formal/large-scale-text-editing` | 1200s | 1 baseline | 1 baseline | `maxCycles=1` | `maxCycles=3` |
| `sqlite-db-truncate` | `/private/tmp/terminal-bench-formal/sqlite-db-truncate` | 900s | 1 baseline | 1 baseline | `maxCycles=1` | `maxCycles=3` |

總計最多 8 個有效候選 trial。Codex/Single Pi 沒有 orchestration cycle cap，保留
為每題一次的 cap-independent baseline；只有 Full 的 cap 1 與 cap 3 進行 paired
cycle-policy comparison。

`maxCycles` 是總 workflow implementation cycles，包含第一次 implementation。cap 1
直接傳 `max_cycles=1`，cap 3 直接傳 `max_cycles=3`。若實際 runtime telemetry 只顯示預設值或沒有 direct
evidence，該 trial 不進比較，且不應繼續燒模型。

## Common locked flags

- Harbor `0.20.0`; model `gpt-5.6-luna`; reasoning/thinking `medium`; Full `maxTier=1`。
- `--env docker --force-build -k 1 -n 1 -r 0 --timeout-multiplier 1.0
  --agent-timeout-multiplier 1.0 --verifier-timeout-multiplier 1.0
  --agent-setup-timeout-multiplier 2`；
  setup multiplier 套用全部 8 個 conditions，每一 job 使用 amendment 專用新 job
  name 與新 artifact root。
- `--agent-setup-timeout-multiplier 2` 只影響 Harbor agent setup/install timeout：
  目前 default 360 秒，amendment 後為 720 秒；不改 task timeout、agent execution
  timeout、verifier timeout、model、reasoning、maxCycles、gate、retry、session、
  concurrency 或 budget。
- fresh session；不 resume、不跨條件 cache/session reuse；Harbor retry 0、concurrency 1。
- `allowLocalCommit=false`；不得 commit、push、merge、deploy 或修改 remote。
- `CODEX_AUTH_PATH`、`PI_AUTH_PATH` 僅是 operator 自己 export 的本機變數；不得把其值
  寫入 manifest、telemetry、prompt 或報告。

## Mandatory preflight

先在兩題上做三 harness `--print-config`，確認 path、agent、model、reasoning、
force-build、attempt/concurrency/retry 全部符合本 plan；`--print-config` 不啟動
container/model/network。Full 另外要有 no-model evidence 顯示 cap 已進入
bridge/core：`maxCycles=1`、`maxCycles=3`。目前
bridge 已接線該 kwarg；以下 commands 仍須在正式 trial 前以最新 wheel/runtime
bundle 執行一次相同的 no-model contract/print-config preflight。

目前已完成的 no-model evidence（amendment 後、目前 Harbor CLI/runtime）：兩題 × 四個
template 的 `--print-config` 均 exit 0，觀測 `agent_setup_timeout_multiplier=2.0`、
`n_concurrent_trials=1`、`force_build=true`；Full cap 1/3 也分別觀測 `max_cycles=1/3`。
這證明 command/config shape，不等於最新 wheel 已安裝到 Harbor environment；重建與
安裝最新 wheel 後，必須再跑同一組 preflight 才可正式 trial。

## Trial command templates

先設定 operator-local variables（不落盤）：

```bash
export CODEX_AUTH_PATH=/absolute/operator/local/codex-auth.json
export PI_AUTH_PATH=/absolute/operator/local/pi-auth.json
export NEW_ARTIFACT_ROOT=/private/tmp/harbor-fresh-cycle-caps-amendment
```

### Harbor Codex baseline

```bash
harbor run --path "$TASK_PATH" --agent codex --model gpt-5.6-luna \
  --agent-kwarg reasoning_effort=medium \
  --agent-env CODEX_AUTH_JSON_PATH="$CODEX_AUTH_PATH" \
  --env docker --force-build -k 1 -n 1 -r 0 \
  --timeout-multiplier 1.0 --agent-timeout-multiplier 1.0 --verifier-timeout-multiplier 1.0 \
  --agent-setup-timeout-multiplier 2 \
  --job-name "fresh-caps-amendment-${TASK_NAME}-codex" --yes --print-config
```

### Single Pi baseline

```bash
harbor run --path "$TASK_PATH" \
  --agent harbor_full_dev_flow.agent:SinglePiSubscriptionAgent \
  --model openai-codex/gpt-5.6-luna --agent-kwarg thinking=medium \
  --agent-kwarg pi_auth_json_path="$PI_AUTH_PATH" \
  --env docker --force-build -k 1 -n 1 -r 0 \
  --timeout-multiplier 1.0 --agent-timeout-multiplier 1.0 --verifier-timeout-multiplier 1.0 \
  --agent-setup-timeout-multiplier 2 \
  --job-name "fresh-caps-amendment-${TASK_NAME}-single-pi" --yes --print-config
```

### Full dev-flow cap 1

```bash
harbor run --path "$TASK_PATH" \
  --agent harbor_full_dev_flow.agent:FullDevFlowAgent --model gpt-5.6-luna \
  --agent-kwarg compatibility_manifest_path=/Users/skai.wu/side/agent-orchestrator/config/harbor/${TASK_NAME}-full-dev-flow-compatibility.json \
  --agent-kwarg max_cycles=1 \
  --agent-kwarg pi_auth_json_path="$PI_AUTH_PATH" \
  --env docker --force-build -k 1 -n 1 -r 0 \
  --timeout-multiplier 1.0 --agent-timeout-multiplier 1.0 --verifier-timeout-multiplier 1.0 \
  --agent-setup-timeout-multiplier 2 \
  --job-name "fresh-caps-amendment-${TASK_NAME}-full-cap1" --yes --print-config
```

### Full dev-flow cap 3

```bash
harbor run --path "$TASK_PATH" \
  --agent harbor_full_dev_flow.agent:FullDevFlowAgent --model gpt-5.6-luna \
  --agent-kwarg compatibility_manifest_path=/Users/skai.wu/side/agent-orchestrator/config/harbor/${TASK_NAME}-full-dev-flow-compatibility.json \
  --agent-kwarg max_cycles=3 \
  --agent-kwarg pi_auth_json_path="$PI_AUTH_PATH" \
  --env docker --force-build -k 1 -n 1 -r 0 \
  --timeout-multiplier 1.0 --agent-timeout-multiplier 1.0 --verifier-timeout-multiplier 1.0 \
  --agent-setup-timeout-multiplier 2 \
  --job-name "fresh-caps-amendment-${TASK_NAME}-full-cap3" --yes --print-config
```

The templates above show `--print-config` for the no-model preflight. After all eight
preflights pass, remove only `--print-config` for the authorized model runs. Run all four
commands for one task before moving to the next task. Replace only `TASK_PATH` and
`TASK_NAME` with the locked table values. Do not reuse an old artifact directory, old job
name, or append a new result to stage-2/canary manifests.

## Gates and acceptance boundary

The compatibility manifest deterministic command is a public infrastructure preflight:

- `large-scale-text-editing`: generated input files, Vim availability, exact Git root。
- `sqlite-db-truncate`: supplied database, Python availability, exact Git root。

These checks must pass on the untouched baseline before model execution. They are recorded
as gate evidence after each cycle but do not prove task correctness. The unchanged external
Harbor verifier decides pass/fail. Do not add a gate after seeing a verifier failure.

## Budget and stop policy

Hard planning ceiling: estimated US$0.75 across all 8 candidate trials. This is a stop
threshold for catalog/subscription estimates, not a billing quote; `actualCostUsd` remains
`null` without provider billing evidence.

Stop immediately for a condition when auth, Docker/TLS, image, package, workdir, or bridge
fails before model tokens. Keep the artifact as `infrastructure-invalid`; do not spend a
retry automatically. Do not run cap 5/10 in this plan. After aggregation:

- if cap 3 adds no pass on either new task and costs at least 1.5× cap 1 incrementally,
  stop cycle-cap expansion;
- if cap 3 adds a pass on at least one task and incremental cost is at most 2× cap 1,
  prepare a separate approved cap-5 decision spec, without executing it automatically.

## Post-run artifact handling

Create a new `benchmark-run-manifest-1` after actual artifact paths exist. Include valid and
invalid trials, explicit cost overrides, and failure taxonomy; never rewrite prior manifests.
Then run `bin/harbor-aggregate` with `HARBOR_BENCHMARK_ARTIFACT_ROOT` and verify that all
summary numbers are read-only recomputable. Update the living backlog only after raw
artifacts and manifest agree.

## Execution log

2026-08-22 第一筆 `large-scale-text-editing` Codex baseline 在模型執行前因 Harbor
agent setup 超過鎖定的 360 秒而停止；`agent_result` 與 verifier 均為 null。依本計畫
的 stop policy 沒有自動重試，其餘七筆也暫停，避免各 condition 使用不同的 setup
政策。invalid artifact 已登記在
`terminal-bench-fresh-cycle-caps-results-manifest.json`，必須保留原樣。

2026-08-22 setup-timeout amendment approved：全部八個 condition 統一使用
`--agent-setup-timeout-multiplier 2`；正式重跑必須使用 amendment 專用 job names、
新的 artifact root 與新的 results manifest。amendment 後的 model trial 尚未授權或
執行。兩題 × 四個 template 的 no-model `--print-config` 已在目前 Harbor CLI 通過；
最新 wheel 安裝後仍須重跑同一組 preflight。

2026-08-24 amendment 後第一筆正式 trial 已完成：

- job：`fresh-caps-amendment-large-scale-text-editing-codex`
- artifact：`harbor-fresh-cycle-caps-amendment/fresh-caps-amendment-large-scale-text-editing-codex/large-scale-text-editing__huSnQx8`
- config：Harbor `0.20.0`、Codex `gpt-5.6-luna`、reasoning `medium`、setup multiplier `2.0`；task/agent/verifier timeout multiplier 均為 `1.0`、`force_build=true`。
- timestamps：started `2026-08-22T10:48:28.673916Z`、finished `2026-08-22T12:24:41.943759Z`。
- phases：environment setup 約 6s、agent setup 約 344s、agent execution 約 5,410s、verifier 約 8s；model 前 setup 沒有失敗。
- outcome：external verifier reward `0`；`AgentTimeoutError`（agent execution timeout `1200s`）；有模型 token，因此是有效 included agent/model failure，不是 `infrastructure-invalid`。
- usage：input `12966`、cache read `9984`、output `200`、model call `1`、estimated cost `0.00103608`、actual cost `null`；Codex ATIF trajectory 有 `4` steps，只有 metrics-bearing step 形成 canonical call。
- provenance：Harbor raw `task_checksum=bfc214f9…`；compatibility manifest 的 derivative canonical digest 是 `08a8365b…`。兩者屬不同 artifact/digest 欄位，均保留，尚未把它們錯誤地視為同一個 digest；在對外 benchmark claim 前仍需釐清 digest domain。
- manifest：`config/harbor/terminal-bench-fresh-cycle-caps-amendment-results-manifest.json`；舊 360 秒 invalid manifest 未修改。

2026-08-24 amendment 後第二筆正式 trial 已完成：

- job：`fresh-caps-amendment-large-scale-text-editing-single-pi`
- artifact：`harbor-fresh-cycle-caps-amendment/fresh-caps-amendment-large-scale-text-editing-single-pi/large-scale-text-editing__QY97A8b`
- config：Harbor `0.20.0`、Single Pi subscription `0.82.1`、effective model `gpt-5.6-luna`、reasoning `medium`、setup multiplier `2.0`；task/agent/verifier timeout multiplier 均為 `1.0`、`force_build=true`。
- timestamps：started `2026-08-24T08:08:42.665453Z`、finished `2026-08-24T08:15:46.944238Z`；agent setup 約 `226.6s`、agent execution 約 `80.1s`、verifier 約 `108.1s`。
- outcome：external verifier reward `1`、CTRF `5/5` passed、exception `null`；valid included pass。
- usage：input `8078`、cache read `2560`、cache write `0`、output `1158`、canonical calls `4`；calls 取 `agent/pi/pi.txt` 的 assistant `message_end` lines `7, 26, 34, 45`，合計與 metadata totals 一致。estimated cost `0.015282`、actual cost `null`。
- cache/session evidence：session `fresh`（preflight evidence）、provider cache observed，registry key `openai-codex/single-pi/@earendil-works/pi-coding-agent@0.82.1`；aggregator derived total prompt `10638`、cache hit rate `0.2406467`，僅作 versioned adapter-contract derived metric，不當作 provider billing。
- manifest：`config/harbor/terminal-bench-fresh-cycle-caps-amendment-results-manifest.json` 新增第二筆；舊 360 秒 invalid manifest 未修改。

2026-08-24 amendment 後第三筆正式 trial（Full cap 1）已完成：

- job：`fresh-caps-amendment-large-scale-text-editing-full-cap1`
- artifact：`harbor-fresh-cycle-caps-amendment/fresh-caps-amendment-large-scale-text-editing-full-cap1/large-scale-text-editing__HTtHxLE`
- config：Harbor `0.20.0`、Full dev-flow、requested `maxCycles=1`，runtime observed `maxCycles=1`；setup multiplier `2.0`，其他 timeout multiplier `1.0`、`force_build=true`。
- timestamps：started `2026-08-24T09:29:24.264354Z`、finished `2026-08-24T09:41:56.791643Z`；agent execution 約 `330.7s`、verifier 約 `96.9s`。
- outcome：external verifier reward `1`、CTRF `5/5` passed、exception `null`；valid included pass，observed cycles `1`。
- usage：input `5905`、cache read `8704`、cache write `0`、output `2399`、canonical calls `4`；Full telemetry registry key `openai-codex/full-dev-flow/pi-process-adapter@0.82.1`，derived cache hit rate `0.5957971`。
- estimated cost：`0.0211694`，由 aggregator 對 sanitized `call-evidence.json` 四筆 `usage.costUsd` 求和；actual cost `null`。這是 explicit operator pricing estimate，不是 billing evidence。

2026-08-24 amendment 後第四筆正式 trial（Full cap 3）已完成：

- job：`fresh-caps-amendment-large-scale-text-editing-full-cap3`
- artifact：`harbor-fresh-cycle-caps-amendment/fresh-caps-amendment-large-scale-text-editing-full-cap3/large-scale-text-editing__8Ky3QFv`
- config：Harbor `0.20.0`、Full dev-flow、requested `maxCycles=3`，runtime observed `maxCycles=3`；setup multiplier `2.0`，其他 timeout multiplier `1.0`、`force_build=true`。
- timestamps：started `2026-08-24T11:17:40.639392Z`、finished `2026-08-24T11:26:34.500649Z`；agent execution 約 `195.7s`、verifier 約 `118.8s`。
- outcome：external verifier reward `1`、CTRF `5/5` passed、exception `null`；valid included pass，observed cycles `1`（cap 3 未被需要消耗）。
- usage：input `4332`、cache read `10240`、cache write `0`、output `972`、canonical calls `4`；Full telemetry registry key `openai-codex/full-dev-flow/pi-process-adapter@0.82.1`，derived cache hit rate `0.7027175`。
- estimated cost：`0.011188`，由 aggregator 對 sanitized `call-evidence.json` 四筆 `usage.costUsd` 求和；actual cost `null`。這是 explicit operator pricing estimate，不是 billing evidence。

2026-08-24 Codex diagnostic retry 已完成，但不屬於 preregistered primary comparison：

- job：`fresh-caps-amendment-large-scale-text-editing-codex-diagnostic-retry1`
- artifact：`harbor-fresh-cycle-caps-amendment/fresh-caps-amendment-large-scale-text-editing-codex-diagnostic-retry1/large-scale-text-editing__smBcgCT`
- config：Harbor `0.20.0`、Codex `gpt-5.6-luna`、reasoning `medium`、setup multiplier `2.0`；其他 timeout multiplier `1.0`、`force_build=true`。
- outcome：reward `0`、exception `null`、external verifier CTRF `4/5`，失敗為 task-compliance；valid task failure diagnostic，明確 excluded，不取代原始 Codex baseline。
- usage：input `382335`、cache read `342528`、output `5623`、estimated cost `0.02155956`、actual `null`；診斷成本只保留在 excluded evidence，不進 primary comparison。
- manifest：上述三筆均登錄於 amendment manifest；Full 兩筆 included，Codex diagnostic `includeInComparison=false` 且 failure category `task-failure`；舊 360 秒 invalid manifest 未修改。

2026-08-25 amendment 後第五筆正式 trial（`sqlite-db-truncate` Codex）已完成：

- job：`fresh-caps-amendment-sqlite-db-truncate-codex`
- artifact：`harbor-fresh-cycle-caps-amendment/fresh-caps-amendment-sqlite-db-truncate-codex/sqlite-db-truncate__VRisi96`
- config：Harbor `0.20.0`、Codex `gpt-5.6-luna`、reasoning `medium`、setup multiplier `2.0`；其他 timeout multiplier `1.0`、`force_build=true`。
- timestamps：started `2026-08-25T06:19:42.178631Z`、finished `2026-08-25T06:21:32.501313Z`。
- outcome：external verifier reward `1`、exception `null`；valid included pass。
- usage：input `92779`、cache read `75264`、output `2279`、canonical model calls `6`；estimated cost `0.00774308`、actual `null`。

2026-08-25 amendment 後第六筆正式 trial（`sqlite-db-truncate` Single Pi）已完成：

- job：`fresh-caps-amendment-sqlite-db-truncate-single-pi`
- artifact：`harbor-fresh-cycle-caps-amendment/fresh-caps-amendment-sqlite-db-truncate-single-pi/sqlite-db-truncate__y3jwc4M`
- config：Harbor `0.20.0`、Single Pi subscription `0.82.1`、effective model `gpt-5.6-luna`、setup multiplier `2.0`；其他 timeout multiplier `1.0`、`force_build=true`。
- timestamps：started `2026-08-25T06:37:30.196036Z`、finished `2026-08-25T06:39:37.671479Z`；session `fresh`。
- outcome：external verifier reward `1`、exception `null`；valid included pass。
- usage：input `9761`、cache read `22528`、output `3265`、canonical model calls `8`；Pi 0.82.1 derived cache hit rate `0.6976989`；estimated cost `0.0316038`、actual `null`。

2026-08-25 amendment 後第七筆正式 trial（`sqlite-db-truncate` Full cap 1）已完成：

- job：`fresh-caps-amendment-sqlite-db-truncate-full-cap1`
- artifact：`harbor-fresh-cycle-caps-amendment/fresh-caps-amendment-sqlite-db-truncate-full-cap1/sqlite-db-truncate__T8ZudnH`
- config：Harbor `0.20.0`、Full dev-flow、requested/effective `maxCycles=1`、setup multiplier `2.0`；其他 timeout multiplier `1.0`、`force_build=true`。
- timestamps：started `2026-08-25T06:52:21.698618Z`、finished `2026-08-25T06:55:42.757603Z`；actual cycles `1`、canonical calls `4`。
- outcome：external verifier reward `1`、exception `null`；valid included pass。
- usage：input `8999`、cache read `9216`、output `996`；Full derived cache hit rate `0.5059566`。
- estimated cost：`0.0158966`，由 aggregator 對 sanitized `call-evidence.json` 四筆 `usage.costUsd` 求和；actual `null`。這是 explicit operator pricing estimate，不是 billing evidence。

2026-08-25 amendment 後第八筆正式 trial（`sqlite-db-truncate` Full cap 3）已完成：

- job：`fresh-caps-amendment-sqlite-db-truncate-full-cap3`
- artifact：`harbor-fresh-cycle-caps-amendment/fresh-caps-amendment-sqlite-db-truncate-full-cap3/sqlite-db-truncate__3HnMjLW`
- config：Harbor `0.20.0`、Full dev-flow、requested/effective `maxCycles=3`、setup multiplier `2.0`；其他 timeout multiplier `1.0`、`force_build=true`。
- timestamps：started `2026-08-25T06:57:51.560129Z`、finished `2026-08-25T07:00:15.533637Z`；actual cycles `1`、canonical calls `4`。
- outcome：external verifier reward `1`、exception `null`；valid included pass。
- usage：input `7408`、cache read `13824`、output `843`；Full derived cache hit rate `0.6510927`。
- estimated cost：`0.0138484`，由 aggregator 對 sanitized `call-evidence.json` 四筆 `usage.costUsd` 求和；actual `null`。這是 explicit operator pricing estimate，不是 billing evidence。

Amendment primary matrix 已完成 8/8（兩題 × Codex／Single Pi／Full cap1／Full cap3）。
本 amendment manifest 另保留 1 筆 excluded Codex diagnostic，primary comparison 不受其影響。

## Image reuse read-only finding

目前 artifact config 是 `force_build=true`，因此後續 command 不能把這筆 trial 當成
「已建立 image 可直接跳過 build」。Harbor `0.20.0` Docker source 顯示相同 task
environment 會用 content-addressed `hb__<environment_id>` image name，普通 Docker
build 可利用 layer cache；但 `force_build=true` 仍會重新執行 `docker compose build`。
本 artifact 沒有持久化 image digest/build log 可證明下一筆會重用哪個 image，且本機
Docker daemon 的唯讀 inspect 被 socket permission 拒絕，因此只能說「可能重用 Docker
layer cache」，不能宣稱 image reuse 已驗證。為維持原始條件，下一筆仍保留
`force_build=true`，不自行改成 `false`。

## 後續處理（不再自動執行模型）

locked 8-trial primary matrix 已完成；下一步只做 read-only aggregate、結果報告與
human review，不自動追加 cap 5/10 或更多模型 trial。若要擴大題目或 cycle policy，
另立 preregistration amendment。下方保留 Full cap 1 的歷史命令 template：

```bash
harbor run --path /private/tmp/terminal-bench-formal/large-scale-text-editing \
  --agent harbor_full_dev_flow.agent:FullDevFlowAgent \
  --model gpt-5.6-luna --agent-kwarg thinking=medium \
  --agent-kwarg compatibility_manifest_path=/Users/skai.wu/side/agent-orchestrator/config/harbor/large-scale-text-editing-full-dev-flow-compatibility.json \
  --agent-kwarg max_cycles=1 \
  --agent-kwarg pi_auth_json_path="$PI_AUTH_PATH" \
  --env docker --force-build -k 1 -n 1 -r 0 \
  --timeout-multiplier 1.0 --agent-timeout-multiplier 1.0 \
  --verifier-timeout-multiplier 1.0 --agent-setup-timeout-multiplier 2 \
  --job-name fresh-caps-amendment-large-scale-text-editing-full-cap1 --yes
```
