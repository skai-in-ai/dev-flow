---
repo: "/Users/skai.wu/side/agent-orchestrator"
status: approved
title: "Terminal-Bench full-corpus inventory and staged evaluation roadmap"
created_at: "2026-08-25T00:00:00+08:00"
---

# 目標

建立一條可稽核、分階段、可停止的 Terminal-Bench full-corpus 評測路徑。先以
唯讀 inventory 與 compatibility triage 盤點任務，再以固定 wheel、no-model
preflight、evidence canary 和 versioned manifests 逐批執行三種 harness，最後才
對有證據的差異題目做 cycle cap 與重複 trial。

# 背景與決策

目前 telemetry、Harbor bridge、`maxCycles` 和 public evidence runner 已在小批
實驗驗證。下一階段的目標是觀察完整 corpus 的任務類型、相容性、失敗形狀與變異度，
不是先挑題證明某個 cap。`bin/harbor-corpus-inventory` 只讀 corpus root，輸出
deterministic JSON；它不讀 solution、tests、verifier 內容，只保存受允許檔案的
內容 digest 與其他檔案 metadata。輸出的 `inventoryDigest` 是 inventory identity，
不是完整 source integrity；`sourceDigest` 明確為 `not-computed`，因 protected
content intentionally unread。

# Invariants and non-goals

- 不讀取 solution、tests 或 hidden verifier 的內容；不把 reward、verifier output
  或答案線索回饋給任何 agent。
- 不事後依結果改 public check、gate、task derivative 或 preregistration。
- source task 與 workspace-compatible derivative 分開記錄；derivative 不得當作
  leaderboard 或上游 dataset 結果。`inventoryDigest` 不可用來宣稱 source/derivative
  完整相等；真正 derivative canonical digest 沿用既有受控 compatibility 流程。
- inventory 與 preflight 不跑模型、不啟動 Docker、不下載、不修改 task。
- 每筆 trial 使用 versioned manifest、原始 artifact 與可重算的 read-only aggregator。
- actual billing 未取得時只報 estimated cost，`actualCostUsd` 保持 `null`。
- production dev-flow 兩個既有入口與 commit/push/merge/deploy 安全邊界不變。

# 修改範圍

- 新增 `src/benchmark/corpus-inventory.ts`、`bin/harbor-corpus-inventory` 與測試。
- 新增本 roadmap，並更新 benchmark backlog 與跨專案 in-flight index。
- Phase 2 之後如需改 bridge、telemetry、evidence runner、task derivative 或
  manifests，另立小 spec 或 preregistration amendment，保留原始 artifact。

# 排除範圍

- 本 spec 不授權模型、Docker、Harbor、網路、帳號登入、PR merge 或部署。
- 不在 inventory 階段執行 tests/verifier，不解析 solution，不建立 task-specific
  gate，不產生 leaderboard。
- 不預先承諾 cap 3、cap 5 或 cap 10 的優越性。

# 驗收條件

- inventory 對明確 corpus root 產生 deterministic、排序穩定、無 operator-local
  absolute path 的 JSON。
- JSON 使用 `inventoryDigest` 表示允許讀取範圍的 inventory identity，並以
  `sourceDigest.status = "not-computed"` 明確表示 protected source integrity 未計算；
  protected content 改變不得改變 inventoryDigest，允許讀取內容改變必須改變它。
- malformed task metadata、unknown CLI args、path escape、symlink escape 均 fail closed。
- inventory 的 indicators 與 public check candidates 僅標示可追溯的 observed clue；
  無證據欄位為 `null` 或空集合。
- solution/tests/verifier 內容不被讀取；測試以受限 fixture 驗證。
- roadmap 定義 Phase 0–6 的輸入、輸出、acceptance、stop policy、budget authority
  與需要使用者決策的節點。

# 測試要求

- `npm test`
- `npm run build`
- `git diff --check`

# 風險

- corpus layout 或 task.toml schema 變動時，inventory 應停止並要求新增 parser
  evidence，不猜測欄位。
- Docker build、套件下載、長任務與 provider cache 可能造成基礎設施失敗；需與
  model/task failure 分類，不能混入成功率。
- full-corpus 成本與 runtime 可能超出預算；每一批開始前必須重算 estimated
  ceiling，達到停止條件即停。

# 未決事項

無
