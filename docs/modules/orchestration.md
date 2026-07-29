# Orchestration 模組

本文件說明 `Orchestrator.run()` 的前置條件、round 行為與完成狀態。

## 前置條件

1. 目標必須是 Git repo。
2. `.orchestrator/` 先加入 repo-local Git exclude。
3. `git status --porcelain` 必須為空；dirty working tree 直接拒絕啟動。
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
Tier > 0 → isolated Sol final reviewer
  pass → ready_for_main
  fail → 下一 round 回 implementer
```

## Round 計數

只有 test/reviewer/final reviewer 的實際失敗才前進到下一 round。最多三 round；第三 round 未通過回傳 `needs_human`。單純 tier escalation 不增加 round。

## 測試來源

Base tests 優先採用 `handoff.tests`；若為空則採用 `RepoConfig.tests`。再合併 effective tier 的 `RepoConfig.testsByTier[tier]` 並去重。命令依序執行，輸出完整保存到 ledger。

沒有命令時流程不會自行失敗，但會在 progress 與 reviewer artifact 明確標為 `NO DETERMINISTIC TESTS CONFIGURED`。

## 完成狀態

| 狀態 | 意義 |
|:---|:---|
| `ready_for_main` | 測試與該 tier 所需 reviews 通過；working tree 保留變更 |
| `needs_human` | 三輪失敗或 Tier 2 escalation 到達上限 |
| `failed` | 型別保留此值；目前主流程沒有以此值正常結束的分支，runtime exception 直接拋出 |

目前不會 commit、push、merge 或切換 branch。
