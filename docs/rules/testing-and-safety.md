# 測試與安全規則

本文件列出目前可驗證行為、部署檢查與安全邊界。

## 本專案驗證

```bash
npm test
```

此命令先執行兩套 TypeScript build，再用 Node.js test runner 跑 `dist/test/*.test.js`。測試目前涵蓋 routing floor、tier/model mapping（含 cycle 階梯與 tier 上限）、cycle 計數與最後一次修正的完整驗證、decision log 回流、`needs_spec` 出口與 spec 回寫、baseline 預檢、相同失敗熔斷、崩潰寫出 `failed` summary、prompt 預算截斷、dev-flow gating、報告渲染、test runner、spec round-trip/lifecycle、測試命令驗證、Pi JSONL parsing、router zero-tools、JSON verdict aliases、無測試提示與 linked worktree ledger。

## GitHub queue local checks

Use `DEV_FLOW_DRY_RUN=1`/`--dry-run` with a local JSON fixture in `DEV_FLOW_FAKE_ISSUES`; this path has no GitHub, remote branch, commit, or PR side effects. The worker requires `DEV_FLOW_ALLOWED_REPOS` and resolves only an already-existing checkout below `DEV_FLOW_WORKSPACE_ROOT` (default `/Users/skai.wu/side`). It claims one Issue under an atomic local single-writer poll lock (which preserves a well-formed same-host lock with a live owner PID regardless of age, immediately recovers a dead same-host PID, and uses the 30-minute age threshold for foreign-host, unverifiable, or malformed metadata while recording recovery), then uses an atomic GitHub ref creation as the cross-Mac claim before performing the `gh issue edit` label transition and recording a job ledger. The claim carries a validated default branch and SHA; the worker fetches and verifies that exact remote commit before creating the isolated worktree. The checkout origin must match the allowlisted owner/repository. Verify `gh auth status` separately; an expired token means there is no real E2E claim.

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

當實作或 review 已產生需要保留的變更，而流程以 `needs_human` 或 runtime `failed` 停止時，人必須先確認保留的 worktree provenance，再建立 local checkpoint commit；接著由人選擇 narrow fix，最後執行 targeted follow-up review。這是手動的安全橋接；queue 的 Same-Issue Resume 不會自動 commit、push 或 discard，必須驗證 repository、Issue、attempt、授權 comment 與 retained provenance；明確 `rebuild` 僅能在 retained path 缺失時重建，既有 worktree 即使 origin 與 branch 正確也不能跳過 provenance 驗證。

`needs_spec`/`specGap` 應先澄清產品語意；乾淨 baseline 的 preflight 失敗應先修正環境或既有程式碼，兩者都不應建立 checkpoint。Queue Same-Issue Resume 只接受具 repository 寫入權限協作者在上一 attempt 結束後新增的明確決策，並重用驗證過的 retained provenance；明確的 rebuild 只能在 retained path 缺失時恢復，既有或損壞的 worktree 若無法完成 provenance 驗證就 fail closed，cancel 則不呼叫 agent。

## 信任邊界

- Handoff 的 `tests` 是 shell command，僅可接受受信任來源。
- GitHub Issue body/title/labels/repository are untrusted input. The approved spec parser rejects missing sections, unresolved items, and prose tests; raw tests still execute with `shell: true`, so `dev-flow-ready` is approval but not a sandbox.
- Queue repository selection is code-enforced by the owner/repository allowlist, a `DEV_FLOW_WORKSPACE_ROOT` constrained to `/Users/skai.wu/side` or a descendant, realpath workspace-root containment, existing Git checkout check, and an `origin` URL matching the allowlisted owner/repository. Worktree and branch names are derived from issue number/title after normalization; the primary working tree is not cleaned or reset. The claimed default branch/ref and SHA are validated and passed as `git` argv values; fetch failure or SHA mismatch blocks agent invocation.
- Queue publication is code-gated on `ready_for_main` and successful deterministic tests/reviews. The branch is committed, then the Draft PR renderer accepts only a typed delivery payload containing approved spec fields, post-commit Git file/status and diff statistics, and structured outcome evidence; malformed or oversized delivery evidence is rendered and rejected before push. Raw report, Pi events, agent text, prompts and ledger content cannot reach the body; missing/malformed/unsuccessful evidence blocks publication. Allowed strings are escaped as plain text, URL autolinking is neutralized, and fields/lists/body are capped. Non-success before publication does not push. If PR creation or Issue writeback fails after push, the worker attempts to delete its remote branch; a failed cleanup is surfaced as `needs_human` and retained in the local queue ledger. Merge and deployment are not implemented.
- GitHub claim refs are attempt-based: one worker per Issue/attempt, with `dev-flow-resume` and a fresh authorized `/dev-flow resume <decision>` comment required for later attempts. Retained worktrees and queue ledgers require periodic human cleanup; missing or corrupt provenance fails closed.
- Spec tool 會拒絕明顯的自然語言測試敘述，但不等同 shell sandbox；approved spec 仍是受信任輸入。
- Implementer 有 bash 與寫檔能力；Pi 層的 tool allowlist 限制工具種類，但不是容器或 OS sandbox。
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
