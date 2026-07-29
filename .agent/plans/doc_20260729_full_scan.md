# Agent Orchestrator 文件工程計畫

本計畫記錄 2026-07-29 對 `agent-orchestrator` 的全量掃描、文件差距與執行範圍。

## 差距分析報告

### CLAUDE.md 狀態

- 不存在；缺少專案定位、文件導航、驗證指令與維護原則。

### 現有文件

- `README.md`：存在，描述 MVP 與 CLI 使用方式；依文件命令規則不納入修改。
- `docs/`：不存在。

### 缺少文件

| 路徑 | 理由 |
|:---|:---|
| `CLAUDE.md` | 子專案 AI 導航入口 |
| `docs/overview.md` | 專案定位、目前邊界與執行方式 |
| `docs/architecture.md` | 實際分層、資料流與目錄責任 |
| `docs/contracts/handoff.md` | handoff JSON 是 CLI 與 extension 的系統邊界 |
| `docs/modules/routing.md` | deterministic floor、model classifier 與 tier/model 對照 |
| `docs/modules/orchestration.md` | 三輪 review loop、升級與 ledger |
| `docs/modules/pi-adapter.md` | Pi 子程序隔離、工具權限與輸出解析 |
| `docs/modules/mobile-entrypoint.md` | `/orchestrate` extension 與 Remote Pi 手機入口 |
| `docs/rules/testing-and-safety.md` | 測試、Git、安全與部署限制 |

### 需更新文件

- 無既有 `CLAUDE.md` 或 `docs/` 文件可更新。

### 模組覆蓋率

- 已辨識模組：4 個
- 已有文件：0 個
- 覆蓋率：0%

## 文件計畫

| 步驟 | 目標 | 大綱 | 主要來源 | 工作量 |
|:---|:---|:---|:---|:---|
| 1 | `CLAUDE.md`、`docs/overview.md` | 定位、導航、邊界、快速開始 | `package.json`、`README.md`、`extensions/orchestrate.ts` | 小 |
| 2 | `docs/architecture.md`、`docs/contracts/handoff.md` | 分層、資料流、handoff 欄位與驗證 | `src/orchestrator.ts`、`src/handoff.ts`、`src/agents/contracts.ts` | 中 |
| 3 | `docs/modules/routing.md`、`docs/modules/orchestration.md` | tier 決策、模型矩陣、review loop | `src/routing.ts`、`src/models.ts`、`src/orchestrator.ts` | 中 |
| 4 | `docs/modules/pi-adapter.md`、`docs/modules/mobile-entrypoint.md` | 子程序隔離、工具權限、手機命令 | `src/adapters/pi/pi-process-adapter.ts`、`extensions/orchestrate.ts` | 中 |
| 5 | `docs/rules/testing-and-safety.md` | 驗證、禁止事項、部署與已知邊界 | `package.json`、測試檔、runtime source | 小 |

## 執行狀態

使用者已在同一請求中明確指示「部署後寫 pi 專案的 doc」，視為本計畫的執行核准。
