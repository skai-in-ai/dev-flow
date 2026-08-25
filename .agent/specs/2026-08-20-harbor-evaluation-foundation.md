---
repo: "/Users/skai.wu/side/agent-orchestrator"
status: ready_for_main
title: "Harbor evaluation foundation: runtime schema、fake ATIF 與 telemetry contract"
created_at: "2026-08-20T00:00:00+08:00"
---

# Harbor evaluation foundation: runtime schema、fake ATIF 與 telemetry contract

## 目標

建立第一個可執行、可測試而不消耗模型額度的 Harbor evaluation foundation。這一張 spec 只定義 Harbor `0.20.0`／Terminal-Bench 2.1 的 runtime config schema、Harbor-like artifact／ATIF fake fixture、跨 harness telemetry contract 與 normalizer、task compatibility metadata、Full dev-flow installed-agent contract skeleton，以及安全的 `harbor-preflight` binary 檢查。它不安裝 Harbor、不啟動 Docker image、不呼叫模型、不跑 benchmark trial，也不修改現有 production orchestration 行為。

完成後，後續人工授權的 Harbor smoke 可以使用固定格式輸入；Single Pi、Harbor Codex baseline 與 Full dev-flow 的結果可以用同一個 telemetry schema 比較，而不會把缺少的 provider usage 或 reward 偽裝成 0。真 Harbor adapter 仍需另一張 spec，必須以本文件的 contract 為輸入。

## 背景與決策

- Harbor 版本固定為 `0.20.0`；dataset ref 固定為 `terminal-bench/terminal-bench-2-1`。runtime config 必須另外保存 dataset revision、task IDs 與每題 digest；沒有 revision 或 digest 的設定不得宣稱可重現。
- 本 repo 目前只有 `PiProcessAdapter` 與兩個既有 dev-flow 入口。這張 spec 不改 `bin/dev-flow`、`bin/dev-flow-worker`、`Orchestrator.run()`、cycle policy、routing、session isolation 或既有 ledger 格式。
- 既有 `AgentRunResult.usage` 是 `Record<string, unknown>`，而 Harbor ATIF／Codex／Pi 對 token 欄位名稱不完全相同。normalizer 必須採取明確來源映射；欄位缺失一律為 `null`，不以 0 補值。
- `cache_read_tokens`、`cache_write_tokens` 與 session mode 是三個不同概念。session fresh／reused 不可推導 cache hit；`uncached_input_tokens` 只有在原始欄位存在時才是 raw value，若由 `input_tokens - cache_read_tokens` 計算，必須放在明示的 `derived` 區塊並保存公式。
- Harbor 的 `shared` verifier 是預設，不能由相容層假設 tests 隱藏。task metadata 必須明確記錄 `shared`、`separate` 或 `unknown`；此 foundation 不做 verifier replay、snapshot restore 或 reward 回饋 agent。
- Custom installed-agent skeleton 只定義本 repo 對 Harbor `BaseInstalledAgent` 介面的 port／mapping；它不繼承 Harbor class、不 import Harbor、不啟動 subprocess。真正 Harbor wrapper 及 `/logs/agent` 映射留給後續 implementation spec。
- `harbor-preflight` 只做 deterministic binary、Docker daemon、版本與 auth-presence 檢查。它不印 token／auth.json 內容、不執行 `harbor auth login`、不讀取 provider secret、不 pull image、不執行 `harbor run` 或任何 trial。

## Invariants and non-goals

- Harbor version literal 必須是 `0.20.0`；任何真實執行設定必須含 dataset ref、非空 revision、task IDs、每題 digest、harness、model／reasoning、timeout、verifier mode 與 trial budget。
- `npm test`、fake fixture、normalizer test 與 `harbor-preflight` 都不得呼叫模型、Harbor trial、Docker image build／pull、網路 API 或上傳結果。
- `harbor-preflight` 的輸出只包含 binary path／version、Docker readiness、auth presence 的 boolean／分類與 exit code；禁止輸出環境變數值、auth file 內容、token、API key、session transcript 或完整 command line secrets。
- 三個 harness 的 canonical names 固定為 `harbor-codex`、`single-pi`、`full-dev-flow`。缺少 reviewer、Harbor reward、cache usage 或美元成本時，schema 仍然成立且欄位為 `null`。
- fake fixture 必須在資料中標為 `source: "fake-fixture"`，不得被 exporter 誤標成真 Harbor trial 或 leaderboard result。
- Full dev-flow skeleton 不得實作第二套 implement → tests → reviewer → retry loop；它只能把 instruction 映射成既有 core runner 的一次請求，並定義 artifact／context 的邊界。
- 不修改 production `maxFixCycles`（目前最多三次修正）、fresh session policy、Pi tool allowlist、GitHub queue、commit／push／PR 行為或 `.orchestrator/runs/` 原始事實來源。
- 不在本輪實作 production ablation、session reuse、cycle snapshot replay、offline verifier、reward feedback、Harbor upload、完整 Terminal-Bench 89 題或任何成本／成功率宣稱。

