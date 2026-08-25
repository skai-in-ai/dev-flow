# Harbor / Terminal-Bench foundation

持續更新的實測學習、缺口與決策 backlog 見
[Terminal-Bench / dev-flow 實測學習與決策 backlog](terminal-bench-learnings-backlog.md)。
任何新增 trial、telemetry 修正或實驗政策變更，先更新該 living document 的
status、owner、evidence 與 acceptance，再更新本文件的穩定 contract。

目前 repository 包含不消耗模型額度的 foundation，以及尚未執行付費 trial 的 Full dev-flow wrapper implementation：runtime schema、fake Harbor-like artifacts、跨 harness telemetry normalizer、task compatibility metadata、Python `BaseInstalledAgent` wheel、TypeScript bridge 與 read-only `bin/harbor-preflight`。

這是 evaluation-only 的第三個入口，不是 production dev-flow delivery，也不是 Terminal-Bench 分數。真實 Harbor 執行必須另行人工授權，固定：

- Harbor `0.20.0`
- dataset `terminal-bench/terminal-bench-2-1` 的非 `latest` revision、task IDs 與 SHA-256 digests
- harness、model、reasoning、timeout、verifier mode、trial count 與預算

## Full dev-flow wrapper

Host 端先安裝與 Harbor `0.20.0` 相同 Python environment 的 wheel，使用：

```bash
harbor run -a harbor_full_dev_flow.agent:FullDevFlowAgent --install-only \
  -p /absolute/path/to/locked-task -e docker -k 1 -n 1 \
  --ak pi_auth_json_path=/absolute/path/to/operator/pi-auth.json --yes
```

wheel 內嵌本 repo 已 build 的 `dist` JS、bridge assets、package metadata 與
manifest SHA-256，不內嵌 host/Mac Node binary，也不依賴 host checkout。container
setup 依 Harbor 0.20.0 內建 Pi 策略執行：nvm `v0.40.2`、Node major `22`、
`@earendil-works/pi-coding-agent@0.82.1`；實際 resolved Node/npm/Pi versions 會
保存。這些 version/tag pin 若沒有額外 installer/tarball checksum，不宣稱完整
cryptographic reproducibility。沒有 apt/network/permissions 時在 model call
前以 `harness_incompatibility` 停止；`--install-only` 不呼叫模型，但可能下載
上述 pinned runtime。

wrapper 只讀 task/environment contract 與 locked compatibility manifest，依實際
workdir/Git/tests/verifier boundary 建立一次 handoff，呼叫既有 TypeScript core。
ledger 保持在 task repo `.orchestrator/runs/`，只把 allowlisted summary/report、
ATIF、telemetry 與 artifact manifest 複製到 `/logs`；不接受 `--run-root`，不讀或
回饋 verifier reward，不把 secret 放入 handoff、prompt、context 或 log。

Pi 0.82.1 的已驗證設定 contract 是 `PI_CODING_AGENT_DIR` 下的
`auth.json`；wrapper 只接受明確的 host `pi_auth_json_path` kwarg，拒絕缺失、
symlink、非 regular file 或 group/world-readable source。它將該單一檔案暫存到
container `/opt/agent-orchestrator/pi-auth/auth.json`，以 agent uid、mode `600`
供 Pi 使用，並在 bridge 結束後刪除；該路徑不在 `/logs`，也不寫入 handoff、
context、telemetry 或 runtime-resolved。沒有明確 path 或權限不符時，在模型前
以 `harness_incompatibility` 停止。Pi 內建 `openai-codex` model catalog 已由
0.82.1 提供，現行 core 使用的 model/reasoning 仍依 TS core 的實際 wiring；
unsupported requested settings 只記錄 requested/effective evidence。

`npm test` 與 Python contract tests 使用 fake environment/exec，不需要 Harbor、
Docker、網路或 auth。上方 `--ak` 只在人工授權的真實 run/安裝設定中使用；真正
單題 model smoke 仍需人工固定 revision/digest、auth、model、reasoning、timeout、
trial count 與預算。

## 真實 install-only evidence

2026-08-21 已用 Harbor `0.20.0` 真實 Docker runtime 執行
`FullDevFlowAgent --install-only`：`0 exceptions`、約 `1m16s`，bundle upload、
Node/Pi pinned setup、wrapper import 與 lifecycle 均通過。Artifact 位置：

`/private/tmp/dev-flow-harbor-custom-install-only-runtime/2026-08-21__02-46-13`

這是 no-model install-only evidence，不是 benchmark 分數，也沒有執行 verifier、
模型 trial 或結果上傳。下一步是先鎖定單一 task revision/digest 與預算，再做三個
harness 的單題 smoke；其中 Full dev-flow 才使用本 custom wrapper。

另一次 Full formal artifact
`/private/tmp/harbor-first-formal-comparison/prove-plus-comm-full-dev-flow-formal-1`
已標記為 infrastructure-invalid、不得作為 benchmark 結果：bridge command 未先
載入 container 內的 NVM，導致 `node` 退出 127。修正後 bridge 會明確 source
`$NVM_DIR/nvm.sh`；該次 reward 不得納入 comparison telemetry。

