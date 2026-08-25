---
repo: "/Users/skai.wu/side/agent-orchestrator"
status: ready_for_main
title: "Harbor custom Full dev-flow wrapper / 第三入口"
created_at: "2026-08-21T00:00:00+08:00"
---

# Harbor custom Full dev-flow wrapper / 第三入口

## 目標

在 Harbor `0.20.0` 上增加一個可由 `harbor run -a module:Class` 載入的 custom
`BaseInstalledAgent` 薄 wrapper，讓 Terminal-Bench task 能以第三個、明確隔離的
Full dev-flow harness 呼叫本 repo 既有的 TypeScript core。這張 spec 只完成
wrapper 的 packaging、container/runtime preflight、instruction-to-handoff
mapping、artifact/telemetry export 與 no-model contract tests；不改既有兩個
dev-flow 入口的語意，也不執行付費 model trial。

完成本張後，乾淨 checkout 可以驗證 Python package/import、fake environment、
bridge 與 artifact mapping。取得 Docker、固定 task revision/digest、以及人工
授權後，已完成 Harbor `--install-only` 的真 wrapper loading；真正的單題 model
smoke 仍是獨立的人工授權操作，不能由 `npm test` 或安裝流程觸發。

## 背景與決策

### 已驗證的 Harbor 0.20.0 介面

本 spec 以本機已安裝的 Harbor `0.20.0` package/source 為契約來源：

- `harbor run --help` 支援 `--install-only`；它執行 agent setup/install、跳過
  agent run 與 verification。
- `--agent`／`-a` 可接受 `module.path:ClassName`。`AgentFactory` 透過
  `importlib.import_module()` 與 class attribute 載入 custom class，並以
  `logs_dir`、`model_name`、`extra_env` 建構它。
- `BaseInstalledAgent` 的必要生命週期是 `install(environment)`、被
  `@with_prompt_template` 包住的 `run(instruction, environment, context)`，以及
  可選的 `populate_context_post_run(context)`；`setup()` 會呼叫 `install()`。
- `BaseEnvironment` 提供帶有 `cwd`、`env`、`timeout_sec`、`user` 的
  `exec()`，以及 `upload_file`／`upload_dir`。Harbor 的 Linux
  `EnvironmentPaths` 預設提供 `/solution`、`/tests`、`/logs/agent`、
  `/logs/verifier`、`/logs/artifacts`，但 wrapper 必須以 task/environment contract
  取得並實查實際 path，不得把這些字串當成所有 task／OS 的不變前提。
- Harbor 會將 `/logs/agent` 同步到 trial `agent/`，將 `/logs/artifacts` 的
  convention entry 收集到 trial `artifacts/`；`agent/trajectory.json` 是
  ATIF viewer／usage parser 的標準檔名。
- `AgentContext` 只有 token、cost、rollout details 與 metadata 欄位；缺少的
  provider usage 必須保持 `null`。verifier reward 位於 verifier result／
  `reward.txt`，不是 agent context 的輸入。

已讀取並以固定版本作為 source evidence 的檔案包括
`harbor/agents/installed/base.py`、`harbor/agents/factory.py`、
`harbor/utils/import_path.py`、`harbor/environments/base.py`、
`harbor/models/agent/context.py`、`harbor/models/trial/paths.py`、
`harbor/trial/artifact_handler.py`、內建 `pi.py`／`codex.py`，以及本機
fix-git oracle 的 `result.json`、`config.json`、`artifacts/manifest.json` 和
`verifier/reward.txt`。

### Package 與 import path

新增一個 repo 內、可建立 wheel 的 Python distribution：

```text
packages/harbor-full-dev-flow/
  pyproject.toml
  src/harbor_full_dev_flow/__init__.py
  src/harbor_full_dev_flow/agent.py
  src/harbor_full_dev_flow/bridge_contract.py
  tests/
```

正式 import path 固定為：

```text
harbor_full_dev_flow.agent:FullDevFlowAgent
```

