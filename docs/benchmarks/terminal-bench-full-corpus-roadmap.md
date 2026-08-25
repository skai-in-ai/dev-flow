# Terminal-Bench full-corpus roadmap

狀態：`approved-roadmap`（2026-08-25）

這是 full-corpus 評測的唯一主流程文件。每個 phase 產出的 manifest、inventory、
preflight report 與 trial artifact 都是不可覆寫的證據。任何改變條件的工作都要先
寫 versioned amendment，再進下一批。

## 固定邊界

- 只用 operator 明確提供的 corpus root；inventory 輸出不含本機絕對路徑。
- 不讀 `solution/`、`tests/` 或 verifier 內容。只讀 `task.toml`、`instruction.md`、
  environment 的檔名／metadata，以及 Dockerfile 的公開 dependency declarations。
- 不把 external reward、hidden verifier output 或 solution clue 放進 reviewer／agent
  context。
- source task、workspace-compatible derivative、trial artifact 三者分開；derivative
  只用來做相容性適配，不代表 upstream leaderboard 結果。
- `inventoryDigest` 只代表 inventory identity（允許讀取的內容加 filesystem
  metadata），不是 source integrity；`sourceDigest` 固定為
  `status: "not-computed"`，因為 protected content intentionally unread。真正的
  derivative canonical digest 只能沿用既有受控 compatibility 流程。
- 未取得 billing evidence 時，成本都是 estimate；`actualCostUsd` 為 `null`。

## Phase 0 — corpus inventory（唯讀）

輸入：operator-local corpus root。

執行：

```bash
bin/harbor-corpus-inventory /absolute/path/to/corpus-root > /private/tmp/terminal-bench-inventory.json
```

輸出：`terminal-bench-corpus-inventory-1` deterministic JSON，包含 task 名稱、相對
路徑、`inventoryDigest`、未計算的 `sourceDigest` 狀態、timeouts、可稽核 workdir、environment file metadata、
保守的 gpu/qemu/service/network/build-large indicators、觀察到的 public command/tool
候選、compatibility risk facts。

驗收：排序穩定、沒有 operator-local absolute path；malformed metadata、unknown
argument、path/symlink escape fail closed；不讀 solution/tests/verifier。

停止政策：CLI 或 schema 任一不確定就停止，不猜欄位、不進模型。

預算權限：只允許本機 CPU／disk；不需要模型、Docker、網路或使用者 trial 預算。

需要使用者決策：corpus root 不存在、不是同一 locked revision，或 inventory 顯示
需要付費資源時，需使用者指定 root／revision／預算後才能進 Phase 1。

## Phase 1 — compatibility triage（唯讀）

輸入：Phase 0 inventory、task metadata、已核准的 Harbor version／dataset revision。

執行：將任務分成 `direct-compatible`、`derivative-required`、`blocked-readonly`
與 `unknown`；只根據 inventory evidence 建立 risk facts。不可讀 solution、tests、
verifier，不能把任務名稱當作能力推論。

輸出：triage matrix、每題 owner/risk、`inventoryDigest` 與若需 derivative 的明確
Dockerfile-only／workspace-only adaptation plan；不產生 leaderboard 結果。

驗收：每個分類有 provenance；未知保持 unknown；derivative 的 canonical digest 只
由既有受控 compatibility 流程計算，不能由 `inventoryDigest` 宣稱 source equality；
無模型／Docker／網路副作用。

停止政策：缺少 workdir、timeout、environment 或 path provenance 的題目先 blocked，
不以猜測放行；若 compatibility risk 超過本批 budget，停止整批。

預算權限：本機唯讀分析；任何 derivative build 或 external service 都必須進下一
phase 並受新的 preregistration budget 控制。

需要使用者決策：選定 locked dataset revision、允許哪些 derivative 類型、每批最大
估算成本與可接受的 infrastructure-invalid 比例。

## Phase 2 — wheel、no-model preflight、evidence canary

輸入：approved triage matrix、source/derivative manifests、固定 Harbor wheel、
public evidence checks。

執行順序：重建並安裝 wheel；跑 Harbor／workspace／auth path 的 no-model preflight；
選一題做三 harness evidence canary。canary 只驗證 artifact、telemetry、evidence
摘要與 redaction，不新增成功率結論。

輸出：wheel digest、preflight report、canary artifacts、telemetry schema version、
evidence runner report 與 read-only aggregate。

驗收：tests、JSON validation、diff check 通過；calls、roles、cycles、cost、session
與 cache 欄位可重算；沒有 prompt、secret、auth path、session ID 或 reward feedback。

停止政策：wheel mismatch、preflight invalid、redaction failure、telemetry
schema drift 或 canary artifact 缺失即停止，不跑 baseline。

預算權限：只允許一題 × 三 harness；模型／網路／Docker 使用須在 preregistration
內，估算超 ceiling 即停止。

需要使用者決策：canary 通過且要不要授權 Phase 3 的批次大小與三 harness 配置。

## Phase 3 — 分批三 harness single-run baseline

輸入：Phase 1 triage matrix、Phase 2 canary、approved batch preregistration。

每批對每題各跑一次：Codex CLI、Single Pi、Full dev-flow（固定 model、reasoning、
timeout、setup multiplier、concurrency、retry 與 cycle cap）。external Harbor
verifier 是唯一 acceptance；public evidence 是 workflow feedback，不替代 verifier。

