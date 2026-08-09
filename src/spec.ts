import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { Handoff } from "./handoff.js";

export type SpecStatus = "draft" | "approved" | "ready_for_main" | "needs_clarification";

export interface TaskSpec {
  repo: string;
  status: SpecStatus;
  title: string;
  createdAt: string;
  objective: string;
  backgroundAndDecisions: string;
  /** Optional compatibility boundary; omitted by legacy saved specs. */
  invariantsAndNonGoals?: string[];
  modificationScope: string[];
  excludedScope: string[];
  acceptanceCriteria: string[];
  testRequirements: string[];
  risks: string[];
  unresolvedItems: string[];
}

const sections = {
  objective: "目標",
  backgroundAndDecisions: "背景與決策",
  invariantsAndNonGoals: "Invariants and non-goals",
  modificationScope: "修改範圍",
  excludedScope: "排除範圍",
  acceptanceCriteria: "驗收條件",
  testRequirements: "測試要求",
  risks: "風險",
  unresolvedItems: "未決事項",
} as const;

function yamlString(value: string): string { return JSON.stringify(value); }
function readYamlString(frontmatter: string, key: string): string {
  const line = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!line) throw new Error(`spec frontmatter requires ${key}`);
  const raw = line[1].trim();
  try { return JSON.parse(raw) as string; } catch { return raw.replace(/^['"]|['"]$/g, ""); }
}
function sectionBody(markdown: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(`${marker}\n`);
  if (start < 0) throw new Error(`spec requires ## ${heading}`);
  const bodyStart = start + marker.length + 1;
  const next = markdown.indexOf("\n## ", bodyStart);
  return markdown.slice(bodyStart, next < 0 ? undefined : next).trim();
}
function list(body: string): string[] {
  if (!body || /^(無|none|n\/a)$/i.test(body)) return [];
  return body.split("\n").map((line) => line.match(/^\s*-\s+(.+)$/)?.[1]?.trim().replace(/^`(.+)`$/, "$1")).filter((item): item is string => Boolean(item));
}

export function validateSpec(spec: TaskSpec): TaskSpec {
  if (!spec.repo || !spec.title || !spec.objective) throw new Error("spec requires repo, title, and objective");
  if (!Object.keys(sections).filter((key) => key !== "invariantsAndNonGoals").every((key) => key in spec)) throw new Error("spec is missing required sections");
  return spec;
}

export function parseSpec(markdown: string): TaskSpec {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!frontmatter) throw new Error("spec must start with YAML frontmatter");
  const status = readYamlString(frontmatter[1], "status") as SpecStatus;
  if (!(["draft", "approved", "ready_for_main", "needs_clarification"] as string[]).includes(status)) throw new Error(`unsupported spec status: ${status}`);
  const body = markdown.slice(frontmatter[0].length);
  return validateSpec({
    repo: resolve(readYamlString(frontmatter[1], "repo")), status,
    title: readYamlString(frontmatter[1], "title"), createdAt: readYamlString(frontmatter[1], "created_at"),
    objective: sectionBody(body, sections.objective),
    backgroundAndDecisions: sectionBody(body, sections.backgroundAndDecisions),
    ...(body.includes(`## ${sections.invariantsAndNonGoals}\n`) ? { invariantsAndNonGoals: list(sectionBody(body, sections.invariantsAndNonGoals)) } : {}),
    modificationScope: list(sectionBody(body, sections.modificationScope)),
    excludedScope: list(sectionBody(body, sections.excludedScope)),
    acceptanceCriteria: list(sectionBody(body, sections.acceptanceCriteria)),
    testRequirements: list(sectionBody(body, sections.testRequirements)),
    risks: list(sectionBody(body, sections.risks)),
    unresolvedItems: list(sectionBody(body, sections.unresolvedItems)),
  });
}

export function renderSpec(spec: TaskSpec): string {
  validateSpec(spec);
  const asList = (items: string[]) => items.length ? items.map((item) => `- ${item}`).join("\n") : "無";
  const commands = spec.testRequirements.length ? spec.testRequirements.map((command) => `- \`${command}\``).join("\n") : "無";
  const invariantsAndNonGoals = spec.invariantsAndNonGoals?.length ? asList(spec.invariantsAndNonGoals) : "none";
  return `---\nrepo: ${yamlString(resolve(spec.repo))}\nstatus: ${spec.status}\ntitle: ${yamlString(spec.title)}\ncreated_at: ${yamlString(spec.createdAt)}\n---\n\n# ${spec.title}\n\n## ${sections.objective}\n${spec.objective}\n\n## ${sections.backgroundAndDecisions}\n${spec.backgroundAndDecisions || "無"}\n\n## ${sections.invariantsAndNonGoals}\n${invariantsAndNonGoals}\n\n## ${sections.modificationScope}\n${asList(spec.modificationScope)}\n\n## ${sections.excludedScope}\n${asList(spec.excludedScope)}\n\n## ${sections.acceptanceCriteria}\n${asList(spec.acceptanceCriteria)}\n\n## ${sections.testRequirements}\n${commands}\n\n## ${sections.risks}\n${asList(spec.risks)}\n\n## ${sections.unresolvedItems}\n${asList(spec.unresolvedItems)}\n`;
}

export function assertRunnableSpec(spec: TaskSpec): void {
  if (spec.status !== "approved") throw new Error(`spec must have status: approved (current: ${spec.status})`);
  if (spec.unresolvedItems.length) throw new Error("spec has unresolved items; clarify them before /dev");
}

export function specToHandoff(spec: TaskSpec): Handoff {
  assertRunnableSpec(spec);
  assertExecutableTestCommands(spec.testRequirements);
  return {
    repo: spec.repo,
    objective: spec.objective,
    scope: { include: spec.modificationScope.length ? spec.modificationScope : ["."], exclude: spec.excludedScope },
    ...(spec.invariantsAndNonGoals !== undefined ? { invariantsAndNonGoals: spec.invariantsAndNonGoals } : {}),
    acceptanceCriteria: spec.acceptanceCriteria,
    constraints: [`Spec: ${spec.title}`, ...(spec.excludedScope.length ? [`Do not modify: ${spec.excludedScope.join(", ")}`] : [])],
    tests: spec.testRequirements,
    riskNotes: spec.risks,
    delivery: { mode: "direct_main", requireApproval: true },
  };
}
/** Test requirements are handed directly to a shell runner; prose must never reach it. */
export function assertExecutableTestCommands(commands: string[]): void {
  for (const command of commands) {
    if (!command.trim()) throw new Error("spec test requirement must be a non-empty shell command");
    if (/\p{Script=Han}/u.test(command) || /^(?:please\s+)?(?:run|execute)\s+(?:the\s+)?(?:tests?|build)\b/i.test(command.trim())) {
      throw new Error(`spec test requirement must be a raw executable shell command, not prose: ${command}`);
    }
  }
}

export async function loadSpec(path: string): Promise<TaskSpec> { return parseSpec(await readFile(resolve(path), "utf8")); }
export function withSpecStatus(markdown: string, status: SpecStatus): string {
  if (!markdown.startsWith("---\n")) throw new Error("spec must start with YAML frontmatter");
  if (!/^status:\s*(?:draft|approved|ready_for_main|needs_clarification)\s*$/m.test(markdown)) throw new Error("spec frontmatter requires status");
  return markdown.replace(/^status:\s*(?:draft|approved|ready_for_main|needs_clarification)\s*$/m, `status: ${status}`);
}
export async function updateSpecStatus(path: string, status: SpecStatus): Promise<void> { const resolved = resolve(path); await writeFile(resolved, withSpecStatus(await readFile(resolved, "utf8"), status)); }

/**
 * 把 reviewer 找到的產品語意缺口寫回 spec 的「未決事項」，讓 `needs_spec` 成為回到討論
 * 階段的那條邊，而不是一個死路。下次任一 agent（Claude Code 或 Pi）打開這份 spec，
 * 就直接看到該問使用者什麼，不必去翻 ledger。
 *
 * 既有的未決事項會保留在前；重複寫入同一個缺口不會產生重複項目。
 */
export function withUnresolvedItems(markdown: string, items: readonly string[]): string {
  const spec = parseSpec(markdown);
  const additions = items.map((item) => item.trim()).filter(Boolean).filter((item) => !spec.unresolvedItems.includes(item));
  if (!additions.length) return markdown;
  return renderSpec({ ...spec, unresolvedItems: [...spec.unresolvedItems, ...additions] });
}

/** `needs_spec` 的回寫：狀態設為 needs_clarification，並附上缺口與候選答案。 */
export async function returnSpecToDiscussion(path: string, semantic: string, candidates: readonly string[]): Promise<void> {
  const resolved = resolve(path);
  const withItems = withUnresolvedItems(await readFile(resolved, "utf8"), [semantic, ...candidates.map((candidate) => `候選答案：${candidate}`)]);
  await writeFile(resolved, withSpecStatus(withItems, "needs_clarification"));
}
export function defaultSpecFilename(spec: Pick<TaskSpec, "createdAt" | "title">): string {
  const date = spec.createdAt.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const slug = spec.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-+|-+$/g, "") || basename("task");
  return `${date}-${slug}.md`;
}
