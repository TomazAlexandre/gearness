import fs from "node:fs";
import path from "node:path";
import { loadConfig, type HarnessConfig } from "./config.js";
import { matchesGlob } from "./util.js";

/**
 * `gearness guard`: runs BEFORE an agent edits a file and refuses edits to paths the harness protects (generated code,
 * lockfiles, vendored code). It works on the path only: what an edit would contain differs between agents, a path does not.
 *
 * Hosts and what they accept (checked against each vendor's hook documentation):
 *   claude  PreToolUse, deny = JSON `hookSpecificOutput.permissionDecision: "deny"`; allow = no output
 *   cursor  preToolUse, deny = JSON `{permission: "deny", ...}`; allow = `{permission: "allow"}`
 *   codex   PreToolUse, same shape as Claude; Codex REJECTS an explicit "allow", so allow = no output
 *
 * Safety rule: this must never block an agent because of a gearness problem. Any error, malformed input or missing
 * configuration answers "allow", and the output is always valid for the host (an invalid JSON answer from a Cursor
 * preToolUse hook blocks every tool call).
 */
export const GUARD_HOSTS = ["claude", "cursor", "codex"] as const;
export type GuardHost = (typeof GUARD_HOSTS)[number];

/** Tools that change files. Reads and shell commands are never refused here. Codex reports every edit as apply_patch. */
const EDIT_TOOLS = /^(edit|multiedit|write|notebookedit|apply_patch|strreplace|str_replace|delete|edit_file)$/i;
const PATH_KEYS = new Set(["file_path", "filePath", "path", "target_file", "targetFile", "notebook_path"]);
const PATCH_HEADERS = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Resolves symlinks so paths compare equal (macOS: /var is a link to /private/var). Works for files that do not exist
 * yet by resolving the deepest existing ancestor and re-appending the rest. Never throws.
 */
function canonical(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let dir = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(dir), ...tail);
    } catch {
      const up = path.dirname(dir);
      if (up === dir) return abs;
      tail.unshift(path.basename(dir));
      dir = up;
    }
  }
}

/** Files an edit tool call targets: path fields, and the file headers of an apply_patch patch wherever the host nests it. */
export function editedFiles(payload: unknown): string[] {
  const found = new Set<string>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 6 || v === null || v === undefined) return;
    if (typeof v === "string") {
      for (const m of v.matchAll(PATCH_HEADERS)) if (m[1]) found.add(m[1]);
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
    } else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (PATH_KEYS.has(k) && typeof x === "string") found.add(x);
        else visit(x, depth + 1);
      }
    }
  };
  if (isObj(payload)) visit(payload.tool_input ?? payload.toolInput, 0);
  return [...found];
}

export interface GuardDecision {
  allow: boolean;
  reason?: string;
  blocked: { file: string; glob: string }[];
}

const ALLOW: GuardDecision = { allow: true, blocked: [] };

/** Repo-relative POSIX paths for a file: as given (against `root`) and symlink-resolved (against `realRoot`). Outside the repo → none. */
function relativeCandidates(root: string, realRoot: string, abs: string): string[] {
  const out = new Set<string>();
  const pairs: [string, string][] = [[root, abs], [realRoot, canonical(abs)]];
  for (const [r, a] of pairs) {
    const rel = path.relative(r, a);
    if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    out.add(rel.split(path.sep).join("/"));
  }
  return [...out];
}

/** Decides whether a tool call may proceed. Paths outside the repository are never this tool's business. */
export function guardDecision(root: string, config: HarnessConfig, payload: unknown): GuardDecision {
  if (!isObj(payload) || !config.protected.length) return ALLOW;
  if (!EDIT_TOOLS.test(String(payload.tool_name ?? payload.toolName ?? ""))) return ALLOW;
  const roots = payload.workspace_roots;
  const base = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : Array.isArray(roots) && typeof roots[0] === "string" ? roots[0] : root;
  const blocked: GuardDecision["blocked"] = [];
  const realRoot = canonical(root);
  // macOS and Windows file systems ignore case, so `Package-Lock.json` is the protected `package-lock.json` there.
  const fold = process.platform === "win32" || process.platform === "darwin";
  for (const f of editedFiles(payload)) {
    const abs = path.isAbsolute(f) ? f : path.resolve(base, f);
    // Check the path as given AND with symlinks resolved: either one landing on a protected glob blocks the edit.
    for (const p of relativeCandidates(root, realRoot, abs)) {
      const glob = config.protected.find((g) => matchesGlob(p, g) || (fold && matchesGlob(p.toLowerCase(), g.toLowerCase())));
      if (glob) {
        blocked.push({ file: p, glob });
        break;
      }
    }
  }
  if (!blocked.length) return ALLOW;
  const files = blocked.slice(0, 5).map((b) => b.file);
  const globs = [...new Set(blocked.map((b) => b.glob))].join(", ");
  const many = blocked.length > 1;
  // Only paths and globs, never any content from the edit: Codex can echo a denial's context into the visible transcript.
  const reason = `gearness: ${files.join(", ")}${blocked.length > 5 ? " and more" : ""} ${many ? "are" : "is"} protected by harness.yaml (protected: ${globs}). Do not edit ${many ? "them" : "it"}: change the source it comes from, or ask the user to update \`protected\` if this really has to change.`;
  return { allow: false, reason, blocked };
}

/** The exact text a host expects on stdout. Empty means "say nothing". */
export function respond(host: GuardHost, d: GuardDecision): string {
  if (host === "cursor") return `${JSON.stringify(d.allow ? { permission: "allow" } : { permission: "deny", user_message: d.reason, agent_message: d.reason })}\n`;
  if (d.allow) return "";
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } })}\n`;
}

function findRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "harness.yaml"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Reads a hook payload and returns what to print. Never throws. */
export function runGuard(host: GuardHost, input: string, cwd: string): string {
  try {
    const payload: unknown = input.trim() ? JSON.parse(input) : {};
    const hinted = isObj(payload) ? payload.cwd ?? (Array.isArray(payload.workspace_roots) ? payload.workspace_roots[0] : undefined) : undefined;
    const root = findRoot(typeof hinted === "string" && hinted ? hinted : cwd) ?? findRoot(cwd);
    const config = root ? loadConfig(root).config : undefined;
    return respond(host, root && config ? guardDecision(root, config, payload) : ALLOW);
  } catch {
    return respond(host, ALLOW);
  }
}
