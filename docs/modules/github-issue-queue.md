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

1. 合併 unstaged、staged 與 untracked 變更清單。
2. 只對明確清單 stage / commit，不接受 `../` 或絕對路徑。
3. Push worker 建立的 `codex/issue-*` branch。
4. 建立 Draft PR，連回 Issue 與 run/report。
5. 將 Issue 轉為 `dev-flow-pr-ready`。

它不會將 PR 轉 ready、merge PR 或 deploy。

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

Worker 以 repository 的 canonical name 尋找 checkout，因此 checkout 目錄必須叫 `dev-flow`。例如：

```bash
git clone git@github.com:skai-in-ai/dev-flow.git /path/to/dev-flow
cd /path/to/dev-flow
npm install
```

若既有 checkout 仍叫 `agent-orchestrator`，請優先將目錄改名為 `dev-flow`；不能改名時，可在 workspace root 建立安全的相容 symlink：

```bash
ln -s /path/to/agent-orchestrator /path/to/dev-flow
```

`agent-orchestrator` package 名稱與 `AGENT_ORCHESTRATOR_*` 環境變數是目前的 compatibility names，待另行 migration；本次文件更新不改動它們。

```bash
export DEV_FLOW_ALLOWED_REPOS=OWNER/REPOSITORY[,OWNER/OTHER]
export DEV_FLOW_WORKSPACE_ROOT=/Users/skai.wu/side
export DEV_FLOW_MAX_TIER=1
export DEV_FLOW_QUEUE_LEDGER=/Users/skai.wu/side/.orchestrator/queue-jobs

/path/to/dev-flow/bin/dev-flow-worker
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

`deployment/dev-flow-worker.plist.example` 是 Mac 範例，預設每 300 秒 poll 一次，每次 poll 最多處理一個 Issue。啟用前：

1. 確認 `gh auth status`。
2. 將 `DEV_FLOW_ALLOWED_REPOS` 改為實際 allowlist。
3. 確認 `PATH` 含 Homebrew `node`、`npm`、`gh` 與 Pi CLI。
4. 審查 `DEV_FLOW_MAX_TIER`。
5. 確認 plist 的 `/path/to/dev-flow` checkout 路徑與同名目錄要求。

以下命令可安裝、bootstrap、檢查 health、查看 logs、reload 與移除；`id -u` 使用目前使用者的 dynamic UID：

```bash
mkdir -p ~/Library/LaunchAgents
cp /path/to/dev-flow/deployment/dev-flow-worker.plist.example ~/Library/LaunchAgents/tw.lifestay.dev-flow-worker.plist
launchctl bootstrap gui/"$(id -u)" ~/Library/LaunchAgents/tw.lifestay.dev-flow-worker.plist
launchctl print gui/"$(id -u)"/tw.lifestay.dev-flow-worker
tail -n 50 /tmp/dev-flow-worker.out
tail -n 50 /tmp/dev-flow-worker.err
launchctl kickstart -k gui/"$(id -u)"/tw.lifestay.dev-flow-worker
launchctl bootout gui/"$(id -u)"/tw.lifestay.dev-flow-worker
rm ~/Library/LaunchAgents/tw.lifestay.dev-flow-worker.plist
```

上例的 `tw.lifestay.dev-flow-worker`、`/Users/skai.wu/side`、`OWNER/REPOSITORY` 與 `/tmp` log 路徑是目前 maintainer Mac instance 的部署範例，不是可攜的預設值；請依實際主機調整。`npm install`、build 或測試不會自動安裝 LaunchAgent。

## 目前限制

- Polling 有最多一個排程週期的延遲。
- 單次 poll 只處理一個 Issue。
- 同一 Issue 無法原地 rerun；需新 Issue。
- Worktree、claim ref 與 ledger 不自動 garbage collect。
- Worker 沒有 HTTP API 或 dashboard；`dev-flow.lifestay.tw` 不參與觸發。
- Worker 不 merge、不 deploy，不取代人類/ChatGPT PR review。
