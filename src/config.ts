import path from "node:path";
import YAML from "yaml";
import { REPO_URL, SCHEMA_URL } from "./meta.js";
import { readFile } from "./util.js";

export const CONFIG_FILE = "harness.yaml";
export const STACKS = ["node", "python", "go", "java", "rust", "dotnet", "generic"] as const;
export const AGENTS = ["claude", "cursor", "copilot", "codex", "gemini", "windsurf", "cline"] as const;
/** Agents enabled by default; the rest are opt-in or enabled when init detects them. */
export const DEFAULT_AGENTS = ["claude", "cursor", "copilot", "codex"] as const;
export type Stack = (typeof STACKS)[number];
export type AgentId = (typeof AGENTS)[number];

export interface Boundary {
  /** Glob of source files the rule applies to. */
  from: string;
  /** Globs of paths (or package names) those files must not import. */
  deny: string[];
  /** Globs of files exempt from this boundary (e.g. tests that reach across layers). */
  except?: string[];
  message?: string;
}

export interface EvalConfig {
  /** Agent preset (claude, codex, aider, gemini) or a shell command containing {prompt}. */
  agent: string;
  /** Directory of task files. */
  tasks: string;
  timeoutSeconds: number;
}

export interface HarnessConfig {
  version: 1;
  project: { name: string; description?: string };
  stack: Stack;
  /** Named commands an agent uses to verify work, e.g. test, lint, build. */
  commands: Record<string, string>;
  context: {
    /** Entry point read by agents. Single source of truth for all adapters. */
    entry: string;
    /** Deeper documents the entry file points to (progressive disclosure). */
    docs: string[];
    /** Handoff file between sessions. */
    status?: string;
    maxEntryLines: number;
    /** Approximate token budget for the entry file (≈ characters / 4). */
    maxEntryTokens: number;
  };
  agents: AgentId[];
  gates: { minScore: number };
  rules: { disable: string[] };
  /** Architecture boundaries checked against real imports. */
  boundaries: Boundary[];
  /** Sub-projects (globs) that each have their own harness.yaml. */
  workspaces: string[];
  /** npm packages that export extra rules. Local rules are loaded from .harness/rules/. */
  plugins: string[];
  eval: EvalConfig;
}

type Partial2<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

export function defaultConfig(partial: Partial2<HarnessConfig> & { project: { name: string } }): HarnessConfig {
  return {
    version: 1,
    project: { name: partial.project.name, ...(partial.project.description ? { description: partial.project.description } : {}) },
    stack: (partial.stack as Stack) ?? "generic",
    commands: (partial.commands as Record<string, string>) ?? {},
    agents: (partial.agents as AgentId[]) ?? [...DEFAULT_AGENTS],
    gates: { minScore: 70, ...(partial.gates ?? {}) },
    rules: { disable: [], ...(partial.rules ?? {}) } as HarnessConfig["rules"],
    boundaries: (partial.boundaries as Boundary[]) ?? [],
    workspaces: (partial.workspaces as string[]) ?? [],
    plugins: (partial.plugins as string[]) ?? [],
    eval: { agent: "claude", tasks: ".harness/evals", timeoutSeconds: 900, ...(partial.eval ?? {}) },
    context: {
      entry: "AGENTS.md",
      docs: ["docs/ARCHITECTURE.md", "docs/CONVENTIONS.md"],
      status: "docs/STATUS.md",
      maxEntryLines: 150,
      maxEntryTokens: 2500,
      ...(partial.context ?? {}),
    } as HarnessConfig["context"],
  };
}

export interface LoadResult {
  config?: HarnessConfig;
  errors: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function parseConfig(text: string): LoadResult {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    return { errors: [`invalid YAML: ${(e as Error).message.split("\n")[0]}`] };
  }
  const errors: string[] = [];
  if (!isObj(raw)) return { errors: ["root must be a mapping"] };
  const opt = (v: unknown, k: string) => (isObj(v) ? v[k] : undefined);

