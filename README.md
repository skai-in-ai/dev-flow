# dev-flow

**把「需求已經確認之後」的開發、驗證與回饋循環自動化。** 這個專案的目標不是再做一個 coding agent。

## 它解決什麼問題

用 coding agent 寫東西時，模型很少是瓶頸。瓶頸是人得一直當中間人：

1. 把需求交給實作者。
2. 檢查實作有沒有偏離需求。
3. 執行測試。
4. 把 review 意見貼回實作者。
5. 判斷這件事是不是該換更強（更貴）的模型。
6. 整理每一輪到底發現了什麼、改了什麼、為什麼保留。

這六件事單獨看都不難，但它們會在每一次修正循環重複一遍，而且**沒有一件需要你的判斷力** —— 需要判斷力的是第一步之前（要做什麼）和最後一步之後（這個結果收不收）。中間全是搬運。

更麻煩的是第 6 點。每個 review 都是新的 session，看不到前幾輪的脈絡，於是同一個疑慮會被重新提出來，而上一輪已經做過的取捨裁決會消失。人不補這個記憶，循環就會原地打轉。

dev-flow 把中間那段變成一個可重複執行、可稽核、會累積記憶的閉環，並且**刻意保留兩端的人工邊界**。

## 整體流程

```text
人 ↔ Supervisor（Claude Code / Pi，人在哪就在哪）
      │
      │ 討論到需求收斂，呼叫一次 /dev-flow
      ▼
┌─ dev-flow ─────────────────────────────┐
│  baseline 測試預檢（不過就零成本拒絕）    │
│  risk routing（deterministic + 模型）    │
│  implement（隔離 session）               │
│  依實際 diff 重新評估風險（只升不降）      │
│  deterministic tests（程式判定，非模型）  │
│  isolated review（唯讀，另一個 session）  │
│  ├─ pass    → 收斂                       │
│  ├─ fail    → 帶著累積 findings 再修一輪  │
│  ├─ escalate→ 升 tier 原地重審           │
│  └─ needs_spec → 缺口寫回 spec，回到討論  │
└────────────────────────────────────────┘
      │
      ├─ ready_for_main ─→ 人接收 diff（CLI/Pi 到此為止，不 commit）
      └─ needs_human ────→ 保留現場，等人決定
                              │
                    （GitHub queue 專有）
                              ▼
                  人在原 Issue 留 resume 決策
                              ▼
                    從保留的現場增量續跑
```

最多三次修正（共四次實作）。升 tier 與 `needs_spec` 不消耗額度；相同失敗連續兩輪直接熔斷，不把剩下的額度燒完。

**兩條入口的差別只在交付邊界：**

| 入口 | 觸發 | 終點 |
|:---|:---|:---|
| CLI / Pi（`/dev-flow`、`bin/dev-flow`） | 人在 session 裡呼叫 | 停在 `ready_for_main`，**不 commit、不 push、不碰 main** |
| GitHub Issue queue（`bin/dev-flow-worker`） | 人在 Issue 加 `dev-flow-ready` label | 同一套 gate 全過後 push 隔離 branch + 開 Draft PR，**不 merge、不部署** |

回到人手上的情況只有這幾種：需求或產品語意沒定義完整、reviewer 要求的風險超過允許上限、相同問題重複出現、修正額度用盡、runtime 例外，或流程完成等你收 diff。

> 作者已將它用於十多輪實際開發流程，目前運作正常；但它仍是持續演進中的 experimental MVP，不應被視為已完成的大規模 benchmark 或無人監督的生產系統。

開源的目的有兩個：**促進 agentic development workflow 的技術討論，以及展示一套可實際運作的低成本 orchestration 設計。**

## 核心特色

### 1. Supervisor → dev-flow 的簡單分派

主要使用方式是在主討論 session 中先確認需求，再輸入：

```text
/dev-flow
```

supervisor 會將已確認的需求整理成 spec；資訊完整時自動啟動流程，資訊不足時則停在討論階段並提出缺少的問題。

人主要負責前後兩端：

