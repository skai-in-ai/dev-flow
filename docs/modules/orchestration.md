# Orchestration 模組

本文件說明 `Orchestrator.run()` 的前置條件、round 行為與完成狀態。

## 前置條件

1. 目標必須是 Git repo。
2. `.orchestrator/` 先加入 repo-local Git exclude。
3. 除 `.agent/specs/` 外，`git status --porcelain` 必須為空；其他 dirty working tree 直接拒絕啟動。
4. baseline 記錄目前 `HEAD`；implementer 若改變 HEAD，流程丟出錯誤。

## 每個 round

```text
需要實作？
  yes → isolated implementer
取得 tracked + untracked working diff
重新 hybrid routing
執行 deterministic tests
  fail → 下一 round 回 implementer
isolated reviewer
  escalate → 升 tier，優先同 round 重審
  fail → 下一 round 回 implementer
Tier 2 → isolated Sol final reviewer
  pass → ready_for_main
  fail → 下一 round 回 implementer
```

## Round 計數

只有 test/reviewer/final reviewer 的實際失敗才前進到下一 round。最多三 round；第三 round 未通過回傳 `needs_human`。單純 tier escalation 不增加 round。T2 在第 1 round 失敗後，後續 round 的 implementer 由 Luna High 升為 Terra Medium。

## 測試來源

Base tests 優先採用 `handoff.tests`；若為空則採用 `RepoConfig.tests`。再合併 effective tier 的 `RepoConfig.testsByTier[tier]` 並去重。命令依序執行，輸出完整保存到 ledger。

從 spec 轉入的測試要求必須是 raw executable shell commands；自然語言會在保存或啟動前拒絕。

沒有命令時流程不會自行失敗，但會在 progress 與 reviewer artifact 明確標為 `NO DETERMINISTIC TESTS CONFIGURED`。

## 完成狀態

| 狀態 | 意義 |
|:---|:---|
| `ready_for_main` | 測試與該 tier 所需 reviews 通過；working tree 保留變更 |
| `needs_human` | 三輪失敗或 Tier 2 escalation 到達上限 |
| `failed` | 型別保留此值；目前主流程沒有以此值正常結束的分支，runtime exception 直接拋出 |

目前不會 commit、push、merge 或切換 branch。

若入口是 spec，`ready_for_main` 會同步將 spec status 更新為 `ready_for_main`；`needs_human` 則更新為 `needs_clarification`。Runtime exception 保留原 status，方便重試與診斷。
