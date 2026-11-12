#!/usr/bin/env node
import path from "node:path";
import { adapterStatus, sync } from "./adapters.js";
import { AGENTS, type AgentId, CONFIG_FILE, type HarnessConfig, loadConfig, STACKS, type Stack } from "./config.js";
import { checkFiles, fileFromClaudeHook, hookFeedback } from "./check.js";
import { AGENT_PRESETS, loadHistory, loadTasks, newTask, RESULTS_DIR, runEval, trend } from "./eval.js";
import { type Comparison, compareWithBase } from "./compare.js";
import { applyFixes } from "./fix.js";
import { buildGraph, suggestBoundaries, toDot, toMermaid, violationEdges } from "./graph.js";
import YAML from "yaml";
import { xray } from "./xray.js";
import { applyLessons, findLessons, recordEvents, TELEMETRY_FILE } from "./learn.js";
import { toGithubAnnotations, toSarif } from "./formats.js";
import { install, INTEGRATIONS, type Integration } from "./install.js";
import { serve } from "./mcp.js";
import { init } from "./init.js";
import { REPO_URL, TOOL, VERSION } from "./meta.js";
import { loadExtraRules } from "./plugins.js";
import { addEntry, FIX_KINDS, type FixKind, loadRatchet } from "./ratchet.js";
import { type Diagnostic, PILLARS, RULES } from "./rules.js";
import { evaluateTree, type Report, type WorkspaceReport } from "./score.js";
import { color as c, GIT_MISSING, hasGit, posix } from "./util.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  const BOOL = new Set(["strict", "apply", "include-tests", "write", "no-regress", "json", "fix", "ci", "force", "check", "dry-run", "markdown", "keep", "workspaces", "help", "version", "staged", "uninstall"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2);
      if (k.startsWith("no-")) flags[k.slice(3)] = false;
      else if (v !== undefined) flags[k] = v;
      else if (!BOOL.has(k) && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (a === "-h") flags.help = true;
    else if (a === "-v") flags.version = true;
    else positional.push(a);
  }
  return { positional, flags };
}

const str = (f: Flags, k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);

const HELP = `${c.bold(TOOL)} ${VERSION} - harness engineering as code

${c.bold("Usage")}
  ${TOOL} <command> [options]

${c.bold("Commands")}
  init              Scaffold harness.yaml, AGENTS.md, docs, ratchet log, CI gate and agent adapters
  lint              Check the harness for problems (exit 1 on errors)
  doctor            Score the harness 0–100 by pillar and list the highest-impact fixes
  sync              Regenerate agent files (CLAUDE.md, Cursor, Copilot, …) from AGENTS.md
  ratchet add|list  Turn agent failures into durable guardrails / show the log
  check [files…]    Fast check of changed files (boundaries, secrets, docs) for hooks
  install           Wire gearness into the agent loop: Claude Code hook, git pre-commit, MCP server
  mcp               Run the MCP server (stdio) so agents can query the harness
  boundaries suggest  Infer the layering your code already follows and lock it in (--write; --strict freezes the graph)
  learn             Turn mistakes agents repeat (from hooks and evals) into learned rules (--apply)
  context [path]    Context X-ray: what each agent loads for a path, with token cost and duplicates
  graph             Module dependency graph (Mermaid/DOT/JSON) with violations and cycles highlighted
  eval              Run eval tasks against an agent and measure the pass rate
  eval new <id>     Scaffold an eval task   eval list   List tasks   eval report   Pass-rate trend
  badge             Print a README badge with the current score
  rules             List all rules (built-in and custom)    explain <rule>   Explain a rule

${c.bold("Global")}  --cwd <dir>   --json   -h/--help   -v/--version

${c.bold("init")}     --name --description --stack <${STACKS.join("|")}>
           --agents <${AGENTS.join(",")}> --workspaces --no-ci --force --dry-run
${c.bold("lint")}     --fix (regenerate drifted adapters)  --format <text|json|github|sarif>
${c.bold("doctor")}   --ci (exit 1 on errors or score < gates.minScore)  --min-score <n>  --markdown
           --base <git-ref> (diff with the base branch)  --no-regress (with --ci: fail if worse than base)
${c.bold("sync")}     --force (overwrite hand-written adapter files)  --check
${c.bold("ratchet add")}  --failure "<what happened>" --fix <${FIX_KINDS.join("|")}> --artifact <file> | --rule "<text>"  [--note]
${c.bold("check")}    [files…] | --staged | --hook claude (reads the hook payload on stdin)
${c.bold("graph")}    --format <mermaid|dot|json>  --markdown  --root <dir>  --include-tests
${c.bold("install")}  --only <${INTEGRATIONS.join(",")}>  --command "<how to run gearness>"  --uninstall
${c.bold("eval")}     --agent <${Object.keys(AGENT_PRESETS).join("|")}|"cmd {prompt}">  --runs <n>  --parallel <n>
           --task <id,id>  --baseline <git-ref>  --min-pass-rate <0-1>  --keep
${c.bold("eval report")}  --last <n>  --markdown

Docs: ${REPO_URL}
`;

function requireConfig(cwd: string): HarnessConfig {
  const { config, errors } = loadConfig(cwd);
  if (!config) throw new UsageError(errors.map((e) => `${CONFIG_FILE}: ${e}`).join("\n"));
  return config;
}

class UsageError extends Error {}

const sevLabel = (s: Diagnostic["severity"]) => (s === "error" ? c.red("error") : s === "warn" ? c.yellow("warn ") : c.blue("info "));
const prefix = (dir: string, file?: string) => (dir === "." ? file : file ? `${dir}/${file}` : dir);

function printDiagnostics(ds: Diagnostic[]): void {
  const byFile = new Map<string, Diagnostic[]>();
  for (const d of ds) byFile.set(d.file ?? "(repository)", [...(byFile.get(d.file ?? "(repository)") ?? []), d]);
  for (const [file, list] of byFile) {
    list.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity));
    console.log(c.bold(file));
    for (const d of list) {
      const loc = d.line ? c.gray(`:${d.line}`.padEnd(5)) : "     ";
      console.log(`  ${loc} ${sevLabel(d.severity)}  ${d.message}  ${c.gray(d.rule)}`);
      if (d.hint) console.log(`        ${c.gray("↳ " + d.hint)}`);
    }
    console.log();
  }
}