- **前段**：確認目標、範圍、驗收條件、測試命令與重要取捨。
- **中段**：通常不介入，由 orchestrator 完成實作、測試、review 和修正。
- **後段**：接收 `ready_for_main`，或處理 `needs_human` 提出的真正卡點。

### 2. 自動化 LLM-as-a-Judge 開發閉環

implementer 完成變更後，reviewer 會根據原始需求、實際 diff、測試結果、repo rules 與歷史 decision log 進行獨立審查。

review verdict 可能是：

- `pass`：通過該風險層級的審查。
- `fail`：將 findings 回傳 implementer 修正。
- `escalate`：不重新實作，直接提高 reviewer 等級重審。
- `needs_spec`：問題不在程式碼，而是需求缺少產品語意，回到人工討論。

最多允許三次修正，共四次實作。最後一次修正仍會完整跑完 tests 與 review gates。

### 3. Context isolation + 跨 cycle memory

implementer、reviewer 與 final reviewer 每次都是新的 Pi child-process session，不共享原始對話，避免 reviewer 被 implementer 的推理與自我辯護影響。

但完全隔離會帶來另一個問題：每一輪都可能失憶，重新提出已處理過的疑慮。

因此本專案維護一個跨 cycle 的 decision log：

- reviewer / tests 發現的 **findings**
- finding 的來源與使用模型
- implementer 對上一輪 findings 的 **回應**
- 回應中描述的解法、取捨與理由

這份歷史會以 `decision_log` artifact 同時提供給下一輪 implementer、reviewer 和 final reviewer。

```text
Cycle 1
  Reviewer finding
  → Implementer resolution + rationale

Cycle 2
  新 reviewer 讀取前一輪 decision log
  → 驗證問題是否真的解決
  → 不把已討論的 trade-off 當成全新問題
```

也就是同時保留：

```text
session isolation
+
cross-cycle memory
```

目前 memory 的實體是 run 內的 `decisions.json` 與 prompt 中的 `decision_log` artifact。它保存歷史，但不擅自宣告某個 finding 已被「推翻」；不同 reviewer 對同一問題的不同觀察都會保留。

### 4. Deterministic tests，不讓 LLM 判斷測試是否通過

測試命令由 spec、handoff 或 repo config 提供，直接由 shell 執行。是否通過取決於 exit code，而不是模型的文字判斷。

在任何模型呼叫前，流程會先對乾淨 baseline 執行測試：

- baseline 已失敗：立即停止，模型成本為零。
- baseline 通過：才開始 routing 和 implementation。

這可避免把既有環境問題誤認為本次實作缺陷，白白消耗多輪模型呼叫。

### 5. Hybrid risk routing

風險等級同時由兩套機制判斷：

- deterministic rules 提供不可降低的 safety floor。
- Luna Medium classifier 補充語意風險判斷。

implementation 完成後，系統還會根據 **actual diff** 再判斷一次；tier 只能升高，不會因最初 handoff 看起來簡單就忽略實際高風險變更。

### 6. Luna-first 的低成本模型階梯

模型不會一開始全部使用最昂貴的等級。

Implementer 依修正 cycle 升級：

| Cycle | Model |
|:---:|:---|
| 1 | Luna Medium |
| 2 | Luna High |
| 3 | Luna High |
| 4 | Terra Medium；`--max-tier < 2` 時不升級 |

Reviewer 依風險 tier 選擇：

| Tier | Reviewer | Final review |
|:---:|:---|:---|
| 0 | Luna Low | 不執行 |
| 1 | Luna High | 預設不在迴圈內執行 Sol |
| 2 | Terra Medium | Sol Medium |

預設 `--max-tier 1`，高風險任務可顯式指定：

```bash
bin/dev-flow --max-tier 2
```

在 2026-08-03、單一 codebase 的 8 個實際 run 中，review 佔總支出的 79%，implementer 只佔 16%。將預設 reviewer 改為 Luna High 並把 Sol 移出一般迴圈後，該批 run 的 tier 1 單次成本約為 US$0.023；tier 2 約為 US$0.10～0.21。

