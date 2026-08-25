---
repo: "/Users/skai.wu/side/agent-orchestrator"
status: approved
title: "P0 benchmark telemetry: effective config, cache denominator, and session provenance"
created_at: "2026-08-22T00:00:00+08:00"
---

# 目標

補齊 evaluation-only Harbor benchmark 的 P0 telemetry contract，讓每一筆新 trial
可以回答三個問題，而且不把未觀測的值當成事實：

1. 每個 role/model call 實際使用了什麼 model、reasoning effort 與 tier？requested
   設定和 effective runtime 設定是否一致？
2. `input`、`uncached`、`cache read`、`cache write` 各自代表什麼？cache hit rate 的
   denominator 是否有 provider/source 證據？
3. agent session 是 fresh 還是 reused？這和 provider prompt cache 是否命中是兩件
   事，能否分別追蹤？

本 spec 只定義 contract、證據邊界、相容策略與驗收，不在本輪修改程式、不執行
Docker、網路或模型 trial。

# 背景與決策

本 spec 延續以下已核對資料：

- [實測學習 backlog](../../docs/benchmarks/terminal-bench-learnings-backlog.md)
- [stage-2 五題結果](../../docs/benchmarks/terminal-bench-stage2-five-task-results.md)
- [現有 normalized telemetry](../../src/benchmark/telemetry.ts)
- [Full Harbor bridge](../../src/harbor-bridge.ts)
- [Full／Single Pi wrapper](../../packages/harbor-full-dev-flow/src/harbor_full_dev_flow/agent.py)

目前的具體限制：

- Full wrapper 把 model/reasoning/timeout/trialCount 寫入
  `requestedConfiguration`；core bridge 會接線 `maxTier`，並在 evaluation-only
  repeated-trial mode 接受明確的 `maxFixCycles`。`effectiveConfiguration` 的其他
  欄位是 `null`，不能把 wrapper request 當成 effective evidence。
- Full ledger 可以按 role/cycle 聚合 usage，並已對 router 的 `message_end`／
  `trace.jsonl` duplicate 做局部去重；但沒有一個逐 model-call 的 canonical
  effective-config record。
- Single Pi 的 `message_end.usage.input` 和 `cacheRead` 在現有 artifact 中不能
  確認是「total prompt + cache read」或「uncached input + cache read」。目前
  `_write_pi_atif` 將兩者相加成 `prompt_tokens`，這不能反推 provider 原始語義。
- Harbor Codex artifact 的 raw usage 欄位由 Harbor/provider 版本決定；只有看到
  欄位名稱不能證明 denominator 定義。
- `sessionMode: fresh` 是 trial-level 的設定輸入，不代表每個 role/call 已證明
  沒有復用 session；同樣地，`cacheReadTokens > 0` 不代表 agent session reused。

因此採用以下原則：

- requested 是「操作者／Harbor command 要求什麼」；effective 是「runtime 有直接
  證據顯示實際套用了什麼」。兩者永遠分欄。
- 缺證據寫 `null`／`unknown` 並記 warning；不得由 model name、wrapper command、
  output token、cache read 或最後 tier 猜測其他欄位。
- raw provider 欄位原樣保存（受大小與 secret redaction 限制），normalized value
  只作查詢用途，derived value 必須附公式、source fields 與 provenance。
- agent session reuse 與 provider prompt cache 是兩個正交維度；任何報表都不可把
  一者當成另一者的 proxy。
- 以 additive schema migration 保留既有 `benchmark-trial-1` reader；歷史 artifact
  不重跑、不改寫、不補填新的 effective/cache/session 結論。

# Invariants and non-goals

## Invariants

- 既有 production dev-flow 入口 A（GitHub Issue queue）與入口 B（working-tree／CLI）
  的 routing、commit、push、merge、deploy、安全 invariant 與 handoff 行為不變。
- Harbor 第三入口仍是 evaluation-only wrapper；telemetry 不得把 verifier reward、
  hidden verifier output 或 agent 不應看到的答案送回 prompt。