  if (raw.version !== 1) errors.push("`version` must be 1");
  const project = raw.project;
  if (!isObj(project) || typeof project.name !== "string" || !project.name.trim()) errors.push("`project.name` is required");
  if (raw.stack !== undefined && !STACKS.includes(raw.stack as Stack)) errors.push(`\`stack\` must be one of: ${STACKS.join(", ")}`);
  if (raw.commands !== undefined) {
    if (!isObj(raw.commands)) errors.push("`commands` must be a mapping of name -> shell command");
    else for (const [k, v] of Object.entries(raw.commands)) if (typeof v !== "string") errors.push(`\`commands.${k}\` must be a string`);
  }
  const ctx = raw.context;
  if (ctx !== undefined) {
    if (!isObj(ctx)) errors.push("`context` must be a mapping");
    else {
      if (ctx.entry !== undefined && typeof ctx.entry !== "string") errors.push("`context.entry` must be a path");
      if (ctx.docs !== undefined && !isStrArr(ctx.docs)) errors.push("`context.docs` must be a list of paths");
      if (ctx.status !== undefined && ctx.status !== null && typeof ctx.status !== "string") errors.push("`context.status` must be a path");
      for (const k of ["maxEntryLines", "maxEntryTokens"])
        if (ctx[k] !== undefined && (typeof ctx[k] !== "number" || (ctx[k] as number) < 10)) errors.push(`\`context.${k}\` must be a number >= 10`);
    }
  }
  if (raw.agents !== undefined) {
    if (!isStrArr(raw.agents)) errors.push("`agents` must be a list");
    else for (const a of raw.agents) if (!AGENTS.includes(a as AgentId)) errors.push(`unknown agent \`${a}\` (use: ${AGENTS.join(", ")})`);
  }
  const minScore = opt(raw.gates, "minScore");
  if (minScore !== undefined && (typeof minScore !== "number" || minScore < 0 || minScore > 100))
    errors.push("`gates.minScore` must be between 0 and 100");
  const disable = opt(raw.rules, "disable");
  if (disable !== undefined && !isStrArr(disable)) errors.push("`rules.disable` must be a list of rule ids");
  if (raw.boundaries !== undefined) {
    if (!Array.isArray(raw.boundaries)) errors.push("`boundaries` must be a list");
    else
      raw.boundaries.forEach((b, i) => {
        if (!isObj(b) || typeof b.from !== "string" || !(isStrArr(b.deny) || typeof b.deny === "string"))
          errors.push(`\`boundaries[${i}]\` needs \`from: <glob>\` and \`deny: [<globs>]\``);
        else if (b.except !== undefined && !isStrArr(b.except)) errors.push(`\`boundaries[${i}].except\` must be a list of globs`);
      });
  }
  for (const k of ["workspaces", "plugins"]) if (raw[k] !== undefined && !isStrArr(raw[k])) errors.push(`\`${k}\` must be a list of strings`);
  const ev = raw.eval;
  if (ev !== undefined) {
    if (!isObj(ev)) errors.push("`eval` must be a mapping");
    else {
      if (ev.agent !== undefined && typeof ev.agent !== "string") errors.push("`eval.agent` must be a preset name or a command");
      if (ev.tasks !== undefined && typeof ev.tasks !== "string") errors.push("`eval.tasks` must be a directory");
      if (ev.timeoutSeconds !== undefined && (typeof ev.timeoutSeconds !== "number" || ev.timeoutSeconds <= 0))
        errors.push("`eval.timeoutSeconds` must be a positive number");
    }
  }
  if (errors.length) return { errors };

  const p = project as { name: string; description?: string };
  const c = (ctx ?? {}) as Partial<HarnessConfig["context"]>;
  const config = defaultConfig({
    project: { name: p.name, description: p.description },
    stack: (raw.stack as Stack) ?? "generic",
    commands: (raw.commands as Record<string, string>) ?? {},
    agents: (raw.agents as AgentId[]) ?? [...DEFAULT_AGENTS],
    gates: minScore !== undefined ? { minScore: minScore as number } : {},
    rules: { disable: (disable as string[]) ?? [] },
    boundaries: ((raw.boundaries as Record<string, unknown>[]) ?? []).map((b) => ({
      from: b.from as string,
      deny: typeof b.deny === "string" ? [b.deny] : (b.deny as string[]),
      ...(Array.isArray(b.except) ? { except: b.except as string[] } : {}),
      ...(typeof b.message === "string" ? { message: b.message } : {}),
    })),
    workspaces: (raw.workspaces as string[]) ?? [],
    plugins: (raw.plugins as string[]) ?? [],
    eval: (ev as Partial<EvalConfig>) ?? {},
    context: {
      entry: c.entry ?? "AGENTS.md",
      docs: c.docs ?? [],
      status: c.status ?? undefined,
      maxEntryLines: c.maxEntryLines ?? 150,
      maxEntryTokens: c.maxEntryTokens ?? 2500,
    },
  });
  return { config, errors: [] };
}

export function loadConfig(cwd: string): LoadResult {
  const text = readFile(path.join(cwd, CONFIG_FILE));
  if (text === null) return { errors: [`${CONFIG_FILE} not found - run \`gearness init\``] };
  return parseConfig(text);
}

export function serializeConfig(config: HarnessConfig): string {
  const header = [
    `# yaml-language-server: $schema=${SCHEMA_URL}`,
    "# harness.yaml - declarative description of this repository's agent harness.",
    `# Managed by gearness (${REPO_URL}). Docs: ${REPO_URL}/blob/main/docs/configuration.md`,
    "",
  ].join("\n");
  const body: Record<string, unknown> = {
    version: 1,
    project: config.project,
    stack: config.stack,
    commands: config.commands,
    context: config.context,
    agents: config.agents,
    gates: config.gates,
    rules: config.rules,
  };
  if (config.workspaces.length) body.workspaces = config.workspaces;
  if (config.plugins.length) body.plugins = config.plugins;
  // Always emit boundaries (empty) with a commented example so teams discover the feature.
  const tail = config.boundaries.length
    ? YAML.stringify({ boundaries: config.boundaries }, { lineWidth: 0 })
    : [
        "# Architecture boundaries, checked against real imports by `gearness lint`. Example:",
        "#   - from: \"src/ui/**\"",
        "#     deny: [\"src/db/**\"]",
        "#     message: UI goes through services, never straight to the database",
        "boundaries: []",
        "",
      ].join("\n");
  const evalBlock = YAML.stringify({ eval: config.eval }, { lineWidth: 0 });
  return header + YAML.stringify(JSON.parse(JSON.stringify(body)), { lineWidth: 0 }) + tail + evalBlock;
}
