# Agent Orchestrator

一套以 **LLM-as-a-Judge** 為核心的自動化開發流程：把 approved spec 交給隔離的 implementer、deterministic tests 與 reviewer，自動完成實作、審查、修正與結果整理。

它不是另一個 coding agent，而是 coding agents 上方的 workflow。專案目前是 experimental MVP，適合已有 Git repo、meaningful tests，且能由一份 spec 說清楚的中小型變更。

## 兩條入口

兩條入口共用同一套 core orchestrator，但任務來源與成功後的交付不同。

### 入口 A：Pi／Remote Pi／CLI → working-tree diff

適合你正在同一個 Pi session 討論，想把結論保存成 spec 並立刻在目前 repo 開發。

```text
Pi／Remote Pi session 討論
  → /dev-flow
  ├─ 資訊不足：保存 draft／needs_clarification → 回 session 補充
  └─ 資訊完整：保存 approved spec → core orchestrator
       ├─ ready_for_main：變更留在目前 working tree
       └─ needs_human：回到目前 session 處理
```

- `/dev-flow`：整理目前對話；完整才自動開始。
- `/dev`：已有 approved spec 時直接執行，不重新整理對話。
- `bin/dev-flow`、`--spec`、`--handoff`：相同路徑的 CLI 入口。
- 不會自動 commit、push、建立 PR、merge 或 deploy。

手機與 session pointer 細節見 [手機與 Pi 入口](docs/modules/mobile-entrypoint.md)。

### 入口 B：GitHub Issue queue → Draft PR

適合從手機或外部 ChatGPT 交辦、多任務排隊，並希望最後只在 GitHub review 成果。

```text
建立 Dev-flow task Issue
  → status: approved + dev-flow-ready
  → Mac worker claim
  → claimed remote SHA 建立 isolated worktree／branch
  → core orchestrator
  ├─ ready_for_main：commit + push + Draft PR
  └─ needs_human：Issue 留報告並保留 worktree
       → dev-flow-resume + 新的授權 comment
       → 同一 Issue／worktree 開始下一個 attempt
```

- Worker 只處理 allowlist repository。
- 每個 Issue 使用隔離 worktree 與 `codex/issue-*` branch。
- 完整 gates 通過後才 commit、push、建立 Draft PR。
- 不會自動 merge 或 deploy。

#### Resume 同一個 needs-human 任務

`needs_human` 後不必另開 Issue。確認 retained worktree 沒有不明變動後：

1. 由具 repository 寫入權限的協作者，在最新 needs-human 報告之後留言：

   ```text
   /dev-flow resume narrow fix <本次要修正的內容>
   ```

2. 加上 `dev-flow-resume` label。
3. Worker 驗證 comment、attempt claim、worktree path／origin／branch／HEAD／Git state，再從原進度繼續。

沒有新決策、權限不足或 provenance 不可信時不會執行 agent。Resume 不自動重建、丟棄 worktree 或接受 `rebuild`／`cancel` 指令。

完整的 labels、claim、resume、publication 與 launchd 設定見 [GitHub Issue queue](docs/modules/github-issue-queue.md)。

## 使用哪一條

| 情境 | 入口 |
|:---|:---|
| 正在 Pi／Remote Pi 討論，想立刻在目前 repo 開發 | A：`/dev-flow` |
| 已有 approved spec 或 handoff | A：`/dev` 或 CLI |
| 從手機／外部 ChatGPT 交辦，稍後只看 GitHub | B：Issue queue |
| 多任務排隊、需要隔離 branch 與 Draft PR | B：Issue queue |
| 新專案 0→1、需求仍在探索、沒有 meaningful tests | 先不要使用 orchestrator |

## 共用核心

```text
approved spec / handoff
  → baseline test preflight
  → deterministic risk floor + Luna classifier
  → isolated implementation
  → actual diff reclassification
  → deterministic tests
  → isolated review
  → fix / escalate / needs_spec
  → ready_for_main 或 needs_human
```

主要性質：

