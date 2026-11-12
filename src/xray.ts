/**
 * Context X-ray: approximates what each agent tool loads into its context when working on a path,
 * following each tool's documented loading rules. Approximate by design - it explains cost and overlap.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { AgentId, HarnessConfig } from "./config.js";
import { matchesGlob, posix, readFile } from "./util.js";

export interface LoadedFile {
  file: string;
  tokens: number;
  why: string;
}

export interface AgentContext {
  agent: AgentId;
  /** Loaded automatically for this path. */
  always: LoadedFile[];
  /** Loaded only when the agent decides to (rule descriptions, linked docs). */
  onDemand: LoadedFile[];
  tokens: number;
  /** Text loaded more than once (wasted budget, risk of drift). */
  duplicates: string[];
}

export const tokensOf = (text: string) => Math.ceil(text.length / 4);

/** Directories from the root down to the target's directory: ["", "packages", "packages/api", …]. */
function chain(target: string, isDir: boolean): string[] {
  const dir = isDir ? target.replace(/\/$/, "") : path.posix.dirname(target);
  const parts = dir === "." || dir === "" ? [] : dir.split("/");
  return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
}

const join = (d: string, f: string) => (d ? `${d}/${f}` : f);

function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  try {
    return { data: (YAML.parse(m[1]) as Record<string, unknown>) ?? {}, body: text.slice(m[0].length) };
  } catch {
    return { data: {}, body: text.slice(m[0].length) };
  }
}

const globs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

/** Expands `@path` imports (Claude Code, Gemini CLI) recursively, outside code. */
function withImports(cwd: string, file: string, why: string, seen: Set<string>, depth = 0): LoadedFile[] {
  const text = readFile(path.join(cwd, file));
  if (text === null || seen.has(file) || depth > 5) return [];
  seen.add(file);
  const out: LoadedFile[] = [{ file, tokens: tokensOf(text), why }];
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const m of prose.matchAll(/(?:^|\s)@([\w./-]+\.[A-Za-z]+)/g)) {
    const target = posix(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])));
    out.push(...withImports(cwd, target, `imported by ${file}`, seen, depth + 1));
  }
  return out;
}

export function xray(cwd: string, config: HarnessConfig, target = "."): AgentContext[] {
  const abs = path.resolve(cwd, target);
  const rel = posix(path.relative(cwd, abs)) || ".";
  const isDir = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
  const dirs = chain(rel === "." ? "" : rel, isDir || rel === ".");
  const probe = isDir || rel === "." ? join(rel === "." ? "" : rel, "_") : rel; // a path inside the target for glob tests
  const read = (f: string) => readFile(path.join(cwd, f));
  const exists = (f: string) => read(f) !== null;
  const lf = (file: string, why: string): LoadedFile => ({ file, tokens: tokensOf(read(file) ?? ""), why });
  const linkedDocs = (): LoadedFile[] =>
    [...config.context.docs, ...(config.context.status ? [config.context.status] : [])].filter(exists).map((d) => lf(d, "linked from the entry file"));

  const results: AgentContext[] = [];
  for (const agent of config.agents) {
    const always: LoadedFile[] = [];
    const onDemand: LoadedFile[] = [];
    const seen = new Set<string>();
    if (agent === "codex") {
      for (const d of dirs) for (const name of ["AGENTS.override.md", "AGENTS.md"]) if (exists(join(d, name))) { always.push(lf(join(d, name), d ? `nested in ${d}/` : "repository root")); break; }
    } else if (agent === "claude" || agent === "gemini") {
      const name = agent === "claude" ? "CLAUDE.md" : "GEMINI.md";
      for (const d of dirs) {
        if (exists(join(d, name))) always.push(...withImports(cwd, join(d, name), d ? `nested in ${d}/` : "repository root", seen));
        if (agent === "claude" && exists(join(d, "CLAUDE.local.md"))) always.push(...withImports(cwd, join(d, "CLAUDE.local.md"), "personal (not committed)", seen));
      }
    } else if (agent === "cursor") {
      for (const d of dirs) {
        const rulesDir = join(d, ".cursor/rules");
        if (!fs.existsSync(path.join(cwd, rulesDir))) continue;
        for (const f of fs.readdirSync(path.join(cwd, rulesDir)).filter((f) => /\.mdc?$/.test(f)).sort()) {
          const file = join(rulesDir, f);
          const { data } = frontmatter(read(file) ?? "");
          const g = globs(data.globs);
          const local = d ? probe.slice(d.length + 1) : probe;
          if (data.alwaysApply === true) always.push(lf(file, "alwaysApply"));
          else if (g.some((x) => matchesGlob(local, x))) always.push(lf(file, `globs match (${g.join(", ")})`));
          else if (data.description) onDemand.push(lf(file, "agent-requested (description)"));
        }
      }
      if (exists(".cursorrules")) always.push(lf(".cursorrules", "legacy root rules"));
    } else if (agent === "copilot") {
      if (exists(".github/copilot-instructions.md")) always.push(lf(".github/copilot-instructions.md", "repository-wide"));
      const dir = ".github/instructions";
      if (fs.existsSync(path.join(cwd, dir)))
        for (const f of fs.readdirSync(path.join(cwd, dir)).filter((f) => f.endsWith(".instructions.md")).sort()) {
          const file = `${dir}/${f}`;
          const g = globs(frontmatter(read(file) ?? "").data.applyTo);
          if (g.some((x) => matchesGlob(probe, x))) always.push(lf(file, `applyTo ${g.join(", ")}`));
        }
    } else if (agent === "windsurf" || agent === "cline") {
      const dir = agent === "windsurf" ? ".windsurf/rules" : ".clinerules";
      if (fs.existsSync(path.join(cwd, dir)))
        for (const f of fs.readdirSync(path.join(cwd, dir)).filter((f) => f.endsWith(".md")).sort()) {
          const file = `${dir}/${f}`;
          const trigger = frontmatter(read(file) ?? "").data.trigger;
          if (agent === "cline" || trigger === "always_on") always.push(lf(file, agent === "cline" ? "rules folder" : "trigger: always_on"));
          else onDemand.push(lf(file, `trigger: ${trigger ?? "manual"}`));
        }
    }
    onDemand.push(...linkedDocs().filter((d) => !always.some((a) => a.file === d.file)));
    // Duplicate text: two loaded files whose bodies (minus headers/frontmatter) are the same.
    const norm = (f: string) => frontmatter(read(f) ?? "").body.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim();
    const seenBodies: [string, string][] = [];
    const duplicates: string[] = [];
    for (const a of always) {
      const b = norm(a.file);
      if (b.length < 200) continue; // tiny pointer files (e.g. "@AGENTS.md") are not duplicated content
      // Same text, or one file pasted inside another, means the agent pays for it twice.
      const prev = seenBodies.find(([, pb]) => pb === b || pb.includes(b) || b.includes(pb));
      if (prev) duplicates.push(`${a.file} repeats ${prev[0]}`);
      else seenBodies.push([a.file, b]);
    }
    results.push({ agent, always, onDemand, tokens: always.reduce((n, a) => n + a.tokens, 0), duplicates });
  }
  return results;
}
