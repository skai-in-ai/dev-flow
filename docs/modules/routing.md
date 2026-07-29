# Routing 模組

本文件說明 tier 判斷、只升不降規則與各角色的模型/reasoning 對照。

## Hybrid routing

`hybridRoute()` 同時取得 deterministic result 與 Terra Low classifier result，最終 tier 使用兩者較高值。classifier 無效或回傳非 0/1/2 時保留 deterministic floor。

流程在 implementation 前與取得 actual diff 後各判斷一次；effective tier 使用歷次最高值，不會降級。

## Deterministic floor

| Tier | 規則 |
|:---:|:---|
| 0 | include 全為 `.md`、`.txt`、`.rst`，且沒有高風險關鍵字/path |
| 1 | runtime code 副檔名，或 scope 不是純文件類型 |
| 2 | objective、scope、risk notes 或 actual diff 命中 migration、schema、database、auth、secret、token、payment、concurrency、queue、lock、transaction、Docker、CI/CD、deploy、production、breaking change 等 |

`RepoConfig.riskPaths` 可把特定字串提高到設定 tier；不會降低既有 tier。

## Model classifier

Classifier 使用 Terra Low，且以 `--no-tools` 啟動。Prompt 明確要求只判技術與變更風險，不可因 initial diff 尚不存在、acceptance criteria 尚未完成或 implementation 尚未開始而升級。

## Model matrix

| Tier | Implement | Review | Final review |
|:---:|:---|:---|:---|
| 0 | Luna Low | Luna Low | 不執行 |
| 1 | Luna Medium | Terra Low | Sol Low |
| 2 | Terra Medium | Terra Medium | Sol Medium |

模型 ID 目前固定為 `openai-codex/gpt-5.6-luna`、`gpt-5.6-terra`、`gpt-5.6-sol`。Provider 自由切換尚未實作成設定檔。

## Review escalation

- Reviewer 回 `escalate` 且 tier < 2：tier 加一，同 round 直接重新 review，不重跑 implementation，也不消耗失敗 round。
- Tier 2 reviewer 仍回 `escalate`：視為失敗，下一 round 回 implementer；第三次則 `needs_human`。
