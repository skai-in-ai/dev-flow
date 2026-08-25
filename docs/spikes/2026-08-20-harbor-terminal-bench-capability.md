# Harbor / Terminal-Bench 2.1 capability spike

日期：2026-08-20
範圍：唯讀文件／本機 readiness；沒有執行模型 trial、沒有上傳結果、沒有修改 production core。

## 結論摘要

目前可以開始寫第一張 implementation spec，但還不能宣稱 Harbor 已在本機可執行：Docker daemon 沒有啟動，Harbor CLI 尚未安裝。本 spike 也發現兩個需要修正 umbrella draft 的邊界：

1. Harbor 已經內建 `pi` installed agent，所以 Single Pi baseline 可以先用 Harbor 的 `--agent pi`，不必先寫 single-Pi adapter。
2. Harbor 的 verifier 預設是 shared container；Terminal-Bench 2.1 的任務不應統稱為「agent 看不到的 hidden verifier」。要逐題記錄 verifier mode；若要保留不洩漏的實驗語意，必須只使用 separate verifier 且確認其 artifact 輸入。

Harbor 對「完成後用另一個 verifier 重評」有官方 `harbor trial regrade`／`harbor job regrade`，但它不是任意 workspace snapshot replay：目前要求 single-step source trial、separate verifier，以及 source trial 已收集的 artifact manifest。因而「每個 dev-flow cycle snapshot 都由官方 verifier 離線評分」尚未被直接證明，應先做一個不含模型的 regrade fixture spike。

## 1. 版本與安裝

官方穩定版目前為 Harbor `0.20.0`（GitHub release tag `v0.20.0`，commit short SHA `459ff6e`；PyPI 亦列為最新穩定版）。可固定安裝：

```bash
uv tool install "harbor==0.20.0"
# 若要 Daytona，改用：
uv tool install "harbor[daytona]==0.20.0"
harbor --version
harbor run --help
```

本機沒有執行安裝：這會修改使用者的 uv tool 環境並下載 Python 依賴；目前 Docker 也未啟動，先保留給明確授權的 setup step。官方安裝文件同時列出 `uv tool install harbor` 與 `pip install harbor`，但 benchmark 應以固定版本而非 floating `latest` 執行。

版本策略：implementation spec 應固定 `harbor==0.20.0`，並在 benchmark artifact 保存 `harbor --version`、Python／uv 版本、Docker server version、dataset lock/digests。不要只記 `terminal-bench/terminal-bench-2-1@latest`。

## 2. Terminal-Bench 2.1 dataset 與 task subset

官方 Terminal-Bench 2.1 repository 的 `tasks/dataset.toml` 列出 89 個 task，dataset 名稱為 `terminal-bench/terminal-bench-2-1`，每個 task 都有 SHA-256 archive digest。官方 README 的基準命令是：

```bash
harbor run -d terminal-bench/terminal-bench-2-1 \
  -a <agent> -m <provider/model> \
  --ak reasoning_effort=<effort> \
  -e docker -k 5 -n <concurrency>
```

官方 task-level 命令可直接跑單題：

```bash
harbor run -t terminal-bench/fix-git \
  -a pi -m <provider/model> -e docker -k 1 -n 1
```

固定 5 題 subset 的可靠做法是先把指定 task 以 package digest 下載／建立本地 dataset，再用 `harbor run -p <local-dataset>`；不應依賴目錄排序或 `@latest` 的當日內容。若只是 capability smoke，可分別以 `-t terminal-bench/<task>` 執行 5 個單題 job，並將每個 job 的 `config.json`／`lock.json` 保存。

第一批 task 不應全挑 Git coding。建議 subset 涵蓋：

- `fix-git`：有 Git repository 的 recovery 類任務。
- `cancel-async-tasks` 或 `filter-js-from-html`：程式修改／debug。
- `headless-terminal` 或 `configure-git-webserver`：CLI／系統操作。
- `count-dataset-tokens` 或 `financial-document-processor`：資料／檔案處理。

這只是候選清單，正式 task IDs、dataset digests 與 timeout 必須在 setup 後由實際下載的 manifest 再確認。Terminal-Bench 2.1 官方說明為 89 題，且其 repo README 說明 2.1 對 2.0 有 26 題修改；公開 blog 對修改數有不同敘述，報告時只使用 task count 與固定 digest，不把修改數當成實驗指標。

