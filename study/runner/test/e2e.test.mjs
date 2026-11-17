import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildStudy, CLI, node, READY, RUNNER } from "./fixture.mjs";

const opts = { skip: READY ? false : "needs dist/cli.js (run `npm run build`), git and tar" };
const run = (args) => node(path.join(RUNNER, "run.mjs"), args, { env: { ...process.env, NO_COLOR: "1" } });
const validate = (s, extra = []) => node(path.join(RUNNER, "validate.mjs"), [s.studyFile, "--strict", ...extra]);
const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

test("study pipeline end to end: isolation, measurement, report, resume and refusal to overwrite", opts, () => {
  const s = buildStudy({ runs: 2 });
  const results = path.join(s.study, "results");

  // 1. without --yes nothing reaches the agent
  const dry = run([s.studyFile, "--gearness", CLI]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /2 conditions × 2 tasks × 2 runs = 8 agent runs/);
  assert.match(dry.stdout, /Dry run/);
  assert.match(dry.stdout, /validated against this exact commit and files: NO/);
  assert.match(dry.stdout, /repo files \d+/, "the plan shows how many files each trial repository has");
  assert.ok(!fs.existsSync(path.join(results, "raw")));
  assert.ok(s.study.includes(" "), "the fixture must live in a path with a space (Windows users have them)");
  assert.match(run([s.studyFile, "--gearness", CLI, "--runs", "1"]).stdout, /2 conditions × 2 tasks × 1 runs = 4 agent runs/, "--runs overrides study.yaml");
  assert.equal(run([s.studyFile, "--gearness", CLI, "--runs", "0"]).status, 2);

  // 2. trial repositories are isolated from the answer and from the legacy harness
  const noneRepo = path.join(s.study, ".work/trials/none/repo"), fullRepo = path.join(s.study, ".work/trials/full/repo");
  assert.equal(git(noneRepo, ["rev-list", "--count", "HEAD"]), "1", "no history: the solution commit must be unreachable");
  assert.equal(git(noneRepo, ["log", "--all", "--format=%s"]).includes("secret solution"), false);
  assert.equal(fs.readFileSync(path.join(noneRepo, "add.mjs"), "utf8").includes("a - b"), true, "pinned to the buggy commit");
  for (const gone of ["CLAUDE.md", ".claude", "docs/guide/AGENTS.md", "AGENTS.md"]) assert.equal(fs.existsSync(path.join(noneRepo, gone)), false, `${gone} should be stripped from "none"`);
  assert.equal(fs.existsSync(path.join(fullRepo, "AGENTS.md")), true, "overlay applied");
  assert.equal(fs.existsSync(path.join(fullRepo, "CLAUDE.md")), false);
  for (const repo of [noneRepo, fullRepo]) {
    assert.equal(git(repo, ["ls-files"]).includes(".study-tasks"), false, "tasks are never tracked, so never in the agent's worktree");
    assert.equal(fs.readFileSync(path.join(repo, "harness.yaml"), "utf8").includes(s.study + "/hidden"), false, "hidden path must not appear in harness.yaml");
  }

  // 3. money is only spent on validated tasks
  const refused = run([s.studyFile, "--gearness", CLI, "--yes"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /have not been validated/);
  assert.ok(!fs.existsSync(path.join(results, "raw")), "nothing was measured");
  const v = validate(s);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /Validation recorded/);
  assert.match(run([s.studyFile, "--gearness", CLI]).stdout, /validated against this exact commit and files: yes/);

  // 4. real run
  const go = run([s.studyFile, "--gearness", CLI, "--yes"]);
  assert.equal(go.status, 0, go.stderr + go.stdout);
  const none = JSON.parse(fs.readFileSync(path.join(results, "raw/none.json"), "utf8"));
  const full = JSON.parse(fs.readFileSync(path.join(results, "raw/full.json"), "utf8"));
  assert.deepEqual(Object.keys(full.rounds), ["1", "2"]);
  const flat = (raw) => Object.values(raw.rounds).flatMap((r) => r.runs);
  assert.equal(flat(none).filter((r) => r.passed).length, 0, "no harness: the fake agent does nothing");
  assert.equal(flat(full).filter((r) => r.passed).length, 4, "with a harness: every run passes");
  const manifest = JSON.parse(fs.readFileSync(path.join(results, "manifest.json"), "utf8"));
  assert.equal(manifest.target.commit, s.base);
  assert.deepEqual(Object.keys(manifest.conditions).sort(), ["full", "none"]);
  assert.ok(manifest.gearness && manifest.node && manifest.seed === 7);
  assert.ok(manifest.validation.fingerprint, "the manifest records what was validated");
  assert.ok("gearnessCommit" in manifest, "the manifest says which gearness commit computed the scores");

  // 5. refuses to overwrite, resumes cleanly
  const again = run([s.studyFile, "--gearness", CLI, "--yes"]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /already exist/);
  const resumed = run([s.studyFile, "--gearness", CLI, "--yes", "--resume"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(results, "raw/full.json"), "utf8")).rounds), ["1", "2"], "resume re-runs nothing");

  // 6. report
  const rep = node(path.join(RUNNER, "report.mjs"), [results, "--boot", "1000"]);
  assert.equal(rep.status, 0, rep.stderr);
  assert.match(rep.stdout, /\| full \| \*\*100%\*\*/);
  assert.match(rep.stdout, /\| none \| \*\*0%\*\*/);
  assert.match(rep.stdout, /full vs none \| \+100 pp/);
  assert.match(rep.stdout, /full better/);
  assert.ok(fs.existsSync(path.join(results, "report.md")));
});

