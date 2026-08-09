# GitHub Issue queue

本模組將 GitHub 當作 ChatGPT、人類 approval 與本機 coding agent 之間的穩定交接層。它是核心 orchestrator 外的可選 wrapper，不改變 Luna-first routing、deterministic tests 或 isolated review。

## 這次新增的重點

```text
人在 ChatGPT 討論需求
  → ChatGPT 用既有 GitHub 工具讀 repo
  → 建立 repo-aware approved spec Issue
  → 人加上 dev-flow-ready（approval）
  → Mac worker poll / claim
  → 隔離 Git worktree 執行 Luna-first dev-flow
  → tests + reviewer + 必要的 final reviewer
  → ready_for_main
  → commit / push codex branch / Draft PR
  → ChatGPT 或人 review PR
```

重點是將各種責任分開：

- ChatGPT 負責讀 repo、討論與寫 spec，不直接取得本機 shell。
- `dev-flow-ready` 是人工核准邊界，不是 sandbox。
- Worker 負責 queue、本機 checkout 驗證、worktree 與外部寫入。
- Core orchestrator 仍只負責 implementation/tests/review，本身仍停在 `ready_for_main`。
- Draft PR 是自動化交付邊界；不自動 merge 或 deploy。

## Issue contract

Issue body 必須使用 `examples/github-issue-template.md`，並包含：

- frontmatter `status: approved`
- `max_tier: 0 | 1 | 2`
- Objective
- Background and decisions
- Scope include / exclude
- Acceptance criteria
- raw executable Tests
- Risks
- Unresolved items

`Unresolved items` 必須是 `none`，或等價的空值表示；任何待答內容都會阻擋執行。測試命令會以 shell 執行，因此加 label 前必須像 review code 一樣 review spec。

## Label lifecycle

| Label | 意義 |
|:---|:---|
| `dev-flow-ready` | 人工確認 spec 可執行，進入 queue |
| `dev-flow-running` | Worker 已 claim，正在本機執行 |
| `dev-flow-pr-ready` | 已產生 Draft PR，等待 review |
| `dev-flow-needs-human` | spec、runtime、review、GitHub writeback 或 cleanup 需人工處理 |

Worker 只選 open 且帶 `dev-flow-ready` 的 Issue，每次 poll 最多處理一個。不合法 Issue 會移除 ready、標記 needs-human，不會永久卡住後面的 queue。

## Claim 與重複防護

1. Workspace 內以 atomic `mkdir` 作單 worker lock。
2. Lock owner 不存在或超過 30 分鐘時可恢復，恢復事件會寫入 ledger。
3. GitHub 上使用 Issue-specific Git ref creation 作 compare-and-set；只有一個 worker 能成功建立。
4. Claim 成功後才將 label 從 ready 轉為 running。

目前 claim ref 會保留，所以同一 Issue 是 one-shot。若 needs-human 後要重跑，請以更新後 spec 建立新 Issue，不要只重新加 ready label。

## Repo 與 worktree 邊界

Worker 不從 Issue body 接受絕對路徑。它將 `OWNER/REPOSITORY` 對應到 workspace root 下同名 checkout，然後驗證：

- repo 在 `DEV_FLOW_ALLOWED_REPOS` 中
- workspace root 未逃出 `/Users/skai.wu/side`
- checkout `realpath` 未逃出 workspace root
- 目標是 Git worktree
- `origin` 的 owner/repository 與 allowlist 完全一致

每個 job 在以下位置建立獨立 worktree：

```text
<workspace>/.orchestrator/worktrees/<owner-repo>-<issue-number>/
```

分支命名：

```text
codex/issue-<number>-<normalized-title>
```

主 checkout 的 dirty working tree 不會被清理、reset 或覆寫。worktree 與 branch 目前不自動刪除，讓 needs-human 可保留現場；操作者確認不再需要後才手動清理。

## Publication gate

