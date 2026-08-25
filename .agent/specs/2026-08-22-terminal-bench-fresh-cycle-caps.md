---
repo: "/Users/skai.wu/side/agent-orchestrator"
status: approved-amended
title: "Fresh Terminal-Bench repeated trials: cycle cap 1 versus 3"
created_at: "2026-08-22T00:00:00+08:00"
---

# 目標

2026-08-22 已核准 setup-timeout amendment：
`.agent/specs/2026-08-22-terminal-bench-fresh-cycle-caps-timeout-amendment.md`。
該 amendment 只改 Harbor agent setup timeout multiplier，原始研究變項與所有
acceptance boundary 維持不變。

2026-08-22 已核准 setup-timeout amendment：
`.agent/specs/2026-08-22-terminal-bench-fresh-cycle-caps-timeout-amendment.md`。
該 amendment 只改 Harbor agent setup timeout multiplier，原始研究變項與所有
acceptance boundary 維持不變。

在尚未納入既有成功率結論的新題上，預先登記一個小型 fresh repeated-trial
實驗，回答 Full dev-flow 的總 cycle cap 從 1 增加到 3 是否改善 external verifier
成功，以及新增 cycles 是否值得其額外 estimated cost。實驗同時保留 Harbor Codex
與 Single Pi 各一個 cap-independent baseline，避免把 task difficulty 誤當成
cycle policy 效果。

本 spec 只準備 derivative、compatibility metadata、run policy 與 no-model
驗收；本次準備不執行 Docker build、Harbor run、verifier、網路、OAuth 或模型。

# 背景與決策

唯讀盤點 `/private/tmp/terminal-bench-2.0-full/terminal-bench` 後，選定兩個尚未
出現在既有 stage-2、prove-plus-comm comparison 或 telemetry canary 結果中的題：

| task | derivative | workdir | reason for selection |
| --- | --- | --- | --- |
| `large-scale-text-editing` | `/private/tmp/terminal-bench-formal/large-scale-text-editing` | `/app` | medium file-operation task；Dockerfile 會產生 deterministic inputs，無需模型前網路 |
| `sqlite-db-truncate` | `/private/tmp/terminal-bench-formal/sqlite-db-truncate` | `/app` | medium file-recovery task；輸入 database 已在本地環境，無需模型前網路 |

兩個 derivative 只修改 `environment/Dockerfile`：加入 Git，並將 image 內已存在的
task input 建立成乾淨 baseline commit。instruction、visible tests、task metadata、
solution 檔案與其他 environment inputs 未閱讀其內容且保持 byte-for-byte；solution
與 expected/verifier details 不作本實驗輸入，也不會傳回 agent。每個 derivative 的
source/derivative canonical digest 與 preserved files 見對應 compatibility manifest。

`maxCycles` 在本 spec 指完成 workflow 的總 implementation cycles，包含第一次
implementation；core policy 以 `maxImplementationAttempts` 表達，因此：

- cap 1 → `maxCycles=1`（最多 1 implementation cycle）
- cap 3 → `maxCycles=3`（最多 3 implementation cycles）

這個 mapping 必須在實際 trial 前由 wrapper/bridge no-model preflight 證明已生效；
目前已完成 wrapper/bridge 接線，但仍須在正式 trial 前使用 `--print-config` 與
contract tests 確認 exact kwarg 與 applied outcome。若 preflight 不能觀測到 exact
cap，整批停止，不把預設 cap 3 當成 cap-1 結果。

## Setup-timeout amendment

八個 planned trials（三個 harness、Full cap 1/3 均包含）統一使用 Harbor job-level
`--agent-setup-timeout-multiplier 2`。這只放寬 agent setup/install phase 的 timeout；
不改 task timeout、agent execution timeout、verifier timeout、model、reasoning、
maxCycles、gate、retry、session、concurrency 或 budget。原本以 360 秒 setup policy
產生的 `infrastructure-invalid` artifact 保留，不覆寫；amendment 後重跑使用新的
job name 與 artifact root，並在新的結果 manifest 記錄。

## Setup-timeout amendment

八個 planned trials（三個 harness、Full cap 1/3 均包含）統一使用 Harbor job-level
`--agent-setup-timeout-multiplier 2`。這只放寬 agent setup/install phase 的 timeout；
不改 task timeout、agent execution timeout、verifier timeout、model、reasoning、
maxCycles、gate、retry、session、concurrency 或 budget。原本以 360 秒 setup policy
產生的 `infrastructure-invalid` artifact 保留，不覆寫；amendment 後重跑使用新的
job name 與 artifact root，並在新的結果 manifest 記錄。

# Invariants and non-goals

## Invariants

- 只使用 evaluation-only Harbor 第三入口；production 入口 A/B、commit invariant、
  push、merge、deploy 與 routing 不變。
- 每題每個 harness 使用同一份 locked derivative；external Harbor verifier 是唯一
  task acceptance authority，deterministicTests 只是公開 preflight/gate evidence。
- 每筆 trial 都是 fresh session、Harbor retry 0、one concurrent trial；不跨題、不跨
  cap、不跨 harness 復用 session 或 cache。
- gate 只使用 manifest 中已預註冊、乾淨 baseline 可執行的公開 input/tool/Git-root
  invariant；不得讀 hidden verifier、solution、reward 或把 task-specific 失敗倒推成
  gate。
- requested/effective config、raw usage、cache denominator、session、calls、cycles、
  estimated/actual cost 分開記錄；缺證據為 `null`/`unknown`，不得猜測。
- invalid trial 保留 failure phase、artifact 與分類，但不進 success/cost/token 分母；
  infrastructure-invalid 不得自動重跑消耗模型預算。
