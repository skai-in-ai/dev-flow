---
repo: "/Users/skai.wu/side/agent-orchestrator"
status: draft
title: "Harbor / Terminal-Bench 2.1 evaluation 入口與跨 harness telemetry"
created_at: "2026-08-20T00:00:00+08:00"
---

# Harbor / Terminal-Bench 2.1 evaluation 入口與跨 harness telemetry

## 目標

為 dev-flow 增加第三個、供 Harbor / Terminal-Bench 2.1 使用的 evaluation 入口，讓外部 benchmark 的隔離 workspace、task instruction 與 verifier 能接到現有 core orchestrator；同時建立可跨 harness 比較的 telemetry 契約，量測成功率、每題消耗、每成功題成本、時間、cycle、gate 效果與失敗類型。

這份 draft 描述完整方向，但在下方未決事項收斂前不得標成 `approved`。第一個可執行增量的目標是建立可重現的 evaluation 基礎設施，並在明確授權的人工 smoke 中證明一題端到端路徑；不自動執行需要模型額度的 trial、不執行完整 benchmark，也不宣稱任何 Terminal-Bench 分數。

## 背景與決策

- 現有 `bin/dev-flow` 是直接在目前 working tree 執行 core orchestrator 的入口；`bin/dev-flow-worker` 是 GitHub Issue queue、isolated worktree 與 Draft PR 的包裝入口。兩者行為與交付邊界維持不變。
- 新入口只增加 Harbor adapter，並共用現有 `Orchestrator.run()`、Pi adapter、routing、cycle policy、review gates、`.orchestrator/runs/` ledger 與既有 report/summary 產物；不可複製另一套 orchestration loop。
- Harbor 負責建立隔離考場、注入 task instruction 與執行最終 verifier；dev-flow 負責解題流程。Harbor 的隱藏 verifier 不得被 agent 讀取或在解題期間取得結果。
- evaluation 先支援三種 harness：
  1. Harbor Codex CLI baseline：Harbor 既有的 Codex CLI agent 接頭，作為外部 harness baseline。
  2. Single Pi + Codex：使用與 dev-flow 相同的 Pi / Codex 路徑，但只執行一次 implementer，不使用 dev-flow reviewer、retry 或 final reviewer。
  3. Full dev-flow：使用現有完整流程，包括 deterministic tests、reviewer、現有 routing、retry 與 tier gates。
- 後續可用同一套資料契約增加 `no-review` 或其他 ablation；本 spec 不要求先改造 production core 以支援所有 ablation 開關。
- 「prompt cache」與「session reuse」是不同實驗因素：
  - prompt cache 是 provider 依請求前綴自動提供的 cache read/write 行為；即使 Pi 每輪是新 session 也可能命中，是否命中由 provider usage 回報決定。
  - session reuse 是同一個 implementer Pi session/process 或明確 continuation 是否跨 cycle 延續。現況是每個 role 使用新的 Pi session；production 行為先不改。
- research 可探索 `maxFixCycles` 為 0、1、2、3、5、10。這個數字沿用現有語意，代表「最多修正次數」，因此 3 仍是最多四次實作；production 預設三次修正不變。研究結果可能支持固定上限或條件式停止，但不得先把研究配置當成 production policy。
- 現有相同失敗熔斷會在連續兩個 cycle 的 finding 完全相同時提前停止；`maxFixCycles=5/10` 只代表上限，不保證實際跑到該輪。若研究問題是「強制延長是否仍可救回」，必須另設僅供 benchmark 的明示配置並獨立標記，不能靜默關閉 production 熔斷或把兩種停止政策混為同一組結果。
- 每個 cycle 都要保存可還原的候選 workspace / diff snapshot；所有 snapshot 的 Harbor verifier 評分在 trial 完成、agent 已停止後離線執行，結果不得回饋當時的 agent prompt、decision log 或下一個 cycle。
- `estimated_cost_usd` 只能在有可信 usage 與定價換算時填寫；訂閱模式沒有實際帳單扣款資料時，`actual_cost_usd` 必須為 `null`，原始 token、呼叫數、時間與 rate-limit 事件仍可比較。
- 本文件是避免方向漂移的 umbrella draft，不應整份一次交給 dev-flow。未決事項收斂後拆成至少兩份可執行 spec：A. Harbor capability spike（版本、auth、workspace、可見測試、原生 Codex 一題與 snapshot verifier 能力，原則上不改 core）；B. 第三入口與 telemetry implementation（只使用 A 已驗證的介面）。比較實驗與付費 trials 是後續操作，不混進基礎設施 implementation diff。

