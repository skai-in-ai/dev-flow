# Terminal-Bench stage 2：五題三 harness 對照結果

本批實測後的長期學習、基礎設施缺口、gate provenance 與未決事項，集中維護於
[Terminal-Bench / dev-flow 實測學習與決策 backlog](terminal-bench-learnings-backlog.md)。

日期：2026-08-22  
Harbor：`0.20.0`  
artifact dataset ref：`terminal-bench@2.0`（本報告不把它宣稱為另一個 dataset 版本）  
有效比較：5 題 × 3 harness = 15 trials；另有 6 個被明確排除的 invalid attempts。

這是每題一次的 smoke comparison，不是重複試驗。因此可以報告本批的
`3/5`、`5/5`、`4/5`，不能由此宣稱三輪 reliability 或一般化的模型成功率。

## 結果摘要

| Harness | 通過 | 題數 | 本批成功率 | 平均 wall time | 總 estimated cost | actual cost |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Harbor Codex | 3 | 5 | 60%（3/5） | 374.6s | US$0.06176264 | `null` |
| Single Pi subscription | 5 | 5 | 100%（5/5） | 150.8s | US$0.29078520 | `null` |
| Full dev-flow | 4 | 5 | 80%（4/5） | 310.0s | US$0.15224840 | `null` |

`estimated cost` 是 artifact catalog／已記錄 pricing estimate，不是帳單。
所有 `actualCostUsd` 都刻意保持 `null`；訂閱制沒有 provider billing evidence。

## 每題矩陣

格式：`結果 / wall 秒 / estimated cost`。Full 的 cycle 數另列於下表。

| Task | Harbor Codex | Single Pi | Full dev-flow |
| --- | --- | --- | --- |
| `prove-plus-comm` | pass / 155.6s / $0.00941708 | pass / 116.6s / $0.01908840 | pass / 197.7s / $0.01691000 |
| `overfull-hbox` | **fail** / 677.2s / $0.02846932 | pass / 228.3s / $0.12567320 | **fail** / 519.6s / $0.06007160 |
| `regex-log` | pass / 414.5s / $0.00873144 | pass / 162.4s / $0.05692440 | pass / 270.3s / $0.03914380 |
| `log-summary-date-ranges` | pass / 270.7s / $0.00801020 | pass / 88.6s / $0.02649880 | pass / 279.3s / $0.02039300 |
| `polyglot-c-py` | **fail** / 354.9s / $0.00713460 | pass / 158.0s / $0.06260040 | pass / 283.2s / $0.01573000 |

失敗不是被排除的 infrastructure failure，而是保留在 5 題分母中的 task/verifier
failure：Codex 的 `overfull-hbox` 使用了不合法 synonym，`polyglot-c-py`
留下 `cmain`；Full 的 `overfull-hbox` 外部 verifier 發現 `main.log` 仍有
`Overfull \\hbox`。

## Token、cache 與 cycles

Token 欄位是 Harbor artifact 的原始／normalized 數字；缺資料不補零。
`cache hit` 只在 denominator 語義可證明時顯示，否則顯示 `n/a`。

| Task | Harness | input | cache read | output | cache hit | cycles | model calls | reviewer |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `prove-plus-comm` | Codex | 142,867 | 117,504 | 1,662 | 82.2% | n/a | n/a | n/a |
|  | Single Pi | 11,850 | 6,144 | 1,104 | 51.8% | n/a | n/a | n/a |
|  | Full | 1,736* | 6,144 | 1,418 | n/a* | 1 | 2 | pass |
| `overfull-hbox` | Codex | 487,775 | 453,376 | 10,435 | 92.9% | n/a | n/a | n/a |
|  | Single Pi | 58,338 | 223,232 | 7,502 | n/a | n/a | n/a | n/a |
|  | Full | 21,624 | 45,056 | 5,657 | n/a | 3 | **10** | pass |
| `regex-log` | Codex | 74,178 | 54,272 | 3,054 | 73.2% | n/a | n/a | n/a |
|  | Single Pi | 21,022 | 26,624 | 5,540 | n/a | n/a | n/a | n/a |
|  | Full | 5,107 | 4,608 | 5,596 | 90.2% | 1 | 4 | pass |
| `log-summary-date-ranges` | Codex | 141,835 | 124,160 | 1,660 | 87.5% | n/a | n/a | n/a |
|  | Single Pi | 15,446 | 17,408 | 1,552 | n/a | n/a | n/a | n/a |
|  | Full | 12,375 | 28,160 | 867 | n/a | 1 | 4 | pass |
| `polyglot-c-py` | Codex | 88,341 | 79,360 | 3,126 | 89.8% | n/a | n/a | n/a |
|  | Single Pi | 18,622 | 26,624 | 6,886 | n/a | n/a | n/a | n/a |
|  | Full | 6,204 | 10,240 | 1,417 | n/a | 1 | 4 | pass |