Core orchestrator 回傳 `ready_for_main` 之前，worker 不得 push。通過後會：

1. 讀取該 run 的 report；缺失或無法讀取時在 publication 前失敗。
2. 合併 unstaged、staged 與 untracked 變更清單。
3. 只對明確清單 stage / commit，不接受 `../` 或絕對路徑。
4. Push worker 建立的 `codex/issue-*` branch。
5. 建立 Draft PR，將 Job、Status、Run metadata 與完整（必要時截斷的）report 內容嵌入 PR body 的 `<details>` 區塊；PR body 不公開本機 report 或 workspace 路徑。
6. 將 Issue 轉為 `dev-flow-pr-ready`。

它不會將 PR 轉 ready、merge PR 或 deploy。

PR report 邊界：report 以 untrusted Markdown 處理，`</details>` closing tag 會被中和，並以 48 KiB UTF-8 conservative cap 限制嵌入內容（超過時顯示明確 truncation marker）。report 缺失或無法讀取會在 push/PR publication 前失敗並標記 `dev-flow-needs-human`，不會發布帶有本機路徑的 broken PR。

## Failure semantics

- Spec/repo validation failure：不執行 agent，Issue 轉 needs-human。
- Orchestrator 非 `ready_for_main`：不 push，Issue 轉 needs-human。
- Push 前 runtime failure：不會有遠端 publication。
- Push 後 PR/writeback failure：嘗試刪除 remote branch；刪除失敗時將錯誤寫入 ledger 並明確回報 needs-human。
- 所有 Issue writeback failure 都以非零結束，不靜默假裝成功。

Local job ledger 預設在：

```text
<workspace>/.orchestrator/queue-jobs/<job-id>/
```

## 設定與手動執行

```bash
export DEV_FLOW_ALLOWED_REPOS=OWNER/REPOSITORY[,OWNER/OTHER]
export DEV_FLOW_WORKSPACE_ROOT=/Users/skai.wu/side
export DEV_FLOW_MAX_TIER=1
export DEV_FLOW_QUEUE_LEDGER=/Users/skai.wu/side/.orchestrator/queue-jobs

bin/dev-flow-worker
```

`DEV_FLOW_ALLOWED_REPOS` 必填。`DEV_FLOW_MAX_TIER` 是操作者成本/風險上限，Issue 內 `max_tier` 只能再往下限制，不能突破環境上限。

## Dry run

Dry run 使用 local JSON fixture 與 fake adapter：

```bash
DEV_FLOW_ALLOWED_REPOS=OWNER/REPOSITORY \
DEV_FLOW_FAKE_ISSUES=/absolute/path/issues.json \
bin/dev-flow-worker --dry-run
```

它只驗證 queue CLI 可載入 fixture 並選擇 Issue，不會連 GitHub、建 worktree、執行 agent、commit、push 或建 PR。

## launchd

`deployment/dev-flow-worker.plist.example` 是 Mac 範例，預設每 300 秒單次 poll。啟用前：

1. 確認 `gh auth status`。
2. 將 `DEV_FLOW_ALLOWED_REPOS` 改為實際 allowlist。
3. 確認 `PATH` 含 Homebrew `node`、`npm`、`gh` 與 Pi CLI。
4. 審查 `DEV_FLOW_MAX_TIER`。
5. 複製 plist 到 `~/Library/LaunchAgents/`，再以 `launchctl bootstrap` 載入。

本 repo 不會在 install/build 過程自動載入 LaunchAgent。

## 目前限制

- Polling 有最多一個排程週期的延遲。
- 單次 poll 只處理一個 Issue。
- 同一 Issue 無法原地 rerun；需新 Issue。
- Worktree、claim ref 與 ledger 不自動 garbage collect。
- Worker 沒有 HTTP API 或 dashboard；`dev-flow.lifestay.tw` 不參與觸發。
- Worker 不 merge、不 deploy，不取代人類/ChatGPT PR review。