/** Flattens diagnostics of all workspaces, prefixing file paths with the workspace dir. */
function allDiagnostics(tree: WorkspaceReport[]): Diagnostic[] {
  return tree.flatMap((w) =>
    w.report
      ? w.report.diagnostics.map((d) => ({ ...d, file: prefix(w.dir, d.file) }))
      : w.configErrors.map((m) => ({ rule: "config/valid", severity: "error" as const, message: m, file: prefix(w.dir, CONFIG_FILE) })),
  );
}

function cmdInit(cwd: string, f: Flags): number {
  const stack = str(f, "stack") as Stack | undefined;
  if (stack && !STACKS.includes(stack)) throw new UsageError(`--stack must be one of ${STACKS.join(", ")}`);
  const agents = str(f, "agents")?.split(",").map((s) => s.trim()) as AgentId[] | undefined;
  for (const a of agents ?? []) if (!AGENTS.includes(a)) throw new UsageError(`unknown agent "${a}" (use ${AGENTS.join(", ")})`);
  const r = init(cwd, {
    name: str(f, "name"),
    description: str(f, "description"),
    stack,
    agents,
    ci: f.ci !== false,
    force: f.force === true,
    dryRun: f["dry-run"] === true,
    workspaces: f.workspaces === true,
  });
  console.log(`${c.bold("Detected")}  stack=${c.cyan(r.config.stack)}  commands=${Object.keys(r.config.commands).join(", ") || c.yellow("none")}  agents=${r.config.agents.join(",")}`);
  if (r.workspaces.length) console.log(`${c.bold("Workspaces")} ${r.workspaces.join(", ")}`);
  console.log();
  const icon = { created: c.green("+"), overwritten: c.yellow("~"), kept: c.gray("="), "would-create": c.cyan("?") };
  for (const file of r.files) console.log(`  ${icon[file.action]} ${file.file} ${c.gray(file.action)}`);
  if (r.imported.length) console.log(`\n${c.bold("Imported")} existing instructions from ${r.imported.join(", ")} into ${r.config.context.entry}`);
  for (const n of r.notes) console.log(`${c.yellow("note")} ${n}`);
  console.log(`\n${c.bold("Next")}
  1. Fill the ${c.cyan("TODO(gearness)")} markers in ${r.config.context.entry} and docs/ - real project knowledge is the whole point.
  2. Declare an architecture boundary in harness.yaml and create an eval task: ${c.cyan(`${TOOL} eval new <id>`)}.
  3. ${c.cyan(`${TOOL} install`)} so agents get feedback while they work (Claude Code hook, pre-commit, MCP).
  4. ${c.cyan(`${TOOL} doctor`)} for your score. When an agent repeats a mistake: ${c.cyan(`${TOOL} ratchet add`)}.`);
  return 0;
}

async function cmdLint(cwd: string, f: Flags): Promise<number> {
  const config = requireConfig(cwd);
  if (f.fix) {
    for (const r of sync(cwd, config).filter((r) => r.action === "written")) console.log(`${c.green("fixed")} regenerated ${r.file}`);
  }
  let tree = await evaluateTree(cwd, config);
  if (f.fix) {
    const fixed = applyFixes(cwd, allDiagnostics(tree));
    for (const file of fixed) console.log(`${c.green("fixed")} updated renamed paths in ${file}`);
    if (fixed.length) {
      // Docs changed: adapters copied from the entry file must follow.
      for (const r of sync(cwd, config).filter((r) => r.action === "written")) console.log(`${c.green("fixed")} regenerated ${r.file}`);
      tree = await evaluateTree(cwd, config);
    }
    for (const w of tree.slice(1))
      if (w.config) for (const r of sync(path.join(cwd, w.dir), w.config).filter((r) => r.action === "written")) console.log(`${c.green("fixed")} regenerated ${w.dir}/${r.file}`);
    tree = await evaluateTree(cwd, config);
  }
  const ds = allDiagnostics(tree);
  const errors = ds.filter((d) => d.severity === "error").length;
  const warnings = ds.filter((d) => d.severity === "warn").length;
  const format = str(f, "format") ?? (f.json ? "json" : "text");
  if (!["text", "json", "github", "sarif"].includes(format)) throw new UsageError("--format must be text, json, github or sarif");
  if (format === "json") return console.log(JSON.stringify({ errors, warnings, diagnostics: ds }, null, 2)), errors ? 1 : 0;
  if (format === "sarif") {
    const extra = (await Promise.all(tree.filter((w) => w.config).map((w) => loadExtraRules(path.join(cwd, w.dir), w.config!)))).flat();
    return console.log(JSON.stringify(toSarif(ds, [...RULES, ...extra]), null, 2)), errors ? 1 : 0;
  }
  if (format === "github") {
    if (ds.length) console.log(toGithubAnnotations(ds));
    console.log(`gearness: ${errors} error(s), ${warnings} warning(s), ${ds.length - errors - warnings} info`);
    return errors ? 1 : 0;
  }
  if (!ds.length) return console.log(c.green("✓ harness is clean")), 0;
  printDiagnostics(ds);
  console.log(`${errors ? c.red(`✖ ${errors} error(s)`) : c.green("✓ 0 errors")}, ${warnings} warning(s), ${ds.length - errors - warnings} info`);
  return errors ? 1 : 0;
}

const PILLAR_LABEL: Record<string, string> = {
  context: "Context",
  commands: "Verification",
  architecture: "Architecture",
  tooling: "Agent tooling",
  safety: "Safety",
  feedback: "Feedback loop",
};

const pillarEntries = (r: Report) => PILLARS.filter((p) => r.pillars[p]).map((p) => [p, r.pillars[p]] as const);

