import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findCandidates, promptFrom } from "../mine.mjs";
import { CLI, node, READY, RUNNER } from "./fixture.mjs";

const opts = { skip: READY ? false : "needs dist/cli.js (run `npm run build`), git and tar" };
const TEST_CMD = "node test/add.test.mjs && node test/mul.test.mjs";

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mine repo-"));
  const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", ...a], { cwd: dir });
  const put = (f, c) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); };
  const commit = (msg) => { git("add", "-A"); git("commit", "-qm", msg); };
  git("init", "-q");
  put("add.mjs", "export const add = (a, b) => a - b;\n");
  put("mul.mjs", "export const mul = (a, b) => a * b;\n");
  put("test/mul.test.mjs", 'import { mul } from "../mul.mjs";\nprocess.exit(mul(2, 3) === 6 ? 0 : 1);\n');
  put("test/add.test.mjs", "process.exit(0);\n"); // placeholder so the suite command exists before the fix
  commit("init"); // root commit: no parent, never a task
  put("README.md", "# calc\n"); put("AGENTS.md", "# calc\n\nNever use floats.\n");
  commit("docs: readme and agent notes"); // touches no tests
  put("add.mjs", "export const add = (a, b) => a + b;\n");
  put("test/add.test.mjs", 'import { add } from "../add.mjs";\nprocess.exit(add(2, 3) === 5 ? 0 : 1);\n');
  commit("fix: add() subtracts instead of adding\n\nadd(2, 3) returned -1.\n\nSigned-off-by: Someone <s@x.io>\nhttps://example.com/issues/1");
  put("mul.mjs", "export const mul = (a, b) => a * b; // renamed nothing\n");
  commit("refactor: comment"); // source without tests
  for (let i = 0; i < 9; i++) put(`gen/g${i}.mjs`, `export const g${i} = ${i};\n`);
  put("test/big.test.mjs", "process.exit(0);\n");
  commit("chore: generate lots of files"); // too many files
  return dir;
}

test("findCandidates keeps only commits that change source and tests together, within size limits", () => {
  const r = repo();
  const { candidates, skipped } = findCandidates(r);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.match(c.subject, /^fix: add\(\)/);
  assert.equal(c.fixish, true);
  assert.deepEqual(c.tests, ["test/add.test.mjs"]);
  assert.deepEqual(c.source, ["add.mjs"]);
  assert.equal(skipped.noTests >= 2 && skipped.tooBig === 1, true, JSON.stringify(skipped));
});

test("commits whose parent had no agent instruction file are skipped unless asked for", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mine repo-"));
  const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", ...a], { cwd: dir });
  const put = (f, c) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); };
  git("init", "-q");
  put("a.mjs", "1\n"); put("test/a.test.mjs", "0\n"); git("add", "-A"); git("commit", "-qm", "init");
  put("a.mjs", "2\n"); put("test/a.test.mjs", "1\n"); git("add", "-A"); git("commit", "-qm", "fix: a");
  assert.equal(findCandidates(dir).candidates.length, 0);
  assert.equal(findCandidates(dir).skipped.noHarness, 1);
  assert.equal(findCandidates(dir, { requireHarness: false }).candidates.length, 1);
});

test("promptFrom drops trailers and bare links, keeps the description, and is bounded", () => {
  const p = promptFrom("fix: rounding\n\nTotals were off by one cent.\n\nSigned-off-by: A <a@b.c>\nCo-authored-by: B <b@c.d>\nhttps://example.com/x\n");
  assert.match(p, /Totals were off by one cent/);
  assert.ok(!/Signed-off|Co-authored|example\.com/.test(p));
  assert.ok(promptFrom("x".repeat(5000)).length < 1700);
});

test("volunteer flow end to end: mine, validate, measure with a fake agent, pooled report", opts, () => {
  const r = repo();
  const out = path.join(r, "..", `mined ${path.basename(r)}`);
  const agent = path.join(out, "fake-agent.mjs");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(agent, 'import fs from "node:fs";\nif (fs.existsSync("AGENTS.md")) fs.writeFileSync("add.mjs", "export const add = (a, b) => a + b;\\n"); // the harness is what makes it succeed\n');
  const mine = node(path.join(RUNNER, "mine.mjs"), ["--repo", r, "--test", TEST_CMD, "--count", "3", "--out", out, "--runs", "1", "--agent", `node "${agent}" --prompt-env GEARNESS_PROMPT`]);
  assert.equal(mine.status, 0, mine.stdout + mine.stderr);
  assert.match(mine.stdout, /Built 1 study/);
  assert.match(mine.stdout, /fix: add\(\) subtracts/);

  const sdir = path.join(out, "vol-1");
  const study = fs.readFileSync(path.join(sdir, "study.yaml"), "utf8");
  const parent = spawnSync("git", ["rev-parse", "HEAD~3"], { cwd: r, encoding: "utf8" }).stdout.trim();
  assert.ok(study.includes(parent), "code is pinned to the PARENT of the fix commit");
  assert.ok(fs.readFileSync(path.join(sdir, "hidden/files/test/add.test.mjs"), "utf8").includes("add(2, 3) === 5"), "the hidden check restores the commit's test");
  const task = fs.readFileSync(path.join(sdir, "tasks/vol-1.yaml"), "utf8");
  assert.ok(task.includes("add(2, 3) returned -1") && !task.includes("Signed-off"));
  assert.ok(!fs.readFileSync(path.join(sdir, "reference/vol-1.patch"), "utf8").includes("test/"), "the reference patch holds no tests");

  const batch = node(path.join(RUNNER, "batch.mjs"), [out, "--yes", "--gearness", CLI]);
  assert.equal(batch.status, 0, batch.stdout + batch.stderr);
  assert.match(batch.stdout, /Pooled report/);
  const md = fs.readFileSync(path.join(out, "report.md"), "utf8");
  assert.match(md, /\| full \| \*\*100%\*\*/);
  assert.match(md, /\| minimal \| \*\*100%\*\*/);
  assert.match(md, /\| none \| \*\*0%\*\*/);
});

test("batch without --yes validates and plans but never calls the agent", opts, () => {
  const r = repo();
  const out = path.join(r, "..", `mined ${path.basename(r)}`);
  assert.equal(node(path.join(RUNNER, "mine.mjs"), ["--repo", r, "--test", TEST_CMD, "--out", out]).status, 0);
  const b = node(path.join(RUNNER, "batch.mjs"), [out, "--gearness", CLI]);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.match(b.stdout, /1 validated, 0 excluded/);
  assert.ok(!fs.existsSync(path.join(out, "vol-1/results/raw")), "nothing was measured");
});

test("a task that fails validation is excluded and reported, not silently run", opts, () => {
  const r = repo();
  const out = path.join(r, "..", `mined ${path.basename(r)}`);
  assert.equal(node(path.join(RUNNER, "mine.mjs"), ["--repo", r, "--test", "node -e \"process.exit(0)\"", "--out", out]).status, 0);
  const b = node(path.join(RUNNER, "batch.mjs"), [out, "--gearness", CLI]);
  assert.notEqual(b.status, 0);
  assert.match(b.stdout, /excluded \(failed validation\): vol-1/);
  assert.match(b.stdout + b.stderr, /PASSES on the untouched code/);
});

test("mine explains when no commit qualifies", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mine repo-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const m = node(path.join(RUNNER, "mine.mjs"), ["--repo", dir, "--test", "npm test"]);
  assert.equal(m.status, 2); // an empty repository has no history at all
  assert.match(m.stderr, /git .*failed|No usable commits/);
});
