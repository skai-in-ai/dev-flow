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
| 測試、Git 或部署操作 | `docs/rules/testing-and-safety.md` |

## 模組

- Routing：`src/routing.ts`、`src/models.ts`、`src/classifier-prompt.ts`
- Orchestration：`src/orchestrator.ts`、`src/test-runner.ts`、`src/policies/completion-policy.ts`、`src/decision-log.ts`
- Prompt 預算：`src/prompt-budget.ts`
- 執行報告：`src/report.ts`（決定性渲染，不得呼叫模型）
- dev-flow 入口：`src/dev-flow.ts`、`bin/dev-flow`
- Pi adapter：`src/adapters/pi/pi-process-adapter.ts`
- Spec contract：`src/spec.ts`
- Mobile entrypoint：`extensions/orchestrate.ts`

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

- 程式碼行為、tier/model 對照、handoff schema 或部署方式變更時，同步更新對應 `docs/`。
- Reviewer 與 implementer 不共用 session；不可弱化 read-only reviewer 的工具 allowlist。
- 動到 `toolsFor()`、`test-runner.ts` 的執行方式、或任何「這是 prompt 請求還是程式碼強制」的分野時，同步更新 README 的 Threat model。那一節逐項對應實際程式碼，漂掉就會變成會說謊的安全文件，比沒有更糟。
- README 的「成本」一節與 `src/models.ts` 的註解共用同一批實測數字。改動 `modelFor()`、`DEFAULT_MAX_TIER` 或重新量測成本時，兩處一起改，並註明量測日期與 run 數。公開的數字沒有出處就是行銷文案。
- MVP 停在 `ready_for_main`，不自動 commit 或 push。
- 輪次上限只允許出現在 `src/policies/completion-policy.ts`；`orchestrator.ts` 的失敗分支一律呼叫 `nextCycle`。
- `applyBudget` 不得原地改寫 `request.artifacts`；ledger 必須保留未截斷的原件。
- 任何提前結束的路徑都必須經過 `finish()`；runtime exception 也要先落地成 `failed` summary 再往外拋。
- 兩張流程圖各有分工，不要合併也不要互相複製：改分支條件或終局動 `docs/modules/orchestration.md` 的 flowchart，改 artifact 或角色動 `docs/architecture.md` 的 sequenceDiagram。