function bar(ratio: number, width = 20): string {
  const n = Math.round(ratio * width);
  const paint = ratio >= 0.75 ? c.green : ratio >= 0.5 ? c.yellow : c.red;
  return paint("█".repeat(n)) + c.gray("░".repeat(width - n));
}

function topGaps(r: Report, n = 5) {
  return r.results
    .filter((x) => x.diagnostics.length)
    .sort((a, b) => b.rule.weight - b.earned - (a.rule.weight - a.earned))
    .slice(0, n);
}

function printReport(cwd: string, config: HarnessConfig, r: Report): void {
  const paint = r.score >= 75 ? c.green : r.score >= 50 ? c.yellow : c.red;
  console.log(`\n  ${c.bold("Harness score")}  ${paint(c.bold(`${r.score}/100`))}  grade ${paint(r.grade)}   ${c.gray(`(${config.project.name})`)}\n`);
  for (const [p, v] of pillarEntries(r)) {
    const ratio = v!.total ? v!.earned / v!.total : 1;
    console.log(`  ${(PILLAR_LABEL[p] ?? p).padEnd(14)} ${bar(ratio)} ${String(Math.round(ratio * 100)).padStart(3)}%`);
  }
  const gaps = topGaps(r);
  if (gaps.length) {
    console.log(`\n  ${c.bold("Highest-impact fixes")}`);
    gaps.forEach((g, i) => {
      const d = g.diagnostics[0];
      const more = g.diagnostics.length > 1 ? c.gray(` (+${g.diagnostics.length - 1} more)`) : "";
      console.log(`  ${i + 1}. ${c.gray(`+${(g.rule.weight - g.earned).toFixed(1)} pts`)} ${d.message}${d.file ? c.gray(` - ${d.file}`) : ""}${more}`);
      if (d.hint) console.log(`     ${c.gray("↳ " + d.hint)}`);
    });
  } else console.log(`\n  ${c.green("Nothing to fix. Keep ratcheting.")}`);
  const statuses = adapterStatus(cwd, config);
  console.log(`\n  ${c.bold("Agents")}  ${statuses.map((s) => `${s.agent} ${s.state === "in-sync" || s.state === "native" ? c.green("✓") : c.yellow(s.state)}`).join("   ")}\n`);
}

function markdownReport(tree: WorkspaceReport[], cmp?: Comparison): string {
  const root = tree[0].report!;
  const emoji = (s: number) => (s >= 75 ? "🟢" : s >= 50 ? "🟡" : "🔴");
  const lines = [`## ${emoji(root.score)} Harness score: ${root.score}/100 (${root.grade})`, ""];
  if (cmp) {
    const d = cmp.delta === null ? "new harness" : cmp.delta > 0 ? `**+${cmp.delta}** ⬆️` : cmp.delta < 0 ? `**${cmp.delta}** ⬇️` : "±0";
    lines.push(`Compared with \`${cmp.ref}\`: ${cmp.baseScore ?? "-"} → ${cmp.score} (${d}) · ${cmp.introduced.length} new finding(s) · ${cmp.resolved.length} resolved`, "");
    const intro = cmp.introduced.filter((x) => x.severity !== "info");
    if (intro.length) {
      lines.push("**Introduced by this change**", "");
      for (const x of intro.slice(0, 15)) lines.push(`- ${x.severity === "error" ? "❌" : "⚠️"} \`${x.file ?? ""}${x.line ? `:${x.line}` : ""}\` ${x.message} <sub>${x.rule}</sub>`);
      lines.push("");
    }
  }
  lines.push("| Pillar | Score |", "|---|---|");
  for (const [p, v] of pillarEntries(root)) lines.push(`| ${PILLAR_LABEL[p] ?? p} | ${Math.round((v!.total ? v!.earned / v!.total : 1) * 100)}% |`);
  if (tree.length > 1) {
    lines.push("", "| Workspace | Score | Errors |", "|---|---|---|");
    for (const w of tree) lines.push(`| \`${w.dir}\` | ${w.report ? `${w.report.score} (${w.report.grade})` : "invalid config"} | ${w.report?.errors ?? "-"} |`);
  }
  const gaps = topGaps(root);
  if (gaps.length) {
    lines.push("", "**Highest-impact fixes**", "");
    for (const g of gaps) {
      const d = g.diagnostics[0];
      lines.push(`- **+${(g.rule.weight - g.earned).toFixed(1)} pts** ${d.message}${d.file ? ` - \`${d.file}\`` : ""} <sub>${g.rule.id}</sub>`);
    }
  }
  const errs = allDiagnostics(tree).filter((d) => d.severity === "error");
  if (errs.length) {
    lines.push("", `<details><summary>${errs.length} error(s)</summary>`, "");
    for (const d of errs) lines.push(`- \`${d.file ?? ""}${d.line ? `:${d.line}` : ""}\` ${d.message} <sub>${d.rule}</sub>`);
    lines.push("", "</details>");
  }
  lines.push("", `<sub>Generated by [gearness](${REPO_URL})</sub>`);
  return lines.join("\n");
}

