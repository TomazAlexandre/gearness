import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { adapterStatus, sync } from "../adapters.js";
import { checkFiles, nearestHarness } from "../check.js";
import { defaultConfig, loadConfig } from "../config.js";
import { loadHistory, newTask, runEval, trend } from "../eval.js";
import { toGithubAnnotations, toSarif } from "../formats.js";
import { checkBoundaries, extractImports, tsAliasResolver } from "../imports.js";
import { init } from "../init.js";
import { hasLoopFeedback, install } from "../install.js";
import { handle } from "../mcp.js";
import { RULES } from "../rules.js";
import { evaluate } from "../score.js";
import { listFiles, parseJsonc } from "../util.js";
import { NODE_PKG, read, tmpRepo, write, NEEDS_GIT } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "cli.js");
const ROOT = path.join(HERE, "..", "..");
const git = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, stdio: "pipe" }).toString();
const commitAll = (dir: string) => {
  if (!fs.existsSync(path.join(dir, ".git"))) git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "c", "--allow-empty");
};
const hits = (dir: string, rule: string) => evaluate(dir, loadConfig(dir).config!).diagnostics.filter((d) => d.rule === rule);
const cli = (dir: string, args: string[], input?: string) => {
  const r = spawnSync("node", [CLI, ...args, "--cwd", dir], { input, env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.status, out: r.stdout.toString(), err: r.stderr.toString() };
};
const withBoundary = (dir: string, from = "src/ui/**", deny = "src/db/**") =>
  write(dir, "harness.yaml", read(dir, "harness.yaml").replace("boundaries: []", `boundaries:\n  - from: "${from}"\n    deny: ["${deny}"]\n    message: UI uses services`));

describe("stale references in docs", () => {
  it("flags cited paths that no longer exist, and only those", NEEDS_GIT, () => {
    const dir = tmpRepo({ "package.json": NODE_PKG, "src/real.ts": "", ".gitignore": "out/\n" });
    init(dir);
    git(dir, "init", "-q");
    write(dir, "docs/CONVENTIONS.md", "Use `src/real.ts:10` not `src/gone.ts`. Build goes to `out/app.js`. Prose `and/or`, glob `src/**`, url `https://x.dev/a`.\n- TODO(gearness): e.g. `src/example.ts`\n");
    assert.deepEqual(hits(dir, "context/stale-references").map((d) => d.message), ["`src/gone.ts` does not exist"]);
  });
});

describe("file listing", () => {
  it("honors .gitignore inside git repositories", NEEDS_GIT, () => {
    const dir = tmpRepo({ "a.ts": "", "gen/b.ts": "", ".gitignore": "gen/\n" });
    git(dir, "init", "-q");
    assert.deepEqual(listFiles(dir, { exts: [".ts"] }), ["a.ts"]);
  });
});

describe("imports v2", () => {
  it("parses JSONC without breaking strings that contain comment markers", () => {
    assert.deepEqual(parseJsonc('{ // c\n "a": "http://x/*y*/", /* b */ "b": [1,], }'), { a: "http://x/*y*/", b: [1] });
  });
  it("resolves tsconfig path aliases, longest prefix first", () => {
    const dir = tmpRepo({ "tsconfig.json": '{ "compilerOptions": { "baseUrl": "./", "paths": { "@/*": ["src/*"], "@db/*": ["src/db/*"], "~config": ["config/index.ts"] } } }' });
    const r = tsAliasResolver(dir)!;
    assert.equal(r("@/ui/x"), "src/ui/x");
    assert.equal(r("@db/pool"), "src/db/pool");
    assert.equal(r("~config"), "config/index.ts");
    assert.equal(r("react"), undefined);
  });
  it("enforces boundaries through aliases", () => {
    const dir = tmpRepo({ "tsconfig.json": '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}', "src/ui/p.ts": 'import { q } from "@/db/q";\nimport { b } from "@/ui/b";\n' });
    assert.deepEqual(checkBoundaries(dir, [{ from: "src/ui/**", deny: ["src/db/**"] }]).violations.map((v) => v.spec), ["@/db/q"]);
  });
  it("reads Java, Kotlin and C# imports as package paths", () => {
    assert.deepEqual(extractImports("A.java", "import com.a.db.Repo;\nimport static com.a.U.*;\n// import com.a.db.X;\n").map((r) => r.target), ["com/a/db/Repo", "com/a/U"]);
    assert.deepEqual(extractImports("A.kt", "import com.a.db.Repo as R\n").map((r) => r.target), ["com/a/db/Repo"]);
    assert.deepEqual(extractImports("A.cs", "using System;\nusing R = Shop.Db.Repo;\nglobal using static Shop.U;\n").map((r) => r.target), ["System", "Shop/Db/Repo", "Shop/U"]);
  });
});

describe("check (hooks and pre-commit)", () => {
  const repo = () => {
    const dir = tmpRepo({ "package.json": NODE_PKG, "src/ui/ok.ts": "export const a = 1;\n", "src/ui/bad.ts": 'import { p } from "../db/pool";\n' });
    init(dir);
    withBoundary(dir);
    return dir;
  };
  it("checks only the given files, with boundaries and secrets", () => {
    const dir = repo();
    write(dir, "src/config.ts", 'const k = "ghp_' + "x".repeat(36) + '";\n');
    const ds = checkFiles(dir, ["src/ui/ok.ts", "src/ui/bad.ts", "src/config.ts"]).flatMap((r) => r.diagnostics);
    assert.deepEqual(ds.map((d) => `${d.file}:${d.rule}`).sort(), ["src/config.ts:safety/no-secrets", "src/ui/bad.ts:architecture/boundaries"]);
  });
  it("uses the nearest workspace harness", () => {
    const dir = tmpRepo({ "package.json": JSON.stringify({ name: "m", workspaces: ["packages/*"] }), "packages/a/package.json": NODE_PKG, "packages/a/src/ui/x.ts": 'import "../db/y";\n' });
    init(dir, { workspaces: true });
    withBoundary(path.join(dir, "packages/a"));
    assert.equal(nearestHarness(path.join(dir, "packages/a/src/ui/x.ts"), dir), path.join(dir, "packages/a"));
    const [r] = checkFiles(dir, ["packages/a/src/ui/x.ts"]);
    assert.equal(r.diagnostics[0].rule, "architecture/boundaries");
  });
  it("claude hook: exit 2 with feedback on violations, 0 otherwise, never blocks on bad input", () => {
    const dir = repo();
    const payload = (f: string) => JSON.stringify({ cwd: dir, tool_name: "Edit", tool_input: { file_path: path.join(dir, f) } });
    const bad = cli(dir, ["check", "--hook", "claude"], payload("src/ui/bad.ts"));
    assert.equal(bad.code, 2);
    assert.match(bad.err, /src\/ui\/bad\.ts:1 imports \.\.\/db\/pool/);
    assert.equal(cli(dir, ["check", "--hook", "claude"], payload("src/ui/ok.ts")).code, 0);
    assert.equal(cli(dir, ["check", "--hook", "claude"], "{not json").code, 0);
    assert.equal(cli(dir, ["check", "--hook", "claude"], JSON.stringify({ tool_input: { file_path: "/etc/hosts" } })).code, 0);
  });
  it("claude hook: editing AGENTS.md re-syncs every adapter", () => {
    const dir = repo();
    write(dir, "AGENTS.md", read(dir, "AGENTS.md") + "\n- new rule\n");
    cli(dir, ["check", "--hook", "claude"], JSON.stringify({ cwd: dir, tool_input: { file_path: "AGENTS.md" } }));
    assert.ok(adapterStatus(dir, loadConfig(dir).config!).every((s) => s.state === "in-sync" || s.state === "native"));
  });
  it("check --staged blocks commits with violations", NEEDS_GIT, () => {
    const dir = repo();
    git(dir, "init", "-q");
    git(dir, "add", "src/ui/bad.ts");
    assert.equal(cli(dir, ["check", "--staged"]).code, 1);
    git(dir, "reset", "-q");
    git(dir, "add", "src/ui/ok.ts");
    assert.equal(cli(dir, ["check", "--staged"]).code, 0);
  });
});

describe("install", () => {
  it("merges into existing Claude settings, is idempotent and reversible", NEEDS_GIT, () => {
    const dir = tmpRepo({ "package.json": NODE_PKG, ".claude/settings.json": '{\n // keep me\n "permissions": {"allow": ["Bash(ls)"]},\n "hooks": {"PostToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "echo hi"}]}]}\n}\n' });
    const { config } = init(dir);
    git(dir, "init", "-q");
    install(dir, config, { command: "node x/cli.js" });
    const again = install(dir, config, { command: "node x/cli.js" });
    assert.ok(again.every((a) => a.action === "unchanged"), JSON.stringify(again));
    const s = JSON.parse(read(dir, ".claude/settings.json"));
    assert.deepEqual(s.permissions, { allow: ["Bash(ls)"] });
    assert.equal(s.hooks.PostToolUse.length, 2);
    assert.equal(s.hooks.PostToolUse[1].hooks[0].command, "node x/cli.js check --hook claude");
    const hook = path.join(dir, ".git/hooks/pre-commit");
    assert.match(fs.readFileSync(hook, "utf8"), /node x\/cli\.js check --staged/);
    if (process.platform !== "win32") assert.ok(fs.statSync(hook).mode & 0o100, "hook is executable");
    assert.ok(hasLoopFeedback(dir));
    assert.ok(!hits(dir, "feedback/agent-loop").length);
    install(dir, config, { remove: true });
    assert.equal(JSON.parse(read(dir, ".claude/settings.json")).hooks.PostToolUse.length, 1);
    assert.ok(!fs.existsSync(hook));
    assert.ok(!("gearness" in JSON.parse(read(dir, ".mcp.json")).mcpServers));
  });
  it("registers the MCP server for each targeted agent and respects other hook managers", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG, "lefthook.yml": "pre-commit:\n  commands: {}\n" });
    const { config } = init(dir, { agents: ["claude", "copilot", "gemini"] });
    const actions = install(dir, config, { command: "npx gearness" });
    assert.deepEqual(actions.filter((a) => a.integration === "mcp").map((a) => a.file), [".mcp.json", ".vscode/mcp.json", ".gemini/settings.json"]);
    assert.deepEqual(JSON.parse(read(dir, ".vscode/mcp.json")).servers.gearness, { type: "stdio", command: "npx", args: ["gearness", "mcp"] });
    const gitAction = actions.find((a) => a.integration === "git")!;
    assert.equal(gitAction.action, "manual");
    assert.match(gitAction.note!, /npx gearness check --staged/);
  });
});