## 3. Agent、模型、auth 與 reasoning

Harbor 目前內建 `codex` 與 `pi` agent；`harbor run --help` 是列出實際可用 agent 的官方入口。這使第一輪 baseline 可定義為：

```text
Codex CLI baseline: --agent codex
Single Pi baseline: --agent pi
Full dev-flow: custom Harbor agent → 現有 Orchestrator.run()
```

Harbor 的 `codex` installed agent：

- `--model provider/model` 指定模型。
- `--ak reasoning_effort=xhigh` 會轉成 Codex CLI 的 `-c model_reasoning_effort=xhigh`；Harbor 官方 Terminal-Bench 範例使用 `--ak reasoning_effort=<effort>`。
- 預設把 Harbor 的 model connection 以 `OPENAI_API_KEY` 寫入 container 內的暫時 Codex auth；這是 API-key 路徑。
- 若要使用 ChatGPT／Codex 訂閱登入，Harbor Codex agent 支援 `CODEX_AUTH_JSON_PATH=/path/to/auth.json` 或 `CODEX_FORCE_AUTH_JSON=1`，把本機 Codex `auth.json` 注入 container 的暫時 `$CODEX_HOME`。這不等於 `harbor auth login`。
- `harbor auth login` 是 Harbor Hub 的 GitHub 登入，供 registry／job upload 使用；它不是模型登入，也不應在 smoke 前自動 upload。

Pi agent 的相應設定是 `--ak thinking=high`，並使用 Pi 的 `--model`／provider 路徑。Harbor 內建 Pi agent 的來源明確實作了 `install`、headless `pi --print --mode json`、session logs 與 usage extraction，並支援 resume；所以 Single Pi baseline 可直接復用，不需 duplicate Pi wrapper。

本機 auth readiness：

```text
codex --version       → codex-cli 0.144.4
codex login status    → Logged in using ChatGPT
codex doctor          → auth configured, ChatGPT tokens present
pi --version          → 0.82.1
```

`codex doctor` 同時報告 provider reachability、state/memories database 與 terminal environment 警告；這只能算 CLI auth 已配置，不能算 Harbor container auth 或網路 ready。不可把訂閱的實際美元扣款假設成可得；要以 token、call count、duration、rate-limit 記錄為主。

## 4. Custom agent 介面與 dev-flow 接入

Harbor 官方支援兩種 custom agent：

- `BaseAgent` external agent：以 `BaseEnvironment.exec` 操作 sandbox。
- `BaseInstalledAgent` installed agent：在 task container 安裝並以 headless mode 執行。

installed agent 的最小介面是：

```python
class MyAgent(BaseInstalledAgent):
    async def install(self, environment): ...

    @with_prompt_template
    async def run(self, instruction, environment, context): ...

    def populate_context_post_run(self, context): ...
```

Full dev-flow 應走 installed/custom agent 或等價可載入 import path；`run()` 只負責把 Harbor instruction 轉成既有 handoff，呼叫已編譯的 dev-flow core，並把 `.orchestrator/runs/` 與 compact Pi traces 映射到 Harbor logs。不可在 adapter 裡重寫 implement → tests → reviewer → retry loop。

第一張 implementation spec 的最小邊界應是：

1. 一個 custom agent import path／wrapper contract。
2. Harbor instruction → temporary handoff/workspace preflight。
3. Full dev-flow 呼叫現有 `Orchestrator.run()`。
4. 將 run ID、summary、role usage 與 compact trace 寫入 Harbor artifact convention directory。
5. 不先做 production ablation flags、不先做官方 upload、不先修改兩個既有入口。

## 5. Workspace、tests 與 verifier 邊界

Harbor task 由 `instruction.md`、`task.toml`、`environment/`、`tests/`（以及可選的 `solution/`）組成；它不是一個由 dev-flow 建立的新長期 repo。不同 task 的工作目錄、Git 狀態、依賴、資源與網路都由 task image/config 定義。

`fix-git` 可作為具體證據：其 instruction 是一句話，task image 為 `alexgshaw/fix-git:20260403`，工作內容位於 `/app/personal-site`，且環境本身是 Git recovery scenario。這證明「有些題目含 Git repo」；不證明所有 89 題都符合 Git repo、clean tree、或 dev-flow deterministic test 前提。