async function cmdDoctor(cwd: string, f: Flags): Promise<number> {
  const config = requireConfig(cwd);
  const tree = await evaluateTree(cwd, config);
  const r = tree[0].report!;
  const min = str(f, "min-score") ? Number(str(f, "min-score")) : config.gates.minScore;
  const failures: string[] = [];
  const baseRef = str(f, "base");
  const cmp = baseRef ? await compareWithBase(cwd, baseRef, tree) : undefined;
  if (cmp && f["no-regress"]) {
    if (cmp.delta !== null && cmp.delta < 0) failures.push(`score dropped ${cmp.baseScore} → ${cmp.score} vs ${cmp.ref}`);
    const newErrors = cmp.introduced.filter((d) => d.severity === "error").length;
    if (newErrors) failures.push(`${newErrors} new error(s) vs ${cmp.ref}`);
  }
  for (const w of tree) {
    const where = w.dir === "." ? "" : ` in ${w.dir}`;
    if (!w.report) failures.push(`invalid ${CONFIG_FILE}${where}`);
    else {
      const wmin = w.dir === "." ? min : w.config!.gates.minScore;
      if (w.report.errors) failures.push(`${w.report.errors} error(s)${where}`);
      if (w.report.score < wmin) failures.push(`score ${w.report.score} < minScore ${wmin}${where}`);
    }
  }
  if (f.json) {
    console.log(
      JSON.stringify(
        {
          score: r.score,
          grade: r.grade,
          minScore: min,
          pillars: r.pillars,
          errors: r.errors,
          warnings: r.warnings,
          diagnostics: r.diagnostics,
          workspaces: tree.slice(1).map((w) => ({ dir: w.dir, score: w.report?.score ?? null, grade: w.report?.grade ?? null, errors: w.report?.errors ?? null, configErrors: w.configErrors })),
          gate: { passed: failures.length === 0, failures },
          ...(cmp ? { comparison: { ref: cmp.ref, baseScore: cmp.baseScore, delta: cmp.delta, introduced: cmp.introduced, resolved: cmp.resolved } } : {}),
        },
        null,
        2,
      ),
    );
  } else if (f.markdown) {
    console.log(markdownReport(tree, cmp));
  } else {
    printReport(cwd, config, r);
    if (cmp) {
      const d = cmp.delta === null ? c.cyan("new harness") : cmp.delta > 0 ? c.green(`+${cmp.delta}`) : cmp.delta < 0 ? c.red(String(cmp.delta)) : c.gray("±0");
      console.log(`  ${c.bold("vs " + cmp.ref)}  ${cmp.baseScore ?? "-"} → ${cmp.score} (${d})   ${c.red(`${cmp.introduced.length} new`)}  ${c.green(`${cmp.resolved.length} resolved`)}`);
      for (const x of cmp.introduced.filter((x) => x.severity !== "info").slice(0, 8)) console.log(`    ${sevLabel(x.severity)} ${x.file ?? ""}${x.line ? `:${x.line}` : ""} ${x.message}`);
      console.log();
    }
    if (tree.length > 1) {
      console.log(`  ${c.bold("Workspaces")}`);
      for (const w of tree.slice(1)) {
        const s = w.report ? `${String(w.report.score).padStart(3)}/100 ${w.report.grade}` : c.red("invalid harness.yaml");
        const e = w.report?.errors ? c.red(` ${w.report.errors} error(s)`) : "";
        console.log(`  ${w.dir.padEnd(28)} ${s}${e}`);
      }
      console.log();
    }
  }
  if (f.ci) {
    if (failures.length) {
      if (!f.json && !f.markdown) console.error(c.red(`✖ gate failed: ${failures.join("; ")}. Run \`${TOOL} lint\` for details.`));
      return 1;
    }
    if (!f.json && !f.markdown) console.log(c.green(`✓ gate passed (score ${r.score} ≥ ${min})`));
  }
  return 0;
}

function cmdSync(cwd: string, f: Flags): number {
  const config = requireConfig(cwd);
  if (f.check) {
    const bad = adapterStatus(cwd, config).filter((s) => s.state === "missing" || s.state === "drifted");
    for (const s of bad) console.log(`${c.red(s.state)} ${s.file}`);
    if (!bad.length) console.log(c.green("✓ adapters in sync"));
    return bad.length ? 1 : 0;
  }
  let skipped = 0;
  for (const r of sync(cwd, config, { force: f.force === true })) {
    if (r.action === "native") console.log(`  ${c.gray("·")} ${r.agent} ${c.gray(`reads ${config.context.entry} natively`)}`);
    else if (r.action === "written") console.log(`  ${c.green("+")} ${r.file} ${c.gray(r.agent)}`);
    else if (r.action === "unchanged") console.log(`  ${c.gray("=")} ${r.file} ${c.gray("up to date")}`);
    else if (r.action === "skipped-unmanaged") {
      skipped++;
      console.log(`  ${c.yellow("!")} ${r.file} ${c.yellow("is hand-written; merge it into the entry file, then use --force")}`);
    } else console.log(`  ${c.red("✖")} ${config.context.entry} not found`);
  }
  return skipped ? 1 : 0;
}

function cmdRatchet(cwd: string, sub: string | undefined, f: Flags): number {
  const config = requireConfig(cwd);
  if (sub === "list" || sub === undefined) {
    const log = loadRatchet(cwd);
    if (f.json) return console.log(JSON.stringify(log, null, 2)), 0;
    if (log.error) return console.error(c.red(log.error)), 1;
    if (!log.entries.length) return console.log(`No entries yet. Record one with ${c.cyan(`${TOOL} ratchet add`)}.`), 0;
    for (const e of log.entries) {
      console.log(`${c.bold(e.id)} ${c.gray(e.date)}  ${c.magenta(e.fix.padEnd(4))}  ${e.failure}`);
      console.log(`       ${c.gray("→ " + e.artifact)}${e.rule ? c.gray(`: ${e.rule}`) : ""}`);
    }
    const mech = log.entries.filter((e) => e.fix !== "doc").length;
    console.log(`\n${log.entries.length} entries, ${mech} mechanical (${Math.round((mech / log.entries.length) * 100)}%). ${c.gray("Mechanical guardrails beat written rules.")}`);
    return 0;
  }
  if (sub !== "add") throw new UsageError(`unknown ratchet subcommand "${sub}" (use add or list)`);
  const failure = str(f, "failure");
  const fix = str(f, "fix") as FixKind | undefined;
  if (!failure || !fix) throw new UsageError(`usage: ${TOOL} ratchet add --failure "<what went wrong>" --fix <${FIX_KINDS.join("|")}> [--artifact <file> | --rule "<text>"]`);
  if (!FIX_KINDS.includes(fix)) throw new UsageError(`--fix must be one of ${FIX_KINDS.join(", ")}`);
  const entry = addEntry(cwd, config.context.entry, { failure, fix, artifact: str(f, "artifact"), rule: str(f, "rule"), note: str(f, "note") });
  console.log(`${c.green("✓")} recorded ${c.bold(entry.id)} (${entry.fix} → ${entry.artifact})`);
  if (fix === "doc") {
    sync(cwd, config);
    console.log(`  rule added to ${config.context.entry} and agent adapters re-synced`);
    console.log(c.gray("  tip: if this rule can be checked by a linter or test, do that instead - agents can ignore prose, not CI."));
  }
  return 0;
}

