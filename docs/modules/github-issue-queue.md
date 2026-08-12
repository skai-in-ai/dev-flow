# GitHub Issue queue

本模組將 GitHub 當作 ChatGPT、人類 approval 與本機 coding agent 之間的穩定交接層。它是核心 orchestrator 外的可選 wrapper，不改變 Luna-first routing、deterministic tests 或 isolated review。

## 入口 A 完整流程

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

這是 README 所稱的**入口 A**。若你正在同一個 Pi／Remote Pi session 討論，成功後只需要 working-tree diff，不需要 Issue queue 或 Draft PR，應使用**入口 B**的 `/dev-flow`；見 [手機與 Pi 入口](mobile-entrypoint.md)。

## 使用時機

使用入口 A 的情況：

- 從手機或外部 ChatGPT 建立 durable task handoff。
- 多個任務要由本機 worker 排隊處理。
- 需要每個任務使用 isolated worktree／branch。
- 希望完整 gates 通過後自動得到 Draft PR。

不要為了單次、正在互動的本機修改繞 GitHub 一圈；那種情況使用入口 B 即可。

## Issue contract

GitHub 的 New Issue 頁面提供 **Dev-flow task** template，桌面與 mobile web 都可選取。它會建立一份從 `status: draft` 開始的 editable body；GitHub 只會移除 template metadata，因此 task frontmatter 會保留在 Issue body。既有 [example](../../examples/github-issue-template.md) 與 installed template 的 required sections 由 deterministic contract test 一起檢查。

Issue body 必須使用 `examples/github-issue-template.md`，並包含：

- frontmatter `status: approved`
- `max_tier: 0 | 1 | 2`
- Objective
- Background and decisions
- optional Invariants and non-goals (use `none` for ordinary tasks)
- Scope include / exclude
- Acceptance criteria
- raw executable Tests
- Risks
- Unresolved items

`Invariants and non-goals` 可省略以相容 legacy Issues；若存在則只描述合理、可到達的 invariant 類別與明確不做的範圍，不要求涵蓋每個理論 sibling。`Unresolved items` 必須是 `none`，或等價的空值表示；任何待答內容都會阻擋執行。Tests 是 raw、trusted shell commands，會直接以 shell 執行，因此加入 ready label 前必須像 review code 一樣 review spec。

Queue parser 的 fail-closed contract 僅是 deterministic 的：`status: approved`、每個 required section 的非空或合法 list 結構、已移除官方 `dev-flow-required` marker、空的 unresolved items，以及 raw executable test commands。它不會嘗試從任意 prose 推論語意完整度，也不維護 `TODO`、`later` 或其他詞彙 blacklist；語意審核屬於獨立的 Spec Gate，非本 queue parser 的責任。

Bullet 若整條被 Markdown code span 包住（`` - `npm test` ``），反引號會被剝掉後才交給 shell，與 CLI spec parser 的 `list()` 行為一致。剝除後仍含反引號的 test command 會被拒絕：那是 shell 的命令替換，實際效果是先跑該指令、再把它的 stdout 當指令執行，preflight 會變成在賭「測試輸出湊巧是不是可執行指令」而不是看 exit code。

### Mobile approval flow

1. 在 repository 的 **New issue** 頁面選 **Dev-flow task**，建立或繼續編輯 `status: draft` 的 body。
2. 移除每個官方 placeholder，填 required sections，將 `status` 改為 `approved`，並確認 Tests 命令與 `Unresolved items: none`。
3. 加入 `dev-flow-ready` 授權 queue 執行；這個 label 不會由 template 自動加入。draft、空 section、官方 placeholder 或未決項目都不會啟動 agent。

## Label lifecycle

| Label | 意義 |
|:---|:---|
| `dev-flow-ready` | 已授權 spec 進入 queue |
| `dev-flow-running` | Worker 已 claim，正在本機執行 |
| `dev-flow-pr-ready` | 已產生 Draft PR，等待 review |
| `dev-flow-needs-human` | spec、runtime、review、GitHub writeback 或 cleanup 需人工處理 |
| `dev-flow-resume` | 人工已核准下一個 resume attempt；仍需授權 comment |