## 修改範圍

### 1. Runtime config schema 與固定設定

新增 `src/benchmark/harbor-runtime.ts`，定義並驗證 `HarborRuntimeConfig`：

- `schemaVersion: "harbor-runtime-1"`
- `harborVersion: "0.20.0"`
- `dataset.ref: "terminal-bench/terminal-bench-2-1"`
- `dataset.revision: string`（非空；不可使用 `latest`；task-level CLI 的 default `latest` 只能作 capability smoke，不能進正式可重現 config）
- `dataset.tasks: { id: string; sha256: string }[]`（id 非空且不重複；digest 為 64 位 hex）
- `harness: "harbor-codex" | "single-pi" | "full-dev-flow"`
- `agent: "codex" | "pi" | "custom-full-dev-flow"`
- `model: string | null`、`reasoningEffort: "low" | "medium" | "high" | "xhigh" | null`
- `timeoutSeconds: positive integer`、`trialCount: positive integer`
- `verifierMode: "shared" | "separate" | "unknown"`
- `allowInternet: boolean | null`
- `maxFixCycles: non-negative integer | null`；Single Pi 與 Harbor Codex 必須為 `null`
- `sessionMode: "fresh" | "reused" | "unknown"`；本 foundation 的 executable baseline 僅允許 `fresh`
- `notes: string[]`（optional；validator 拒絕 credential-like `key=value`／`key: value` 內容）

新增 `config/harbor/terminal-bench-2-1.schema.json` 作為 shape/schema 層的人可讀 JSON Schema，並在 `src/benchmark/harbor-runtime.ts` 提供不依賴新套件的 deterministic semantic validator。JSON Schema 可表達型別、required、pattern 與部分 `if/then` pairing；task ID uniqueness、trim/case-insensitive `latest`、notes credential-like content、baseline-only `fresh` 與其他跨欄位政策由 TypeScript semantic validator enforce。測試會對同一批 valid／invalid fixtures 同時跑 shape schema parity helper 與 semantic validator，不宣稱兩層可表達能力完全相同。Schema 不提供會自動執行的 paid config；任何實際 revision／task digest 由後續明確授權的操作 artifact 填入。

### 2. Task compatibility metadata

新增 `src/benchmark/task-compatibility.ts`，定義 `TaskCompatibilityMetadata`：

- `schemaVersion: "task-compatibility-1"`、`taskId`、`datasetRevision`、`taskDigest`
- `workspaceKind: "git-repo" | "directory" | "unknown"`
- `requiresGitRepo: boolean | null`、`requiresCleanTree: boolean | null`
- `agentWorkdir: string | null`、`testsVisibleToAgent: boolean | "unknown"`
- `verifierMode: "shared" | "separate" | "unknown"`
- `internetAllowed: boolean | null`
- `fullDevFlowCompatible: boolean | "unknown"`
- `incompatibilityReasons: string[]`

Metadata 只能由已保存的 task／runtime config evidence 填值；`testsVisibleToAgent` 不得從「有 verifier」或任務名稱推論。缺少 evidence 時採 `unknown`，Full dev-flow compatibility 為 false 時必須保留可讀原因，例如無 Git repo、無可執行 deterministic test 或 verifier 只有 shared mode。

新增 `src/test/benchmark-foundation.test.ts`，以固定 object fixture 覆蓋 shared、separate、缺欄位與不相容題型；測試不可讀取網路或 Harbor dataset。

### 3. Cross-harness telemetry contract 與 normalizer

新增 `src/benchmark/telemetry.ts`，定義 `BenchmarkTrialTelemetry` 及 `normalizeBenchmarkArtifacts()`。canonical shape 必須至少包含：

