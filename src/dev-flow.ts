/**
 * `dev-flow` 的解析與 gating。
 *
 * 目的是把「臨時想到一件事就丟出去」的儀式降到最低：不必手寫 handoff JSON，
 * 不必記絕對路徑，打一個字就跑最新那份已定案的 spec。
 *
 * 但**資訊不齊全時一律不啟動**。這不是保守，而是這個入口能安全存在的前提：
 * 隨手分派會讓 spec 模糊的機率最高，而模糊的 spec 丟進實作階段，最好的結果是
 * reviewer 回 needs_spec（花掉一次 review 的錢才問到問題），最壞是 agent 自行
 * 猜測產品語意。既有的 `assertRunnableSpec` 已經定義了「可執行」的標準
 * （status 為 approved 且沒有未決事項），這裡沿用它，不另外發明一套判準。
 */

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { assertRunnableSpec, loadSpec, type TaskSpec } from "./spec.js";

export const SPEC_DIR = ".agent/specs";

export interface DevFlowTarget {
  readonly path: string;
  readonly spec: TaskSpec;
}

/** 待答問題：spec 還在討論階段，dev-flow 不該啟動，應由使用者回答後再分派。 */
export class SpecNotReady extends Error {
  constructor(readonly path: string, readonly spec: TaskSpec, readonly reason: string) {
    super(reason);
    this.name = "SpecNotReady";
  }
  /** 給終端輸出用：說明卡在哪、要回答什麼。 */
  render(): string {
    const questions = this.spec.unresolvedItems.length
      ? `\n\n待回答：\n${this.spec.unresolvedItems.map((item) => `  - ${item}`).join("\n")}`
      : "";
    return `這份 spec 還不能執行：${this.reason}\n  ${this.path}\n  狀態：${this.spec.status}${questions}\n\n回到討論階段把上述問題定案，並把 status 改為 approved，再執行 dev-flow。`;
  }
}

export async function listSpecs(repo: string): Promise<string[]> {
  const dir = join(resolve(repo), SPEC_DIR);
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.filter((entry) => entry.endsWith(".md")).sort().map((entry) => join(dir, entry));
}

/**
 * 未指定路徑時挑選目標：取最新一份（檔名以日期開頭，字典序即時間序）。
 *
 * 刻意不「自動略過未定案的 spec 去找更舊的可執行 spec」：那會讓 dev-flow 在
 * 使用者以為要跑新任務時，安靜地跑了一件舊的。寧可報錯說最新這份還沒定案。
 */
export async function resolveTarget(repo: string, explicitPath?: string): Promise<DevFlowTarget> {
  const path = explicitPath ? resolve(explicitPath) : (await listSpecs(repo)).at(-1);
  if (!path) throw new Error(`找不到任何 spec：${join(resolve(repo), SPEC_DIR)}\n先在討論階段產生一份 spec，再執行 dev-flow。`);

  const spec = await loadSpec(path);
  try {
    assertRunnableSpec(spec);
  } catch (error) {
    throw new SpecNotReady(path, spec, error instanceof Error ? error.message : String(error));
  }
  return { path, spec };
}
