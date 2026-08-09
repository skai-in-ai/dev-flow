# 文件工程計畫：Same-Issue Resume 落地後的文件同步

範圍：`skai-in-ai/dev-flow`（本機 checkout 為 `agent-orchestrator`，worktree `.orchestrator/worktrees/skai-in-ai-dev-flow-10`，branch `codex/issue-10-issue-worktree-needs-human`）。

觸發原因：本 session 人工接手 Issue #10，實作了 Same-Issue Resume MVP（commit `019b1a1`），並合併了 main 的 FIFO 選取（`2c5ed1f`、`e7bf7d5`）。程式碼行為已變，部分文件尚未跟上。

## 差距分析報告

### CLAUDE.md 狀態

存在，82 行（限制 200 行內，尚有空間）。缺少：

- 「模組」清單沒有 GitHub queue（`src/github-queue.ts`、`src/github-queue-cli.ts`、`bin/dev-flow-worker`），但「文件導航」表有指向 `docs/modules/github-issue-queue.md`，兩處不一致。
- 「維護原則」未涵蓋 resume 的新不變量（provenance 驗證不可跳過、等待中的 resume 不得寫入 Issue）。

### 現有文件

| 檔案 | 行數 | 狀態 |
|:---|---:|:---|
| `docs/overview.md` | 97 | **過時** — 流程圖與 queue 一節沒有 resume；邊界表缺列 |
| `docs/architecture.md` | 106 | **部分更新** — queue boundary 段本 session 已改；分層表與 ledger 樹過時 |
| `docs/modules/orchestration.md` | 171 | **過時** — 前置條件、預檢、flowchart 都沒有 resume 這條邊 |
| `docs/modules/github-issue-queue.md` | 238 | **大致完整** — 本 session 已更新；仍缺 provenance 欄位表、ledger 檔案清單、comment 編輯的 gotcha |
| `docs/modules/routing.md` | 66 | 完整 |
| `docs/modules/pi-adapter.md` | 56 | 完整 |
| `docs/modules/mobile-entrypoint.md` | 79 | 完整 |
| `docs/contracts/spec.md` | 36 | 完整 |
| `docs/contracts/handoff.md` | 45 | **不完整** — 只記 handoff JSON，未記 `RunSource`（新增 `resume`、`allowRetainedChanges`） |
| `docs/rules/testing-and-safety.md` | 78 | **已更新**（本 session） |
| `README.md` | 494 | **需重整** — 見下方 |

### 缺少文件

無需新增檔案。現有結構已覆蓋所有模組，resume 屬於 queue 模組的一部分，不另立檔案（避免與 `github-issue-queue.md` 內容重複）。

### 需更新文件

1. `README.md` — 使用者明確要求：**開頭先講此 repo 解決什麼問題，再講整體流程**。目前順序相反（1-28 行是定位與流程圖，30 行才是「它解決什麼問題」）。另需補 resume 到流程圖與 Threat model。
2. `docs/overview.md` — 流程、queue 一節、邊界表。
3. `docs/modules/orchestration.md` — 前置條件、預檢、flowchart、`RunSource`。
4. `docs/architecture.md` — 分層表補齊實際檔案、ledger 樹補 queue 產物。
5. `docs/modules/github-issue-queue.md` — provenance 欄位表、ledger 檔案清單、comment 編輯 gotcha。
6. `docs/contracts/handoff.md` — 補 `RunSource` 一節。
7. `CLAUDE.md` — 模組清單與維護原則。

### 模組覆蓋率

已辨識模組 11 個（routing、orchestration、pi-adapter、mobile-entrypoint、github-queue、report、prompt-budget、decision-log、completion-policy、test-runner、dev-flow 入口）。

獨立文件 5 個；其餘 6 個以章節形式存在於 `orchestration.md`（decision log、執行報告、預檢、熔斷、測試來源、dev-flow 入口）與 `architecture.md`（分層表）。

覆蓋率 100%（無未記錄模組），但呈現方式不對稱：`report.ts` 與 `prompt-budget.ts` 各有實質設計決策，目前埋在 orchestration 內。本次不拆（拆檔會製造交叉引用維護成本），列為觀察。

## 文件計畫

### 步驟 1：README 重整（大）

目標路徑：`README.md`

大綱調整：

| 現況順序 | 調整後 |
|:---|:---|
| H1 + 定位段 + 流程圖 + 免責 | H1 + **一句話定位** |
| `## 它解決什麼問題` | `## 它解決什麼問題`（提前，含原本的痛點清單） |
| — | `## 整體流程`（原本散在開頭的 ASCII 圖 + 完整流程，含 resume 這條邊） |
| `## 核心特色` 1-10 | 不動順序，更新第 8、10 節 |
| 其餘 | 不動，僅更新 Threat model |

資訊來源：現有 README、`src/github-queue.ts`、`src/orchestrator.ts`。

### 步驟 2：overview.md + orchestration.md（中）

- `overview.md`：「目前流程」加 resume 分支；「GitHub Issue queue」一節改寫；「目前邊界」表加「同 Issue resume」列。
- `orchestration.md`：前置條件 3 加 `allowRetainedChanges` 例外；「預檢」一節加 resume 的容忍與不容忍；flowchart 的 `Clean` 與 `Pre` 節點加 resume 分支；新增「Resume 入口」小節說明 `RunSource.resume` 如何注入 artifacts。

資訊來源：`src/orchestrator.ts:50-80`、`src/orchestrator.ts:113-135`。

### 步驟 3：architecture.md + handoff.md（中）

- `architecture.md`：分層表補 `src/github-queue.ts`、`src/github-queue-cli.ts`、`src/dev-flow.ts`、`src/report.ts`、`src/prompt-budget.ts`、`src/decision-log.ts`、`src/policies/completion-policy.ts`；ledger 樹補 `queue-jobs/` 與 `queue-provenance.json`。
- `handoff.md`：新增「RunSource」一節，記 `specPath`/`specTitle`/`specMarkdown`/`maxTier`/`resume`/`allowRetainedChanges`。

資訊來源：`src/orchestrator.ts:30-36`、`src/github-queue.ts` 的 `record()` 呼叫點。

### 步驟 4：github-issue-queue.md + CLAUDE.md（小）

- `github-issue-queue.md`：新增 `queue-provenance.json` 欄位表、job ledger 檔案清單（含 `resume-waiting.json`、`retained-provenance.json`）、以及「編輯舊 comment 不會更新 `createdAt`，因此永遠是過期的」這個操作 gotcha。
- `CLAUDE.md`：模組清單補 queue；維護原則補兩條 resume 不變量。

資訊來源：`src/github-queue.ts` 的 `RetainedWorktreeProvenance`、`parseResumeDecision`。

## 不做的事

- 不改任何原始碼。
- 不拆 `report.ts` / `prompt-budget.ts` 出獨立 module 文件。
- 不改 `AGENT_ORCHESTRATOR_*` 相容名稱的敘述（migration 另案）。
- 不宣稱 resume 已通過真實 E2E（至今未實跑）。