```text
schemaVersion
trial: { trialId, trialName, taskId, taskName, taskRef, datasetRef, datasetRevision, taskDigest, harness, source }
configuration: { harborVersion, agent, model, reasoningEffort, timeoutSeconds,
                 trialCount, maxFixCycles, verifierMode, sessionMode,
                 reviewerEnabled, finalReviewerEnabled, routingEnabled,
                 promptCacheConfigured }
result: { passed, reward, firstPassingCycle, finalCycle, stopReason,
          failureCategory, verifierStatus, durationMs }
usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
         uncachedInputTokens, modelCallCount, estimatedCostUsd,
         actualCostUsd, rateLimitCount, timeoutCount }
derived: { uncachedInputTokens: { value, formula, sourceFields } | null }
orchestration: { runId, cycles, roles, tiers, retryCount,
                  reviewerVerdicts, deterministicTestEvidence }
cycles: [{ cycle, snapshotRef, durationMs, usage, tests, reviewFindingFingerprint,
           recovered, regression, stopReason }]
provenance: { sourceFiles, generatedAt, usagePrecedence, pricingEvidence,
              billingEvidence, rewardSource, passedDerivedFromReward, timing,
              normalizationWarnings }
```

所有數值 usage／cost 欄位為 `number | null`；未知、provider 未回報及不適用均為 `null`。usage precedence 固定為 `final totals > trajectory metrics > step metrics`；step metrics 不得覆寫 final totals。`actualCostUsd` 在訂閱模式固定為 `null`，除非輸入明確包含 billing evidence。`estimatedCostUsd` 只有輸入明確包含 pricing snapshot 且 raw estimated field 存在時才能填值；generic `cost` 不算 evidence，否則為 `null`。`reward` 可為 number 或 null，但 fake fixture 的 reward 不得被報為官方分數。

normalizer 必須支援三種 input：

1. Harbor-like `config.json`、`result.json`、`agent/trajectory.json`、`verifier/reward.txt` 的 fixture shape。
2. Pi／Codex agent usage 的不同 raw key（包含 Codex `input_tokens`、`output_tokens`、`cached_input_tokens`、`cache_write_input_tokens` 與 Pi `input`、`output`、`cacheRead`、`cacheWrite`）。
3. 現有 `.orchestrator/runs/<run-id>/run.json`、cycle summary／tests／review evidence；不得依賴完整未壓縮 event array。

4. Harbor 0.20.0 captured result shape：`id`／`trial_name`／`task_name`／`task_id.ref`／`task_checksum`、nested `agent_result.n_input_tokens`／`n_cache_tokens`／`n_output_tokens`／`cost_usd`、`verifier_result.rewards.reward`、`exception_info`、top-level與 phase timestamps。`n_cache_tokens` 是 aggregate cache，不能映射成 cache write；task-level `ref: latest` 只保留為 smoke evidence。

Normalizer 需保留 `sourceFiles`、未知欄位 warning 與 raw-vs-derived distinction；不因某個 harness 缺少 field 而改變 schema。`source: "fake-fixture" | "harbor-artifacts" | "orchestrator-ledger" | "mixed"` 必須由呼叫端明確提供，不能從檔名猜測。

新增 `src/test/benchmark-foundation.test.ts`，覆蓋三 harness、完整 usage、缺 cache／cost／reward、Pi/Codex key mapping、final-vs-step precedence、pricing／billing evidence、derived uncached formula、未知欄位、cycle null 與 fake provenance。測試需斷言 normalizer 絕不把缺失值轉成 0，也不把 fresh session 轉成 cache hit。

### 4. Harbor-like artifact／ATIF fake fixture

新增 `src/benchmark/fixtures/harbor-atif.ts`，只產生 deterministic in-memory／temporary-directory fixture，不 import Harbor、不執行 Pi／Codex、不存取網路。fixture 至少包含三組資料：

- `harbor-codex`：Codex-style ATIF usage、reward 與 verifier result。
- `single-pi`：Pi-style `input/output/cacheRead/cacheWrite` usage，沒有 reviewer fields。
- `full-dev-flow`：現有 run ledger／cycle／review evidence，Harbor reward 與 cache fields 缺失，應被 normalizer 設為 `null`。

Fixture directory 可模擬 `config.json`、`result.json`、`agent/trajectory.json`、`verifier/reward.txt` 與 `.orchestrator/runs/` 的最小檔案，但每個 fixture 都必須帶 `fixtureVersion` 與 `source: "fake-fixture"`。這是 normalizer test input，不是 Harbor replay proof，也不能在文件中稱為 benchmark result。

### 5. Full dev-flow installed-agent contract skeleton