## Invariants and non-goals

- 不修改現有 `bin/dev-flow` 或 `bin/dev-flow-worker` 的命令列語意、GitHub queue 行為、Draft PR 邊界、routing matrix、reviewer 工具 allowlist、`maxFixCycles` production 預設或 session isolation。
- Full dev-flow 必須呼叫現有 core；benchmark adapter 不得以第二套 loop 重寫 implement → tests → reviewer → retry。
- Harbor verifier 是外部評分邊界，不是 dev-flow 內部 deterministic test；不得把隱藏 verifier 內容、結果或答案注入 handoff、prompt、decision log 或 reviewer artifacts。
- benchmark workspace 的相容處理只能建立本題所需的暫時 baseline / Git 形狀與 handoff；不得另開長期維護的 task repo，不得修改 benchmark dataset 或隱藏測試。
- `.orchestrator/runs/` 與既有 Pi trace / usage 是原始事實來源；不得建立一套與 run ledger 平行、互相矛盾的成本帳本。
- `cache_read_tokens`、`cache_write_tokens`、`uncached_input_tokens`、token 或成本資料拿不到時必須明確存 `null`，不得以 0 或估算值冒充實測值。
- 不在自動測試或一般安裝流程中安裝 Harbor、執行模型 trial、提交官方 leaderboard、修改 production 預設輪數、改成 session reuse，或承諾完整 89 題 × 5 trials 已完成。真實一題 E2E 是需要另行明確授權與固定預算的人工驗證，不得由 `npm test` 偷跑。

## 修改範圍

- 新增 Harbor / Terminal-Bench evaluation adapter 與第三入口，位置依現有 `src/`、`bin/` 與 adapter 結構決定；實作不得修改現有兩個入口的行為。
- 新增 Harbor task instruction → dev-flow handoff / workspace compatibility 的薄層，處理本題暫時 workspace、baseline、可見測試與既有 orchestrator 前提；對不相容題型分類為 `harness_incompatibility`，不得繞過安全前提靜默放行。
- 新增跨 harness `BenchmarkTrialTelemetry`（或等價 TypeScript contract）與 normalizer/exporter，原始資料取自 `.orchestrator/runs/<run-id>/`、`index.jsonl`、Pi compact trace、usage、cycle artifacts、tests、review verdict、summary 與 Harbor trial result。
- telemetry 至少涵蓋以下欄位：
  - trial identity：`schemaVersion`、`trialId`、`taskId`、dataset / dataset revision、harness、model / reasoning effort、開始時間、duration。
  - configuration：`maxFixCycles`、reviewer / final reviewer / routing 是否啟用、timeout、fresh 或 reused session、是否使用 provider prompt cache（只記設定，不宣稱命中）。
  - result：Harbor reward、pass/fail、首次通過 cycle、最終 cycle、failure taxonomy、stop reason、verifier status。
  - usage：input/output/cache-read/cache-write/uncached-input tokens、model call count、`estimated_cost_usd`、`actual_cost_usd`（不可得為 `null`）、rate-limit / timeout 計數。
  - orchestration：cycles、每個 role / model、tier、routing decision、reviewer / final reviewer verdict、retry、escalation、deterministic test evidence。
  - cycle records：cycle 編號、候選 snapshot reference、diff statistics、tests、review finding fingerprint、cycle usage / duration / cost、是否救回、是否 regression、停止原因。
