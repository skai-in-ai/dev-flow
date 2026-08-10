# 與 GSD Pi 的關係與重疊

對照對象：[open-gsd/gsd-pi](https://github.com/open-gsd/gsd-pi)（`@opengsd/gsd-pi` v1.14.0，MIT）。

**這不是競品分析，是上游分析。** dev-flow 的每個 role 都是 spawn `pi` child process（見 `docs/modules/pi-adapter.md`），而 `pi` 就在 gsd-pi 這個 monorepo 裡（`packages/pi-coding-agent`、`packages/pi-agent-core`、`packages/pi-ai`）。dev-flow 建在它上面。

同時，gsd-pi 已經長出 `gsd-orchestrator`：一個 skill，內容是「寫 spec → 啟動 headless build → poll → 處理 blocker → 追成本 → 驗收」。那正是 dev-flow 核心迴圈的形狀。所以重疊是真的，而且是上游往下游的方向長過來。

另有兩個叫 Orca 的專案的對照，見 [orca-comparison.md](orca-comparison.md)。

---

## 一、確認過的事實

| 項目 | 證據 |
|:---|:---|
| gsd-pi 內含 pi coding agent | `packages/pi-coding-agent`（`@gsd/pi-coding-agent` 1.14.0）、`packages/pi-agent-core`、`packages/pi-ai` |
| dev-flow 依賴 pi | `pi --mode json --model <m> --thinking <l> --session-dir <dir> --no-extensions`（`docs/modules/pi-adapter.md`） |
| 本機 pi 版本 | 0.82.1（homebrew） |
| gsd-pi 的 orchestrator 是 skill | `gsd-orchestrator/SKILL.md`，218 行，配三個 workflow：`build-from-spec`、`monitor-and-poll`、`step-by-step` |
| 體量 | 5,521 files、97 MB、TUI + web + electron studio + mobile + vscode extension + docker sandbox |

gsd-pi 的自我定位：

> gsd-pi is the orchestration layer between you and AI coding agents. It handles planning, execution, verification, and shipping so you can focus on what to build, not how to wrangle the tools.

它的 VISION 裡有一條值得注意的原則：

> **Heavy orchestration layers.** Don't duplicate what the agent infrastructure already provides. Build on top of it, don't wrap it.

也就是說，重的編排層是他們明文不收的 PR 類型。這對 dev-flow 是好消息也是壞消息：好消息是核心不會無限膨脹；壞消息是 orchestrator 該有的能力會以 skill 與 extension 的形式進來，而 skill 正是 dev-flow 的形狀。

---

## 二、重疊的部分

以下每一項 gsd-orchestrator 都已經有了。

1. **spec 當輸入**。`gsd headless --context spec.md new-milestone --auto`，且 `templates/spec.md` 規定了 What／Requirements／Technical Constraints／Out of Scope 四段。dev-flow 的 spec contract 更嚴（`status: approved`、零未決事項、raw executable tests），但形狀相同。
2. **headless subprocess + JSON + exit code**。`--output-format json`，exit code `0` 成功、`1` 錯誤、`10` blocked、`11` cancelled。dev-flow 的 `ready_for_main`／`needs_human` 是同一個概念的兩態版本。
3. **poll 監控**。`workflows/monitor-and-poll.md`，用 `gsd headless query` 取快照（約 50 ms、無 LLM 成本）。dev-flow worker 的 300 秒 poll 是同一件事，只是輪詢對象是 GitHub 而非本機狀態。
4. **成本追蹤**。`query` 回傳 `cost.total`，skill 明文要求「Budget awareness. Set limits before launching long runs」。dev-flow 的 `.orchestrator/runs/*/summary.json` 有 per-role 拆分。
5. **中斷續跑**。`--resume <sessionId>`。dev-flow 有 same-Issue resume。
6. **worktree 隔離**。gsd-pi 宣稱 Worktree-aware Git automation，「Keep implementation work isolated while preserving a reviewable main checkout」。dev-flow 入口 A 每個 Issue 一個 worktree。
7. **專案記憶**。`.gsd/DECISIONS.md`（append-only）、`KNOWLEDGE.md`、`STATE.md`、milestone／slice／task 的 PLAN 與 SUMMARY。dev-flow 有 `decisions.json` 與 `report.md`。
8. **人工介入的出口**。exit 10 blocked、`steer <desc>` 中途硬轉向。dev-flow 有 `needs_human`、`needs_spec`、`/dev-flow resume`。

結論：**「用 spec 驅動、headless 跑、poll 狀態、追成本、卡住找人」這一整組能力，dev-flow 沒有一項是獨有的。** 撰寫專案說明時不應把它們描述成本專案特有的設計。

---

## 三、真正不同的地方

以下四項是查證過、目前站得住的差異。

### 1. 方向相反：專案建造器 vs 任務執行器

gsd-pi 的模型是 milestone → slice → task，`build-from-spec.md` 第一步是 `mkdir /tmp/my-project && git init`。它要解決的是**從無到有做出一個產品**，spec 描述的是整個產品。

dev-flow 在 `docs/overview.md` 明文拒絕這件事：

> **新專案的 0 到 1**：沒有 repo、沒有測試、沒有形狀。reviewer 會收到 `NO DETERMINISTIC TESTS CONFIGURED`，等於付了錢卻拿到沒有 gate 的 review，比不用更糟。

它的硬性前提是既有 Git repo、乾淨 working tree、已存在且有意義的測試命令、一份 spec 描述得完的增量變更。

這是兩個相反方向的最佳化。gsd-pi 從零長出東西，dev-flow 在已經長出來的東西上做受控修改。

### 2. reviewer 的獨立性

gsd-pi 的 auto mode 是同一個 agent 內部完成 plan、code、test、commit（`gsd-orchestrator/SKILL.md` 的 mental model：「The subprocess handles all planning, coding, testing, and git commits internally」）。它有 `code-review`、`review`、`verify-work`、`audit-*` 等指令，但那是同一個專案 agent 的另一個階段。

dev-flow 把 implementer 與 reviewer 拆成兩個沒有共享對話的 Pi process，而且工具權限不同：

| Role | Pi tools |
|:---|:---|
| Router | `--no-tools` |
| Reviewer / final reviewer | `read,grep,find,ls` |
| Implementer | `read,write,edit,bash,grep,find,ls` |

reviewer 沒有 write、edit、bash。它只能看，不能改，也不能自己跑測試來說服自己。這是 LLM-as-a-judge 的獨立性條件，不是效能考量。

### 3. 授權方向相反

gsd-orchestrator 的 answer injection 是為了讓 run 完全無人：

```json
{
  "questions": { "question_id": "selected_option" },
  "secrets": { "API_KEY": "sk-..." },
  "defaults": { "strategy": "first_option" }
}
```

`defaults.strategy` 預設 `first_option`，意思是沒對到的問題就選第一個選項繼續跑。

dev-flow 走的是反方向：spec 只要有未決事項就拒絕啟動（`assertRunnableSpec`），reviewer 發現缺的是產品決策時回 `needs_spec` 停下來，Issue 沒有人工加上 `dev-flow-ready` 就不會被 worker 看一眼。

兩者對「不確定性」的處置完全相反：一邊自動選第一個選項讓流程不中斷，一邊把不確定當成停止條件。這個對照很鋒利，因為它不是功能多寡，是價值取向。

### 4. 確定性 gate 的位置

dev-flow 在任何模型呼叫之前先跑 baseline preflight，測試不綠就拒絕啟動，模型成本為零；每輪測試結果一律由 shell exit code 決定，不由模型宣告。

gsd-pi 有 `verify-work`、UAT、`doctor` 等驗證能力，但驗證是 agent 流程的一個階段，`gsd-orchestrator` 的驗收指引是「Check deliverables, verify output」，由呼叫端自己判斷。我沒有在 skill 或 workflow 裡找到「測試不過就零成本拒絕啟動」這種前置硬 gate。

（**未完全查證**：我只讀了 `gsd-orchestrator/` 與 README／VISION，沒有讀 `src/` 與 `packages/gsd-agent-*` 的實作。這一項若要對外講，應先確認 auto mode 內部有沒有等價的前置檢查。）

---

## 四、對維護的影響

**pi 的 CLI 契約是目前最實際的風險。** dev-flow 依賴 `pi --mode json --thinking --session-dir --no-extensions --tools`；gsd-pi 主推的 bin 是 `gsd`，flags 完全不同（`--output-format`、`--bare`、`--answers`）。兩邊的 CLI 表面已經分岔，pi 的 flag 若在某次 release 變動，dev-flow 會靜默壞掉，而失敗會表現成一批莫名其妙的 needs-human 報告，根因要反推很久。

**建議**：worker 啟動時執行一次 `pi --version`，比對已知可用範圍，不符就拒絕啟動並寫進 log。價值不在預防，在於失敗時立刻知道原因。

**provider-neutral adapter 的優先序值得往前挪。** 原本排在 P1，理由是「不是核心定位」。現在多一個工程理由：唯一的 adapter 綁在一個正在快速變動的上游。

**可以直接借鑑的**：`gsd headless query` 那種「約 50 ms、無 LLM 成本」的狀態快照。dev-flow 目前要知道現況得去讀 ledger 檔案。做一個決定性的 `bin/dev-flow status` 成本極低，且對「人不在電腦前」這個使用情境直接有用。

---

## 出處與驗證狀態

- gsd-pi 的描述來自 2026-08-10 shallow clone 的 `README.md`、`VISION.md`、`gsd-orchestrator/SKILL.md`、`gsd-orchestrator/workflows/build-from-spec.md`、各 `packages/*/package.json`。**未讀 `src/` 與 `packages/gsd-agent-*` 的實作，未實際執行 `gsd`。**
- 第三節第 4 點（確定性 gate 的位置）是四項差異中唯一沒有完整查證的，對外引用前需先確認。
- dev-flow 的描述來自本 repo 的 `docs/overview.md`、`docs/modules/pi-adapter.md`、`README.md`。