operator 先在與 Harbor 0.20.0 相同的 Python environment 安裝已建置的 wheel，
再傳入：

```bash
harbor run -a harbor_full_dev_flow.agent:FullDevFlowAgent ...
```

不能用 `PYTHONPATH=/Users/.../agent-orchestrator`、editable host checkout 或
相對路徑作正式 run 的依賴。release／smoke input 必須保存 wheel filename、
SHA-256、distribution version 與 Harbor version；custom class 由 Harbor host
process 載入，container 內的 dev-flow runtime 則由 wheel 內嵌的 release bundle
安裝，兩者是不同邊界。`harbor` 不是本 repo 的 npm runtime dependency；
clean-checkout 測試不得因 global Harbor、網路或 Docker 缺失而失敗。

### Container runtime 與版本 pin

Python wrapper 不把 host repo 路徑傳進 task container，也不在 container 內
`git clone` 或下載 floating `latest`。Host Python wheel 內嵌本 repo 已由
`npm ci`／`npm run build` 產生的 JS `dist`、必要的 package metadata、bridge
assets 與 manifest；不內嵌 Mac 或其他 host-specific Node binary。release
artifact 至少帶有：

```text
devFlowBundleVersion
devFlowBundleSha256
nodeMajor = 22
nvmTag = v0.40.2
piVersion = 0.82.1
piPackage = @earendil-works/pi-coding-agent
bridgeVersion
bridgeSha256
installSource = wheel-embedded-release-bundle
nodeResolution = record-actual-version
runtimeReproducibility = version-pinned-not-cryptographically-reproducible
```

`install(environment)` 以 `upload_file`／`upload_dir` 把 wheel 內的 bundle 傳至
例如 `/opt/agent-orchestrator/harbor-runtime`，再以不含秘密的 `sha256sum` 驗證
JS bundle／manifest。接著依 Harbor 0.20.0 內建 `Pi.install` 的已驗證策略完成
container setup：

1. 先檢查可用的 `apt-get`、可寫入的 agent home 與足夠權限；以 agent UID/GID
   先由 root 建立並設定 `/opt/agent-orchestrator` 與
   `/opt/agent-orchestrator/harbor-runtime` 的 owner／traverse permissions，再
   upload wheel bundle；用 `exec_as_root` 安裝 `curl`，用
   `exec_as_agent` 執行固定 tag `nvm v0.40.2` 的安裝腳本。
2. 以 nvm 安裝 Node major `22`，並保存實際 resolved `node --version` 與
   `npm --version`；不接受非 22 major，也不把 patch version 猜成固定值。
3. 以 `npm install -g @earendil-works/pi-coding-agent@0.82.1` 安裝 dev-flow
   實際使用的 Pi fork，保存 package name 並驗證 `pi --version` 為 `0.82.1`；不
   使用 `@latest` 或不存在的 upstream package/version 組合。
4. 驗證 bundle digest、Node/Pi 實際版本與 bridge 可執行性，將非秘密的
   `runtime-resolved.json` 寫入 `/logs/agent/full-dev-flow/`。

setup 階段允許上述固定 tag/version 的網路下載；沒有網路、沒有 `apt-get`、
curl/nvm/npm/Pi 安裝失敗、agent home 不可寫或權限不足時，在任何 model command
前分類為 `harness_incompatibility`。Node 的實際安裝與 major-version check 是
runtime compatibility proof；不能 fallback 到 floating
版本或 task image 中未驗證的 Node/Pi。runtime image 若預先有相容工具，可只
在實際版本符合 manifest 時重用，否則仍走這個 pinned setup。

`v0.40.2` 與 `0.82.1` 是版本/tag pin，但若實作沒有額外保存 nvm installer、
Node distribution、npm tarball 的 checksum，就不得宣稱整個 runtime 具
cryptographic reproducibility；報告必須保留 resolved Node/npm/Pi versions、
來源 tag/version、bundle SHA-256，並標記上述限制。只有 wheel 內嵌的 dev-flow
bundle 本身要求 SHA-256 驗證。`install()` 不執行 model、Pi prompt 或 verifier；
Node/Pi 的 auth 也不由 bundle 複製。