- 每一個可計費或可計 token 的 model call 最多在 canonical call ledger 計數一次。
  `message_end`、`turn_end`、`events.jsonl`、`trace.jsonl` 的重複輸出不得重複加總。
- `requested` 不等於 `effective`。若 effective 不能由 direct runtime evidence 證明，
  該欄位為 `null`，並標記 `not-observed`／`unsupported`／`conflict`。
- `null` 不等於 0。未知 usage、unknown denominator、unknown session mode 與缺失
  billing evidence 不得被 normalization 或 aggregation 轉成 0。
- secret、access token、refresh token、auth file 內容、prompt、完整 agent message
  與 verifier reward 不可進 telemetry；source path 只能是受控 artifact reference，
  不得把 auth path/value 寫入 event payload。
- `actualCostUsd` 只有 provider billing evidence 才能填；catalog/subscription
  estimate 仍和 actual 分欄。

## Non-goals

- 不在這份 spec 中修改 model routing policy、tier policy、retry/cycle policy 或
  production core 的 completion behavior。
- 不承諾把所有 provider 的 cache semantics 統一成同一種 input 定義；只能表示
  provider/source 已證明的 semantics。
- 不回填 stage-1/stage-2 舊 artifact 的 effective model、cache denominator 或
  session reuse；舊資料只透過 backward-compatible reader 顯示 unknown/partial。
- 不做 provider billing integration、訂閱額度推估、token 價格猜測或實際付款對帳。
- 不把單一 Terminal-Bench 題目的 hidden verifier 條件寫成 task-specific gate。
- 不建立跨 trial 的長期 session reuse；本 spec 只記錄實際發生的 fresh/reused，是否
  開啟 reuse 是後續實驗政策，不由 telemetry 自動改變。
- 不在本輪執行任何網路下載、Docker build、Harbor run、Pi/Codex model call 或
  OAuth refresh。

# 修改範圍

實作階段預計只涉及 benchmark telemetry／wrapper evidence，不改 production A/B：

- `src/benchmark/telemetry.ts`：新增 benchmark-trial-2 canonical types、call-level
  config observation、cache semantics/provenance、session/cache separation 與 v1
  normalization warnings。
- `src/harbor-bridge.ts`：從 Full ledger／Pi event 的可見欄位建立 canonical call
  records；保留現有 allowlist、router duplicate 去重與 prompt 不落地邊界。
- `packages/harbor-full-dev-flow/src/harbor_full_dev_flow/agent.py` 及
  `bridge_contract.py`：傳遞 requested config、runtime-observation metadata、
  session preflight result；不在 wrapper 宣稱 core 未觀測的 effective 值。
- benchmark fixture、TS/Python tests：覆蓋 schema、migration、duplicate、null、
  secret redaction 與三 harness capability boundary。
- 如需更新 benchmark 文件，僅更新 backlog 的 GAP-01、GAP-02、GAP-04、GAP-11
  evidence/status；不得修改 production workflow 文件來暗示行為變更。

## Canonical data shape（提案）

新輸出使用 `schemaVersion: "benchmark-trial-2"`。ATIF 仍維持其原有格式；ATIF 的
`prompt_tokens` 不得取代下列 canonical semantics。

### Call-level config observation

每一個有 usage 或 runtime event 的 model call 都應有一筆 `orchestration.calls[]`。
欄位概念如下（實作可採等價 TypeScript type，但不得省略語義）：

