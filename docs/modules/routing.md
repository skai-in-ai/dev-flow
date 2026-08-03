# Routing 模組

本文件說明 tier 判斷、只升不降規則與各角色的模型/reasoning 對照。

## Hybrid routing

`hybridRoute()` 同時取得 deterministic result 與 Luna Medium classifier result，最終 tier 使用兩者較高值。classifier 無效或回傳非 0/1/2 時保留 deterministic floor。

流程在 implementation 前與取得 actual diff 後各判斷一次；effective tier 使用歷次最高值，不會降級。

## Deterministic floor

| Tier | 規則 |
|:---:|:---|
| 0 | include 全為 `.md`、`.txt`、`.rst`，且沒有高風險關鍵字/path |
| 1 | runtime code 副檔名，或 scope 不是純文件類型 |
| 2 | objective、scope、risk notes 或 actual diff 命中 migration、schema、database、auth、secret、token、payment、concurrency、queue、lock、transaction、Docker、CI/CD、deploy、production、breaking change 等 |

`RepoConfig.riskPaths` 可把特定字串提高到設定 tier；不會降低既有 tier。

## Model classifier

Classifier 使用 Luna Medium，且以 `--no-tools` 啟動。Prompt 明確要求只判技術與變更風險，不可因 initial diff 尚不存在、acceptance criteria 尚未完成或 implementation 尚未開始而升級。它只能將 tier 升高；deterministic floor 仍是不可降低的安全底線。

## Model matrix

**Implementer 只看 cycle，不看 tier。** tier 只決定 reviewer 是誰。這讓成本可預期，並符合「實作盡量留在便宜的 Luna」的目標。

| Cycle | Implement | 理由 |
|:---:|:---|:---|
| 1 首次實作 | Luna Medium | handoff 已寫清楚要做什麼，High 的多餘推理正是範圍漂移的來源 |
| 2 第一次修正 | Luna High | 需要理解 finding 背後的意圖 |
| 3 第二次修正 | Luna High | 同上 |
| 4 第三次修正 | Terra Medium | Luna 連兩次修不好才升級，昂貴模型保留給有困難證據的情況 |

| Tier | Review | Final review |
|:---:|:---|:---|
| 0 | Luna Low | 不執行 |
| 1 | Luna High | Sol Low（僅在 escalation 導向時可能出現） |
| 2 | Terra Medium | Sol Medium |

模型 ID 目前固定為 `openai-codex/gpt-5.6-luna`、`gpt-5.6-terra`、`gpt-5.6-sol`。Provider 自由切換尚未實作成設定檔。

## Review escalation

- Reviewer 回 `escalate` 且 tier < 2：tier 加一，同 cycle 直接重新 review，不重跑 implementation，也不消耗 cycle。
- Tier 2 reviewer 仍回 `escalate`：**直接送 Sol final review 裁決**，不消耗 cycle，不重新實作。reviewer 說的是「這超出我的判斷」而非「實作有錯」，叫 implementer 再改一次沒有意義。
- T1 的 Luna reviewer 直接 pass 時即 `ready_for_main`；只有 reviewer escalation 導向 T2 時才執行 Sol final review。

## `needs_spec`

獨立於 escalate 與 fail 的第四種 verdict，表示「缺陷不在實作，而在 handoff 沒定義的產品語意」，重試沒有意義。

- 不消耗 cycle，直接收斂為 `needs_human`。
- 防濫用：findings 必須至少三條（第一條是缺的語意，其餘是候選答案，至少兩個），不足者降級為一般 `fail` 走重試路徑。
- 由 spec 入口啟動時，缺口與候選答案會寫回 spec 的「未決事項」並將 status 設為 `needs_clarification`，讓討論階段接手。
