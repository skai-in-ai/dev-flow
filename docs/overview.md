# 專案概覽

本文件說明 Agent Orchestrator 的定位、使用入口與目前已實作邊界。

## 定位

Agent Orchestrator 將主討論 session 的結論保存為結構化 spec，再轉為 handoff；也保留直接接收 handoff 的入口。它先以 deterministic rules 與 Luna Medium classifier 決定風險 tier，再分別啟動隔離的 Pi 子程序進行實作、測試與審查。這讓需求脈絡有穩定文件，同時避免 implementer 與 reviewer 共享對話上下文。

## 目前流程

```text
討論
  → /dev-flow
  → 完整：approved spec（.agent/specs/）→ 自動啟動
  → 不完整：draft / needs_clarification → 繼續討論後再 /dev-flow
  → handoff
  → deterministic floor + Luna Medium risk classifier
  → Luna-first isolated implementer
  → actual diff reclassification（tier 只能升）
  → deterministic tests
  → isolated reviewer
  → Tier 2 isolated Sol final reviewer
  → ready_for_main 或 needs_human
```

最多允許三次修正（共四次實作）。單純升級 tier 與 `needs_spec` 都不消耗 cycle，也不會自動重做已完成的 implementation；流程會先用較強 reviewer 重新檢查。implementer 的模型只看 cycle：首次 Luna Medium、兩次修正 Luna High、第三次修正才升 Terra Medium。tier 只決定 reviewer：T1 為 Luna High，T2 為 Terra Medium 加 Sol Medium final。

## 使用入口

### CLI

```bash
npm run orchestrate -- --handoff /absolute/path/handoff.json
```

### Pi / Remote Pi

```text
/dev-flow
/dev
/orchestrate /absolute/path/handoff.json
/orchestrate /Users/skai.wu/side/example-repo 實作明確的小型需求
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
| 自動 commit / push | 未實作 |
| 自動建立 PR / 合併 | 未實作 |
| 人工 approval UI | handoff 有欄位，但 MVP 僅停在 `ready_for_main` |
| Provider-agnostic adapter | contract 已抽象化；目前只有 Pi process adapter |

## Runtime 資料

`.orchestrator/` 會加入目標 repo 的 Git exclude，不進入版控。每次 run 保存 handoff、routing、各角色輸出、測試輸出與 summary。
