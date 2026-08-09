# 專案概覽

本文件說明 Agent Orchestrator 的定位、使用入口與目前已實作邊界。

## 定位

Agent Orchestrator 將主討論 session 的結論保存為結構化 spec，再轉為 handoff；也保留直接接收 handoff 的入口。它先以 deterministic rules 與 Luna Medium classifier 決定風險 tier，再分別啟動隔離的 Pi 子程序進行實作、測試與審查。這讓需求脈絡有穩定文件，同時避免 implementer 與 reviewer 共享對話上下文。

## 適用範圍與不適用的情況

這是**任務執行器，不是專案建造器**。整個安全模型建立在「deterministic tests + 對照 acceptance criteria 審一份 diff」上，兩者缺一就沒有把關能力。這決定了它的邊界：

| 硬性前提 | 出處 |
|:---|:---|
| 目標必須是 Git repo 且 working tree 乾淨（`.agent/specs/` 除外） | `Orchestrator.run()` |
| spec 必須 `approved` 且未決事項為空 | `assertRunnableSpec` |
| 測試命令必須已存在且有意義 | `handoff.tests` / `RepoConfig.tests` |
| reviewer 對著一份 diff 判斷 | `artifacts.diff` |

因此**不適用**於：

- **新專案的 0 到 1**：沒有 repo、沒有測試、沒有形狀。reviewer 會收到 `NO DETERMINISTIC TESTS CONFIGURED`，等於付了 Terra 與 Sol 的錢卻拿到沒有 gate 的 review，比不用更糟，因為它給出「已經 review 過」的錯覺。
- **大幅重構架構**：整包 diff 會撞上 prompt 預算被截斷，reviewer 只看得到頭尾。
- **需求還在邊做邊想**：spec 是探索的產物，不是輸入。強迫寫出「零未決事項」只會製造假確定性。

這些情況屬於探索階段，應由使用者與互動式 agent 直接進行。一個專案要能交給本流程，需先長出三樣東西：repo 骨架、**一個有意義的測試命令**（所有 gate 的地基）、以及足夠的形狀讓下一個變更能用一份 spec 描述完。

判準是：切得出「一份 spec 能描述完」的變更嗎？切不出來就代表還在探索階段。

## 兩條入口

兩條入口共用同一個 core orchestrator，但不能混為同一條操作流程。

### 入口 A：Pi／Remote Pi／CLI → working tree

```text
同一個 Pi session 討論
  → /dev-flow 整理並保存 spec
  ├─ 資訊不足：draft / needs_clarification → 回 session 補充
  └─ approved：自動啟動 core orchestrator
       → ready_for_main：變更留在目前 working tree
       └─ needs_human：由目前 session 接手
```

已有 approved spec 時用 `/dev` 或 `bin/dev-flow`；已有 handoff 時用 CLI `--handoff`。入口 A 不 commit、不 push、不建立 PR。

### 入口 B：GitHub Issue → isolated worktree → Draft PR

```text
建立符合 contract 的 GitHub Issue
  → status: approved + dev-flow-ready
  → worker claim
  → claimed remote SHA 建立 isolated worktree
  → core orchestrator
  ├─ ready_for_main：worker commit / push / 建立 Draft PR
  └─ needs_human：Issue 留報告並保留 worktree，可授權 resume
```

入口 B 會發布 Draft PR，但不 merge、不 deploy。

### 使用時機

| 需求 | 入口 |
|:---|:---|
| 目前 Pi 對話已收斂，想立刻開發 | A |
| 已有本機 approved spec 或 handoff | A |
| 從手機／外部 ChatGPT 交辦並以 GitHub 接收 | B |
| 多任務排隊、需要隔離 branch 與 Draft PR | B |
| 需求仍在探索或沒有 meaningful tests | 先不要進 orchestrator |

## 共用核心流程

