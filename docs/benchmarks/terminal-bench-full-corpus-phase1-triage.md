# Terminal-Bench full-corpus Phase 1 triage

狀態：`approved`（2026-08-25）。這份文件是 Phase 0 inventory 後、任何模型
trial 前的唯讀 compatibility 摘要；不授權建立 derivative 或啟動 Harbor。

## 執行方式

```bash
bin/harbor-corpus-triage /absolute/path/to/terminal-bench-inventory.json \
  > /private/tmp/terminal-bench-phase1-triage.json
```

輸入必須是 `terminal-bench-corpus-inventory-1`。輸出只保留 inventory identity
（`inventoryDigest`）與 `sourceIntegrity.status=not-computed` 聲明；不把 operator-local
absolute path、protected content 或 source equality 填入結果。
輸出結構由 `config/harbor/terminal-bench-phase1-triage.schema.json` 固定。

## 分類規則

每個 task × harness 都會有 classification、reason、risk 與 relative provenance：

- Codex／Single Pi：workdir、Dockerfile、agent/verifier timeout 都已觀察且沒有
  明確 blocker 時為 `direct-compatible`。
- Full dev-flow：同樣的 facts 為 `derivative-required`，因為 clean Git baseline
  要由另外受控的 workspace-compatible derivative 提供；Phase 1 不自動建立。
- 明確 GPU、QEMU/VM、service/port、large build/resource，或缺 workdir、Dockerfile、
  timeout 時為 `blocked-readonly`。
- 規則不足時保持 `unknown`。task name 不參與推論。
- network dependency 只形成 risk stratum，不一律 blocked。

## Locked inventory 結果

本次 operator 提供的 inventory 為 89 tasks、267 entries（3 harnesses × 89）。
摘要數字由 `config/harbor/terminal-bench-full-corpus-phase1-triage.json` 產生，
不可手動改寫：

- Codex：63 direct-compatible、26 blocked-readonly。
- Single Pi：63 direct-compatible、26 blocked-readonly。
- Full dev-flow：63 derivative-required、26 blocked-readonly。
- 目前沒有可保守判定的 `unknown` entry。
- risk strata：network dependency clue 186 entries、resource limits declared
  267 entries、no public check candidate observed 138 entries。

`resource limits declared` 是風險資料，不等於 large-build blocker；只有 inventory
明確的 `buildLarge=true` 才進入 blocked-readonly。network 也不會因為有 clue 就被排除
出所有後續工作。

## Batch 0 建議（非執行授權）

固定排除已跑過的 `prove-plus-comm`、`overfull-hbox`、`regex-log`、
`log-summary-date-ranges`、`polyglot-c-py`、`large-scale-text-editing`、
`sqlite-db-truncate`，以及 GPU/QEMU/service/high-build-risk 題目。再要求 workdir、
Dockerfile、public check candidate 可觀測，並跨 category/difficulty 做 deterministic
selection。

本次建議 8 題：

`build-cython-ext`、`cancel-async-tasks`、`configure-git-webserver`、
`fix-code-vulnerability`、`llm-inference-batching-scheduler`、
`model-extraction-relu-logits`、`reshard-c4-data`、`video-processing`。

這只是下一階段人工審核與 preregistration 的候選清單；尚未讀 solution/tests/verifier，
也尚未判定這些題目的成功率、成本或適合哪一個 model。

## 稽核與停止條件

- 每個 entry 的 provenance 指向 task relative path、inventory digest 或 inventory
  rule；沒有 operator-local path。
- `sourceDigest` 必須維持 `not-computed`，不能由 inventory digest 宣稱 source
  equality。
- 同一 inventory CLI 連跑兩次必須 byte-identical。
- malformed inventory、缺少 source-integrity 聲明、或無法保守分類時 fail closed／保留
  unknown；不得人工猜測放行。
- Phase 2 以前不建立 derivative、不安裝 wheel、不跑 Docker、網路或模型。