輸出：每題三 harness 的 raw artifacts、versioned manifest、aggregated reward、wall
time、calls/cycles、token/cache、estimated cost、failure taxonomy、reviewer/verifier
disagreement 與 infrastructure validity。

驗收：題目與 harness 全部有明確 include/exclude；失敗分為 model、task-outcome、
configuration、infrastructure；不因失敗重寫 gate 或選擇性刪除 trial。

停止政策：任何 infrastructure-invalid pattern 連續出現、估算成本達批次 ceiling、
setup／network 長時間異常，先停批並修正或提出 amendment；不得自動 retry 取代原始值。

預算權限：每批開始前由 preregistration 固定 ceiling；root agent 監控，超過 ceiling
或新增模型／harness／retry 必須停下。

需要使用者決策：是否接受下一批預算、是否納入 blocked/unknown 題、是否允許新的
derivative adaptation。

## Phase 4 — targeted cap 1/3

輸入：Phase 3 baseline 中有 harness disagreement、Full 使用多於一 cycle、或有
可觀察且可修復 failure signal 的題目。

每題跑 Full `maxCycles=1` 與 `maxCycles=3`，先 preregister 題目、配置、sample
數量、budget、stop policy。cap 是上限；第一輪通過不得強迫執行後續 cycle。

輸出：requested/effective maxCycles、actual cycles、first passing cycle、reviewer
actionability、external reward、成本與時間差異。

驗收：只有 runtime evidence 能證明 effective cap；reviewer pass 不可替代 verifier；
cap 3 只能解釋為條件性 evidence，不宣稱普遍最佳。

停止政策：三題皆第一輪通過時停止擴大 cap；cap 3 額外消耗但沒有 reward 增益時不升
cap 5；reviewer/verifier 不一致時轉 tool-update loop。

預算權限：只對 triage 選出的題目花費；不得把 cap 5/10 視為預設。新增 cap 或 retry
要 amendment。

需要使用者決策：是否接受 cap comparison ceiling、是否要研究 cap 5/10、是否允許
修改 public evidence runner。

## Phase 5 — repetitions and variance

輸入：Phase 3/4 結果與 failure taxonomy。採分層抽樣，不只重跑 pass 或 fail：每種
任務類型包含 pass、fail、harness disagreement 與 infrastructure risk 的代表題。

執行：同一 task × harness × config 先重跑 3 次；只有觀察到高變異且 budget 足夠時，
才 preregister 擴到 5 次。暫不預設 10 次。

輸出：pass frequency、success spread、wall/token/cost/cycle variance、harness
disagreement、reviewer/verifier disagreement、infrastructure-invalid rate。

驗收：每次 repetition 有 stable identity；排除與 retry 規則預先寫定；摘要可由 raw
artifact 重算；不把小樣本頻率寫成一般成功率。

停止政策：成本超 ceiling、同一 infrastructure blocker 重複三次或資料品質不一致即
停；先修資料／工具再決定是否延伸 sample。

預算權限：repetition 必須另有 sample-size 與 cost ceiling；root agent 不自行把 3
次擴成 5/10 次。

需要使用者決策：是否接受擴大 sample、是否要引入其他模型／provider、是否將結果
寫入公開 benchmark 報告或 cover letter。

## Phase 6 — tool update loop

輸入：跨 corpus 的 failure taxonomy、evidence/reviewer 行為、telemetry gaps、
setup/runtime 分段與 cost/variance。

執行：把缺口分成 telemetry、evidence runner、gate、workspace compatibility、
Harbor adapter、prompt/orchestration policy。每個修改先寫 spec，保留 before/after
對照；若 gate 會改 agent feedback，必須有 gate-off control 或明確排除。

輸出：tool update proposal/PR、regression fixtures、schema migration 或 new manifest
amendment；必要時回到 Phase 2 canary，再回到 Phase 3 baseline。

驗收：修改後通過完整測試；同一 raw artifact 仍可 read-only aggregate；不把更新後
結果與舊 baseline 混算；不因新 gate 成功就宣稱模型能力提升。

停止政策：若工具更新改變 acceptance、prompt feedback、task derivative 或成本模型，
停止原批並建立新 preregistration；未取得授權不得繼續跑模型。

預算權限：工程修改由 approved spec 控制；新 trial 由新 batch ceiling 控制，不能用
「下一步」名義隱含授權。

需要使用者決策：是否採用工具更新、是否重新跑受影響 baseline、是否接受公開敘事與
cover-letter wording。

## 目前入口與下一步

- 唯讀 inventory：`bin/harbor-corpus-inventory /absolute/path/to/corpus-root`
- Harbor preflight：`bin/harbor-preflight ...`
- artifact aggregate：`bin/harbor-aggregate ...`
- 目前完成到：Phase 0 inventory 與 Phase 1 compatibility triage 已完成；locked
  inventory digest 為 `d3a499e35e96a6163c1bb378161250f2c49b7c7c5d59aef64ecbd51ed1292bdd`，
  89 tasks／267 harness entries 的 matrix 與 Batch 0 recommendation 見
  `docs/benchmarks/terminal-bench-full-corpus-phase1-triage.md`、
  `config/harbor/terminal-bench-full-corpus-phase1-triage.json`。下一步是 Phase 2
  wheel、no-model preflight 與 evidence canary；尚未授權全 corpus 模型 trial。
- 任何模型 trial 需由 root agent 依本 roadmap 建立 batch preregistration 並監控；
  本文件不自動授權全 corpus 一次跑完。