這不是對照實驗，也不是可直接外推的 benchmark。它的意義是：**先量測每個角色真正花了多少，再決定模型放在哪裡，而不是憑直覺只降低 implementer 成本。**

### 7. 可追溯的 run ledger

每次 run 都會在目標 repo 的 `.orchestrator/` 保存必要 artifacts，包括：

- spec / handoff snapshot
- 每輪 actual diff
- routing 結果
- deterministic test output
- agent session metadata 與原始 events path
- decisions / findings / implementer responses
- 依角色拆分的成本
- 最終 `report.md`

`report.md` 是決定性渲染，不呼叫模型。它會列出狀態、tier、cycle、花費、耗時、尚未解決的 findings、逐輪歷史與下一步建議；report 與 ledger 留在本機，僅作 non-public traceability artifacts，不是 PR body 的輸入。

### 8. 明確的人類介入邊界

流程不會為了追求「全自動」而猜測未定義的需求。

當 reviewer 判斷問題屬於產品語意缺口時，可以回傳 `needs_spec`，附上缺少的語意與候選答案。流程會停止並將問題寫回 spec，讓 supervisor 和人繼續討論，而不是叫 implementer 對未定義的需求盲目重試。

當修正 review finding 時，implementer 只需檢查同一個合理且可到達的 invariant 類別中的 sibling cases，並補上相關 regression tests；reviewer 會在同一輪批次檢查同類別、可到達且已核准的路徑，同時遵守明確 non-goals，不要求每個理論 sibling。這些界線由 handoff 的 optional `Invariants and non-goals` 欄位聲明；普通任務填 `none` 即可，legacy specs 不受影響。

`needs_human` 不只有一種 recovery path：

- 若 report 帶有 `needs_spec` / `specGap`，先澄清產品語意、更新 spec，再重跑；不需要建立 checkpoint。
- 若是乾淨 baseline 的 preflight 失敗，先修正環境或既有程式碼，再重跑；這也不是 checkpoint bridge 的情境。
- 只有在實作或 review 已經產生要保留的變更、且需要人工修正時，才先確認保留 worktree 的 provenance，建立 local checkpoint commit，再由人選擇 narrow fix，最後做 targeted follow-up review。這是手動 checkpoint bridge；不會自動 commit、push、restart 或 discard。

經 GitHub queue 執行時，同一件事有自動化版本：**Same-Issue Resume**。流程停在 `needs_human` 時，worker 會保留 worktree 與 branch，把現場狀態寫進 `.orchestrator/queue-provenance.json`，並在原 Issue 貼出一份繁體中文報告（未解 findings、上一輪實作回應、變更檔案、失敗驗證、成本）。你看完之後在同一個 Issue 留言：

```text
/dev-flow resume narrow fix 只改 X，不要動 Y
```

下一輪 poll 就會從**同一個現場**接著跑，而不是從頭重來。它要求三件事同時成立才動：Issue 帶 `dev-flow-resume`、留言者有 repository 寫入權限、留言時間晚於最新那則報告。三者有任一不成立，worker 直接跳過這個 Issue 去處理下一個，不留言也不改 label —— 等人回覆是靜止狀態，不是失敗，更不該每 300 秒洗版一次。

現場對不上（provenance 遺失、損壞，或 worktree 有沒被記錄的變動）就停在 needs-human 並附診斷。**沒有任何自動路徑會重建或捨棄你的現場**，那是人的決定。

### 9. 不自動 commit、push 或 merge

MVP 的完成狀態是：

```text
ready_for_main
```

它會保留 working tree 變更，但 orchestrator 本身不會自動 commit、push、建立 PR 或修改 main。

這讓本工具專注在「產生經過測試與 review 的變更」，而不是同時承擔發布權限。

### 10. 可選的 GitHub Issue queue

需要把已核准需求交給 Mac 自動處理時，可使用 `bin/dev-flow-worker`。它每次 poll 最多 claim 一個 Issue：由人加上 `dev-flow-ready` 的初次 Issue，或加上 `dev-flow-resume` 的原 Issue：

