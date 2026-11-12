import fs from "node:fs";
import path from "node:path";
import { sync } from "./adapters.js";
import { CONFIG_FILE, type HarnessConfig, loadConfig } from "./config.js";
import { checkBoundaries } from "./imports.js";
import { contextFiles, type Diagnostic, RULES, runRules, SECRET_PATTERNS } from "./rules.js";
import { lineOf, posix, readFile } from "./util.js";

/** Context rules that can be judged per file, cheaply, while an agent is working. */
const CONTEXT_RULES = new Set(["context/broken-links", "context/stale-references", "context/entry-size", "safety/no-secrets"]);

export interface CheckResult {
  /** Harness root (absolute) the files were checked against. */
  root: string;
  diagnostics: Diagnostic[];
  /** Adapter files regenerated because the entry file changed. */
  synced: string[];
}

/** Finds the nearest directory at or above `fileAbs` (and not above `stopAt`) that has a harness.yaml. */
export function nearestHarness(fileAbs: string, stopAt: string): string | null {
  let dir = path.dirname(fileAbs);
  const stop = path.resolve(stopAt);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    if (dir === stop || path.dirname(dir) === dir || !dir.startsWith(stop)) return null;
    dir = path.dirname(dir);
  }
}

/**
 * Fast checks for a set of changed files - meant for agent hooks and pre-commit:
 * architecture boundaries, secrets, and per-file context rules. Files are grouped by their
 * nearest harness (so monorepo workspaces use their own boundaries).
 */
export function checkFiles(repoRoot: string, files: string[], opts: { autoSync?: boolean } = {}): CheckResult[] {
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const abs = path.resolve(repoRoot, f);
    if (!fs.existsSync(abs)) continue;
    const root = nearestHarness(abs, repoRoot);
    if (!root) continue;
    groups.set(root, [...(groups.get(root) ?? []), posix(path.relative(root, abs))]);
  }
  const results: CheckResult[] = [];
  for (const [root, rels] of groups) {
    const { config } = loadConfig(root);
    if (!config) continue;
    results.push(checkGroup(root, config, rels, opts));
  }
  // A workspace entry file also feeds the root's Copilot path instructions: keep those in sync too.
  if (opts.autoSync && results.some((r) => r.root !== path.resolve(repoRoot) && r.synced.length + 1 > 0)) {
    const { config: rootConfig } = loadConfig(repoRoot);
    if (rootConfig?.workspaces.length)
      for (const r of sync(repoRoot, rootConfig)) if (r.action === "written" && r.file) results[0]?.synced.push(path.relative(results[0].root, path.join(repoRoot, r.file)));
  }
  return results;
}

function checkGroup(root: string, config: HarnessConfig, rels: string[], opts: { autoSync?: boolean }): CheckResult {
  const diagnostics: Diagnostic[] = [];
  for (const v of checkBoundaries(root, config.boundaries, rels).violations)
    diagnostics.push({
      rule: "architecture/boundaries",
      severity: "error",
      file: v.file,
      line: v.line,
      message: `imports ${v.spec} (crosses ${v.boundary.from} ✗ ${v.denied})${v.boundary.message ? ` - ${v.boundary.message}` : ""}`,
      hint: "go through the allowed layer instead of importing across the boundary",
    });

  const ctxFiles = new Set(contextFiles(config));
  for (const rel of rels) {
    if (ctxFiles.has(rel)) continue; // covered by the context rules below
    const text = readFile(path.join(root, rel));
    if (text === null || text.length > 2_000_000) continue;
    for (const [label, re] of SECRET_PATTERNS) {
      const m = re.exec(text);
      if (m) diagnostics.push({ rule: "safety/no-secrets", severity: "error", file: rel, line: lineOf(text, m.index), message: `possible ${label}`, hint: "remove it and load it from the environment or a secret manager" });
    }
  }

  const touchedContext = rels.filter((r) => ctxFiles.has(r));
  const synced: string[] = [];
  if (touchedContext.length) {
    if (opts.autoSync && touchedContext.includes(config.context.entry))
      for (const r of sync(root, config)) if (r.action === "written" && r.file) synced.push(r.file);
    // Run only the cheap per-file rules; repository-wide rules belong to `lint`.
    const disable = RULES.filter((r) => !CONTEXT_RULES.has(r.id)).map((r) => r.id);
    for (const run of runRules(root, { ...config, rules: { disable } }))
        diagnostics.push(...run.diagnostics.filter((d) => d.severity !== "info" && d.file && touchedContext.includes(d.file)));
  }
  return { root, diagnostics: diagnostics.filter((d) => !config.rules.disable.includes(d.rule)), synced };
}

/** Extracts the edited file from a Claude Code PostToolUse hook payload. */
export function fileFromClaudeHook(payload: unknown): string | null {
  const p = payload as { tool_input?: { file_path?: unknown; notebook_path?: unknown } };
  const f = p?.tool_input?.file_path ?? p?.tool_input?.notebook_path;
  return typeof f === "string" ? f : null;
}

/** Formats findings as feedback the agent can act on. */
export function hookFeedback(results: CheckResult[], repoRoot: string): string {
  const lines: string[] = [];
  for (const r of results)
    for (const d of r.diagnostics) {
      const file = posix(path.relative(repoRoot, path.join(r.root, d.file ?? CONFIG_FILE)));
      lines.push(`- ${file}${d.line ? `:${d.line}` : ""} ${d.message} [${d.rule}]${d.hint ? `\n  fix: ${d.hint}` : ""}`);
    }
  return [
    "gearness: this change breaks the repository's harness rules.",
    ...lines,
    "Fix these before continuing. The rules come from harness.yaml and AGENTS.md; do not work around them.",
  ].join("\n");
}
