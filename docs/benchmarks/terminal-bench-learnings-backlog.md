# Terminal-Bench / dev-flow 實測學習與決策 backlog

狀態：`active-living-document`
最後更新：2026-08-22
Owner：agent-orchestrator 維護者（root agent 審核；operator 提供 auth、預算與正式 trial 授權）

本文件是 benchmark 進行中的單一「防飄移」紀錄。它記錄我們原本要回答
什麼、實測後確定了什麼、因實測新增哪些基礎設施／產品缺口，以及哪些方向已
否決或暫緩。它不是 Terminal-Bench leaderboard 報告，也不是把未驗證的想法
寫成產品承諾。

更新規則：每次新增 trial、修正 telemetry、改變實驗政策或否決一個方向時，先
更新本文件的 status、owner、evidence 與 acceptance，再改 run plan 或程式。
原始 artifact 與 versioned manifest 永遠是證據；摘要若與 artifact 不一致，應
重算摘要，不手動改數字。

## 導航與相關文件

- 基礎設計與入口邊界：[Harbor / Terminal-Bench foundation](harbor-terminal-bench.md)
- 五題三 harness 結果：[stage 2 results](terminal-bench-stage2-five-task-results.md)
- 五題鎖定設定與命令：[stage 2 run plan](../../config/harbor/terminal-bench-stage2-five-task-run-plan.md)
- 新版 telemetry 實跑：[telemetry canary](terminal-bench-telemetry-canary.md)
- 離線聚合器：[harbor-aggregate](harbor-aggregate.md)
- commit-capable 評估：[commit-capable follow-up](harbor-commit-capable-mode-follow-up.md)
- Pi subscription wrapper：[Pi wrapper follow-up](harbor-pi-subscription-wrapper-follow-up.md)

## 1. 原始目標與不變邊界

| ID | 原始目標／邊界 | Status | Owner | Evidence / acceptance |
| --- | --- | --- | --- | --- |
| GOAL-01 | 增加 evaluation-only 的第三入口，讓 Harbor 能跑 Full dev-flow benchmark。既有 production 入口 A（GitHub Issue queue）與 B（working-tree / CLI）不改行為、不改交付邊界。 | `verified-boundary` | root | `docs/overview.md` 的入口 C；AC：production A/B regression tests 維持通過，第三入口不自動改 production routing、commit、push、merge 或 deploy。 |
| GOAL-02 | 在同一 locked task derivative 上比較三個 harness：Harbor Codex CLI、Single Pi（Codex subscription）、Full dev-flow wrapper。 | `verified-for-smoke` | benchmark owner | stage2 結果的 5 × 3 矩陣；AC：每筆 trial 記 task digest、harness、model、requested/effective config、artifact path 與 include/exclude。 |
| GOAL-03 | 觀察外部 verifier 成功、wall time、model calls、cycles、token/cache、估算成本與失敗類型，評估是否值得把 Full dev-flow 納入 benchmark 流程。 | `verified-schema-and-smoke` | telemetry owner | manifest + aggregator schema 與 15 筆有效 trial；AC：原始值、derived 值、缺值 `null`、invalid taxonomy 可重算。 |
| GOAL-04 | 之後以重複 trial 研究可靠性與 cycle cap；「三輪」是待驗證的政策假設，不是預先保證。 | `in_progress` | benchmark owner | `.agent/specs/2026-08-22-terminal-bench-fresh-cycle-caps.md`、`config/harbor/terminal-bench-fresh-cycle-caps-preregistration.json`；兩題 × Codex/Single Pi baseline × Full cap 1/3 的 amendment primary matrix 已完成 8/8；仍只能做本批受限結論，不能宣稱普遍 cap 最佳或三輪必要。另有 1 筆 Codex diagnostic 明確 excluded。 |
| GOAL-05 | 允許 local commit 只作為 disposable benchmark workspace 的可選能力；production dev-flow 仍保留既有安全 invariant。 | `deferred` | core owner | `harbor-commit-capable-mode-follow-up.md`；AC：baseline SHA、`baseline..HEAD` 加 staged/unstaged diff、commit-only/mixed regression tests 全部具備前，不得開 `allowLocalCommit=true`。 |