```text
ChatGPT 讀取 repo
  → 建立含 approved spec 的 Issue
  → 人加入 dev-flow-ready
  → Mac worker
  → isolated worktree + Luna-first dev-flow
  ├─ ready_for_main → codex/issue-<number>-<slug> branch + Draft PR → ChatGPT / 人 review PR
  └─ needs_human   → 保留 worktree + Issue 上的繁中報告
                      → 人留 /dev-flow resume narrow fix <說明>
                      → 從同一個現場續跑（回到上一行）
```

這是一般 CLI/Pi 流程以外的明確發布入口。只有 `ready_for_main` 且 deterministic tests 與 review gates 全部通過時，worker 才會對自己建立的隔離 branch commit、push 並建立 Draft PR；它不會 merge 或部署。非成功結果會標記為 `dev-flow-needs-human`、保留 ledger，並讓下一個 queue 項目繼續執行。

allowlist 的 checkout 必須使用 canonical repository name `dev-flow`：worker 會以 repo 名稱尋找同名目錄。若舊 checkout 仍叫 `agent-orchestrator`，請先改名；若不能改名，可在 workspace root 建立只讀相容 symlink（例如 `ln -s /path/to/agent-orchestrator /path/to/dev-flow`），不要複製出第二份工作樹。這些 `agent-orchestrator` package 與 `AGENT_ORCHESTRATOR_*` 環境變數名稱目前仍是相容名稱，待另行 migration，請勿因本文件改名而自行修改它們。

設定時必須提供 repo allowlist：

```bash
export DEV_FLOW_ALLOWED_REPOS=OWNER/REPOSITORY[,OWNER/OTHER]
export DEV_FLOW_WORKSPACE_ROOT=/Users/skai.wu/side # 預設值，也必須位於此根目錄之下
export DEV_FLOW_MAX_TIER=1                         # 選用，預設 1
export DEV_FLOW_QUEUE_LEDGER=/path/to/ledger        # 選用
```

allowlist 對應的 checkout 必須已存在於 workspace root 下、是 Git worktree，且 `origin` 必須與 `OWNER/REPOSITORY` 完全一致；同名但不同 owner 的 checkout 會被拒絕。worker 使用本機 atomic poll lock 避免同一台 Mac 重複 claim，並以 GitHub ref 的 atomic creation 防止跨 Mac 重複處理。`gh` 必須能讀寫 Issue、push branch、建立 pull request；先用 `gh auth status` 確認登入。

GitHub New Issue 提供桌面與 mobile web 都可使用的 **Dev-flow task** template（見 `.github/ISSUE_TEMPLATE/dev-flow.md`），並保留一般 blank Issues。它先建立 `status: draft` 的 draft；移除官方 `dev-flow-required` placeholders、填入 [approved template](examples/github-issue-template.md) 的 required sections 後，改為 `status: approved`，確認 raw、trusted shell tests 與 `Unresolved items: none`，再加入 `dev-flow-ready`。建立或編輯 Issue 不是 execution authorization；ready label 才是明確 queue gate，template 不會自動加 label，draft、空 required section 或官方 placeholder 都不會啟動 agent。parser 只做這些 deterministic checks，不會把任意文字（例如 `TODO` 或 `later`）判定為 semantic placeholder；語意完整度是獨立 Spec Gate 的責任。`max_tier` 必須存在；`Invariants and non-goals` 可省略，普通任務填 `none`。可先用以下方式做無副作用驗證：

```bash
DEV_FLOW_FAKE_ISSUES=/path/to/issues.json bin/dev-flow-worker --dry-run
```

`--dry-run` 不會呼叫 GitHub、建立 git worktree、commit、push 或建立 PR。Worker 範例每 300 秒 poll 一次，每次 poll 最多處理一個 Issue。排程可參考 [launchd 範例](deployment/dev-flow-worker.plist.example)；本專案不會自動安裝或載入它，請先檢查環境變數再手動啟用。