更重要的是 verifier：Harbor 文件明確表示 `shared` 是預設，`[verifier.environment]` 才會啟用 separate verifier。shared verifier 能看見 agent container 的工作目錄與環境；tests 會在 runtime 以 `/tests` 形式使用。因而 adapter 不能無條件宣稱 Terminal-Bench verifier 是 agent 看不到的 hidden test，也不能把 Harbor verifier 當成現有 handoff 的 deterministic test command。

implementation spec 必須為每個 task 保存：

```text
workspace root / workdir
git detected? / baseline state
tests visible to agent?
verifier.environment_mode = shared | separate
network mode / timeout / resources
compatibility = compatible | harness_incompatibility | environment_failure
```

若研究問題需要不洩漏 verifier，先只納入確認為 separate verifier 的 task；若官方 task 是 shared，應在報告中明示這個限制，而不是由 adapter 私自移除或隱藏 `/tests`。

## 6. Snapshot 與離線 verifier replay

官方有 `harbor trial regrade` 與 `harbor job regrade`：

```bash
harbor trial regrade <completed-trial-dir> \
  -p <task-with-separate-verifier> -e docker
harbor job regrade <completed-job-dir> \
  -p <task-or-dataset-with-separate-verifier> -e docker
```

regrade 不重新啟動 agent，而是使用 source trial 的 agent/verifier artifacts，建立新的 verifier trial，並保留 source provenance；因此沒有模型額度，也不需要 agent credentials。官方限制包括：source 必須是 completed single-step trial、有 readable `result.json` 與 `artifacts/manifest.json`；新的 verifier 必須是 separate mode；所有宣告的 verifier inputs 必須仍在 source artifact manifest；multi-step 尚未支援。

這可以支持「試驗完成後重評同一份已保存 artifact」，但尚未直接支持「把 dev-flow cycle 0..10 的任意 live workspace snapshot 當成 Terminal-Bench 原 verifier 逐輪重跑」。要做到後者，必須先證明：

1. 每個 cycle snapshot 能以官方 artifact collection 完整還原 verifier 所需的檔案與路徑。
2. task verifier 是 separate mode，且能從這些 artifact 評分。
3. regrade 不把結果回饋給原 trial 的 agent、prompt、decision log 或下一 cycle。

第一個無模型 fixture 應只測 regrade 的 artifact manifest、provenance 與 result isolation；若 Terminal-Bench 原 task 不符合，就把 cycle analysis 限定為 dev-flow deterministic evidence，不能自製一個聲稱等價的 verifier。

## 7. Harbor telemetry 與 cache 可觀測性

官方 job layout 可觀察：

```text
jobs/<job>/
  config.json
  result.json
  <trial>/
    config.json
    result.json
    agent/trajectory.json
    agent/recording.cast
    verifier/reward.txt
    verifier/ctrf.json
    verifier/test-stdout.txt
    verifier/test-stderr.txt
```

ATIF trajectory 支援 step-level 與 final-level metrics，包括 prompt/input tokens、completion/output tokens、cached tokens、cost、model、llm call count 與 tool calls。Harbor 的 Codex parser 也會從 Codex `token_count` events 讀取：

```text
input_tokens
output_tokens
cached_input_tokens
cache_write_input_tokens
reasoning_output_tokens
total_tokens
cost_usd（若 CLI 沒報，嘗試 LiteLLM pricing fallback）
```

在 ATIF/Harbor schema 中 cache read 通常呈現為 `cached_tokens`；cache write 可能放在 `extra`，不是所有 agent 都有一個同名的一級欄位。`uncached_input_tokens` 不是可靠的原始跨-agent欄位，不能在缺資料時以 `input - cached` 靜默冒充；若要輸出，必須標記為 derived 且保留原始欄位。

Pi 內建 agent 會解析 JSON message usage 的 input/output/cacheRead/cacheWrite/cost；Codex 內建 agent 會保存 `trajectory.json` 並把 usage 回填到 Harbor `AgentContext`。因此跨 harness telemetry 可沿用 Harbor trial artifacts + 本專案 `.orchestrator/runs/`，但 normalizer 要保留 `null`，不可把缺失的 cache/cost 寫成 0。

Harbor viewer 可比較 job、task reward、duration、trajectory、token breakdown、verification timing 與 artifacts；這很適合後續報告，但不取代本專案按 role/cycle 的 ledger。

