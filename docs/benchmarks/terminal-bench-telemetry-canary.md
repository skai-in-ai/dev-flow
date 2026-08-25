# Terminal-Bench telemetry canary

日期：2026-08-22  
任務：`prove-plus-comm` derivative  
用途：驗證 `benchmark-trial-2` telemetry；不是新的成功率樣本或 leaderboard 結論。

## 有效結果

| Harness | Reward | Calls | 觀測結果 | Estimated cost |
| --- | ---: | ---: | --- | ---: |
| Harbor Codex | 1 | 15 | ATIF `model_name` observed；reasoning/tier unknown | US$0.01479548 |
| Single Pi | 1 | 7 | raw `pi.txt` totals 與 metadata 一致；session fresh 有 preflight；model observed | US$0.0130044 |
| Full dev-flow | 1 | 4 | 1 cycle；model observed；implementer medium/reviewer high，因此頂層 reasoning conflict；session unknown | US$0.0106008 |

三筆 `actualCostUsd` 均為 `null`。Full 的 external verifier reward 為 1；內部 deterministic test 只作 preflight，不替代 external verifier。

唯讀重算：

```bash
HARBOR_BENCHMARK_ARTIFACT_ROOT=/private/tmp \
  bin/harbor-aggregate \
  --manifest config/harbor/terminal-bench-telemetry-canary-manifest.json
```

## Canary 找到並修正的缺口

1. Native Codex 的 `agent/trajectory.json` 原未被 aggregator 讀取；現以有 metrics 的 ATIF steps 建 canonical calls，effective model 只取 runtime `model_name`。
2. Pi lifecycle 同一 usage 會出現在 `message_start`、`message_end`、`turn_end`；wrapper 與 aggregator 現只計 assistant `message_end`，避免 totals/calls 重複。
3. Full ledger 已有 adapter invocation model/reasoning，但 bridge 原未接入；現輸出 per-call effective，頂層只在一致時 observed，衝突時明確標 `conflict`。
4. Full 不匯出含 prompt/summary 的 raw role ledger；改輸出 sanitized `call-evidence.json`，排除 session path、session ID、prompt 與 secret。

## Invalid attempts

- Single Pi 首次嘗試：`npm` 回報 `Exit handler never called`，模型前失敗。
- Full v2 首次嘗試：Pi 安裝超過 Harbor 360 秒 setup timeout，模型前失敗；受控重試只把 setup multiplier 調為 2。
- Single Pi 舊成功 canary 暴露 lifecycle 重複，保留作診斷，不納入此 manifest。
- Full 最後一次成功 trial 使用的 wheel 在 evidence path prefix 修正之前打包，因此該 trial 的 telemetry refs 是短路徑；實際 evidence 已存在於 `artifacts/logs/artifacts/...`。最終 wheel 已安裝且 147 個 TS tests、28 個 Python tests通過，但 path prefix 尚未由另一筆模型 run 驗證。

## 下一步

停止重跑已見過的 `prove-plus-comm`。選少量未見結果的新題，先鎖定通用 deterministic gates，再執行 fresh repeated trials；cycle cap 先比較 1 與 3，只有資料顯示未收斂時才增加 5，不直接展開 0/1/2/3/5/10 全矩陣。