Issue 的 label lifecycle 是 `dev-flow-ready` → `dev-flow-running` → `dev-flow-pr-ready` / `dev-flow-needs-human`；恢復另需 `dev-flow-resume` 與授權協作者新留的 `/dev-flow resume narrow fix <說明>` comment。Claim identity 綁定 Issue number 與 attempt，前一 attempt 完成不阻擋下一 attempt。Resume 只重用通過 provenance 驗證的 retained worktree；provenance 遺失、損壞或 worktree 有無法解釋的變動就停在 needs-human，不自動重建也不捨棄。成功後只建立連回原 Issue 的 Draft PR，`ready_for_main` 或已發 PR 之後不可 resume。worktree 與 job ledger 會保留供診斷，不會自動清理。完整限制見 [GitHub Issue queue 模組文件](docs/modules/github-issue-queue.md)。

## 有對外 API 嗎？

**目前沒有。**

這個 repo 沒有提供 HTTP server、REST API、webhook endpoint 或對外服務程序。它目前是一個本機 process orchestrator，支援的入口是：

| 入口 | 用途 |
|:---|:---|
| `bin/dev-flow` | 從目前 repo 啟動最新 approved spec |
| `npm run orchestrate -- --spec ...` | 以指定 spec 啟動 |
| `npm run orchestrate -- --handoff ...` | 以 handoff JSON 啟動 |
| Pi extension `/dev-flow` | 從 supervisor session 整理 spec 並自動啟動 |
| Pi extension `/orchestrate` | 直接指定 handoff 或 repo 任務 |
| `bin/dev-flow-worker` | 可選的 GitHub Issue queue 單次 poll |

外部服務若要整合，目前需要呼叫 CLI，或自行在外層包一個 API service。HTTP API layer 尚未實作。

## 適用範圍

適合：

- 已存在且有測試的 Git repository。
- 需求可以整理成明確 spec 的中小型變更。
- 希望將實作、測試、review 和修正交給 agent 自動閉環。
- 希望保留跨輪次的 findings、解法與決策脈絡。
- 希望按實際風險與失敗證據才升級昂貴模型。

不適合：

- **新專案 0 到 1**：沒有穩定 repo、測試與可比較 diff。
- **大規模架構重寫**：diff 可能超出 prompt 預算，reviewer 無法完整看到變更。
- **需求還在邊做邊想**：應先留在 supervisor 的探索與討論階段。
- **沒有 meaningful deterministic tests 的專案**：review gate 的地基不足。
- **不受信任的 repo 或 spec**：implementer 擁有 shell 執行能力，請先隔離。

判斷方式很簡單：

> 這個變更能否由一份 spec 說清楚，並由固定測試命令驗證？

不能的話，代表它還不適合交給這條流程。

## 安裝與驗證

需求：

- Node.js
- 已安裝 Pi Coding Agent CLI
- Pi 已透過 Codex OAuth 登入

```bash
git clone git@github.com:skai-in-ai/dev-flow.git
cd dev-flow
npm install
npm test
```

`npm install` 只會建立此 repo 的 local `node_modules`，不需要全域 npm package。`npm install`、build 與測試不會自動安裝或載入 GitHub queue 的 LaunchAgent。

## 使用方式

### 方式一：日常 dev-flow

在目標 repo 中建立 approved spec，放在：

```text
.agent/specs/*.md
```

執行最新一份：

```bash
/path/to/dev-flow/bin/dev-flow
```

或指定 spec：

```bash
/path/to/dev-flow/bin/dev-flow path/to/spec.md
```

spec 尚未 approved 或仍有未決事項時，流程不會啟動，而是列出待處理問題。

### 方式二：從 supervisor session 呼叫

將 `extensions/orchestrate.ts` 連結或複製到 Pi workspace 的 `.pi/extensions/` 後 reload Pi。

在主 session 討論完成後輸入：

```text
/dev-flow
```

資訊完整時，extension 會保存 approved spec 並自動啟動隔離流程；資訊不足時則保存 draft / needs_clarification，並要求補充必要資訊。

也可以直接指定 handoff：

```text
/orchestrate /absolute/path/handoff.json
```

### GitHub queue LaunchAgent（Mac）

