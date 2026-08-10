---
status: approved
max_tier: 1
---

# Dev-flow task

## Objective

修正 `NodePiProcessRunner` 對 Pi JSON stdout/stderr 無限累加的執行期記憶體問題，使長輸出與累積式 `message_update` 不再觸發 V8 `RangeError: Invalid string length`，同時保留完成一次 agent run 所需的 assistant summary、review verdict、usage 與 compact trace。

## Background and decisions

- 2026-08-11，`WuSKai403/content-studio#10` 的 dev-flow Attempt 1 在 Cycle 2 崩潰。實際錯誤位於編譯後的 `dist/adapters/pi/pi-process-adapter.js`：
  ```
  RangeError: Invalid string length
      at Socket.<anonymous> (.../pi-process-adapter.js:11:56)
  ```
- 對應 source 是 `src/adapters/pi/pi-process-adapter.ts` 的 `stdout += x`／`stderr += x`。Pi 的 `message_update` 是累積快照，不是 delta；長回覆會讓 stdout 體積呈平方成長，最後超過 V8 單一字串上限。
- 現有 `compactPiEvents(result.stdout)` 只在 child process 關閉後執行。它能降低落盤 trace 大小，但無法降低 process 執行期間已累積在記憶體中的完整 stdout。
- crash 發生於 stream callback，queue 無法寫出 `summary.json`／`outcome.json` 或收斂 GitHub label，造成 Issue 留在 `dev-flow-running`，retained worktree 存在但後續 poll 永遠 idle。
- 修正應在讀取 stream 時就保持有界狀態；不得先保留完整 stdout，再於結束後壓縮。
- 既有角色隔離、timeout、Pi invocation、prompt budget、tools allowlist 與 compact trace 語意維持不變。
- 這張 Issue 只修 adapter 的串流與記憶體邊界；既有孤兒 job 的人工恢復另行處理。

## Implementation decision

採用「自訂有界 JSONL splitter + 逐行 canonical compaction + 直接寫入 trace」；不引入第三方 streaming library、不建立 raw stdout 暫存檔，也不做通用 event bus。

- `NodePiProcessRunner` 以 `for await ... of child.stdout` 消費 stream，使用 `TextDecoder` 的 streaming mode 處理 UTF-8 跨 chunk 邊界。
- splitter 只保留尚未遇到換行的 remainder；remainder 設定 4 MiB hard limit。超限即終止 child，回傳正常可捕捉的 adapter error。這是單一 JSONL record 上限，不是整次 run 的 stdout 上限。
- 從 `compactPiEvents()` 抽出並共用單行 primitive，例如 `compactPiEventLine(line)`；batch compaction 與 live stream 必須呼叫同一 primitive，禁止複製 allowlist。
- 每讀到完整一行便立即：解析終局 assistant/usage 狀態、套用 canonical compaction、將保留結果 append 到 `trace.jsonl`。寫入必須 await，讓 stdout consumption 自然形成 backpressure。
- 記憶體只保留：未完成行（最多 4 MiB）、最後 assistant text／usage，以及 64 KiB stderr tail。不得保留完整 events array、完整 stdout 或完整 stderr。
- 最後 assistant text 若超過 1 MiB，應以明確 adapter error fail closed；不得靜默截斷後仍讓 reviewer verdict 通過。
- stderr 使用固定 64 KiB tail buffer；截斷時加上 `[stderr truncated; showing last 65536 bytes]` 標記。
- stream、spawn、timeout、close 競爭由單一 settle/cleanup 路徑處理；任何 parser/write error 都先終止 child，再 reject 一次。
- 使用 Node 內建 API 即可；不新增 dependency、背景 worker thread、資料庫、raw spool file 或額外 daemon。

選擇這個方案的理由：它在 stream ingestion 當下就施加 backpressure 與 hard bounds，能真正修掉本次 crash；同時只新增一個小型 splitter 與單行 compaction primitive，比 Transform pipeline、外部 parser、raw file spool 或完整事件狀態機更容易測試與維護。

## Invariants and non-goals

- implementer、reviewer、final reviewer 仍各自啟動全新的 Pi process，不共用 session。
- `trace.jsonl` 仍只保存經既有 canonical compaction policy 篩選後的事件；不得重新落盤完整累積式 `message_update`。
- 成功 run 必須仍能決定性取得最後 assistant text、review verdict/findings 與最後 usage。
- 非零 exit、spawn error 與 timeout 必須維持可診斷且有界的錯誤資訊；不得把完整可能含大量輸出的 stderr 塞進 exception。
- 不修改模型 routing、tier、prompt、review policy、GitHub queue label 或 resume 語意。
- 不以單純提高 Node heap、提高字串上限或延後 compaction 作為修正。
- 不處理 `test-runner.ts` 的一般測試輸出 buffering；若調查發現同一 helper 可安全共用，只能提出後續 Issue，不擴張本次 patch。

