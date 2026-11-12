import fs from "node:fs";
import path from "node:path";
import { adapterStatus } from "./adapters.js";
import { CONFIG_FILE, type HarnessConfig } from "./config.js";
import { commandEnv, commandProblems, docCommands } from "./commands.js";
import { checkBoundaries } from "./imports.js";
import { hasLoopFeedback } from "./install.js";
import { loadRatchet } from "./ratchet.js";
import { PLACEHOLDER, RATCHET_FILE } from "./templates.js";
import { expandDirGlobs, gitIgnored, headingAnchors, renameResolver, isExternal, lastModified, lineOf, listFiles, markdownLinks, matchesGlob, readFile } from "./util.js";

export type Severity = "error" | "warn" | "info";
export const PILLARS = ["context", "commands", "architecture", "tooling", "safety", "feedback"] as const;
export type Pillar = (typeof PILLARS)[number];

export interface Diagnostic {
  rule: string;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
  hint?: string;
  /** Safe automatic fix for `lint --fix`: replace every occurrence of `find` with `replace` in `file`. */
  fix?: { find: string; replace: string };
}

export interface Ctx {
  cwd: string;
  config: HarnessConfig;
  read(rel: string): string | null;
  exists(rel: string): boolean;
  /** Repository files (skipping dependencies and build output), optionally filtered by extension. */
  files(exts?: string[]): string[];
  /** Repository files matching a glob. */
  glob(pattern: string): string[];
  now: Date;
}

export type Finding = Omit<Diagnostic, "rule" | "severity"> & { severity?: Severity };

export interface Rule {
  id: string;
  pillar: Pillar;
  /** Points this rule is worth in the doctor score. */
  weight: number;
  severity: Severity;
  description: string;
  check(ctx: Ctx): Finding[];
  /** Optional partial credit (0–1) when findings exist; defaults to a severity-based credit. */
  credit?(ctx: Ctx): number;
}

const placeholderHits = (text: string): number[] => {
  const out: number[] = [];
  let i = text.indexOf(PLACEHOLDER);
  while (i !== -1) {
    out.push(i);
    i = text.indexOf(PLACEHOLDER, i + 1);
  }
  return out;
};

export const contextFiles = (c: HarnessConfig) => [
  c.context.entry,
  ...c.context.docs,
  ...(c.context.status ? [c.context.status] : []),
];

export const SECRET_PATTERNS: [string, RegExp][] = [
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["OpenAI/Anthropic-style API key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe live key", /\b[rs]k_live_[0-9a-zA-Z]{24,}/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["connection string with password", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@]+:[^\s@/]{3,}@/],
];

