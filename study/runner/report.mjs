#!/usr/bin/env node
// Turns raw study results into a Markdown report: per-condition pass rate with a cluster-bootstrap CI,
// per-task table, pre-registered comparisons, a sensitivity check and the harness-score correlation.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { isInvalid } from "./lib.mjs";
import { bootstrapDiff, bootstrapMacro, macro, mean, spearman, wilson } from "./stats.mjs";

/** Order used for display and to decide which comparisons are pre-registered (see PROTOCOL.md §6). */
const ORDER = ["full", "bloated", "minimal", "none"];
const PRIMARY = [["full", "minimal"], ["full", "bloated"]];

export function loadResults(dirs) {
  const rows = [], scores = [], metrics = [], studies = [];
  for (const dir of dirs) {
    const manifest = fs.existsSync(path.join(dir, "manifest.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) : null;
    const rawDir = path.join(dir, "raw");
    if (!fs.existsSync(rawDir)) throw new Error(`${dir}: no raw/ directory (run the study first)`);
    const study = manifest?.study ?? path.basename(path.dirname(path.resolve(dir)));
    studies.push({ study, manifest });
    for (const f of fs.readdirSync(rawDir).filter((f) => f.endsWith(".json")).sort()) {
      const raw = JSON.parse(fs.readFileSync(path.join(rawDir, f), "utf8"));
      scores.push({ study, condition: raw.condition, score: raw.doctorScore ?? null });
      for (const [round, summary] of Object.entries(raw.rounds ?? {}))
        for (const r of summary.runs) rows.push({ study, condition: raw.condition, task: r.task, run: Number(round), passed: r.passed, invalid: isInvalid(r), reason: r.reason, forbidden: r.forbiddenChanged?.length ?? 0, durationMs: r.durationMs });
    }
    const mf = path.join(dir, "metrics.jsonl");
    if (fs.existsSync(mf))
      for (const l of fs.readFileSync(mf, "utf8").split("\n").filter(Boolean))
        try {
          metrics.push({ study, ...JSON.parse(l) });
        } catch {
          /* ignore a torn line */
        }
  }
  return { rows, scores, metrics, studies };
}

const sortConditions = (names) => [...names].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));

export function analyze({ rows, scores = [], metrics = [] }, { B = 10000, seed = 1 } = {}) {
  const multi = new Set(rows.map((r) => r.study)).size > 1;
  const key = (r) => (multi ? `${r.study}/${r.task}` : r.task);
  const conditions = sortConditions([...new Set(rows.map((r) => r.condition))]);
  const tasks = [...new Set(rows.map(key))].sort();

  const perCond = {};
  for (const c of conditions) {
    const mine = rows.filter((r) => r.condition === c);
    const valid = mine.filter((r) => !r.invalid);
    const perTask = {}, perTaskStrict = {};
    for (const r of valid) (perTask[key(r)] ??= []).push(r.passed ? 1 : 0);
    for (const r of mine) (perTaskStrict[key(r)] ??= []).push(r.passed ? 1 : 0);
    const passed = valid.filter((r) => r.passed).length;
    const cost = metrics.filter((m) => m.condition === c && typeof m.costUsd === "number").map((m) => m.costUsd);
    perCond[c] = {
      perTask,
      runs: mine.length,
      valid: valid.length,
      invalid: mine.length - valid.length,
      passed,
      macro: bootstrapMacro(perTask, { B, seed }),
      pooled: wilson(passed, valid.length),
      strictMacro: macro(perTaskStrict),
      forbidden: valid.filter((r) => r.forbidden > 0).length,
      meanSeconds: valid.length ? mean(valid.map((r) => r.durationMs)) / 1000 : NaN,
      meanCost: cost.length ? mean(cost) : null,
      score: mean(scores.filter((s) => s.condition === c && typeof s.score === "number").map((s) => s.score)),
    };
  }

  const comparisons = [];
  const seen = new Set();
  const add = (a, b, primary) => {
    if (!perCond[a] || !perCond[b] || seen.has(`${a}|${b}`)) return;
    seen.add(`${a}|${b}`);
    const d = bootstrapDiff(perCond[a].perTask, perCond[b].perTask, { B, seed });
    const verdict = !d.tasks ? "no shared tasks" : d.lo > 0 ? `${a} better` : d.hi < 0 ? `${a} worse` : "inconclusive";
    comparisons.push({ a, b, primary, ...d, verdict });
  };
  for (const [a, b] of PRIMARY) add(a, b, true);
  for (let i = 0; i < conditions.length; i++) for (let j = i + 1; j < conditions.length; j++) add(conditions[i], conditions[j], false);

  // One point per (study, condition): harness score against that study's macro pass rate.
  const points = [];
  for (const s of scores) {
    if (typeof s.score !== "number") continue;
    const perTask = {};
    for (const r of rows.filter((r) => r.study === s.study && r.condition === s.condition && !r.invalid)) (perTask[r.task] ??= []).push(r.passed ? 1 : 0);
    if (Object.keys(perTask).length) points.push({ score: s.score, rate: macro(perTask) });
  }
  const correlation = { n: points.length, rho: points.length >= 6 ? spearman(points.map((p) => p.score), points.map((p) => p.rate)) : null };

  return { conditions, tasks, perCond, comparisons, correlation, multi, B, seed };
}

