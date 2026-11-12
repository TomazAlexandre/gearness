import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { ADAPTERS } from "./adapters.js";
import { CONFIG_FILE, type HarnessConfig } from "./config.js";
import { evalTaskYaml } from "./templates.js";
import { exists, GIT_MISSING, hasGit, matchesGlob, readFile, writeFile } from "./util.js";

export interface EvalTask {
  id: string;
  prompt: string;
  /** Shell command that exits 0 only when the task was done correctly. */
  check: string;
  setup?: string;
  /** Globs of files the agent must not change. */
  forbid: string[];
  timeoutSeconds: number;
  file: string;
}

/** Headless invocations of popular agents. Override with any command containing {prompt}. */
export const AGENT_PRESETS: Record<string, string> = {
  claude: "claude -p {prompt} --permission-mode acceptEdits",
  codex: "codex exec --full-auto {prompt}",
  aider: "aider --yes-always --no-auto-commits --message {prompt}",
  gemini: "gemini --yolo -p {prompt}",
};

export const RESULTS_DIR = ".harness/eval-results";

export function shellQuote(s: string): string {
  if (process.platform === "win32") return `"${s.replace(/"/g, '\\"')}"`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function agentCommand(spec: string, prompt: string): string {
  const template = AGENT_PRESETS[spec] ?? spec;
  if (template.includes("{prompt}")) return template.replaceAll("{prompt}", shellQuote(prompt));
  // Commands that read $GEARNESS_PROMPT themselves are used as-is.
  return template.includes("GEARNESS_PROMPT") ? template : `${template} ${shellQuote(prompt)}`;
}

export function loadTasks(cwd: string, config: HarnessConfig): { tasks: EvalTask[]; errors: string[] } {
  const dir = path.join(cwd, config.eval.tasks);
  const tasks: EvalTask[] = [];
  const errors: string[] = [];
  if (!fs.existsSync(dir)) return { tasks, errors };
  for (const f of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const rel = `${config.eval.tasks}/${f}`;
    let raw: Record<string, unknown>;
    try {
      raw = YAML.parse(readFile(path.join(dir, f)) ?? "") ?? {};
    } catch (e) {
      errors.push(`${rel}: invalid YAML (${(e as Error).message.split("\n")[0]})`);
      continue;
    }
    const id = typeof raw.id === "string" ? raw.id : path.basename(f).replace(/\.ya?ml$/, "");
    if (typeof raw.prompt !== "string" || !raw.prompt.trim()) errors.push(`${rel}: \`prompt\` is required`);
    else if (typeof raw.check !== "string" || !raw.check.trim()) errors.push(`${rel}: \`check\` is required`);
    else if (/TODO\(gearness\)/.test(raw.prompt + raw.check)) errors.push(`${rel}: still has TODO(gearness) placeholders`);
    else
      tasks.push({
        id,
        prompt: raw.prompt.trim(),
        check: raw.check,
        setup: typeof raw.setup === "string" ? raw.setup : undefined,
        forbid: Array.isArray(raw.forbid) ? raw.forbid.map(String) : [],
        timeoutSeconds: typeof raw.timeoutSeconds === "number" ? raw.timeoutSeconds : config.eval.timeoutSeconds,
        file: rel,
      });
  }
  if (new Set(tasks.map((t) => t.id)).size !== tasks.length) errors.push("duplicate task ids");
  return { tasks, errors };
}

export function newTask(cwd: string, config: HarnessConfig, id: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("task id must be kebab-case, e.g. add-health-endpoint");
  const rel = `${config.eval.tasks}/${id}.yaml`;
  if (exists(path.join(cwd, rel))) throw new Error(`${rel} already exists`);
  writeFile(path.join(cwd, rel), evalTaskYaml(id, config));
  return rel;
}

/** Files that make up the harness (what we swap between variants). */
export function harnessPaths(config: HarnessConfig): string[] {
  const adapters = config.agents.map((a) => ADAPTERS[a].file).filter((f): f is string => !!f);
  return [...new Set([CONFIG_FILE, config.context.entry, ...config.context.docs, ...(config.context.status ? [config.context.status] : []), ...adapters, ".harness/rules"])];
}

function git(cwd: string, args: string[], input?: string): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? "") + (r.status ? r.stderr ?? "" : "") };
}

const GIT_ID = ["-c", "user.name=gearness-eval", "-c", "user.email=eval@gearness.invalid", "-c", "commit.gpgsign=false"];

function copyRecursive(src: string, dst: string): void {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src)) copyRecursive(path.join(src, e), path.join(dst, e));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