## Scope include

- 重構 `NodePiProcessRunner`／必要的 Pi event parsing，使 stdout 在串流期間即被逐行解析、壓縮或保留必要的有界狀態。
- 對尚未形成完整 JSONL line 的尾端資料設定明確上限與錯誤行為，避免單一無換行 chunk 重新形成無界字串。
- 對 stderr 保留有界 tail 或等價診斷摘要，並在截斷時留下明確標記。
- 讓 adapter 在 child close 後不需要重新 materialize 完整原始 stdout，即可產生 compact `trace.jsonl`、assistant summary、review verdict/findings 與 usage。
- 保持 `PiProcessRunner` 可注入、可單元測試；若 contract 需要調整，同步更新所有 fake runners 與 tests。
- 新增 regression tests，模擬大量累積式 `message_update`、跨 chunk JSONL、超長無換行資料、stderr 截斷、timeout 與非零 exit。
- 更新 `docs/modules/pi-adapter.md`，說明執行期 memory bound、保留資料與截斷規則。
- 若 adapter contract 或 failure surface 有變動，同步更新 `docs/rules/testing-and-safety.md`；不變則不做無關文件改寫。

## Scope exclude

- 自動恢復或修改 `WuSKai403/content-studio#10` 的 labels、claim ref、ledger 或 retained worktree。
- 修改 GitHub Issue queue 的 stale-running recovery。
- 修改 Pi CLI 或上游 `message_update` 格式。
- 修改 ledger retention 的產品語意、保留期限或清理排程。
- 重構其他 child-process adapters 或測試執行器。
- 重新設計 orchestrator cycle/retry policy。

## Acceptance criteria

- `NodePiProcessRunner` 不再以 `stdout += chunk` 或任何等價方式保存完整 Pi stdout。
- 實作符合本 Issue 的 Implementation decision；除非有可重現的 Node API blocker，否則不得自行改成 raw stdout spool、第三方 parser 或完整事件陣列。
- 以可注入的小型上限執行 regression test 時，輸入遠超該上限的累積式 `message_update` 仍能完成，不拋出字串長度／buffer overflow，且保留資料量受上限約束。
- 多個 chunk 中被切開的 JSONL event 能正確重組；event boundary 不因 chunk boundary 改變。
- 成功 run 仍會產生 compact `trace.jsonl`，並正確回傳最後 assistant summary、review verdict/findings 與 usage。
- 大量 intermediate `message_update` 不會完整保存在記憶體或 trace；最終保留規則與 `compactPiEvents()` 的 canonical policy 一致，不另外維護一套會漂移的 event allowlist。
- 單一超長、沒有換行的 stdout record 會以明確、可測試且 fail-closed 的方式中止該 agent run，不會持續無界累積，也不會讓整個 worker 因 uncaught exception 終止。
- stderr 只保留有界診斷內容；被截斷時 exception/report 明確標示 truncation，且不改變 timeout／non-zero exit 的判斷。
- timeout 仍會終止 child process，並回報對應角色的 timeout error。
- spawn error、stream error、非零 exit 都會 reject/throw 正常 Error，沒有未捕捉的 stream callback exception。
- 現有 Pi adapter、ledger retention、orchestrator 與 GitHub queue tests 全部通過。
- 文件清楚區分「stream-time bounded retention」與「post-run ledger compaction」，不再宣稱僅靠落盤壓縮即可避免執行期記憶體爆炸。
- patch 保持 narrow；不改 queue labels、routing、prompt 或無關 child-process code。

## Tests

- npm ci && npm test
- npm ci && npm run build
- git diff --check

## Risks

- 若串流 parser 過早丟棄事件，可能遺失最後 assistant message 或 usage；tests 必須驗證它們跨 chunk 且位於大量 updates 之後仍可取得。
- 若重新實作一套 event compaction allowlist，會與 `compactPiEvents()` 漂移；設計必須共用 canonical policy 或抽取可串流共用的 primitive。
- 有界 stderr 可能隱藏錯誤開頭或結尾；截斷策略與標記必須明確且可測試。
- stream error、child error、close、timeout 可能競爭完成 Promise；實作必須只 settle 一次並清理 timer/listener。

## Unresolved items

none