Worker 只選 open 且帶 `dev-flow-ready` 或 `dev-flow-resume` 的 Issue，每次 poll 最多處理一個。不合法 Issue 會標記 needs-human，不會永久卡住後面的 queue。

## 新 repository onboarding

在建立第一張 Issue **前**，本機 operator 必須明示執行：

```bash
/path/to/dev-flow/bin/dev-flow-onboard /absolute/path/to/checkout
```

command 從嚴格的 `git@github.com:OWNER/REPOSITORY.git` origin 推導 repository，要求 checkout 位於 worker workspace root、是 Git worktree root，且 basename 是 queue 的 `<workspace>/<repo-name>` 解析路徑。它只建立缺少的五個 workflow labels，保留既有 label 屬性，將 repository 去重附加至已安裝 LaunchAgent 的 allowlist，然後 atomic 更新／reload／驗證。`--dry-run` 沒有 GitHub、plist 或 launchd 寫入。

這是人明示的本機信任擴張；worker 不會因 Issue 自行加 allowlist。onboarding 不建立或修改 Issue，尤其不會加入 `dev-flow-ready`。plist reload 失敗時會復原舊檔並嘗試重載，先前成功建立的 additive labels 保留，方便安全重試。

## 選取順序

跨 repository 以 Issue `createdAt` 遞增排序，取第一個。Issue 編號是 per-repository 的計數器，單以編號排序會讓新加入 allowlist 的 repository（從 #1 開始）永久插隊到既有 repository 前面。採 `createdAt` 而非 `updatedAt`，是為了讓編輯 Issue body 不會把它推到隊尾。時間戳完全相同時才以 repository 名稱與 Issue 編號打破平手（以 code unit 比較，不用 locale-dependent 的 `localeCompare`，否則不同機器的 worker 可能對同一個 queue 得出不同順序），確保選取是決定性的；時間戳缺漏或無法解析的 Issue 排在最後，不會靜默插隊。

已知近似：`createdAt` 是 Issue 建立時間，不是加上 `dev-flow-ready` 的時間。長期擱置後才核准的 Issue，會排在「較晚建立但立刻核准」的 Issue 前面。精確版本需查 label 事件時間（`gh api repos/{owner}/{repo}/issues/{n}/timeline`），成本高一個等級，目前刻意不做。

Resume 用同一條排序：`dev-flow-resume` 不會插隊，等待中的初次 Issue 也不會被它擠掉。

## Claim 與重複防護

1. Workspace 內以 atomic `mkdir` 作單 worker lock。
2. Lock 若有同 host 的有效 owner PID，會以 PID liveness 保持 active，即使超過 30 分鐘；dead PID 可立即恢復。foreign host、無法驗證 liveness 或 malformed metadata 才以 30 分鐘 age threshold fallback，恢復事件會寫入 ledger。
3. GitHub 上使用 Issue-specific Git ref creation 作 compare-and-set；claim 同時綁定 validated default branch 與 40-character SHA，只有一個 worker 能成功建立。
4. Claim 成功後才將 label 從 ready 轉為 running。Worktree 建立前只 fetch `origin` 的該 default branch，並驗證 fetched SHA 與 claim 完全一致；不會 merge 或修改 primary checkout。

Claim ref 建在該 Issue 所屬 repository 底下，名稱含 Issue number 與 attempt number（`refs/dev-flow-claims/issue-<n>-attempt-<k>`）並永久保留：同一 attempt 只能有一個 worker 建立成功，但完成的 attempt 不阻擋下一次 resume。

`needs_human` 會保留原 worktree、branch、partial code，並在 worktree 內寫下 `.orchestrator/queue-provenance.json`。要啟動下一個 attempt 必須同時滿足：

- Issue 帶 `dev-flow-resume` label
- 具 repository 寫入權限的協作者，在上一則 needs-human 報告之後新增 `/dev-flow resume narrow fix <說明>` comment
- retained worktree 通過 provenance 驗證（路徑、origin、branch、HEAD、working tree 狀態逐項相符）