新增 `src/benchmark/full-dev-flow-agent-contract.ts`，定義不依賴 Harbor package 的 local port：

- `FullDevFlowAgentEnvironment`：cwd、artifact root、可被 fake 注入的 `exec`／write boundary；不可直接取得 secret。
- `FullDevFlowAgentContext`：instruction、task metadata、runId、artifact references、post-run metadata；不得帶 verifier reward 回 agent prompt。
- `FullDevFlowRunner`：唯一可注入的既有 core runner，輸入是 handoff／workspace，輸出是 runId、status、ledger root。
- `FullDevFlowInstalledAgentSkeleton`：提供 `install()`、`run()`、`populateContextPostRun()` 的 contract-shaped method。`install()` 僅驗證注入 environment contract；`run()` 只做 task instruction → handoff mapping、呼叫一次 `FullDevFlowRunner` 並登記 artifact reference；`populateContextPostRun()` 只回填 run metadata。

此 skeleton 不宣稱已符合 Harbor runtime：不要繼承 `BaseInstalledAgent`、不要 import `harbor`、不要 spawn `harbor`／`pi`、不要呼叫 verifier、不要把 reward 寫回 instruction／prompt。新增 `src/test/full-dev-flow-agent-contract.test.ts` 使用 fake runner 驗證一次呼叫、artifact mapping、context 不含 reward、runner failure 的 deterministic error，以及沒有第二套 cycle loop。後續真 Harbor wrapper 只能是薄層 delegation，另開 spec 審核。

### 6. `harbor-preflight` 安全檢查

新增 `src/benchmark/harbor-preflight.ts` 與 `bin/harbor-preflight`。CLI 只允許 read-only checks，輸出固定 key／status，不印值：

- `command -v harbor`, `harbor --version`；若存在但不是 `0.20.0`，狀態為 `version_mismatch`。
- `command -v docker`, `docker --version`, `docker info`；只報 binary／daemon ready，不 pull、build、run 或 inspect image。
- `command -v pi`, `command -v codex`；只報 binary 存在與 version command 結果。
- Codex auth presence：若 `CODEX_AUTH_JSON_PATH` 指向 readable file，或預設 Codex auth file readable，或 `OPENAI_API_KEY` environment 存在，僅報 `present`／`absent`；不可 cat、parse 或印值。
- Pi auth presence：只檢查明確設定的 `PI_CODING_AGENT_DIR` 是否為 readable directory，及 provider env 是否存在；若 provider 路徑無法安全判斷，報 `unknown`，不猜測成功。

預設只做檢查；CLI 不接受任何 positional argument 或旗標，包含 `--run`、`--trial`、`--upload` 與未知旗標；有任一 argument 時在任何 binary/Docker/auth check 前固定輸出安全錯誤並 exit 1。preflight exit code：所有必要 binary／Docker／Harbor exact version／明確要求的 auth presence 都 ready 為 0；不 ready 為 1；不確定但非必要 provider auth 為 0 並輸出 `unknown`。實作不得透過 shell 拼接外部輸入，不得執行 Harbor Hub login。

### 7. 文件

更新：

- `docs/overview.md`：新增第三個「Harbor evaluation」入口，但標明 foundation 只產生 fake／contract，不能啟動 paid trial；既有兩入口語意不變。
- `docs/modules/pi-adapter.md`：補充 Pi usage 對應 telemetry 的 raw／null／derived 規則與 fresh session 不等於 cache hit。
- `docs/rules/testing-and-safety.md`：加入 `harbor-preflight` 的 no-secret／no-trial gate、fake fixture provenance 與真 Harbor trial 必須人工授權的規則。
- `docs/benchmarks/harbor-terminal-bench.md`：記錄 `harbor==0.20.0`、dataset ref／revision／digest lock 要求、三 harness names、verifier shared/separate 限制、未支援 snapshot replay，以及後續人工 smoke 的前置條件。文件引用 capability spike，不寫入任何未執行分數。

## 排除範圍

