# 測試與安全規則

本文件列出目前可驗證行為、部署檢查與安全邊界。

Worker 的 Pi 登入前置檢查必須在 Issue listing、claim 與 GitHub 寫入前完成。測試以假的 OAuth record 驗證缺少、損壞、到期與 refresh 存在的情況；不得刷新 token、呼叫模型或輸出憑證。離線 dry-run 不要求登入，本機檢查不能保證遠端 OAuth 有效性。

## 本專案驗證

```bash
npm test
```

### Harbor preflight 與 fake foundation

`bin/harbor-preflight` 是 read-only readiness check，只能檢查 Harbor／Docker／Pi／Codex binary、Docker daemon、固定 Harbor version 與 auth presence。它不得輸出 secret 或 auth file 內容，不得登入 Harbor Hub、pull image、啟動 container、執行 trial 或呼叫模型。測試以 temporary fake PATH binaries 與 fake Harbor-like artifacts 驗證，不依賴本機 Harbor、Docker、provider auth 或網路。

CLI 不接受任何參數；`--run`、`--trial`、`--upload` 或未知參數都必須在 checks 前 fail closed。`CODEX_HOME` 只檢查 `$CODEX_HOME/auth.json`；未設定時才 fallback 到 `$HOME/.codex/auth.json`。Pi auth directory 必須先通過 filesystem directory type check，不能把普通檔案當成 directory。

### Harbor Full dev-flow wrapper

`harbor_full_dev_flow.agent:FullDevFlowAgent` 是 evaluation-only thin wrapper。wheel
內嵌已 build 的 JS bundle 並做 SHA-256 驗證；container setup 只允許固定 nvm
`v0.40.2`、Node major `22` 與 `@earendil-works/pi-coding-agent@0.82.1`，可在
setup 階段下載，但不得使用 floating latest。apt/network/permissions 或 task
compatibility 不符合時，
必須在 model call 前 fail closed。既有 `.orchestrator/runs/` ledger 不得由 bridge
重定向，reward 不得回饋 agent，原始 prompt/auth/raw events 不得整包複製到 artifacts。

Fake artifact 必須帶 `source: "fake-fixture"`，不得渲染成官方 benchmark result。Telemetry normalizer 對缺失 token、cache、reward、cost 或 verifier evidence 使用 `null`；derived token 必須保存公式，不能以 0 代替。shared verifier 也不能被文件或 metadata 宣稱為 hidden tests。

此命令先執行兩套 TypeScript build，再用 Node.js test runner 跑 `dist/test/*.test.js`。測試目前涵蓋 routing floor、tier/model mapping（含 cycle 階梯與 tier 上限）、cycle 計數與最後一次修正的完整驗證、decision log 回流、`needs_spec` 出口與 spec 回寫、baseline 預檢、相同失敗熔斷、崩潰寫出 `failed` summary、prompt 預算截斷、dev-flow gating、報告渲染、test runner、公開 build-output evidence 的 argv/timeout/output cap/redaction/observe-blocking 與 cycle provenance、spec round-trip/lifecycle、測試命令驗證、Pi JSONL parsing、router zero-tools、JSON verdict aliases、無測試提示、linked worktree ledger，以及 queue 的 attempt claim ref、resume 決策解析、needs-human 報告渲染、retained worktree provenance 驗證、createdAt FIFO 選取、等待中的 resume 不被選取也不被寫入，已發布 PR 的 Issue 不可 resume、claim 後 resume 交付前提（過長決策、包含未 commit 變更的唯讀衝突比對與缺少 claimed SHA 的 fetch）、交付成功後的 worktree 回收與 ledger 搬移，以及事件壓縮的保留判準。Pi adapter 的 stream、spawn、timeout、close 與 bounded stderr/parser failure 也必須以正常 `Error` 收斂，不得由 stream callback 產生未捕捉例外。

## GitHub queue local checks

Use `DEV_FLOW_DRY_RUN=1`/`--dry-run` with a local JSON fixture in `DEV_FLOW_FAKE_ISSUES`; this path has no GitHub, remote branch, commit, or PR side effects. The worker requires `DEV_FLOW_ALLOWED_REPOS` and resolves only an already-existing checkout below `DEV_FLOW_WORKSPACE_ROOT` (default `/Users/skai.wu/side`). It claims one Issue under an atomic local single-writer poll lock (which preserves a well-formed same-host lock with a live owner PID regardless of age, immediately recovers a dead same-host PID, and uses the 30-minute age threshold for foreign-host, unverifiable, or malformed metadata while recording recovery), then uses an atomic GitHub ref creation as the cross-Mac claim before performing the `gh issue edit` label transition and recording a job ledger. The claim carries a validated default branch and SHA; the worker fetches and verifies that exact remote commit before creating the isolated worktree. On resume, after the claim and before any agent invocation, a missing claimed SHA is fetched into the local object database, and a temporary Git index compares the retained worktree snapshot (including uncommitted changes) with the claimed default-branch commit; conflicts stop with needs-human without changing the retained worktree. The checkout origin must match the allowlisted owner/repository. Verify `gh auth status` separately; an expired token means there is no real E2E claim.

