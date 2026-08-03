# Orchestration 模組

本文件說明 `Orchestrator.run()` 的前置條件、cycle 行為與完成狀態。

## 前置條件

1. 目標必須是 Git repo。
2. `.orchestrator/` 先加入 repo-local Git exclude。
3. 除 `.agent/specs/` 外，`git status --porcelain` 必須為空；其他 dirty working tree 直接拒絕啟動。
4. baseline 記錄目前 `HEAD`；implementer 若改變 HEAD，流程丟出錯誤。

## 每個 cycle

一個 cycle 是一次完整的 implement → tests → reviewer →（tier 2）final。

```text
需要實作？
  yes → isolated implementer（模型依 cycle 階梯，見 routing.md）
取得 tracked + untracked working diff
重新 hybrid routing
執行 deterministic tests
  fail → 下一 cycle 回 implementer
isolated reviewer
  needs_spec（合格）→ 立即 needs_human，不消耗 cycle，回到討論階段
  escalate 且 tier < 2 → 升 tier，同 cycle 重審，不消耗 cycle
  escalate 且 tier = 2 → 直接交 Sol final 裁決，不消耗 cycle，不重新實作
  其餘非 pass → 下一 cycle 回 implementer
Tier 2 → isolated Sol final reviewer
  needs_spec（合格）→ 立即 needs_human，不消耗 cycle
  pass → ready_for_main
  fail → 下一 cycle 回 implementer
```

## Cycle 計數

`maxFixCycles` 計的是「因失敗而重新實作」的次數，預設 3，對應最多 4 次實作（cycle 1 是原始實作，cycle 2 至 4 是三次修正）。可由 `RepoConfig.maxFixCycles` 覆寫。

**關鍵不變量：失敗計數點在失敗當下，不在進入時。** 因此最後一次修正（cycle 4）仍會完整跑完 tests、reviewer 與必要的 final review，只有在它也失敗時才收斂為 `needs_human`。

判斷邏輯只存在於 `src/policies/completion-policy.ts` 的 `nextCycle`，`orchestrator.ts` 的每個失敗分支都必須呼叫它，上限數字不得散落在別處。單純 tier escalation 與 `needs_spec` 都不消耗 cycle。

## Decision log

`decisions.json` 累積每個 cycle 的 findings（來源為 tests / reviewer / final_reviewer）與 implementer 的逐輪回應，並以 `decision_log` artifact 同時餵給 implementer、reviewer 與 final reviewer。

存在的理由：reviewer 每個 cycle 都是全新的 isolated session，若看不到前幾輪的 finding 與 implementer 的回應，會重新推導出同一個疑慮，也看不到上一輪 final reviewer 已經對同一個 trade-off 做過的裁決，於是兩個都對的 reviewer 會被呈現成互相矛盾的 fail。

刻意**只呈現歷史，不做裁決**：沒有任何把 finding 標記為「已推翻」的機制。兩位 reviewer 對同一故障的不同面向都可能是對的，硬性推翻會丟資訊。

log 只收結構化 findings，沒有 findings 時才退回整段 summary，避免歷史被每輪的散文淹沒。implementer 的回應以「每個 cycle 一筆」記錄，因為自由格式敘述無法可靠地機械切分歸屬到個別 finding。

## 測試來源

Base tests 優先採用 `handoff.tests`；若為空則採用 `RepoConfig.tests`。再合併 effective tier 的 `RepoConfig.testsByTier[tier]` 並去重。命令依序執行，輸出完整保存到 ledger。

從 spec 轉入的測試要求必須是 raw executable shell commands；自然語言會在保存或啟動前拒絕。

沒有命令時流程不會自行失敗，但會在 progress 與 reviewer artifact 明確標為 `NO DETERMINISTIC TESTS CONFIGURED`。

## 完成狀態

| 狀態 | 意義 |
|:---|:---|
| `ready_for_main` | 測試與該 tier 所需 reviews 通過；working tree 保留變更 |
| `needs_human` | 修正次數用盡，或 reviewer 回報合格的 `needs_spec`（產品語意未定義） |
| `failed` | 型別保留此值；目前主流程沒有以此值正常結束的分支，runtime exception 直接拋出 |

目前不會 commit、push、merge 或切換 branch。

若入口是 spec，`ready_for_main` 會同步將 spec status 更新為 `ready_for_main`；`needs_human` 則更新為 `needs_clarification`。若帶有 `specGap`，缺的語意與候選答案會一併寫回 spec 的「未決事項」，讓 `needs_spec` 成為回到討論階段的那條邊，而不是死路。Runtime exception 保留原 status，方便重試與診斷。

## 兩個階段的介面

```text
     ┌──────────────────────────────────────┐
     ▼                                      │
討論階段（Claude Code 或 Pi，人在哪就在哪）   │
     │                                 needs_spec
spec: approved                    缺的語意 + 候選答案
unresolvedItems: []                       │
     ▼                                      │
實作階段（orchestrator）───────────────────┘
     │
     ▼
ready_for_main
```

兩個階段不合併成同一個 agent，統一的是 spec 格式本身。討論階段的價值來自累積的脈絡（知識庫、前幾輪決策、專案記憶），那綁在使用者人在哪討論，不綁在哪個 agent。`loadSpec` 定義的 frontmatter 加八個章節已是兩邊共用的契約。

## dev-flow 入口

`bin/dev-flow` 是隨手分派的薄殼：無參數時跑目前 repo `.agent/specs/` 中最新一份 spec，也可指定路徑。

gating 沿用 `assertRunnableSpec`（status 為 approved 且無未決事項），**資訊不齊全一律不啟動**，改為印出待答問題。刻意不自動略過未定案的 spec 去找更舊的可執行 spec：使用者以為在跑新任務卻安靜地跑了舊的，比報錯更糟。
