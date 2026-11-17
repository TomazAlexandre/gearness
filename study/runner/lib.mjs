// Shared helpers for the study runner: study config, isolated trial repositories, manifest.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_GEARNESS = path.resolve(RUNNER_DIR, "../../dist/cli.js");
export const KIT_VERSION = "0.1";

export class StudyError extends Error {}

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

/** Quotes one token for the platform's shell: single quotes for sh, double quotes for cmd.exe. */
export function shellPath(p, platform = process.platform) {
  if (/^[\w@%+=:,./\\-]+$/.test(p)) return p;
  return platform === "win32" ? `"${p.replace(/"/g, '\\"')}"` : `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs an agent binary on any platform. On Windows the npm-installed `claude` is a .cmd shim that only a shell can
 * start, and a .mjs/.js path (used by tests and wrappers) is run with this node. STUDY_SHELL=1 forces the shell path
 * on any OS so it can be tested. Arguments given here must never carry user content: prompts travel via stdin.
 */
export function spawnBin(bin, args, opts = {}) {
  const script = /\.(mjs|cjs|js)$/i.test(bin);
  const base = { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts };
  if (script) return spawnSync(process.execPath, [bin, ...args], base);
  if (process.platform !== "win32" && process.env.STUDY_SHELL !== "1") return spawnSync(bin, args, base);
  // Decide "command not found" BEFORE running, never from cmd.exe's message: that message is localized
  // (e.g. "não é reconhecido como um comando interno ou externo") and its exit code is just 1.
  if (process.platform === "win32" && !commandExists(bin)) return { status: 127, stdout: "", stderr: `${bin}: command not found`, signal: null };
  return spawnSync([bin, ...args].map((a) => shellPath(a)).join(" "), { ...base, shell: true });
}

/** Windows: is `bin` a file (with or without .exe/.cmd/.bat/.com) or a command on PATH? Language-independent. */
export function commandExists(bin) {
  if (/[\\/]/.test(bin) || /^[a-z]:/i.test(bin)) return ["", ".exe", ".cmd", ".bat", ".com"].some((ext) => fs.existsSync(bin + ext));
  return spawnSync("where", [bin], { stdio: "ignore" }).status === 0;
}

/** Parses and validates study.yaml. Every path in it is relative to the file. */
export function loadStudy(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new StudyError(`${file} not found`);
  let raw;
  try {
    raw = YAML.parse(fs.readFileSync(abs, "utf8")) ?? {};
  } catch (e) {
    throw new StudyError(`${file}: invalid YAML (${e.message.split("\n")[0]})`);
  }
  const dir = path.dirname(abs);
  const errs = [];
  if (typeof raw.id !== "string" || !KEBAB.test(raw.id)) errs.push("`id` must be kebab-case, e.g. gearness-pilot");
  if (typeof raw.agent !== "string" || !raw.agent.trim()) errs.push("`agent` is required (a gearness preset or a command containing {prompt})");
  const runs = raw.runs ?? 5;
  if (!Number.isInteger(runs) || runs < 1) errs.push("`runs` must be a positive integer");
  const t = raw.target ?? {};
  if (!t.path && !t.repo) errs.push("`target.path` or `target.repo` is required");
  if (!t.commit) errs.push("`target.commit` is required (a sha; HEAD is accepted for a local path and is recorded as a sha)");
  if (typeof raw.tasks !== "string") errs.push("`tasks` (directory of task files) is required");
  const conds = raw.conditions;
  if (!conds || typeof conds !== "object" || !Object.keys(conds).length) errs.push("`conditions` is required");
  for (const name of Object.keys(conds ?? {})) if (!KEBAB.test(name)) errs.push(`condition name "${name}" must be kebab-case`);
  if (errs.length) throw new StudyError(`${file}:\n  - ${errs.join("\n  - ")}`);
  return {
    file: abs,
    dir,
    id: raw.id,
    agent: raw.agent.replace(/\{runner\}([^\s"']*)/g, (_, rest) => shellPath(path.join(RUNNER_DIR, rest))),
    runs,
    parallel: raw.parallel ?? 3,
    seed: raw.seed ?? 1,
    timeoutSeconds: raw.timeoutSeconds,
    protocol: raw.protocol ? path.resolve(dir, raw.protocol) : undefined,
    target: {
      path: t.path ? path.resolve(dir, t.path) : undefined,
      repo: t.repo,
      commit: String(t.commit),
      exclude: Array.isArray(t.exclude) ? t.exclude.map(String) : [],
    },
    tasksDir: path.resolve(dir, raw.tasks),
    hiddenDir: raw.hidden ? path.resolve(dir, raw.hidden) : undefined,
    referenceDir: path.resolve(dir, raw.reference ?? "reference"),
    resultsDir: path.join(dir, "results"),
    workDir: path.join(dir, ".work"),
    conditions: Object.fromEntries(
      Object.entries(conds).map(([name, c]) => [name, { overlay: c?.overlay ? path.resolve(dir, c.overlay) : undefined, strip: c?.strip !== false }]),
    ),
  };
}

// ---------------------------------------------------------------- stripping

const FILE_NAMES = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", ".windsurfrules", ".clinerules", ".mcp.json"]);
const DIR_NAMES = new Set([".cursor", ".claude", ".windsurf", ".clinerules"]);
const REL_PATHS = new Set([".github/copilot-instructions.md", ".github/instructions", ".vscode/mcp.json", ".harness"]);

/** Context files a gearness-style harness.yaml declares (entry, docs, status): they are part of that harness. */
function declaredContext(root) {
  const f = path.join(root, "harness.yaml");
  if (!fs.existsSync(f)) return [];
  try {
    const c = YAML.parse(fs.readFileSync(f, "utf8"))?.context ?? {};
    return [c.entry, ...(Array.isArray(c.docs) ? c.docs : []), c.status].filter((p) => typeof p === "string" && p && !path.isAbsolute(p) && !p.includes(".."));
  } catch {
    return [];
  }
}

/**
 * Removes everything that tells an agent how to work in the repository (instruction files for every
 * agent, MCP config, a gearness harness and the context docs it declares), so each condition starts from zero.
 * Returns the removed paths, relative to root.
 */
export function stripAgentFiles(root) {
  const removed = [];
  const rm = (rel) => {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) {
      fs.rmSync(abs, { recursive: true, force: true });
      removed.push(rel);
    }
  };
  for (const rel of declaredContext(root)) rm(rel);
  rm("harness.yaml");
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if ((e.isDirectory() && (DIR_NAMES.has(e.name) || REL_PATHS.has(r))) || (!e.isDirectory() && (FILE_NAMES.has(e.name) || REL_PATHS.has(r)))) rm(r);
      else if (e.isDirectory()) walk(r);
    }
  };
  walk("");
  return removed;
}

/** For conditions that keep the target's own harness: only remove what would leak the eval tasks. */
export function stripEvalLeaks(root) {
  const removed = [];
  for (const rel of [".harness/evals", ".harness/eval-results"]) {
    if (fs.existsSync(path.join(root, rel))) {
      fs.rmSync(path.join(root, rel), { recursive: true, force: true });
      removed.push(rel);
    }
  }
  return removed;
}

// ---------------------------------------------------------------- git helpers

export function git(cwd, args, opts = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

const GIT_ID = ["-c", "user.name=gearness-study", "-c", "user.email=study@gearness.invalid", "-c", "commit.gpgsign=false"];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Exports the files of the pinned commit WITHOUT history. A trial repository that kept the history would let an
 * agent read the real solution of a task taken from a later commit with `git log`.
 */
export function exportCommit(target, dest) {
  let src = target.path;
  let tmp;
  if (!src) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "study-clone-"));
    const c = git(os.tmpdir(), ["clone", "--quiet", target.repo, tmp]);
    if (!c.ok) throw new StudyError(`git clone ${target.repo} failed: ${c.err}`);
    src = tmp;
  }
  try {
    const sha = git(src, ["rev-parse", "--verify", `${target.commit}^{commit}`]);
    if (!sha.ok) throw new StudyError(`commit "${target.commit}" not found in ${target.path ?? target.repo}`);
    const tar = path.join(os.tmpdir(), `study-${process.pid}-${Date.now()}.tar`);
    const a = git(src, ["archive", "--format=tar", "-o", tar, sha.out]);
    if (!a.ok) throw new StudyError(`git archive failed: ${a.err}`);
    fs.mkdirSync(dest, { recursive: true });
    const x = spawnSync("tar", ["-xf", tar, "-C", dest]);
    fs.rmSync(tar, { force: true });
    if (x.status !== 0) throw new StudyError(`tar failed: ${String(x.stderr)}`);
    return sha.out;
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- tasks

/** Copies task files, replacing {{HIDDEN}} with the absolute path of the hidden checks directory. */
export function resolveTasks(study, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(study.tasksDir)) throw new StudyError(`tasks directory not found: ${study.tasksDir}`);
  const files = fs.readdirSync(study.tasksDir).filter((f) => /\.ya?ml$/.test(f)).sort();
  if (!files.length) throw new StudyError(`no task files (*.yaml) in ${study.tasksDir}`);
  const hidden = study.hiddenDir ?? "";
  for (const f of files) {
    const text = fs.readFileSync(path.join(study.tasksDir, f), "utf8");
    if (text.includes("{{HIDDEN}}") && !study.hiddenDir) throw new StudyError(`${f} uses {{HIDDEN}} but the study has no \`hidden\` directory`);
    fs.writeFileSync(path.join(outDir, f), text.replaceAll("{{HIDDEN}}", hidden));
  }
  return files.map((f) => ({ file: f, ...YAML.parse(fs.readFileSync(path.join(outDir, f), "utf8")) }));
}