「第三入口」是測試適配層，不是第四種 production workflow。benchmark 的成功也不
等於 production ready；任何要改 A/B 的提案需另立 approved spec。

## 2. 已驗證事實（只列已有證據者）

### 2.1 Harness smoke 結果

2026-08-22 的五題 smoke 是 `terminal-bench@2.0` registry/source 的 workspace-
compatible derivative；對話中曾稱 Terminal-Bench 2.1，但本批報告不把它寫成
另一個 dataset 版本。instruction、tests、verifier 與 task metadata 保留；
衍生環境只加入 Git 與 baseline。每題每 harness 一次有效 trial，不能視為穩定
成功率。

| Harness | 通過 | 本批觀察 | 不能從這批推出的事 |
| --- | ---: | --- | --- |
| Harbor Codex | 3/5（60%） | `overfull-hbox` synonym 失敗、`polyglot-c-py` 留下 `cmain` | 一般 Codex 成功率、跨任務模型排名 |
| Single Pi subscription | 5/5（100%） | 本批最快；估算成本較高 | Pi 必然更可靠或長期更便宜 |
| Full dev-flow | 4/5（80%） | `overfull-hbox` 外部 verifier fail，但 Full 內部 reviewer pass；該題 3 cycles / 10 calls | 三輪保證成功、reviewer pass 可替代 verifier |

證據：[terminal-bench-stage2-five-task-results.md](terminal-bench-stage2-five-task-results.md)。
所有 `actualCostUsd` 仍是 `null`；表中的成本是 catalog/pricing estimate，不能
稱作實際付款。

### 2.2 實測暴露的運作事實

| ID | 事實 | Status | Evidence / interpretation |
| --- | --- | --- | --- |
| FACT-01 | 目前 Full wrapper 是 evaluation-only 薄 wrapper；不改 core 的 production A/B。 | `verified` | `docs/overview.md` 入口 C、foundation；AC 已由 foundation tests 與既有 npm tests 覆蓋。 |
| FACT-02 | Full 的 requested model/reasoning/maxTier 不必然等於 core 實際 effective controls；artifact 必須分開記錄兩者。 | `verified-gap` | stage2 report 明確記錄 requested/effective 落差；不能只讀 Harbor command line 就宣稱 core 使用了完整設定。 |
| FACT-03 | 舊的 Full `prove-plus-comm` artifact 缺 router usage，只能作 partial/lower-bound；不能拿它推 pooled cache hit 或完整成本。 | `verified-limitation` | first comparison 與 stage2 report；後續 collector 已讀 router event，但舊 artifact 不重跑、不補值。 |
| FACT-04 | Single Pi 的多數 artifact 中 `input` 與 `cache read` denominator 語義不一致；只能保留 raw cache read，不能直接宣稱 cache hit rate。 | `verified-limitation` | stage2 report；只有 denominator 可證明時 aggregator 才呈現比例。 |
| FACT-05 | OAuth refresh token 會輪替；Pi 曾因 `refresh_token_reused` 在模型前 401，這是 infrastructure-invalid，不是 agent task failure。 | `verified` | stage2 manifest 的 excluded entries；重新 `/login` 後才可繼續 Pi harness。auth path/value 不進 artifact。 |
| FACT-06 | Pi wrapper 曾有 `/app` workdir bug；模型可能在錯誤 workspace 執行。 | `fixed-and-regressed` | stage2 run history 與修正後 Python tests；AC：workdir preflight 在 model call 前 fail closed。 |
| FACT-07 | cleanup 把受控 auth directory 當成 cleanup failure、Docker/TLS、NVM 未 source，以及錯誤的 post-run clean-tree test，均可能製造 invalid attempt。 | `verified-taxonomy` | stage2 manifest 6 個 excluded entries；invalid 必須保留原因但不污染有效 success denominator。 |
| FACT-08 | artifact manifest + aggregator 可以唯讀重算 15 筆有效 trial，並把 invalid、estimated cost、actual cost、raw/null/derived 分開。 | `verified` | `config/harbor/terminal-bench-stage2-five-task-manifest.json`、`docs/benchmarks/harbor-aggregate.md`。 |
| FACT-09 | Full 的 reviewer pass 不代表 Harbor external verifier pass。`overfull-hbox` 已構成實證：Full 到 `ready_for_main`，外部仍 fail。 | `verified` | stage2 report；這是 gate/reviewer evidence boundary，不是「增加 cycle 就必然修好」的證據。 |
| FACT-10 | Full `overfull-hbox` 在弱 deterministic test 下用了 3 cycles / 10 calls，仍未通過外部 verifier。 | `verified` | stage2 artifact；只能說本題顯示弱訊號會重複浪費輪次，不能說 3 cycles 普遍無效。 |

