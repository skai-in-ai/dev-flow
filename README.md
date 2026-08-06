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

## Threat model

**這套工具不提供沙箱。** 它以你的使用者權限執行 AI agent，agent 可以執行任意 shell 指令。使用前請先讀完本節。

### 實際的權限邊界

角色之間的工具權限不同，見 `toolsFor()`（`src/adapters/pi/pi-process-adapter.ts`）：

| 角色 | 工具 | 能不能寫檔 |
|:---|:---|:---|
| router | 無（`--no-tools`） | 否 |
| reviewer / final reviewer | `read,grep,find,ls` | 否 |
| implementer | `read,write,edit,bash,grep,find,ls` | **是，且不受路徑限制** |

reviewer 的唯讀限制是真的，由 Pi 的工具 allowlist 強制執行。**但不要因此推論 implementer 也受限。** implementer 拿到 `bash`，而 allowlist 的粒度到工具為止，管不到指令內容。child process 的 `cwd` 設為目標 repo，但 `cwd` 是起點不是圍籬：`cd .. && rm -rf` 或讀取 `~/.ssh/` 都不會被這套程式碼擋下。

Pi CLI 本身也沒有提供檔案系統沙箱、路徑白名單或目錄限制的選項（`pi --help`）。

### 哪些保證是 prompt，哪些是程式碼

這個分野很重要，因為前者可以被模型忽略：

- **程式碼強制**：reviewer 的唯讀工具集、reviewer 與 implementer 不共用 session、測試由外部固定指令執行且結果不經 LLM 判斷、修正次數上限、baseline 測試預檢、流程停在 `ready_for_main` 而不呼叫 commit 或 push。
- **僅為 prompt 請求**：`renderPrompt()` 裡的 `Never run git commit, git push, git reset, git checkout, or mutate main`，以及 implementer 指示中的「不要改動與需求無關的檔案」。這些是寫給模型看的約束，沒有執行層的攔截。

換句話說，「不會自動 commit」成立的原因是 orchestrator 不去呼叫 commit，不是 implementer 被禁止呼叫 commit。

### `AGENT_ORCHESTRATOR_WORKSPACE_ROOT` 擋的是什麼

它只在 extension 決定目標 repo 時生效（`resolvedRepo()`）。orchestrator 與所有 agent 都不讀取這個變數（child process 會照常繼承環境變數，但沒有任何一段程式碼會去看它），因此它對流程啟動之後的行為沒有任何約束力。

它是**選錯目標的防呆**：spec 裡 repo 路徑寫錯、指到隔壁專案這類手滑，設了就會被擋下。這是真實會發生的事，成本只有一個環境變數，建議設。

它**不是檔案系統的圍籬**：對已經在跑的 implementer 的 `bash` 毫無作用。請不要把它當成安全邊界來理解或對外宣稱。

### 測試命令本身就是 shell 執行

`tests` / `testRequirements` 的內容會以 `shell: true` 直接執行（`src/test-runner.ts`）。這是刻意的設計，測試結果必須是決定性的、不經 LLM 判斷，因此命令必須原封不動地跑。

代價是：**handoff 或 spec 裡的測試命令等同於任意 shell 執行權**。extension 的 `assertRawCommands()` 只擋自然語言敘述（避免模型寫出「在 repo 執行 npm test」這種無法執行的字串），它不是資安過濾，也沒有嘗試要當資安過濾。

因此 handoff 與 spec 應視為與程式碼同等的信任層級。不要執行來路不明的 spec 檔。

### 指向不受信任的 repo 時

implementer 會讀取 repo 內的檔案，內容會進入 prompt。配上不受限的 `bash`，一個帶有惡意指示的 repo 就構成以你的身分執行任意程式碼的路徑。這是所有 coding agent 共有的性質，不是本工具特有，但你應該知道它存在。

因此：**只對你信任的 repo 使用**，或先做隔離。

### 要真正的隔離該怎麼做

唯一能有效約束 `bash` 的層級在作業系統，不在本工具內部：

- 容器或 VM 內執行整個流程
- macOS 可用 `sandbox-exec` 包住 Pi child process
- 使用專用的低權限帳號，並移除該帳號對其他專案與憑證的讀取權

本 repo 目前不內建上述任何一項，也不打算假裝有。

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
| `AGENT_ORCHESTRATOR_WORKSPACE_ROOT` | 未設定 | 選用的**目標選取防呆**。設了就只允許分派該目錄下的 repo；不設則不限制目錄，只要求目標是 Git repo，相對名稱以呼叫端 cwd 解析。它不是檔案系統沙箱，見 [Threat model](#threat-model) |

三者都與 pi 的啟動目錄無關，因此從任何位置呼叫 `/dev-flow` 行為都一致。

手機主 session 中可輸入：

```text
/orchestrate /absolute/path/handoff.json
```

它會非阻塞啟動 CLI 並將進度顯示於 Pi；仍只會停在 `ready_for_main` 或 `needs_human`。
**tier 上限預設為 1**（成本考量，見 `docs/modules/routing.md`），要放開時顯式指定：`bin/dev-flow --max-tier 2 path/to/spec.md`。上限同時約束 reviewer 與 implementer 階梯。若 reviewer 要求超過上限的審查，流程會回到 `needs_human`，不會靜默放行或自動升級。
