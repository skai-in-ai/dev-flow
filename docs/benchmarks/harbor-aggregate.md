# 離線 Harbor 結果聚合

`bin/harbor-aggregate` 只讀既有 Harbor trial artifact；它不啟動 Harbor、Docker、模型，也不需要網路。輸出是 `benchmark-aggregate-1` JSON，按 harness 彙總：

- 通過／失敗／未知與 success rate（有未知結果時 success rate 保持 `null`）
- wall time、cycles、stop reason
- input／uncached／cache read／cache write／output tokens 與 cache hit rate
- `estimatedCostUsd` 與 `actualCostUsd` 分開；缺值是 `null`，不當成 0
- configuration、infrastructure、model、verifier、task failure taxonomy，以及被排除的 trial

最小用法：

```bash
/Users/skai.wu/side/agent-orchestrator/bin/harbor-aggregate \
  /private/tmp/harbor-first-formal-comparison/prove-plus-comm-codex-formal-1/prove-plus-comm__3Sx5V2F \
  /private/tmp/harbor-first-formal-comparison/prove-plus-comm-single-pi-formal-3/prove-plus-comm__Tp7Zrnn \
  /private/tmp/harbor-first-formal-comparison/prove-plus-comm-full-dev-flow-formal-3/prove-plus-comm__4gt5JxD \
  > /private/tmp/harbor-aggregate.json
```

若要保存人工排除理由與 operator 核對的估算成本，使用版本化 run manifest：

```bash
HARBOR_FIRST_FORMAL_COMPARISON_ROOT=/private/tmp/harbor-first-formal-comparison \
/Users/skai.wu/side/agent-orchestrator/bin/harbor-aggregate \
  --manifest /Users/skai.wu/side/agent-orchestrator/config/harbor/harbor-prove-plus-comm-first-manifest.json \
  > /private/tmp/harbor-aggregate.json
```

manifest 的 `artifacts[].path` 必須是相對路徑，預設相對於 manifest 所在目錄解析；若指定
`artifactRoot`，它是相對 manifest 的 operator-local 目錄，或是
`{"env":"UPPERCASE_ENV_NAME"}`。環境變數只提供 artifact 根目錄，不會被輸出或讀取成
credential。每筆 entry 必須明確寫出 `includeInComparison`、`failureCategory`、
`invalidReason`、`estimatedCostUsd` 與 `actualCostUsd`；被排除的 entry 必須有合法分類與理由，
納入的 entry 則兩者都必須是 `null`。未知欄位、錯誤型別、未知分類、路徑逃逸與重複 artifact
都會 fail closed。範例 manifest 見
`config/harbor/harbor-prove-plus-comm-first-manifest.json`；它用環境變數避免把本機的
`/private/tmp` 寫進可提交設定。

訂閱制或 catalog 成本不是帳單證據。若已有人工核對的 pricing／billing ledger，應在程式 API 使用 `readHarborArtifactDirectory(path, { estimatedCostUsd, actualCostUsd })`；覆寫值會在 telemetry warning 留下來源，且 actual 仍與 estimated 分開。沒有此證據時，直接報告 `null`，不要把 Harbor `agent_result.cost_usd` 自動宣稱為實際支出。

被排除的 artifact 使用 `includeInComparison: false`、`failureCategory` 與 `invalidReason` 明確標記；它們保留在 `trials`，但不進 success rate、成本或 token 聚合。Full dev-flow 若只有 implementer／reviewer token，輸出會保留其 partial/lower-bound warning，不會補 router token 或將缺值設為 0。

這個工具只提供第一層數據整理。五題 smoke 完成前不要據此宣稱穩定 success rate；三輪或五／十輪可靠性仍需預先鎖定 cycle policy 後，以獨立 trial 重複量測。
