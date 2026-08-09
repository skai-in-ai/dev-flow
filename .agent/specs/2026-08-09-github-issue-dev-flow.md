---
repo: "/Users/skai.wu/side/agent-orchestrator"
status: ready_for_main
title: "GitHub Issue 驅動的 dev-flow queue 與 Draft PR"
created_at: "2026-08-09T00:00:00+08:00"
---

# GitHub Issue 驅動的 dev-flow queue 與 Draft PR

## 目標
把目前由 Pi session 或本機 CLI 手動啟動的 dev-flow 擴充為 GitHub Issue queue：外部 ChatGPT 使用既有 GitHub 外掛讀取 repo、討論並建立 repo-aware spec Issue；只有人工加上 `dev-flow-ready` label 才視為核准。Mac worker 輪詢並原子 claim Issue，在隔離 Git worktree 執行既有 Luna-first orchestrator；成功後建立 `codex/` branch、commit、push 與 Draft PR，將可追蹤結果回寫 Issue，供 ChatGPT 後續 review PR。不得自動 merge 或部署。

## 背景與決策
GitHub 是跨 ChatGPT、手機與本機 coding agent 的穩定交接面，同時提供 spec、approval、queue、audit log 與 PR review。MVP 採 Mac 主動 polling，因此不依賴 inbound HTTP API，也不使用 `dev-flow.lifestay.tw` 觸發；該 hostname 保留未來狀態頁或 webhook。Mac 擁有 `~/side` repo、Pi 與 orchestrator，避免把主要開發位置反轉到 P14。macOS 排程提供 launchd 範例，不直接安裝。初始 implementer 必須沿用現有 Luna-first matrix；風險 tier 只影響 reviewer/final gate與允許的上限。

## 修改範圍
- src/
- bin/
- tests/ 或 src/test/
- docs/
- README.md
- package.json
- deployment/ 或 examples/ 中必要的 launchd/config 範例

## 排除範圍
- src/models.ts 的 Luna-first model matrix
- 現有 Pi extension 的 /dev-flow 使用方式
- 自動 merge
- 自動部署
- P14 部署
- Cloudflare Tunnel 設定
- 真實 GitHub Issue、label、branch 或 PR 寫入
- 使用任意絕對 repo path 或允許 ~/side 以外的 checkout

## 驗收條件
- 提供可由 launchd 週期執行的單次 poll worker；預設每次只 claim 一個 `dev-flow-ready` open Issue，避免同一台 Mac 並行修改與成本失控。
- GitHub 操作抽象成可測試 adapter；production adapter 使用 `gh` 的結構化 JSON 輸出與 argv 呼叫，不以 shell 字串拼接來自 Issue 的內容。
- 設定明確 allowlist：只處理允許的 GitHub owner/repositories，並只解析到指定 workspace root（預設概念為 `/Users/skai.wu/side`）內已存在的 Git repo；不得接受 Issue body 提供的任意本機路徑。
- Issue body 使用文件化、可機械解析的 approved spec 契約，至少包含 objective、scope include/exclude、acceptance criteria、tests、risks、unresolved items 與 max tier；unresolved items 非空、tests 不合法或格式不足時不得 claim 執行，改以可操作錯誤回報。
- `dev-flow-ready` 是人工核准邊界。claim 時先移除 ready 並加 `dev-flow-running`，留下含 worker/job identifier 的 comment；重複 poll 不得重複執行同一 Issue。
- 每個 job 建立獨立 worktree 與 `codex/issue-<number>-<slug>` branch，不能要求目標 repo 的主要工作目錄保持乾淨，也不能覆寫使用者本機修改；branch 名稱與 worktree path 必須由可信欄位決定並正規化。
- Worker 在 worktree 內保存 spec，呼叫現有 orchestrator/dev-flow 並尊重 Issue 的 max tier；implementer 仍依現有 Luna-first cycle matrix，不因 GitHub queue 改成固定 Terra。
- 只有 orchestrator 回傳 `ready_for_main` 且 deterministic tests/reviews 全部通過，worker 才能 stage 明確變更、commit、push 並建立 Draft PR；不得 merge。PR body 必須連回來源 Issue並包含 run/report 摘要。
- `needs_human`、`needs_clarification` 或 runtime failure 不得 push 可合併成果；以 comment 與明確 terminal label 回寫 Issue，保存足以人工診斷的 report 路徑或摘要。
- 成功後 Issue 移除 running、加上 `dev-flow-pr-ready`，comment Draft PR URL；失敗則移除 running、加上 `dev-flow-needs-human`。任何回寫步驟失敗都必須輸出非零狀態且留下本機 job ledger，不能靜默吞錯。
- 提供 `--dry-run` 或 fake adapter 測試路徑，測試不得對真實 GitHub、遠端 branch 或 PR 產生副作用。
- 提供 issue template/範例，讓 ChatGPT 能穩定建立正確格式的 Issue；文件清楚描述「ChatGPT 讀 repo → Issue + ready label → Mac worker → Luna-first dev-flow → Draft PR → ChatGPT review PR」。
- 提供 launchd plist 範例、必要環境變數、`gh auth`/權限需求、安裝與手動單次執行說明；本輪不直接載入 LaunchAgent。
- 更新 architecture、overview、testing/safety 與 README threat model，明確標示 Issue 內容是不受信任輸入、label 是 approval 但不是 sandbox、agent 仍有本機工具權限。
- 保持現有 CLI、Pi `/dev-flow`、routing、cycle、ledger 與測試行為相容。

## 測試要求
- `npm test`
- `git diff --check`

## 風險
- Blocker：目前 Mac 的 `gh auth status` 顯示 token 失效；只完成程式與 fake/dry-run 驗證，不得宣稱真實 GitHub E2E 或部署完成。
- Major：Issue body、title、labels 與 repo name 全是不受信任輸入，不得形成 shell injection、path traversal、任意測試命令或任意 repo checkout。
- Major：Issue 中 tests 最終會執行 shell command；只能在嚴格 allowlisted repo 與人工 `dev-flow-ready` approval 後執行，文件需揭露這是信任邊界而非 sandbox。
- Major：claim、crash recovery 與重複 poll 若不具 idempotency，可能造成雙重 agent 成本、重複 branch/PR 或互相覆寫。
- Major：push/PR 是新的外部副作用，只能發生在完整 ready_for_main gate 後；任何非成功終局不得 push。
- Major：worktree/branch 建立不得碰觸或清理使用者既有 working tree；不得使用 reset --hard、force push 或 merge。
- Minor：MVP polling 有最多一個排程週期的延遲，接受以換取架構簡單與不暴露 inbound API。
- Minor：`dev-flow.lifestay.tw` 已正確連到 Tunnel 並在無服務時回 502，但本 MVP 不使用該 hostname，不得為了消除 502 額外啟動未定義服務。

## 未決事項
無
