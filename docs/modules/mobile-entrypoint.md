# 手機與 Pi 入口

本文件說明已部署的 Pi extension、Remote Pi 上的使用方式與目前限制。

## 部署位置

專案來源：

```text
/Users/skai.wu/side/agent-orchestrator/extensions/orchestrate.ts
```

Pi project extension：

```text
/Users/skai.wu/side/.pi/extensions/orchestrate.ts
```

目前使用 symlink，因此 repo 內 extension 更新後，Pi 執行 `/reload` 即可載入新版本。

## 手機使用

Remote Pi app 連上 `pi.lifestay.tw` 的 `mac-dev` session 後，在輸入框使用：

```text
先與 agent 討論需求
/dev-flow
```

`/dev-flow` 會讓同一個 session 的 agent 讀取目前討論並整理 spec。若目標 repo、範圍、驗收、測試或決策仍不完整，agent 會保存可保存的 draft / `needs_clarification` 並提出最少必要問題，不會啟動開發；補充後必須再輸入一次 `/dev-flow`，普通對話中的 spec 儲存不會自動開始。若資訊完整，agent 會呼叫 `save_agent_spec` 寫入 approved spec，extension 立即自動啟動隔離的 dev → review 流程。

每個 Pi session 分別記住最近一次 spec，因此手機不必輸入完整路徑。`/dev` 保留為相容入口：已有 approved spec 時可直接重跑它，不會重新分析討論內容。

舊的直接入口仍可用：

```text
/orchestrate /Users/skai.wu/side/example 修正 README 的安裝指令
```

若已有完整 handoff：

```text
/orchestrate /Users/skai.wu/side/example/.orchestrator/handoffs/task.json
```

Extension 會立即通知 handoff 路徑，再以背景 child process 執行 orchestrator，進度透過 Pi notification 顯示。

## Spec 條件

- repo 必須位於 `/Users/skai.wu/side` 且本身為 Git repo。
- `/dev` 只接受 `approved` 且沒有未決事項的 spec。
- `/dev-flow` 僅在本次命令建立的 approved spec 才會自動開始；draft 或 `needs_clarification` 一律停止在討論 session。
- 測試要求必須是原始 shell command，例如 `npm test`，不能寫成「在 repo 執行 npm test」。
- 成功後 spec 變為 `ready_for_main`；三輪未通過則變為 `needs_clarification`。
- Session pointer 寫在 `~/.pi/agent-orchestrator/sessions/`，不同 session 不互相誤用。

## Draft handoff 行為

- repo path 目前不能包含空白。
- `scope.include` 固定為 `["."]`，因此通常至少是 Tier 1；若需求文字命中高風險規則則是 Tier 2。
- `acceptanceCriteria` 直接使用 objective。
- 自動偵測 `package.json` 的 `test` 與 `build` scripts。
- `delivery.requireApproval` 固定為 `true`，但 MVP 最後只顯示 `ready_for_main`，不會自動 commit/push。

## Session 與連線

Pi 主 session 位於 `/Users/skai.wu/side`，可控制該目錄下的 repo。Remote Pi relay 只傳遞 UI/session 資料；實際 orchestrator 與 agent child processes 均在 Mac 本機執行。手機離線不會改變已啟動 child process 的執行位置。