以下是手動安裝、檢查、reload 與移除範例；`id -u` 會使用目前登入使用者的 dynamic UID，不要改成固定的 501 或 502。先編輯 plist 中的 allowlist 與 checkout 路徑，再執行：

```bash
mkdir -p ~/Library/LaunchAgents
cp /path/to/dev-flow/deployment/dev-flow-worker.plist.example ~/Library/LaunchAgents/tw.lifestay.dev-flow-worker.plist
launchctl bootstrap gui/"$(id -u)" ~/Library/LaunchAgents/tw.lifestay.dev-flow-worker.plist
launchctl print gui/"$(id -u)"/tw.lifestay.dev-flow-worker
tail -n 50 /tmp/dev-flow-worker.out
tail -n 50 /tmp/dev-flow-worker.err
launchctl kickstart -k gui/"$(id -u)"/tw.lifestay.dev-flow-worker
launchctl bootout gui/"$(id -u)"/tw.lifestay.dev-flow-worker
rm ~/Library/LaunchAgents/tw.lifestay.dev-flow-worker.plist
```

`npm install` 或 build 不會執行上述安裝。`tw.lifestay.dev-flow-worker`、`/Users/skai.wu/side` 與 `OWNER/REPOSITORY` 是目前 maintainer Mac instance 的部署範例，不是可攜的預設值；請依實際主機調整。

### 方式三：handoff JSON

```json
{
  "repo": "/path/to/workspace/example-repo",
  "objective": "修正登入 callback",
  "scope": { "include": ["src/auth/callback.ts"] },
  "invariantsAndNonGoals": ["保留既有登入行為", "不修改公開 API"],
  "acceptanceCriteria": ["invalid state is rejected"],
  "constraints": ["do not change public API"],
  "tests": ["npm test"],
  "riskNotes": [],
  "delivery": { "mode": "direct_main", "requireApproval": true }
}
```

```bash
npm run orchestrate -- --handoff /absolute/path/handoff.json
```

Artifacts 會寫入目標 repo：

```text
.orchestrator/runs/<run-id>/
```

## Workflow 細節

```text
handoff / spec
  → clean working tree check
  → baseline test preflight
  → deterministic floor + Luna classifier
  → implementer
  → actual diff reclassification
  → deterministic tests
  → isolated reviewer
  → optional Sol final reviewer
  → ready_for_main / needs_human / failed
  → report.md
```

重要行為：

- working tree 必須乾淨，`.agent/specs/` 除外。
- baseline 測試失敗時不呼叫任何模型。
- reviewer 是新的 agent invocation，不共享 implementer session。
- actual diff 只會讓 tier 上升。
- `escalate` 只升級 reviewer，不重新做 implementation，也不消耗 cycle。
- 只有 `fail` 才會回 implementer 修正。
- 連續兩個 cycle 的 findings 逐字元相同時提前停止。
- runtime exception 會先寫出 `failed` summary 與已累積成本，再往外拋。

更完整的分支與 artifact 流程見：

- `docs/overview.md`
- `docs/architecture.md`
- `docs/modules/orchestration.md`
- `docs/modules/routing.md`

## Project structure

- `src/orchestrator.ts`：主流程協調。
- `src/decision-log.ts`：跨 cycle findings 與 implementer responses。
- `src/routing.ts`、`src/models.ts`：風險分級與模型選擇。
- `src/test-runner.ts`：deterministic shell tests。
- `src/report.ts`：不使用 LLM 的最終報告。
- `src/policies/`：completion / retry policy。
- `src/agents/`：provider-neutral agent contracts。
- `src/adapters/pi/`：Pi JSON child-process adapter。
- `src/spec.ts`、`src/handoff.ts`：輸入 contracts。
- `extensions/orchestrate.ts`：Pi supervisor / mobile entrypoint。
- `bin/dev-flow`：日常分派入口。
- `src/test/`：Node built-in test runner 的單元測試。

## Threat model

**這套工具不提供 sandbox。** 它以目前使用者權限執行 agent。

