/**
 * Minimal Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0).
 * Lets agents ask the harness questions while they work: what to read, how to verify,
 * whether an import is allowed, and whether their changes break the rules.
 */
import path from "node:path";
import { createInterface } from "node:readline";
import { checkFiles } from "./check.js";
import { recordEvents } from "./learn.js";
import { type HarnessConfig, loadConfig } from "./config.js";
import { extractImports, tsAliasResolver } from "./imports.js";
import { TOOL, VERSION } from "./meta.js";
import { addEntry, FIX_KINDS, type FixKind } from "./ratchet.js";
import { evaluateTree } from "./score.js";
import { matchesGlob, readFile } from "./util.js";
import { xray } from "./xray.js";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  run(args: Record<string, unknown>, cwd: string, config: HarnessConfig): Promise<unknown> | unknown;
}

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

export const TOOLS: Tool[] = [
  {
    name: "harness_overview",
    description: "Start here. Returns where this repository's agent instructions live, which docs to read for each area, the commands that verify work, architecture boundaries, and the current harness score with its top gaps.",
    inputSchema: obj(),
    annotations: { readOnlyHint: true },
    run: async (_a, cwd, config) => {
      const tree = await evaluateTree(cwd, config);
      const r = tree[0].report!;
      return {
        project: config.project,
        entry: config.context.entry,
        docs: config.context.docs,
        status: config.context.status ?? null,
        commands: config.commands,
        boundaries: config.boundaries,
        workspaces: tree.slice(1).map((w) => ({ dir: w.dir, score: w.report?.score ?? null })),
        score: r.score,
        grade: r.grade,
        topGaps: r.results
          .filter((x) => x.diagnostics.length)
          .sort((a, b) => b.rule.weight - b.earned - (a.rule.weight - a.earned))
          .slice(0, 5)
          .map((x) => ({ rule: x.rule.id, message: x.diagnostics[0].message, hint: x.diagnostics[0].hint })),
      };
    },
  },
  {
    name: "harness_rules_for_path",
    description: "Before editing a file, returns the instruction files that apply to it (root and nested AGENTS.md, path-scoped rules), the architecture boundaries that constrain it, and the docs worth reading on demand.",
    inputSchema: obj({ path: { type: "string", description: "Repository-relative file or directory" } }, ["path"]),
    annotations: { readOnlyHint: true },
    run: (a, cwd, config) => {
      const p = String(a.path);
      const ctx = xray(cwd, { ...config, agents: ["codex"] }, p)[0];
      return {
        instructions: ctx.always.map((f) => ({ file: f.file, why: f.why, tokens: f.tokens })),
        readOnDemand: ctx.onDemand.map((f) => f.file),
        boundaries: config.boundaries.filter((b) => matchesGlob(p, b.from) && !b.except?.some((g) => matchesGlob(p, g))).map((b) => ({ deny: b.deny, why: b.message ?? null })),
        verify: config.commands,
      };
    },
  },
  {
    name: "harness_verify_commands",
    description: "Returns the exact shell commands that must pass before a task counts as done (test, lint, typecheck, build).",
    inputSchema: obj(),
    annotations: { readOnlyHint: true },
    run: (_a, _cwd, config) => ({ commands: config.commands, rule: "A task is not done until test and static checks pass." }),
  },
  {
    name: "harness_check_files",
    description: "Checks changed files against the harness: architecture boundaries, leaked secrets, and broken or stale references in docs. Call before finishing a task with the files you created or edited.",
    inputSchema: obj({ files: { type: "array", items: { type: "string" }, description: "Repository-relative paths" } }, ["files"]),
    annotations: { readOnlyHint: true },
    run: (a, cwd) => {
      const files = (a.files as string[]) ?? [];
      const results = checkFiles(cwd, files);
      for (const r of results) recordEvents(r.root, "mcp", r.diagnostics.filter((d) => d.severity === "error"));
      const problems = results.flatMap((r) =>
        r.diagnostics.map((d) => ({ file: path.relative(cwd, path.join(r.root, d.file ?? "")).split(path.sep).join("/"), line: d.line, rule: d.rule, severity: d.severity, message: d.message, fix: d.hint })),
      );
      return { ok: !problems.some((p) => p.severity === "error"), checked: files.length, problems };
    },
  },
  {
    name: "harness_can_import",
    description: "Before adding an import, asks whether a file may import a module under the declared architecture boundaries. Returns allowed=false with the reason when it would cross a boundary.",
    inputSchema: obj({ file: { type: "string", description: "Importing file, repository-relative" }, import: { type: "string", description: "Import specifier as it would be written" } }, ["file", "import"]),
    annotations: { readOnlyHint: true },
    run: (a, cwd, config) => {
      const file = String(a.file);
      const spec = String(a.import);
      const line = file.endsWith(".py")
        ? spec.startsWith(".") ? `from ${spec} import x` : `import ${spec}`
        : file.endsWith(".go") ? `import "${spec}"`
        : /\.(java|kts?)$/.test(file) ? `import ${spec};`
        : file.endsWith(".cs") ? `using ${spec};`
        : `import x from "${spec}";`;
      const goModule = readFile(path.join(cwd, "go.mod"))?.match(/^module\s+(\S+)/m)?.[1] ?? null;
      const [imp] = extractImports(file, line, { goModule, alias: tsAliasResolver(cwd) });
      for (const b of config.boundaries.filter((b) => matchesGlob(file, b.from) && !b.except?.some((g) => matchesGlob(file, g)))) {
        const denied = b.deny.find((g) => (imp?.target !== undefined && matchesGlob(imp.target, g) && !matchesGlob(file, g)) || (!spec.startsWith(".") && matchesGlob(spec, g) && !matchesGlob(file, g)));
        if (denied) return { allowed: false, boundary: b, resolved: imp?.target ?? spec, reason: b.message ?? `${b.from} must not import ${denied}` };
      }
      return { allowed: true, resolved: imp?.target ?? spec };
    },
  },
  {
    name: "harness_record_lesson",
    description: "Records a lesson after a mistake was corrected, so it is not repeated: either a written rule added to the agent instructions (fix='doc') or a pointer to an existing mechanical guardrail (lint/test/type/hook/ci). Only use when the user agrees the lesson should become permanent.",
    inputSchema: obj(
      {
        failure: { type: "string", description: "What went wrong, in one sentence" },
        fix: { type: "string", enum: [...FIX_KINDS] },
        rule: { type: "string", description: "For fix='doc': the rule agents must follow" },
        artifact: { type: "string", description: "For mechanical fixes: the file that enforces it (must exist)" },
      },
      ["failure", "fix"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: (a, cwd, config) => {
      const entry = addEntry(cwd, config.context.entry, { failure: String(a.failure), fix: a.fix as FixKind, rule: a.rule as string | undefined, artifact: a.artifact as string | undefined });
      return { recorded: entry, next: "run `gearness sync` (or your hook) so every agent tool sees the rule" };
    },
  },
];

type Json = Record<string, unknown>;

/** Negotiated protocol version; structuredContent only exists from 2025-06-18 on. */
let negotiated = PROTOCOL_VERSIONS[0];

export async function handle(msg: Json, cwd: string): Promise<Json | null> {
  const id = msg.id;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const method = msg.method as string;
  if (id === undefined || id === null) return null; // notification (e.g. notifications/initialized)
  switch (method) {
    case "initialize": {
      const requested = (msg.params as Json | undefined)?.protocolVersion as string | undefined;
      negotiated = requested && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      return reply({
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: TOOL, version: VERSION },
        instructions: "Call harness_overview at the start of a task, harness_can_import before adding cross-module imports, and harness_check_files before you finish.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: string; arguments?: Json };
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(-32602, `unknown tool: ${params.name}`);
      const { config, errors } = loadConfig(cwd);
      if (!config) return reply({ content: [{ type: "text", text: `harness.yaml problem: ${errors.join("; ")}` }], isError: true });
      try {
        const result = await tool.run(params.arguments ?? {}, cwd, config);
        const structured = negotiated >= "2025-06-18" ? { structuredContent: result } : {};
        return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], ...structured, isError: false });
      } catch (e) {
        return reply({ content: [{ type: "text", text: (e as Error).message }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

export function serve(cwd: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    let pending = Promise.resolve();
    rl.on("line", (line) => {
      if (!line.trim()) return;
      pending = pending.then(async () => {
        let msg: Json;
        try {
          msg = JSON.parse(line);
        } catch {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
          return;
        }
        const res = await handle(msg, cwd);
        if (res) process.stdout.write(JSON.stringify(res) + "\n");
      });
    });
    rl.on("close", () => void pending.then(resolve));
  });
}