### Instruction、workspace 與 handoff mapping

`run()` 使用 `@with_prompt_template`，將 Harbor 傳入的 instruction 視為資料，
建立一次性 handoff，不在 Python 層重寫 orchestrator loop：

| Harbor input | Full dev-flow handoff | 規則 |
|---|---|---|
| instruction | `objective` | 原文保留；不得從原文解析 shell command、repo path 或 reward |
| Harbor task/environment contract 的 resolved workdir | `repo` | 必須是 Git repo；`git rev-parse --show-toplevel` 必須等於該 task 允許 root |
| locked compatibility manifest | `scope`, `acceptanceCriteria`, `tests`, `constraints`, `riskNotes` | 只採用已驗證、非 instruction 提供的欄位 |
| runtime/task metadata | `invariantsAndNonGoals` | 包含 Git/workdir/verifier boundary 與 no-reward-feedback 規則 |
| `allowLocalCommit` policy | handoff `policy` + invariants | 必須是明確 boolean；目前 wrapper 真實執行只接受 `false`，缺失或 `true` 在 model 前 fail closed |
| generated run id | `source`／artifact metadata | 由 core ledger 回傳；不由 task name 猜測 |

wrapper 在呼叫 bridge 前必須 fail closed 檢查：

1. workspace path 只能來自 Harbor task/environment contract 與 locked
   `agentWorkdir`，再實查它是允許的 Git repository root；Linux 預設 `/solution`
   只有在實際 EnvironmentPaths／task config 確認時才採用。不同 OS、custom
   workdir、非 root default user 或不能安全確認 owner/permissions 時拒絕，不接受
   host absolute path、symlink escape 或空 repo。
2. compatibility metadata 的 `taskId`、`datasetRevision`、`taskDigest` 與
   Harbor task identity 相符；revision 不得是 trim 後的 `latest`，digest 必須
   是固定值。Captured fix-git 的 `ref: latest` 只算 capability evidence，不能
   作正式 Full dev-flow smoke 設定。
3. `fullDevFlowCompatible` 必須是 `true`，`workspaceKind` 必須是 `git-repo`，
   `requiresGitRepo`／`requiresCleanTree` 不能是 `false`／`unknown`，且
   `testsVisibleToAgent`、`verifierMode` 與 deterministic tests evidence 必須
   明確。缺任何一項或有 incompatibility reason 就拒絕呼叫 core。
4. `allowLocalCommit` 必須明確存在且為 boolean；本 wrapper 目前只允許
   `false`，因此 prove-plus-comm 等比較 task 不會讓 local commit 破壞現有
   working-tree review evidence。handoff 仍會把 policy 映射成 invariant：只有
   明確 `true` 才會出現「locked disposable workspace 內可 local commit」語意，
   且該模式要等 baseline-aware review evidence follow-up 完成。
5. handoff 的 `tests` 只可來自 locked compatibility manifest 的固定 raw
   commands；不得把 Harbor `/tests`、verifier script 或 instruction 直接當成
   core test command，也不得因 shared verifier 存在就宣稱 hidden tests。
6. 先寫入不含 secret 的 handoff manifest，再以固定 argv 呼叫 bridge；不把
   verifier reward、`/logs/verifier`、`reward.txt` 或 verifier stdout 傳入
   objective、handoff、Pi prompt 或下一輪 decision。

handoff 的 `delivery.mode` 固定為 `direct_main`、`requireApproval` 固定為
`true`；這只代表 Harbor container 內的一次 core run，不會授權 commit、push、
PR、merge、deploy。既有 core 的 repo dirty／tests gate 行為仍由 core 決定；
wrapper 不放寬它們。若 task 初始 tree 與既有 core 的 gate 不相容，wrapper 在
model call 前回報 `harness_incompatibility`。

