# Spec contract

Spec 是討論 session 與隔離開發流程間的穩定契約，保存在目標 repo 的 `.agent/specs/YYYY-MM-DD-<title>.md`。

## 必要 frontmatter

```yaml
repo: "/Users/skai.wu/side/example"
status: approved
title: "明確標題"
created_at: "ISO-8601 timestamp"
```

`status` 可為 `draft`、`approved`、`ready_for_main` 或 `needs_clarification`。只有 `approved` 能啟動 `/dev`。

## 必要章節

依序包含：目標、背景與決策、修改範圍、排除範圍、驗收條件、測試要求、風險、未決事項。未決事項必須為「無」才能執行。

測試要求每列只能放原始可執行命令，render 時使用 inline code，例如：

```markdown
- `npm test`
- `npm run build`
```

## Lifecycle

```text
draft → approved → ready_for_main
                 ↘ needs_clarification
```

Agent 透過 `save_agent_spec` 寫入或覆寫 spec，並為當前 Pi session 保存 pointer。`/dev` 優先使用該 pointer；若 Pi cwd 本身就是目標 Git repo，也可回退至該 repo 最新的 approved spec。它不會跨 session 使用全域最近 spec。
