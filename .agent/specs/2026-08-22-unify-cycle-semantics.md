---
repo: "/Users/skai.wu/side/agent-orchestrator"
status: approved
title: "統一 cycle 上限語意與相容別名"
created_at: "2026-08-22T00:00:00+08:00"
---

## 目標

將正常 dev-flow、Harbor Full wrapper、CLI、benchmark preregistration、文件與 telemetry 統一使用 `maxCycles` 語意：它是整個 workflow 最多允許的 implementation 次數，並包含第一次 implementation。core policy 以 `maxImplementationAttempts` 表達同一規則；新設定不再以 `maxFixCycles` 作為來源。

## 背景與決策

目前 `maxFixCycles` 表示失敗後額外修正次數，造成 `cycleCap=3` 必須人工轉換成 `maxFixCycles=2`，容易產生 off-by-one 與 telemetry/文件漂移。本 migration 定義：`maxCycles=1` 代表最多一次 implementation，`maxCycles=3` 代表最多三次 implementation。舊 `maxFixCycles`/`max_fix_cycles` 僅作 backward-compatible deprecated alias，且與新欄位同時存在時 fail closed。既有 artifacts 不改寫，只在讀取 normalization 時保留 legacy provenance。

## Invariants and non-goals

- 一個 cycle 是 implementation → deterministic tests → review（必要時 final review）；tier escalation、合格的 `needs_spec` 與 review escalation 不增加 implementation cycle。
- 任何失敗分支都只能透過 `nextCycle` 判斷是否還有 implementation attempt。
- `maxCycles` 必須是正整數；core 內部 `maxImplementationAttempts` 與它相等。
- 未指定新舊設定時 production 行為不變：預設仍為原本的 4 次 implementation（legacy default 3 retries）。
- 舊 artifacts 維持原文；normalizer 可輸出 `legacyMaxFixCycles`/來源，但不得回填或重寫檔案。
- 本任務不變更 setup timeout、Docker、模型、網路或真實 trial。

## 修改範圍

- `completion-policy`、`RepoConfig`、orchestrator 與 CLI/bridge：以 `maxCycles`/`maxImplementationAttempts` 為 canonical。
- Harbor wrapper 支援 `max_cycles` 新 kwarg；舊 `max_fix_cycles` 只可單獨使用並轉成 `maxCycles = old + 1`，寫入 deprecated provenance。
- bridge result、telemetry、runtime config、schemas 與 tests 反映 canonical field，legacy alias 只在相容層出現。
- fresh cycle-cap preregistration/run plan 改為 cap 1/3，移除人工 `-1` mapping。
- 更新 orchestration、wrapper、benchmark 文件與 migration notes。

## 排除範圍

- 不執行 Docker、Harbor trial、模型或網路。
- 不修改既有 benchmark artifacts、既有結果 manifest 或 production A/B 未指定的預設行為。
- 不在本任務處理 setup timeout amendment。

## 驗收條件

- `maxCycles=1` 最多執行一次 implementation；`maxCycles=3` 最多三次。
- tier escalation 與 review-only rerun 不消耗 implementation attempt。
- 新舊欄位同時傳入一律 fail closed；舊 alias 單獨傳入會產生 deprecated/legacy provenance。
- baseline Codex/Single Pi 不接受 cycle control；Full wrapper 接受 canonical `max_cycles`。
- telemetry requested/effective 保存 canonical `maxCycles`；legacy artifacts normalization 不猜測新設定。
- 舊測試與新 migration 測試通過。

## 測試要求

- `npm test`
- `python3 -m unittest discover -s packages/harbor-full-dev-flow/tests -p 'test_*.py'`
- `git diff --check`

## 風險

- 舊呼叫端若只傳 `max_fix_cycles` 仍可運作，但需看到 deprecation provenance。
- 既有 telemetry consumer 可能只認 `maxFixCycles`；schema normalization 需保留 legacy read path，不能刪除舊欄位的讀取能力。
- 外部 Harbor 版本若只傳 kwargs 不同時支援新欄位，wrapper 需在輸入層完成 deterministic validation。

## 未決事項

無
