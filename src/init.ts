import path from "node:path";
import { ADAPTERS, detectAgents, GENERATED_MARK, sync } from "./adapters.js";
import { type AgentId, CONFIG_FILE, DEFAULT_AGENTS, defaultConfig, type HarnessConfig, serializeConfig, type Stack } from "./config.js";
import { detect, detectWorkspaces } from "./detect.js";
import { agentsMd, architectureMd, conventionsMd, RATCHET_FILE, ratchetYaml, statusMd, WORKFLOW_FILE, workflowYml } from "./templates.js";
import { exists, expandDirGlobs, readFile, writeFile } from "./util.js";

export interface InitOptions {
  name?: string;
  description?: string;
  stack?: Stack;
  agents?: AgentId[];
  ci?: boolean;
  force?: boolean;
  dryRun?: boolean;
  /** Also scaffold a harness in every workspace of a monorepo. */
  workspaces?: boolean;
  /** Set when scaffolding a workspace inside a monorepo. */
  nested?: boolean;
}

export interface FileAction {
  file: string;
  action: "created" | "overwritten" | "kept" | "would-create";
}

export interface InitResult {
  config: HarnessConfig;
  files: FileAction[];
  imported: string[];
  notes: string[];
  workspaces: string[];
}

/** Hand-written instruction files we can absorb into AGENTS.md so every agent shares one source. */
const LEGACY = ["CLAUDE.md", ".github/copilot-instructions.md", ".cursorrules", "GEMINI.md", ".windsurfrules"];

/** Agents whose instruction files work from a subdirectory (Copilot only reads the repo root). */
const NESTABLE: AgentId[] = ["claude", "cursor", "codex", "gemini"];

export function init(cwd: string, opts: InitOptions = {}): InitResult {
  if (exists(path.join(cwd, CONFIG_FILE)) && !opts.force)
    throw new Error(`${CONFIG_FILE} already exists in ${cwd}. Use --force to regenerate, or run \`gearness doctor\`.`);

  const d = detect(cwd);
  let agents = opts.agents ?? [...new Set<AgentId>([...DEFAULT_AGENTS, ...detectAgents(cwd)])];
  if (opts.nested) agents = agents.filter((a) => NESTABLE.includes(a));

  const wsGlobs = opts.workspaces ? detectWorkspaces(cwd) : [];
  if (opts.workspaces && !wsGlobs.length) d.notes.push("no workspaces found (package.json, pnpm-workspace.yaml, Cargo.toml, go.work)");
  const wsDirs = expandDirGlobs(cwd, wsGlobs);

  const config = defaultConfig({
    project: { name: opts.name ?? d.name, ...(opts.description ? { description: opts.description } : {}) },
    stack: opts.stack ?? d.stack,
    commands: d.commands,
    agents,
    workspaces: wsGlobs,
  });

  const files: FileAction[] = [];
  const put = (rel: string, content: string) => {
    const abs = path.join(cwd, rel);
    const had = exists(abs);
    if (had && !opts.force) return files.push({ file: rel, action: "kept" });
    if (opts.dryRun) return files.push({ file: rel, action: "would-create" });
    writeFile(abs, content);
    files.push({ file: rel, action: had ? "overwritten" : "created" });
  };

  // Absorb existing hand-written agent instructions instead of discarding them.
  const imported: { source: string; content: string }[] = [];
  const entryExists = exists(path.join(cwd, config.context.entry));
  if (!entryExists) {
    for (const f of LEGACY) {
      const text = readFile(path.join(cwd, f));
      if (text && !text.includes(GENERATED_MARK)) imported.push({ source: f, content: text });
    }
  }

  put(CONFIG_FILE, serializeConfig(config));
  put(config.context.entry, agentsMd(config, imported, wsDirs));
  const [arch, conv] = config.context.docs;
  if (arch) put(arch, architectureMd(config.project.name));
  if (conv) put(conv, conventionsMd(config));
  if (config.context.status) put(config.context.status, statusMd());
  put(RATCHET_FILE, ratchetYaml());
  // Local-only data (violation log for `gearness learn`) stays out of git.
  put(".harness/.gitignore", "telemetry/\n");
  if (opts.ci !== false && !opts.nested) put(WORKFLOW_FILE, workflowYml());

  const adapterFiles = new Set(config.agents.map((a) => ADAPTERS[a].file).filter((f): f is string => !!f));
  if (!opts.dryRun) {
    // Imported files are now preserved inside AGENTS.md, so their adapters may be replaced.
    const overwrite = new Set(imported.map((i) => i.source));
    for (const r of sync(cwd, config, { force: opts.force, overwrite })) {
      if (r.action === "written") files.push({ file: r.file!, action: overwrite.has(r.file!) ? "overwritten" : "created" });
      if (r.action === "skipped-unmanaged") files.push({ file: r.file!, action: "kept" });
    }
  }
  for (const i of imported)
    if (!adapterFiles.has(i.source)) d.notes.push(`${i.source} was imported into ${config.context.entry}; delete it once you have merged the content`);
  if (entryExists) d.notes.push(`existing ${config.context.entry} kept; run \`gearness lint\` to see what it is missing`);

  // Scaffold each workspace with its own harness (skipping ones that already have one).
  for (const ws of wsDirs) {
    if (exists(path.join(cwd, ws, CONFIG_FILE)) && !opts.force) {
      files.push({ file: `${ws}/${CONFIG_FILE}`, action: "kept" });
      continue;
    }
    const r = init(path.join(cwd, ws), { agents: opts.agents, force: opts.force, dryRun: opts.dryRun, nested: true, ci: false });
    files.push(...r.files.map((f) => ({ ...f, file: `${ws}/${f.file}` })));
    d.notes.push(...r.notes.map((n) => `${ws}: ${n}`));
  }
  // Root adapters that depend on workspace entry files (Copilot path instructions) exist only now.
  if (wsDirs.length && !opts.dryRun)
    for (const r of sync(cwd, config)) if (r.action === "written") files.push({ file: r.file!, action: "created" });
  return { config, files, imported: imported.map((i) => i.source), notes: d.notes, workspaces: wsDirs };
}