## 8. 本機 readiness 檢查與實際輸出摘要

執行過的唯讀命令：

```bash
docker context ls
docker info --format 'Server={{.ServerVersion}} OS={{.OSType}} Arch={{.Architecture}}'
uv --version
harbor --version
pi --version
codex --version
codex login status
codex doctor
git rev-parse --short HEAD
git diff --check
```

摘要：

| 項目 | 結果 | 判定 |
|---|---|---|
| Docker CLI | 28.5.2 | 已安裝 |
| Docker daemon | `Cannot connect ... docker.sock` | blocker，需啟動 Docker Desktop |
| uv | 0.11.7 | 已安裝；`uv tool list` 因受限 cache 權限未完成 |
| Harbor CLI | `command not found` | 未安裝；需明確 setup |
| Pi | 0.82.1；`PI_CODING_AGENT_DIR=/private/tmp/... pi --help` 成功 | 本機 Pi executable ready；未做模型 call |
| Codex CLI | 0.144.4；ChatGPT login status 成功 | host auth configured；container injection 未驗證 |
| Codex doctor | auth configured，但 reachability/state/memories/TERM 有警告 | 不能算 Harbor E2E ready |
| 本 repo | commit `d0c461e`；既有 umbrella spec 為 untracked draft | 未改 production |

沒有執行：`uv tool install harbor`、任何 `harbor run`、oracle／agent trial、Docker image build、`harbor auth login`、`harbor upload`。因此沒有模型消耗、沒有結果上傳、沒有 benchmark score。

## 9. Confirmed / unconfirmed matrix

| 問題 | 狀態 | 證據／下一步 |
|---|---|---|
| Harbor 安裝方式 | confirmed | 官方 docs：uv/pip；建議 pin `0.20.0` |
| Harbor 可固定版本 | confirmed | release `v0.20.0`、PyPI stable；仍需本機安裝後保存 lock |
| TB 2.1 task count | confirmed | 官方 `tasks/dataset.toml`：89 tasks |
| 固定單題命令 | confirmed | `harbor run -t terminal-bench/<task>` |
| 固定 5 題 subset 命令 | partial | 可用 task-level jobs 或 local dataset；需在 Harbor 0.20.0 `--help`／fixture 驗證完整 flags |
| Codex CLI model/reasoning | confirmed | `-m`, `--ak reasoning_effort=...`; Codex source maps to `model_reasoning_effort` |
| ChatGPT subscription auth | partial | Harbor Codex source supports auth.json injection；container smoke 尚未驗證 |
| Harbor Hub auth | confirmed | `harbor auth login` 只管 Hub／upload |
| Harbor built-in Pi baseline | confirmed | built-in `AgentName.PI` + installed Pi implementation |
| Full dev-flow custom interface | confirmed interface / unconfirmed integration | BaseInstalledAgent methods confirmed；本 repo wrapper 尚未寫 |
| Task is always Git repo | disproved | task format has no Git invariant；`fix-git` 只是具體 Git task |
| Tests/verifier always hidden | disproved as blanket claim | Harbor default verifier mode is shared；逐題確認 separate mode |
| Post-trial regrade | confirmed with limits | official trial/job regrade；single-step + separate verifier + artifacts required |
| Arbitrary cycle snapshot regrade | unconfirmed | 需 artifact/regrade fixture；不可直接假設 |
| Reward/trajectory/usage | confirmed | `result.json`, `reward.txt`, ATIF, agent logs；欄位缺失仍可能是 null |
| Cache read/write | partial | Codex parser exposes cached/read + cache-write in extra；跨 agent 欄位需 normalizer |
| Docker local execution | blocked | daemon 未啟動 |

## 10. 對 umbrella draft 的逐項答案

