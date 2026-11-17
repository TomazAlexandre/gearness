#!/usr/bin/env node
// Runs a study: for every round, for every condition (in a shuffled order), one `gearness eval` pass.
// Interleaving conditions means model or API drift over the hours a study takes cannot favour one condition.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { DEFAULT_GEARNESS, KIT_VERSION, git, loadStudy, doctorScore, prepareTrial, protocolState, resolveTasks, shuffled, spawnBin, stampFile, studyFingerprint, StudyError } from "./lib.mjs";
import { rng as makeRng } from "./stats.mjs";

const USAGE = `usage: node study/runner/run.mjs <study.yaml> [options]
  --conditions a,b   run only these conditions (default: all)
  --runs <n>         rounds to run, overriding study.yaml (use for pilots; the protocol asks for >= 5 in a real study)
  --gearness <cli>   path to gearness cli.js (default: ../../dist/cli.js)
  --yes              actually call the agent (without it: prepare, print the plan, stop)
  --resume           continue a previous run, skipping rounds already saved
  --force            overwrite saved results (see PROTOCOL.md: pilots get a new study id instead)
  --allow-dirty-protocol   run even if PROTOCOL.md has uncommitted changes
  --skip-validation  measure without a recorded validation (the protocol forbids this for a real study)`;

function evalRound(gearness, trial, study, condition, metrics) {
  const args = [gearness, "eval", "--json", "--runs", "1", "--parallel", String(study.parallel), "--agent", study.agent];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: trial.repo,
      env: { ...process.env, STUDY_CONDITION: condition, STUDY_METRICS: metrics },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new StudyError(`gearness eval produced no JSON for "${condition}" (exit ${code}): ${out.slice(-500)}`));
      }
    });
  });
}

function agentVersion() {
  const r = spawnBin(process.env.STUDY_CLAUDE_BIN || "claude", ["--version"]);
  return r.status === 0 ? String(r.stdout).trim() : null;
}