async function cmdEval(cwd: string, sub: string | undefined, arg: string | undefined, f: Flags): Promise<number> {
  const config = requireConfig(cwd);
  if (sub === "new") {
    if (!arg) throw new UsageError(`usage: ${TOOL} eval new <task-id>`);
    const file = newTask(cwd, config, arg);
    console.log(`${c.green("+")} ${file}\n  Write a realistic prompt and a check command that only passes when the task is done right.`);
    return 0;
  }
  if (sub === "list") {
    const { tasks, errors } = loadTasks(cwd, config);
    if (f.json) return console.log(JSON.stringify({ tasks, errors }, null, 2)), errors.length ? 1 : 0;
    for (const t of tasks) console.log(`${c.bold(t.id.padEnd(28))} ${c.gray(t.file)}  check: ${t.check.trim().split("\n")[0]}${t.check.trim().includes("\n") ? " …" : ""}`);
    for (const e of errors) console.log(`${c.red("error")} ${e}`);
    if (!tasks.length && !errors.length) console.log(`No tasks yet. Create one with ${c.cyan(`${TOOL} eval new <id>`)}.`);
    return errors.length ? 1 : 0;
  }
  if (sub === "report") return evalReport(cwd, f);
  if (sub !== undefined && sub !== "run") throw new UsageError(`unknown eval subcommand "${sub}" (use run, new, list or report)`);
  const runs = str(f, "runs") ? Number(str(f, "runs")) : 1;
  if (!Number.isInteger(runs) || runs < 1) throw new UsageError("--runs must be a positive integer");
  const parallel = str(f, "parallel") ? Number(str(f, "parallel")) : 1;
  if (!Number.isInteger(parallel) || parallel < 1) throw new UsageError("--parallel must be a positive integer");
  const summary = await runEval(cwd, config, {
    runs,
    parallel,
    tasks: str(f, "task")?.split(",").map((s) => s.trim()),
    agent: str(f, "agent"),
    baseline: str(f, "baseline"),
    keep: f.keep === true,
    onProgress: f.json ? undefined : (m) => console.error(c.gray(m)),
  });
  if (f.json) console.log(JSON.stringify(summary, null, 2));
  else {
    const [cur, base] = summary.variants;
    console.log(`\n  ${c.bold("Eval")}  agent=${summary.agent}  runs/task=${runs}\n`);
    const ids = [...new Set(summary.runs.map((r) => r.task))];
    const rate = (task: string, v: string) => {
      const rs = summary.runs.filter((r) => r.task === task && r.variant === v);
      return { p: rs.filter((r) => r.passed).length, n: rs.length };
    };
    console.log(`  ${"task".padEnd(28)} ${"current".padEnd(10)}${base ? `${base.name.slice(0, 12).padEnd(14)}Δ` : ""}`);
    for (const id of ids) {
      const a = rate(id, cur.name);
      const cell = (x: { p: number; n: number }) => (x.p === x.n ? c.green : x.p ? c.yellow : c.red)(`${x.p}/${x.n}`.padEnd(10));
      let line = `  ${id.padEnd(28)} ${cell(a)}`;
      if (base) {
        const b = rate(id, base.name);
        const d = Math.round((a.p / a.n - b.p / b.n) * 100);
        line += `${cell(b)}    ${d > 0 ? c.green(`+${d}%`) : d < 0 ? c.red(`${d}%`) : c.gray("0%")}`;
      }
      console.log(line);
    }
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const delta = base ? Math.round((cur.passRate - base.passRate) * 100) : 0;
    const deltaText = delta > 0 ? c.green(`+${delta} pp`) : delta < 0 ? c.red(`${delta} pp`) : c.gray("±0 pp");
    console.log(`\n  ${c.bold("Pass rate")}  current ${pct(cur.passRate)}${base ? `   ${base.name} ${pct(base.passRate)}   Δ ${deltaText}` : ""}`);
    const fails = summary.runs.filter((r) => !r.passed && r.variant === cur.name);
    if (fails.length) {
      console.log(`\n  ${c.bold("Failures")} ${c.gray("(current harness)")}`);
      for (const r of fails.slice(0, 8)) console.log(`  ${c.red("✗")} ${r.task} run ${r.run}: ${r.reason}`);
    }
    console.log(c.gray(`\n  Full results in ${RESULTS_DIR}/. Agents are nondeterministic: use --runs 3+ before drawing conclusions.\n`));
  }
  const min = str(f, "min-pass-rate");
  if (min !== undefined && summary.variants[0].passRate < Number(min)) {
    if (!f.json) console.error(c.red(`✖ pass rate ${Math.round(summary.variants[0].passRate * 100)}% < ${Math.round(Number(min) * 100)}%`));
    return 1;
  }
  return 0;
}

