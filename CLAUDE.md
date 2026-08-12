# Agent Orchestrator

以 Pi 子程序隔離 implement、review 與 final review，依風險自動選擇 Luna、Terra、Sol 的本機開發流程協調器。

## 技術棧

- Node.js、TypeScript、ES modules
- Pi Coding Agent CLI 0.82.x
- Node.js 內建 test runner
- Git working tree 與 `.orchestrator/` 本機 ledger

## 文件導航

| 任務 | 先讀 |
|:---|:---|
| 理解用途與目前邊界 | `docs/overview.md` |
| 修改整體流程或目錄 | `docs/architecture.md` |
| 建立、解析或更新討論 spec | `docs/contracts/spec.md` |
| 建立或驗證 handoff | `docs/contracts/handoff.md` |
| 修改 tier、風險規則或模型 | `docs/modules/routing.md` |
| 修改 retry、review 或完成條件；查完整流程圖 | `docs/modules/orchestration.md` |
| 修改 Pi invocation 或權限 | `docs/modules/pi-adapter.md` |
| 修改手機 `/orchestrate` 入口 | `docs/modules/mobile-entrypoint.md` |
| 評估加第二台 worker、併發與所有權問題 | `docs/multi-worker.md` |
| 修改 GitHub Issue queue、labels、worktree 或 Draft PR 發布 | `docs/modules/github-issue-queue.md` |
| 測試、Git 或部署操作 | `docs/rules/testing-and-safety.md` |

## 模組

- Routing：`src/routing.ts`、`src/models.ts`、`src/classifier-prompt.ts`
- Orchestration：`src/orchestrator.ts`、`src/test-runner.ts`、`src/policies/completion-policy.ts`、`src/decision-log.ts`
- Prompt 預算：`src/prompt-budget.ts`
- Ledger 保留：`src/ledger-retention.ts`、`src/compact-ledgers.ts`、`bin/compact-ledgers`
- 執行報告：`src/report.ts`（決定性渲染，不得呼叫模型）
- dev-flow 入口：`src/dev-flow.ts`、`bin/dev-flow`
- Pi adapter：`src/adapters/pi/pi-process-adapter.ts`
- Spec contract：`src/spec.ts`
- Mobile entrypoint：`extensions/orchestrate.ts`
- GitHub Issue queue：`src/github-queue.ts`、`src/github-queue-cli.ts`、`bin/dev-flow-worker`

## 驗證

```bash
npm test
```

完整真實流程需另備乾淨 Git repo 與 handoff，再執行：

```bash
npm run orchestrate -- --handoff /absolute/path/handoff.json
```

也可由已核准 spec 啟動：

```bash
npm run orchestrate -- --spec /absolute/path/spec.md
```

日常隨手分派（跑目前 repo `.agent/specs/` 最新一份已定案的 spec）：

```bash
bin/dev-flow            # 最新一份
bin/dev-flow spec.md    # 指定
```

spec 尚未定案（status 非 approved 或仍有未決事項）時不會啟動，改為印出待答問題。

tier 上限預設為 1（成本考量，見 `docs/modules/routing.md`）。動到金流或下單時：

```bash
bin/dev-flow --max-tier 2
```

## 維護原則

- 新 repository 只能由人明示執行 `bin/dev-flow-onboard /absolute/checkout` 納入 worker allowlist；command 會建立缺少 labels，但不得替任何 Issue 加上 `dev-flow-ready`。

- 程式碼行為、tier/model 對照、handoff schema 或部署方式變更時，同步更新對應 `docs/`。
- Reviewer 與 implementer 不共用 session；不可弱化 read-only reviewer 的工具 allowlist。
- 動到 `toolsFor()`、`test-runner.ts` 的執行方式、或任何「這是 prompt 請求還是程式碼強制」的分野時，同步更新兩份 README 的安全邊界。那一節逐項對應實際程式碼，漂掉就會變成會說謊的安全文件，比沒有更糟。
- 英文 `README.md` 與繁中 `README.zh-TW.md` 的流程、安全邊界與支援範圍必須同步；文案不必逐句直譯，但事實不得分岔。
- 核心 CLI/Pi orchestrator 停在 `ready_for_main`，不自動 commit 或 push。可選的 GitHub queue wrapper 只在同一套 gates 通過後發布隔離 branch 與 Draft PR，不 merge 或 deploy。
- 修改 queue labels、claim、failure recovery、worktree 或 publication 時，同步更新 `docs/modules/github-issue-queue.md`、README Threat model 與 `docs/rules/testing-and-safety.md`。
- Resume 的兩條不變量不得弱化：retained worktree 一定要通過 provenance 驗證才重用；尚未取得授權決策的 Issue 在選取階段就跳過，不 claim 也不寫入 GitHub。後者若破功，worker 會每輪 poll 重貼報告並卡住 FIFO 佇列。
- GitHub 上給人看的內容用台灣繁體中文，但 machine-readable token 一律保留英文，`Closes #<n>` 也算 —— 它被翻掉會讓 merge 後的 Issue 永遠不關。
- 輪次上限只允許出現在 `src/policies/completion-policy.ts`；`orchestrator.ts` 的失敗分支一律呼叫 `nextCycle`。
- `applyBudget` 不得原地改寫 `request.artifacts`；ledger 必須保留未截斷的原件。
- Pi 事件在落地前一律經 `compactPiEvents()`。原始 stdout 的 `message_update` 是累積快照而非 delta，直接保存會隨模型輸出長度呈平方成長（實測單一 implementer 315 MB）。清理工具與落地路徑共用同一個函式，不得各寫一套。
- 任何提前結束的路徑都必須經過 `finish()`；runtime exception 也要先落地成 `failed` summary 再往外拋。
- 兩張流程圖各有分工，不要合併也不要互相複製：改分支條件或終局動 `docs/modules/orchestration.md` 的 flowchart，改 artifact 或角色動 `docs/architecture.md` 的 sequenceDiagram。
- **確定性檢查一律排在最貴的步驟之前。** 新增任何「發布時才會用到」的限制（欄位長度、格式、前提狀態）時，同時把它加進 claim 後、呼叫 agent 前的前置檢查。否則失敗會發生在整輪工作跑完、付完錢之後（實例：resume 決策 597 字元超過 512 上限，在 `ready_for_main` 之後才於組 PR body 時炸掉）。preflight 對測試已經是這個形狀，新限制要跟上。
- **label 不得承諾系統兌現不了的狀態。** `dev-flow-resume` 表示系統可以接手，`dev-flow-running` 表示正在執行。任何會讓 label 與實際能力脫節的路徑都要有收斂：寫入失敗走 catch block 補償，process 被外力終止則必須在下一輪 poll 判斷（catch block 那時根本不會執行）。這兩類要分開想，同一套補償救不了兩者。
- **liveness 與授權判斷只信本機 ledger，不信 GitHub 任何欄位。** Issue body、title、comment 都是不可信輸入；以它們判斷「某個 worker 是否還活著」等於讓任何有留言權限的人回收別人執行中的工作。
- **新增的 gate 必須通得過乾淨 checkout。** worktree 沒有 `node_modules`、沒有 `.env`。測試指令寫成自帶安裝步驟（`npm ci && npm test`），不要假設環境已就緒。