授權判斷用 `repos/{owner}/{repo}/collaborators/{user}/permission`：以 `user.permissions.push` 這個 boolean 為準，字串 `permission` 只接受 `write`／`maintain`／`admin`。GitHub 這個字串欄位不會回傳 `push`，拿 `push` 去比會把一般 write 協作者全部誤拒。

Comment 的 `id` 也有同類陷阱：`gh issue view --json comments` 回的是 GraphQL node ID 字串（`IC_kwDO…`），不是 REST 的整數。決策的身分檢查因此接受非空字串或整數；只認整數會讓每一則真實 resume 指令都被判為不合法，`pendingResume` 永遠回 `undefined`，Issue 停在 needs-human 而 worker 每輪都回 `idle`——不會報錯，只是靜默不動。

帶 `dev-flow-resume` 但還沒有可執行決策的 Issue（沒有新 comment、決策過期、格式不合、留言者無寫入權限），會在**選取階段就被跳過**：不 claim、不留言、不改 label，只在本機 ledger 記一筆，並讓 poll 繼續往後找下一個可執行的 Issue。這一點是刻意的：等人回覆可能等好幾天，若每輪都貼一則報告，Issue 會每 300 秒被灌一則留言，而且因為它在 FIFO 最前面，後面排隊的 Issue 會被永久餓死。同樣地，不回應未授權的留言，也避免任何有留言權限的人驅動無上限的 Issue 寫入。

有了合法決策之後才會 claim。claim 成功後、任何 agent 呼叫前，resume 另外執行交付前提檢查：授權決策不得超過 512 個字元；若 retained worktree 的 baseline SHA 與 claim 的 default branch SHA 不同，先補 fetch 本機缺少的 claimed SHA，確認 baseline 是 claim SHA 的 ancestor，保留 retained worktree 現有的 Git index 狀態，再納入 unstaged 與 untracked 變更寫入暫存 Git index，計算落後 commit 數與未合併的衝突檔案。只有 fast-forward 且確認無衝突才繼續；歷史分歧、衝突或過長決策會貼出 needs-human 報告，不會修改 retained worktree，也不會呼叫 agent。落後但可自動合併時照常執行。

此後的失敗（provenance 遺失或損壞、worktree 有無法解釋的變動、attempt 對不上）會貼出**一則**needs-human 報告；因為決策必須晚於最新報告，這則新報告會讓剛才那個決策失效，Issue 回到等待狀態，不會反覆重試。這種在 claim 前就失敗的情況會一併移除 `dev-flow-resume`，由人連同新決策一起重新加上。

provenance 遺失、損壞、或 worktree 有無法由 provenance 解釋的變動時直接停在 needs-human，不重建、不捨棄、不 resume。自動 `rebuild` 與 `cancel` 不在此版範圍；要重建或放棄由人自己動手。

### queue-provenance.json

寫在 retained worktree 內的 `.orchestrator/queue-provenance.json`，每次非 `ready_for_main` 結束時覆寫。

| 欄位 | 用途 |
|:---|:---|
| `repository` / `issueNumber` / `branch` / `cwd` | 身分：這個現場屬於哪個 Issue |
| `baselineSha` | 記錄當下的 `HEAD`，resume 時逐字比對 |
| `status` | `git status --porcelain --untracked-files=all` 原文，resume 時逐字比對 |
| `attempt` / `recordedAt` | 產生這份快照的 attempt 與時間 |
| `previousOutcome` | 上一輪的 `RunOutcome`；缺少就拒絕 resume |
| `findings` / `attemptedFixes` / `testEvidence` | 交給下一個 attempt 的脈絡 |
| `changedFiles` / `failedVerification` / `costUsd` / `durationMs` | 給人看的報告內容 |

`status` 逐字比對是這裡最嚴格的一條：任何 provenance 沒記錄的變動都代表現場被外部動過，一律 fail closed。人若在 needs-human 之後手動改了那個 worktree（例如建 checkpoint commit），resume 就不會再接手，這是刻意的。

### 一個操作上的 gotcha

決策的時效只看 comment 的 `createdAt`，而 GitHub **編輯留言不會更新 `createdAt`**。把一則舊留言編輯成新決策沒有用，它永遠是過期的，必須開一則新留言。

