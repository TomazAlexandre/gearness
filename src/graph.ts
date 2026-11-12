import fs from "node:fs";
import path from "node:path";
import type { Boundary } from "./config.js";
import { checkBoundaries, extractImports, SOURCE_EXTS, tsAliasResolver } from "./imports.js";
import { listFiles, matchesGlob, readFile } from "./util.js";

/** Globs matching the files isTestFile recognizes, used to exempt tests from inferred boundaries. */
export const TEST_GLOBS = ["**/__tests__/**", "**/test/**", "**/tests/**", "**/spec/**", "**/*.test.*", "**/*.spec.*", "**/*_test.go", "**/test_*.py"];

/** Test globs relevant to the languages and test files actually present (keeps generated config short). */
export function testGlobsFor(files: string[]): string[] {
  const tests = files.filter(isTestFile);
  return TEST_GLOBS.filter((g) => tests.some((f) => matchesGlob(f, g)));
}

export const isTestFile = (f: string) => /(^|\/)(tests?|__tests__|spec|e2e|fixtures?)\//.test(f) || /[._-](test|spec)\.\w+$/.test(f) || /_test\.go$/.test(f) || /(^|\/)test_[^/]+\.py$/.test(f);

export interface ModuleGraph {
  /** Directory under which modules are its direct children ("" = repository root). */
  root: string;
  modules: { id: string; files: number }[];
  edges: { from: string; to: string; count: number }[];
}

/** Picks the directory whose children are the meaningful modules (src, src/main/java/com/acme, …). */
export function autoRoot(files: string[]): string {
  let root = "";
  // A conventional source folder holding most of the code wins even with benchmarks/examples beside it.
  for (const conv of ["src", "lib", "app", "source"]) {
    const n = files.filter((f) => f.startsWith(`${conv}/`)).length;
    if (n >= files.length * 0.5 && files.some((f) => f.startsWith(`${conv}/`) && f.slice(conv.length + 1).includes("/"))) {
      root = conv;
      break;
    }
  }
  for (let i = 0; i < 10; i++) {
    const under = files.filter((f) => (root ? f.startsWith(`${root}/`) : true)).map((f) => (root ? f.slice(root.length + 1) : f));
    const counts = new Map<string, number>();
    for (const f of under) if (f.includes("/")) counts.set(f.split("/")[0], (counts.get(f.split("/")[0]) ?? 0) + 1);
    const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    // Descend while one directory holds almost everything and itself has subdirectories.
    if (!top || top[1] < under.length * 0.8) break;
    const next = root ? `${root}/${top[0]}` : top[0];
    const hasSubdirs = files.some((f) => f.startsWith(`${next}/`) && f.slice(next.length + 1).includes("/"));
    if (!hasSubdirs) break;
    root = next;
  }
  return root;
}

/** Module of a file: the root's direct child directory it lives in, or the root itself. */
export function moduleOf(file: string, root: string): string | null {
  if (root && !file.startsWith(`${root}/`)) return null;
  const rest = root ? file.slice(root.length + 1) : file;
  const parts = rest.split("/");
  if (parts.length === 1) return root || ".";
  return root ? `${root}/${parts[0]}` : parts[0];
}