- Harbor/version/dataset/task IDs：可定為 Harbor `0.20.0`、dataset `terminal-bench/terminal-bench-2-1`、89 tasks；具體 smoke task digest 要在 download/setup 後寫入 config。
- 官方 snapshot verifier：只有官方 regrade 對「已收集 artifact + separate verifier」成立；任意 cycle workspace replay 尚未成立，umbrella 的 acceptance criteria 應改成先做 fixture proof。
- 第三入口位置：仍可放本 repo `src/` + `bin/`；Harbor custom agent import module 不是新 repo，但需要 container packaging contract。
- Single Pi contract：不用 custom adapter 先解；先調查／利用 Harbor built-in `pi`，並把其 output/usage 映射到共同 schema。
- Cache/session：Harbor Pi/Codex 都有 native session/usage hooks；provider cache hit 不由 session mode 推論；缺欄位為 null。
- 5/10 cycle：仍是後續 benchmark config；但 cycle snapshot 只有在 regrade fixture 成立後才可作離線 reward 曲線。
- Verifier leakage：不是 Harbor 全域保證；第一批 task 必須保存 verifier mode，shared task 不可標 hidden。

## 11. 建議的第一張可執行 implementation spec 邊界

第一張 spec 應只做「capability fixture + adapter contract」，不做付費 benchmark：

1. 固定 Harbor `0.20.0`、Node/Pi/Codex runtime 版本欄位與 smoke config schema。
2. 加入一個不呼叫模型的 fake Harbor trial／artifact fixture，驗證 `config.json`、`result.json`、ATIF usage、reward、null cache/cost 與 `.orchestrator/runs` normalizer。
3. 定義 custom installed agent 的 import/run/context contract；用 fake command 或 `nop` path 驗證 instruction、workspace preflight、run ID、artifact export，不啟動真 agent。
4. 定義 task compatibility metadata：Git、workdir、tests visibility、verifier mode、snapshot/regrade eligibility。
5. 加入 `harbor-preflight` 文件／命令，只檢查 Harbor binary、Docker daemon、task resolution、auth presence（不印秘密），不執行 trial。
6. 不修改 `bin/dev-flow`／`bin/dev-flow-worker`、production max cycles、session reuse 或 routing；不加入 `npm test` 的 Harbor install/run。

第二張 spec 才在 Docker 啟動、Harbor 安裝與明確模型預算後做：一題 oracle／baseline、同題 Single Pi、再同題 Full dev-flow；各 trial 是否可 regrade、verifier mode 與 usage evidence 必須逐項驗收。

## 官方來源

- [Harbor Getting Started](https://www.harborframework.com/docs/getting-started) — 安裝與 `harbor run`。
- [Harbor Agents](https://www.harborframework.com/docs/agents) — built-in agents、BaseAgent/BaseInstalledAgent、自訂 agent。
- [Harbor Evals](https://www.harborframework.com/docs/run-jobs/run-evals) — job/trial layout、reward、viewer。
- [Harbor Task Structure](https://www.harborframework.com/docs/tasks) — instruction、environment、tests、shared/separate verifier。
- [Harbor Regrade](https://www.harborframework.com/docs/run-jobs/regrade) — trial/job regrade 限制與 provenance。
- [Harbor ATIF](https://www.harborframework.com/docs/agents/trajectory-format) — trajectory 與 token/cost metrics。
- [Harbor Artifact Collection](https://www.harborframework.com/docs/run-jobs/results-and-artifacts) — `/logs/artifacts`、manifest、artifact replay inputs。
- [Harbor v0.20.0 release](https://github.com/harbor-framework/harbor/releases) — stable version/tag。
- [Harbor Codex installed agent source](https://github.com/harbor-framework/harbor/blob/main/src/harbor/agents/installed/codex.py) — auth.json/API key、reasoning flag、session、usage parser。
- [Harbor Pi installed agent source](https://github.com/harbor-framework/harbor/blob/main/src/harbor/agents/installed/pi.py) — built-in Pi headless runner、thinking、session、usage。
- [Terminal-Bench 2.1 README](https://github.com/harbor-framework/terminal-bench-2-1/blob/main/README.md) — dataset run、89-task leaderboard protocol、5 trials requirement。
- [Terminal-Bench 2.1 dataset manifest](https://github.com/harbor-framework/terminal-bench-2-1/blob/main/tasks/dataset.toml) — task list與每題 digest。
- [Terminal-Bench 2.1 fix-git task](https://github.com/harbor-framework/terminal-bench-2-1/tree/main/tasks/fix-git) — Git workspace example、task structure。

驗證：`git diff --check` 通過；未執行 Harbor/Pi/Codex 模型 trial。主要 blocker 為 Docker daemon 未啟動、Harbor 尚未安裝、以及 verifier isolation／cycle snapshot replay 尚未由本機 fixture 證明。