## 3. 實測新增的 infrastructure / product gaps

這些不是把 benchmark 題目量身打造的功能清單，而是從三 harness 共通的執行、
證據與產品目標抽出的能力缺口。每項都要有 owner 和可驗收 evidence，否則維持
`observed`，不自動升級成「已完成」。

| ID | Gap / 要補的能力 | Status | Owner | Acceptance / evidence | 下一步 |
| --- | --- | --- | --- | --- | --- |
| GAP-01 | Telemetry 必須完整保存 role/session/router/implementer/reviewer 的事件與 totals，並保留 `requestedConfig` 與 `effectiveConfig`。 | `verified-canary` | telemetry owner | 三入口 canary 已驗證 Codex ATIF、Single Pi canonical calls 與 Full role/cycle usage；Full model observed、role reasoning 可呈現 conflict。 | 在未見結果的新題延續相同 schema；不回填舊 partial artifact。 |
| GAP-02 | Cache metrics 要有明確 denominator：`inputTokens`、`uncachedInputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`sessionMode` 與公式分開。 | `verified-canary` | telemetry owner | Single Pi raw calls/totals 一致且有 fresh preflight；Full 使用 versioned Pi 0.82.1 semantics 算 derived hit rate，session 證據不足時維持 unknown。 | 在 repeated trials 比較 cache 前先確認相同 version/denominator。 |
| GAP-03 | 成本要區分 catalog estimate、subscription estimate 與 provider billing evidence。 | `verified-policy` | benchmark owner | `estimatedCostUsd`、`actualCostUsd` 分欄；無 billing evidence 時 actual 必須 `null`。 | 若要報實際支出，另建 operator billing ledger，與 artifact ID 對應。 |
| GAP-04 | Auth/session lifecycle 要可診斷且不洩漏 secret：Pi explicit auth path、0600/non-symlink、ephemeral upload/cleanup、OAuth rotation 分類。 | `partially-verified` | wrapper owner | auth 失敗在模型前分類為 `infrastructure-invalid`；auth path/value 不進 logs/telemetry；refresh 後可做最小 smoke。 | 將 login freshness 與 model invocation 前的 auth preflight evidence 寫入 manifest，不把 token 複製給 Codex。 |
| GAP-05 | Workdir、Git root、baseline 與工具存在性必須在最貴步驟前 fail closed。 | `fixed-policy` | wrapper/core owner | 每題 compatibility preflight 在 model 前通過；不要求 post-run clean tree；scope/acceptance 另記。 | 新 task derivative 先 `--print-config`／install-only，再正式 trial。 |
| GAP-06 | Invalid taxonomy 要區分 configuration-invalid、infrastructure-invalid、model/task failure、verifier failure，且排除理由可重現。 | `verified` | aggregator owner | invalid 保留在 manifest/trials，但不進有效 success/cost/token 分母；分類不靠人工事後改結果。`AgentTimeoutError` 若發生於 agent execution 且已有 model usage，聚合為 valid included `model-failure`；setup timeout 仍為 `infrastructure-invalid`。 | 每個新 trial 記 failure phase、model tokens、artifact path、根因與是否可 rerun。 |
| GAP-07 | Artifact manifest 要能鎖定 task revision、task digest、derivative digest、harness、auth/model config、trial/retry policy。 | `verified-for-stage2` | benchmark owner | 任何摘要可從 manifest + artifact 唯讀重算；path 可用 operator-local env，不把本機 secrets/路徑提交。 | 重複 trial 時用新 manifest 版本，不覆寫 stage2 manifest。 |
| GAP-08 | Local commit mode 的 evidence 還沒完成；目前 review 只看 working-tree diff。 | `deferred` | core owner | 開啟前須保存 baseline SHA，review 同時看 `baseline..HEAD` 與 staged/unstaged diff，並通過 commit-only/mixed regression tests。 | 維持 `allowLocalCommit=false`；完成 approved spec 後才另做 evaluation-only spike。 |
| GAP-09 | Gate 的來源、可見性與適用範圍要有 provenance policy；不能因為看過 hidden verifier 失敗就為單題複製答案檢查器。 | `policy-adopted` | core/benchmark owner | gate 必須是 task 公開可見且可在乾淨 checkout 執行的 build/test/lint/typecheck/invariant；manifest 記 command、source、時間與 result；external verifier 仍是 acceptance authority。 | 先在尚未看過結果的新題預註冊 gate，再跑 trial；`overfull-hbox` 不做事後 gate-on/off 宣傳性實驗。 |
| GAP-10 | Cycle policy 與可靠性證據尚未建立；cycle cap、implementation 次數、reviewer 次數、model calls 必須分開。 | `preregistered-implemented-no-model` | benchmark owner | 新題、gate provenance、budget、stop rules 與 canonical `maxCycles` 1/3 已 preregister；Full wrapper/bridge 已將 total implementation cap 接入 core，requested/effective telemetry 與 bridge-result 保留 canonical value。 | 以最新 wheel/runtime bundle 再做 operator preflight，確認 `maxCycles=1/3` 後，執行 8 個候選 trials；不立即跑 0/1/2/3/5/10 全矩陣。 |
| GAP-11 | Requested config 與 effective runtime config 的差距可能使 harness 比較失真。 | `verified-canary` | wrapper/core owner | Codex/Single Pi/Full 的 model 均由 runtime artifact observed；Full role reasoning 不一致時標 conflict，tier 未觀測仍為 null。 | 後續比較必須保留 per-call effective，不把頂層 requested 當實際值。 |
| GAP-12 | Dataset/task derivative 的 source provenance 與 workspace compatibility 必須能追溯，否則結果不能當公開 benchmark 分數。 | `verified-for-stage2` | benchmark owner | source/derivative canonical SHA-256、preserved files、Dockerfile-only delta、verifier mode 與 task timeout 皆在 config/manifest；Harbor raw `task_checksum` 另作 runtime artifact field，不與 derivative canonical digest 混同。 | 若要對外發布，先釐清 raw task checksum 與 derivative digest 的 domain，並取得可引用的 upstream revision/digest；否則明確稱為 smoke derivative。 |
| GAP-13 | Agent setup timeout policy 必須在所有 harness/condition 一致，避免安裝時間差異污染 cycle-cap comparison。 | `verified` | benchmark owner | setup-timeout amendment 鎖定 Harbor `--agent-setup-timeout-multiplier 2` 套用全部 8 個 planned trials；第一筆 amendment artifact 實測 setup `2.0`、其他 timeout multiplier `1.0`。只改 setup/install timeout，不改 task/agent/verifier timeout、model、cycle、gate、retry、session、budget。舊 360 秒 invalid artifact 保留且不可覆寫。 | 最新 wheel/runtime bundle 安裝後重跑其餘 harness 的 no-model preflight；不要以這筆 Codex artifact 宣稱 Full/Single Pi image reuse 已驗證。 |

## 4. Gate provenance policy（通用，不量身打造）

### 定義責任

gate 由 task compatibility / handoff 的公開測試契約宣告，由 dev-flow core 在每
輪實作後執行；reviewer 讀 gate 結果、diff 與 findings；Harbor external verifier
獨立做最後 benchmark acceptance。Gate 不是 reviewer 的替代品，也不是 hidden
verifier 的副本。

### 可接受的 gate

- repository 原本就有、或在看到該次結果前已預先註冊的 build、test、lint、typecheck、schema、公開 invariant。
- 能在乾淨 checkout／locked task derivative 執行的 deterministic command。
- 不讀取或回饋 Harbor reward、hidden verifier output 或 agent 不應知道的答案。
- manifest 能記錄 command source、版本、輸出摘要、耗時與 pass/fail。

### 不接受的 gate

- 看到某題 hidden verifier 的具體失敗後，才把相同條件寫進該題 gate。
- 將「環境存在」（檔案／工具／Git root）冒充「任務完成」；前者只能叫 preflight。
- 要求 agent 修改後仍保持 clean tree，因為那會排除合法 working-tree evidence。
- 把 reviewer pass、內部 gate pass 或 model 自報完成當作 external verifier acceptance。

因此 `overfull-hbox` 目前保留為「弱 gate + reviewer pass + external fail」的失敗
案例；不為了事後證明顯而易見的 gate 效果，製作針對這題的 gate-on/off 結果。
後續要研究 gate 效果，應在尚未看過結果的新題上預註冊通用 gate，並把 gate source
與 acceptance boundary 一起公開。

## 5. 已否決或暫不做

| ID | 決策 | Status | 理由／重新開啟條件 |
| --- | --- | --- | --- |
| DEC-01 | 不修改 production dev-flow 的入口 A/B 或安全 invariant。 | `rejected-for-this-scope` | 本 benchmark 是 evaluation-only；若要改 production，另開 spec、regression 與 review。 |
| DEC-02 | 不把 `allowLocalCommit` 直接打開。 | `deferred` | 目前 working-tree diff evidence 會看不到 commit-only change；完成 GAP-08 前維持 false。 |
| DEC-03 | 不把 `overfull-hbox` 做成事後量身打造的 gate-on/off showcase。 | `rejected-for-this-scope` | 已看過 verifier，因果證據會被 benchmark-specific leakage 污染；保留為 failure case。 |
| DEC-04 | 不立即跑 0/1/2/3/5/10 全 cycle 矩陣。 | `deferred` | 五題各一次不足以支撐 reliability；先挑未見結果的新題、預註冊 policy、少量 cap 與 fresh repeats。 |
| DEC-05 | 不宣稱「三輪保證可靠」或「三輪是最佳」。 | `rejected-claim` | `overfull-hbox` 3 cycles / 10 calls 仍 external fail；要等 repeated trials。 |
| DEC-06 | 不把 `actualCostUsd` 從 Harbor/catalog estimate 推導。 | `rejected-claim` | 訂閱模式沒有 provider billing evidence；actual 永遠 `null` 直到有可稽核 billing ledger。 |
| DEC-07 | 不把 Single Pi raw cache read 當 cache hit，也不把 Full 舊 sample lower-bound 當完整 telemetry。 | `rejected-claim` | denominator／router usage 不完整；只能保留 raw、partial、lower-bound 標記。 |
| DEC-08 | 不把 stage2 derivative smoke 當未修改 upstream image 的公開 leaderboard 分數。 | `rejected-claim` | derivative 只為 workspace compatibility 加 Git/baseline；需鎖定可引用 upstream revision/digest 才能另行發布。 |
| DEC-09 | 不使用 Harbor native Pi 來代表 Single Pi，除非其 auth-file 與 pinned package contract 先被解決。 | `deferred` | Harbor 0.20 native agent 缺明確 auth-file kwarg 且 package pin 不合；目前使用 audited wrapper。 |

## 6. 後續工作（按優先順序）

| Priority | Work item | Status | Owner | Acceptance / evidence |
| --- | --- | --- | --- | --- |
| P0 | 維護本 living document、stage2 manifest 與 report 的互相連結；每次新 trial 先寫 provenance/policy。 | `in-progress` | root | 本文件被 foundation 與 stage2 report 連結；後續 diff 必須更新 status/evidence。 |
| P0 | 完整化 telemetry contract：role/session/router、requested/effective config、cycle/call counts、cache denominator、stop reason。 | `implemented-no-model` | telemetry/wrapper owner | `benchmark-trial-2`、cache registry、TS 144/144、Python 28/28；fake/no-model fixtures 可重算且不重複計算 router/turn events。 | 由一次新 Full/Single Pi artifact 驗證 runtime effective evidence；若未提供則保留 partial/unknown。 |
| P1 | 在尚未看過 verifier 結果的新題上，預先鎖定通用 gates 與 provenance，然後才跑三 harness。 | `preregistered-no-trial` | benchmark owner | `config/harbor/large-scale-text-editing-full-dev-flow-compatibility.json`、`config/harbor/sqlite-db-truncate-full-dev-flow-compatibility.json`；gate 只檢查公開 input/tool/Git-root invariant，external verifier 保持 acceptance authority。 |
| P1 | 重複 trial／cycle-cap 小型研究：先少量選 `cap=1` 與 `cap=3`（必要時 `cap=5`），每組 fresh trial；不先跑全 0..10。 | `in_progress` | benchmark owner | [fresh cycle-cap run plan](../../config/harbor/terminal-bench-fresh-cycle-caps-run-plan.md) 與 amendment results manifest 已完成 8 個 primary trials、US$0.75 estimate ceiling、invalid taxonomy、stop rules；primary 8/8 均 valid，7/8 pass、1/8 Codex model failure。按 harness：Codex 1/2、Single Pi 2/2、Full 4/4；primary estimated cost 合計 US$0.11776736，actual 全為 null。兩題的 Full cap1/cap3 實際 cycles 都是 1，不能因此宣稱 cap1 普遍最佳或三輪必要；另有 1 筆 Codex task-compliance diagnostic excluded（US$0.02155956）。 |
| P1 | 重新登入只作 operator auth recovery；補最小 auth smoke 與 OAuth rotation 的 invalid evidence。 | `planned` | operator + wrapper owner | token failure 在 model 前被分類；新 auth 不複製到 Codex，secret 不進 logs。 |
| P2 | 若有實際需求，再做 commit-aware evaluation-only mode。 | `deferred` | core owner | GAP-08 的 baseline/diff/regression acceptance 全通過；production A/B 仍不變。 |
| P2 | 有 billing evidence 時才把 actual cost 納入報告；否則維持 null 並報 catalog estimate。 | `deferred` | operator | provider ledger 可對應 artifact/run ID、時間、模型與 usage；人工核對後才填 actual。 |
| P3 | schema 穩定、重複 trial 完成後，再產 Markdown/CSV/圖表與對外摘要。 | `deferred` | benchmark owner | 報表由 aggregator output 產生；所有 claim 都能回鏈 raw artifact/manifest。 |

### 每次新 trial 的最小更新清單

- [ ] task dataset revision、task/derivative digest 與 source provenance 已鎖定。
- [ ] harness、requested model/reasoning/maxTier、effective config evidence 已記錄。
- [ ] session mode、fresh/reused、trial/retry/cycle policy 已記錄。
- [ ] gate command、source、可見性與執行時點已記錄；未預註冊不得升格為通用 gate。
- [ ] auth/workdir/Git preflight 在 model 前完成；失敗標為 invalid 並記 phase/tokens。
- [ ] raw artifact、manifest entry、verifier reward、reviewer verdict 與 stop reason 已對應。
- [ ] cost 的 estimate/actual 分開；無 billing evidence 的 actual 寫 `null`。
- [ ] cache 比例只有 denominator 可證明時才計算；否則保留 raw/`null`/lower-bound。
- [ ] 更新本文件對應 GAP/FACT/DEC/P 項目，跑 `git diff --check`。

## 7. 現階段不能宣稱的結論

在有新的 repeated-trial evidence 前，對外或履歷材料不得寫成下列句子：

- 「Full dev-flow 在 Terminal-Bench 的成功率是 80%」；目前只能說五題一次 smoke
  為 4/5，且是 workspace-compatible derivative。
- 「Single Pi 一定比 Codex 或 Full 好」；本批只是 5 題觀察，且模型、cache、成本
  與 effective config 的證據仍有差異。
- 「三輪可以保證可靠」或「三輪是最佳成本／效能點」；目前沒有 repeated cycles
  的 controlled evidence，且一題三輪仍 external fail。
- 「Gate 讓通過率由 A 提升到 B」；目前沒有預註冊、未見結果的新題 gate-on/off
  對照，且事後量身打造會污染因果解釋。
- 「每題花費 US$X」或「訂閱成本就是 US$X」；目前都是 estimate，actual cost 是
  `null`。
- 「cache hit 是 N%」若該 harness 的 input/cache denominator 不可證明；Single Pi
  多數 artifact 與 Full 舊 sample 都不能如此報告。
- 「reviewer pass 就是 task pass」；Harbor external verifier 仍是獨立 acceptance。
- 「這是 upstream Terminal-Bench 公開 leaderboard 分數」；本批是 derivative smoke，
  不是未修改 upstream image 的 leaderboard run。

## 8. 變更紀錄

| 日期 | 變更 | Evidence |
| --- | --- | --- |
| 2026-08-22 | 建立 living document；收斂三 harness、telemetry/cache/cost、invalid taxonomy、gate provenance、cycle 與 commit-aware 邊界。 | stage2 report、foundation、run plan、commit/Pi follow-up；尚未新增 trial。 |
| 2026-08-22 | P0 telemetry no-model contract 實作：`benchmark-trial-2`、requested/effective per-call observations、Pi 0.82.1 versioned cache semantics、session/provider-cache 分離、legacy v1 in-memory migration、dedupe/security fixtures。 | `.agent/specs/2026-08-22-p0-benchmark-telemetry-effective-config-cache-session.md`、TS 144/144、Python 28/28；尚未新增 model trial。 |
| 2026-08-22 | Fresh cycle-cap 實驗 preregistration：選定尚未跑過結果的 `large-scale-text-editing` 與 `sqlite-db-truncate` derivatives，鎖定 Full total-cycle cap 1/3（core `maxCycles` 1/3）、8 個候選 trial、公開 preflight gates、US$0.75 estimate ceiling 與停止條件；尚未執行模型。 | `.agent/specs/2026-08-22-terminal-bench-fresh-cycle-caps.md`、`config/harbor/terminal-bench-fresh-cycle-caps-preregistration.json`、`config/harbor/terminal-bench-fresh-cycle-caps-run-plan.md`；cap plumbing 已完成 no-model 驗證。 |
| 2026-08-22 | Fresh cycle-cap 第一筆 Codex baseline 在安裝階段超過 360 秒 setup timeout，模型/verifier 前停止；依預註冊規則未自動重試，其餘七筆暫停。 | `config/harbor/terminal-bench-fresh-cycle-caps-results-manifest.json`；分類為 `infrastructure-invalid`，estimated/actual cost 均為 null。 |
| 2026-08-22 | Cycle semantics migration：公開設定與 telemetry 統一 `maxCycles`（包含第一次 implementation），core 使用 `maxImplementationAttempts`；舊 `maxFixCycles`/`max_fix_cycles` 僅作衝突即拒絕的相容 alias，舊 artifacts 只在 normalization 轉換並保留 legacy provenance。 | `.agent/specs/2026-08-22-unify-cycle-semantics.md`、TS 152/152、Python 31/31；未執行模型或網路。 |
| 2026-08-22 | Setup-timeout preregistration amendment approved：八個 planned conditions、三個 harness 統一 `--agent-setup-timeout-multiplier 2`；只影響 agent setup/install timeout（360→720 秒），不改 task/agent/verifier timeout 或 cycle policy。既有 360 秒 `infrastructure-invalid` artifact 與 manifest 保留，新 run 使用 amendment job names、新 artifact root、新 results manifest；核准當時尚未跑模型。 | `.agent/specs/2026-08-22-terminal-bench-fresh-cycle-caps-timeout-amendment.md`、`config/harbor/terminal-bench-fresh-cycle-caps-preregistration.json`、`config/harbor/terminal-bench-fresh-cycle-caps-run-plan.md` |
| 2026-08-24 | Amendment 後第一筆 `large-scale-text-editing` Codex baseline 完成：setup multiplier=2，agent execution 在 1200s timeout，external verifier reward 0；因已有 12,966 input／9,984 cache／200 output tokens，分類為 valid included `model-failure`，不是 infrastructure-invalid。新增 amendment results manifest；舊 invalid manifest 未覆寫。Harbor raw `task_checksum` 與 compatibility manifest derivative canonical digest 不同，先分開保留，未作未證明的 digest 等同。 | `config/harbor/terminal-bench-fresh-cycle-caps-amendment-results-manifest.json`、artifact `harbor-fresh-cycle-caps-amendment/fresh-caps-amendment-large-scale-text-editing-codex/large-scale-text-editing__huSnQx8`、TS 153/153；actual cost null。 |
| 2026-08-24 | Read-only image reuse 檢查：Harbor 0.20.0 Docker source 使用 content-addressed `hb__<environment_id>`，普通 build 可用 layer cache，但 `force_build=true` 仍執行 compose build；artifact 沒有 image digest/build log 能證明 reuse，Docker socket inspect 也被 permission 拒絕。下一筆依 locked matrix 為同題 Single Pi baseline，不改 force-build。 | `config/harbor/terminal-bench-fresh-cycle-caps-run-plan.md`；不宣稱 image reuse 已驗證。 |
| 2026-08-24 | Amendment 後第二筆 `large-scale-text-editing` Single Pi baseline 完成：setup multiplier=2，external verifier reward 1、CTRF 5/5 passed、exception null；登錄為 valid included pass。`pi.txt` 的 assistant `message_end` canonical calls 為 4（lines 7/26/34/45），usage totals input 8078／cache read 2560／output 1158 一致；fresh session、provider cache 與 Pi 0.82.1 cache semantics key 均保留，derived cache hit rate 0.2406467；estimated US$0.015282、actual null。amendment manifest 新增 entry，舊 invalid manifest 未覆寫。下一筆改為同題 Full cap 1，仍需最新 wheel/runtime 的 no-model preflight，未宣稱 image reuse。 | `config/harbor/terminal-bench-fresh-cycle-caps-amendment-results-manifest.json`、`config/harbor/terminal-bench-fresh-cycle-caps-run-plan.md`、artifact `harbor-fresh-cycle-caps-amendment/fresh-caps-amendment-large-scale-text-editing-single-pi/large-scale-text-editing__QY97A8b`；TS 153/153、Python 31/31。 |
| 2026-08-24 | Amendment 後第三、四筆正式 trial：同題 Full cap 1 與 cap 3 均 setup multiplier=2、external verifier reward 1、CTRF 5/5、exception null，observed cycles 均為 1，且 runtime maxCycles 分別 observed 1/3。aggregator 由 sanitized call evidence 四筆 `usage.costUsd` 求得 estimated US$0.0211694（cap1）與 US$0.011188（cap3），actual null；兩筆均 valid included。這只能說本題兩個 cap 都通過且 cap3 未消耗額外 cycle，不能推論普遍最佳 cap 或三輪必要性。 | `config/harbor/terminal-bench-fresh-cycle-caps-amendment-results-manifest.json`、`config/harbor/terminal-bench-fresh-cycle-caps-run-plan.md`、artifacts `...full-cap1/large-scale-text-editing__HTtHxLE`、`...full-cap3/large-scale-text-editing__8Ky3QFv`；TS 153/153、Python 31/31。 |
| 2026-08-24 | Codex diagnostic retry 完成但不進 prereg primary：reward 0、exception null、CTRF 4/5，失敗為 task-compliance；usage input 382335／cache read 342528／output 5623，estimated US$0.02155956、actual null。manifest 以 `includeInComparison=false`、`task-failure` 明確保留，未取代 original Codex baseline；只作失敗形狀與成本診斷。 | `config/harbor/terminal-bench-fresh-cycle-caps-amendment-results-manifest.json`、artifact `harbor-fresh-cycle-caps-amendment/fresh-caps-amendment-large-scale-text-editing-codex-diagnostic-retry1/large-scale-text-editing__smBcgCT`；aggregator read-only output。 |
| 2026-08-25 | Amendment primary matrix 完成 8/8：`sqlite-db-truncate` Codex reward 1（input 92779／cache 75264／output 2279／estimated US$0.00774308）、Single Pi reward 1（9761／22528／3265／US$0.0316038、fresh session）、Full cap1 reward 1（8999／9216／996、4 calls、runtime maxCycles 1、actual cycles 1、aggregator estimated US$0.0158966）、Full cap3 reward 1（7408／13824／843、4 calls、runtime maxCycles 3、actual cycles 1、aggregator estimated US$0.0138484）。兩筆 Full estimate 均由 sanitized per-call evidence 求和，actual null。兩題合併 primary 7/8 pass、estimated US$0.11776736；這是 locked derivative 的受限 observation，不是 upstream leaderboard 或普遍成功率。 | `config/harbor/terminal-bench-fresh-cycle-caps-amendment-results-manifest.json`、`config/harbor/terminal-bench-fresh-cycle-caps-run-plan.md`、sqlite artifacts `...VRisi96`、`...y3jwc4M`、`...T8ZudnH`、`...3HnMjLW`；aggregator read-only output。 |