```json
{
  "callId": "provider/event id or controlled ledger reference",
  "role": "router|implementer|reviewer|final_reviewer",
  "cycle": 1,
  "sessionId": null,
  "requested": {
    "model": "openai-codex/gpt-5.6-luna",
    "reasoningEffort": "medium",
    "tier": null,
    "maxTier": 1,
    "source": "harbor-config|wrapper-args|core-request|unknown"
  },
  "effective": {
    "model": {
      "value": null,
      "status": "not-observed",
      "source": "none",
      "evidenceRefs": []
    },
    "reasoningEffort": {
      "value": null,
      "status": "not-observed",
      "source": "none",
      "evidenceRefs": []
    },
    "tier": {
      "value": null,
      "status": "not-observed",
      "source": "none",
      "evidenceRefs": []
    }
  },
  "usage": { "...": "canonical usage fields described below" },
  "provenance": {
    "source": "ledger-file|pi-message-end|harbor-result|runtime-event",
    "sourceRef": "artifact-relative reference",
    "dedupeKey": "stable source event key or null"
  }
}
```

規則：

- `requested` 可以來自 manifest、Harbor config、wrapper CLI args 或 core request，
  但要保存 source；command line 不是 effective proof。
- `effective.*.status` 只允許 `observed`、`not-observed`、`unsupported`、`conflict`。
  `observed` 必須有 direct runtime sourceRef；`conflict` 保留衝突來源，不能選一個
  值靜默覆蓋另一個。
- `tier` 要分辨 requested `maxTier`（上限）與 effective selected tier（實際路由）；
  outcome 的最後 tier 只能作 run-level evidence，不能自動複製到每個 call。
- `callId` 缺失時不可用陣列 index 冒充 provider event id。可使用受控 ledger file
  reference 作 dedupe key；兩者都沒有時保留 `null` 並增加 completeness warning。
- `usageByRole`、`usageByCycle` 是從 canonical calls 產生的 derived totals，不是
  另一套可獨立加總的 raw source。若 legacy artifact 只有 aggregate，保留 aggregate
  並標記 call-level evidence missing。

### Cache/token semantics

每個 call 與 run total 都要保留四個可分開為 `null` 的欄位：

- `totalPromptTokens`：只有 provider/source 明確表示「整個 prompt token 數」時填值。
- `uncachedInputTokens`：provider 明確回報，或依已證明的同一-provider公式導出時填值。
- `cacheReadTokens`：provider 明確回報的 prompt cache read token 數；raw cache read
  不得被改名成 hit rate。
- `cacheWriteTokens`：provider 明確回報的 cache write token 數；不可當成 read
  denominator，也不可默認等於 uncached input。

另附：

```json
{
  "cacheSemantics": {
    "denominator": "totalPromptTokens|uncachedPlusCacheRead|unknown",
    "unit": "provider-token|unknown",
    "formula": null,
    "derived": {
      "cacheHitRate": null
    },
    "provenance": {
      "source": "provider-contract|runtime-usage|adapter-contract|none",
      "evidenceRefs": [],
      "confidence": "observed|derived|unknown"
    }
  }
}
```

可接受的公式只有在 source contract 證明欄位語義後使用：

- 若 `input` 明確是 total prompt，`cacheRead` 是其 subset：
  `uncachedInputTokens = totalPromptTokens - cacheReadTokens`，
  `cacheHitRate = cacheReadTokens / totalPromptTokens`。
- 若 `input` 明確是不含 cache read 的 uncached input，且 `cacheRead` 是同一 prompt
  的 read：`totalPromptTokens = uncachedInputTokens + cacheReadTokens`，
  `cacheHitRate = cacheReadTokens / totalPromptTokens`。
- 若上述任一語義未被 provider/adapter contract 證明：四個 raw/normalized field
  仍各自保留，但 `denominator=unknown`、`formula=null`、`cacheHitRate=null`。

任何 derived object 必須附 `formula` 與 `sourceFields`／`evidenceRefs`。不能用
`inputTokens - cacheReadTokens` 這個字串公式作為普遍規則；它只有在第一種語義被
證明時才合法。既有 `inputTokens` 欄位為了相容仍可保留，但新報表不可不加語義就
把它叫作 total prompt。

### Session 與 provider prompt cache

session telemetry 分兩層：