### TypeScript bridge 與既有 core

新增窄 bridge（預定 `src/harbor-bridge.ts` 與 `bin/harbor-dev-flow`），並把
目前 `src/cli.ts` 使用的 handoff → `Orchestrator.run()` 共用部分抽成內部
function；既有 `bin/dev-flow`、`npm run orchestrate`、Issue queue 與其 argument
語意保持不變。bridge 只接受：

```text
--handoff <absolute path>
```

所有其他 flags、positional input、缺少 handoff、非 task-resolved repo 或不合法
handoff 都 deterministic fail closed。它以固定 argv 呼叫同一個
`Orchestrator`、同一個 `PiProcessAdapter`、`ShellTestRunner` 與既有 routing／
cycle policy；不得在 bridge 或 Python wrapper 另寫 implement → tests → reviewer
→ retry loop。bridge 不接受也不實作 `--run-root`；既有 Orchestrator 繼續把
ledger 寫在 task repo 的 `.orchestrator/runs/`，exporter 再將 allowlisted 內容
複製到 `/logs`。這避免新增或重定向 ledger producer，也不改既有 max cycle、
session isolation、tool allowlist、routing tier 或 review 語意。

bridge process 的 stdout/stderr 只能留下去識別 status、run ID 與錯誤分類；
prompt、auth、environment secret 與 verifier result 不寫入 bridge log。

### Auth 與 model boundary

auth 只由 Harbor agent config／`extra_env`／agent environment injection 提供。
wrapper 不讀取、解析、複製或落盤 `auth.json`、API key、Codex subscription
token，不將 auth path/value 寫入 repo、handoff、trajectory 或 log。已查證 Pi
0.82.1 的 config contract：`PI_CODING_AGENT_DIR` 指向的目錄內使用
`auth.json`，已知 `openai-codex` model catalog 隨 Pi 提供，不需把整個 host
`.pi` 目錄複製進 task。wrapper 只接受明確的 host `pi_auth_json_path` kwarg，
並在 model command 前拒絕缺失、symlink、非 regular file 或 group/world-readable
source；不讀 credential value。它將單一檔案上傳到 container 的固定、非 `/logs`
暫存路徑；必須先由 root 建立該目錄、設為 agent uid/gid 並 `chmod 700`，再
upload 檔案，最後由 root 設檔案 owner、`chmod 600`，確保預設 agent 可 traverse。
所有 compatibility、scope、acceptance 與 bridge context 純驗證必須在 auth upload
前完成；以同一個 `PI_CODING_AGENT_DIR` env 傳給 bridge，bridge 結束後刪除。
source path、target
path、auth value 都不寫入 handoff、context、trajectory、telemetry 或
runtime-resolved；無法 upload/chown/chmod/cleanup 時分類為
`harness_incompatibility`。install-only 不需要 auth，也不執行 model。

model、reasoning、timeout 由 Harbor config 傳入並保存於 artifact metadata；
wrapper 不從 instruction 覆寫。單題 model smoke 必須由人明確指定 fixed task
revision/digest、模型、reasoning、timeout、trial count、預算與 auth；不接受
自動 retry／upload／leaderboard。

### Artifact、ATIF 與 telemetry mapping

bridge 在 task-resolved repo 的 `.orchestrator/runs/<run-id>/` 產生既有 ledger，並只把下列
去識別檔案輸出到 `/logs/agent/full-dev-flow/`：

```text
handoff.json              # 已移除 secret 的實際 mapping
bridge-result.json        # status、runId、timestamps、error category
telemetry.json            # canonical cross-harness telemetry；缺值為 null
trajectory.json           # minimal valid ATIF；無法保證欄位時仍可為空 usage
artifact-manifest.json    # source/destination/hash，不含 verifier reward
```