```text
approved spec / handoff
  → baseline 測試預檢（不過就拒絕啟動，零成本）
  → deterministic floor + Luna Medium risk classifier
  → Luna-first isolated implementer
  → actual diff reclassification（tier 只能升）
  → deterministic tests
  → isolated reviewer
  → Tier 2 isolated Sol final reviewer
  → ready_for_main 或 needs_human
  → report.md（決定性渲染的人類可讀報告）
```

最多允許三次修正（共四次實作）。單純升級 tier 與 `needs_spec` 都不消耗 cycle，也不會自動重做已完成的 implementation；流程會先用較強 reviewer 重新檢查。implementer 的模型只看 cycle：首次 Luna Medium、兩次修正 Luna High、第三次修正才升 Terra Medium。tier 只決定 reviewer：T1 為 Luna High，T2 為 Terra Medium 加 Sol Medium final。**tier 上限預設為 1**，`--max-tier 2` 才會用到 Terra 與 Sol。相同失敗連續兩個 cycle 會提前熔斷。

## 入口 A 的操作方式

### CLI

```bash
npm run orchestrate -- --handoff /absolute/path/handoff.json
```

### Pi / Remote Pi

```text
/dev-flow
/dev
/orchestrate /absolute/path/handoff.json
/orchestrate /path/to/workspace/example-repo 實作明確的小型需求
```

主要使用方式是在同一個 Pi session 討論需求後輸入 `/dev-flow`。Agent 會根據本 session 整理 spec：資訊完整時寫入 approved spec 並自動開始流程；資訊不足時保存 draft 或 `needs_clarification`（repo 已知時）並直接提出缺少的問題，不會開始開發。補充後必須再次輸入 `/dev-flow`；一般對話後直接儲存 approved spec 不會沿用先前命令自動啟動。不必再貼 repo 或檔案路徑。

`/dev` 是相容入口，供已有 approved spec 的 session 直接啟動，不會重新彙整討論。

第二種形式會建立 draft handoff，並從目標 repo 的 `package.json` 自動加入既有 `test`、`build` scripts。

## 目前邊界

| 能力 | 現況 |
|:---|:---|
| 多模型 routing | Luna、Terra、Sol 的固定 tier matrix |
| Context isolation | 每個 role 使用新的 Pi session directory |
| 實際 diff 風險升級 | 已實作，tier 不會降級 |
| Deterministic tests | 執行 handoff 或 config 提供的 shell commands |
| Audit ledger | 寫入目標 repo 的 `.orchestrator/runs/` |
| Spec-first handoff | `.agent/specs/` 文件與 session-local pointer |
| 自動 commit / push | GitHub queue 成功 gate 後才對隔離 branch 執行 |
| 自動建立 PR / 合併 | queue 建立 Draft PR；不自動合併 |
| 人工 approval UI | handoff 有欄位，但 MVP 僅停在 `ready_for_main` |
| Provider-agnostic adapter | contract 已抽象化；目前只有 Pi process adapter |

## 入口 B：GitHub Issue queue

`bin/dev-flow-worker` 是單次 poll worker，每輪最多 claim 一個 open `dev-flow-ready` Issue。Issue 必須符合 `examples/github-issue-template.md` 的 approved spec 契約；人工 label 是 approval 邊界，但不是 sandbox。Worker 只接受設定 allowlist 的 owner/repository，從 workspace root 下已存在 checkout 建立獨立 worktree 與 `codex/issue-<number>-<slug>` branch。既有 orchestrator 的 Luna-first cycle matrix 與 max-tier cap 不變；只有 `ready_for_main` 和 deterministic gates 全通過才 commit、push、建立 Draft PR。

完整 label state machine、GitHub-side claim、failure recovery、launchd 與目前操作限制見 `docs/modules/github-issue-queue.md`。

## Runtime 資料

`.orchestrator/` 會加入目標 repo 的 Git exclude，不進入版控。每次 run 保存 handoff、routing、各角色輸出、測試輸出與 summary。
