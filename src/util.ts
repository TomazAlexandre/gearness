import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Reads a text file, normalizing CRLF so checks behave the same on Windows checkouts. */
export function readFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

export function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

export const exists = (p: string): boolean => fs.existsSync(p);

export const sha = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 12);

/** Normalizes to forward slashes so output is stable across OSes. */
export const posix = (p: string): string => p.split(path.sep).join("/");

/** Last modification time of a file, preferring git history over filesystem mtime. */
export function lastModified(cwd: string, rel: string): Date | null {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%ct", "--", rel], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (out) return new Date(Number(out) * 1000);
  } catch {
    /* not a git repo, or git missing */
  }
  try {
    return fs.statSync(path.join(cwd, rel)).mtime;
  } catch {
    return null;
  }
}

/** Blanks out fenced and inline code so link/secret scanners ignore examples, keeping line numbers. */
export function stripCode(md: string): string {
  const noFences = md.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "));
  return noFences.replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
}

export function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

export interface MdLink {
  target: string;
  line: number;
}

export function markdownLinks(md: string): MdLink[] {
  const clean = stripCode(md);
  const links: MdLink[] = [];
  const inline = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = inline.exec(clean))) links.push({ target: m[1], line: lineOf(clean, m.index) });
  // Reference-style definitions: [label]: target "title"
  const refDef = /^[ ]{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+["'(].*)?$/gm;
  while ((m = refDef.exec(clean))) links.push({ target: m[1], line: lineOf(clean, m.index) });
  return links;
}

/** GitHub-style heading anchors of a markdown document (with -1, -2 suffixes for duplicates). */
export function headingAnchors(md: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const m of stripCode(md).matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
    const base = m[1]
      .replace(/<[^>]+>/g, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    anchors.add(n ? `${base}-${n}` : base);
    seen.set(base, n + 1);
  }
  for (const m of md.matchAll(/<a\s+(?:name|id)=["']([^"']+)["']/g)) anchors.add(m[1]);
  return anchors;
}

export const isExternal = (t: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("#") || t.startsWith("//");

// NO_COLOR (https://no-color.org) wins; FORCE_COLOR turns colors on for pipes and CI logs.
const forced = !!process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0" && process.env.FORCE_COLOR !== "false";
const useColor = !process.env.NO_COLOR && (process.stdout.isTTY || forced);
const wrap = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = {
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
  gray: wrap(90),
  bold: wrap(1),
  dim: wrap(2),
};

/** Converts a glob (`**`, `*`, `?`) into an anchored RegExp over forward-slash paths. */
export function globToRegExp(glob: string, opts: { prefix?: boolean } = {}): RegExp {
  // "dir/**" means the directory itself or anything below it.
  if (glob.endsWith("/**") && glob.length > 3) glob = glob.slice(0, -3);
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // By default a glob also matches everything below a matched path (deny "lodash" covers "lodash/fp").
  return new RegExp(opts.prefix === false ? `^${re}$` : `^${re}(?:/.*)?$`);
}

export const matchesGlob = (p: string, glob: string): boolean => globToRegExp(glob).test(p);

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "target", "vendor", ".venv", "venv", "__pycache__", ".next", ".turbo", "coverage", ".harness"]);

const skipPath = (rel: string) => rel.split("/").some((seg, i, all) => i < all.length - 1 && (SKIP_DIRS.has(seg) || seg.startsWith(".")));

/** Files git knows about (tracked + untracked, honoring .gitignore), relative to cwd; null outside a repository. */
function gitFiles(cwd: string): string[] | null {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    }).toString();
    return [...new Set(out.split("\0").filter(Boolean))].filter((f) => fs.existsSync(path.join(cwd, f)));
  } catch {
    return null;
  }
}

/**
 * Lists repository files (forward-slash, relative), skipping dependency/build folders and dot-directories.
 * Inside a git repository it uses `git ls-files`, so .gitignore is honored and large trees stay fast.
 */