`trajectory.json` 放在 `/logs/agent/trajectory.json` 作 Harbor 標準入口；上述
子目錄副本只作分類。`.orchestrator/runs/<run-id>/` 只輸出經 allowlist 的
handoff、cycle summary、test evidence、review finding fingerprint 與決定性
report；不得整包複製含 prompt、auth 或秘密的原始 event。需跨 trial 保存的
非秘密檔案放在 `/logs/artifacts/orchestrator-runs/<run-id>/`，依 Harbor
`/logs/artifacts` convention 收集並以 manifest 記錄。

exporter 使用 foundation 的 `normalizeBenchmarkArtifacts()` 與
`BenchmarkTrialTelemetry`：

- `.orchestrator/runs` 提供 `runId`、cycles、roles、tiers、tests、review evidence
  與 duration；沒有 provider token/cost 就是 `null`。
- Pi/Codex raw usage 只有在實際 log 有欄位時才映射；`n_cache_tokens`／cache
  read/write、derived uncached 與 final-vs-step precedence 沿用 foundation
  contract。
- `AgentContext.n_input_tokens` 包含 cache read 的總 input；
  `n_cache_tokens` 只填 raw cache aggregate；沒有可靠 billing/pricing evidence
  時 `cost_usd`、estimated cost、actual cost 都是 `null`。
- `verifier_result`、`/logs/verifier`、`reward.txt` 不進 exporter input，也不
  回填 AgentContext。Harbor 最終 reward 只在 Harbor trial result 由 verifier
  產生；它不會成為 agent 的 observation、prompt、retry decision 或 Full
  dev-flow ledger input。

`populate_context_post_run()` 只讀 host `logs_dir` 內上述 exporter 結果，回填
`AgentContext` 的 usage、run id、artifact references、normalization warnings；
若檔案不存在或 JSON invalid，保守保持 null 並記錄非秘密 warning。它不讀
workspace 的 verifier path，不重跑 tests，不改 reward。

### Verifier、tests visibility 與 revision lock

Harbor task 的 verifier 預設可為 `shared`；`separate` 需由 task config evidence
明確證明。Full dev-flow compatibility 不以「有 verifier」推論 tests hidden，
也不把 Harbor verifier 直接當作既有 handoff deterministic gate。每個 smoke
task 必須保存：task id、dataset revision、task digest、workdir、Git state、
tests visibility、verifier mode、network、timeout 與 compatibility decision。

本機 `fix-git` oracle 的 `task_id.ref=latest`、reward 1/1 artifact 只作 Harbor
0.20.0 shape/capability evidence；正式 Full dev-flow smoke 必須以固定 dataset
revision 或 task package commit/digest lock 重跑，並在 report 明示兩者不是同一
種證據。官方 regrade 對 completed single-step/separate-verifier/artifact
manifest 有限支援，但不等於任意 `.orchestrator` cycle snapshot replay；本張
不實作 replay、regrade 或 verifier feedback。

## Invariants and non-goals

- 這是第三個 evaluation harness，不改入口 A（Issue queue）或入口 B（Pi／CLI）
  的 command、routing、cycle、session、review、Git delivery 或 ledger producer
  語意。
- Python agent 是 thin delegation layer；orchestration loop、retry、review、
  tests 與 completion policy 只有既有 TypeScript core 一份。
- 所有不確定的 workspace、Git、tests、verifier、revision、digest、runtime
  version 與 artifact boundary 在 model call 前 fail closed。
- 不把 verifier reward 回饋 agent；不把 missing usage/cost 轉成 0；不把 session
  reuse 當 cache hit。
- 沒有 host repo path、floating latest、未 pin 的 Node/Pi、秘密或 credential
  進 container bundle、handoff、logs、ATIF、telemetry 或 artifact manifest。
- `npm test` 與所有預設 tests 不需要 Harbor、Docker、網路、Pi/Codex auth、模型
  或既有 `.orchestrator`。

## 修改範圍

