#!/usr/bin/env node
// Runs every study in a directory: validate each task, drop the ones that fail validation (reported, never hidden),
// optionally measure the rest, then write one pooled report. Built for mine.mjs output (one study per task).
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { StudyError } from "./lib.mjs";
import { main as validate } from "./validate.mjs";
import { main as run } from "./run.mjs";
import { main as report } from "./report.mjs";

export async function main(argv) {
  const { values: o, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { yes: { type: "boolean" }, runs: { type: "string" }, gearness: { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (o.help || !positionals[0]) return console.log("usage: node study/runner/batch.mjs <dir of studies> [--yes] [--runs n] [--gearness cli.js]\n  without --yes: validates and shows the plan, nothing is sent to the agent"), o.help ? 0 : 2;
  const root = path.resolve(positionals[0]);
  const studies = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "study.yaml"))).map((e) => path.join(root, e.name, "study.yaml")).sort();
  if (!studies.length) throw new StudyError(`no study.yaml found under ${root}`);
  const valid = [], dropped = [];
  for (const f of studies) {
    console.log(`\n=== validating ${path.basename(path.dirname(f))} ===`);
    ((await validate([f, "--strict"])) === 0 ? valid : dropped).push(f);
  }
  for (const f of dropped) console.log(`excluded (failed validation): ${path.basename(path.dirname(f))}`);
  if (!valid.length) throw new StudyError("no task passed validation, nothing to run");
  const extra = [...(o.runs ? ["--runs", o.runs] : []), ...(o.gearness ? ["--gearness", o.gearness] : [])];
  for (const f of valid) {
    console.log(`\n=== ${o.yes ? "measuring" : "plan for"} ${path.basename(path.dirname(f))} ===`);
    const code = await run([f, ...extra, ...(o.yes ? ["--yes"] : [])]);
    if (code !== 0) throw new StudyError(`run failed for ${f}`);
  }
  if (!o.yes) { console.log(`\n${valid.length} validated, ${dropped.length} excluded. Re-run with --yes to measure (this uses your plan or API credits).`); return 0; }
  const dirs = valid.map((f) => path.join(path.dirname(f), "results")).filter((d) => fs.existsSync(path.join(d, "raw")));
  const out = path.join(root, "report.md");
  report([...dirs, "--out", out]);
  console.log(`\nPooled report: ${out}  (${valid.length} tasks measured, ${dropped.length} excluded by validation)`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e instanceof StudyError ? `error ${e.message}` : e); process.exit(e instanceof StudyError ? 2 : 1); });
}
