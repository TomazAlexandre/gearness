#!/usr/bin/env node
// Volunteer mode: builds ready-to-run studies from a repository's OWN history, so nobody has to write tasks by hand.
// A commit that changed source AND tests becomes one task:
//   code      = the commit's parent
//   prompt    = the commit message
//   check     = the tests the commit touched, restored from the commit (the agent never sees them) + your test command
//   reference = the commit's non-test diff (proves the task can be solved)
// Conditions: none (everything that instructs an agent stripped), minimal (one line: how to test) and
// full (the repository's OWN harness as it was at the parent commit). One study per task, because each task has its own base commit.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { StudyError } from "./lib.mjs";

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]*\.py$|Tests?\.(java|kt|cs)$/i;
const NOISE_PATH = /(^|\/)(docs?|node_modules|vendor|dist|build)\/|\.(md|mdx|txt|rst|lock|svg|png|jpe?g|gif|ico)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|CHANGELOG[^/]*)$/i;
const HARNESS = /^(AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.cursorrules|\.windsurfrules|\.github\/copilot-instructions\.md|\.cursor\/rules\/.+)$/;
const FIXISH = /\b(fix(es|ed)?|bug|regress(ion)?|crash|wrong|incorrect|broken|error|fail(s|ed|ure)?)\b/i;

const USAGE = `usage: node study/runner/mine.mjs --test "<test command>" [options]
  --repo <path>        repository to mine (default: current directory)
  --test "<cmd>"       command that runs the tests, e.g. "npm test" (required)
  --setup "<cmd>"      command that installs dependencies, e.g. "npm ci"
  --count <n>          tasks to build (default 5)
  --out <dir>          where to write the studies (default: study/studies/volunteer)
  --id <prefix>        study id prefix (default: vol)
  --runs <n>           rounds per condition (default 3)
  --scan <n>           how many recent commits to look at (default 400)
  --max-files <n>      skip commits touching more files (default 8)
  --max-lines <n>      skip commits with a larger source diff (default 300)
  --agent "<cmd>"      agent command (default: Claude Code through the cost-recording wrapper)
  --any-commit         also use commits whose parent had no agent instruction file (the "full" condition then equals "none")`;

const raw = (cwd, args) => spawnSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
const text = (cwd, args) => {
  const r = raw(cwd, args);
  if (r.status !== 0) throw new StudyError(`git ${args.join(" ")} failed: ${String(r.stderr).trim()}`);
  return r.stdout.toString("utf8");
};

/** Scans recent history for commits that changed source and tests together. Pure git, no model. */
export function findCandidates(repo, o = {}) {
  const { scan = 400, maxFiles = 8, maxLines = 300, requireHarness = true } = o;
  const skipped = { noTests: 0, noSource: 0, tooBig: 0, noHarness: 0 };
  const found = [];
  for (const line of text(repo, ["log", "--no-merges", "--format=%H%x09%P%x09%s", "-n", String(scan)]).split("\n").filter(Boolean)) {
    const [sha, parents, subject] = line.split("\t");
    if (!parents || parents.includes(" ")) continue;
    const changes = text(repo, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-M", sha]).split("\n").filter(Boolean).map((l) => {
      const p = l.split("\t");
      return { status: p[0][0], file: p[p.length - 1] };
    }).filter((c) => c.status !== "D");
    const tests = changes.filter((c) => TEST_PATH.test(c.file)).map((c) => c.file);
    const source = changes.filter((c) => !TEST_PATH.test(c.file) && !NOISE_PATH.test(c.file)).map((c) => c.file);
    if (!tests.length) { skipped.noTests++; continue; }
    if (!source.length) { skipped.noSource++; continue; }
    if (changes.length > maxFiles) { skipped.tooBig++; continue; }
    const stat = text(repo, ["diff", "--numstat", parents, sha, "--", ...source]).split("\n").filter(Boolean).map((l) => l.split("\t"));
    if (stat.some((s) => s[0] === "-") || stat.reduce((n, s) => n + Number(s[0]) + Number(s[1]), 0) > maxLines) { skipped.tooBig++; continue; }
    if (requireHarness && !text(repo, ["ls-tree", "-r", "--name-only", parents]).split("\n").some((f) => HARNESS.test(f))) { skipped.noHarness++; continue; }
    found.push({ sha, parent: parents, subject, tests, source, fixish: FIXISH.test(subject) });
  }
  // fixes first (the clearest tasks), then newest first as git log already orders them
  return { candidates: [...found.filter((c) => c.fixish), ...found.filter((c) => !c.fixish)], skipped };
}

/** The commit message as a task prompt: no trailers, no bare links, bounded. Review it for solution hints. */
export function promptFrom(message) {
  const body = message.split("\n").filter((l) => !/^(signed-off-by|co-authored-by|reviewed-by|change-id|cc):/i.test(l.trim()) && !/^\s*https?:\/\/\S+\s*$/.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 1500);
  return `Make the change described below in this repository. The existing tests must keep passing.\n\n${body}\n`;
}