1. 新增 `packages/harbor-full-dev-flow/` Python package、release bundle manifest
   與 stdlib-only fake Harbor/environment contract tests；實際 Harbor import
   test 以 optional local command 執行，不成為 npm gate。
2. 新增 `src/harbor-bridge.ts` 及 `bin/harbor-dev-flow`；必要時從 `src/cli.ts`
   抽出不改語意的共用 `runOrchestratorFromHandoff` function。
3. 新增 Harbor wrapper 的 compatibility manifest loader、workspace/Git/version
   preflight、fixed-argv invocation、ATIF/telemetry exporter、artifact allowlist
   與 `AgentContext` mapping。
4. 更新 `docs/benchmarks/harbor-terminal-bench.md`、`docs/overview.md`、
   `docs/rules/testing-and-safety.md` 與必要 package README，清楚區分
   install-only capability、model smoke 授權與 fake fixture。
5. 只使用 foundation 已定義的 runtime config、task compatibility、telemetry
   normalizer 與 fake fixture contract；不另造 reward/cost ledger。

## 排除範圍

- 不安裝或升級 Harbor，不修改 uv/global Harbor package，不要求 npm test 使用
  Harbor 0.20.0、Docker daemon 或網路。
- 不跑任何 Codex、Pi、Full dev-flow model trial，不消耗 subscription/API 額度，
  不做 benchmark score、成本／成功率宣稱、不 upload、不上 leaderboard。
- 不做 0..10 輪策略、三輪／五輪／十輪 ablation、session reuse、cache policy、
  no-review 對照、snapshot replay、offline verifier、regrade 或 reward feedback。
- 不在 wrapper 裡重寫 core orchestration，不改兩個既有入口、不改 Pi adapter、
  routing、maxFixCycles、reviewer、GitHub queue、commit/push/PR/merge/deploy。
- 不承諾所有 Terminal-Bench task 都是 Git repo、clean tree、deterministic tests
  或 hidden verifier；不以 fix-git latest artifact 代替正式 locked smoke。
- 不把 full dev-flow 本身當 Harbor built-in agent；只實作明確的 custom import
  path delegation contract。

## 驗收條件

- Python wheel 可在無 host checkout path 的情況下提供
  `harbor_full_dev_flow.agent:FullDevFlowAgent`；fake import test 能確認 class
  是 installed-agent contract 的薄 wrapper，缺失依賴／錯誤 import path 會有
  deterministic error。
- fake environment 測試覆蓋 install 的 bundle digest、Node/Pi version、Git/
  workdir/compatibility fail-closed，以及不存在或未知 tests/verifier/revision/
  digest 時不呼叫 model bridge。
- bridge 的固定 argv／handoff test 證明 instruction 只進 objective、tests 只
  來自 locked manifest、task-resolved workspace 逃逸與未知旗標被拒絕，且既有
  core runner 只被呼叫一次；沒有第二套 retry/review loop。
- fake runner／fake logs 能產生 `handoff.json`、`bridge-result.json`、minimal
  ATIF `trajectory.json`、canonical telemetry、artifact manifest 與
  `.orchestrator/runs` allowlisted mapping；secret-like values與 verifier reward
  不出現在任何 agent log/context/prompt。
- final usage 優先於 trajectory/step metrics；缺 usage/cache/cost 為 null；
  `n_cache_tokens` 不會冒充 cache write；沒有 pricing/billing evidence 時兩種
  cost 都是 null；`AgentContext` 欄位與 foundation normalizer 相符。
- Harbor `--install-only` 的 optional local integration test（有 Harbor 0.20.0
  package、Docker、固定 local task path 時）能載入真 wrapper、完成 setup/install
  後退出，且不執行 agent command／verifier；該命令不列入 npm test。任何真 model
  smoke 仍需人工 auth、預算、task revision/digest、model/reasoning/timeout 與
  explicit confirmation。
- 文件與測試明確寫出 `fix-git@latest` 僅 capability evidence、shared verifier
  不等於 hidden tests、官方 regrade 不等於任意 cycle snapshot replay。
