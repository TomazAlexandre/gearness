import path from "node:path";
import { justRecipes, makeTargets, taskfileTasks } from "./detect.js";
import { exists, lineOf, readFile } from "./util.js";

const NPM_BUILTINS = new Set(["ci", "install", "i", "exec", "x", "dlx", "add", "remove", "rm", "audit", "pack", "publish", "init", "create", "link", "outdated", "update", "upgrade", "why", "list", "ls", "version", "config", "login", "info", "view", "cache", "store", "import", "prune", "dedupe"]);
const RUNNER_FILE: Record<string, string> = { make: "Makefile", just: "justfile", task: "Taskfile" };
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Splits a shell line into the individual commands joined by && / || / ; / |. */
export const segments = (cmd: string): string[] =>
  cmd
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, "")) // drop leading FOO=bar env assignments
    .filter(Boolean);

/** The script or task target a command segment runs, if it runs one through a known runner. */
export function scriptOf(seg: string): { tool: string; name: string } | null {
  const m = /^(npm|pnpm|yarn|bun)\s+(.+)$/.exec(seg);
  if (m) {
    const [tool, rest] = [m[1], m[2].split(/\s+/).filter((a) => !/^--?(?:filter|w|workspace|prefix|C|dir)(?:=|$)/.test(a))];
    if (rest[0] === "run" || rest[0] === "run-script") return rest[1] && !rest[1].startsWith("-") ? { tool, name: rest[1] } : null;
    if (rest[0] === "test" || rest[0] === "start") return { tool, name: rest[0] };
    if (tool !== "npm" && rest[0] && !NPM_BUILTINS.has(rest[0]) && !rest[0].startsWith("-")) return { tool, name: rest[0] };
    return null;
  }
  const runner = /^(make|just|task)\s+([A-Za-z0-9_.:-]+)/.exec(seg);
  return runner && !runner[2].startsWith("-") ? { tool: runner[1], name: runner[2] } : null;
}

export function packageManagerOf(cwd: string): { pm: PackageManager; lockfile: string } | null {
  for (const [lockfile, pm] of [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lockb", "bun"], ["bun.lock", "bun"], ["package-lock.json", "npm"]] as const)
    if (exists(path.join(cwd, lockfile))) return { pm, lockfile };
  return null;
}

export interface CommandEnv {
  scripts: Record<string, string> | null;
  hasPackageJson: boolean;
  runners: Record<string, Set<string>>;
  pm: { pm: PackageManager; lockfile: string } | null;
}

export function commandEnv(cwd: string): CommandEnv {
  const pkg = readFile(path.join(cwd, "package.json"));
  let scripts: Record<string, string> | null = null;
  if (pkg)
    try {
      scripts = JSON.parse(pkg).scripts ?? {};
    } catch {
      /* invalid package.json: scripts unknown */
    }
  return { scripts, hasPackageJson: pkg !== null, runners: { make: makeTargets(cwd), just: justRecipes(cwd), task: taskfileTasks(cwd) }, pm: packageManagerOf(cwd) };
}

/** Problems with a shell command line: missing scripts/targets, or the wrong package manager for this repo. */
export function commandProblems(cmd: string, env: CommandEnv): string[] {
  const out: string[] = [];
  for (const seg of segments(cmd)) {
    const tool = /^(npm|pnpm|yarn|bun)\b/.exec(seg)?.[1] as PackageManager | undefined;
    if (tool && env.pm && tool !== env.pm.pm && !(tool === "npm" && /^npm\s+(?:i|install)\s+-g\b/.test(seg)))
      out.push(`\`${seg}\` uses ${tool}, but this repository uses ${env.pm.pm} (${env.pm.lockfile})`);
    const s = scriptOf(seg);
    if (!s) continue;
    if (s.tool in env.runners) {
      if (!env.runners[s.tool].has(s.name)) out.push(`\`${seg}\`: ${RUNNER_FILE[s.tool]} has no \`${s.name}\` target`);
    } else if (!env.hasPackageJson) out.push(`\`${seg}\`: uses ${s.tool} but there is no package.json`);
    else if (env.scripts && !(s.name in env.scripts)) out.push(`\`${seg}\`: package.json has no \`${s.name}\` script`);
  }
  return out;
}

const SHELL_LANGS = new Set(["", "sh", "bash", "shell", "zsh", "console", "terminal", "powershell", "ps1", "cmd"]);

/** Shell commands a markdown document tells the reader to run (inline code and shell code blocks). */
export function docCommands(md: string): { cmd: string; line: number }[] {
  const out: { cmd: string; line: number }[] = [];
  const looksRunnable = (s: string) => /^(?:\$\s+)?(?:npm|pnpm|yarn|bun|make|just|task)\s/.test(s);
  // Fenced blocks first, then inline spans outside them.
  const fence = /^([ \t]*)(```|~~~)[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)^\1\2[ \t]*$/gm;
  let m: RegExpExecArray | null;
  const blanked = md.replace(fence, (block, _i, _f, lang: string, body: string, offset: number) => {
    if (SHELL_LANGS.has(lang.toLowerCase())) {
      const start = lineOf(md, offset) + 1;
      body.split("\n").forEach((l, i) => {
        const t = l.trim().replace(/^\$\s+/, "");
        if (t && !t.startsWith("#") && looksRunnable(t)) out.push({ cmd: t.replace(/\s+#.*$/, ""), line: start + i });
      });
    }
    return block.replace(/[^\n]/g, " ");
  });
  const inline = /`([^`\n]+)`/g;
  while ((m = inline.exec(blanked))) {
    const t = m[1].trim().replace(/^\$\s+/, "");
    if (looksRunnable(t)) out.push({ cmd: t, line: lineOf(blanked, m.index) });
  }
  return out.sort((a, b) => a.line - b.line);
}
