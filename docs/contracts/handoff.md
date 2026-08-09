# Handoff 契約

本文件定義 CLI 與 Pi extension 傳入 orchestrator 的 JSON 格式。

## Schema

| 欄位 | 型別 | 必填 | 現況 |
|:---|:---|:---:|:---|
| `repo` | string | 是 | 目標 Git repo；執行時轉為絕對路徑 |
| `objective` | string | 是 | implementer 的主要目標 |
| `scope.include` | string[] | 是 | deterministic routing 與 reviewer 的允許範圍 |
| `scope.exclude` | string[] | 否 | 目前傳給 agent；orchestrator 未另做 path enforcement |
| `invariantsAndNonGoals` | string[] | 否 | 宣告需保留的不變量與明確不做的範圍；普通任務填 `none`；legacy handoff 可省略 |
| `acceptanceCriteria` | string[] | 是 | reviewer 驗收依據 |
| `constraints` | string[] | 是 | 實作限制 |
| `tests` | string[] | 是 | 依序執行的 shell commands；空陣列時明確通知 reviewer |
| `riskNotes` | string[] | 是 | routing 風險輸入 |
| `delivery.mode` | `direct_main` | 是 | 目前唯一合法值 |
| `delivery.requireApproval` | boolean | 是 | 契約已保存；MVP 尚未執行 approval UI |

## 範例

```json
{
  "repo": "/path/to/workspace/example",
  "objective": "修正單一模組的輸入驗證",
  "scope": {
    "include": ["src/input.ts", "src/input.test.ts"],
    "exclude": ["migrations/"]
  },
  "invariantsAndNonGoals": ["Preserve existing input behavior", "Do not change migrations"],
  "acceptanceCriteria": ["無效輸入回傳明確錯誤", "既有測試通過"],
  "constraints": ["不得新增 dependency", "不得 commit 或 push"],
  "tests": ["npm test"],
  "riskNotes": [],
  "delivery": {
    "mode": "direct_main",
    "requireApproval": true
  }
}
```

## RunSource

`Orchestrator.run(handoff, onProgress, source)` 的第三個參數，不屬於 handoff JSON，由 CLI、Pi extension 或 GitHub queue 直接構造。

| 欄位 | 型別 | 用途 |
|:---|:---|:---|
| `specPath` / `specTitle` / `specMarkdown` | string | spec 入口的來源與快照；`specMarkdown` 會寫入 ledger，因為 spec 會被就地改寫 |
| `maxTier` | Tier | 操作者的成本上限，只能往下限制 |
| `allowRetainedChanges` | boolean | 放行非乾淨 working tree 與保留的 product-test 失敗；僅供 queue resume，且必須在 provenance 驗證通過後才設定 |
| `resume` | object | 上一個 attempt 的脈絡：`attempt`、`decision`、`decisionLog`、`findings`、`attemptedFixes`、`testEvidence` |

orchestrator 不驗證 `resume` 是否正當 —— 授權、時效與 provenance 都是呼叫端（queue）在此之前的責任。行為細節見 `docs/modules/orchestration.md` 的「Resume 入口」。

## 驗證行為

`src/handoff.ts` 會拒絕非 object、空的 `repo`/`objective`、錯誤的 string arrays，以及非 `direct_main` 的 delivery。它目前不檢查 repo 是否存在、scope path 是否真的受限，也不禁止任意 shell test command；handoff 應視為受信任的本機操作指令。
