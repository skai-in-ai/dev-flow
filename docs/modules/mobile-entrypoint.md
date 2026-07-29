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
/orchestrate /Users/skai.wu/side/<repo> <需求描述>
```

例如：

```text
/orchestrate /Users/skai.wu/side/example 修正 README 的安裝指令
```

若已有完整 handoff：

```text
/orchestrate /Users/skai.wu/side/example/.orchestrator/handoffs/task.json
```

Extension 會立即通知 handoff 路徑，再以背景 child process 執行 orchestrator，進度透過 Pi notification 顯示。

## Draft handoff 行為

- repo path 目前不能包含空白。
- `scope.include` 固定為 `["."]`，因此通常至少是 Tier 1；若需求文字命中高風險規則則是 Tier 2。
- `acceptanceCriteria` 直接使用 objective。
- 自動偵測 `package.json` 的 `test` 與 `build` scripts。
- `delivery.requireApproval` 固定為 `true`，但 MVP 最後只顯示 `ready_for_main`，不會自動 commit/push。

## Session 與連線

Pi 主 session 位於 `/Users/skai.wu/side`，可控制該目錄下的 repo。Remote Pi relay 只傳遞 UI/session 資料；實際 orchestrator 與 agent child processes 均在 Mac 本機執行。手機離線不會改變已啟動 child process 的執行位置。