describe("mcp server", () => {
  const repo = () => {
    const dir = tmpRepo({ "package.json": NODE_PKG, "src/ui/bad.ts": 'import "../db/x";\n' });
    init(dir);
    withBoundary(dir);
    return dir;
  };
  const call = async (dir: string, name: string, args: object) => {
    const r = (await handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }, dir)) as { result: { content: { text: string }[]; isError: boolean } };
    const text = r.result.content[0].text;
    return { data: r.result.isError ? text : JSON.parse(text), isError: r.result.isError };
  };
  it("negotiates the protocol version and lists tools", async () => {
    const dir = repo();
    const init1 = (await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, dir)) as { result: { protocolVersion: string } };
    assert.equal(init1.result.protocolVersion, "2024-11-05");
    const list = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, dir)) as { result: { tools: { name: string; inputSchema: object }[] } };
    assert.ok(list.result.tools.length >= 5 && list.result.tools.every((t) => t.inputSchema));
    assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, dir), null);
    const unknown = (await handle({ jsonrpc: "2.0", id: 3, method: "nope" }, dir)) as { error: { code: number } };
    assert.equal(unknown.error.code, -32601);
  });
  it("answers can-import, check-files and records lessons", async () => {
    const dir = repo();
    assert.equal((await call(dir, "harness_can_import", { file: "src/ui/a.ts", import: "../db/pool" })).data.allowed, false);
    assert.equal((await call(dir, "harness_can_import", { file: "src/ui/a.ts", import: "./b" })).data.allowed, true);
    const checked = await call(dir, "harness_check_files", { files: ["src/ui/bad.ts"] });
    assert.equal(checked.data.ok, false);
    const lesson = await call(dir, "harness_record_lesson", { failure: "edited dist", fix: "doc", rule: "Never edit dist/" });
    assert.equal(lesson.data.recorded.id, "R-001");
    assert.match(read(dir, "AGENTS.md"), /Never edit dist\//);
    assert.equal((await call(dir, "harness_record_lesson", { failure: "x", fix: "lint", artifact: "missing.js" })).isError, true);
  });
  it("speaks newline-delimited JSON-RPC over stdio", () => {
    const dir = repo();
    const input = ['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}', '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"harness_verify_commands","arguments":{}}}', "oops", ""].join("\n");
    const lines = cli(dir, ["mcp"], input).out.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].result.serverInfo.name, "gearness");
    assert.equal(lines[1].result.structuredContent.commands.test, "npm run test");
    assert.equal(lines[2].error.code, -32700);
  });
});