export function listFiles(cwd: string, opts: { exts?: string[]; limit?: number } = {}): string[] {
  const limit = opts.limit ?? 50_000;
  const keep = (f: string) => !opts.exts || opts.exts.some((x) => f.endsWith(x));
  const fromGit = gitFiles(cwd);
  if (fromGit) return fromGit.filter((f) => !skipPath(f) && keep(f)).sort().slice(0, limit);
  const out: string[] = [];
  const walk = (rel: string) => {
    if (out.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(child);
      } else if (keep(child)) {
        out.push(child);
        if (out.length >= limit) return;
      }
    }
  };
  walk("");
  return out.sort();
}

/** Paths (relative to cwd) that git ignores; empty outside a repository. */
export function gitIgnored(cwd: string, paths: string[]): Set<string> {
  if (!paths.length) return new Set();
  try {
    const r = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd, input: paths.join("\n"), encoding: "utf8" });
    return new Set((r.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Expands directory globs like `packages/*` or `apps/**` into existing directories. */
export function expandDirGlobs(cwd: string, globs: string[]): string[] {
  const found = new Set<string>();
  for (const g of globs) {
    const clean = g.replace(/^\.\//, "").replace(/\/$/, "");
    if (!/[*?]/.test(clean)) {
      if (fs.existsSync(path.join(cwd, clean))) found.add(clean);
      continue;
    }
    const exact = globToRegExp(clean, { prefix: false });
    const walk = (rel: string, depth: number) => {
      if (depth > 6) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (exact.test(child)) found.add(child);
        walk(child, depth + 1);
      }
    };
    walk("", 0);
  }
  return [...found].sort();
}

/** Parses JSON with comments and trailing commas (tsconfig.json, .vscode files). */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * Resolves where a missing path went, using git's rename history (files and whole directories,
 * following chains like a → b → c). Returns null when git has no rename that explains it.
 */
export function renameResolver(cwd: string): (missing: string) => string | null {
  let map: Map<string, string> | null = null;
  const load = () => {
    map = new Map();
    try {
      const out = execFileSync("git", ["log", "--format=", "--name-status", "-M", "-z", "--diff-filter=R"], { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 }).toString();
      const parts = out.split("\0").filter(Boolean);
      const pairs: [string, string][] = [];
      for (let i = 0; i + 2 < parts.length + 1; i += 3) if (/^R\d*$/.test(parts[i]) && parts[i + 2] !== undefined) pairs.push([parts[i + 1], parts[i + 2]]);
      // git log is newest first; replay oldest first so later renames win.
      for (const [from, to] of pairs.reverse()) map.set(from, to);
    } catch {
      /* not a git repository */
    }
    return map;
  };
  const follow = (p: string): string | null => {
    let cur = p;
    for (let i = 0; i < 20 && map!.has(cur); i++) cur = map!.get(cur)!;
    return cur !== p && fs.existsSync(path.join(cwd, cur)) ? cur : null;
  };
  return (missing) => {
    if (!map) load();
    const clean = missing.replace(/\/$/, "");
    const file = follow(clean);
    if (file) return file;
    // Directory: every renamed file under it must point to the same new directory.
    const prefixes = new Set<string>();
    for (const [from] of map!) {
      if (!from.startsWith(`${clean}/`)) continue;
      const rest = from.slice(clean.length);
      const to = follow(from);
      if (!to || !to.endsWith(rest)) return null;
      prefixes.add(to.slice(0, to.length - rest.length));
    }
    if (prefixes.size !== 1) return null;
    const dir = [...prefixes][0];
    return fs.existsSync(path.join(cwd, dir)) ? dir : null;
  };
}

let gitAvailable: boolean | undefined;
/** Whether the git executable is available in PATH (memoized). */
export function hasGit(): boolean {
  if (gitAvailable === undefined) {
    const r = spawnSync("git", ["--version"], { stdio: "ignore" });
    gitAvailable = !r.error && r.status === 0;
  }
  return gitAvailable;
}

export const GIT_MISSING = "git was not found in PATH. Install it from https://git-scm.com/downloads (on Windows: `winget install --id Git.Git -e`), then open a new terminal.";