- 在先以 Harbor spike 確認可行介面後，新增每 cycle snapshot 的保存與 trial 結束後離線評分介面；snapshot 評分結果只能寫入 trial 的事後分析資料，不可在同一 trial 中回饋 agent。若 Harbor 無法對歷史 workspace 直接重跑 verifier，必須先回到討論收斂等價的隔離 replay 設計，不得由 implementer 自行發明或降低隔離。
- 新增測試／fake adapter，覆蓋第三入口、telemetry normalization、未知或缺失 usage 欄位、cache 欄位為 `null`、snapshot metadata、verifier 結果隔離與不改現有入口的 contract。
- 更新受影響的 `docs/overview.md`、`docs/modules/orchestration.md`、`docs/modules/pi-adapter.md`、`docs/rules/testing-and-safety.md`，說明第三入口、telemetry 來源、prompt cache 與 session reuse 差異、snapshot / offline verifier 邊界及尚未完成的 Harbor E2E 限制。
- 提供 evaluation 設定與操作文件，固定 smoke task 清單、dataset revision、模型、timeout、trial 數與預算欄位；設定不可把付費 benchmark 執行偷偷放進 `npm test` 或既有 dev-flow。

## 排除範圍

- 不修改 `bin/dev-flow`、`bin/dev-flow-worker` 的現有行為或 GitHub queue、worktree、branch、Draft PR、resume、push、merge、deploy。
- 不另開 repo、長期複製 Terminal-Bench tasks、修改 Harbor verifier、讀取隱藏測試或把 verifier 結果暴露給 agent。
- 不在本輪實作完整官方 leaderboard submission、結果上傳、89 題 × 5 trials、自動成本扣款或任何外部帳號／訂閱管理。
- 不把 Codex CLI baseline 的執行器誤當成 Pi harness；三種 harness 的差異必須在 telemetry 中明確標示。
- 不先改 production 的三次修正上限，不以 benchmark 結果直接開啟最多 5 或 10 次修正，不在本輪把 fresh implementer session 改成 reused session。
- 不要求所有題目都符合現有 Git repo / clean tree / deterministic tests 前提；不相容題目要被辨識、記錄並分類，而不是刪除安全 gate。
- 不將不可取得的 provider cache usage、美元成本、Harbor reward 或 verifier 詳情自行推算成實測資料。

## 驗收條件

- 新增第三個 Harbor evaluation 入口，可將一個 Harbor task instruction 送入指定 harness；Full dev-flow 路徑共用現有 core orchestrator，且既有兩個入口的測試與行為保持不變。
- 三種 harness 都能產生同一個跨 harness telemetry contract；不適用或 provider 未回報的欄位為 `null`，不會因某一 harness 缺少 reviewer 或 cache usage 而改變 schema。
- telemetry 能從既有 run ledger 對應到 `runId`、task / trial identity、model、cycle、tier、role usage、duration、cost、review verdict、routing、failure category 與 stop reason；不得依賴完整未壓縮 Pi event array。
- telemetry 明確區分 `cache_read_tokens`、`cache_write_tokens`、`uncached_input_tokens` 與 session mode；fresh session 不得被報成 session reuse，provider cache hit 也不得由 session mode 推論。
- production Full dev-flow 的預設 `maxFixCycles=3`、cycle 語意與現有三次修正政策不變；研究配置可表達 0/1/2/3/5/10，但只能由明確 benchmark config 傳入。
- Harbor spike 必須先證明或否證「歷史 cycle snapshot 可在 trial 結束後隔離評分」；介面確認後，每個候選 cycle 都保存可識別且可還原的 snapshot reference。若 spike 否證此能力，本 draft 維持未核准並回到討論，不以未驗證的自製 verifier 取代官方評分。
- Harbor verifier 結果在 agent trial 結束後才寫入 offline evaluation；測試能證明 verifier result 不出現在 agent request、decision log、reviewer artifact 或下一 cycle prompt 中。
- 能計算並輸出 success / reward、平均每題 usage、每成功題 usage / estimated cost、duration、cycle recovery / regression、review verdict 與 failure taxonomy；沒有可信美元價格時不輸出 `actual_cost_usd`。
- 能以固定設定文件描述至少三種 harness、模型、reasoning effort、timeout、dataset revision、task subset、trial 數、maxFixCycles 與 session mode；不會在安裝或 `npm test` 時自動執行付費 Harbor trial。
- 文件清楚說明漸進流程：一題 E2E → 固定 5 題 smoke → 10–15 題多 trials → 有價值才跑完整 89 題 × 5；並清楚標示本 spec 不包含付費執行。
- 既有完整測試、build 與 diff whitespace 檢查通過；新增測試移除第三入口、schema normalization 或隔離邏輯時應能失敗，證明 gate 不是只有文件。