function evalReport(cwd: string, f: Flags): number {
  const last = str(f, "last") ? Number(str(f, "last")) : 10;
  const history = loadHistory(cwd, last);
  if (!history.length) return console.log(`No results in ${RESULTS_DIR}/ yet. Run \`${TOOL} eval\` first.`), 0;
  const { tasks, rows } = trend(history);
  const pct = (x: number | null) => (x === null ? "-" : `${Math.round(x * 100)}%`);
  if (f.json) return console.log(JSON.stringify({ tasks, rows }, null, 2)), 0;
  if (f.markdown) {
    const lines = [`## Eval trend (last ${rows.length} runs)`, "", `| Date | Agent | Overall | ${tasks.join(" | ")} |`, `|---|---|---|${tasks.map(() => "---|").join("")}`];
    for (const r of rows) lines.push(`| ${r.date.slice(0, 16).replace("T", " ")} | ${r.agent} | **${pct(r.overall)}** | ${tasks.map((t) => pct(r.rates[t])).join(" | ")} |`);
    return console.log(lines.join("\n")), 0;
  }
  console.log(`\n  ${c.bold("Eval trend")} ${c.gray(`(last ${rows.length} runs, current harness)`)}\n`);
  const spark = (vals: (number | null)[]) => vals.map((v) => (v === null ? c.gray("·") : "▁▂▃▄▅▆▇█"[Math.min(7, Math.round(v * 7))])).join("");
  console.log(`  ${"overall".padEnd(28)} ${spark(rows.map((r) => r.overall))}  ${pct(rows[rows.length - 1].overall)}`);
  for (const t of tasks) console.log(`  ${t.padEnd(28)} ${spark(rows.map((r) => r.rates[t]))}  ${pct(rows[rows.length - 1].rates[t])}`);
  const first = rows[0].overall;
  const lastRate = rows[rows.length - 1].overall;
  const d = Math.round((lastRate - first) * 100);
  console.log(`\n  ${rows.length > 1 ? `Since ${rows[0].date.slice(0, 10)}: ${d > 0 ? c.green(`+${d} pp`) : d < 0 ? c.red(`${d} pp`) : "±0 pp"}` : "Run more evals to see a trend."}\n`);
  return 0;
}

async function cmdCheck(cwd: string, files: string[], f: Flags): Promise<number> {
  const hook = str(f, "hook");
  if (hook !== undefined && hook !== "claude") throw new UsageError("--hook supports: claude");
  let root = cwd;
  if (hook === "claude") {
    // Claude Code PostToolUse: payload on stdin; exit 2 feeds stderr back to the agent.
    let payload: { cwd?: string } = {};
    try {
      payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    } catch {
      return 0; // never block the agent because of a malformed payload
    }
    const file = fileFromClaudeHook(payload);
    if (!file) return 0;
    root = path.resolve(str(f, "cwd") ?? payload.cwd ?? cwd);
    const rel = path.relative(root, path.resolve(root, file));
    if (rel.startsWith("..") || path.isAbsolute(rel)) return 0;
    const results = checkFiles(root, [rel], { autoSync: true });
    if (!results.some((r) => r.diagnostics.some((d) => d.severity === "error"))) return 0;
    for (const r of results) recordEvents(r.root, "claude-hook", r.diagnostics.filter((d) => d.severity === "error"));
    console.error(hookFeedback(results.map((r) => ({ ...r, diagnostics: r.diagnostics.filter((d) => d.severity === "error") })), root));
    return 2;
  }
  let list = files;
  if (f.staged) {
    if (!hasGit()) throw new UsageError(`--staged needs git: ${GIT_MISSING}`);
    try {
      list = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], { cwd }).toString().split("\0").filter(Boolean);
    } catch {
      throw new UsageError("--staged needs a git repository");
    }
  }
  if (!list.length) return console.log(c.gray("nothing to check")), 0;
  const results = checkFiles(root, list, { autoSync: false });
  if (f.staged) for (const r of results) recordEvents(r.root, "pre-commit", r.diagnostics.filter((d) => d.severity === "error"));
  const ds = results.flatMap((r) => r.diagnostics.map((d) => ({ ...d, file: posix(path.relative(root, path.join(r.root, d.file ?? ""))) })));
  if (f.json) return console.log(JSON.stringify({ checked: list.length, diagnostics: ds }, null, 2)), ds.some((d) => d.severity === "error") ? 1 : 0;
  if (!ds.length) return console.log(c.green(`✓ ${list.length} file(s) pass the harness checks`)), 0;
  printDiagnostics(ds);
  const errors = ds.filter((d) => d.severity === "error").length;
  if (errors) console.error(c.red(`✖ ${errors} error(s) - commit blocked by the harness`));
  return errors ? 1 : 0;
}

function cmdInstall(cwd: string, f: Flags): number {
  const config = requireConfig(cwd);
  const only = str(f, "only")?.split(",").map((s) => s.trim()) as Integration[] | undefined;
  for (const o of only ?? []) if (!INTEGRATIONS.includes(o)) throw new UsageError(`--only accepts ${INTEGRATIONS.join(", ")}`);
  const actions = install(cwd, config, { only, command: str(f, "command"), remove: f.uninstall === true });
  const icon = { added: c.green("+"), updated: c.yellow("~"), unchanged: c.gray("="), removed: c.red("-"), manual: c.yellow("!") };
  for (const a of actions) {
    console.log(`  ${icon[a.action]} ${a.integration.padEnd(7)} ${a.file} ${c.gray(a.action)}`);
    if (a.note) console.log(a.note.split("\n").map((l) => `      ${l}`).join("\n"));
  }
  if (f.uninstall !== true)
    console.log(`\n  ${c.bold("What this does")}
  claude  every edit by Claude Code is checked; violations go straight back to the agent to fix
  git     staged files are checked before each commit, for humans and agents alike
  mcp     agents can ask the harness: overview, verify commands, can-I-import, check my files
  ${c.gray("Commit .claude/settings.json and the MCP files so the whole team gets them.")}`);
  return 0;
}

