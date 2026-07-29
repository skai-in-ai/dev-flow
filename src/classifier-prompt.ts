import type { Handoff } from "./handoff.js";

export function renderClassifierPrompt(handoff: Handoff, diff?: string): string {
  return `Classify only the technical and change risk. Return JSON: {"tier":0|1|2,"confidence":0..1,"reasons":[string],"riskFlags":[string]}. Do not treat a missing initial diff, unfinished acceptance criteria, or the fact that implementation has not begun as risk. Assess only the requested scope, explicit risk notes, and any actual diff supplied. Handoff: ${JSON.stringify(handoff)}\nActual diff: ${diff ?? ""}`;
}