- 新結果使用新的 manifest/artifact root；不得覆寫 stage-2 five-task 或 telemetry
  canary manifest。

## Non-goals

- 不用兩題推導 Terminal-Bench 普遍成功率、leaderboard 分數或「三輪保證可靠」。
- 不做 gate-on/gate-off 因果實驗；本輪 gate 固定，研究變項只有 Full cycle cap。
- 不展開 cap 0/1/2/3/5/10 全矩陣；cap 5 只有在預註冊停止規則允許時另立 spec。
- 不填寫 provider billing 的 `actualCostUsd`；catalog/subscription estimate 不是實際
  付款。
- 不開啟 local commit、resume、Harbor retry、parallel trials 或 session reuse。

# 修改範圍

- `/private/tmp/terminal-bench-formal/large-scale-text-editing`：workspace-compatible
  derivative，僅 Dockerfile 變更。
- `/private/tmp/terminal-bench-formal/sqlite-db-truncate`：workspace-compatible
  derivative，僅 Dockerfile 變更。
- `config/harbor/large-scale-text-editing-full-dev-flow-compatibility.json`
- `config/harbor/sqlite-db-truncate-full-dev-flow-compatibility.json`
- `config/harbor/terminal-bench-fresh-cycle-caps-run-plan.md`
- `config/harbor/terminal-bench-fresh-cycle-caps-preregistration.json`：只保存
  preregistration policy；實際 trial path 完成後由 operator 建立符合
  `benchmark-run-manifest-1` 的新 results manifest，不回寫本檔。
- 本 spec 與 living backlog 的 provenance/status/acceptance 更新。
- `.agent/specs/2026-08-22-terminal-bench-fresh-cycle-caps-timeout-amendment.md`：
  setup-timeout amendment 與新 job-name policy。
- `.agent/specs/2026-08-22-terminal-bench-fresh-cycle-caps-timeout-amendment.md`：
  setup-timeout amendment 與新 job-name policy。

已完成一個小範圍的 cap plumbing：Full Python wrapper 接受明確的
`max_cycles` kwarg，bridge 將它傳給 `Orchestrator`，並在 requested/effective
telemetry 與 bridge result 中保留 exact value。這不是 task gate，也不改 production
入口；正式 model commands 仍需通過本 spec 的 no-model preflight。

# 排除範圍

- `/private/tmp/terminal-bench-2.0-full/terminal-bench/*/solution/**`
- hidden verifier、expected output、Harbor reward、既有 trial prompt/trajectory
- stage-2/canary artifact 改寫、模型輸出預讀、網路下載與 Docker image build
- upstream leaderboard 或公開分數宣稱

# 驗收條件

1. 兩個 derivative 的 canonical digest、source provenance 與 Dockerfile-only delta
   可重算；preserved files byte-for-byte 一致。
2. 兩個 compatibility manifest 通過 schema/metadata validation，`fullDevFlowCompatible`
   為 true，`allowLocalCommit=false`，workdir/Git/test visibility/verifier boundary
   明確，且 deterministic gate 只包含公開 preflight invariant。
3. cap 的 no-model contract 明確驗證：`maxCycles=1` 與 `maxCycles=3` 都直接被
   observed；任何未觀測或預設值均 fail closed。
4. run plan 鎖定 8 個有效候選 trial：兩題 ×（Codex baseline、Single Pi baseline、
   Full cap 1、Full cap 3）；每個候選各自新 job name 與 artifact root。
5. 若 cap=3 未能在 3 cycles 前完成，結果仍算有效的 capped failure；若 cap=1 已
   pass，cap=3 不因「多跑」而重新定義為成功改善。
6. summary 只由新 manifest + raw artifacts 唯讀聚合；每筆 verifier reward/status、
   stop reason、cycle/call count、estimated cost、actual cost/null、invalid taxonomy
   與 evidence refs 可追溯。

# 測試要求

- `npm test`
- `python3 -m unittest discover -s packages/harbor-full-dev-flow/tests -p 'test_*.py'`
- `git diff --check`
- `python3 -m json.tool config/harbor/terminal-bench-fresh-cycle-caps-preregistration.json`
- Harbor `--print-config`：兩題 × 四個 command template 均須觀測
  `agentSetupTimeoutMultiplier=2`；只可作 no-model preflight。
- Harbor `--print-config`：兩題 × 四個 command template 均須觀測
  `agentSetupTimeoutMultiplier=2`；只可作 no-model preflight。

上述是 no-model/read-only validation。正式 trial 的 `harbor run` 命令只可在
operator 明確授權預算、auth 與 cap plumbing preflight 後執行。

# 風險

- `large-scale-text-editing` 會生成大型 CSV，Docker build/wall time 可能顯著高於
  canary；task timeout 以 source `task.toml` 的 1200 秒為準，不自行改寫。
- SQLite 題可能因損壞資料恢復難度造成 cap=1/3 都 fail；這是有效 task failure，不能
  事後把資料庫內容轉成 gate。
- Harbor source image/registry、Docker/TLS、auth refresh、Pi package 安裝失敗均在
  模型前分類為 infrastructure-invalid，不進 agent success denominator。
- cost 表只報 catalog/subscription estimate；`actualCostUsd` 無 billing ledger 時必為
  null。
- Full cap plumbing 已完成並通過 no-model contract/print-config；若 wheel 尚未重建
  或 runtime artifact 未包含此版本，仍視為 infrastructure-invalid，禁止正式 trial。

# 未決事項

無。cap plumbing 是已知的執行前 acceptance prerequisite，不是待使用者決策的問題；
若其 no-model 驗證失敗，狀態應標為 blocked/preflight-invalid 並停止本 spec 的正式
trial。