理由是編輯後的留言無法分辨當初是不是寫在報告之前，採信它等於讓過期決策復活。

## Repo 與 worktree 邊界

Worker 不從 Issue body 接受絕對路徑。它將 `OWNER/REPOSITORY` 對應到 workspace root 下同名 checkout，然後驗證：

- repo 在 `DEV_FLOW_ALLOWED_REPOS` 中
- workspace root 未逃出 `/Users/skai.wu/side`
- claim 的 default branch 與 SHA 經驗證，fetch 後 worktree 固定從該 SHA 建立，不使用 local `HEAD`
- checkout `realpath` 未逃出 workspace root
- 目標是 Git worktree
- `origin` 的 owner/repository 與 allowlist 完全一致

每個 job 在以下位置建立獨立 worktree：

```text
<workspace>/.orchestrator/worktrees/<owner-repo>-<issue-number>/（owner/repository 先正規化為小寫）
```

分支命名：

```text
codex/issue-<number>-<normalized-title>
```

主 checkout 的 dirty working tree 不會被清理、reset 或覆寫。

worktree 的回收分兩種情況：

| 終局 | 處置 | 理由 |
|:---|:---|:---|
| Draft PR 建立成功 | **自動回收** | branch 已在遠端，worktree 只是副本 |
| `needs_human` | 保留 | 這正是「保留現場」的定義，變更只存在本機 |
| push 後 PR／writeback 失敗 | 保留 | 狀態不明，要人看 |

自動回收前先把 run ledger 從 worktree 內搬到 `queue-jobs/<job-id>/runs/archived/`，否則 `report.md`、`decisions.json`、`cycle-<n>.diff` 與 trace 會跟著消失。整個回收是 best-effort：失敗只記進 job ledger 的 `worktree-reclaim-error.txt`，不會把一次已經成功的交付變成 needs-human。

branch 不自動刪除。claim ref 也保留，它是 attempt 唯一性的依據。

## Publication gate

Core orchestrator 回傳 `ready_for_main` 之前，worker 不得 push。通過後會：

1. 合併 unstaged、staged 與 untracked 變更清單。
2. 只對明確清單 stage / commit，不接受 `../` 或絕對路徑。
3. 從 approved spec、`RunOutcome` 的 structured verification 與 post-commit Git metadata 建立 typed delivery payload；缺少、格式錯誤、測試失敗或 reviewer 非 pass 時在 push 前失敗。report、Pi events、agent output、prompts 與 ledger 不會進入 payload。
4. Push worker 建立的 `codex/issue-*` branch。
5. 建立 Draft PR，body 只渲染本次 attempt 編號與授權 resume 決策、Why、How（post-commit Git name/status 與 diff statistics）、approved scope、structured verification result 與 intentionally excluded；所有允許字串以 plain text escaped、逐欄及整體限制長度。它描述已 push 的交付狀態，不重複核心 report 的 pre-publication next step。Local report 與 ledger 只作 non-public traceability artifacts。
6. 將 Issue 轉為 `dev-flow-pr-ready`。

它不會將 PR 轉 ready、merge PR 或 deploy。

PR delivery boundary：PR renderer 沒有 arbitrary report、raw event、agent summary、prompt 或 ledger 參數；unknown payload fields 也不渲染。缺少或 malformed structured evidence、非成功測試或非 pass reviewer verdict 會阻擋 publication 並標記 `dev-flow-needs-human`。

## Failure semantics

- Spec validation failure：不執行 agent，Issue 轉 needs-human；若是 `needs_spec`，先澄清 spec，不需要 checkpoint。
- 乾淨 baseline 的 preflight 失敗：初次執行不執行 agent。resume 只容忍保留下來的 product-test 失敗；命令不存在、無法執行或其他環境錯誤仍然在呼叫任何 agent 前停止。
- Orchestrator 非 `ready_for_main`：不 push，Issue 轉 needs-human。只有在實作或 review 已產生要保留的變更、且需要人工修正時，才走下述 checkpoint bridge。
- Push 前 runtime failure：不會有遠端 publication。
- Push 後 PR/writeback failure：嘗試刪除 remote branch；刪除失敗時將錯誤寫入 ledger 並明確回報 needs-human。
- needs-human 報告貼出失敗時，會移除 `dev-flow-resume`，只保留 `dev-flow-needs-human`，避免沒有報告可供驗證時看似能 resume；若移除也失敗，錯誤會寫入 job ledger，poll 仍回傳 failed 而不拋出例外。
- 所有 Issue writeback failure 都以非零結束，不靜默假裝成功。