export function buildGraph(cwd: string, opts: { root?: string; includeTests?: boolean } = {}): ModuleGraph {
  const files = listFiles(cwd, { exts: SOURCE_EXTS }).filter((f) => !/\.d\.ts$/.test(f) && (opts.includeTests || !isTestFile(f)));
  const root = opts.root?.replace(/\/$/, "") ?? autoRoot(files);
  const fileSet = new Set(files);
  const goModule = readFile(path.join(cwd, "go.mod"))?.match(/^module\s+(\S+)/m)?.[1] ?? null;
  const alias = tsAliasResolver(cwd);
  const resolved = new Map<string, string | null>();
  // Map an import target (path without extension, package path, directory) to a real file or directory.
  const resolveTarget = (t: string): string | null => {
    if (resolved.has(t)) return resolved.get(t)!;
    let hit: string | null = null;
    if (fileSet.has(t)) hit = t;
    for (const ext of SOURCE_EXTS) if (!hit && fileSet.has(t + ext)) hit = t + ext;
    for (const idx of ["/index", "/__init__", "/mod"]) for (const ext of SOURCE_EXTS) if (!hit && fileSet.has(t + idx + ext)) hit = t + idx + ext;
    if (!hit && fs.existsSync(path.join(cwd, t)) && fs.statSync(path.join(cwd, t)).isDirectory()) hit = `${t}/`;
    // Package paths (Java/Kotlin/C#/Python src layouts) match files by suffix.
    if (!hit) for (const f of files) if (SOURCE_EXTS.some((ext) => f.endsWith(`/${t}${ext}`))) { hit = f; break; }
    resolved.set(t, hit);
    return hit;
  };
  const sizes = new Map<string, number>();
  const edgeCounts = new Map<string, number>();
  for (const file of files) {
    const from = moduleOf(file, root);
    if (!from) continue;
    sizes.set(from, (sizes.get(from) ?? 0) + 1);
    const src = readFile(path.join(cwd, file));
    if (src === null) continue;
    for (const imp of extractImports(file, src, { goModule, alias })) {
      if (!imp.target) continue;
      const target = resolveTarget(imp.target);
      if (!target) continue;
      const to = moduleOf(target.replace(/\/$/, "/_"), root);
      if (!to || to === from) continue;
      const k = `${from}\u0000${to}`;
      edgeCounts.set(k, (edgeCounts.get(k) ?? 0) + 1);
    }
  }
  return {
    root,
    modules: [...sizes.entries()].map(([id, n]) => ({ id, files: n })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edgeCounts.entries()].map(([k, count]) => {
      const [from, to] = k.split("\u0000");
      return { from, to, count };
    }).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
  };
}

export interface Suggestion {
  boundaries: Boundary[];
  /** Module pairs that import each other; they cannot be layered until the cycle is broken. */
  cycles: [string, string][];
  /** Proposed rules that turned out to have violations (e.g. through unresolved paths) and were dropped. */
  dropped: number;
}

/**
 * Infers boundaries the code already respects: if A imports B and B never imports A,
 * propose "B must not import A". Each proposal is verified to have zero violations today.
 */