```json
{
  "session": {
    "mode": "fresh|reused|unknown",
    "scope": "trial|role|call",
    "sessionId": null,
    "evidence": "preflight-empty-session-dir|explicit-reuse|runtime-event|none",
    "evidenceRefs": []
  },
  "providerPromptCache": {
    "configured": null,
    "observed": null,
    "scope": "call|session|provider|unknown",
    "cacheReadTokens": null,
    "cacheWriteTokens": null,
    "semanticsRef": null,
    "evidenceRefs": []
  }
}
```

- `session.mode=fresh` 只在 model call 前已確認 session directory／session id 不曾
  被此 trial 使用，或 provider/runtime 明確回報 fresh 時使用。
- `session.mode=reused` 必須有 explicit reuse input 或 runtime evidence；同一個
  provider cache read 不構成 reused 證據。
- `sessionId` 不保存 session 內容。若需要跨檔案關聯，使用不可逆、受控 scope 的
  opaque hash；若來源可能含 secret，直接 `null`。
- `providerPromptCache.configured` 表示是否明確開啟／關閉 cache；
  `providerPromptCache.observed` 表示本 call 是否有 provider cache usage evidence。
  兩者都可以是 `null`，且不能由 `cacheReadTokens` 反推 configured。
- Pi 的 `--session-dir` 是 agent session 控制，不是 provider prompt-cache setting。
  Full 的每個 Pi role process 依現有 adapter contract 各用自己的 session，是否
  fresh/reused 需由 preflight evidence 記錄；不得在 aggregator 看到同一 model 時
  合併 session。

## 三種 harness 的能力與限制

| Harness | 可直接觀測／應保存 | 目前不能宣稱／需留 null |
| --- | --- | --- |
| Harbor Codex | Harbor config 的 requested agent/model/reasoning；artifact raw usage；若 Harbor runtime event 提供 call model/reasoning/tier，保存其 effective evidence；trial/session preflight evidence | 只看 `config.json` 不能證明 effective model/reasoning；只看 `input`/`cached` 不能證明 cache denominator；沒有 runtime session id 就不能宣稱 reused/fresh per call |
| Single Pi subscription | wrapper CLI/provider/model/thinking 的 requested；pinned Pi/Node runtime；Pi `message_end` raw usage；session directory 的 preflight；Pi event 若含 model/reasoning/provider 則保存 effective evidence | wrapper command 不是 provider effective proof；Pi `input` 與 `cacheRead` 未有 semantics contract 前不可算 hit rate；一次 Pi invocation 的多個 turns 不可誤寫成多個 agent sessions |
| Full dev-flow | wrapper requested config；core ledger 的 role/cycle；router/implementer/reviewer source refs；outcome selected tier；Pi process/session preflight；runtime event 若含 role/model/reasoning/tier 則保存 | 目前 core 只接 `maxTier`，不能把 requested model/reasoning 當 effective；outcome tier 不等於每次 call tier；舊 ledger 無 router usage／call identity 時只能 partial/lower-bound |

三者的 comparison eligibility：若某組 requested/effective model 或 cache semantics
沒有足夠 evidence，仍可報告 task reward、wall time 與 raw usage，但該組不得被描述為
「相同 effective model」或「cache hit rate controlled comparison」。

# Schema migration / backward compatibility

- Reader 必須接受 `benchmark-trial-1`、raw Harbor result、Single Pi ATIF 與新
  `benchmark-trial-2`。
- Reader 內部可 normalize 成 v2 shape；v1 欄位映射只做無歧義映射：
  `cacheReadTokens` 保留 raw，`totalPromptTokens`／`uncachedInputTokens` 若沒有
  semantics evidence 就是 `null`；`session.mode`、call effective config 及
  provider cache scope 為 `unknown`／`not-observed`。
- v1 `configuration.model`、`configuration.reasoningEffort` 與
  `orchestration.requestedConfiguration` 可映射到 `requested`，但不得映射到
  `effective`。v1 `tiers`／outcome tier 只可映射 run-level selected tier evidence，
  不可複製成每個 call 的 effective tier。
