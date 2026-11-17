import path from "node:path";
import { CONFIG_FILE, type HarnessConfig, loadConfig } from "./config.js";
import { loadExtraRules } from "./plugins.js";
import { type Diagnostic, type Pillar, type Rule, runRules } from "./rules.js";
import { expandDirGlobs, exists } from "./util.js";

/** Share of a rule's weight kept when its worst finding has this severity. */
const CREDIT = { none: 1, info: 0.6, warn: 0.3, error: 0 } as const;

export interface RuleResult {
  rule: Rule;
  diagnostics: Diagnostic[];
  earned: number;
}

/**
 * Highest score a project can reach while its entry file is missing. Rules that examine the entry file's content
 * (placeholders, links, size, secrets, adapters...) have nothing to flag when there is no file, and "nothing to flag"
 * used to earn full marks: a project with only a harness.yaml scored 82 (grade B). Without the entry file there is
 * no harness, so the score cannot leave the F band, however many rules pass vacuously.
 */
export const NO_ENTRY_CAP = 39;

export interface ScoreCap {
  max: number;
  reason: string;
  /** What the score would have been without the cap, so the cap is never a hidden adjustment. */
  uncapped: number;
}

export interface Report {
  score: number;
  grade: string;
  /** Present when the score was limited (see NO_ENTRY_CAP). */
  cap?: ScoreCap;
  pillars: Partial<Record<Pillar, { earned: number; total: number }>>;
  results: RuleResult[];
  diagnostics: Diagnostic[];
  errors: number;
  warnings: number;
}

const worst = (ds: Diagnostic[]): keyof typeof CREDIT =>
  ds.some((d) => d.severity === "error") ? "error" : ds.some((d) => d.severity === "warn") ? "warn" : ds.length ? "info" : "none";

export const gradeOf = (s: number) => (s >= 90 ? "A" : s >= 75 ? "B" : s >= 60 ? "C" : s >= 40 ? "D" : "F");

export function evaluate(cwd: string, config: HarnessConfig, now = new Date(), extra: Rule[] = []): Report {
  const results = runRules(cwd, config, now, extra).map(({ rule, diagnostics, credit }) => ({
    rule,
    diagnostics,
    earned: rule.weight * (credit ?? CREDIT[worst(diagnostics)]),
  }));
  const pillars: Report["pillars"] = {};
  let earned = 0;
  let total = 0;
  for (const r of results) {
    const p = (pillars[r.rule.pillar] ??= { earned: 0, total: 0 });
    p.earned += r.earned;
    p.total += r.rule.weight;
    earned += r.earned;
    total += r.rule.weight;
  }
  const raw = total ? Math.round((earned / total) * 100) : 0;
  const entry = results.find((r) => r.rule.id === "context/entry-exists");
  const cap: ScoreCap | undefined = entry && entry.earned === 0 && raw > NO_ENTRY_CAP ? { max: NO_ENTRY_CAP, reason: `entry file ${config.context.entry} not found`, uncapped: raw } : undefined;
  const score = cap ? cap.max : raw;
  const diagnostics = results.flatMap((r) => r.diagnostics);
  return {
    score,
    grade: gradeOf(score),
    ...(cap ? { cap } : {}),
    pillars,
    results,
    diagnostics,
    errors: diagnostics.filter((d) => d.severity === "error").length,
    warnings: diagnostics.filter((d) => d.severity === "warn").length,
  };
}

export interface WorkspaceReport {
  /** Repository-relative directory ("." for the root). */
  dir: string;
  config?: HarnessConfig;
  report?: Report;
  configErrors: string[];
}

/** Evaluates the root harness plus every workspace that has its own harness.yaml, loading custom rules for each. */
export async function evaluateTree(cwd: string, root: HarnessConfig, now = new Date()): Promise<WorkspaceReport[]> {
  const out: WorkspaceReport[] = [{ dir: ".", config: root, report: evaluate(cwd, root, now, await loadExtraRules(cwd, root)), configErrors: [] }];
  for (const dir of expandDirGlobs(cwd, root.workspaces)) {
    const abs = path.join(cwd, dir);
    if (!exists(path.join(abs, CONFIG_FILE))) continue; // reported by context/workspaces at the root
    const { config, errors } = loadConfig(abs);
    if (!config) {
      out.push({ dir, configErrors: errors });
      continue;
    }
    out.push({ dir, config, report: evaluate(abs, config, now, await loadExtraRules(abs, config)), configErrors: [] });
  }
  return out;
}
