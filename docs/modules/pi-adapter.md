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

- `VERDICT: pass|fail|escalate`
- JSON `verdict` 的 `pass/approve/approved`
- JSON `verdict` 的 `fail/reject/rejected`
- JSON `verdict` 的 `escalate/escalated`

若無法解析 verdict，orchestrator 預設視為 fail，避免錯誤放行。

## Context isolation

不同 role 永遠不重用 Pi session。Reviewer prompt 由 orchestrator 重新組合 immutable artifacts，不包含 implementer 的完整 conversation。這提供上下文隔離；它不是作業系統層的 sandbox，implementer 仍可在其工具權限與本機帳號權限內操作檔案。