/** Replaces the worktree's harness files with those from the working tree (ref = null) or a git ref. */
function overlayHarness(cwd: string, wt: string, paths: string[], ref: string | null): void {
  for (const p of paths) fs.rmSync(path.join(wt, p), { recursive: true, force: true });
  for (const p of paths) {
    if (ref === null) {
      if (fs.existsSync(path.join(cwd, p))) copyRecursive(path.join(cwd, p), path.join(wt, p));
      continue;
    }
    const listed = git(cwd, ["ls-tree", "-r", "--name-only", ref, "--", p]);
    for (const f of listed.out.split("\n").filter(Boolean)) {
      const r = spawnSync("git", ["show", `${ref}:${f}`], { cwd, maxBuffer: 64 * 1024 * 1024 });
      if (r.status === 0) {
        fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
        fs.writeFileSync(path.join(wt, f), r.stdout);
      }
    }
  }
}

function changedFiles(wt: string): string[] {
  return git(wt, ["status", "--porcelain", "-uall"])
    .out.split("\n")
    .filter(Boolean)
    .flatMap((l) => l.slice(3).split(" -> "))
    .map((f) => f.replace(/^"|"$/g, ""));
}

/** Runs a shell command; on timeout kills the whole process tree (agents spawn children). */
function run(cmd: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ code: number | null; timedOut: boolean; output: string; ms: number }> {
  const start = Date.now();
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    const child = spawn(cmd, { cwd, shell: true, env, detached: !win, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (b: Buffer) => {
      output += b.toString();
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (win) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
        else process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, timedOut, output, ms: Date.now() - start });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, timedOut: false, output: String(e), ms: Date.now() - start });
    });
  });
}

/** Serializes git operations on the main repository (worktree add/remove take locks). */
function mutex() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => T | Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
}

export interface TaskRun {
  task: string;
  variant: string;
  run: number;
  passed: boolean;
  reason: string;
  agentExit: number | null;
  checkExit: number | null;
  forbiddenChanged: string[];
  changedFiles: number;
  durationMs: number;
  logTail: string;
}

export interface EvalOptions {
  runs?: number;
  tasks?: string[];
  agent?: string;
  /** Git ref whose harness files form the baseline variant. */
  baseline?: string;
  keep?: boolean;
  /** How many agent runs to execute at once (each in its own worktree). */
  parallel?: number;
  onProgress?: (msg: string) => void;
}

export interface EvalSummary {
  date: string;
  agent: string;
  head: string;
  baseline: string | null;
  variants: { name: string; passRate: number; passed: number; total: number }[];
  runs: TaskRun[];
}

