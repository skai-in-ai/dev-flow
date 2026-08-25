---
repo: "/Users/skai.wu/side/agent-orchestrator"
status: approved
title: "Fresh cycle-cap experiment: setup-timeout amendment"
created_at: "2026-08-22T00:00:00+08:00"
parent_spec: ".agent/specs/2026-08-22-terminal-bench-fresh-cycle-caps.md"
---

# Preregistration amendment

這份 amendment 只修改 fresh cycle-cap 實驗的 Harbor agent setup timeout policy。
原始實驗的八個 planned conditions、task derivative、model、reasoning、cycle cap、
gate、retry、session、concurrency、budget 與 acceptance boundary 全部不變。

## 變更

所有八個 planned trials 統一加入 Harbor job-level flag：

```text
--agent-setup-timeout-multiplier 2
```

這個設定套用於三個 harness：Harbor Codex、Single Pi、Full dev-flow；Full 的
`maxCycles=1` 與 `maxCycles=3` 兩個 condition 也都套用。它只將 Harbor agent
setup/install phase 的 timeout 乘以 2（目前 Harbor 0.20.0 的 locked default 是
360 秒，因此 setup budget 變成 720 秒），不會改變 task timeout 或 agent execution
timeout。

## 不變項

- model `gpt-5.6-luna`、reasoning/thinking `medium`、Full `maxTier=1`。
- `timeoutMultiplier=1.0`、`agentExecutionTimeoutMultiplier=1.0`、
  `verifierTimeoutMultiplier=1.0`；這三個 timeout multiplier 顯式維持原值。
- `maxCycles=1` 與 `maxCycles=3` 的 total implementation-cycle 語意。
- task timeout：`large-scale-text-editing=1200s`、`sqlite-db-truncate=900s`。
- Harbor retry `0`、concurrency `1`、fresh session、`forceBuild=true`。
- deterministic preflight gates 與 Harbor external verifier acceptance authority。
- `allowLocalCommit=false`，不 resume、不跨 condition 重用 session/cache。
- US$0.75 planning ceiling、actual cost 無 billing evidence 時為 `null`。

## 既有 invalid artifact

2026-08-22 第一筆 Codex baseline 使用原始 locked setup policy，在模型執行前超過
360 秒並分類為 `infrastructure-invalid`。該 artifact 與
`config/harbor/terminal-bench-fresh-cycle-caps-results-manifest.json` 保留原樣，
不覆寫、不重分類、不納入有效成功率分母。amendment 生效後重新執行的 condition
必須使用新的 job name 與新的 artifact root；若要重跑同一 condition，結果必須以
新的 manifest entry 記錄，並標明這是 amendment 後的 run。

## 新 job names

正式重跑使用 amendment 專用 prefix：

```text
fresh-caps-amendment-<task>-codex
fresh-caps-amendment-<task>-single-pi
fresh-caps-amendment-<task>-full-cap1
fresh-caps-amendment-<task>-full-cap3
```

不得沿用既有 `fresh-caps-...` job name 或 artifact directory。

## 驗收

在任何模型 trial 前，兩個 task 的四種 command template 都必須用 Harbor
`--print-config` 唯讀確認：

- `agentSetupTimeoutMultiplier=2`（或 Harbor config output 的等價欄位）。
- `timeoutMultiplier=1.0`、`agentTimeoutMultiplier=1.0`、`verifierTimeoutMultiplier=1.0`
  未被 amendment 改動。
- task path、agent、model、reasoning、`forceBuild=true`、`nAttempts=1`、
  `nConcurrentTrials=1`、retry `0`、Full `maxCycles=1/3` 均符合原始 plan。

`--print-config`、JSON validation、TypeScript/Python tests 與 `git diff --check` 是
本 amendment 的 no-model 驗收；不啟動 Docker、verifier、網路、OAuth 或模型。
