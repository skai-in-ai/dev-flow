# Agent Orchestrator

直接推 main 前的隔離實作與 review MVP。它使用 Pi child process（每個角色均為新 session），但終點只會是 `ready_for_main`，絕不自行 commit、push 或變動 main。

## Workflow

```text
handoff → hybrid route → implement → actual-diff risk scan → tests → isolated review → Sol gate → ready_for_main
```

- 測試結果由外部固定指令提供，workflow 不以 LLM 判斷測試是否通過。
- reviewer 必須是新的 agent invocation，只接收原始需求、diff、測試輸出等明確 artifacts，不共享 implementer 對話。
- implementer 只看 cycle：1 Luna medium、2/3 Luna high、4 Terra medium（`--max-tier` 低於 2 時不升 Terra）。reviewer 只看 tier：T0 Luna low、T1 Luna high、T2 Terra medium 加 Sol medium final。
- actual diff 只會升 tier。`escalate` 會直接用更高級 reviewer 再檢查，不重做 implementation，也不消耗 cycle；只有 `fail` 才回 implementer，最多 3 次修正（共 4 次實作），且最後一次修正仍會跑完所有 gate。
- 測試命令只能來自 handoff 或 repo config，reviewer 不決定命令。
- 啟動前先在乾淨 baseline 跑一次測試；不過就拒絕啟動，不花任何模型錢。
- 某個 cycle 的 findings 與上一個 cycle 逐字元相同時立即停止，再修一次也不會變。
- Runtime exception 會先寫出 `failed` summary（含 stderr 與已累積成本）再往外拋。

## Structure

- `src/policies/`: 可替換的 completion / retry policy，是修正次數上限的唯一來源。
- `src/report.ts`: 每次 run 的人類可讀報告，決定性渲染，不呼叫模型。
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
  "repo": "/path/to/workspace/example-repo",
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

repo 內含 extension：`extensions/orchestrate.ts`。主 session 的管理者可將此檔連結或複製到 `<workspace root>/.pi/extensions/` 後 reload Pi；本實作不會自行寫入該目錄。

Extension 用到的路徑全部可由環境變數覆寫：

| 變數 | 預設 | 用途 |
|:---|:---|:---|
| `AGENT_ORCHESTRATOR_HOME` | 由 extension 檔案自身位置推導（Node 會解開 symlink） | 本 repo 位置，`npm run orchestrate` 在此執行。只有在「複製而非連結」extension 時才需設定 |
| `AGENT_ORCHESTRATOR_STATE_DIR` | `~/.pi/agent-orchestrator` | session pointer 的存放處 |
| `AGENT_ORCHESTRATOR_WORKSPACE_ROOT` | 未設定 | **選用的安全邊界**。設了就只允許分派該目錄下的 repo；不設則不限制目錄，只要求目標是 Git repo，相對名稱以呼叫端 cwd 解析 |

三者都與 pi 的啟動目錄無關，因此從任何位置呼叫 `/dev-flow` 行為都一致。

手機主 session 中可輸入：

```text
/orchestrate /absolute/path/handoff.json
```

它會非阻塞啟動 CLI 並將進度顯示於 Pi；仍只會停在 `ready_for_main` 或 `needs_human`。
**tier 上限預設為 1**（成本考量，見 `docs/modules/routing.md`），要放開時顯式指定：`bin/dev-flow --max-tier 2 path/to/spec.md`。上限同時約束 reviewer 與 implementer 階梯。若 reviewer 要求超過上限的審查，流程會回到 `needs_human`，不會靜默放行或自動升級。
