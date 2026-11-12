import path from "node:path";
import type { Boundary } from "./config.js";
import { lineOf, listFiles, matchesGlob, parseJsonc, readFile } from "./util.js";

export const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".py", ".go", ".java", ".kt", ".kts", ".cs"];

export interface ImportRef {
  /** Specifier as written in the source. */
  spec: string;
  /** Repository-relative path the import points to, when it can be resolved. */
  target?: string;
  line: number;
}

/** Removes comments while keeping string contents and line numbers intact (best effort). */
function blankComments(src: string, lang: "js" | "py" | "go" | "jvm"): string {
  if (lang === "py") return src.replace(/#[^\n]*/g, (m) => " ".repeat(m.length));
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, pre: string) => pre + " ".repeat(m.length - pre.length));
}

export type AliasResolver = (spec: string) => string | undefined;

function jsImports(file: string, src: string, alias?: AliasResolver): ImportRef[] {
  const out: ImportRef[] = [];
  const text = blankComments(src, "js");
  const re = /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    const raw = spec.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)) : alias?.(spec);
    const target = raw?.replace(/\.(m|c)?[jt]sx?$/, "");
    out.push({ spec, target, line: lineOf(text, m.index) });
  }
  return out;
}

function pyImports(file: string, src: string): ImportRef[] {
  const out: ImportRef[] = [];
  const text = blankComments(src, "py");
  const re = /^[ \t]*(?:from\s+(\.*)([\w.]*)\s+import\s+([\w*, \t()]+)|import\s+([\w., \t]+))/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const line = lineOf(text, m.index);
    if (m[4] !== undefined) {
      for (const part of m[4].split(",")) {
        const mod = part.trim().split(/\s+as\s+/)[0];
        if (mod) out.push({ spec: mod, target: mod.replace(/\./g, "/"), line });
      }
      continue;
    }
    const dots = m[1].length;
    const mod = m[2];
    if (dots === 0) {
      out.push({ spec: mod, target: mod.replace(/\./g, "/"), line });
    } else {
      let base = path.posix.dirname(file);
      for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
      const rel = mod ? `${base}/${mod.replace(/\./g, "/")}` : base;
      out.push({ spec: `${m[1]}${mod}`, target: path.posix.normalize(rel), line });
    }
  }
  return out;
}

function goImports(src: string, modulePath: string | null): ImportRef[] {
  const out: ImportRef[] = [];
  const text = blankComments(src, "go");
  const push = (spec: string, idx: number) => {
    const target = modulePath && (spec === modulePath || spec.startsWith(`${modulePath}/`)) ? spec.slice(modulePath.length + 1) || "." : undefined;
    out.push({ spec, target, line: lineOf(text, idx) });
  };
  for (const m of text.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) push(m[1], m.index ?? 0);
  for (const block of text.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) {
    const start = (block.index ?? 0) + block[0].indexOf("(") + 1;
    for (const m of block[1].matchAll(/(?:[\w.]+\s+)?"([^"]+)"/g)) push(m[1], start + (m.index ?? 0));
  }
  return out;
}

/** Java/Kotlin `import a.b.C` and C# `using A.B;` - matched as package paths (`a/b/C`). */
function jvmImports(file: string, src: string): ImportRef[] {
  const out: ImportRef[] = [];
  const text = blankComments(src, "jvm");
  const re = file.endsWith(".cs")
    ? /^[ \t]*(?:global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?(\w+(?:\.\w+)*)\s*;/gm
    : /^[ \t]*import\s+(?:static\s+)?(\w+(?:\.\w+)*)(?:\.\*)?(?:\s+as\s+\w+)?\s*;?/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ spec: m[1], target: m[1].replace(/\./g, "/"), line: lineOf(text, m.index) });
  return out;
}

export interface ImportOptions {
  goModule?: string | null;
  alias?: AliasResolver;
}

export function extractImports(file: string, src: string, opts: ImportOptions | string | null = {}): ImportRef[] {
  const o: ImportOptions = typeof opts === "string" || opts === null ? { goModule: opts } : opts;
  if (file.endsWith(".py")) return pyImports(file, src);
  if (file.endsWith(".go")) return goImports(src, o.goModule ?? null);
  if (/\.(java|kts?|cs)$/.test(file)) return jvmImports(file, src);
  return jsImports(file, src, o.alias);
}

/**
 * Builds a resolver for TypeScript/JavaScript path aliases from tsconfig.json or jsconfig.json
 * (`compilerOptions.baseUrl` + `paths`, single `*` wildcards). Returns repository-relative paths.
 */
export function tsAliasResolver(cwd: string): AliasResolver | undefined {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const text = readFile(path.join(cwd, name));
    if (text === null) continue;
    let opts: { baseUrl?: string; paths?: Record<string, string[]> } | undefined;
    try {
      opts = (parseJsonc(text) as { compilerOptions?: typeof opts })?.compilerOptions;
    } catch {
      return undefined;
    }
    if (!opts?.paths) return undefined;
    const base = (opts.baseUrl ?? ".").replace(/\\/g, "/");
    const entries = Object.entries(opts.paths)
      .filter(([, targets]) => Array.isArray(targets) && targets.length)
      // Longest prefix first, so "@/db/*" wins over "@/*".
      .sort((a, b) => b[0].replace("*", "").length - a[0].replace("*", "").length);
    return (spec) => {
      for (const [pattern, targets] of entries) {
        const star = pattern.indexOf("*");
        let rest: string | null = null;
        if (star === -1) rest = spec === pattern ? "" : null;
        else {
          const pre = pattern.slice(0, star);
          const post = pattern.slice(star + 1);
          if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) rest = spec.slice(pre.length, spec.length - post.length);
        }
        if (rest === null) continue;
        const target = targets[0].replace("*", rest);
        return path.posix.normalize(path.posix.join(base, target)).replace(/^\.\//, "");
      }
      return undefined;
    };
  }
  return undefined;
}

export interface Violation {
  file: string;
  line: number;
  spec: string;
  boundary: Boundary;
  denied: string;
}

/** Checks every source file matching a boundary's `from` against its `deny` globs. */
export function checkBoundaries(cwd: string, boundaries: Boundary[], only?: string[]): { violations: Violation[]; scanned: number } {
  if (!boundaries.length) return { violations: [], scanned: 0 };
  const goMod = readFile(path.join(cwd, "go.mod"));
  const goModule = goMod?.match(/^module\s+(\S+)/m)?.[1] ?? null;
  const alias = tsAliasResolver(cwd);
  const files = (only ?? listFiles(cwd, { exts: SOURCE_EXTS })).filter((f) => SOURCE_EXTS.some((x) => f.endsWith(x)) && !/\.d\.ts$/.test(f));
  const violations: Violation[] = [];
  let scanned = 0;
  for (const file of files) {
    const applicable = boundaries.filter((b) => matchesGlob(file, b.from) && !b.except?.some((g) => matchesGlob(file, g)));
    if (!applicable.length) continue;
    const src = readFile(path.join(cwd, file));
    if (src === null) continue;
    scanned++;
    for (const imp of extractImports(file, src, { goModule, alias })) {
      for (const b of applicable) {
        // Files may always import within their own denied area (e.g. src/db/** importing src/db/x).
        const denied = b.deny.find(
          (g) => (imp.target !== undefined && matchesGlob(imp.target, g) && !matchesGlob(file, g)) || (!imp.spec.startsWith(".") && matchesGlob(imp.spec, g) && !matchesGlob(file, g)),
        );
        if (denied) violations.push({ file, line: imp.line, spec: imp.spec, boundary: b, denied });
      }
    }
  }
  return { violations, scanned };
}
