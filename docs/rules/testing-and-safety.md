# 測試與安全規則

本文件列出目前可驗證行為、部署檢查與安全邊界。

## 本專案驗證

```bash
npm test
```

此命令先執行兩套 TypeScript build，再用 Node.js test runner 跑 `dist/test/*.test.js`。測試目前涵蓋 routing floor、tier/model mapping（含 cycle 階梯與 tier 上限）、cycle 計數與最後一次修正的完整驗證、decision log 回流、`needs_spec` 出口與 spec 回寫、baseline 預檢、相同失敗熔斷、崩潰寫出 `failed` summary、prompt 預算截斷、dev-flow gating、報告渲染、test runner、spec round-trip/lifecycle、測試命令驗證、Pi JSONL parsing、router zero-tools、JSON verdict aliases、無測試提示與 linked worktree ledger。

## GitHub queue local checks

Use `DEV_FLOW_DRY_RUN=1`/`--dry-run` with a local JSON fixture in `DEV_FLOW_FAKE_ISSUES`; this path has no GitHub, remote branch, commit, or PR side effects. The worker requires `DEV_FLOW_ALLOWED_REPOS` and resolves only an already-existing checkout below `DEV_FLOW_WORKSPACE_ROOT` (default `/Users/skai.wu/side`). It claims one Issue under an atomic local single-writer poll lock (which recovers an orphaned/dead or 30-minute-stale lock and records that recovery), then uses an atomic GitHub ref creation as the cross-Mac claim before performing the `gh issue edit` label transition and recording a job ledger. The checkout origin must match the allowlisted owner/repository. Verify `gh auth status` separately; an expired token means there is no real E2E claim.

## 真實 E2E

單元測試使用 fake agent。要驗證登入、模型名稱、Pi CLI flags 與真實 reviewer output，需在一次性乾淨 Git repo 執行完整 handoff，確認結果為：

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

## 信任邊界

- Handoff 的 `tests` 是 shell command，僅可接受受信任來源。
- GitHub Issue body/title/labels/repository are untrusted input. The approved spec parser rejects missing sections, unresolved items, and prose tests; raw tests still execute with `shell: true`, so `dev-flow-ready` is approval but not a sandbox.
- Queue repository selection is code-enforced by the owner/repository allowlist, a `DEV_FLOW_WORKSPACE_ROOT` constrained to `/Users/skai.wu/side` or a descendant, realpath workspace-root containment, existing Git checkout check, and an `origin` URL matching the allowlisted owner/repository. Worktree and branch names are derived from issue number/title after normalization; the primary working tree is not cleaned or reset.
- Queue publication is code-gated on `ready_for_main` and successful deterministic tests/reviews. The generated report must be readable before push/PR publication; its untrusted Markdown is embedded in the Draft PR body under a sanitized `<details>` wrapper, with local report/workspace paths redacted and a conservative 48 KiB UTF-8 report cap plus truncation marker. Non-success before publication does not push. If PR creation or Issue writeback fails after push, the worker attempts to delete its remote branch; a failed cleanup is surfaced as `needs_human` and retained in the local queue ledger. Merge and deployment are not implemented.
- GitHub claim refs make one Issue one-shot in the current MVP. Re-running requires a new Issue; retained worktrees and queue ledgers require periodic human cleanup after diagnosis.
- Spec tool 會拒絕明顯的自然語言測試敘述，但不等同 shell sandbox；approved spec 仍是受信任輸入。
- Implementer 有 bash 與寫檔能力；Pi 層的 tool allowlist 限制工具種類，但不是容器或 OS sandbox。
- `scope.include/exclude` 目前是 routing/review contract，沒有 deterministic path enforcement。
- Reviewer 讀取的 repo rules 目前只有目標 repo 根目錄 `CLAUDE.md`。

## Extension 部署檢查

1. `npm test` 通過。
2. `~/side/.pi/extensions/orchestrate.ts` 指向專案 extension。
3. Pi 執行 `/reload` 後啟動畫面列出 `orchestrate.ts`。
4. 自然語言可建立 approved spec，接著 `/dev` 能解析 session pointer 並啟動流程。