const checkScript = (testCmd) => `// Generated by mine.mjs. Runs with the agent's worktree as the current directory.
// Restores the tests of the original commit (the agent never saw them), then runs the test command.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "files");
const restore = (rel) => {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) restore(r);
    else {
      fs.mkdirSync(path.dirname(path.join(process.cwd(), r)), { recursive: true });
      fs.copyFileSync(path.join(root, r), path.join(process.cwd(), r));
    }
  }
};
restore("");
process.exit(spawnSync(${JSON.stringify(testCmd)}, { shell: true, stdio: "inherit" }).status ?? 1);
`;

export function buildStudy(repo, c, i, opt) {
  const id = `${opt.prefix}-${i + 1}`;
  const dir = path.join(opt.out, id);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const d of ["tasks", "hidden/files", "reference", "conditions/minimal"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  for (const f of c.tests) {
    const dst = path.join(dir, "hidden/files", f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, raw(repo, ["show", `${c.sha}:${f}`]).stdout);
  }
  fs.writeFileSync(path.join(dir, "hidden/check.mjs"), checkScript(opt.test));
  fs.writeFileSync(path.join(dir, "reference", `${id}.patch`), raw(repo, ["diff", "--no-color", "--no-ext-diff", c.parent, c.sha, "--", ...c.source]).stdout);
  fs.writeFileSync(path.join(dir, "conditions/minimal/AGENTS.md"), `# ${path.basename(repo)}\n\nRun \`${opt.test}\` before you finish.\n`);
  const task = { id, prompt: promptFrom(text(repo, ["log", "-1", "--format=%B", c.sha])), ...(opt.setup ? { setup: opt.setup } : {}), check: 'node "{{HIDDEN}}/check.mjs"', forbid: [], timeoutSeconds: 900 };
  fs.writeFileSync(path.join(dir, "tasks", `${id}.yaml`), `# Prompt derived from commit ${c.sha.slice(0, 10)}: read it and remove any hint about HOW it was solved before you measure.\n` + YAML.stringify(task, { lineWidth: 0 }));
  const study = {
    id, agent: opt.agent, runs: opt.runs, parallel: 1, seed: i + 1,
    target: { path: repo, commit: c.parent },
    tasks: "tasks", hidden: "hidden", reference: "reference",
    conditions: { none: {}, minimal: { overlay: "conditions/minimal" }, full: { strip: false } },
  };
  fs.writeFileSync(path.join(dir, "study.yaml"), `# Mined from ${c.sha.slice(0, 10)} "${c.subject.replace(/"/g, "'")}". Code = its parent ${c.parent.slice(0, 10)}.\n` + YAML.stringify(study, { lineWidth: 0 }));
  return { id, dir };
}

export async function main(argv) {
  const { values: v } = parseArgs({
    args: argv,
    options: { repo: { type: "string" }, test: { type: "string" }, setup: { type: "string" }, count: { type: "string" }, out: { type: "string" }, id: { type: "string" }, runs: { type: "string" }, scan: { type: "string" }, "max-files": { type: "string" }, "max-lines": { type: "string" }, agent: { type: "string" }, "any-commit": { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (v.help) return console.log(USAGE), 0;
  if (!v.test) return console.error(`error --test "<command>" is required\n\n${USAGE}`), 2;
  const repo = path.resolve(v.repo ?? process.cwd());
  if (spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repo }).status !== 0) throw new StudyError(`${repo} is not a git repository`);
  const num = (x, d) => (x === undefined ? d : Number(x));
  const { candidates, skipped } = findCandidates(repo, { scan: num(v.scan, 400), maxFiles: num(v["max-files"], 8), maxLines: num(v["max-lines"], 300), requireHarness: !v["any-commit"] });
  const picked = candidates.slice(0, num(v.count, 5));
  if (!picked.length) {
    console.error(`No usable commits found (skipped: no tests ${skipped.noTests}, no source ${skipped.noSource}, too big ${skipped.tooBig}, parent without an agent instruction file ${skipped.noHarness}).`);
    if (skipped.noHarness) console.error('Commits before your harness existed were skipped, since "full" would equal "none". Pass --any-commit to include them.');
    return 1;
  }
  const out = path.resolve(v.out ?? "study/studies/volunteer");
  const opt = { prefix: v.id ?? "vol", out, test: v.test, setup: v.setup, runs: num(v.runs, 3), agent: v.agent ?? "node {runner}/agent.mjs --prompt-env GEARNESS_PROMPT" };
  const built = picked.map((c, i) => ({ ...buildStudy(repo, c, i, opt), c }));
  console.log(`Built ${built.length} stud${built.length === 1 ? "y" : "ies"} in ${out}\n`);
  for (const b of built) console.log(`  ${b.id}  ${b.c.sha.slice(0, 10)}  ${b.c.fixish ? "fix    " : "change "} ${b.c.subject.slice(0, 70)}`);
  console.log(`\nNext (read VOLUNTEER.md): review the prompts in each tasks/ folder, then\n  node study/runner/batch.mjs ${path.relative(process.cwd(), out) || "."}          # validates every task and shows the plan, free\n  node study/runner/batch.mjs ${path.relative(process.cwd(), out) || "."} --yes    # runs the agent: uses your plan or API credits`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e instanceof StudyError ? `error ${e.message}` : e); process.exit(e instanceof StudyError ? 2 : 1); });
}
