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

export interface RepoConfig { tests?: string[]; testsByTier?: Partial<Record<Tier, string[]>>; riskPaths?: Record<string, Tier>; }

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
