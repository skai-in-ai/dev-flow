---
status: approved
max_tier: 1
---

## Objective

掛著 `dev-flow-running` 超過門檻時間的 Issue，貼一則留言並加上 `dev-flow-needs-human`，讓人知道它需要處理。只標記，不回收、不改授權 label、不碰保留現場。

## Background and decisions

worker 被外力終止（SIGTERM、當機、關機）後，Issue 會永久停在 `dev-flow-running`：選取階段排除該 label，而 `pendingResume()` 需要一則帶 attempt marker 的報告才算得出 attempt 編號，兩條路都不通。2026-08-10 實際發生過一次，只能人工刪 claim ref、移除 worktree 與 branch、改回 label。卡住的 Issue 不阻塞佇列（選取直接跳過），但也不會有任何訊息告訴人。

Issue #29 嘗試自動回收，跑滿 4 cycles 停在 needs-human，15 條 findings（3 條 High）指向同一個根本問題：GitHub label 與本機 ledger 是兩個獨立儲存、分兩次寫入，中間必然有窗口；PID 這個存活訊號無法跨主機驗證，且會被作業系統回收再利用。任何據此改變狀態的邏輯，都可能把一個仍在執行的 worker 手上的 Issue 收走，導致同一份工作跑兩次與互相衝突的 branch，比原本卡住嚴重。該做法已放棄。

本 Issue 改為只標記不回收。這樣不需要判斷任何 process 的死活：不需要 PID、不需要跨主機比對、不需要本機 ledger，因此上述整族問題都不成立。誤判的唯一後果是一則誤報留言與一個多餘的 label，被誤判的 worker 不受影響，仍會照常跑完並設定自己的 label。

時間來源使用 claim 時已經貼出的那則 worker claim 留言的 `createdAt`。這是 GitHub 端的不可信輸入，但本判斷不是授權決策：授權與 liveness 仍然只信本機資料，而標記只影響可見性，誤報成本為零。改用 label 事件 timeline 可以更精確，但每個 running Issue 多一次 API 呼叫，不值得。

門檻預設 4 小時。實測單次執行為 36 分鐘（Tier 1、4 cycles），Tier 2 加上重試可能更久，4 小時遠高於任何正常執行，同時能讓人當天發現。

## Invariants and non-goals

- 不移除、不還原、不變更任何授權 label（`dev-flow-ready`、`dev-flow-resume`）。
- 不移除 `dev-flow-running`。
- 不修改、不刪除 worktree、branch 或 claim ref。
- 不改變選取順序、claim、resume 授權或 provenance 驗證的任何行為。
- 標記留言不得使用 needs-human 報告的 attempt marker，也不得產生任何可被 `pendingResume()` 解讀為報告或決策的內容。
- 不新增 label 種類。

## Scope include

- src/github-queue.ts
- src/test/github-queue.test.ts
- docs/modules/github-issue-queue.md

## Scope exclude

- Do not reclaim, restore, or remove any label other than adding `dev-flow-needs-human`
- Do not touch worktrees, branches, or claim refs
- Do not infer process liveness by any means
- Do not change selection, claim, or resume behavior

## Acceptance criteria

- poll 時檢查 allowlist 內帶 `dev-flow-running` 的 open Issue，對於最新一則 worker claim 留言的 `createdAt` 距今超過門檻者，貼一則標記留言並加上 `dev-flow-needs-human`。
- 標記留言帶有專屬 marker，且該 marker 與 needs-human 報告的 attempt marker 不同；`pendingResume()` 對只有標記留言的 Issue 仍回傳 undefined。
- 同一個 Issue 已存在標記留言時不再重複貼，重複 poll 不產生第二則留言。
- 未超過門檻、或找不到 worker claim 留言時，不貼留言也不加 label。
- 標記前後，該 Issue 的其他 label 完全一致；不呼叫任何移除 label 的操作。
- 門檻可由環境變數設定，預設 4 小時；未設定或設定值不合法時使用預設。
- 標記行為不影響同一輪 poll 的 Issue 選取與執行結果。
- 新增的測試在移除標記邏輯後會失敗。
- `npm ci && npm test` 全數通過。

## Tests

- npm ci && npm test

## Risks

- 真正跑超過門檻的執行會被誤標。後果僅為一則留言與一個多餘 label，該次執行仍會正常完成並設定自己的 label；驗收條件已要求不得移除或變更任何既有 label。
- 標記留言若被誤設為 needs-human 報告格式，會讓 `pendingResume()` 誤認為存在可 resume 的報告。驗收條件已明確要求 marker 必須不同，並要求驗證 `pendingResume()` 的行為。
- 每輪 poll 多一次 `gh issue list`；running Issue 通常為零或一個，成本可忽略。

## Unresolved items

none