`bin/dev-flow-onboard` is a separate, explicit operator command. It is the only supported way to add a repository to the installed worker allowlist: it verifies workspace containment, queue checkout path identity and a strict GitHub SSH origin before any write. Its `--dry-run` makes no GitHub, plist or launchd writes; normal execution creates only missing workflow labels, never mutates an Issue. LaunchAgent updates use a validated temporary plist plus atomic rename; reload/verification failure restores the old plist and attempts to reload it. GitHub labels are intentionally not rolled back because they are additive, harmless without an approved Issue, and make retries idempotent.

## 真實 E2E

單元測試使用 fake agent。要驗證登入、模型名稱、Pi CLI flags 與真實 reviewer output，需在一次性乾淨 Git repo 執行完整 handoff；目前文件不宣稱第一個真實 Issue-to-PR E2E 已通過。確認結果為：

```text
READY_FOR_MAIN · Tier <n> · <cycle>/<maxCycles> cycles
```

## 目標 repo 安全條件

- 啟動前 working tree 必須乾淨。
- 未追蹤或已修改的 `.agent/specs/` 不阻擋啟動，也不送入 reviewer diff；spec 可在交付時和程式碼一起版控。
- Agent 不得改變 baseline HEAD。
- Ledger 位於 `.orchestrator/`，加入 repo-local Git exclude。
- Implementer prompt 禁止 commit、push、reset、checkout。
- Reviewer 沒有 write/edit/bash tools。
- `ready_for_main` 只表示檢查通過；不代表已 commit 或部署。

## 人工 checkpoint bridge / Same-Issue Resume

當實作或 review 已產生需要保留的變更，而流程以 `needs_human` 或 runtime `failed` 停止時，人必須先確認保留的 worktree provenance，再建立 local checkpoint commit；接著由人選擇 narrow fix，最後執行 targeted follow-up review。這是手動的安全橋接。queue 的 Same-Issue Resume 同樣不會自動 commit、push 或 discard：它必須驗證 repository、Issue、attempt、授權 comment 與 retained provenance；worktree 即使 origin 與 branch 看起來正確也不能跳過 provenance 驗證。

`needs_spec`/`specGap` 應先澄清產品語意；乾淨 baseline 的 preflight 失敗應先修正環境或既有程式碼，兩者都不應建立 checkpoint。Queue Same-Issue Resume 只接受具 repository 寫入權限的協作者在上一 attempt 報告之後新增的 `/dev-flow resume narrow fix <說明>`，並重用驗證過的 retained provenance。provenance 遺失、損壞或 worktree 有無法解釋的變動就 fail closed，停在 needs-human 並附繁體中文診斷；自動 rebuild 與 cancel 不在此版範圍。Claim 後的 resume 交付前提檢查也會在任何 agent 之前以暫存 index 比對 retained 的未 commit 變更與 claimed default branch，缺少 claimed SHA 時先 fetch；過長決策或衝突都不修改 retained worktree。Resume 只容忍保留下來的 product-test 失敗；命令不存在、無法執行或其他環境錯誤仍在任何 agent 之前停止。

## 信任邊界