async function cmdExplain(cwd: string, id: string | undefined, f: Flags): Promise<number> {
  if (!id) throw new UsageError(`usage: ${TOOL} explain <rule-id>   (see \`${TOOL} rules\`)`);
  const { config } = loadConfig(cwd);
  const extra = config ? await loadExtraRules(cwd, config) : [];
  const rule = [...RULES, ...extra].find((r) => r.id === id);
  if (!rule) throw new UsageError(`unknown rule "${id}"`);
  const report = config ? (await evaluateTree(cwd, config))[0].report : undefined;
  const result = report?.results.find((r) => r.rule.id === id);
  if (f.json) return console.log(JSON.stringify({ id: rule.id, pillar: rule.pillar, weight: rule.weight, severity: rule.severity, description: rule.description, findings: result?.diagnostics ?? [] }, null, 2)), 0;
  console.log(`\n  ${c.bold(rule.id)}  ${c.gray(`${rule.pillar} · ${rule.weight} pts · ${rule.severity}${extra.includes(rule) ? " · custom" : ""}`)}\n`);
  console.log(`  ${rule.description}\n`);
  if (!config) console.log(c.gray("  (no harness.yaml here, so no findings to show)"));
  else if (config.rules.disable.includes(id)) console.log(c.yellow("  Disabled in harness.yaml (rules.disable)."));
  else if (!result?.diagnostics.length) console.log(c.green("  ✓ No findings in this repository."));
  else {
    console.log(`  ${c.bold("Findings")} ${c.gray(`(${result.earned.toFixed(1)}/${rule.weight} pts earned)`)}`);
    for (const d of result.diagnostics.slice(0, 10)) console.log(`  ${sevLabel(d.severity)} ${d.file ?? ""}${d.line ? `:${d.line}` : ""} ${d.message}${d.hint ? c.gray(`\n         ↳ ${d.hint}`) : ""}`);
  }
  console.log(c.gray(`\n  Docs: ${REPO_URL}/blob/main/docs/rules.md · disable with rules.disable: [${id}]\n`));
  return 0;
}

function cmdLearn(cwd: string, f: Flags): number {
  const config = requireConfig(cwd);
  const min = str(f, "min") ? Number(str(f, "min")) : 2;
  const lessons = findLessons(cwd, { min });
  if (f.json && !f.apply) return console.log(JSON.stringify(lessons, null, 2)), 0;
  if (!lessons.length) {
    console.log(`\n  ${c.bold("Nothing to learn yet.")} ${c.gray(`Violations caught by hooks, pre-commit and MCP are logged to ${TELEMETRY_FILE};`)}`);
    console.log(c.gray(`  eval failures come from .harness/eval-results/. Run \`${TOOL} install\` and come back after some agent sessions.\n`));
    return 0;
  }
  if (!f.apply) {
    console.log(`\n  ${c.bold("What agents keep getting wrong")} ${c.gray(`(seen ${min}+ times)`)}\n`);
    for (const l of lessons) {
      const tag = l.learned ? c.green("learned") : l.enforced ? c.yellow("caught, not yet taught") : c.red("not guarded");
      console.log(`  ${c.bold(`${l.count}×`)} ${l.pattern} ${c.gray(`· ${l.days} day(s) · ${l.sources.join(", ")}`)}  ${tag}`);
      if (!l.learned) console.log(`     ${c.cyan("→ rule:")} ${l.rule}`);
    }
    const pending = lessons.filter((l) => !l.learned).length;
    console.log(pending ? `\n  ${c.cyan(`${TOOL} learn --apply`)} adds ${pending} learned rule(s) to ${config.context.entry} and the ratchet log.\n  ${c.gray("Caught violations still cost the agent a failed attempt; teaching the rule up front saves it.")}\n` : c.green("\n  ✓ every recurring mistake is already a learned rule\n"));
    return 0;
  }
  const added = applyLessons(cwd, config, lessons);
  if (added.length) sync(cwd, config);
  if (f.json) return console.log(JSON.stringify(added, null, 2)), 0;
  for (const e of added) console.log(`${c.green("✓")} ${c.bold(e.id)} ${e.rule}`);
  console.log(added.length ? c.gray(`  added to ${config.context.entry}, recorded in the ratchet log, adapters re-synced`) : c.green("✓ nothing new to learn"));
  return 0;
}

function cmdContext(cwd: string, target: string | undefined, f: Flags): number {
  const config = requireConfig(cwd);
  const results = xray(cwd, config, target ?? ".");
  const agent = str(f, "agent");
  const shown = agent ? results.filter((r) => r.agent === agent) : results;
  if (agent && !shown.length) throw new UsageError(`agent "${agent}" is not in harness.yaml agents (${config.agents.join(", ")})`);
  if (f.json) return console.log(JSON.stringify(shown, null, 2)), 0;
  const budget = config.context.maxEntryTokens;
  console.log(`\n  ${c.bold("Context X-ray")} ${c.gray(`for ${target ?? "."} - what each agent loads before reading any code`)}\n`);
  for (const r of shown) {
    const paint = r.tokens > budget * 2 ? c.red : r.tokens > budget ? c.yellow : c.green;
    console.log(`  ${c.bold(r.agent.padEnd(9))} ${paint(`~${r.tokens.toLocaleString("en")} tokens`)} always loaded${r.always.length ? "" : c.yellow("  (nothing! this agent starts blind)")}`);
    for (const a of r.always) console.log(`    ${c.green("●")} ${a.file.padEnd(46)} ${String(a.tokens).padStart(6)}  ${c.gray(a.why)}`);
    for (const a of r.onDemand) console.log(`    ${c.gray("○")} ${c.gray(a.file.padEnd(46))} ${c.gray(String(a.tokens).padStart(6))}  ${c.gray(a.why)}`);
    for (const d of r.duplicates) console.log(`    ${c.yellow("⚠ duplicate:")} ${d}`);
  }
  console.log(c.gray(`\n  ● always loaded   ○ on demand   budget per entry file: ${budget} tokens (context.maxEntryTokens)`));
  console.log(c.gray("  Approximation of each tool's documented loading rules; global/user-level files are not included.\n"));
  return 0;
}