| Role | Tools | 可寫檔 |
|:---|:---|:---:|
| router | 無 | 否 |
| reviewer / final reviewer | `read,grep,find,ls` | 否 |
| implementer | `read,write,edit,bash,grep,find,ls` | 是 |

reviewer 的 read-only allowlist 是程式碼強制；implementer 則擁有 `bash`，而 child process 的 `cwd` 只是起點，不是檔案系統圍籬。

以下分野很重要：

- **程式碼強制**：reviewer 的唯讀工具集、角色 session 隔離、baseline 與 deterministic tests、修正次數上限。一般 CLI/Pi flow 到 `ready_for_main` 就停止；queue worker 只有在同一套 gate 全通過後，才會對它建立的隔離 branch commit，從 approved spec、structured outcome verification 與 post-commit Git metadata 建立 typed delivery payload，再 push 和建立 Draft PR。PR body 不接受或渲染 report、Pi events、agent output、prompts 或 ledger；缺少、malformed、測試失敗或 reviewer 非 pass 的 evidence 會在 push 前阻擋 publication。允許字串會以 plain text escape 並受逐欄、列表及整體 body 上限限制；它不會 merge 或部署。
- **僅為 prompt 請求**：`renderPrompt()` 中的「不要 `git commit`、`git push`、`git reset`、`git checkout` 或修改 main」，以及「不要修改需求外檔案」。同樣地，`src/adapters/pi/pi-process-adapter.ts` 裡要求 implementer 檢查合理且可到達的同 invariant 類別 sibling cases、補 regression tests，以及要求 reviewer 批次檢查同類別可到達且已核准的路徑、遵守 non-goals，都是 prompt-only guidance，不是程式碼強制。模型可以忽略這些文字，並沒有執行層攔截。

另外，spec / handoff 內的測試命令會以 shell 直接執行，因此它們與程式碼具有相同的信任要求。GitHub Issue queue 的 title、body、labels、repository metadata **與 comments** 同樣是不受信任的輸入；allowlist 與 workspace-root 檢查只防止選到任意 checkout，`dev-flow-ready` 是人工 approval，不是 sandbox。

Resume 決策來自 Issue comment，因此授權是程式碼強制的：worker 讀 `repos/{owner}/{repo}/collaborators/{user}/permission`，以 `user.permissions.push` 這個 boolean 為準（字串 `permission` 只接受 `write`／`maintain`／`admin`，它不會回傳 `push`）。未授權、過期或格式不符的留言一律無效，而且 worker **不會回應它們** —— 回應等於讓任何有留言權限的人驅動無上限的 Issue 寫入。

attempt 編號讀自報告內的 HTML marker，這是已知的殘餘風險：能留言的人可以貼一則假報告，讓一則合法決策看起來過期（阻斷服務），但無法讓過期決策變新鮮，且保留現場記錄的 attempt 仍必須相符。

請遵守：

- 只對可信任的 repo、spec 和 handoff 使用。
- 需要真正隔離時，在 container、VM、macOS `sandbox-exec` 或低權限帳號內執行。
- 不要把 `AGENT_ORCHESTRATOR_WORKSPACE_ROOT` 當成 sandbox；它只是避免選錯目標 repo 的防呆。

哪些行為是程式碼保證，哪些只是 prompt 約束，詳見現有 threat model 與 `docs/rules/testing-and-safety.md`。

## Extension 環境變數

| 變數 | 預設 | 用途 |
|:---|:---|:---|
| `AGENT_ORCHESTRATOR_HOME` | 由 extension 自身位置推導 | agent-orchestrator repo 位置 |
| `AGENT_ORCHESTRATOR_STATE_DIR` | `~/.pi/agent-orchestrator` | session pointer 與 extension state |
| `AGENT_ORCHESTRATOR_WORKSPACE_ROOT` | 未設定 | 選用的目標 repo 範圍防呆，不是 sandbox |

## License

MIT，見 `LICENSE`。

`package.json` 的 `private: true` 只是防止誤發佈到 npm，與 MIT 授權無關。這個 repo 是拿來 clone 與執行的，不是拿來發佈成 npm package 的。
