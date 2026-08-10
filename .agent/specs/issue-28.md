---
status: approved
max_tier: 1
---

## Objective

把所有「確定性、且只在發布階段才會用到」的前提檢查，從發布階段移到 claim 之後、呼叫任何 agent 之前，讓這類失敗發生在花錢之前，並在 retained worktree 的 base 已落後而會產生衝突時停下來問人，而不是跑完才發現交付不出去。

## Background and decisions

2026-08-10 連續兩次真實執行暴露同一個形狀的問題：確定性檢查排在最貴的步驟之後。

第一次：resume 決策字串長度沒有上限。`parseResumeDecision` 取 `/dev-flow resume ` 之後的整則留言當決策，`draftPullRequestBody` 把它逐字交給 `plain(payload.resumeDecision, MAX_DELIVERY_LIST_ITEM_LENGTH)`。當時那則留言 597 字元，超過 512。結果是 orchestrator 已回報 `ready_for_main`、實作已 commit、全部 gate 通過之後，才在組 PR body 時拋出 `delivery payload contains a missing or oversized field`，整輪工作無法交付。

第二次：retained worktree 的 baseline 是 `e8525e9`，而同日 main 已推進三個 commit，兩者都動過 `src/github-queue.ts` 與 `src/test/github-queue.test.ts`。resume 依設計不重建也不移動 worktree，因此實作是在舊 base 上完成的；衝突要到人工開 PR 時才被 GitHub 判定為 `CONFLICTING`。

既有的 preflight 已經對「測試」實踐了正確原則：乾淨 tree 上測試就紅，就不啟動 agent。本 Issue 是把同一個原則延伸到交付前提。

不採用「resume 前自動 rebase 或 merge」：retained worktree 的安全性建立在 `baselineSha` 與 `git status` 原文逐字比對上，rebase 會同時改掉兩者，等於在 resume 路徑開一個「系統可自行改寫保留現場」的洞；而且 rebase 自身可能衝突，屆時沒有人在場，由 agent 自動解衝突會在無 review 的情況下決定保留誰的程式碼。

不採用「只警告、照跑」：那保留了「付一輪錢才發現交付不出去」這個正是要消除的行為。

衝突偵測使用 `git merge-tree`，唯讀，不建立 commit、不動 working tree、不動 index。

## Invariants and non-goals

- 不改變 `pendingResume()` 的三項驗證（授權、時效、格式），也不改變 provenance 驗證的任何一條。
- 不修改、不 rebase、不 merge、不捨棄 retained worktree；新增的檢查全部唯讀。
- 不改變初次執行路徑的行為：初次執行的 worktree 本來就從剛 fetch 的 SHA 建立，落後檢查不適用。
- 不改變成功路徑：`ready_for_main` 之後的 commit、push、Draft PR 與 label 轉換維持原樣。
- 不新增自動重試。

## Scope include

- src/github-queue.ts
- src/test/github-queue.test.ts
- docs/modules/github-issue-queue.md

## Scope exclude

- Do not change the initial (non-resume) execution path
- Do not rebase, merge, or otherwise modify a retained worktree
- Do not change resume authorization, freshness, or provenance validation
- Do not touch the publication success path

## Acceptance criteria

- 新增一段在 claim 成功之後、呼叫 orchestrator 之前執行的檢查，只在 resume 路徑執行，全部為唯讀操作。
- 授權決策字串長度超過 `MAX_DELIVERY_LIST_ITEM_LENGTH` 時，該 attempt 不呼叫任何 agent，貼出 needs-human 報告，報告內含實際長度與上限。
- retained worktree 的 `baselineSha` 與本次 claim 的 default branch SHA 不同時，計算兩者之間的 commit 數與是否可自動合併；判定為會衝突時不呼叫任何 agent，貼出 needs-human 報告，報告內含落後的 commit 數與會衝突的檔案路徑清單。
- 判定為可自動合併（僅落後、無衝突）時照常執行，不阻斷。
- 上述兩種阻斷情況下，retained worktree 的 `HEAD` 與 `git status --porcelain --untracked-files=all` 與檢查前完全一致。
- 新增的測試在移除對應檢查後會失敗。
- `npm ci && npm test` 全數通過。

## Tests

- npm ci && npm test

## Risks

- 本次改動位於 claim 與 resume 路徑上，改壞會讓後續所有 Issue 都無法執行。驗收條件已要求既有測試全數通過，且不得改動 provenance 與授權驗證。
- `git merge-tree` 的輸出格式在不同 Git 版本間有差異，判定邏輯需以 exit code 或明確的衝突標記為準，不可依賴人類可讀文字的排版。
- 落後但可自動合併的情況仍可能在語意上過期（介面已改名但語法不衝突）。本 Issue 不處理語意過期，只處理語法衝突。

## Unresolved items

none