export const RULES: Rule[] = [
  {
    id: "context/entry-exists",
    pillar: "context",
    weight: 10,
    severity: "error",
    description: "The entry file (AGENTS.md) exists. Without it agents start every task blind.",
    check: ({ config, exists }) =>
      exists(config.context.entry)
        ? []
        : [{ message: `${config.context.entry} not found`, file: config.context.entry, hint: "run `gearness init` or create it by hand" }],
  },
  {
    id: "context/entry-size",
    pillar: "context",
    weight: 6,
    severity: "warn",
    description: "The entry file stays short (lines and approximate tokens). It is a map that points to deeper docs, not an encyclopedia.",
    check: ({ config, read }) => {
      const text = read(config.context.entry);
      if (text === null) return [];
      const out: Finding[] = [];
      const lines = text.split("\n").length;
      const tokens = Math.round(text.length / 4);
      const { maxEntryLines, maxEntryTokens } = config.context;
      const hint = "move detail into docs/ and link to it from the Map section";
      if (lines > maxEntryLines) out.push({ message: `${lines} lines (limit ${maxEntryLines}); long entry files dilute what matters`, file: config.context.entry, hint });
      if (tokens > maxEntryTokens) out.push({ message: `~${tokens} tokens (limit ${maxEntryTokens}); every agent pays this on every task`, file: config.context.entry, hint });
      return out;
    },
  },
  {
    id: "context/docs-exist",
    pillar: "context",
    weight: 8,
    severity: "error",
    description: "Every context document declared in harness.yaml exists.",
    check: ({ config, exists }) =>
      [...config.context.docs, ...(config.context.status ? [config.context.status] : [])]
        .filter((d) => !exists(d))
        .map((d) => ({ message: `declared context doc ${d} is missing`, file: "harness.yaml", hint: "create it or remove it from context.docs" })),
  },
  {
    id: "context/broken-links",
    pillar: "context",
    weight: 8,
    severity: "error",
    description: "Relative links (inline and reference-style) and their #anchors resolve. Agents follow links literally; a dead link is a dead end.",
    check: ({ cwd, config, read, exists }) => {
      const out: Finding[] = [];
      const renamed = renameResolver(cwd);
      const anchorsOf = new Map<string, Set<string>>();
      const anchors = (file: string) => {
        if (!anchorsOf.has(file)) anchorsOf.set(file, headingAnchors(read(file) ?? ""));
        return anchorsOf.get(file)!;
      };
      for (const file of contextFiles(config)) {
        const text = read(file);
        if (text === null) continue;
        for (const link of markdownLinks(text)) {
          if (isExternal(link.target) && !link.target.startsWith("#")) continue;
          const [rawPath, anchor] = link.target.split("#");
          let target = file;
          if (rawPath) {
            const p = safeDecode(rawPath);
            target = p.startsWith("/") ? p.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(file), p));
            if (!exists(target)) {
              const moved = renamed(target);
              if (moved) {
                const rel = path.posix.relative(path.posix.dirname(file), moved) || ".";
                const next = rel + (anchor !== undefined ? `#${anchor}` : "");
                out.push({ message: `broken link to ${link.target} (renamed to ${moved})`, file, line: link.line, hint: "`gearness lint --fix` updates the link", fix: { find: `](${link.target})`, replace: `](${next})` } });
              } else out.push({ message: `broken link to ${link.target}`, file, line: link.line, hint: "fix the path or remove the link" });
              continue;
            }
          }
          if (anchor && /\.mdx?$/i.test(target) && !anchors(target).has(safeDecode(anchor).toLowerCase()))
            out.push({ message: `anchor #${anchor} not found in ${target}`, file, line: link.line, hint: "headings changed? update the anchor" });
        }
      }
      return out;
    },
  },
  {
    id: "context/stale-references",
    pillar: "context",
    weight: 6,
    severity: "warn",
    description: "File and folder paths cited in context docs (in `code`) still exist. Renamed code with stale docs sends agents to places that are gone.",
    check: ({ cwd, config, read, exists }) => {
      const candidates: { file: string; line: number; ref: string; resolved: string[] }[] = [];
      for (const file of contextFiles(config)) {
        const text = read(file);
        if (text === null) continue;
        const noFences = text.replace(/```[\s\S]*?```/g, (b) => b.replace(/[^\n]/g, " "));
        const lines = noFences.split("\n");
        lines.forEach((lineText, i) => {
          if (lineText.includes(PLACEHOLDER)) return; // scaffold examples are not claims about the repo
          for (const m of lineText.matchAll(/`([^`\s]+)`/g)) {
            const ref = m[1].replace(/:\d+(?::\d+)?$/, "").replace(/^\.\//, "");
            if (!looksLikePath(ref)) continue;
            const clean = ref.replace(/\/$/, "");
            const first = clean.split("/")[0];
            const docDir = path.posix.dirname(file);
            const fromDoc = path.posix.normalize(path.posix.join(docDir, clean));
            // Only judge references anchored in this repository, so prose like `and/or` is ignored.
            const anchored = exists(first) || (docDir !== "." && exists(path.posix.join(docDir, first)));
            if (!anchored || exists(clean) || exists(fromDoc)) continue;
            candidates.push({ file, line: i + 1, ref: m[1], resolved: [clean, fromDoc] });
          }
        });
      }
      // Paths that git ignores (build output, eval results…) legitimately may not exist yet.
      // Directory patterns like `out/` only match paths with a trailing slash, so ask about both forms.
      const ignored = gitIgnored(cwd, candidates.flatMap((c) => c.resolved.flatMap((r) => [r, `${r}/`])));
      const renamed = renameResolver(cwd);
      return candidates
        .filter((c) => !c.resolved.some((r) => ignored.has(r) || ignored.has(`${r}/`)))
        .map((c) => {
          const moved = renamed(c.resolved[0]);
          if (!moved) return { message: `\`${c.ref}\` does not exist`, file: c.file, line: c.line, hint: "renamed or removed? update the doc so agents are not sent to a dead path" };
          // Keep the reference's shape: ./ prefix, trailing slash and :line suffix.
          const suffix = /:\d+(?::\d+)?$/.exec(c.ref)?.[0] ?? "";
          const next = `${c.ref.startsWith("./") ? "./" : ""}${moved}${c.ref.replace(suffix, "").endsWith("/") ? "/" : ""}${suffix}`;
          return { message: `\`${c.ref}\` does not exist (renamed to ${moved})`, file: c.file, line: c.line, hint: "`gearness lint --fix` updates the reference", fix: { find: `\`${c.ref}\``, replace: `\`${next}\`` } };
        });
    },
  },
  {
    id: "context/docs-referenced",
    pillar: "context",
    weight: 5,
    severity: "warn",
    description: "Every context doc is linked from the entry file, so agents can discover it (progressive disclosure).",
    check: ({ config, read }) => {
      const entry = read(config.context.entry);
      if (entry === null) return [];
      const dir = path.posix.dirname(config.context.entry);
      const linked = new Set(markdownLinks(entry).map((l) => path.posix.normalize(path.posix.join(dir, l.target.split("#")[0]))));
      return [...config.context.docs, ...(config.context.status ? [config.context.status] : [])]
        .filter((d) => !linked.has(path.posix.normalize(d)) && !entry.includes(d))
        .map((d) => ({ message: `${d} is not referenced from ${config.context.entry}`, file: config.context.entry, hint: "add it to the Map section with one line on when to read it" }));
    },
  },
  {
    id: "context/placeholders",
    pillar: "context",
    weight: 30,
    severity: "warn",
    description: `Scaffolded ${PLACEHOLDER} markers are replaced with real project knowledge. Structure without content is not a harness.`,
    check: ({ config, read }) => {
      const out: Finding[] = [];
      for (const file of contextFiles(config)) {
        const text = read(file);
        if (text === null) continue;
        const hits = placeholderHits(text);
        if (hits.length)
          out.push({ message: `${hits.length} unfilled ${PLACEHOLDER} marker(s)`, file, line: lineOf(text, hits[0]), hint: "replace with concrete facts about this codebase - this is where most of the value is" });
      }
      return out;
    },
    // Each remaining marker costs a share of the points; ~6 left means no credit.
    credit: ({ config, read }) => {
      const total = contextFiles(config).reduce((n, f) => n + placeholderHits(read(f) ?? "").length, 0);
      return Math.max(0, 1 - total / 6);
    },
  },
  {
    id: "context/status-fresh",
    pillar: "context",
    weight: 4,
    severity: "warn",
    description: "The status/handoff file was updated in the last 30 days.",
    check: ({ cwd, config, exists, now }) => {
      const s = config.context.status;
      if (!s || !exists(s)) return [];
      const when = lastModified(cwd, s);
      if (!when) return [];
      const days = Math.floor((now.getTime() - when.getTime()) / 86_400_000);
      return days > 30 ? [{ message: `last updated ${days} days ago`, file: s, hint: "stale handoff notes mislead agents; update or trim it" }] : [];
    },
  },
  {
    id: "commands/defined",
    pillar: "commands",
    weight: 8,
    severity: "warn",
    description: "A `test` command and at least one static check (`lint` or `typecheck`) are declared, so agents can verify their work.",
    check: ({ config }) => {
      const out: Finding[] = [];
      if (!config.commands.test) out.push({ message: "no `test` command declared", file: "harness.yaml", hint: "agents that cannot run tests cannot know they are done" });
      if (!config.commands.lint && !config.commands.typecheck)
        out.push({ message: "no `lint` or `typecheck` command declared", file: "harness.yaml", hint: "static checks are the cheapest, fastest guardrail for agents" });
      return out;
    },
  },
  {
    id: "commands/resolvable",
    pillar: "commands",
    weight: 8,
    severity: "error",
    description: "Declared commands point to scripts/targets that exist (package.json, Makefile, justfile, Taskfile) and use the repository's package manager.",
    check: ({ cwd, config }) => {
      const env = commandEnv(cwd);
      return Object.entries(config.commands).flatMap(([name, cmd]) =>
        commandProblems(cmd, env).map((p) => ({ message: `commands.${name}: ${p}`, file: CONFIG_FILE })),
      );
    },
  },
  {
    id: "commands/docs-runnable",
    pillar: "commands",
    weight: 6,
    severity: "warn",
    description: "Commands that context docs tell agents to run exist and use this repository's package manager. Agents run what docs say, literally.",
    check: ({ cwd, config, read }) => {
      const env = commandEnv(cwd);
      const out: Finding[] = [];
      for (const file of contextFiles(config)) {
        const text = read(file);
        if (text === null) continue;
        const lines = text.split("\n");
        for (const { cmd, line } of docCommands(text)) {
          if (lines[line - 1]?.includes(PLACEHOLDER)) continue;
          for (const p of commandProblems(cmd, env)) out.push({ message: p, file, line, hint: "fix the doc or add the script - an agent will try to run exactly this" });
        }
      }
      return out;
    },
  },
  {
    id: "commands/documented",
    pillar: "commands",
    weight: 5,
    severity: "warn",
    description: "Every declared command appears in the entry file, so agents see how to verify without opening harness.yaml.",
    check: ({ config, read }) => {
      const entry = read(config.context.entry);
      if (entry === null) return [];
      return Object.entries(config.commands)
        .filter(([, cmd]) => !entry.includes(cmd))
        .map(([name, cmd]) => ({ message: `command \`${cmd}\` (${name}) is not mentioned`, file: config.context.entry, hint: "add it to the Commands table" }));
    },
  },
  {
    id: "tooling/adapters-in-sync",
    pillar: "tooling",
    weight: 8,
    severity: "error",
    description: "Agent-specific instruction files (CLAUDE.md, Cursor rules, Copilot instructions) match the entry file.",
    check: ({ cwd, config, exists }) => {
      if (!exists(config.context.entry)) return [];
      const out: Finding[] = [];
      for (const s of adapterStatus(cwd, config)) {
        if (!s.file) continue;
        if (s.state === "missing") out.push({ message: `${s.agent} adapter is missing`, file: s.file, hint: "run `gearness sync`" });
        if (s.state === "drifted") out.push({ message: `${s.agent} adapter is out of date with ${config.context.entry}`, file: s.file, hint: "run `gearness sync` (or `gearness lint --fix`)" });
        if (s.state === "unmanaged")
          out.push({ severity: "warn", message: `${s.file} is hand-written and can diverge from ${config.context.entry}`, file: s.file, hint: "merge its content into the entry file, then `gearness sync --force`" });
      }
      return out;
    },
  },
  {
    id: "safety/no-secrets",
    pillar: "safety",
    weight: 10,
    severity: "error",
    description: "Context files contain no credentials. Everything in them is sent to model providers.",
    check: ({ cwd, config, read }) => {
      const files = [...contextFiles(config), ...adapterStatus(cwd, config).flatMap((s) => (s.file ? [s.file] : []))];
      const out: Finding[] = [];
      for (const file of files) {
        const text = read(file);
        if (text === null) continue;
        for (const [label, re] of SECRET_PATTERNS) {
          const m = re.exec(text);
          if (m) out.push({ message: `possible ${label}`, file, line: lineOf(text, m.index), hint: "remove it and rotate the credential" });
        }
      }
      return out;
    },
  },
  {
    id: "feedback/ci-gate",
    pillar: "feedback",
    weight: 8,
    severity: "warn",
    description: "CI runs the project's checks or the harness gate on every change, so agent output is verified mechanically.",
    check: ({ cwd, config }) => {
      // CI usually lives at the repository root, so look upward from workspaces until the git root.
      const dirs: string[] = [];
      for (let d = path.resolve(cwd), i = 0; i < 8; i++) {
        dirs.push(d);
        if (fs.existsSync(path.join(d, ".git")) || path.dirname(d) === d) break;
        d = path.dirname(d);
      }
      const files: string[] = [];
      for (const d of dirs) {
        const wf = path.join(d, ".github/workflows");
        if (fs.existsSync(wf)) for (const f of fs.readdirSync(wf)) if (/\.ya?ml$/.test(f)) files.push(path.join(wf, f));
        for (const f of [".gitlab-ci.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", ".circleci/config.yml", "Jenkinsfile"]) files.push(path.join(d, f));
      }
      const needles = ["gearness", ...Object.values(config.commands).filter((c) => c !== config.commands.install)];
      const covered = files.some((f) => {
        const t = readFile(f);
        return t !== null && needles.some((n) => t.includes(n));
      });
      return covered ? [] : [{ message: "no CI pipeline runs the declared checks or the harness gate", hint: "add .github/workflows/gearness.yml (created by `gearness init`) or run your test command in CI" }];
    },
  },
  {
    id: "feedback/ratchet-valid",
    pillar: "feedback",
    weight: 6,
    severity: "error",
    description: "Each ratchet entry points to an artifact that exists, so learned lessons cannot silently disappear.",
    check: ({ cwd, config, exists, read }) => {
      const log = loadRatchet(cwd);
      if (log.error) return [{ message: log.error, file: RATCHET_FILE }];
      const entry = read(config.context.entry) ?? "";
      const out: Finding[] = [];
      for (const e of log.entries) {
        if (!e.id || !e.failure || !e.fix || !e.artifact) {
          out.push({ message: `entry ${e.id ?? "(no id)"} is missing id/failure/fix/artifact`, file: RATCHET_FILE });
          continue;
        }
        if (!exists(e.artifact)) out.push({ message: `${e.id}: artifact ${e.artifact} no longer exists`, file: RATCHET_FILE, hint: "restore the guardrail or record why it was retired" });
        if (e.fix === "doc" && !entry.includes(`(${e.id})`))
          out.push({ message: `${e.id}: learned rule was removed from ${config.context.entry}`, file: config.context.entry, hint: "restore it, or replace it with a mechanical check and update the entry" });
      }
      return out;
    },
  },
  {
    id: "feedback/ratchet-active",
    pillar: "feedback",
    weight: 4,
    severity: "info",
    description: "The team records agent failures as durable fixes (at least one ratchet entry).",
    check: ({ cwd }) =>
      loadRatchet(cwd).entries.length
        ? []
        : [{ message: "no ratchet entries yet", file: RATCHET_FILE, hint: "next time an agent repeats a mistake, run `gearness ratchet add`" }],
  },
  {
    id: "architecture/boundaries",
    pillar: "architecture",
    weight: 8,
    severity: "error",
    description: "Declared architecture boundaries hold in the real imports (TS/JS, Python, Go). Mechanical boundaries stop agents from taking shortcuts across layers.",
    check: ({ cwd, config }) => {
      if (!config.boundaries.length)
        return [{ severity: "info", message: "no architecture boundaries declared", file: CONFIG_FILE, hint: "declare at least one rule like `from: src/ui/**` / `deny: [src/db/**]` under `boundaries`" }];
      const { violations, scanned } = checkBoundaries(cwd, config.boundaries);
      const out: Finding[] = violations.map((v) => ({
        message: `imports ${v.spec} (crosses ${v.boundary.from} ✗ ${v.denied})${v.boundary.message ? ` - ${v.boundary.message}` : ""}`,
        file: v.file,
        line: v.line,
        hint: "go through the allowed layer instead of importing across the boundary",
      }));
      if (!scanned) out.push({ severity: "warn", message: "no source files match any boundary `from` glob", file: CONFIG_FILE, hint: "check the globs; a boundary that matches nothing protects nothing" });
      return out;
    },
  },
  {
    id: "context/workspaces",
    pillar: "context",
    weight: 5,
    severity: "warn",
    description: "In a monorepo, every declared workspace has its own harness and is linked from the root entry file.",
    check: ({ cwd, config, read, exists }) => {
      if (!config.workspaces.length) return [];
      const dirs = expandDirGlobs(cwd, config.workspaces);
      const entry = read(config.context.entry) ?? "";
      const out: Finding[] = [];
      if (!dirs.length) out.push({ message: `\`workspaces\` globs match no directories`, file: CONFIG_FILE });
      for (const d of dirs) {
        if (!exists(`${d}/${CONFIG_FILE}`)) out.push({ message: `workspace ${d} has no ${CONFIG_FILE}`, file: CONFIG_FILE, hint: `run \`gearness init --cwd ${d}\`` });
        else if (!entry.includes(`${d}/`)) out.push({ message: `workspace ${d} is not linked from ${config.context.entry}`, file: config.context.entry, hint: "add it to the Workspaces section" });
      }
      return out;
    },
  },
  {
    id: "feedback/agent-loop",
    pillar: "feedback",
    weight: 5,
    severity: "info",
    description: "Harness checks run while the agent works (Claude Code hook) or before each commit (git hook), not only in CI.",
    check: ({ cwd }) =>
      hasLoopFeedback(cwd) ? [] : [{ message: "no agent hook or pre-commit hook runs gearness", hint: "run `gearness install` - agents get feedback seconds after an edit instead of minutes later in CI" }],
  },
  {
    id: "feedback/evals-defined",
    pillar: "feedback",
    weight: 4,
    severity: "info",
    description: "Eval tasks exist, so the team can measure whether harness changes actually help agents (`gearness eval`).",
    check: ({ config, exists, glob }) => {
      const tasks = exists(config.eval.tasks) ? glob(`${config.eval.tasks}/*.y*ml`) : [];
      return tasks.length ? [] : [{ message: "no eval tasks yet", file: config.eval.tasks, hint: "create one with `gearness eval new <id>`" }];
    },
  },
];