- 舊 `derived.uncachedInputTokens` 若是由既有不明 semantics 產生，reader 不得把它
  升級成 v2 valid derivation；應保留 legacy warning，必要時標為 `legacy-lower-bound`。
- 不修改原始 artifact、不覆寫 stage2 manifest；新 run 使用新的 manifest/schema
  version。每個 normalized output 需列 `migrationWarnings` 與 source schema。
- Aggregator 在 v1/v2 混合時，若任一納入 trial 缺 denominator semantics，pooled
  cache hit rate 輸出 `null`，不能只平均已知 trial 後把結果包裝成 complete。
- schema migration 不改 success/failure reward；只影響 telemetry completeness、
  effective-config comparability 與 cache-derived metrics。

# Raw / null / derived / provenance 規則

- `raw`：只保存 provider/Harbor/Pi 事件中必要的 scalar usage/config 欄位與
  artifact-relative sourceRef；不可保存 prompt、完整 message、auth、reward。
- normalized：把已知欄位轉成統一名稱與 numeric type，但保留來源欄位名稱和
  semantics status。
- `null`：來源沒有提供、來源語義未證明、或資料互相衝突時使用；不可以 0 替代。
- derived：只在公式前提明確時產生，並保存 formula、sourceFields、evidenceRefs、
  derivationVersion。derived value 不可覆蓋 raw value。
- provenance：每個 call 至少有 source kind、相對 sourceRef、dedupe key/status、
  schema version；effective/cache/session 的每個非 null 結論都要能回鏈 evidence。
- normalization warning：重複 event、缺 call id、v1 migration、partial/lower-bound、
  semantics unknown、conflicting model evidence 都需列出；報表沿用 warning 而不
  靜默修正。

# Security / privacy

- 不讀取或解析 auth token 內容；auth preflight 只留下 `authPreflight: passed|failed`
  與 failure phase，不留下 host/container auth path、token、refresh token 或 stderr。
- 不把 prompts、assistant text、handoff artifact body、verifier reward 或完整
  event payload 寫進 telemetry。只保存必要的 bounded scalar fields。
- `sourceRef` 只能是相對於受控 artifact root 的 path／opaque id；禁止將
  `/Users/.../.pi/agent/auth.json`、container auth path 或環境變數 value 放入。
- session id 若需要關聯，使用不可逆 opaque hash 並固定 salt scope；不能用 raw Pi
  session path 作為公開報表欄位。
- 日誌與 JSON artifact 權限延續現有 0600；redaction 測試要確認序列化結果不含
  `token`、`refresh_token`、`auth.json` 內容、prompt marker 或 verifier reward。

# 驗收條件

## Contract and normalization

- 新 schema 能表示每一個 canonical call 的 role、cycle、requested model/reasoning/
  tier、effective model/reasoning/tier status、usage、session 與 source refs。
- effective 欄位只有 direct runtime evidence 才能是 `observed`；wrapper requested、
  final outcome tier、model name 或 cache read 不得單獨升格。
- Full 的現況 fixture 會正確輸出 requested model/reasoning、effective
  model/reasoning=`null`／`not-observed`，effective tier 只在有 per-call evidence
  時填值；現有 stage2 舊 artifact 不被補值。
- 每個 role/cycle summary 可由 canonical calls 重算；router `events.jsonl` 與
  `trace.jsonl` duplicate、`turn_end` snapshot 不重複計數。

## Cache semantics

- 至少覆蓋三種 fixture：`input=total prompt`、`input=uncached prompt`、semantics
  unknown；前兩者只有各自合法公式，第三者的 hit rate 必須是 `null`。
- `cacheWriteTokens` 不會進 cache-read denominator；負值、cache 大於 total 或跨
  provider 混算必須產生 warning 並維持 derived null。
- 舊 Single Pi／Full fixture 只保留 raw cache read 與 partial/lower-bound warning，
  不因既有欄位名稱而回填 total/uncached/hit rate。