export async function runEval(cwd: string, config: HarnessConfig, opts: EvalOptions = {}): Promise<EvalSummary> {
  if (!hasGit()) throw new Error(`gearness eval needs git: ${GIT_MISSING}`);
  const head = git(cwd, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) throw new Error("gearness eval needs a git repository with at least one commit");
  if (opts.baseline && !git(cwd, ["rev-parse", "--verify", `${opts.baseline}^{commit}`]).ok) throw new Error(`unknown git ref "${opts.baseline}"`);
  const { tasks: all, errors } = loadTasks(cwd, config);
  if (errors.length) throw new Error(errors.join("\n"));
  const tasks = opts.tasks?.length ? all.filter((t) => opts.tasks!.includes(t.id)) : all;
  if (!tasks.length) throw new Error(all.length ? "no task matches --task" : `no eval tasks in ${config.eval.tasks} - create one with \`gearness eval new <id>\``);

  const agent = opts.agent ?? config.eval.agent;
  const runs = Math.max(1, opts.runs ?? 1);
  const variants: { name: string; ref: string | null }[] = [{ name: "current", ref: null }];
  if (opts.baseline) variants.push({ name: opts.baseline, ref: opts.baseline });
  const paths = harnessPaths(config);
  const log = opts.onProgress ?? (() => {});

  const jobs = tasks.flatMap((task) => variants.flatMap((v) => Array.from({ length: runs }, (_, k) => ({ task, v, i: k + 1 }))));
  const locked = mutex();

  const runJob = async ({ task, v, i }: (typeof jobs)[number]): Promise<TaskRun> => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gearness-eval-"));
    const wt = path.join(tmp, "wt");
    const label = `${task.id} [${v.name}] run ${i}/${runs}`;
    log(`▶ ${label}`);
    const added = await locked(() => git(cwd, ["worktree", "add", "--detach", wt, "HEAD"]));
    if (!added.ok) throw new Error(`git worktree add failed: ${added.out}`);
    const base = { task: task.id, variant: v.name, run: i, forbiddenChanged: [] as string[], changedFiles: 0 };
    try {
      overlayHarness(cwd, wt, paths, v.ref);
      git(wt, [...GIT_ID, "add", "-A"]);
      git(wt, [...GIT_ID, "commit", "-q", "--no-verify", "--allow-empty", "-m", `gearness eval: ${v.name} harness`]);
      const env = { ...process.env, GEARNESS_PROMPT: task.prompt, GEARNESS_TASK: task.id, GEARNESS_VARIANT: v.name };
      const timeout = task.timeoutSeconds * 1000;
      if (task.setup) {
        const s = await run(task.setup, wt, timeout, env);
        if (s.code !== 0) {
          log(`  ✗ ${label}: setup failed`);
          return { ...base, passed: false, reason: "setup failed", agentExit: null, checkExit: null, durationMs: s.ms, logTail: s.output.slice(-2000) };
        }
        // Setup output (node_modules, venvs) must not count as agent changes.
        git(wt, [...GIT_ID, "add", "-A"]);
        git(wt, [...GIT_ID, "commit", "-q", "--no-verify", "--allow-empty", "-m", "gearness eval: setup"]);
      }
      const a = await run(agentCommand(agent, task.prompt), wt, timeout, env);
      const changed = changedFiles(wt);
      const forbidden = changed.filter((f) => task.forbid.some((g) => matchesGlob(f, g)));
      const c = a.timedOut ? null : await run(task.check, wt, timeout, env);
      const passed = !a.timedOut && c?.code === 0 && forbidden.length === 0;
      const reason = a.timedOut ? "agent timed out" : forbidden.length ? `changed forbidden files: ${forbidden.join(", ")}` : c?.code !== 0 ? `check failed (exit ${c?.code})` : "ok";
      log(`  ${passed ? "✓" : "✗"} ${label}${passed ? "" : `: ${reason}`}`);
      return {
        ...base,
        passed,
        reason,
        agentExit: a.code,
        checkExit: c?.code ?? null,
        forbiddenChanged: forbidden,
        changedFiles: changed.length,
        durationMs: a.ms + (c?.ms ?? 0),
        logTail: (a.output + (c ? `\n--- check ---\n${c.output}` : "")).slice(-4000),
      };
    } finally {
      if (opts.keep) log(`  worktree kept at ${wt}`);
      else {
        await locked(() => git(cwd, ["worktree", "remove", "--force", wt]));
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  };

  // Bounded worker pool; results keep the job order for stable reports.
  const results: TaskRun[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(opts.parallel ?? 1, jobs.length)) }, async () => {
    while (next < jobs.length) {
      const k = next++;
      results[k] = await runJob(jobs[k]);
    }
  });
  await Promise.all(workers);

  const summary: EvalSummary = {
    date: new Date().toISOString(),
    agent,
    head: head.out.trim(),
    baseline: opts.baseline ?? null,
    variants: variants.map((v) => {
      const mine = results.filter((r) => r.variant === v.name);
      const passed = mine.filter((r) => r.passed).length;
      return { name: v.name, passed, total: mine.length, passRate: mine.length ? passed / mine.length : 0 };
    }),
    runs: results,
  };
  const file = path.join(cwd, RESULTS_DIR, `${summary.date.replace(/[:.]/g, "-")}.json`);
  writeFile(file, JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

/** Loads saved eval summaries, oldest first. */
export function loadHistory(cwd: string, limit = 20): EvalSummary[] {
  const dir = path.join(cwd, RESULTS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .slice(-limit)
    .flatMap((f) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as EvalSummary];
      } catch {
        return [];
      }
    });
}

/** Per-task pass rate of the "current" variant across saved runs. */
export function trend(history: EvalSummary[]): { tasks: string[]; rows: { date: string; agent: string; rates: Record<string, number | null>; overall: number }[] } {
  const tasks = [...new Set(history.flatMap((h) => h.runs.map((r) => r.task)))].sort();
  const rows = history.map((h) => {
    const rates: Record<string, number | null> = {};
    for (const t of tasks) {
      const rs = h.runs.filter((r) => r.task === t && r.variant === "current");
      rates[t] = rs.length ? rs.filter((r) => r.passed).length / rs.length : null;
    }
    return { date: h.date, agent: h.agent, rates, overall: h.variants[0]?.passRate ?? 0 };
  });
  return { tasks, rows };
}