export interface RuleRun {
  rule: Rule;
  diagnostics: Diagnostic[];
  credit?: number;
}

export function makeCtx(cwd: string, config: HarnessConfig, now = new Date()): Ctx {
  let all: string[] | null = null;
  const files = () => (all ??= listFiles(cwd, { limit: 50_000 }));
  // Dot-directories (like .harness) are skipped by listFiles, so globs fall back to a direct walk of the base dir.
  const glob = (pattern: string) => {
    const base = pattern.split(/[*?]/)[0].replace(/\/[^/]*$/, "");
    const pool = base.startsWith(".") ? listFiles(path.join(cwd, base)).map((f) => `${base}/${f}`) : files();
    return pool.filter((f) => matchesGlob(f, pattern));
  };
  return {
    cwd,
    config,
    now,
    read: (rel) => readFile(path.join(cwd, rel)),
    exists: (rel) => fs.existsSync(path.join(cwd, rel)),
    files: (exts) => (exts ? files().filter((f) => exts.some((x) => f.endsWith(x))) : files()),
    glob,
  };
}

export function runRules(cwd: string, config: HarnessConfig, now = new Date(), extra: Rule[] = []): RuleRun[] {
  const ctx = makeCtx(cwd, config, now);
  return [...RULES, ...extra].filter((r) => !config.rules.disable.includes(r.id)).map((rule) => {
    let findings: Finding[];
    try {
      findings = rule.check(ctx);
    } catch (e) {
      findings = [{ severity: "error", message: `rule crashed: ${(e as Error).message}`, hint: "this is a bug in the rule, not in your harness" }];
    }
    const diagnostics = findings.map((f) => ({ ...f, rule: rule.id, severity: f.severity ?? rule.severity }));
    return { rule, diagnostics, credit: diagnostics.length && rule.credit ? rule.credit(ctx) : undefined };
  });
}


function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A slash-separated relative path without globs, URLs, spaces or placeholders. */
function looksLikePath(ref: string): boolean {
  if (!ref.includes("/") || ref.startsWith("/") || ref.startsWith("../") || ref.includes("://")) return false;
  if (/[*?{}<>$|\\'",;=]|\s/.test(ref) || ref.startsWith("@") || ref.startsWith("-")) return false;
  return /^[\w.()[\]-]+(?:\/[\w.()[\]@+-]+)*\/?$/.test(ref);
}