- 既有兩入口與現有 foundation tests 維持通過；無 production core 行為漂移。
- `allowLocalCommit=true` 不屬於本張可執行範圍；commit-capable benchmark mode
  必須先完成 follow-up 的 baseline SHA 與 `baseline..HEAD` 加 working-tree diff
  evidence，不能只放寬 prompt。

## 測試要求

以下是 clean checkout 可執行的 raw shell commands；不依賴全域 Harbor、Docker、
網路、auth 或秘密：

- `npm ci`
- `npm test`
- `python3 -m unittest discover -s packages/harbor-full-dev-flow/tests -p 'test_*.py'`
- `npm run build && node dist/harbor-bridge.js --help`
- `git diff --check`

Python tests 必須以 repository 內的 stdlib fake Harbor module／fake
`BaseEnvironment`／fake context 執行，不能偷裝 Harbor。Optional integration
command 只供人工在已準備好環境執行，不能放進上述 gate：

```bash
harbor run --install-only \
  -a harbor_full_dev_flow.agent:FullDevFlowAgent \
  -p /absolute/path/to/locked-task \
  -e docker -k 1 -n 1 --yes
```

它需要 Docker、可載入的 Harbor 0.20.0 與 locked local task；不代表模型 smoke
已授權，也不應在本 spec 產生 benchmark result。

## Verified local integration evidence

2026-08-21 以 Harbor `0.20.0` 真實 Docker install-only 執行 custom wrapper，完成
bundle upload、pinned Node/Pi setup、wheel import 與 lifecycle，`0 exceptions`，總
runtime 約 `1m16s`。本次只執行 install-only，沒有 agent model call、verifier trial、
benchmark score、結果上傳或 commit；原始 Harbor artifacts 保留於：

`/private/tmp/dev-flow-harbor-custom-install-only-runtime/2026-08-21__02-46-13`

這項 evidence 只證明第三入口可在已授權的 Harbor runtime 完成 no-model install-only；
正式評測仍須先鎖定 task revision/digest、三個 harness 配置、單題預算與人工確認。

## 風險

- Harbor 0.20.0 的 Python interface、ATIF parser、artifact collection 與 CLI
  可能變動；wrapper package version、import contract tests、captured shape
  fixture 與 optional install-only test 共同限制 drift。
- Harbor host import 與 task-container runtime 是兩個 Python/filesystem boundary；
  wheel 能被 host import 不代表 container runtime 已可執行，反之亦然。manifest
  digest/version check 必須在 model call 前完成。
- Terminal-Bench task 的 task image 可能缺 Node、Pi、Git 或 deterministic test；
  compatibility metadata 與 setup preflight 要先拒絕不相容 task。Node/Pi 只可
  依本 spec 的 pinned Harbor-Pi setup 安裝，不可下載未 pin 的依賴或猜測 `/tests`。
- Pi 透過 Codex subscription 的 auth 由 explicit `pi_auth_json_path` 單檔注入；
  wrapper 不驗證登入成功或帳單，且不複製 whole config directory。缺 path 或
  權限不符時在 model 前 fail closed。
- 現有 `src/cli.ts` 是 inline orchestration wiring；抽 bridge 若未共用同一個
  runner 可能產生第二套語意，實作時必須以 contract test 鎖定一次呼叫與同一組
  dependencies。
- `.orchestrator/runs` 可能含 prompt、raw Pi events 或其他敏感內容；只能 export
  allowlisted summaries／fingerprints，不能用整個目錄作 artifact。

## 未決事項

無。Harbor 0.20.0 import／lifecycle／path／artifact contract、package boundary、
bridge boundary、auth boundary、compatibility fail-closed 與 no-model test
策略均已由本機 source、`--help`、foundation contract 與 captured real artifact
決定。固定 smoke task 的 revision/digest、runtime bundle 的實際 Node/Pi 版本與
模型預算是執行時輸入，不是本張 spec 的未決依賴。