describe("output formats", () => {
  it("escapes GitHub annotations", () => {
    const out = toGithubAnnotations([{ rule: "a/b", severity: "error", file: "x,y.md", line: 3, message: "50% bad\nline" }]);
    assert.equal(out, "::error file=x%2Cy.md,line=3,title=gearness a/b::50%25 bad%0Aline");
  });
  it("emits valid-looking SARIF with rule metadata", () => {
    const s = toSarif([{ rule: "context/broken-links", severity: "error", file: "AGENTS.md", line: 2, message: "m" }], RULES) as { runs: { results: { level: string }[]; tool: { driver: { rules: { id: string }[] } } }[] };
    assert.equal(s.runs[0].results[0].level, "error");
    assert.deepEqual(s.runs[0].tool.driver.rules.map((r) => r.id), ["context/broken-links"]);
  });
  it("lint --format github exits 1 on errors", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir);
    fs.rmSync(path.join(dir, "docs/STATUS.md"));
    const r = cli(dir, ["lint", "--format", "github"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /^::error /m);
  });
});

describe("eval v2", () => {
  it("runs in parallel with stable ordering and builds a trend", NEEDS_GIT, async () => {
    const dir = tmpRepo({ "package.json": JSON.stringify({ name: "e", scripts: { test: "node check.cjs" } }), "check.cjs": 'process.exit(require("fs").existsSync("DONE")?0:1)\n', "agent.cjs": 'require("fs").writeFileSync("DONE","1")\n' });
    const { config } = init(dir, { agents: ["claude"], ci: false });
    for (const id of ["a", "b"]) {
      newTask(dir, config, id);
      write(dir, `.harness/evals/${id}.yaml`, read(dir, `.harness/evals/${id}.yaml`).replace(/TODO\(gearness\)[^\n]*/, "do it").replace(/setup: .*\n/, ""));
    }
    commitAll(dir);
    const s = await runEval(dir, config, { agent: "node agent.cjs", runs: 2, parallel: 4 });
    assert.deepEqual(s.runs.map((r) => `${r.task}${r.run}:${r.passed}`), ["a1:true", "a2:true", "b1:true", "b2:true"]);
    await runEval(dir, config, { agent: "node agent.cjs", tasks: ["a"] });
    const t = trend(loadHistory(dir));
    assert.equal(t.rows.length, 2);
    assert.deepEqual(t.tasks, ["a", "b"]);
    assert.equal(t.rows[1].rates.b, null);
  });
});