export function suggestBoundaries(cwd: string, graph: ModuleGraph, opts: { strict?: boolean; includeTests?: boolean } = {}): Suggestion {
  // The graph ignores tests unless asked, so the proposed rules must not apply to them either.
  // Each boundary gets its own array: shared references would be emitted as YAML anchors.
  const testGlobs = opts.includeTests ? [] : testGlobsFor(listFiles(cwd, { exts: SOURCE_EXTS }));
  const exceptFor = () => (testGlobs.length ? { except: [...testGlobs] } : {});
  const isRoot = (m: string) => m === (graph.root || ".");
  const out = new Map<string, Set<string>>();
  const inn = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (isRoot(e.from) || isRoot(e.to)) continue;
    (out.get(e.from) ?? out.set(e.from, new Set()).get(e.from)!).add(e.to);
    (inn.get(e.to) ?? inn.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  const reach = (start: string, adj: Map<string, Set<string>>) => {
    const seen = new Set<string>();
    const stack = [...(adj.get(start) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(adj.get(n) ?? []));
    }
    return seen;
  };
  const cycles: [string, string][] = [];
  for (const e of graph.edges)
    if (!isRoot(e.from) && !isRoot(e.to) && e.from < e.to && out.get(e.to)?.has(e.from)) cycles.push([e.from, e.to]);
  const proposals: Boundary[] = [];
  if (opts.strict) {
    // Freeze the graph: each module may only import the modules it imports today.
    const mods = graph.modules.map((m) => m.id).filter((m) => !isRoot(m));
    for (const m of mods.sort()) {
      const allowed = out.get(m) ?? new Set<string>();
      const deny = mods.filter((o) => o !== m && !allowed.has(o));
      if (!deny.length) continue;
      const names = [...allowed].map((a) => path.posix.basename(a)).sort();
      proposals.push({
        from: `${m}/**`,
        deny: deny.map((d) => `${d}/**`),
        ...exceptFor(),
        message: `${path.posix.basename(m)} may only depend on ${names.length ? names.join(", ") : "nothing else"}; a new cross-module dependency is an architecture decision (frozen by gearness)`,
      });
    }
    const kept = proposals.filter((b) => checkBoundaries(cwd, [b]).violations.length === 0);
    return { boundaries: kept, cycles, dropped: proposals.length - kept.length };
  }
  for (const m of [...inn.keys()].sort()) {
    // Everything that depends on m, directly or transitively, except modules m itself reaches (cycles).
    const below = reach(m, out);
    const deps = [...reach(m, inn)].filter((d) => d !== m && !below.has(d)).sort();
    if (!deps.length) continue;
    const direct = [...(inn.get(m) ?? [])].filter((d) => deps.includes(d)).map((d) => path.posix.basename(d));
    proposals.push({
      from: `${m}/**`,
      deny: deps.map((d) => `${d}/**`),
      ...exceptFor(),
      message: `${path.posix.basename(m)} is a lower layer used by ${direct.join(", ")}; it must not depend on the layers above it (inferred by gearness)`,
    });
  }
  const kept = proposals.filter((b) => checkBoundaries(cwd, [b]).violations.length === 0);
  return { boundaries: kept, cycles, dropped: proposals.length - kept.length };
}

/** Mermaid flowchart of the module graph; edges with boundary violations are drawn red, cycles orange. */
export function toMermaid(graph: ModuleGraph, violations: { from: string; to: string }[] = []): string {
  const ids = new Map(graph.modules.map((m, i) => [m.id, `m${i}`]));
  const label = (id: string) => (graph.root && id.startsWith(`${graph.root}/`) ? id.slice(graph.root.length + 1) : id);
  const lines = ["flowchart LR"];
  for (const m of graph.modules) lines.push(`  ${ids.get(m.id)}["${label(m.id)}<br/>${m.files} file${m.files === 1 ? "" : "s"}"]`);
  const bad = new Set(violations.map((v) => `${v.from}\u0000${v.to}`));
  const both = new Set(graph.edges.map((e) => `${e.from}\u0000${e.to}`));
  const styles: string[] = [];
  graph.edges.forEach((e, i) => {
    lines.push(`  ${ids.get(e.from)} -->|${e.count}| ${ids.get(e.to)}`);
    if (bad.has(`${e.from}\u0000${e.to}`)) styles.push(`  linkStyle ${i} stroke:#d73a49,stroke-width:3px`);
    else if (both.has(`${e.to}\u0000${e.from}`)) styles.push(`  linkStyle ${i} stroke:#e36209,stroke-width:2px,stroke-dasharray:4`);
  });
  return [...lines, ...styles].join("\n");
}

export function toDot(graph: ModuleGraph, violations: { from: string; to: string }[] = []): string {
  const bad = new Set(violations.map((v) => `${v.from}\u0000${v.to}`));
  return [
    "digraph modules {",
    "  rankdir=LR; node [shape=box, style=rounded];",
    ...graph.modules.map((m) => `  "${m.id}" [label="${m.id}\\n${m.files} files"];`),
    ...graph.edges.map((e) => `  "${e.from}" -> "${e.to}" [label="${e.count}"${bad.has(`${e.from}\u0000${e.to}`) ? ", color=red, penwidth=2" : ""}];`),
    "}",
  ].join("\n");
}

/** Module-level edges that carry at least one declared-boundary violation. */
export function violationEdges(cwd: string, graph: ModuleGraph, boundaries: Boundary[]): { from: string; to: string }[] {
  if (!boundaries.length) return [];
  const out = new Map<string, { from: string; to: string }>();
  for (const v of checkBoundaries(cwd, boundaries).violations) {
    const from = moduleOf(v.file, graph.root);
    const target = v.denied.replace(/\/\*\*$/, "");
    // Most specific module containing the denied path (so "src/ui" wins over the root "src").
    const containing = graph.modules.filter((m) => m.id === target || target.startsWith(`${m.id}/`)).sort((a, b) => b.id.length - a.id.length);
    const to = (containing[0] ?? graph.modules.find((m) => m.id.startsWith(`${target}/`)))?.id;
    if (from && to && from !== to) out.set(`${from}\u0000${to}`, { from, to });
  }
  return [...out.values()];
}