// ---------------------------------------------------------------- trials

function patchHarnessYaml(dir, study) {
  const file = path.join(dir, "harness.yaml");
  const had = fs.existsSync(file);
  const doc = (had ? YAML.parse(fs.readFileSync(file, "utf8")) : null) ?? {};
  doc.version ??= 1;
  doc.project = { name: "study-trial", ...(doc.project ?? {}) };
  if (!had) doc.agents = []; // a condition without a harness has no adapters either
  doc.eval = {
    ...(doc.eval ?? {}),
    agent: study.agent,
    tasks: ".study-tasks", // untracked, so it never reaches the agent's worktree
    timeoutSeconds: study.timeoutSeconds ?? doc.eval?.timeoutSeconds ?? 900,
  };
  fs.writeFileSync(file, YAML.stringify(doc, { lineWidth: 0 }));
}

function listFiles(root, rel = "") {
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? (e.name === ".git" ? [] : listFiles(root, r)) : [r];
  });
}

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/**
 * Builds <workDir>/trials/<name>/repo: the pinned code (no history), stripped of agent files, with the
 * condition's overlay applied and a single commit. The resolved tasks live next to it, untracked.
 */
export function prepareTrial(study, name, cond, workDir, tasks) {
  const base = path.join(workDir, "trials", name);
  const dir = path.join(base, "repo");
  fs.rmSync(base, { recursive: true, force: true });
  const commit = exportCommit(study.target, dir);
  for (const p of study.target.exclude) fs.rmSync(path.join(dir, p), { recursive: true, force: true });
  const removed = cond.strip ? stripAgentFiles(dir) : stripEvalLeaks(dir);
  let overlayFiles = [];
  if (cond.overlay) {
    if (!fs.existsSync(cond.overlay)) throw new StudyError(`overlay for "${name}" not found: ${cond.overlay}`);
    copyDir(cond.overlay, dir);
    overlayFiles = listFiles(cond.overlay);
  }
  patchHarnessYaml(dir, study);
  git(dir, ["init", "-q"]);
  fs.mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "info", "exclude"), ".study-tasks/\n.harness/eval-results/\n");
  git(dir, [...GIT_ID, "add", "-A"]);
  const c = git(dir, [...GIT_ID, "commit", "-q", "--no-verify", "-m", `study: ${name} harness on ${commit.slice(0, 12)}`]);
  if (!c.ok) throw new StudyError(`could not commit trial repository: ${c.err}`);
  fs.cpSync(tasks, path.join(dir, ".study-tasks"), { recursive: true });
  return {
    repo: dir,
    codeCommit: commit,
    trialCommit: git(dir, ["rev-parse", "HEAD"]).out,
    removed,
    overlayFiles,
    harnessFiles: listFiles(dir).filter((f) => !f.startsWith(".study-tasks/")).length,
  };
}