function cmdGraph(cwd: string, f: Flags): number {
  const config = loadConfig(cwd).config;
  const graph = buildGraph(cwd, { root: str(f, "root"), includeTests: f["include-tests"] === true });
  if (!graph.modules.length) return console.log(c.gray("no source files found")), 0;
  const bad = config ? violationEdges(cwd, graph, config.boundaries) : [];
  const format = str(f, "format") ?? (f.json ? "json" : "mermaid");
  if (format === "json") return console.log(JSON.stringify({ ...graph, violations: bad }, null, 2)), 0;
  if (format === "dot") return console.log(toDot(graph, bad)), 0;
  if (format !== "mermaid") throw new UsageError("--format must be mermaid, dot or json");
  const mermaid = toMermaid(graph, bad);
  console.log(f.markdown ? ["```mermaid", mermaid, "```", "", `<sub>Module dependencies under \`${graph.root || "."}\`. Red: boundary violations · dashed orange: cycles. Generated by gearness.</sub>`].join("\n") : mermaid);
  return 0;
}

function cmdBoundaries(cwd: string, sub: string | undefined, f: Flags): number {
  if (sub !== "suggest") throw new UsageError(`usage: ${TOOL} boundaries suggest [--strict] [--write] [--root <dir>] [--include-tests]`);
  const config = requireConfig(cwd);
  const graph = buildGraph(cwd, { root: str(f, "root"), includeTests: f["include-tests"] === true });
  const s = suggestBoundaries(cwd, graph, { strict: f.strict === true, includeTests: f["include-tests"] === true });
  const existing = new Set(config.boundaries.map((b) => b.from));
  const fresh = s.boundaries.filter((b) => !existing.has(b.from));
  if (f.json) return console.log(JSON.stringify({ root: graph.root, ...s, new: fresh }, null, 2)), 0;
  console.log(`\n  ${c.bold("Architecture inferred from imports")} ${c.gray(`(${graph.modules.length} modules under ${graph.root || "."}, ${graph.edges.reduce((n, e) => n + e.count, 0)} cross-module imports)`)}\n`);
  if (s.cycles.length) {
    console.log(`  ${c.yellow("Cycles")} ${c.gray("- these modules import each other, so neither can be layered yet:")}`);
    for (const [a, b] of s.cycles) console.log(`    ${a} ⇄ ${b}`);
    console.log();
  }
  if (!fresh.length) {
    console.log(s.boundaries.length ? c.green("  ✓ every inferred boundary is already declared") : c.gray("  nothing to propose: no one-directional dependencies between modules"));
    return 0;
  }
  console.log(`  ${c.bold(`${fresh.length} boundaries`)} ${c.gray("that the code already respects (verified: 0 violations today):")}\n`);
  console.log(YAML.stringify({ boundaries: fresh }, { lineWidth: 0, aliasDuplicateObjects: false }).split("\n").map((l) => `    ${l}`).join("\n"));
  if (s.dropped) console.log(c.gray(`  (${s.dropped} candidate(s) dropped because unresolved imports would violate them)`));
  if (!f.write) {
    console.log(`  Lock them in with ${c.cyan(`${TOOL} boundaries suggest --write`)} - from then on, agents cannot erode the layering.\n`);
    return 0;
  }
  const file = path.join(cwd, CONFIG_FILE);
  const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
  const current = (doc.toJS()?.boundaries as unknown[]) ?? [];
  doc.set("boundaries", doc.createNode([...current, ...fresh], { aliasDuplicateObjects: false }));
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
  console.log(c.green(`  ✓ added ${fresh.length} boundaries to ${CONFIG_FILE}\n`));
  return 0;
}

async function cmdBadge(cwd: string, f: Flags): Promise<number> {
  const config = requireConfig(cwd);
  const r = (await evaluateTree(cwd, config))[0].report!;
  const colorName = r.score >= 90 ? "brightgreen" : r.score >= 75 ? "green" : r.score >= 60 ? "yellow" : r.score >= 40 ? "orange" : "red";
  const url = `https://img.shields.io/badge/harness-${r.score}%2F100_${r.grade}-${colorName}`;
  if (f.json) console.log(JSON.stringify({ score: r.score, grade: r.grade, url }));
  else console.log(`[![harness score](${url})](${REPO_URL})`);
  return 0;
}

async function cmdRules(cwd: string, f: Flags): Promise<number> {
  const { config } = loadConfig(cwd);
  const extra = config ? await loadExtraRules(cwd, config) : [];
  const all = [...RULES, ...extra];
  if (f.json) return console.log(JSON.stringify(all.map(({ check, credit, ...r }) => ({ ...r, custom: extra.includes(all.find((x) => x.id === r.id)!) })), null, 2)), 0;
  for (const r of all) console.log(`${c.bold(r.id.padEnd(28))} ${c.gray(r.pillar.padEnd(12))} ${String(r.weight).padStart(2)} pts  ${r.description}${extra.includes(r) ? c.magenta(" [custom]") : ""}`);
  return 0;
}

async function main(): Promise<number> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.version) return console.log(VERSION), 0;
  const [cmd, sub, arg] = positional;
  if (!cmd || flags.help || cmd === "help") return console.log(HELP), 0;
  const cwd = path.resolve(str(flags, "cwd") ?? process.cwd());
  switch (cmd) {
    case "init": return cmdInit(cwd, flags);
    case "lint": return cmdLint(cwd, flags);
    case "doctor": return cmdDoctor(cwd, flags);
    case "sync": return cmdSync(cwd, flags);
    case "ratchet": return cmdRatchet(cwd, sub, flags);
    case "eval": return cmdEval(cwd, sub, arg, flags);
    case "check": return cmdCheck(cwd, positional.slice(1), flags);
    case "install": return cmdInstall(cwd, flags);
    case "mcp": return requireConfig(cwd), serve(cwd).then(() => 0);
    case "explain": return cmdExplain(cwd, sub, flags);
    case "graph": return cmdGraph(cwd, flags);
    case "context": return cmdContext(cwd, sub, flags);
    case "learn": return cmdLearn(cwd, flags);
    case "boundaries": return cmdBoundaries(cwd, sub, flags);
    case "badge": return cmdBadge(cwd, flags);
    case "rules": return cmdRules(cwd, flags);
    default:
      throw new UsageError(`unknown command "${cmd}". Run \`${TOOL} --help\`.`);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(`${c.red("error")} ${(e as Error).message}`);
    process.exitCode = 2;
  },
);
