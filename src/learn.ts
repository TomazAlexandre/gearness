/**
 * The learning loop: hooks, pre-commit and MCP checks record every violation they catch (locally,
 * never sent anywhere). `gearness learn` finds what agents keep getting wrong and proposes durable
 * rules, so the harness improves from real behavior instead of guesses.
 */
import fs from "node:fs";
import path from "node:path";
import type { HarnessConfig } from "./config.js";
import { loadHistory } from "./eval.js";
import { addEntry, loadRatchet, type RatchetEntry } from "./ratchet.js";
import type { Diagnostic } from "./rules.js";
import { readFile, writeFile } from "./util.js";

export const TELEMETRY_FILE = ".harness/telemetry/events.jsonl";

export interface HarnessEvent {
  ts: string;
  source: "claude-hook" | "pre-commit" | "mcp";
  rule: string;
  file?: string;
  message: string;
}

export function telemetryEnabled(): boolean {
  return !["0", "false", "off"].includes(String(process.env.GEARNESS_TELEMETRY ?? "").toLowerCase());
}

/** Appends caught violations to the local event log (kept out of git by .harness/.gitignore). */
export function recordEvents(root: string, source: HarnessEvent["source"], diagnostics: Diagnostic[]): void {
  if (!telemetryEnabled() || !diagnostics.length) return;
  try {
    const ignore = path.join(root, ".harness/.gitignore");
    const current = readFile(ignore) ?? "";
    if (!/^telemetry\/$/m.test(current)) writeFile(ignore, `${current}${current && !current.endsWith("\n") ? "\n" : ""}telemetry/\n`);
    const file = path.join(root, TELEMETRY_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(file, diagnostics.map((d) => JSON.stringify({ ts, source, rule: d.rule, file: d.file, message: d.message } satisfies HarnessEvent)).join("\n") + "\n");
  } catch {
    /* telemetry must never break a hook */
  }
}

export function loadEvents(root: string): HarnessEvent[] {
  const text = readFile(path.join(root, TELEMETRY_FILE));
  if (!text) return [];
  return text.split("\n").flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l) as HarnessEvent] : [];
    } catch {
      return [];
    }
  });
}

export interface Lesson {
  key: string;
  /** What agents keep doing. */
  pattern: string;
  /** Rule text proposed for AGENTS.md. */
  rule: string;
  count: number;
  days: number;
  sources: string[];
  lastSeen: string;
  /** Already guarded mechanically; the rule saves the agent the failed attempt. */
  enforced: boolean;
  learned: boolean;
}

const strip = (g: string) => g.replace(/\/\*\*$/, "");

export function findLessons(root: string, opts: { min?: number } = {}): Lesson[] {
  const min = opts.min ?? 2;
  const groups = new Map<string, Omit<Lesson, "count" | "days" | "sources" | "lastSeen" | "learned"> & { hits: { ts: string; source: string }[] }>();
  const add = (key: string, base: { pattern: string; rule: string; enforced: boolean }, ts: string, source: string) => {
    const g = groups.get(key) ?? { key, ...base, hits: [] };
    g.hits.push({ ts, source });
    groups.set(key, g);
  };
  for (const e of loadEvents(root)) {
    if (e.rule === "architecture/boundaries") {
      const m = /\(crosses (.+?) ✗ (.+?)\)(?: - (.+))?$/.exec(e.message);
      if (!m) continue;
      const [, from, deny, why] = m;
      add(`boundary:${from}:${deny}`, { pattern: `imports from ${strip(deny)} inside ${strip(from)}`, rule: `Code under \`${strip(from)}/\` must not import from \`${strip(deny)}/\`${why ? ` - ${why.replace(/\s*\((?:inferred|frozen) by gearness\)$/, "")}` : ""}`, enforced: true }, e.ts, e.source);
    } else if (e.rule === "safety/no-secrets") {
      add("secrets", { pattern: "hardcoded credentials", rule: "Never write credentials, tokens or keys into code or docs; read them from environment variables", enforced: true }, e.ts, e.source);
    } else if (e.rule === "context/broken-links" || e.rule === "context/stale-references") {
      add("doc-paths", { pattern: "docs pointing to paths that do not exist", rule: "When you rename or move files, update every doc that cites them in the same change", enforced: true }, e.ts, e.source);
    }
  }
  for (const run of loadHistory(root, 100).flatMap((h) => h.runs.map((r) => ({ ...r, ts: h.date }))))
    for (const f of run.forbiddenChanged ?? [])
      add(`forbid:${f}`, { pattern: `changes ${f} during unrelated tasks`, rule: `Do not modify \`${f}\` unless the task explicitly asks for it`, enforced: false }, run.ts, "eval");

  const learnedKeys = new Set(loadRatchet(root).entries.flatMap((e: RatchetEntry) => (e.note?.startsWith("learned:") ? [e.note.slice(8)] : [])));
  return [...groups.values()]
    .map((g) => ({
      key: g.key,
      pattern: g.pattern,
      rule: g.rule,
      enforced: g.enforced,
      count: g.hits.length,
      days: new Set(g.hits.map((h) => h.ts.slice(0, 10))).size,
      sources: [...new Set(g.hits.map((h) => h.source))].sort(),
      lastSeen: g.hits.map((h) => h.ts).sort().at(-1) ?? "",
      learned: learnedKeys.has(g.key),
    }))
    .filter((l) => l.count >= min)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** Records the not-yet-learned lessons as ratchet entries with learned rules in the entry file. */
export function applyLessons(root: string, config: HarnessConfig, lessons: Lesson[]): RatchetEntry[] {
  return lessons
    .filter((l) => !l.learned)
    .map((l) => addEntry(root, config.context.entry, { failure: `Agents repeatedly ${l.pattern} (${l.count}× over ${l.days} day${l.days === 1 ? "" : "s"})`, fix: "doc", rule: l.rule, note: `learned:${l.key}` }));
}
