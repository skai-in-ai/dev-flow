/**
 * Ledger 保留政策：決定一次 agent 執行有多少東西值得留在磁碟上。
 *
 * Pi 的 stdout 是串流事件，而 `message_update` 帶的是**累積快照而非 delta**：一則長度 N 的
 * 訊息會被寫下 N 次「從頭到目前」的完整 message 物件，因此紀錄量隨訊息長度呈平方成長。
 * 實測一次 Tier 1 的四輪 run，單一 implementer 的 events.jsonl 就有 315 MB，其中 297.7 MB
 * 是 22,726 筆 `message_update`；同一批資訊在 184 筆 `message_end` 裡只佔 0.9 MB。
 *
 * 保留判準是「未來要分析什麼」：跑了幾次、過了沒、中間發生什麼事（幾個 turn、叫了哪些工具、
 * 花了多少 token、為什麼停）。這些都在事件的**結構欄位**裡，不在內容裡。因此這裡保留骨架、
 * 丟掉內容：模型講了什麼、讀到的檔案內容、工具回傳的整包結果，一律不留。
 *
 * 需要完整內容時看 run 根目錄：`decisions.json` 有逐輪 findings 與 implementer 回應，
 * `cycle-<n>.diff` 有實際變更，`cycle-<n>-tests.json` 有測試輸出。那些才是分析的素材。
 */

/** 純進度事件：資訊全部涵蓋在對應的 `*_end` 事件裡，留著只是重複。 */
const DROPPED_EVENT_TYPES = new Set(["message_update", "tool_execution_update"]);

/** 內容欄位。留骨架不留內容，就是把這些拿掉。 */
const CONTENT_KEYS = new Set(["content", "result", "toolResults", "thinking", "thinkingSignature", "text"]);

const MAX_RETAINED_STRING = 200;

function compactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > MAX_RETAINED_STRING ? `${value.slice(0, MAX_RETAINED_STRING)}…(truncated)` : value;
  if (Array.isArray(value)) return depth > 6 ? [] : value.map((item) => compactValue(item, depth + 1));
  if (value && typeof value === "object") {
    if (depth > 6) return {};
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // toolResults 整包丟掉太可惜：叫了哪些工具、有沒有失敗，是「中間發生什麼事」的核心。
      // 留名字與成敗，丟回傳內容。
      if (key === "toolResults" && Array.isArray(item)) {
        output[key] = item.map((entry) => {
          const record = (entry ?? {}) as Record<string, unknown>;
          return { toolName: record.toolName, isError: record.isError };
        });
        continue;
      }
      if (CONTENT_KEYS.has(key)) continue;
      output[key] = compactValue(item, depth + 1);
    }
    return output;
  }
  return value;
}

/**
 * 把 Pi 的原始 stdout 壓成可長期保存的 trace。
 *
 * 無法解析的行原樣保留（截斷過長字串）：看不懂的東西丟掉，就是把診斷未知故障的唯一線索丟掉。
 */
export function compactPiEventLine(line: string): string | undefined {
  if (!line.trim()) return undefined;
  let event: unknown;
  try { event = JSON.parse(line); } catch {
    return JSON.stringify({ type: "unparsed", raw: compactValue(line) });
  }
  const type = event && typeof event === "object" ? (event as { type?: unknown }).type : undefined;
  if (typeof type === "string" && DROPPED_EVENT_TYPES.has(type)) return undefined;
  return JSON.stringify(compactValue(event));
}

export function compactPiEvents(stdout: string): string {
  const lines: string[] = [];
  for (const line of stdout.split("\n")) {
    const compacted = compactPiEventLine(line);
    if (compacted !== undefined) lines.push(compacted);
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Pi 自己寫在 session 目錄裡的對話紀錄；內容與 trace 重疊，且每個角色約 1 MB。 */
export function isPiSessionLog(fileName: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T[\d-]+Z_[0-9a-f-]{36}\.jsonl$/i.test(fileName);
}
