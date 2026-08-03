import type { Tier } from "./agents/contracts.js";
import type { Handoff, RepoConfig } from "./handoff.js";

export interface RoutingResult { tier: Tier; confidence: number; reasons: string[]; riskFlags: string[]; }
/**
 * `sessionDir` 由 orchestrator 指定，讓 classifier 的 session 落在該次 run 底下。
 * 先前 CLI 自行組 `.orchestrator/router-<epoch>`，session 散在 run 之外，事後無法
 * 對應回是哪一次 run，成本也歸不了帳。
 */
export interface ClassifierInput { handoff: Handoff; diff?: string; sessionDir: string }
/** `costUsd` 讓 router 的花費能併入該次 run 的成本統計。 */
export interface ClassifierResult extends Partial<RoutingResult> { costUsd?: number }
export interface ModelClassifier { classify(input: ClassifierInput): Promise<ClassifierResult>; }

const T2 = /migration|schema|database|auth(?:entication|orization)?|secret|token|credential|payment|concurren|queue|lock|transaction|docker|ci\/?cd|deploy|production|breaking change/i;
const T1 = /\.([cm]?[jt]sx?|py|go|rs|java|rb|php|cs|swift|kt)$/i;
const T0 = /\.(md|txt|rst)$/i;

export function deterministicRoute(handoff: Handoff, config: RepoConfig = {}, actualDiff = ""): RoutingResult {
  const text = [handoff.objective, ...handoff.scope.include, ...handoff.riskNotes, actualDiff].join("\n");
  const flags: string[] = [];
  let tier: Tier = 0;
  if (T2.test(text)) { tier = 2; flags.push("high-risk keyword or path detected"); }
  else if (handoff.scope.include.some((path) => T1.test(path)) || !handoff.scope.include.every((path) => T0.test(path))) { tier = 1; flags.push("runtime code or non-mechanical scope detected"); }
  for (const [needle, configuredTier] of Object.entries(config.riskPaths ?? {})) {
    if (text.includes(needle) && configuredTier > tier) { tier = configuredTier; flags.push(`repo risk path: ${needle}`); }
  }
  return { tier, confidence: flags.length ? 0.92 : 0.75, reasons: flags.length ? flags : ["documentation-only scope"], riskFlags: flags };
}

export async function hybridRoute(handoff: Handoff, config: RepoConfig = {}, classifier?: ModelClassifier, diff = "", sessionDir = ""): Promise<RoutingResult & { costUsd?: number }> {
  const floor = deterministicRoute(handoff, config, diff);
  if (!classifier) return floor;
  const model = await classifier.classify({ handoff, diff, sessionDir });
  const candidate = model.tier === 0 || model.tier === 1 || model.tier === 2 ? model.tier : floor.tier;
  return { tier: Math.max(floor.tier, candidate) as Tier, confidence: Math.max(floor.confidence, model.confidence ?? 0), reasons: [...floor.reasons, ...(model.reasons ?? [])], riskFlags: [...floor.riskFlags, ...(model.riskFlags ?? [])], costUsd: model.costUsd };
}