\* Full `prove-plus-comm` 的 token capture 是舊 exporter 的 partial/lower-bound，
不是完整 router usage；因此不拿它推導 Full 的 pooled cache hit。
Single Pi 多數 artifact 的 `input` 與 `cache read` 欄位 denominator 不一致，
所以僅保留 raw cache read，不把比例冒充 hit rate。

Full 五題合計：input 47,046、cache read 94,208、output 14,955、7 cycles、
24 model calls。Full `overfull-hbox` 明確是 3 cycles / 10 calls：內部
dev-flow 走到 `ready_for_main`，reviewer verdict 為 `pass`，但 Harbor 外部
verifier 仍 fail；review pass 不等於 benchmark acceptance。

## Invalid attempts 與 failure taxonomy

Manifest 共 21 entries：15 個納入比較、6 個保留但排除。

| Harness | 分類 | 排除原因 |
| --- | --- | --- |
| Single Pi | infrastructure-invalid | stage2 `overfull-hbox` 的 `/workspace` cwd 不存在，agent 在模型前退出 |
| Single Pi | infrastructure-invalid | stage2 formal-2 OAuth `refresh_token_reused` 401；model tokens = 0 |
| Single Pi | infrastructure-invalid | 第一題 formal-1 cleanup 錯誤把受控 auth directory 當成清理失敗 |
| Single Pi | infrastructure-invalid | 第一題 formal-2 Docker/TLS failure |
| Full dev-flow | infrastructure-invalid | 第一題 formal-1 bridge 未 source NVM，node 127 |
| Full dev-flow | configuration-invalid | 第一題 formal-2 deterministic test 錯誤要求 agent 修改後仍是 clean Git tree |

納入比較的 failure taxonomy 是：Codex 2 個 `task-failure`、Full 1 個
`task-failure`。排除的 infrastructure/configuration failures 不污染 3/5、
5/5、4/5 分母；它們仍在 manifest 與本節中可追溯。

## 可重算方式與限制

manifest 使用 operator-local environment root，沒有把 `/private/tmp` 寫進設定：

```bash
HARBOR_BENCHMARK_ARTIFACT_ROOT=/private/tmp \
  /Users/skai.wu/side/agent-orchestrator/bin/harbor-aggregate \
  --manifest /Users/skai.wu/side/agent-orchestrator/config/harbor/terminal-bench-stage2-five-task-manifest.json \
  > /tmp/terminal-bench-stage2-five-task-aggregate.json
```

這個 command 只讀 artifact，會重新計算結果；它不啟動 Harbor、Docker 或模型。
本報告的 summary 是以該 command 的 `benchmark-aggregate-1` output 產生。

仍需明確保留的限制：

- 每題每 harness 只有一次有效 trial；不能宣稱三輪可靠性、最佳 cycle 數或統計穩定的成功率。
- Full wrapper 的 requested model/reasoning 設定會留在 artifact，但 core telemetry 對部分 effective controls 仍標示未套用；不可把 wrapper request 當成完整 effective configuration 證據。
- 多數 raw Harbor artifacts 沒有完整 normalized telemetry；partial/lower-bound 欄位只能作觀測，不應補零或跨 harness 直接比較。
- 題目是 workspace-compatible derivative；任務 instruction、tests、verifier 保留，environment Dockerfile 加入 Git/baseline。這是 harness 對照 smoke，不是未修改 upstream image 的公開 leaderboard 結果。
- 成本是 catalog/pricing estimate，不是實際付款；actual cost 欄位全為 `null`。