## 測試要求

- `npm ci && npm test`
- `npm ci && npm run build`
- `git diff --check`

Harbor / Terminal-Bench 的真實 smoke 或付費 trial 只在明確的人工作業中執行，不列入 `npm test`；執行前必須固定 Harbor 版本、dataset revision、task IDs、模型、timeout 與預算，並將結果寫入外部 benchmark artifact。

## 風險

- Major：Harbor task workspace 未必是乾淨 Git repo、未必有 dev-flow 可用的 tests；若相容層硬湊前提，可能污染 benchmark 或把環境失敗誤報成模型失敗。應 fail closed 並分類 `harness_incompatibility` / `environment_failure`。
- Major：把 Harbor 隱藏 verifier 或中間 reward 回饋 agent 會造成 test leakage，所有 snapshot verifier 必須在 agent 完成後、隔離的 offline path 執行。
- Major：Full dev-flow、Single Pi 與 Codex CLI 同時改變模型、prompt、工具與 harness 時，結果無法歸因；telemetry 與 evaluation config 必須完整記錄這些變因。
- Major：Pi session reuse 可能降低重複 context 成本，也可能延續錯誤推理、造成 context drift 或與角色隔離衝突；在沒有獨立配置實驗前 production 維持 fresh session。
- Major：provider prompt cache 不是 Pi session reuse，且不同訂閱／模型可能不回報 cache usage；只能報原始可觀測欄位，不可把 estimated cache hit 當成事實。
- Major：多輪探索（尤其 5/10 次修正）會放大模型費用、timeout 與 regression；先用小 subset 探索，production 預設仍為三次修正，並保存每輪邊際收益。
- Major：Terminal-Bench 的 hidden verifier 與 dev-flow deterministic tests 不是同一套 gate；若只報最後 reward，可能掩蓋 reviewer false positive、false negative、retry regression 或不相容題型。
- Minor：訂閱模式可能沒有每 trial 的真實美元帳單，`estimated_cost_usd` 依賴模型定價快照；公開報告要同時保留 token、call count、duration 與 rate-limit evidence。
- Minor：snapshot 的還原格式、Harbor 是否可直接對歷史 workspace 重跑 verifier、以及 verifier 失敗的重現方式可能受 Harbor 版本限制；需在 smoke 前驗證，未支援時明確記錄限制。

## 未決事項

- 尚未決定並驗證 Harbor / Terminal-Bench 2.1 的固定版本、dataset revision、官方 task IDs、Harbor 執行命令與 Codex CLI baseline 的實際登入方式。
- 尚未決定 snapshot 在 Harbor 中的實際離線評分 API／CLI；需確認可在不回饋 agent 的前提下評估 cycle 0 至 cycle 10，或明確定義等價的隔離 evaluator。
- 尚未決定第三入口、telemetry normalizer、snapshot metadata 與 exporter 的最終檔案位置；實作需沿用目前 `src/`、`bin/`、`.orchestrator/runs/` 結構，不得為了草圖硬造平行 ledger。
- 尚未決定 Single Pi + Codex 要沿用現有 `PiProcessAdapter` 的哪個公開 contract，以及如何在不啟動 reviewer / retry 的情況下取得一致的 usage / trace。
- 尚未決定 provider 能否穩定回報 `cache_read_tokens`、`cache_write_tokens`、`uncached_input_tokens` 與 subscription 的成本換算；缺失欄位必須維持 `null`。
- 尚未決定 fresh / reused session 實驗的明確 session continuation API、可比較的 prompt prefix、context budget 與是否允許跨 cycle 變更 model。
- 尚未決定 5/10 輪探索是否保留現有相同失敗熔斷；若要研究強制延長，需定義 benchmark-only flag、telemetry 標記與公平對照，production 熔斷維持不變。
- 尚未決定第一批 5 題 smoke subset、每組 trial 數、整體預算上限、timeout、failure taxonomy 的最終分類規則，以及何種結果才算「有價值」而進入完整 89 題 × 5。
- 尚未決定後續 no-review ablation 是否需要 core 中的明確 feature flag；本 spec 先要求 telemetry schema 可表達該配置，但不先改 production 行為。