test("validate: passes with correct reference patches, fails on a bad patch or a check that passes on base code", opts, () => {
  const s = buildStudy();
  const v = path.join(RUNNER, "validate.mjs");
  const ok = node(v, [s.studyFile, "--strict"]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /✓ fix-add: fails on base code, passes with the reference patch/);

  fs.writeFileSync(path.join(s.study, "reference/fix-mul.patch"), "--- a/mul.mjs\n+++ b/mul.mjs\n@@ -1 +1 @@\n-export const mul = (a, b) => a + b;\n+export const mul = (a, b) => a - b;\n");
  const bad = node(v, [s.studyFile]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /✗ fix-mul[\s\S]*FAILS with the reference patch/);

  fs.writeFileSync(path.join(s.study, "hidden/fix-mul.mjs"), "process.exit(0);\n");
  const vacuous = node(v, [s.studyFile]);
  assert.equal(vacuous.status, 1);
  assert.match(vacuous.stdout, /PASSES on the untouched code/);

  fs.rmSync(path.join(s.study, "reference/fix-add.patch"));
  fs.writeFileSync(path.join(s.study, "hidden/fix-mul.mjs"), "process.exit(1);\n");
  const missing = node(v, [s.studyFile, "--strict"]);
  assert.match(missing.stdout, /no reference patch/);
});

test("run.mjs refuses to measure while PROTOCOL.md has uncommitted changes", opts, () => {
  const s = buildStudy();
  const proto = path.join(s.study, "PROTOCOL.md");
  fs.writeFileSync(proto, "v1\n");
  for (const a of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-qm", "protocol"]]) spawnSync("git", a, { cwd: s.study });
  fs.appendFileSync(s.studyFile, "protocol: PROTOCOL.md\n");
  fs.appendFileSync(proto, "edited after freezing\n");
  const r = run([s.studyFile, "--gearness", CLI, "--yes"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /uncommitted changes/);
  assert.ok(!fs.existsSync(path.join(s.study, "results/raw")));
});

test("the real wrapper under gearness eval: prompt via env, cost recorded, cost shown in the report", opts, () => {
  const s = buildStudy({ runs: 1, wrapper: true });
  assert.equal(validate(s).status, 0);
  const env = { ...process.env, NO_COLOR: "1", STUDY_CLAUDE_BIN: s.fakeClaude, STUDY_PROMPT_VIA: "arg" };
  // started from a directory that looks like a harnessed repo: a misbehaving fake would write add.mjs/mul.mjs here
  const sentinel = fs.mkdtempSync(path.join(path.dirname(s.root), "sentinel-"));
  fs.writeFileSync(path.join(sentinel, "AGENTS.md"), "x\n");
  const go = node(path.join(RUNNER, "run.mjs"), [s.studyFile, "--gearness", CLI, "--yes"], { env, cwd: sentinel });
  assert.deepEqual(fs.readdirSync(sentinel), ["AGENTS.md"], "run.mjs and its `claude --version` call must not write into the caller's directory");
  assert.equal(go.status, 0, go.stderr + go.stdout);
  const metrics = fs.readFileSync(path.join(s.study, "results/metrics.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(metrics.length, 4, "2 conditions x 2 tasks x 1 round");
  assert.deepEqual([...new Set(metrics.map((m) => m.condition))].sort(), ["full", "none"]);
  assert.ok(metrics.every((m) => m.costUsd === 0.5 && m.turns === 4 && m.task));
  const rep = node(path.join(RUNNER, "report.mjs"), [path.join(s.study, "results"), "--boot", "500"]);
  assert.match(rep.stdout, /\| full \| \*\*100%\*\*.*\$0\.50/);
  assert.match(rep.stdout, /\| none \| \*\*0%\*\*.*\$0\.50/);
});

test("a validation stamp is bound to the exact commit, tasks, hidden checks and patches", opts, () => {
  const s = buildStudy({ runs: 1 });
  assert.equal(validate(s).status, 0);
  const stamp = path.join(s.study, ".work/validated.json");
  assert.ok(fs.existsSync(stamp));
  const plan = () => run([s.studyFile, "--gearness", CLI]).stdout;
  assert.match(plan(), /files: yes/);

  fs.appendFileSync(path.join(s.study, "hidden/fix-add.mjs"), "// edited after validation\n");
  assert.match(plan(), /files: NO/, "editing a hidden check invalidates the stamp");
  const refused = run([s.studyFile, "--gearness", CLI, "--yes"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /changed since/);

  const skip = run([s.studyFile, "--gearness", CLI, "--yes", "--skip-validation"]);
  assert.equal(skip.status, 0, skip.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.study, "results/manifest.json"), "utf8")).validation, { skipped: true }, "a skipped validation is on the record");
});

test("a target without the code the tasks need is caught by validation, before any run", opts, () => {
  const s = buildStudy({ runs: 1 });
  // the real-world mistake: the pinned commit is missing the files the reference patch edits
  spawnSync("git", ["rm", "-q", "add.mjs"], { cwd: s.target });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-qm", "oops"], { cwd: s.target });
  fs.writeFileSync(s.studyFile, fs.readFileSync(s.studyFile, "utf8").replace(/commit: \w+/, "commit: HEAD"));
  const v = validate(s);
  assert.equal(v.status, 1);
  assert.match(v.stdout, /reference patch does not apply/);
  assert.ok(!fs.existsSync(path.join(s.study, ".work/validated.json")), "no stamp for an invalid study");
  assert.equal(run([s.studyFile, "--gearness", CLI, "--yes"]).status, 2);
});