export async function main(argv) {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      conditions: { type: "string" },
      runs: { type: "string" },
      gearness: { type: "string" },
      yes: { type: "boolean" },
      resume: { type: "boolean" },
      force: { type: "boolean" },
      "allow-dirty-protocol": { type: "boolean" },
      "skip-validation": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (o.help || !positionals[0]) return console.log(USAGE), o.help ? 0 : 2;
  const study = loadStudy(positionals[0]);
  if (o.runs !== undefined) {
    if (!/^[1-9][0-9]*$/.test(o.runs)) throw new StudyError("--runs must be a positive integer");
    study.runs = Number(o.runs);
  }
  const gearness = path.resolve(o.gearness ?? DEFAULT_GEARNESS);
  if (!fs.existsSync(gearness)) throw new StudyError(`gearness CLI not found at ${gearness} (run \`npm run build\` or pass --gearness)`);
  const names = o.conditions ? o.conditions.split(",").map((s) => s.trim()) : Object.keys(study.conditions);
  for (const n of names) if (!study.conditions[n]) throw new StudyError(`unknown condition "${n}" (have: ${Object.keys(study.conditions).join(", ")})`);

  const proto = protocolState(study);
  if (proto?.dirty && !o["allow-dirty-protocol"] && o.yes) throw new StudyError(`${proto.file} has uncommitted changes: commit the protocol BEFORE measuring (or pass --allow-dirty-protocol)`);

  const rawDir = path.join(study.resultsDir, "raw");
  const rawFile = (n) => path.join(rawDir, `${n}.json`);
  const existing = names.filter((n) => fs.existsSync(rawFile(n)));
  if (o.yes && existing.length && !o.resume && !o.force)
    throw new StudyError(`results already exist for: ${existing.join(", ")}. Use --resume to continue, or start a new study id. Re-running until the number looks good is what the protocol forbids.`);

  const tasks = resolveTasks(study, path.join(study.workDir, "tasks-resolved"));
  console.error(`Preparing ${names.length} trial repositories (history removed, agent files stripped)...`);
  const trials = {};
  for (const n of names) {
    trials[n] = prepareTrial(study, n, study.conditions[n], study.workDir, path.join(study.workDir, "tasks-resolved"));
    trials[n].doctorScore = doctorScore(trials[n].repo, gearness);
  }

  const codeCommit = Object.values(trials)[0].codeCommit;
  const fingerprint = studyFingerprint(study, codeCommit);
  const stamp = fs.existsSync(stampFile(study)) ? JSON.parse(fs.readFileSync(stampFile(study), "utf8")) : null;
  const validated = stamp?.fingerprint === fingerprint;
  const jobs = names.length * tasks.length * study.runs;
  console.log(`\nStudy ${study.id}: ${names.length} conditions × ${tasks.length} tasks × ${study.runs} runs = ${jobs} agent runs`);
  for (const n of names) console.log(`  ${n.padEnd(10)} score ${String(trials[n].doctorScore ?? "n/a").padStart(3)}   removed ${trials[n].removed.length} agent files, overlay ${trials[n].overlayFiles.length} files   repo files ${trials[n].harnessFiles}   ${trials[n].repo}`);
  console.log(`Agent: ${study.agent}`);
  console.log(`Code: ${codeCommit.slice(0, 12)}   Tasks validated against this exact commit and files: ${validated ? "yes" : "NO"}`);
  if (!o.yes) {
    console.log(`\nDry run: nothing was sent to the agent. This will cost real money (${jobs} runs). Re-run with --yes when ready.`);
    return 0;
  }

  if (!validated && !o["skip-validation"])
    throw new StudyError(`these tasks have not been validated against ${codeCommit.slice(0, 12)} (or a task, hidden check or reference patch changed since).\n  Run: node study/runner/validate.mjs ${path.relative(process.cwd(), study.file)} --strict\n  It proves every check fails on the untouched code and passes with its reference patch, before any money is spent.`);

  fs.mkdirSync(rawDir, { recursive: true });
  const metrics = path.join(study.resultsDir, "metrics.jsonl");
  const manifestFile = path.join(study.resultsDir, "manifest.json");
  const gv = JSON.parse(fs.readFileSync(path.resolve(path.dirname(gearness), "../package.json"), "utf8"));
  const prev = o.resume && fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : null;
  const manifest = {
    kit: KIT_VERSION,
    study: study.id,
    startedAt: prev?.startedAt ?? new Date().toISOString(),
    gearness: gv.version,
    // the version string only changes on release, so also record the exact commit (and whether it was modified):
    // scores computed before and after a change to the scoring formula must be told apart
    gearnessCommit: (() => { const root = path.resolve(path.dirname(gearness), ".."); const h = git(root, ["rev-parse", "HEAD"]); return h.ok ? { sha: h.out, dirty: git(root, ["status", "--porcelain", "--", "src", "package.json"]).out !== "" } : null; })(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    agent: study.agent,
    agentVersion: agentVersion(),
    runs: study.runs,
    seed: study.seed,
    protocol: proto,
    validation: validated ? { fingerprint, validatedAt: stamp.validatedAt } : { skipped: true },
    target: { source: study.target.path ?? study.target.repo, commit: Object.values(trials)[0].codeCommit, exclude: study.target.exclude },
    conditions: Object.fromEntries(names.map((n) => [n, { strip: study.conditions[n].strip, overlayFiles: trials[n].overlayFiles, removedFiles: trials[n].removed.length, doctorScore: trials[n].doctorScore, trialCommit: trials[n].trialCommit }])),
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");

  const raw = Object.fromEntries(
    names.map((n) => [n, o.resume && fs.existsSync(rawFile(n)) ? JSON.parse(fs.readFileSync(rawFile(n), "utf8")) : { study: study.id, condition: n, doctorScore: trials[n].doctorScore, codeCommit: trials[n].codeCommit, rounds: {} }]),
  );
  const rand = makeRng(study.seed);
  for (let r = 1; r <= study.runs; r++) {
    const order = shuffled(names, rand); // always drawn, so a resumed run keeps the same order
    for (const n of order) {
      if (raw[n].rounds[r]) continue;
      console.error(`\n=== round ${r}/${study.runs} · ${n} ===`);
      raw[n].rounds[r] = await evalRound(gearness, trials[n], study, n, metrics);
      fs.writeFileSync(rawFile(n), JSON.stringify(raw[n], null, 2) + "\n");
    }
  }
  console.log(`\nDone. Results in ${path.relative(process.cwd(), study.resultsDir)}\nNext: node study/runner/report.mjs ${path.relative(process.cwd(), study.resultsDir)}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e instanceof StudyError ? `error ${e.message}` : e);
      process.exit(e instanceof StudyError ? 2 : 1);
    },
  );
}