describe("copilot in monorepos", () => {
  it("writes path-specific instructions per workspace and detects their drift", () => {
    const dir = tmpRepo({ "package.json": JSON.stringify({ name: "m", workspaces: ["packages/*"] }), "packages/api/package.json": NODE_PKG });
    init(dir, { workspaces: true });
    const file = ".github/instructions/packages-api.instructions.md";
    assert.match(read(dir, file), /^---\napplyTo: "packages\/api\/\*\*"\n---/);
    assert.match(read(dir, file), /\]\(\.\.\/\.\.\/packages\/api\/docs\/ARCHITECTURE\.md\)/);
    write(dir, "packages/api/AGENTS.md", read(dir, "packages/api/AGENTS.md") + "\nchanged\n");
    const { config } = loadConfig(dir);
    assert.ok(adapterStatus(dir, config!).some((s) => s.file === file && s.state === "drifted"));
    sync(dir, config!);
    assert.ok(adapterStatus(dir, config!).every((s) => s.state !== "drifted"));
  });
});

describe("json schema", () => {
  const require = createRequire(import.meta.url);
  const Ajv = require("ajv/dist/2020").default;
  const validate = new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(fs.readFileSync(path.join(ROOT, "schema/harness.schema.json"), "utf8")));
  it("accepts every config gearness writes, including its own", () => {
    const single = tmpRepo({ "package.json": NODE_PKG });
    init(single);
    const mono = tmpRepo({ "package.json": JSON.stringify({ name: "m", workspaces: ["packages/*"] }), "packages/a/package.json": NODE_PKG });
    init(mono, { workspaces: true });
    for (const f of [path.join(single, "harness.yaml"), path.join(mono, "harness.yaml"), path.join(mono, "packages/a/harness.yaml"), path.join(ROOT, "harness.yaml")]) {
      const ok = validate(YAML.parse(fs.readFileSync(f, "utf8")));
      assert.ok(ok, `${f}: ${JSON.stringify(validate.errors)}`);
    }
  });
  it("rejects invalid configs and covers every config key", () => {
    assert.equal(validate({ version: 1, project: { name: "x" }, agents: ["vim"] }), false);
    assert.equal(validate({ version: 1, project: { name: "x" }, boundaries: [{ from: "a" }] }), false);
    const schemaKeys = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, "schema/harness.schema.json"), "utf8")).properties).sort();
    assert.deepEqual(schemaKeys, Object.keys(defaultConfig({ project: { name: "x" } })).sort());
  });
});

describe("cli explain", () => {
  it("shows the rule and its findings in this repo", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir);
    const r = cli(dir, ["explain", "context/placeholders"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /context\/placeholders\s+context · 30 pts/);
    assert.match(r.out, /Findings/);
    assert.equal(cli(dir, ["explain", "nope/x"]).code, 2);
  });
});
