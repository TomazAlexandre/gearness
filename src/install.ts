import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { HarnessConfig } from "./config.js";
import { PACKAGE } from "./meta.js";
import { parseJsonc, readFile, writeFile } from "./util.js";

export const INTEGRATIONS = ["claude", "git", "mcp", "cursor", "codex"] as const;
/** cursor and codex are experimental and opt-in: ask for them with `--only cursor` / `--only codex`. */
export const DEFAULT_INTEGRATIONS: Integration[] = ["claude", "git", "mcp"];
export type Integration = (typeof INTEGRATIONS)[number];

export interface InstallAction {
  integration: Integration;
  file: string;
  action: "added" | "updated" | "unchanged" | "removed" | "manual";
  note?: string;
}

/** Recognizes gearness hook commands however gearness is invoked (npx, local bin, node dist/cli.js). */
const MARK_RE = /\b(?:check --(?:hook claude|staged)|guard --host (?:claude|cursor|codex))\b/;
const isOurs = (text: string | null | undefined) => !!text && MARK_RE.test(text);

/** How hooks and MCP clients should invoke gearness in this repository. */
export function defaultCommand(cwd: string): string {
  const pkg = readFile(path.join(cwd, "package.json"));
  if (pkg) {
    try {
      const p = JSON.parse(pkg);
      if (p.name === PACKAGE) return "node dist/cli.js";
      if (p.devDependencies?.[PACKAGE] || p.dependencies?.[PACKAGE]) return `npx ${PACKAGE}`;
    } catch {
      /* fall through */
    }
  }
  return `npx --yes ${PACKAGE}@0`;
}

const splitCommand = (cmd: string) => {
  const [command, ...args] = cmd.split(/\s+/).filter(Boolean);
  return { command, args };
};

