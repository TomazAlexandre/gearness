import path from "node:path";
import { type AgentId, type HarnessConfig, loadConfig } from "./config.js";
import { exists, expandDirGlobs, isExternal, posix, readFile, writeFile } from "./util.js";

export const GENERATED_MARK = "gearness:generated";

export interface Adapter {
  agent: AgentId;
  /** File the agent tool reads. null = the tool reads the entry file natively. */
  file: string | null;
  render(entryContent: string, entryPath: string): string;
}

const header = (entry: string) =>
  `<!-- ${GENERATED_MARK} from ${entry} - do not edit by hand. Edit ${entry}, then run \`gearness sync\`. -->`;

/** Rewrites relative markdown links so a copy placed in another directory still resolves. */
export function rewriteLinks(md: string, fromFile: string, toFile: string): string {
  const fromDir = path.posix.dirname(fromFile);
  const toDir = path.posix.dirname(toFile);
  if (fromDir === toDir) return md;
  return md.replace(/(\[[^\]]*\]\(\s*<?)([^)\s>]+)/g, (all, prefix: string, target: string) => {
    if (isExternal(target) || target.startsWith("/")) return all;
    const [p, anchor] = target.split("#");
    const repoRel = path.posix.normalize(path.posix.join(fromDir, p));
    let out = path.posix.relative(toDir, repoRel) || ".";
    if (anchor !== undefined) out += `#${anchor}`;
    return prefix + out;
  });
}

const pointer = (title: string, entry: string) => {
  const target = posix(path.posix.relative(".", entry));
  return [header(entry), "", `# ${title}`, "", `Agent instructions for this repository live in [${target}](${target}).`, "", `@${target}`, ""].join("\n");
};

const copy = (file: string, frontmatter: string[] = []) => (content: string, entry: string) =>
  [...(frontmatter.length ? ["---", ...frontmatter, "---"] : []), header(entry), "", rewriteLinks(content, entry, file).trimEnd(), ""].join("\n");

export const ADAPTERS: Record<AgentId, Adapter> = {
  codex: { agent: "codex", file: null, render: () => "" },
  claude: {
    agent: "claude",
    file: "CLAUDE.md",
    // Claude Code supports @imports, so a pointer stays in sync with no copy.
    render: (_c, entry) => pointer("CLAUDE.md", entry),
  },
  gemini: {
    agent: "gemini",
    file: "GEMINI.md",
    // Gemini CLI also supports @file imports in GEMINI.md.
    render: (_c, entry) => pointer("GEMINI.md", entry),
  },
  cursor: {
    agent: "cursor",
    file: ".cursor/rules/gearness.mdc",
    render: (c, e) => copy(".cursor/rules/gearness.mdc", [`description: Repository agent instructions (generated from ${e})`, "alwaysApply: true"])(c, e),
  },
  copilot: {
    agent: "copilot",
    file: ".github/copilot-instructions.md",
    render: copy(".github/copilot-instructions.md"),
  },
  windsurf: {
    agent: "windsurf",
    file: ".windsurf/rules/gearness.md",
    render: copy(".windsurf/rules/gearness.md", ["trigger: always_on"]),
  },
  cline: {
    agent: "cline",
    file: ".clinerules/gearness.md",
    render: copy(".clinerules/gearness.md"),
  },
};

export type AdapterState = "in-sync" | "missing" | "drifted" | "unmanaged" | "native";

export interface AdapterStatus {
  agent: AgentId;
  file: string | null;
  state: AdapterState;
  expected?: string;
}

/**
 * Copilot only reads instructions from the repository root, so each workspace gets a
 * path-specific file (.github/instructions/<ws>.instructions.md with applyTo: "<ws>/**").
 */
function workspaceCopilot(cwd: string, config: HarnessConfig): { file: string; expected: string }[] {
  if (!config.agents.includes("copilot") || !config.workspaces.length) return [];
  return expandDirGlobs(cwd, config.workspaces).flatMap((ws) => {
    const { config: wc } = loadConfig(path.join(cwd, ws));
    if (!wc) return [];
    const entryRel = `${ws}/${wc.context.entry}`;
    const content = readFile(path.join(cwd, entryRel));
    if (content === null) return [];
    const file = `.github/instructions/${ws.replace(/[^\w.-]+/g, "-")}.instructions.md`;
    const expected = ["---", `applyTo: "${ws}/**"`, "---", header(entryRel), "", rewriteLinks(content, entryRel, file).trimEnd(), ""].join("\n");
    return [{ file, expected }];
  });
}

export function adapterStatus(cwd: string, config: HarnessConfig): AdapterStatus[] {
  const base = rootAdapterStatus(cwd, config);
  const ws = workspaceCopilot(cwd, config).map(({ file, expected }): AdapterStatus => {
    const current = readFile(path.join(cwd, file));
    const state: AdapterState = current === null ? "missing" : !current.includes(GENERATED_MARK) ? "unmanaged" : current === expected ? "in-sync" : "drifted";
    return { agent: "copilot", file, state, expected };
  });
  return [...base, ...ws];
}

function rootAdapterStatus(cwd: string, config: HarnessConfig): AdapterStatus[] {
  const entry = config.context.entry;
  const content = readFile(path.join(cwd, entry));
  return config.agents.map((agent) => {
    const a = ADAPTERS[agent];
    if (!a.file) return { agent, file: null, state: "native" };
    if (content === null) return { agent, file: a.file, state: "missing" };
    const expected = a.render(content, entry);
    const current = readFile(path.join(cwd, a.file));
    if (current === null) return { agent, file: a.file, state: "missing", expected };
    if (!current.includes(GENERATED_MARK)) return { agent, file: a.file, state: "unmanaged", expected };
    return { agent, file: a.file, state: current === expected ? "in-sync" : "drifted", expected };
  });
}

export interface SyncResult {
  agent: AgentId;
  file: string | null;
  action: "written" | "unchanged" | "skipped-unmanaged" | "native" | "no-entry";
}

export function sync(cwd: string, config: HarnessConfig, opts: { force?: boolean; overwrite?: Set<string> } = {}): SyncResult[] {
  return adapterStatus(cwd, config).map((s) => {
    if (s.state === "native") return { agent: s.agent, file: null, action: "native" };
    if (!s.expected || !s.file) return { agent: s.agent, file: s.file, action: "no-entry" };
    if (s.state === "in-sync") return { agent: s.agent, file: s.file, action: "unchanged" };
    if (s.state === "unmanaged" && !opts.force && !opts.overwrite?.has(s.file))
      return { agent: s.agent, file: s.file, action: "skipped-unmanaged" };
    writeFile(path.join(cwd, s.file), s.expected);
    return { agent: s.agent, file: s.file, action: "written" };
  });
}

/** Agent tools whose footprints already exist in the repository. */
export function detectAgents(cwd: string): AgentId[] {
  const signs: [AgentId, string[]][] = [
    ["claude", ["CLAUDE.md", ".claude"]],
    ["cursor", [".cursor", ".cursorrules"]],
    ["copilot", [".github/copilot-instructions.md"]],
    ["gemini", ["GEMINI.md", ".gemini"]],
    ["windsurf", [".windsurf", ".windsurfrules"]],
    ["cline", [".clinerules"]],
  ];
  return signs.filter(([, files]) => files.some((f) => exists(path.join(cwd, f)))).map(([a]) => a);
}