const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "n/a");
const pp = (x) => (Number.isFinite(x) ? `${x > 0 ? "+" : ""}${Math.round(x * 100)} pp` : "n/a");

export function render(a, studies = []) {
  const L = [];
  const ids = studies.map((s) => s.study).join(", ");
  const total = Object.values(a.perCond).reduce((n, c) => n + c.runs, 0);
  const invalid = Object.values(a.perCond).reduce((n, c) => n + c.invalid, 0);
  L.push(`# Study report${ids ? `: ${ids}` : ""}`, "");
  L.push(`${total} agent runs over ${a.tasks.length} task(s) and ${a.conditions.length} condition(s); ${invalid} invalid run(s) excluded from the primary analysis (counted as failures in the sensitivity check below).`, "");

  L.push("## Pass rate by condition", "");
  L.push("| Condition | Pass rate (95% CI) | Valid runs | Invalid | Forbidden-file violations | Mean time per run | Mean cost per run | Harness score |", "|---|---|---|---|---|---|---|---|");
  for (const c of a.conditions) {
    const p = a.perCond[c];
    L.push(`| ${c} | **${pct(p.macro.mean)}** (${pct(p.macro.lo)} to ${pct(p.macro.hi)}) | ${p.valid} | ${p.invalid} | ${p.forbidden} | ${Number.isFinite(p.meanSeconds) ? `${Math.round(p.meanSeconds)} s` : "n/a"} | ${p.meanCost === null ? "n/a" : `$${p.meanCost.toFixed(2)}`} | ${Number.isFinite(p.score) ? Math.round(p.score) : "n/a"} |`);
  }
  L.push("", `Pass rate is the mean of per-task pass rates. The interval is a cluster bootstrap over tasks (${a.B} resamples, seed ${a.seed}); with few tasks it is wide, and that width is the honest answer. Run-level rate with a Wilson interval, for reference: ${a.conditions.map((c) => `${c} ${pct(a.perCond[c].pooled.p)} (${pct(a.perCond[c].pooled.lo)} to ${pct(a.perCond[c].pooled.hi)})`).join("; ")}.`, "");

  L.push("## Pass rate per task", "", `| Task | ${a.conditions.join(" | ")} |`, `|---|${a.conditions.map(() => "---").join("|")}|`);
  for (const t of a.tasks) L.push(`| ${t} | ${a.conditions.map((c) => { const r = a.perCond[c].perTask[t]; return r?.length ? `${r.reduce((x, y) => x + y, 0)}/${r.length}` : "-"; }).join(" | ")} |`);

  L.push("", "## Comparisons", "", "Difference in pass rate (A minus B), paired by task. A verdict other than *inconclusive* means the 95% interval excludes zero.", "", "| A vs B | Difference | 95% CI | Tasks | Verdict | Status |", "|---|---|---|---|---|---|");
  for (const x of a.comparisons) L.push(`| ${x.a} vs ${x.b} | ${pp(x.mean)} | ${pp(x.lo)} to ${pp(x.hi)} | ${x.tasks} | ${x.verdict} | ${x.primary ? "pre-registered" : "exploratory"} |`);
  if (!a.comparisons.length) L.push("| - | - | - | - | needs at least two conditions | - |");

  L.push("", "## Sensitivity: invalid runs counted as failures", "", `| ${a.conditions.join(" | ")} |`, `|${a.conditions.map(() => "---").join("|")}|`, `| ${a.conditions.map((c) => pct(a.perCond[c].strictMacro)).join(" | ")} |`);

  L.push("", "## Does the harness score predict the pass rate?", "");
  L.push(a.correlation.rho === null ? `Not enough points (${a.correlation.n}; at least 6 study × condition points are needed for a rank correlation).` : `Spearman rho = ${a.correlation.rho.toFixed(2)} over ${a.correlation.n} study × condition points. This is exploratory: it says whether the score tracks outcomes, not that it causes them.`);

  L.push("", "## Read this before quoting a number", "", "- Results are specific to the agent, model, tasks and repositories listed in the manifest; they do not generalize beyond them without more studies.", "- Comparisons marked *exploratory* were not pre-registered. Treat them as leads.", "- Every deviation from PROTOCOL.md must be listed in DEVIATIONS.md next to this report.", "");
  return L.join("\n");
}

export function main(argv) {
  const { values: o, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: "string" }, json: { type: "boolean" }, boot: { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (o.help || !positionals.length) return console.log("usage: node study/runner/report.mjs <results-dir> [more results dirs to pool] [--out report.md] [--json]"), o.help ? 0 : 2;
  const data = loadResults(positionals);
  const a = analyze(data, { B: o.boot ? Number(o.boot) : 10000, seed: 1 });
  const md = render(a, data.studies);
  const out = o.out ?? (positionals.length === 1 ? path.join(positionals[0], "report.md") : null);
  if (out) fs.writeFileSync(out, md);
  if (o.json) {
    const strip = ({ perTask, ...rest }) => rest;
    fs.writeFileSync((out ?? "summary").replace(/\.md$/, "") + ".summary.json", JSON.stringify({ ...a, perCond: Object.fromEntries(Object.entries(a.perCond).map(([k, v]) => [k, strip(v)])) }, null, 2) + "\n");
  }
  console.log(md);
  if (out) console.error(`written to ${out}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`error ${e.message}`);
    process.exit(2);
  }
}