- Handoff 的 `tests` 是 shell command，僅可接受受信任來源。
- GitHub Issue body/title/labels/repository/comments are untrusted input. Resume decisions are authorized by the comment author's repository write permission, and the attempt number is read from a marker inside a comment: anyone able to comment can post a fake needs-human report and thereby make a pending legitimate decision look stale (a denial of service), but cannot make a stale decision look fresh, and the attempt recorded in the retained provenance must still match. The running-Issue stale scan has a separate trust boundary: it accepts only a claim comment authored by the currently authenticated worker identity whose marker (or pre-marker legacy format) matches the local `claim.json`; copying a public marker from another author is therefore not claim evidence. The scan uses comment age only for the reminder and never infers process liveness; it only adds `dev-flow-needs-human` and a distinct stale marker, without removing labels or touching retained state. Regression tests cover forged/replayed authors, legacy claims, missing/fresh claims, duplicate reminders, label preservation and isolated write failures. The approved spec parser rejects missing sections, unresolved items, and prose tests; raw tests still execute with `shell: true`, so `dev-flow-ready` is approval but not a sandbox. A bullet wrapped in a Markdown code span has the backticks stripped before it reaches the shell, and any command still containing a backtick is rejected: left in place it is a command substitution, so the shell would run the command and then execute its stdout as the next command — the test output of the repository under test would itself be executed, and the gate would pass or fail on whether that output happens to be runnable rather than on the exit code.
- Queue repository selection is code-enforced by the owner/repository allowlist, a `DEV_FLOW_WORKSPACE_ROOT` constrained to `/Users/skai.wu/side` or a descendant, realpath workspace-root containment, existing Git checkout check, and an `origin` URL matching the allowlisted owner/repository. Worktree and branch names are derived from issue number/title after normalization; the primary working tree is not cleaned or reset. The claimed default branch/ref and SHA are validated and passed as `git` argv values; fetch failure or SHA mismatch blocks agent invocation.
- Queue publication is code-gated on `ready_for_main` and successful deterministic tests/reviews. The branch is committed, then the Draft PR renderer accepts only a typed delivery payload containing approved spec fields, post-commit Git file/status and diff statistics, and structured outcome evidence; malformed or oversized delivery evidence is rendered and rejected before push. Raw report, Pi events, agent text, prompts and ledger content cannot reach the body; missing/malformed/unsuccessful evidence blocks publication. Allowed strings are escaped as plain text, URL autolinking is neutralized, and fields/lists/body are capped. Non-success before publication does not push. If PR creation or Issue writeback fails after push, the worker attempts to delete its remote branch; a failed cleanup is surfaced as `needs_human` and retained in the local queue ledger. Merge and deployment are not implemented.
- GitHub claim refs are attempt-based: one worker per Issue/attempt, with `dev-flow-resume` and a fresh authorized `/dev-flow resume narrow fix <instruction>` comment required for later attempts. Authorization reads `user.permissions.push` from the collaborator permission endpoint, falling back to the `write`/`maintain`/`admin` legacy strings; the string never carries `push`. Retained worktrees and queue ledgers require periodic human cleanup; missing or corrupt provenance fails closed and is never rebuilt automatically.
- GitHub 上給人閱讀的內容（Issue comment、needs-human 報告、PR title/body、recovery 指示）使用台灣繁體中文；label、command、verdict token、程式碼識別字與 **`Closes #<n>` 這類 GitHub 關鍵字**屬 machine-readable，一律保留英文。`Closes` 曾被誤翻成中文敘述，後果是 PR 被 merge 之後對應的 Issue 不會自動關閉。
- Spec tool 會拒絕明顯的自然語言測試敘述，但不等同 shell sandbox；approved spec 仍是受信任輸入。
- Implementer 有 bash 與寫檔能力；Pi 層的 tool allowlist 限制工具種類，但不是容器或 OS sandbox。
- `publicChecks` 是受信任的本機 operator configuration，但 runner 仍以直接 argv spawn、repo-relative cwd、timeout、stdout/stderr caps 與受限 diagnostics 限制執行；不使用 shell、不輸出完整環境、不讀 hidden verifier。Evidence artifact 只保存 sanitized bounded excerpts、diagnostic counts、cycle/phase、`failureKind`（task-outcome/execution）與 relative evidence refs。Baseline 的正常非零 exit/diagnostic 是 task-outcome observation；只有 spawn/timeout execution failure fail closed。Observe checks 不影響完成判斷；cycle blocking checks 只依 manifest 宣告的 task-outcome 結果進下一輪。
- `scope.include/exclude` 目前是 routing/review contract，沒有 deterministic path enforcement。
- Reviewer 讀取的 repo rules 目前只有目標 repo 根目錄 `CLAUDE.md`。

## Mac worker LaunchAgent 檢查

`deployment/dev-flow-worker.plist.example` 是目前 maintainer Mac worker pattern 的範例，不是 portable defaults；其中 `/Users/skai.wu/side`、`OWNER/REPOSITORY`、`tw.lifestay.dev-flow-worker` 與 `/tmp` logs 都必須依主機調整。範例每 300 秒 poll，單次最多處理一個 Issue。`npm install`、build 與測試不會自動安裝 LaunchAgent。

checkout 必須使用 `dev-flow` 這個 canonical 目錄名；舊的 `agent-orchestrator` checkout 可改名，或用 `ln -s /path/to/agent-orchestrator /path/to/dev-flow` 提供相容路徑。`agent-orchestrator` package 與 `AGENT_ORCHESTRATOR_*` 是待另行 migration 的 compatibility names。

安裝、health inspection、log inspection、reload 與 uninstall 都應使用目前使用者的 dynamic UID：

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

## Extension 部署檢查

1. `npm test` 通過。
2. `~/side/.pi/extensions/orchestrate.ts` 指向專案 extension。
3. Pi 執行 `/reload` 後啟動畫面列出 `orchestrate.ts`。
4. 自然語言可建立 approved spec，接著 `/dev` 能解析 session pointer 並啟動流程。
