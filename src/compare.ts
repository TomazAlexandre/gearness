import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_FILE, loadConfig } from "./config.js";
import type { Diagnostic } from "./rules.js";
import { evaluateTree, type WorkspaceReport } from "./score.js";
import { GIT_MISSING, hasGit } from "./util.js";

export interface Comparison {
  ref: string;
  /** Root score at the base ref; null when the base had no harness. */
  baseScore: number | null;
  score: number;
  delta: number | null;
  /** Findings present now but not at the base (regressions introduced by this change). */
  introduced: Diagnostic[];
  /** Findings at the base that this change resolved. */
  resolved: Diagnostic[];
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

// Line numbers move with every edit, so findings are matched by rule, file and message.
const key = (d: Diagnostic) => `${d.rule}\u0000${d.file ?? ""}\u0000${d.message}`;

export function flatten(tree: WorkspaceReport[]): Diagnostic[] {
  return tree.flatMap((w) => (w.report?.diagnostics ?? []).map((d) => ({ ...d, file: w.dir === "." ? d.file : `${w.dir}/${d.file ?? ""}` })));
}

/** Evaluates the harness as it was at `ref` (in a throwaway worktree) and diffs it with the current one. */
export async function compareWithBase(cwd: string, ref: string, current: WorkspaceReport[]): Promise<Comparison> {
  if (!hasGit()) throw new Error(`--base needs git: ${GIT_MISSING}`);
  try {
    git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    throw new Error(`unknown git ref "${ref}" (in CI, check out with fetch-depth: 0)`);
  }
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  const rel = path.relative(fs.realpathSync(top), fs.realpathSync(cwd));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gearness-base-"));
  const wt = path.join(tmp, "wt");
  git(cwd, ["worktree", "add", "--detach", wt, ref]);
  try {
    const baseCwd = path.join(wt, rel);
    let base: WorkspaceReport[] | null = null;
    if (fs.existsSync(path.join(baseCwd, CONFIG_FILE))) {
      const { config } = loadConfig(baseCwd);
      if (config) base = await evaluateTree(baseCwd, config);
    }
    const now = flatten(current);
    const before = base ? flatten(base) : [];
    const beforeKeys = new Set(before.map(key));
    const nowKeys = new Set(now.map(key));
    const score = current[0].report!.score;
    const baseScore = base?.[0].report?.score ?? null;
    return {
      ref,
      baseScore,
      score,
      delta: baseScore === null ? null : score - baseScore,
      introduced: now.filter((d) => !beforeKeys.has(key(d))),
      resolved: before.filter((d) => !nowKeys.has(key(d))),
    };
  } finally {
    try {
      git(cwd, ["worktree", "remove", "--force", wt]);
    } catch {
      /* best effort */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