- 每個 role 使用新的 Pi session，reviewer 不共享 implementer 對話。
- `decisions.json` 保存跨 cycle findings 與 implementer responses。
- 測試結果由 shell exit code 決定，不由模型宣告。
- 最多三次修正、四次實作；相同失敗重複時提前熔斷。
- 預設 `max-tier 1`；Tier 2 才使用 Terra reviewer 與 Sol final review。
- 每次 run 在 `.orchestrator/runs/` 保存 diff、tests、routing、cost 與 `report.md`。

模型與流程細節見 [Orchestration](docs/modules/orchestration.md)、[Routing](docs/modules/routing.md) 與 [Architecture](docs/architecture.md)。

## 安裝

需求：Node.js、Pi Coding Agent CLI，以及可用的 Codex OAuth 登入。

```bash
git clone git@github.com:skai-in-ai/dev-flow.git
cd dev-flow
npm install
npm test
```

`npm install` 只建立 local `node_modules`，不會安裝或啟用 LaunchAgent。

## 快速開始

### Pi／Remote Pi

將 `extensions/orchestrate.ts` 連結到 Pi workspace 的 `.pi/extensions/`，執行 `/reload`，然後在同一個 session：

```text
先與 agent 討論需求
/dev-flow
```

### 已有 spec

```bash
/path/to/dev-flow/bin/dev-flow /absolute/path/to/spec.md
```

### 已有 handoff

```bash
npm run orchestrate -- --handoff /absolute/path/to/handoff.json
```

### GitHub Issue queue

```bash
export DEV_FLOW_ALLOWED_REPOS=OWNER/REPOSITORY
export DEV_FLOW_WORKSPACE_ROOT=/Users/skai.wu/side
export DEV_FLOW_MAX_TIER=1

/path/to/dev-flow/bin/dev-flow-worker
```

GitHub **Dev-flow task** template 會從 `status: draft` 開始；填完 required sections、移除官方 placeholders、改為 `approved`，再加上 `dev-flow-ready`。Mac 定期 poll 可使用 [launchd 範例](deployment/dev-flow-worker.plist.example)。

## 安全邊界

- Implementer 有 read/write/edit/bash；reviewer 只有 read/grep/find/ls。這是工具 allowlist，不是 OS sandbox。
- Approved spec 的 test commands 會由 shell 執行；approval 不是 sandbox，只能接受受信任來源。
- `scope.include/exclude` 是 prompt/review contract，沒有 deterministic path enforcement。
- GitHub queue 以 repository allowlist、workspace containment、origin match、remote SHA 與 atomic claim 保護 worktree 建立。
- Draft PR body 只接受 typed spec、Git 與 verification evidence；raw agent events、prompts、完整 report 與 ledger 不會發布。
- Core orchestrator 不 commit/push；只有入口 B 的 queue wrapper 在 gates 通過後發布 branch 與 Draft PR。
- 系統不提供 HTTP API、webhook、dashboard、自動 merge 或 deployment。

完整規則見 [Testing and safety](docs/rules/testing-and-safety.md) 與 [Threat model](docs/architecture.md#isolation-邊界)。

## 文件索引

| 主題 | 文件 |
|:---|:---|
| 定位、適用範圍與兩條入口 | [Overview](docs/overview.md) |
| Pi／Remote Pi／手機入口 | [Mobile entrypoint](docs/modules/mobile-entrypoint.md) |
| GitHub Issue queue、resume 與 launchd | [GitHub Issue queue](docs/modules/github-issue-queue.md) |
| Core retry／review 流程 | [Orchestration](docs/modules/orchestration.md) |
| Tier 與模型 routing | [Routing](docs/modules/routing.md) |
| Spec／handoff contracts | [Spec](docs/contracts/spec.md)、[Handoff](docs/contracts/handoff.md) |
| 架構與 artifacts | [Architecture](docs/architecture.md) |
| 測試與安全規則 | [Testing and safety](docs/rules/testing-and-safety.md) |

## License

[MIT](LICENSE)