Full formal-2 artifact
`/private/tmp/harbor-first-formal-comparison/prove-plus-comm-full-dev-flow-formal-2`
也標記為 `configuration-invalid`：其外部 reward 為 `1`，但 compatibility
manifest 的 deterministic test 錯誤要求 agent 完成後仍保持 clean tree，和
正常 proof 工作互相矛盾，因此 `includeInComparison=false`。修正版 config 只把
clean-tree 留在 wrapper preflight，task test 僅檢查輸入檔、`coqc` 與 exact Git root。

## 第一張正式 comparison task

`config/harbor/prove-plus-comm-run-plan.md` 鎖定官方
`terminal-bench@2.0` 的 `prove-plus-comm` derivative：只在 `/private/tmp` 的
Dockerfile 安裝 git 並建立 `/workspace` clean Git baseline，instruction、tests、
verifier、solution、task metadata 與 partial proof 保持 byte-for-byte。其 source
與 derivative canonical SHA-256、Full wrapper compatibility manifest、三路候選命令
與 `--print-config` 驗證結果都在 `config/harbor/`。

Codex、Single Pi subscription wrapper 與 Full dev-flow 已各完成一次有效的
`prove-plus-comm` 單題 trial；結果表與所有排除的失敗嘗試見
`docs/benchmarks/harbor-prove-plus-comm-first-comparison.md`。Harbor native Pi
本身仍不適用：0.20.0 沒有 auth-file kwarg，且會
安裝不存在的 upstream `@mariozechner/pi-coding-agent@0.82.1`；第三路已由
`harbor_full_dev_flow.agent:SinglePiSubscriptionAgent` 修正為 pinned
`@earendil-works/pi-coding-agent@0.82.1`，並以明確 `pi_auth_json_path` 做 ephemeral
auth upload/cleanup。`allowLocalCommit=false` 維持 current core review evidence
安全邊界；commit-capable 模式另見
`docs/benchmarks/harbor-commit-capable-mode-follow-up.md`；wrapper contract 見
`docs/benchmarks/harbor-pi-subscription-wrapper-follow-up.md`。

`harbor-preflight` 只檢查 binary、Docker daemon、版本與 auth presence。它不讀 auth 內容、不印 secret、不登入 Harbor Hub、不 pull image、不執行 `harbor run`，也不呼叫模型。測試使用 fake PATH binaries；fake fixture 永遠標記 `source: "fake-fixture"`，不可當作官方結果。

## Stage-2 five-task smoke preparation

第一張 `prove-plus-comm` comparison 之後，已在 `/private/tmp` 準備四個同一
`terminal-bench@2.0` local extraction 的環境衍生題：`overfull-hbox`、
`regex-log`、`log-summary-date-ranges`、`polyglot-c-py`。每題只改
`environment/Dockerfile` 以安裝 git，並在各自的 `/app`（prove-plus-comm 為
`/workspace`）建立 baseline commit；source instruction、tests、verifier、solution
與 task metadata 都逐檔 byte-preserved。四份 locked Full compatibility manifest、
canonical SHA-256、scope 與 deterministic infrastructure test 見
`config/harbor/*-full-dev-flow-compatibility.json`，五題總表與三路命令模板見
`config/harbor/terminal-bench-stage2-five-task-run-plan.md`。

目前狀態是 `prepared-no-trial`：沒有建 Docker、install-only、verifier 或模型
呼叫。每題固定 Harbor 0.20.0、Luna medium、Full maxTier 1、fresh session、
trial 1、retry 0、`allowLocalCommit=false`；先以 `--print-config` 做無模型解析，
再由人工確認預算後逐題跑三路。這五題只可形成第一個 smoke 分布，不能單獨宣稱
穩定 success rate、三輪 reliability 或 0..10 輪次結論。

Harbor task-level 命令（例如 `harbor run -t terminal-bench/fix-git`）預設可解析到 task ref `latest`；這適合 capability smoke，但不符合正式可重現設定。正式 smoke 必須保存明確 dataset revision、task IDs 與 digest，並由 runtime schema／semantic validator gate。

Telemetry 固定保留 raw／null／derived 的差異：`cacheReadTokens`、`cacheWriteTokens`、`uncachedInputTokens` 與 `sessionMode` 分開；如果 uncached input 由前兩者計算，會放在 `derived` 並保存公式。訂閱模式沒有帳單證據時，`actualCostUsd` 為 `null`。

Runtime JSON Schema 是 shape 層；TypeScript validator 另行 enforce task ID uniqueness、harness／agent pairing、baseline fresh／canonical `maxCycles`（以及只讀 legacy `maxFixCycles`）、revision trim/case-insensitive `latest` 與 notes credential-like rejection。generic `cost` 不是 pricing snapshot，沒有 pricing／billing evidence 時 estimated／actual cost 都是 `null`。Telemetry precedence 固定為 final totals > trajectory metrics > step metrics。

Task verifier mode 必須是 `shared`、`separate` 或 `unknown`。沒有 evidence 時不宣稱 tests hidden；目前官方 artifact regrade 能力不等於任意歷史 workspace snapshot replay，因此 snapshot restore／offline verifier 不在 foundation 範圍。Captured Harbor result shape 只作去識別 regression fixture，仍標記 `source: "fake-fixture"`。

後續真 Harbor adapter 必須以 `.agent/specs/2026-08-20-harbor-evaluation-foundation.md` 的 contract 為輸入，且另開 approved spec；不得在 `npm test` 或一般安裝流程中偷偷啟動 trial。
