import path from "node:path";
import YAML from "yaml";
import { LEARNED_END, LEARNED_START, RATCHET_FILE, ratchetYaml } from "./templates.js";
import { exists, readFile, writeFile } from "./util.js";

export const FIX_KINDS = ["lint", "test", "type", "hook", "ci", "doc"] as const;
export type FixKind = (typeof FIX_KINDS)[number];

export interface RatchetEntry {
  id: string;
  date: string;
  /** What the agent did wrong, in one sentence. */
  failure: string;
  /** Which mechanism now prevents it. Mechanical fixes (lint/test/type/hook/ci) beat docs. */
  fix: FixKind;
  /** File that encodes the fix. */
  artifact: string;
  /** For doc fixes: the rule text added to the entry file. */
  rule?: string;
  note?: string;
}

export interface RatchetLog {
  entries: RatchetEntry[];
  error?: string;
}

export function loadRatchet(cwd: string): RatchetLog {
  const text = readFile(path.join(cwd, RATCHET_FILE));
  if (text === null) return { entries: [] };
  try {
    const data = YAML.parse(text) as { entries?: RatchetEntry[] } | null;
    const entries = data?.entries ?? [];
    if (!Array.isArray(entries)) return { entries: [], error: "`entries` must be a list" };
    return { entries };
  } catch (e) {
    return { entries: [], error: `invalid YAML: ${(e as Error).message.split("\n")[0]}` };
  }
}

function saveRatchet(cwd: string, entries: RatchetEntry[]): void {
  const file = path.join(cwd, RATCHET_FILE);
  const existing = readFile(file) ?? ratchetYaml();
  const headerLines = existing.split("\n").filter((l) => l.startsWith("#"));
  const body = YAML.stringify({ entries: entries.map((e) => JSON.parse(JSON.stringify(e))) }, { lineWidth: 0 });
  writeFile(file, [...headerLines, body].join("\n"));
}

export function nextId(entries: RatchetEntry[]): string {
  const max = entries.reduce((m, e) => Math.max(m, Number(/^R-(\d+)$/.exec(e.id)?.[1] ?? 0)), 0);
  return `R-${String(max + 1).padStart(3, "0")}`;
}

/** Inserts a learned rule into the entry file between the gearness markers (creating them if absent). */
export function appendLearnedRule(cwd: string, entryRel: string, id: string, rule: string): void {
  const file = path.join(cwd, entryRel);
  let md = readFile(file) ?? "";
  const bullet = `- ${rule.trim().replace(/\.?$/, ".")} _(${id})_`;
  if (!md.includes(LEARNED_START) || !md.includes(LEARNED_END)) {
    md = `${md.trimEnd()}\n\n## Learned rules\nAdded after real agent failures (history in \`.harness/ratchet.yaml\`).\n\n${LEARNED_START}\n${LEARNED_END}\n`;
  }
  md = md.replace(LEARNED_END, `${bullet}\n${LEARNED_END}`);
  writeFile(file, md);
}

export interface AddInput {
  failure: string;
  fix: FixKind;
  artifact?: string;
  rule?: string;
  note?: string;
  date?: string;
}

export function addEntry(cwd: string, entryRel: string, input: AddInput): RatchetEntry {
  const log = loadRatchet(cwd);
  if (log.error) throw new Error(`${RATCHET_FILE}: ${log.error}`);
  const id = nextId(log.entries);
  if (input.fix === "doc") {
    if (!input.rule) throw new Error("doc fixes need --rule \"<the rule agents must follow>\"");
    appendLearnedRule(cwd, entryRel, id, input.rule);
  } else if (!input.artifact) {
    throw new Error(`${input.fix} fixes need --artifact <file that enforces it>`);
  } else if (!exists(path.join(cwd, input.artifact))) {
    throw new Error(`artifact ${input.artifact} does not exist - build the guardrail first, then record it`);
  }
  const entry: RatchetEntry = {
    id,
    date: input.date ?? new Date().toISOString().slice(0, 10),
    failure: input.failure.trim(),
    fix: input.fix,
    artifact: input.fix === "doc" ? entryRel : input.artifact!,
    ...(input.rule ? { rule: input.rule.trim() } : {}),
    ...(input.note ? { note: input.note.trim() } : {}),
  };
  saveRatchet(cwd, [...log.entries, entry]);
  return entry;
}
