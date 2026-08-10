# 與 Orca 的對照

**先釐清：叫 Orca 的開源專案有兩個，而且是完全不同的東西。**

| 專案 | 是什麼 | 與 dev-flow 的關係 |
|:---|:---|:---|
| [stablyai/orca](https://github.com/stablyai/orca) | Agent Development Environment（ADE）。桌面與手機 App，把 prompt 分給多個 coding agent，各自在獨立 git worktree 執行，人比較結果挑贏家 | **互補**。它最佳化人在場時的操作體驗，dev-flow 最佳化人不在場時的自動驗證 |
| [VirtusLab/orca](https://github.com/VirtusLab/orca) | 可程式化的 AI development workflow framework。Scala 3 DSL 定義 flow，durable stage，內建 review-and-fix loop | **同型競品**。流程形狀最接近 dev-flow |

對外提到 Orca 一定要附連結，否則讀者會對到錯的專案。本文兩個都寫。

**本次改版的另一個原因**：上一版對照寫於入口 A 完成之前，當時 dev-flow 的終點一律是 `ready_for_main`，不 commit、不 push、不開 PR。該敘述現在只對入口 B 成立，入口 A 會 push `codex/issue-*` branch 並建立 Draft PR。所有「dev-flow 不碰 Git」的比較都已作廢。

---

## dev-flow 的現況（對照基準）

```text
approved spec / handoff
  → baseline test preflight（不過就拒絕啟動，零模型成本）
  → deterministic risk floor + Luna Medium classifier
  → Luna-first isolated implementer
  → actual diff reclassification（tier 只能升）
  → deterministic tests（exit code）
  → isolated reviewer（每輪全新 Pi session）
  → fix / escalate / needs_spec
  → ready_for_main 或 needs_human
```

兩條入口共用這個核心，差別在任務來源與成功後的交付：

- **入口 A**（GitHub Issue queue）：worker poll → claim → 隔離 worktree → 核心流程 → commit、push、Draft PR。不 merge、不 deploy。
- **入口 B**（Pi／CLI）：`/dev-flow` → 核心流程 → 變更留在 working tree。不 commit、不 push、不開 PR。

---

## 一、對照 stablyai/orca（ADE）

### 它是什麼

Agent Development Environment。核心賣點是 **Parallel Worktrees**：「Fan one prompt across five agents, each in its own isolated git worktree」，把同一個 prompt 同時交給多個 agent，各自在獨立 worktree 跑，人再比較輸出、挑一個 merge。

- 支援 30 多種 CLI agent（Claude Code、Codex、OpenCode、Pi、Cursor、Copilot、Grok、Cline、Devin、Goose 等）
- 桌面 App（macOS／Windows／Linux）加手機 companion App，可監看進度
- **Annotate AI-generated diffs**：commit 前在 diff 行上留註解
- 內建 GitHub 與 Linear 整合，可直接瀏覽 PR 與 issue
- **Design Mode**：透過 Chromium 檢視元素來下 UI 相關的 prompt
- `orca` CLI：`worktree create`、`snapshot`、`click`、`fill`
- MIT 授權

### 對照表

| 面向 | stablyai/orca | dev-flow |
|:---|:---|:---|
| 使用姿勢 | 人在電腦前，開 App 操作 | 人不在場，加 label 授權後離開 |
| 平行模型 | fan-out：同一個需求同時交給多個 agent | 序列：一次一張 Issue，前一個 PR 沒 merge 不放下一個 |
| worktree 用途 | 隔離多個競爭方案，供比較 | 隔離單一任務，並作為 resume 時的 provenance 依據 |
| 品質把關 | 人看 diff、標註、挑贏家 | deterministic tests 加 LLM judge 迴圈，自動修正 |
| agent 選擇 | 30 多種，使用者自選 | Pi adapter 一種，模型走固定的 luna／terra／sol 階梯 |
| 手機 | companion App 監看進度 | GitHub Issue 的 label 狀態，靠 GitHub 原生通知 |
| GitHub 整合 | 瀏覽 PR 與 issue 的介面 | Issue 是佇列、授權邊界與狀態機 |
| 交付 | 人工挑選後 merge | 自動 push branch + Draft PR，不 merge |

### 真正的差異：人在不在場

這兩個工具最佳化的是同一條開發流程的不同前提。

**Orca 假設人在場**。它的價值來自並行比較與人工挑選：五個方案同時跑，人看得快、選得準，所以總體比一個一個試更省時間。annotate diff、Design Mode、快速跨 worktree 搜尋，全都是為了讓「人在電腦前操作 agent」這件事更順手。

**dev-flow 假設人不在場**。它的價值來自把驗證責任交給確定性的 gate：測試由 exit code 判定，review 由獨立 session 執行，失敗就熔斷並標 `needs-human`，人回來只需要看結論。它不需要 GUI，因為人根本不在那裡看。

所以兩者不是替代關係。合理的組合是：**探索期用 Orca 這類 ADE 平行試方案，方案定下來、寫得出 spec 之後交給 dev-flow 跑驗證迴圈。**

### 值得借鑑的

1. **手機端的狀態呈現**。Orca 有 companion App，dev-flow 目前靠 GitHub label 加原生通知。這個選擇是對的（零維護、任何看得到 GitHub 的東西都能讀），但 label 只能表達狀態，表達不了進度。如果要補，方向是把 `report.md` 的摘要寫進 Issue comment，不是做 App。
2. **diff 標註作為 resume 的輸入**。Orca 讓人在 diff 上留註解。dev-flow 的 resume 目前只吃一行決策字串（且有 512 字元上限）。「在 PR 的某一行留 comment，resume 時當作 finding 帶進去」是相同能力的低成本版本，且完全走 GitHub 既有介面。

### 不建議借鑑的

- **fan-out 平行方案**。它跟 dev-flow 的成本模型相衝：dev-flow 的省錢邏輯是「便宜模型加確定性 gate，一次做對」，fan-out 是「同時做五份，丟掉四份」。後者在人在場、能快速判斷時划算，在無人在場、要靠自動 gate 篩選時只是把成本乘五。
- **GUI**。做了就等於承認人要在電腦前。

---

## 二、對照 VirtusLab/orca（workflow framework）

流程形狀上真正的近親。兩者都在跑「實作 → 獨立 reviewer 審查 → findings 回給 implementer → 自動修正 → 重新審查」。

### 它是什麼

自我定位是 Deterministic, AI-driven development flows。用 Scala 3 寫 flow script，`scala-cli` 一個命令執行。

```text
prompt
  → planning agent 拆成 tasks（Plan.autonomous / Plan.interactive）
  → durable implementer session
  → 每個 task 一個 stage
      └─ reviewAndFixLoop（picker 選 reviewer → 平行 review → fix → re-review）
  → 每個 stage 產生一個 git commit + progress log
  → push stage
  → gh.createPr
```

stage 是可恢復的原子單位：完成時把結果與程式碼一起 commit，重跑同一 flow 會自動跳過，從第一個未完成的 stage 續跑。編譯期檢查「所有有副作用的呼叫都必須在 stage body 內」。

### 對照表

| 面向 | VirtusLab/orca | dev-flow |
|:---|:---|:---|
| 流程定義 | Scala 3 DSL，使用者自行組合 | 固定流程，只開放有限設定 |
| 執行單位 | stage，每個 stage 一個 commit | cycle，run 結束才交付 |
| 中斷續跑 | durable stage runtime，重跑自動跳過已完成 stage | 入口 A 的 same-Issue resume，需人工授權 comment |
| reviewer 記憶 | resume 同一個 reviewer chat session | 每輪全新 session，只帶 `decisions.json` |
| reviewer 數量 | 8 個 canonical lens，picker 選本輪跑誰，平行執行 | 單一 reviewer，tier 決定它是誰 |
| findings 結構 | `ReviewIssue`：severity、`Confidence`(0~1)、title、description，配 `ConfidenceGate.default (0.5/0.6/0.8)` | severity 分級 + `file:line`，無 confidence gate |
| 迭代上限 | `maxIterations = 3`（最多四輪評估） | 最多三次修正、四次實作，另有相同失敗熔斷 |
| 停止條件 | reviewer 全清、fixer 表示沒修東西、達上限 | 同左三項，另加 `needs_spec` 與 max-tier 邊界 |
| 測試 gate | `test` 存在於 stack settings 但 review loop 不自動消費；lint 輸出交給便宜 LLM 整理成 findings | baseline preflight + 每輪 deterministic tests，一律由 exit code 決定 |
| backend | Claude、Codex、OpenCode、Pi、Gemini，可依 role 分別指定 | Pi adapter 一種 |
| Git 寫入 | 內建 branch、commit、push、PR、CI 等待，由使用者放進 stage | 入口 A：push branch + Draft PR。入口 B：完全不碰 |
| GitHub Issue | `gh.readIssue` 當 flow 的輸入來源 | Issue 是佇列與人工核准邊界，狀態寫回 label |
| 沙箱 | 明確要求在 sandbox 執行（預設 `ToolSet.Full` + `AutoApprove.All`），提供 ReadOnly／NetworkOnly／Full | 無 OS sandbox。隔離靠 git worktree 與獨立 Pi session，implementer 仍有 `bash` |

### 這次改版讓差異縮小的地方

1. **Git 交付不再是分界**。兩邊都會 commit、push、開 PR。差別退化成「交付到哪一格為止」：VirtusLab 由 flow 作者決定（可做到 CI 等待與 PR 更新），dev-flow 固定停在 Draft PR，且寫死不開放設定。
2. **GitHub Issue 不再是 dev-flow 獨有的入口**。VirtusLab 有 `gh.readIssue`、`gh.readIssueComments`、`gh.upsertComment`。差別在職責：它把 Issue 當**輸入來源**，dev-flow 把 Issue 當**授權邊界與狀態機**。`dev-flow-ready` 是人工核准的動作，`running`／`pr-ready`／`needs-human`／`resume` 是對外可見狀態。
3. **續跑不再是它獨有**。dev-flow 有 same-Issue resume。但模型不同：VirtusLab 是 runtime feature，重跑同一命令自動接續；dev-flow 需要具寫入權限者留授權 comment，並逐字比對 worktree path、origin、branch、HEAD 與 Git state，provenance 不可信就不執行。前者追求少重做，後者追求不在無人在場時做出未經授權的動作。

### 仍然成立的差異

**1. 框架大小本身是設計選擇。** VirtusLab 要求使用者寫 Scala flow，表達力完整，代價是先學一套 DSL 與 stage 模型，流程正確與否由使用者負責。dev-flow 不開放 flow graph，只開放 tests、constraints、max tier、max cycles。判準是：一件事簡單就做得完，不值得為它扛一整套框架。這也讓流程小到作者本人能讀懂每一步。

**2. Fresh judge + explicit memory。** VirtusLab 為每個 reviewer 保存 chat session，下一輪 resume 同一段對話，帶入新 diff 與 fixer 拒絕處理的理由，但不告訴 reviewer 哪些宣稱已修好。優點是脈絡厚、resume 較省；風險是 anchoring 與 phantom findings（它自己對 lint summarizer 做了額外處理來避開）。dev-flow 每輪全新 session，只帶 `decisions.json` 的歷史 findings、implementer response 與理由。

> 我不讓 reviewer 延續上一輪的 session，但也不讓它失憶。每輪都重開一個乾淨的 judge，只把 findings、解法和理由帶進下一輪。

**3. 測試結果不經過 LLM。** VirtusLab 的 `reviewAndFixLoop` 跑 lint 後把 exit code 與輸出交給便宜模型整理成 findings；`test` 預設不被 review loop 消費。dev-flow 把兩件事切開且不開放設定：測試通過與否一律由 exit code 決定，且在任何模型呼叫前先跑 baseline preflight，不綠就拒絕啟動，模型成本為零。

不能寫成「Orca 沒有 deterministic validation」。準確的說法是：**它讓使用者自己決定 gate 放哪；dev-flow 預設就把 deterministic tests 設成不可跳過的邊界。**

**4. 需求不完整是合法終局。** VirtusLab 的 review loop 輸出是 `ReviewIssue`、`FixOutcome`、`IgnoredIssues`，沒有對應 `needs_spec` 的結構化終局。dev-flow 在 reviewer 發現缺的是產品決策而非程式碼時會停止開發，把缺口與候選答案寫回 spec 交還 supervisor。

**5. 模型階梯是流程政策的一部分。** VirtusLab 的成本策略偏向減少 session 重建、縮小 prompt、減少 reviewer 數量與 turn。dev-flow 把模型能力綁進流程政策：deterministic floor 決定下限，implementer 依失敗 cycle 升級，實作完成後用 actual diff 再判一次且 tier 只能升，預設 `max-tier 1`，Sol final review 移到迴圈外。

不要拿 dev-flow 的單次成本跟它公開過的失敗 flow 成本（US$44.64、約 340 turns）直接比。任務、模型、流程長度、reviewer 數量都不同。

**6. 責任分層。** 這是整個設計的底層邏輯：

> 昂貴的深度推理集中在需求確認階段，不需要在每一輪 implementation 和 review 裡重複支付。

- **Supervisor** 負責高不確定性：需求澄清、產品決策、範圍控制、acceptance criteria、判斷真正的卡點。
- **dev-flow** 負責低不確定性：實作、跑測試、依 diff review、修正 findings、驗證是否完成。

VirtusLab 把 planning 也放進 flow（`Plan.autonomous`／`Plan.interactive`，後者能主動 `ask_user`）。dev-flow 刻意留在外面，因為它的安全模型建立在「spec 已經穩定」這個前提上。

---

## 三、值得借鑑的（依優先序）

原則：**引入能提高可靠性與可驗證性的能力，不引入只是增加流程自由度的能力。**

### P0

1. **固定 benchmark 與成本量測**。同一組任務跑 Luna-first 與強模型流程對照，追蹤 success rate、首次通過率、平均修正 cycle、總 token、總成本、wall-clock、human intervention rate、escalation rate、regression rate、最終未解決 findings。在有這組資料前，「不用最強模型」是合理的設計假設；有了才是技術證據。
2. **finding／resolution／rationale 正式 schema**。最小欄位：`id`、`source`、`cycle`、`severity`、`claim`、`evidence(file/line)`、`resolution`、`rationale`、`status`。不建議照抄數值 confidence，LLM 自報的 0.71 與 0.76 未必有統計意義。先做 severity、evidence、actionability 三維。
3. **implementer 回傳 fixed／ignored／reason 的結構化輸出**。VirtusLab 只有 fixer 真的回報至少一個 fixed 才重新 review，沒修就停止，避免空轉；未處理的 finding 不會消失。不增加 agent 數量、不增加流程自由度，但大幅提升 decision memory 品質。
4. **large diff budget**。只截斷是危險的，reviewer 會以為看到了完整修改。應回報：payload 含哪些檔案、省略哪些、各自修改行數、是否因預算而不完整。超出時可選 `needs_human`、升 tier、或分批 review。
5. **輕量 resumability**。不必照抄 stage-per-commit。先做 `checkpoint.json` 記錄 `last_completed_stage`、`spec_hash`、`base_commit`、`current_diff_hash`、`test_result_hash`、`decision_log_version`，恢復前全部比對，不符就要求重跑。保留「不自動 commit」的邊界，同時避免一次中斷就從頭付錢。
6. **模型選擇理由寫進 report**。不只記 `reviewer = Luna High`，還要記為什麼（deterministic floor、changed files、先前失敗 cycle、max tier）與升級觸發條件。這直接支撐「強模型由風險與失敗證據觸發」的主張。

### P1（有價值，先不進核心）

- **relative regression baseline**：現行 strict baseline 最安全。未來可加選用的 regression 模式只擋新增失敗，但 regression matching 本身很複雜（測試名稱不穩、ordering 變動、snapshot 大量差異、flaky），遇到 legacy repo 需求再說。
- **風險觸發的 specialist reviewer**：不要搬八個 lens 全家桶。維持單一 general reviewer，只在 deterministic risk flag 命中時加開一個（auth 對 security、async/lock/transaction 對 concurrency、schema/migration 對 data、cache/query/loop 對 performance）。不需要 picker agent，也不需要跨 reviewer findings dedup。
- **PR 行內 comment 作為 resume 輸入**：走 GitHub 既有介面，成本低，且解掉現行 resume 只能吃一行決策字串的限制。
- **provider-neutral adapter**：先讓 Pi 穩定，再加 Codex CLI、Claude Code、OpenCode。workflow policy 仍由 dev-flow 控制。
- **Max escape hatch**：讓論點從「我不用最強模型」升級成「我不為每個任務預付最強模型的成本，只有證據顯示需要時才用」。

### 不建議借鑑

1. **Flow DSL**。開放任意 flow graph 會直接消除 dev-flow 的產品差異，而且 VirtusLab 已經做得很完整。
2. **保留 reviewer conversation**。fresh reviewer 加顯式 decision log 是最有辨識度的設計，不該為了模仿而拿掉。
3. **預設跑多 reviewer**。同時破壞低成本、低延遲、低複雜度與 findings 的可理解性。
4. **fan-out 平行方案**。與 dev-flow 的成本模型相衝，見上。
5. **GUI**。做了等於承認人要在電腦前。
6. **自動 merge 或 deploy**。再往前一步就從 verified development flow 變成 Git delivery platform，接著要處理 branch naming、concurrent runs、remote rejection、CI 狀態、stale branch、merge conflict、rollback、權限範圍。
7. **自動猜測 test 命令**。測試命令必須由 supervisor、spec 或 repo 明確提供。自己猜測試命令又自己判定完成，責任邊界就糊掉了。

---

## 出處與驗證狀態

- stablyai/orca 與 VirtusLab/orca 的描述均來自 2026-08-10 讀取的 GitHub 專案說明，未讀原始碼、未實際執行。細節（confidence 門檻數值、reviewer picker 實作、lint 三態參數、Orca CLI 指令集）若要對外引用，發布前應重新核對。
- dev-flow 的描述來自本 repo 的 `README.md`、`docs/overview.md`、`docs/modules/github-issue-queue.md`、`docs/multi-worker.md` 與 `src/models.ts`。
- 本文不含成本數字。成本量測的單一出處是 `README.md` 的成本一節與 `src/models.ts` 的 `DEFAULT_MAX_TIER` 註解，兩處共用同一批量測，重新量測時一起改。
