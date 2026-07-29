# Handoff 契約

本文件定義 CLI 與 Pi extension 傳入 orchestrator 的 JSON 格式。

## Schema

| 欄位 | 型別 | 必填 | 現況 |
|:---|:---|:---:|:---|
| `repo` | string | 是 | 目標 Git repo；執行時轉為絕對路徑 |
| `objective` | string | 是 | implementer 的主要目標 |
| `scope.include` | string[] | 是 | deterministic routing 與 reviewer 的允許範圍 |
| `scope.exclude` | string[] | 否 | 目前傳給 agent；orchestrator 未另做 path enforcement |
| `acceptanceCriteria` | string[] | 是 | reviewer 驗收依據 |
| `constraints` | string[] | 是 | 實作限制 |
| `tests` | string[] | 是 | 依序執行的 shell commands；空陣列時明確通知 reviewer |
| `riskNotes` | string[] | 是 | routing 風險輸入 |
| `delivery.mode` | `direct_main` | 是 | 目前唯一合法值 |
| `delivery.requireApproval` | boolean | 是 | 契約已保存；MVP 尚未執行 approval UI |

## 範例

```json
{
  "repo": "/Users/skai.wu/side/example",
  "objective": "修正單一模組的輸入驗證",
  "scope": {
    "include": ["src/input.ts", "src/input.test.ts"],
    "exclude": ["migrations/"]
  },
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

## 驗證行為

`src/handoff.ts` 會拒絕非 object、空的 `repo`/`objective`、錯誤的 string arrays，以及非 `direct_main` 的 delivery。它目前不檢查 repo 是否存在、scope path 是否真的受限，也不禁止任意 shell test command；handoff 應視為受信任的本機操作指令。
