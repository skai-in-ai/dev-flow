import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Tier } from "./agents/contracts.js";

export interface Handoff {
  repo: string;
  objective: string;
  scope: { include: string[]; exclude?: string[] };
  acceptanceCriteria: string[];
  constraints: string[];
  tests: string[];
  riskNotes: string[];
  delivery: { mode: "direct_main"; requireApproval: boolean };
}

export interface RepoConfig {
  tests?: string[];
  testsByTier?: Partial<Record<Tier, string[]>>;
  riskPaths?: Record<string, Tier>;
  /** 因失敗而重新實作的次數上限；未設定時採 DEFAULT_MAX_FIX_CYCLES。 */
  maxFixCycles?: number;
  /**
   * 略過「在乾淨 baseline 上先跑一次測試」的預檢。
   *
   * 預設執行。它會多花一次測試時間，換掉整批「環境壞掉卻連燒數個 cycle」的浪費。
   * 只有在測試本身昂貴且環境確定穩定時才值得關掉。
   */
  skipPreflight?: boolean;
}

export async function loadHandoff(path: string): Promise<Handoff> {
  const parsed: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  return validateHandoff(parsed);
}

export function validateHandoff(value: unknown): Handoff {
  if (!value || typeof value !== "object") throw new Error("handoff must be a JSON object");
  const v = value as Record<string, unknown>;
  const strings = (key: string, required = true): string[] => {
    const x = v[key];
    if (x === undefined && !required) return [];
    if (!Array.isArray(x) || !x.every((item) => typeof item === "string")) throw new Error(`handoff.${key} must be string[]`);
    return x as string[];
  };
  if (typeof v.repo !== "string" || !v.repo) throw new Error("handoff.repo must be a non-empty string");
  if (typeof v.objective !== "string" || !v.objective) throw new Error("handoff.objective must be a non-empty string");
  if (!v.scope || typeof v.scope !== "object" || !Array.isArray((v.scope as Record<string, unknown>).include)) throw new Error("handoff.scope.include must be string[]");
  const scope = v.scope as Record<string, unknown>;
  if (!(scope.include as unknown[]).every((x) => typeof x === "string")) throw new Error("handoff.scope.include must be string[]");
  if (scope.exclude !== undefined && (!Array.isArray(scope.exclude) || !(scope.exclude as unknown[]).every((x) => typeof x === "string"))) throw new Error("handoff.scope.exclude must be string[]");
  if (!v.delivery || typeof v.delivery !== "object") throw new Error("handoff.delivery is required");
  const delivery = v.delivery as Record<string, unknown>;
  if (delivery.mode !== "direct_main" || typeof delivery.requireApproval !== "boolean") throw new Error("handoff.delivery must use direct_main and boolean requireApproval");
  return { repo: v.repo, objective: v.objective, scope: { include: scope.include as string[], exclude: (scope.exclude as string[] | undefined) }, acceptanceCriteria: strings("acceptanceCriteria"), constraints: strings("constraints"), tests: strings("tests"), riskNotes: strings("riskNotes"), delivery: { mode: "direct_main", requireApproval: delivery.requireApproval } };
}