function readJson(file: string): Record<string, unknown> {
  const text = readFile(file);
  if (text === null || !text.trim()) return {};
  const v = parseJsonc(text);
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${file} is not a JSON object`);
  return v as Record<string, unknown>;
}

function writeJson(file: string, data: unknown): void {
  writeFile(file, JSON.stringify(data, null, 2) + "\n");
}

type HookGroup = { matcher?: string; hooks?: { type: string; command: string; timeout?: number }[] };

/** Deletes a file we created, and its folder when that leaves it empty (rmdir refuses a folder with anything in it). */
function removeFile(file: string): void {
  fs.rmSync(file, { force: true });
  try {
    fs.rmdirSync(path.dirname(file));
  } catch {
    /* the folder holds other files: leave it */
  }
}

/** Adds, refreshes or (entry = null) removes our group under `hooks[event]`, leaving every other group alone. */
function upsertGroup(hooks: Record<string, HookGroup[]>, event: string, entry: HookGroup | null): "added" | "updated" | "unchanged" | "removed" {
  const current = hooks[event] ?? [];
  const groups = current.filter((g) => !g.hooks?.some((h) => isOurs(h.command)));
  const existed = groups.length !== current.length;
  if (entry === null) {
    if (!existed) return "unchanged";
    if (groups.length) hooks[event] = groups;
    else delete hooks[event];
    return "removed";
  }
  const before = JSON.stringify(current);
  hooks[event] = [...groups, entry];
  return JSON.stringify(hooks[event]) === before ? "unchanged" : existed ? "updated" : "added";
}

function combine(results: ReturnType<typeof upsertGroup>[]): "added" | "updated" | "unchanged" | "removed" {
  if (results.every((r) => r === "unchanged")) return "unchanged";
  if (results.includes("removed")) return "removed";
  return results.every((r) => r === "added") ? "added" : "updated";
}

/**
 * Claude Code hooks. PostToolUse: every edit is checked and violations are fed back to the agent (exit 2).
 * PreToolUse: refuses edits to `protected` paths; installed only while the harness protects something, so a project that
 * does not use the feature pays for no extra process per edit.
 */
function installClaude(cwd: string, cmd: string, remove: boolean, guard: boolean): InstallAction {
  const rel = ".claude/settings.json";
  const file = path.join(cwd, rel);
  const settings = readJson(file);
  const hooks = (settings.hooks ?? {}) as Record<string, HookGroup[]>;
  const post: HookGroup = { matcher: "Edit|MultiEdit|Write", hooks: [{ type: "command", command: `${cmd} check --hook claude`, timeout: 60 }] };
  const pre: HookGroup = { matcher: "Edit|MultiEdit|Write|NotebookEdit", hooks: [{ type: "command", command: `${cmd} guard --host claude`, timeout: 30 }] };
  const action = combine([upsertGroup(hooks, "PostToolUse", remove ? null : post), upsertGroup(hooks, "PreToolUse", remove || !guard ? null : pre)]);
  if (action === "unchanged") return { integration: "claude", file: rel, action };
  settings.hooks = hooks;
  if (!Object.keys(hooks).length) delete settings.hooks;
  writeJson(file, settings);
  return { integration: "claude", file: rel, action };
}

/** Codex PreToolUse hook (experimental). File edits arrive as apply_patch; the matcher also accepts Edit and Write. */
function installCodex(cwd: string, cmd: string, remove: boolean): InstallAction {
  const rel = ".codex/hooks.json";
  const file = path.join(cwd, rel);
  const doc = readJson(file);
  const hooks = (doc.hooks ?? {}) as Record<string, HookGroup[]>;
  const entry: HookGroup = { matcher: "apply_patch|Edit|Write", hooks: [{ type: "command", command: `${cmd} guard --host codex` }] };
  const action = upsertGroup(hooks, "PreToolUse", remove ? null : entry);
  if (action === "unchanged") return { integration: "codex", file: rel, action };
  doc.hooks = hooks;
  if (!Object.keys(hooks).length) delete doc.hooks;
  if (!Object.keys(doc).length) removeFile(file);
  else writeJson(file, doc);
  return {
    integration: "codex",
    file: rel,
    action,
    ...(remove ? {} : { note: "experimental: Codex runs project hooks only once the project is trusted and you have reviewed this hook in /hooks.\nRestart Codex afterwards. Check it with: ask the agent to edit a protected file; the edit must be refused." }),
  };
}

/** Cursor preToolUse hook (experimental). Cursor's own file format: a flat list per event, with a tool matcher. */
function installCursor(cwd: string, cmd: string, remove: boolean): InstallAction {
  const rel = ".cursor/hooks.json";
  const file = path.join(cwd, rel);
  const doc = readJson(file);
  const hooks = (doc.hooks ?? {}) as Record<string, { command?: string; matcher?: string }[]>;
  const current = hooks.preToolUse ?? [];
  const kept = current.filter((h) => !isOurs(h.command));
  const existed = kept.length !== current.length;
  if (remove) {
    if (!existed) return { integration: "cursor", file: rel, action: "unchanged" };
    if (kept.length) hooks.preToolUse = kept;
    else delete hooks.preToolUse;
    doc.hooks = hooks;
    if (!Object.keys(hooks).length) delete doc.hooks;
    if (Object.keys(doc).every((k) => k === "version")) removeFile(file);
    else writeJson(file, doc);
    return { integration: "cursor", file: rel, action: "removed" };
  }
  const entry = { command: `${cmd} guard --host cursor`, matcher: "Write|Edit|Delete|StrReplace" };
  hooks.preToolUse = [...kept, entry];
  if (JSON.stringify(hooks.preToolUse) === JSON.stringify(current)) return { integration: "cursor", file: rel, action: "unchanged" };
  doc.version ??= 1;
  doc.hooks = hooks;
  writeJson(file, doc);
  return { integration: "cursor", file: rel, action: existed ? "updated" : "added", note: "experimental: Cursor must reload hooks (it watches the file). Check it with: ask the agent to edit a protected file; the edit must be refused." };
}

function gitHooksDir(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return path.resolve(cwd, out);
  } catch {
    return null;
  }
}

/** Pre-commit check of staged files, through husky when the repo uses it, else a plain git hook. */
function installGit(cwd: string, cmd: string, remove: boolean): InstallAction {
  const line = `${cmd} check --staged`;
  for (const [f, snippet] of [
    ["lefthook.yml", `pre-commit:\n  commands:\n    gearness:\n      run: ${line}`],
    [".pre-commit-config.yaml", `- repo: local\n  hooks:\n    - id: gearness\n      name: gearness\n      entry: ${line}\n      language: system\n      pass_filenames: false`],
  ] as const) {
    const text = readFile(path.join(cwd, f));
    if (text !== null) {
      if (isOurs(text)) return { integration: "git", file: f, action: "unchanged" };
      return { integration: "git", file: f, action: "manual", note: `add this to ${f}:\n${snippet}` };
    }
  }
  const husky = fs.existsSync(path.join(cwd, ".husky"));
  const hooksDir = husky ? path.join(cwd, ".husky") : gitHooksDir(cwd);
  if (!hooksDir) return { integration: "git", file: ".git/hooks/pre-commit", action: "manual", note: "not a git repository" };
  const file = path.join(hooksDir, "pre-commit");
  const rel = path.relative(cwd, file).split(path.sep).join("/");
  const text = readFile(file);
  if (remove) {
    if (!isOurs(text)) return { integration: "git", file: rel, action: "unchanged" };
    const rest = text!.split("\n").filter((l) => !isOurs(l) && l !== "# gearness").join("\n");
    if (/^(#!.*\n?)?\s*$/.test(rest)) fs.rmSync(file);
    else writeFile(file, rest);
    return { integration: "git", file: rel, action: "removed" };
  }
  if (isOurs(text)) {
    if (text!.includes(line)) return { integration: "git", file: rel, action: "unchanged" };
    writeFile(file, text!.split("\n").map((l) => (isOurs(l) ? line : l)).join("\n"));
    return { integration: "git", file: rel, action: "updated" };
  }
  const content = text === null ? `#!/bin/sh\n# gearness\n${line}\n` : `${text.trimEnd()}\n\n# gearness\n${line}\n`;
  writeFile(file, content);
  fs.chmodSync(file, 0o755);
  return { integration: "git", file: rel, action: text === null ? "added" : "updated" };
}

