# 專案概覽

本文件說明 Agent Orchestrator 的定位、使用入口與目前已實作邊界。

## 定位

Agent Orchestrator 將主討論 session 的結論保存為結構化 spec，再轉為 handoff；也保留直接接收 handoff 的入口。它先以 deterministic rules 與 Terra Low classifier 決定風險 tier，再分別啟動隔離的 Pi 子程序進行實作、測試與審查。這讓需求脈絡有穩定文件，同時避免 implementer 與 reviewer 共享對話上下文。

## 目前流程

```text
討論完成
  → approved spec（.agent/specs/）
  → /dev
  → handoff
  → deterministic floor + Terra Low risk classifier
  → isolated implementer
  → actual diff reclassification（tier 只能升）
  → deterministic tests
  → isolated reviewer
  → Tier 1/2 isolated Sol final reviewer
  → ready_for_main 或 needs_human
```

最多允許三個失敗 round。單純升級 tier 不算失敗 round，也不會自動重做已完成的 implementation；流程會先用較強 reviewer 重新檢查。

## 使用入口

### CLI

```bash
npm run orchestrate -- --handoff /absolute/path/handoff.json
```

### Pi / Remote Pi

```text
/dev
/orchestrate /absolute/path/handoff.json
/orchestrate /Users/skai.wu/side/example-repo 實作明確的小型需求
```

主要使用方式是在同一個 Pi session 討論需求，結論確定後說「把結論整理成 approved spec，先不要實作」。Agent 會呼叫 `save_agent_spec`，將文件寫進目標 repo 的 `.agent/specs/`，並記住該 session 的 spec。確認內容後只需輸入 `/dev`，不必再貼 repo 或檔案路徑。

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
