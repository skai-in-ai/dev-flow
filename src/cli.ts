import { loadHandoff } from "./handoff.js";
import { loadSpec, returnSpecToDiscussion, specToHandoff, updateSpecStatus } from "./spec.js";
import { SpecNotReady, resolveTarget } from "./dev-flow.js";
import { readFile } from "node:fs/promises";
import { DEFAULT_MAX_TIER } from "./models.js";
import type { Tier } from "./agents/contracts.js";
import { createCoreRunner } from "./cli-core.js";

const handoffIndex = process.argv.indexOf("--handoff");
const specIndex = process.argv.indexOf("--spec");
const maxTierIndex = process.argv.indexOf("--max-tier");
const maxTierValue = maxTierIndex >= 0 ? process.argv[maxTierIndex + 1] : undefined;
const maxTier = maxTierValue === "0" || maxTierValue === "1" || maxTierValue === "2" ? Number(maxTierValue) as Tier : DEFAULT_MAX_TIER;
const maxCyclesIndex = process.argv.indexOf("--max-cycles");
const maxCyclesValue = maxCyclesIndex >= 0 ? process.argv[maxCyclesIndex + 1] : undefined;
const maxCycles = maxCyclesValue !== undefined && /^\d+$/.test(maxCyclesValue) ? Number(maxCyclesValue) : undefined;
// dev-flow 模式：不給任何旗標時，跑目前 repo 最新一份已定案的 spec。
const devFlow = handoffIndex < 0 && specIndex < 0;
const optionValueIndexes = new Set([handoffIndex + 1, specIndex + 1, maxTierIndex + 1, maxCyclesIndex + 1].filter((index) => index > 1));
const positional = process.argv.slice(2).filter((argument, index) => !argument.startsWith("--") && !optionValueIndexes.has(index + 2));
if (maxTierIndex >= 0 && maxTierValue !== "0" && maxTierValue !== "1" && maxTierValue !== "2") { console.error("--max-tier 必須是 0、1 或 2"); process.exitCode = 2; }
else if (maxCyclesIndex >= 0 && (maxCycles === undefined || maxCycles < 1)) { console.error("--max-cycles 必須是正整數"); process.exitCode = 2; }
else if (!devFlow && (handoffIndex < 0 || !process.argv[handoffIndex + 1]) && (specIndex < 0 || !process.argv[specIndex + 1])) { console.error("Usage: dev-flow [--max-tier 0|1|2] [--max-cycles N] [path/to/spec.md] OR npm run orchestrate -- --handoff path/to/handoff.json [--max-tier 0|1|2] [--max-cycles N] OR --spec path/to/spec.md [--max-tier 0|1|2] [--max-cycles N]"); process.exitCode = 2; }
else {
  let specPath = specIndex >= 0 ? process.argv[specIndex + 1] : undefined;
  if (devFlow) {
    try {
      const target = await resolveTarget(process.cwd(), positional[0]);
      specPath = target.path;
      console.log(`dev-flow · ${target.spec.title}\n  ${target.path}`);
    } catch (error) {
      // 資訊不齊全就停在討論階段，不進實作。這是隨手分派能安全存在的前提。
      console.error(error instanceof SpecNotReady ? error.render() : error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
  if (process.exitCode === 2) { /* dev-flow gating 已阻擋，不啟動流程 */ } else {
  const handoff = handoffIndex >= 0 ? await loadHandoff(process.argv[handoffIndex + 1]) : specToHandoff(await loadSpec(specPath!));
  const spec = specPath ? await readFile(specPath, "utf8") : undefined;
  const result = await createCoreRunner(maxCycles === undefined ? undefined : { maxCycles }).run(handoff, {
    specPath, specTitle: specPath ? await loadSpec(specPath).then((parsed) => parsed.title) : undefined, specMarkdown: spec,
    maxTier,
  }, console.log);
  if (specPath && result.status === "ready_for_main") await updateSpecStatus(specPath, "ready_for_main");
  if (specPath && result.status === "needs_human") {
    if (result.specGap) await returnSpecToDiscussion(specPath, result.specGap.semantic, result.specGap.candidates);
    else await updateSpecStatus(specPath, "needs_clarification");
  }
  console.log(`\n${result.status.toUpperCase()} · Tier ${result.tier} · ${result.cycles}/${result.maxCycles} cycles · US$${result.cost.total.toFixed(5)} · run ${result.runId}`);
  if (result.specGap) console.log(`\n缺的語意：${result.specGap.semantic}\n候選答案：\n${result.specGap.candidates.map((candidate, index) => `  ${String.fromCharCode(65 + index)}. ${candidate}`).join("\n")}`);
  process.exitCode = result.status === "failed" ? 1 : 0;
  }
}

export { parseClassifierResult } from "./cli-core.js";