/** Registers the gearness MCP server with the agents this harness targets (project-scoped config files). */
function installMcp(cwd: string, config: HarnessConfig, cmd: string, remove: boolean): InstallAction[] {
  const { command, args } = splitCommand(`${cmd} mcp`);
  const targets: [string, "mcpServers" | "servers", Record<string, unknown>][] = [[".mcp.json", "mcpServers", { command, args }]];
  if (config.agents.includes("cursor")) targets.push([".cursor/mcp.json", "mcpServers", { command, args }]);
  if (config.agents.includes("copilot")) targets.push([".vscode/mcp.json", "servers", { type: "stdio", command, args }]);
  if (config.agents.includes("gemini")) targets.push([".gemini/settings.json", "mcpServers", { command, args }]);
  return targets.map(([rel, key, server]) => {
    const file = path.join(cwd, rel);
    const data = readJson(file);
    const servers = (data[key] ?? {}) as Record<string, unknown>;
    const had = "gearness" in servers;
    if (remove) {
      if (!had) return { integration: "mcp" as const, file: rel, action: "unchanged" as const };
      delete servers.gearness;
      data[key] = servers;
      writeJson(file, data);
      return { integration: "mcp" as const, file: rel, action: "removed" as const };
    }
    if (had && JSON.stringify(servers.gearness) === JSON.stringify(server)) return { integration: "mcp" as const, file: rel, action: "unchanged" as const };
    data[key] = { ...servers, gearness: server };
    writeJson(file, data);
    return { integration: "mcp" as const, file: rel, action: had ? ("updated" as const) : ("added" as const) };
  });
}

export function install(cwd: string, config: HarnessConfig, opts: { only?: Integration[]; command?: string; remove?: boolean } = {}): InstallAction[] {
  const cmd = opts.command ?? defaultCommand(cwd);
  const only = opts.only ?? DEFAULT_INTEGRATIONS;
  const out: InstallAction[] = [];
  if (only.includes("claude")) out.push(installClaude(cwd, cmd, !!opts.remove, config.protected.length > 0));
  if (only.includes("cursor")) out.push(installCursor(cwd, cmd, !!opts.remove));
  if (only.includes("codex")) out.push(installCodex(cwd, cmd, !!opts.remove));
  if (only.includes("git")) out.push(installGit(cwd, cmd, !!opts.remove));
  if (only.includes("mcp")) out.push(...installMcp(cwd, config, cmd, !!opts.remove));
  return out;
}

/** Whether any in-the-loop feedback (agent hook or pre-commit) runs gearness in this repository. */
export function hasLoopFeedback(cwd: string): boolean {
  const files: string[] = [];
  // Workspaces inherit hooks configured at the repository root.
  for (let d = path.resolve(cwd), i = 0; i < 8; i++) {
    files.push(...[".claude/settings.json", ".husky/pre-commit", "lefthook.yml", ".pre-commit-config.yaml"].map((f) => path.join(d, f)));
    if (fs.existsSync(path.join(d, ".git")) || path.dirname(d) === d) break;
    d = path.dirname(d);
  }
  const hooks = gitHooksDir(cwd);
  if (hooks) files.push(path.join(hooks, "pre-commit"));
  return files.some((f) => isOurs(readFile(f)));
}
