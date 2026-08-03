# Pi Process Adapter

本文件說明 orchestrator 如何啟動 Pi、隔離角色權限並解析輸出。

## Invocation

每個 request 以新的 child process 執行：

```text
pi --mode json --model <model> --thinking <level>
   --session-dir <role-specific-dir> --no-extensions
   [--no-tools | --tools <allowlist>] <prompt>
```

預設 timeout 為 15 分鐘。Request 先保存為 `request.json`，Pi stdout 保存為 `events.jsonl`。

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

- `reviewerInstruction()`：verdict 選項、`needs_spec` 的使用時機與「不是 fail 的替代品」、候選答案的格式要求。
- `implementerInstruction()`：原有指示、scope 硬性條款（不重構、不改格式、不動無關檔案）、以及有 `decision_log` 時的增量修正與逐條回應要求。scope 條款是目前唯一的範圍漂移防線，偵測面的 scope judge 尚未實作。

## Context isolation

不同 role 永遠不重用 Pi session。Reviewer prompt 由 orchestrator 重新組合 immutable artifacts，不包含 implementer 的完整 conversation。這提供上下文隔離；它不是作業系統層的 sandbox，implementer 仍可在其工具權限與本機帳號權限內操作檔案。
