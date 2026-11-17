#!/usr/bin/env node
// Validates every task BEFORE any agent runs: its check must FAIL on the untouched code and PASS once the
// reference patch (reference/<task-id>.patch, a unified diff) is applied. A check that cannot do both measures nothing.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { loadStudy, prepareTrial, resolveTasks, stampFile, studyFingerprint, StudyError } from "./lib.mjs";

// Same shell semantics as `gearness eval` (/bin/sh on POSIX, cmd.exe on Windows). Never assume `sh` exists.
const sh = (cmd, cwd, seconds) => {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", timeout: seconds * 1000, env: process.env, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.error ? 127 : r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}` };
};

export async function main(argv) {
  const { values: o, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { strict: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
  if (o.help || !positionals[0]) return console.log("usage: node study/runner/validate.mjs <study.yaml> [--strict]\n  --strict   a task without a reference patch fails validation"), o.help ? 0 : 2;
  const study = loadStudy(positionals[0]);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "study-validate-"));
  try {
    const tasks = resolveTasks(study, path.join(work, "tasks"));
    const trial = prepareTrial(study, "validate", { strip: true, overlay: undefined }, work, path.join(work, "tasks"));
    let failed = 0, unproven = 0;
    console.log(`Validating ${tasks.length} task(s) against ${study.target.path ?? study.target.repo} @ ${trial.codeCommit.slice(0, 12)}\n`);
    for (const t of tasks) {
      const patch = path.join(study.referenceDir, `${t.id}.patch`);
      const seconds = t.timeoutSeconds ?? study.timeoutSeconds ?? 900;
      const dir = path.join(work, `ws-${t.id}`);
      fs.cpSync(trial.repo, dir, { recursive: true });
      const problems = [];
      if (t.setup) {
        const s = sh(t.setup, dir, seconds);
        if (s.status !== 0) problems.push(`setup failed: ${s.out.slice(-300)}`);
      }
      if (!problems.length) {
        if (sh(t.check, dir, seconds).status === 0) problems.push("check PASSES on the untouched code (it measures nothing)");
        if (!fs.existsSync(patch)) {
          unproven++;
          if (o.strict) problems.push(`no reference patch at ${path.relative(process.cwd(), patch)}`);
          else console.log(`  ! ${t.id}: check fails on base code, but there is no reference patch to prove it can pass`);
        } else {
          const a = spawnSync("git", ["apply", "--whitespace=nowarn", "--ignore-whitespace", patch], { cwd: dir, encoding: "utf8" });
          if (a.status !== 0) problems.push(`reference patch does not apply: ${a.stderr.trim().slice(0, 300)}`);
          else {
            const c = sh(t.check, dir, seconds);
            if (c.status !== 0) problems.push(`check FAILS with the reference patch applied: ${c.out.slice(-300).trim()}`);
          }
        }
      }
      if (problems.length) {
        failed++;
        console.log(`  ✗ ${t.id}`);
        for (const p of problems) console.log(`      ${p}`);
      } else if (fs.existsSync(patch)) console.log(`  ✓ ${t.id}: fails on base code, passes with the reference patch`);
    }
    if (failed) console.log(`\n${failed} task(s) invalid. Fix them before running the study.`);
    else if (unproven) console.log(`\nNo task failed, but ${unproven} have no reference patch, so nothing was recorded. Run with --strict: run.mjs only measures validated studies.`);
    else {
      fs.mkdirSync(study.workDir, { recursive: true });
      fs.writeFileSync(stampFile(study), JSON.stringify({ study: study.id, codeCommit: trial.codeCommit, fingerprint: studyFingerprint(study, trial.codeCommit), validatedAt: new Date().toISOString(), tasks: tasks.map((t) => t.id) }, null, 2) + "\n");
      console.log("\nAll tasks valid. Validation recorded: run.mjs will now accept this study.");
    }
    return failed ? 1 : 0;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
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
