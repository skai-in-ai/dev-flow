/**
 * 跨輪次累積的 finding 歷史。
 *
 * 存在的理由：reviewer 每輪都是全新的 isolated session，若不把前幾輪的 finding
 * 與 implementer 的回應交給它，它會重新推導出同一個疑慮，而且看不到上一輪
 * final reviewer 已經對同一個 trade-off 做過的裁決，於是兩個都對的 reviewer
 * 會被呈現成互相矛盾的 fail。
 *
 * 這裡刻意「只呈現歷史，不做裁決」：沒有任何把 finding 標記為「已推翻」的機制。
 * 兩位 reviewer 對同一故障的不同面向都可能是對的，硬性推翻會丟資訊。
 */

export type FindingSource = "tests" | "reviewer" | "final_reviewer";

export interface FindingRecord {
  readonly round: number;
  readonly source: FindingSource;
  /** 產生此 finding 的模型；deterministic tests 記為 "deterministic"。 */
  readonly model: string;
  readonly text: string;
}

/**
 * implementer 對某一輪 findings 的回應。
 *
 * 以「每輪一筆」而非「每個 finding 一筆」記錄，因為 implementer 交回的是一段
 * 自由格式的敘述，無法可靠地機械切分並歸屬到個別 finding。硬拆會製造假精確。
 */
export interface ResponseRecord {
  /** 被回應的是哪一輪的 findings。 */
  readonly round: number;
  readonly model: string;
  readonly text: string;
}

export interface DecisionLog {
  readonly findings: readonly FindingRecord[];
  readonly responses: readonly ResponseRecord[];
}

export const EMPTY_DECISION_LOG: DecisionLog = { findings: [], responses: [] };

/** 累積而非覆寫；回傳新的 log，不修改輸入。 */
export function appendFindings(log: DecisionLog, records: readonly FindingRecord[]): DecisionLog {
  return { ...log, findings: [...log.findings, ...records] };
}

export function appendResponse(log: DecisionLog, record: ResponseRecord): DecisionLog {
  return { ...log, responses: [...log.responses, record] };
}

const NO_HISTORY = "NO PRIOR ROUNDS. This is the first implementation attempt.";

/** 供 prompt artifact 使用的人類可讀格式。 */
export function formatDecisionLog(log: DecisionLog): string {
  if (log.findings.length === 0 && log.responses.length === 0) return NO_HISTORY;

  const rounds = [...new Set([...log.findings, ...log.responses].map((entry) => entry.round))].sort((a, b) => a - b);
  return rounds
    .map((round) => {
      const findings = log.findings.filter((finding) => finding.round === round);
      const responses = log.responses.filter((response) => response.round === round);
      const blocks = [`## Round ${round}`];
      if (findings.length) {
        blocks.push(findings.map((finding, index) => `${index + 1}. [${finding.source} · ${finding.model}] ${finding.text}`).join("\n"));
      }
      for (const response of responses) {
        blocks.push(`IMPLEMENTER RESPONSE (${response.model}):\n${response.text}`);
      }
      return blocks.join("\n");
    })
    .join("\n\n");
}