對於已保留實作或 review 變更的 needs-human report，recovery 是：確認 retained worktree provenance，由具 repository 寫入權限的協作者新增 `dev-flow-resume` 與新的 `/dev-flow resume narrow fix <說明>` comment；下一個 attempt 重用同一 worktree，不會自動 commit、push 或 discard。provenance 驗不過就 fail closed，停在 needs-human 並附繁體中文診斷。

下一個 attempt 若再次失敗，會更新同一個 Issue、保留同一個 worktree，並可再提供一次新的 resume 決策。

Local job ledger 預設在：

```text
<workspace>/.orchestrator/queue-jobs/<job-id>/
```

## 保留現場的清理

worktree、branch 與 job ledger 都不自動刪除，這讓 needs-human 可以保留現場，代價是它們會無限累積。2026-08-10 的實測：10 個保留的 worktree 共佔 **2.6 GB**。

體積幾乎全部來自 run ledger 內的 Pi 原始事件流。以其中一次 run 為例：

| 內容 | 大小 |
|:---|---:|
| `events.jsonl` 的 `message_update`（22,726 筆） | 297.7 MB |
| `message_end`（184 筆，資訊等價） | 0.9 MB |
| `report.md`、`summary.json`、`decisions.json`、各 cycle diff | 404 KB |

`message_update` 是串流的**累積快照**而非 delta，每筆都帶完整 message 物件，因此單一訊息的紀錄量隨長度呈平方成長。目前 `pi-process-adapter.ts` 原封不動保存整份 stdout，所以這些重複資料全部落地。這是已知問題，過濾與保留政策尚未實作。

清理前必須逐項確認，因為「保留現場」保護的正是這些東西：

| 檢查 | 指令 | 不通過的意義 |
|:---|:---|:---|
| 有無未 push 的 commit | `git -C <worktree> log @{u}..HEAD` | 只存在本機，刪了就沒了 |
| 有無未 commit 的變更 | `git -C <worktree> status --porcelain` | 這正是 needs-human 保留的現場；`.agent/specs/issue-N.md` 例外，那是 worker 寫入的 Issue 副本 |
| branch 是否已進 main | `git -C <worktree> branch -r --contains HEAD` | 未合併代表工作尚未交付 |

三項都通過才可清理。留下小型 artifact、刪掉整個 worktree：

```bash
cp <worktree>/.orchestrator/runs/*/report.md      <archive>/
cp <worktree>/.orchestrator/runs/*/summary.json   <archive>/
cp <worktree>/.orchestrator/runs/*/decisions.json <archive>/
cp <worktree>/.orchestrator/runs/*/*.diff         <archive>/

git -C <checkout> worktree remove <worktree>
git -C <checkout> worktree prune
```

`queue-jobs/` 很小（實測 10 個 job 共 204 KB），建議保留作稽核。claim ref 也保留：它是 attempt 唯一性的依據，刪掉會讓同一 attempt 可被重複 claim。

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
- 同一 Issue 可依 `dev-flow-resume`、新授權決策 comment 與 retained provenance 原地 resume；已 `ready_for_main`、已帶 `dev-flow-pr-ready` 或已有 Draft PR 的 Issue 不可再次 resume。
- 自動 `rebuild`／`cancel`、provenance 遺失後自動重建、跨 attempts 的累積 PR payload 與成本聚合都不在此版範圍。
- Draft PR 成功後的 worktree 會自動回收；needs-human 的 worktree、branch、claim ref 與 job ledger 不自動 garbage collect，見下方「保留現場的清理」。
- Worker 沒有 HTTP API 或 dashboard；`dev-flow.lifestay.tw` 不參與觸發。
- Worker 不 merge、不 deploy，不取代人類/ChatGPT PR review。
