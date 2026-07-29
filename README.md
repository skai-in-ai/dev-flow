# Agent Orchestrator

直接推 main 前的隔離實作與 review MVP。它使用 Pi child process（每個角色均為新 session），但終點只會是 `ready_for_main`，絕不自行 commit、push 或變動 main。

## Workflow

```text
handoff → hybrid route → implement → actual-diff risk scan → tests → isolated review → Sol gate → ready_for_main
```

- 測試結果由外部固定指令提供，workflow 不以 LLM 判斷測試是否通過。
- reviewer 必須是新的 agent invocation，只接收原始需求、diff、測試輸出等明確 artifacts，不共享 implementer 對話。
- T0: Luna low → Luna low；T1: Luna medium → Terra low → Sol low；T2: Terra medium → Terra medium → Sol medium。
- actual diff 只會升 tier。`escalate` 會直接用更高級 reviewer 再檢查，不重做 implementation，也不消耗 round；只有 `fail` 才回 implementer，最多 3 輪。
- 測試命令只能來自 handoff 或 repo config，reviewer 不決定命令。

## Structure

- `src/workflows/`: 純狀態機，沒有 provider、process 或檔案系統依賴。
- `src/policies/`: 可替換的 completion / retry policy。
- `src/agents/`: provider-neutral agent contracts。
- `src/adapters/pi/`: 真正的 Pi JSON child-process adapter，保存 JSONL 與 metadata。
- `src/test/`: Node 內建 test runner 的單元測試。

## Local verification

```bash
npm install
npm test
```

`npm install` 只會在此 repository 建立 local `node_modules`；不需要全域套件、登入或任何憑證。

## Run

建立 handoff JSON，例如：

```json
{
  "repo": "/Users/skai.wu/side/example-repo",
  "objective": "修正登入 callback",
  "scope": { "include": ["src/auth/callback.ts"] },
  "acceptanceCriteria": ["invalid state is rejected"],
  "constraints": ["do not change public API"],
  "tests": ["npm test"],
  "riskNotes": [],
  "delivery": { "mode": "direct_main", "requireApproval": true }
}
```

然後執行：

```bash
npm run orchestrate -- --handoff /absolute/path/handoff.json
```

Artifacts 會被寫到目標 repo 的 `.orchestrator/runs/<run-id>/`（已在 `.gitignore`）。Pi 必須已安裝並以 Codex OAuth 登入。

## Remote Pi 手機入口

repo 內含 extension：`extensions/orchestrate.ts`。主 session 的管理者可將此檔連結或複製到 `~/side/.pi/extensions/` 後 reload Pi；本實作不會自行寫入該目錄。手機主 session 中可輸入：

```text
/orchestrate /absolute/path/handoff.json
```

它會非阻塞啟動 CLI 並將進度顯示於 Pi；仍只會停在 `ready_for_main` 或 `needs_human`。
