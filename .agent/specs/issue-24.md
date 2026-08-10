---
status: approved
max_tier: 1
---

## Objective

當 needs-human 報告貼不出去時，不要讓 Issue 停在「看起來可以 resume、實際上永遠不會被處理」的狀態。

目前 `pollOnce` 的 catch block 會先加上 `dev-flow-needs-human` 與 `dev-flow-resume`，再貼報告。若貼報告這一步失敗（GitHub 暫時性錯誤、權限問題、rate limit），label 已經加上去了但 Issue 上沒有任何報告。

後果是靜默停滯：下一輪 poll 的 `pendingResume()` 找不到帶 attempt marker 的報告，回傳 `undefined`，於是這個 Issue 每輪都被跳過，永遠不會被處理，Issue 上也沒有任何訊息說明發生了什麼。人只看得到兩個 label 和一片安靜。

修法：貼報告失敗時，把 `dev-flow-resume` 移除，只留 `dev-flow-needs-human`。狀態語意變成「需要人工處理，且系統無法自行接手」，與實際情況相符。

## Background and decisions

`dev-flow-resume` 的意義是「這個現場可以由系統接手續跑」。而 `pendingResume()` 要求必須存在一則帶 `<!-- dev-flow-needs-human-attempt:N -->` marker 的報告才能算出 attempt 編號。報告不存在時，這個 label 就是一個永遠兌現不了的承諾。

不採用「重試貼報告」：writeback 失敗的原因通常不是重試能解決的，而且重試會讓一次失敗的 poll 佔用更久。也不採用「補一則簡化報告」：那需要第二次 GitHub 寫入，同樣可能失敗，只是把問題往後推一格。

移除 label 是最小且不可能再失敗的收斂方式；就算移除本身也失敗，結果不會比現在更糟（現況已經是靜默停滯）。

保留現場不受影響：worktree、branch 與 `queue-provenance.json` 都已在此之前寫好，人仍可自行加回 label 與決策來接手。

## Invariants and non-goals

- 不改變 `pendingResume()` 的三項驗證（授權、時效、格式），也不改變 provenance 驗證。
- 不改變成功路徑：Draft PR 建立成功後的 label 轉換與 worktree 回收維持原樣。
- 不新增重試機制，不新增 GitHub API 呼叫次數。
- 不處理 claim ref 的清理；claim ref 是 attempt 唯一性的依據，保留是刻意的。

## Scope include

- src/github-queue.ts
- src/test/github-queue.test.ts
- docs/modules/github-issue-queue.md

## Scope exclude

- Do not change the publication success path
- Do not add retries or extra GitHub API calls
- Do not touch resume authorization or provenance validation

## Acceptance criteria

- 貼 needs-human 報告失敗時，`dev-flow-resume` 會被移除，`dev-flow-needs-human` 保留
- 移除 label 本身若也失敗，`pollOnce` 仍回傳 `failed` 並在 job ledger 留下錯誤，不往外拋例外
- 貼報告成功時，label 行為與現況完全一致（可 resume 的情況仍帶 `dev-flow-resume`）
- 新增的測試在移除修正後會失敗
- npm test 全數通過

## Tests

- npm ci && npm test

## Risks

- catch block 內再做 GitHub 呼叫，本身也可能失敗；驗收條件已要求這條路徑不得往外拋例外
- 這段程式碼同時被初次執行與 resume 兩條路徑共用，改動需確認兩者的 label 結果都正確

## Unresolved items

none

