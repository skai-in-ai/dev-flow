# Pi Process Adapter

本文件說明 orchestrator 如何啟動 Pi、隔離角色權限並解析輸出。

## Invocation

每個 request 以新的 child process 執行：

```text
pi --mode json --model <model> --thinking <level>
   --session-dir <role-specific-dir> --no-extensions
   [--no-tools | --tools <allowlist>] <prompt>
```

adapter 預設 timeout 為 15 分鐘；orchestrator 的 implementer request 明確給 25 分鐘，讓多檔案修改與 deterministic tests 有足夠 wall time。router／reviewer 未覆寫時仍使用 15 分鐘。Request 先保存為 `request.json`；Pi stdout 不原樣落地，而是壓縮成 `trace.jsonl`（見下方「事件保留」）。

`AgentRunResult` **刻意不回傳原始 events**，只回傳 `sessionMetadata.tracePath` 指標。若把 events 放進 result，orchestrator 寫 ledger 時會把同一份資料再存一次：實測一次真實 run 因此佔用 527 MB，其中單一 implementer 的 JSON 有 100% 是重複的 events（`summary` 僅 1 KB）。

## 事件保留

Pi 的串流事件是**累積快照而非 delta**：一則長度 N 的訊息會被寫下 N 次「從頭到目前」的完整 message 物件，紀錄量隨訊息長度呈平方成長。實測一次 Tier 1 四輪 run，單一 implementer 的原始 stdout 有 315 MB，其中 297.7 MB 是 22,726 筆 `message_update`；同一批資訊在 184 筆 `message_end` 裡只佔 0.9 MB。

因此 `NodePiProcessRunner` 在 stdout 串流期間逐行解析，並以 `compactPiEventLine()`（`src/ledger-retention.ts`）即時壓縮；每行 await 直接 append 到 `trace.jsonl`，由 stream consumption 提供 backpressure，不會先累積完整 stdout 再落地。adapter 仍以同一套 canonical policy 寫成 `trace.jsonl`（注入的 fake runner 若只提供 stdout，才在 close 後使用 `compactPiEvents()` 作相容 fallback）：

| 處置 | 對象 |
|:---|:---|
| 丟棄 | `message_update`、`tool_execution_update` —— 純進度事件，資訊涵蓋於對應的 `*_end` |
| 保留骨架 | 其餘所有事件型別，含未知型別（只截斷不丟棄，避免 Pi 新增事件時靜默消失） |
| 剝除 | `content`、`result`、`thinking`、`text` 等內容欄位；字串一律截到 200 字 |
| 例外保留 | `toolResults` 的 `toolName` 與 `isError` —— 叫了哪些工具、有沒有失敗是結構不是內容 |

保留判準是「未來要分析什麼」：跑了幾個 turn、叫了哪些工具幾次、花多少 token、為什麼停。完整內容看 run 根目錄的 `decisions.json`、`cycle-<n>.diff`、`cycle-<n>-tests.json`，那些才是分析素材。

執行期保留有界：預設單一未完成 JSONL line 上限 4 MiB、stderr tail 上限 64 KiB、compact trace 上限 4 MiB；最後 assistant text 超過 1 MiB 會 fail-closed；可注入 `NodePiProcessRunner` limits 做測試。超長無換行 record 會 fail-closed 終止該 run；stderr 超限保留最後 64 KiB，並附 `[stderr truncated; showing last 65536 bytes]` 標記；trace 超限只在剩餘空間足夠時附 `trace_truncated` 事件，實際檔案絕不超過上限。assistant summary 與最後 usage 只保留必要的最新狀態，不保存完整 event array。這些是 stream-time bound，與既有 ledger 的 post-run `compactPiEvents()` 清理不同；後者只處理既有磁碟資料，不能回收執行期間已配置的 stdout 記憶體。

adapter 同時移除 Pi 自己寫在 session 目錄的對話紀錄（每個角色約 1 MB，內容與 trace 重疊），best-effort，清不掉不影響執行。

既有 ledger 用 `bin/compact-ledgers <root> [--apply]` 回收，與落地路徑共用同一個函式；預設只報告不改寫。2026-08-10 對 10 個保留 worktree 實跑：195 個檔案、2,440 MB → 3.2 MB。

## 工具權限

| Role | Pi tools |
|:---|:---|
| Router | `--no-tools` |
| Reviewer / final reviewer | `read,grep,find,ls` |
| Implementer | `read,write,edit,bash,grep,find,ls` |

Reviewer 雖在目標 repo cwd 執行，但沒有 write、edit 或 bash。所有角色另有 prompt 禁止 commit、push、reset、checkout 或修改 main。

## 輸出解析

Adapter 逐行解析 Pi JSONL，取最後一個 assistant `message_end` 的 text content。Reviewer verdict 支援：

- `VERDICT: pass|fail|escalate|needs_spec`
- JSON `verdict` 的 `pass/approve/approved`
- JSON `verdict` 的 `fail/reject/rejected`
- JSON `verdict` 的 `escalate/escalated`
- JSON `verdict` 的 `needs_spec/spec_gap/needs_clarification`（空格與連字號變體皆正規化）

若無法解析 verdict，orchestrator 預設視為 fail，避免錯誤放行。orchestrator 端採白名單：`pass` 以外一律走失敗路徑，新增 verdict 時預設不放行。

## Prompt 長度預算

`renderPrompt` 在組裝 artifacts 前套用 `applyBudget`（`src/prompt-budget.ts`）：先對每個 artifact 施加 `perArtifactChars`，總量仍超出時依比例再縮減。截斷處插入明確標記 `…[TRUNCATED — full content preserved in the run ledger]…`，保留頭尾兩端。

預設值 `{ perArtifactChars: 20_000, totalChars: 80_000 }` 是**保守猜測，待實測調整**，未對照任何模型的實際 context 上限。

關鍵不變量：`applyBudget` 只作用在算繪出的 prompt 字串，**不得原地改寫 `request.artifacts`**。`<sessionDir>/request.json` 保存的仍是未截斷的原件，事後才能查出 agent 當時實際看到的內容與完整素材的差異。reviewer 具備 read/grep 工具，看到截斷標記可自行撈取需要的部分。

## Prompt 指示

- `reviewerInstruction()`：verdict 選項、`needs_spec` 的使用時機與「不是 fail 的替代品」、候選答案的格式要求。它也要求 reviewer 尊重 handoff 宣告的不變量與非目標，並在同一輪合併同類 sibling finding；檢查只限已核准、合理且可達的路徑，不要求窮舉理論分支。
- `implementerInstruction()`：原有指示、scope 硬性條款（不重構、不改格式、不動無關檔案）、以及有 `decision_log` 時的增量修正與逐條回應要求。處理 finding 時，implementer 必須檢視同一個可達不變量類別中合理的 sibling case，並為相關情況補 regression test；不必嘗試每個理論 sibling。這些都是 prompt-only guidance，不是 deterministic scope enforcement。scope 條款是目前唯一的範圍漂移防線，偵測面的 scope judge 尚未實作。

## Context isolation

不同 role 永遠不重用 Pi session。Reviewer prompt 由 orchestrator 重新組合 immutable artifacts，不包含 implementer 的完整 conversation。這提供上下文隔離；它不是作業系統層的 sandbox，implementer 仍可在其工具權限與本機帳號權限內操作檔案。