/**
 * Identifies exactly what `validate.mjs` proved: the pinned commit plus every task, hidden check and reference patch.
 * run.mjs refuses to measure unless the stored stamp matches, so an unvalidated or edited task never reaches the agent.
 */
export function studyFingerprint(study, codeCommit) {
  const h = crypto.createHash("sha256");
  h.update(`commit:${codeCommit}\nexclude:${study.target.exclude.join(",")}\n`);
  for (const [label, dir] of [["tasks", study.tasksDir], ["hidden", study.hiddenDir], ["reference", study.referenceDir]]) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const f of listFiles(dir).sort()) h.update(`${label}/${f}:${sha256(fs.readFileSync(path.join(dir, f)))}\n`);
  }
  return h.digest("hex");
}

export const stampFile = (study) => path.join(study.workDir, "validated.json");

/** Harness score of a trial repository (null when the CLI cannot compute one). */
export function doctorScore(repo, gearness = DEFAULT_GEARNESS) {
  const r = spawnSync(process.execPath, [gearness, "doctor", "--json"], { cwd: repo, encoding: "utf8" });
  try {
    const s = JSON.parse(r.stdout).score;
    return typeof s === "number" ? s : null;
  } catch {
    return null;
  }
}

/** Deterministic shuffle (so condition order inside a round is varied but reproducible). */
export function shuffled(xs, rand) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** A run is invalid when it says nothing about the harness: setup failed, or the agent crashed without touching anything. */
export function isInvalid(run) {
  if (run.passed) return false;
  if (run.reason === "setup failed") return true;
  return run.agentExit !== null && run.agentExit !== 0 && run.changedFiles === 0 && !String(run.reason).startsWith("changed forbidden");
}

export function protocolState(study) {
  if (!study.protocol) return null;
  if (!fs.existsSync(study.protocol)) throw new StudyError(`protocol file not found: ${study.protocol}`);
  const dir = path.dirname(study.protocol);
  const inRepo = git(dir, ["rev-parse", "--is-inside-work-tree"]).ok;
  const dirty = inRepo ? git(dir, ["status", "--porcelain", "--", study.protocol]).out !== "" : null;
  const commit = inRepo ? git(dir, ["log", "-1", "--format=%H", "--", study.protocol]).out || null : null;
  return { file: path.relative(study.dir, study.protocol), sha256: sha256(fs.readFileSync(study.protocol)), commit, dirty, inRepo };
}