## Session/cache separation

- fresh session、explicit reused session、unknown session 三種 fixture 都能正確
  輸出；沒有 preflight/runtime evidence 時不可預設 fresh。
- `providerPromptCache.configured`、`observed`、`scope` 與 agent session mode 可
  各自為 null／不同值；測試必須證明 cache read 不會把 session 改成 reused。
- Single Pi 一次 invocation 的多個 assistant usage 仍屬同一 agent session scope；
  Full 不同 role process 不因 model 相同而合併 session。

## Compatibility and safety

- v1 raw Harbor、v1 normalized telemetry、v2 normalized telemetry 都可被 reader
  讀取；v1 缺 evidence 的欄位維持 null/unknown 且 warning 可見。
- production A/B regression 不變；benchmark telemetry failure 不會改變 agent
  completion status 或安全 invariant。
- fixture 序列化不包含 prompt、secret、auth file content 或 verifier reward。

# 測試要求

- `npm test`
- `python3 -m unittest discover -s packages/harbor-full-dev-flow/tests -p 'test_*.py'`
- `git diff --check`

正式 trial 驗證不屬於本 spec 的 no-model 實作驗收；完成程式與 fixture tests 後，另
由 benchmark run plan 安排一次新 Full／Single Pi artifact，確認 runtime effective
evidence 是否真的存在。若 runtime 沒提供 evidence，正確結果是 partial/unknown，
不是為了讓比較完整而推測。

# 風險

- Harbor、Pi provider event schema 可能只提供 requested/model label 而不提供
  reasoning/tier；implementation 必須接受長期 `not-observed`，不能為了 schema
  完整而讀取非公開內部狀態。
- 不同 provider 對 `input`／cache read 的計數單位或命名不同；錯誤統一會造成比
  成本更嚴重的錯誤結論。需在 semantics registry 中按 provider/package version
  登錄 evidence，不以欄位名稱匹配代替 contract。
- per-call event id 缺失時，duplicate 去重可能只能做到 source-local；需標 partial，
  不可用猜測的 hash 把兩次 call 合併。
- 把 session id 寫進 artifact 可能意外洩漏路徑或帳號資訊；預設 null，只有明確
  threat-reviewed opaque id 才可開啟。
- telemetry exporter 失敗若阻斷 Harbor task，會把觀測問題誤報成 task failure；
  除必要的 security/schema invariant 外，export 應 best-effort 並寫 bounded warning，
  不改原本 verifier 結果。

# 已解決的實作決策

1. **Pi 0.82.1 usage semantics**：本機鎖定的
   `@earendil-works/pi-coding-agent@0.82.1` source map 明確以
   `usage.input + usage.cacheRead + usage.cacheWrite` 計算 prompt tokens，並把
   `input + cacheWrite` 視為 paid/non-read buckets。因此僅對這個 package version，
   `input` 映射為 uncached input、total prompt 由三者相加；其他版本不繼承。
2. **Harbor Codex effective evidence**：Harbor 0.20 真實 Codex ATIF 的 agent 與
   step 提供 runtime `model_name`，model 可標為 observed；現有 artifact 沒有 direct
   reasoning/tier evidence，因此 reasoning/tier 維持 not-observed。Harbor config 仍
   只屬 requested evidence。
3. **Session identity policy**：canonical telemetry 不保存 raw session ID，也不建立
   opaque hash；`sessionId` 固定為 `null`。fresh/reused 只靠 preflight／explicit
   reuse evidence與 artifact-relative sourceRef 表示。
4. **Semantics registry placement**：建立 versioned code registry 於
   `src/benchmark/cache-semantics.ts`（或同目錄等價模組），key 至少包含
   provider/adapter/package version。未知版本 fail closed 為 unknown。

目前沒有未決事項；本 spec 已由 root 依本機 package source 與真實 Harbor artifact
完成 evidence review，可進入 no-model 實作與 fixture 驗收。