- 不安裝 Harbor 或修改 uv／global tool cache，不啟動或下載 Docker image。
- 不執行 `harbor run`、`harbor trial`、`harbor job`、`harbor regrade`、Codex／Pi 模型呼叫、oracle、leaderboard submission、upload 或網路 benchmark。
- 不實作真 Harbor agent registration、`BaseAgent`／`BaseInstalledAgent` subclass、workspace mount、verifier execution、artifact replay、snapshot restore 或 reward feedback。
- 不修改 `src/orchestrator.ts`、`src/models.ts`、`src/adapters/pi/pi-process-adapter.ts` 的 production 行為；若 telemetry 需要讀取現有 ledger，使用純函式 normalizer，不改既有 ledger producer。
- 不新增 session reuse、no-review ablation、5／10 cycle policy、production config、第三入口實際 dispatch、dataset mirror 或另一套成本 ledger。
- 不把 fake fixture、preflight readiness 或 schema validation 解讀為 Harbor E2E ready、Terminal-Bench score、成本或成功率。

## 驗收條件

- `HarborRuntimeConfig` 會拒絕錯誤 Harbor version、floating dataset revision、空 task list、重複 task、錯誤 digest、Single Pi／Codex 非 null `maxFixCycles` 與非 fresh baseline。
- JSON Schema shape helper 與 TypeScript semantic validator 對同一組 valid／invalid fixtures 各自通過 parity tests；跨欄位政策由 semantic validator 負責，不能宣稱 JSON Schema 單獨涵蓋全部規則；不新增 runtime dependency。
- 三組 fake artifact 都能被 normalizer 轉成同一個 `BenchmarkTrialTelemetry` shape；缺失欄位是 `null`，來源與 warning 可追溯。
- Captured Harbor result fixture 能正確取得 nested reward／usage／identity／duration；reward precedence 為 verifier result > reward text > legacy flat，沒有明確 reward policy 時 `passed` 保持 `null`。
- normalizer 能分別保留 raw cache read/write、明示 derived uncached formula，且不從 session mode 推導 cache hit、成本或 token。
- task metadata 對 shared verifier、separate verifier、缺 metadata 與不相容 Git/test 前提都能 fail closed 或輸出 `unknown`／原因；不能宣稱隱藏 tests。
- Full dev-flow skeleton 在 fake runner 下只呼叫一次既有 runner，能輸出 artifact references，且 verifier reward 不會進入 runner input 或 context prompt。
- `harbor-preflight` 在缺 binary、Docker daemon、版本不符或 auth absent 時以 deterministic status／exit code 結束；有任何 argument 時在 checks 前 fail closed；任何輸出不含 secret；執行不會建立 Harbor job、下載 image 或呼叫模型。
- 文件清楚區分 capability foundation、fake fixture 與後續需人工授權的真 Harbor adapter；不宣稱 snapshot verifier replay 已可用。官方 Harbor regrade 目前只確認為 artifact／separate-verifier regrade path，不等同任意歷史 workspace snapshot replay，本限制固定記錄在文件中。
- 既有兩個入口的行為與測試保持不變；所有新測試可在乾淨 checkout 透過下列 raw commands 執行。

## 測試要求

- `npm ci`
- `npm test`
- `git diff --check`

測試程式不得依賴本機 Harbor、Docker daemon、Codex／Pi auth、網路、環境中的秘密或既有 `.orchestrator/`；所有 Harbor／ATIF／ledger 輸入使用 repository fixtures 或 test-created temporary directories。`harbor-preflight` 的 CLI integration test 必須以 fake command PATH／temporary env 注入，不得執行真 `harbor`、真 `docker`、真 `pi` 或真 `codex`。

## 風險

- Harbor 官方 installed-agent API、ATIF 欄位與 CLI 版本可能變動；本輪以 versioned local contract、fixture provenance 與 schema validator 限制漂移，真 wrapper 另行驗證。
- `docker info` 可能因 daemon 未啟動而失敗；這是 preflight 的結果，不是測試失敗，也不應觸發啟動 Docker 或安裝步驟。
- Codex subscription auth 可能只有 host `auth.json` 而不能在 Harbor container 使用；preflight 只報 presence，不能報 auth validity 或模型可用性。
- provider cache 欄位與美元成本可能缺少或命名不同；normalizer 以 null／derived policy 保守處理，報告不得把 null 平均成 0。
- Full dev-flow task 若不是 Git repo、沒有 deterministic test 或只提供 shared verifier，metadata 必須標記不相容／unknown，不得用相容層硬湊 benchmark 前提。
- fake fixture 很容易被誤用為真實 benchmark；source/provenance、文件措辭與測試斷言必須同時防止這種誤讀。

## 未決事項

無。snapshot workspace replay、真 Harbor wrapper、人工 smoke task／預算與正式第三入口不屬於本張 spec；它們是明確排除的後續工作，不是本張 spec 的未決依賴。
