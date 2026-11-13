import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { commandEnv, commandProblems, docCommands } from "../commands.js";
import { compareWithBase } from "../compare.js";
import { loadConfig } from "../config.js";
import { applyFixes } from "../fix.js";
import { autoRoot, buildGraph, suggestBoundaries, testGlobsFor, toMermaid, violationEdges } from "../graph.js";
import { checkBoundaries } from "../imports.js";
import { init } from "../init.js";
import { applyLessons, findLessons, loadEvents, recordEvents, TELEMETRY_FILE } from "../learn.js";
import { evaluate, evaluateTree } from "../score.js";
import { renameResolver } from "../util.js";
import { xray } from "../xray.js";
import { NODE_PKG, read, tmpRepo, write, NEEDS_GIT, TEST_ENV } from "./helpers.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const git = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, stdio: "pipe" }).toString();
const commit = (dir: string, msg = "c") => {
  if (!fs.existsSync(path.join(dir, ".git"))) git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", msg, "--allow-empty");
};
const cli = (dir: string, ...args: string[]) => {
  const r = spawnSync("node", [CLI, ...args, "--cwd", dir], { env: TEST_ENV });
  return { code: r.status, out: r.stdout.toString(), err: r.stderr.toString() };
};
const hits = (dir: string, rule: string) => evaluate(dir, loadConfig(dir).config!).diagnostics.filter((d) => d.rule === rule);

/** A small layered app: ui/api → services → db → utils, plus an entry file. */
const layered = () =>
  tmpRepo({
    "package.json": JSON.stringify({ name: "app", scripts: { test: "t", lint: "l" } }),
    "src/main.ts": 'import "./ui/page";\nimport "./api/routes";\n',
    "src/ui/page.tsx": 'import { u } from "../services/users";\nimport { f } from "../utils";\n',
    "src/api/routes.ts": 'import { u } from "../services/users";\n',
    "src/services/users.ts": 'import { q } from "../db/client";\nimport { f } from "../utils/fmt";\n',
    "src/db/client.ts": 'import { f } from "../utils/fmt";\n',
    "src/utils/fmt.ts": "export const f = 1;\n",
    "src/utils/index.ts": 'export * from "./fmt";\n',
    "src/ui/page.test.tsx": 'import "../db/client";\n',
  });

describe("commands in docs", () => {
  it("extracts runnable commands from inline code and shell blocks only", () => {
    const md = "Run `npm run dev` or `npm i -g x`.\n```bash\n$ pnpm test  # fast\nexport A=1\n```\n```js\nnpm run nope\n```\n";
    assert.deepEqual(docCommands(md).map((c) => c.cmd), ["npm run dev", "npm i -g x", "pnpm test"]);
  });
  it("flags missing scripts and the wrong package manager", () => {
    const dir = tmpRepo({ "package.json": JSON.stringify({ scripts: { test: "x" } }), "pnpm-lock.yaml": "" });
    const env = commandEnv(dir);
    assert.deepEqual(commandProblems("pnpm test && pnpm run e2e", env), ["`pnpm run e2e`: package.json has no `e2e` script"]);
    assert.match(commandProblems("yarn test", env)[0], /uses yarn, but this repository uses pnpm \(pnpm-lock\.yaml\)/);
    assert.deepEqual(commandProblems("CI=1 pnpm test", env), []);
    assert.deepEqual(commandProblems("npm install -g @anthropic-ai/claude-code", env), []);
  });
  it("reports doc commands agents cannot run", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir);
    write(dir, "docs/CONVENTIONS.md", "Run `npm run e2e` before pushing. Then `make deploy`.\n");
    assert.deepEqual(hits(dir, "commands/docs-runnable").map((d) => d.message), ["`npm run e2e`: package.json has no `e2e` script", "`make deploy`: Makefile has no `deploy` target"]);
  });
});

describe("rename-aware fixes", () => {
  const renamedRepo = () => {
    const dir = tmpRepo({ "src/a.ts": "a", "src/pay/x.ts": "x", "src/pay/y.ts": "y" });
    commit(dir);
    git(dir, "mv", "src/a.ts", "src/b.ts");
    commit(dir);
    fs.mkdirSync(path.join(dir, "src/core"));
    git(dir, "mv", "src/b.ts", "src/core/c.ts");
    git(dir, "mv", "src/pay", "src/billing");
    commit(dir);
    return dir;
  };
  it("follows rename chains for files and whole directories", NEEDS_GIT, () => {
    const r = renameResolver(renamedRepo());
    assert.equal(r("src/a.ts"), "src/core/c.ts");
    assert.equal(r("src/pay/"), "src/billing");
    assert.equal(r("src/never.ts"), null);
  });
  it("lint --fix rewrites stale references and links, keeping their shape", NEEDS_GIT, () => {
    const dir = renamedRepo();
    write(dir, "package.json", NODE_PKG);
    init(dir);
    write(dir, "docs/CONVENTIONS.md", "See `src/a.ts:12`, `./src/b.ts`, `src/pay/` and [x](../src/pay/x.ts#top). Gone: `src/gone.ts`.\n");
    commit(dir);
    const tree = evaluate(dir, loadConfig(dir).config!);
    assert.deepEqual(applyFixes(dir, tree.diagnostics), ["docs/CONVENTIONS.md"]);
    assert.equal(read(dir, "docs/CONVENTIONS.md"), "See `src/core/c.ts:12`, `./src/core/c.ts`, `src/billing/` and [x](../src/billing/x.ts#top). Gone: `src/gone.ts`.\n");
    assert.deepEqual(hits(dir, "context/stale-references").map((d) => d.message), ["`src/gone.ts` does not exist"]);
  });
});

describe("regression gate", () => {
  it("diffs findings against a base ref and fails --no-regress on new errors", NEEDS_GIT, async () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir);
    commit(dir);
    write(dir, "AGENTS.md", read(dir, "AGENTS.md") + "\n[x](missing.md)\n");
    const { sync } = await import("../adapters.js");
    sync(dir, loadConfig(dir).config!);
    const tree = await evaluateTree(dir, loadConfig(dir).config!);
    const cmp = await compareWithBase(dir, "HEAD", tree);
    assert.ok(cmp.delta! < 0);
    assert.deepEqual(cmp.introduced.map((d) => d.rule), ["context/broken-links"]);
    assert.equal(cmp.resolved.length, 0);
    assert.equal(cli(dir, "doctor", "--ci", "--no-regress", "--base", "HEAD").code, 1);
    assert.equal(execFileSync("git", ["worktree", "list"], { cwd: dir }).toString().trim().split("\n").length, 1);
  });
  it("compares from a workspace subdirectory, whatever the path spelling", NEEDS_GIT, async () => {
    const dir = tmpRepo({ "package.json": JSON.stringify({ name: "m", workspaces: ["packages/*"] }), "packages/a/package.json": NODE_PKG });
    init(dir, { workspaces: true });
    commit(dir);
    const ws = path.join(dir, "packages", "a");
    write(ws, "AGENTS.md", read(ws, "AGENTS.md") + "\n[x](missing.md)\n");
    const { sync } = await import("../adapters.js");
    sync(ws, loadConfig(ws).config!);
    // A differently spelled but equivalent path (trailing separator, ".." segment) must resolve to the same place.
    const odd = path.join(dir, "packages", "a", "..", "a") + path.sep;
    const cmp = await compareWithBase(odd, "HEAD", await evaluateTree(ws, loadConfig(ws).config!));
    assert.ok(cmp.baseScore !== null, "base harness found in the workspace");
    assert.ok(cmp.delta! < 0);
  });
  it("treats a base without a harness as a new harness", NEEDS_GIT, async () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    commit(dir);
    init(dir);
    const cmp = await compareWithBase(dir, "HEAD", await evaluateTree(dir, loadConfig(dir).config!));
    assert.equal(cmp.baseScore, null);
    assert.equal(cmp.delta, null);
  });
});

describe("architecture inference", () => {
  it("finds the module root, even in deep JVM layouts", () => {
    assert.equal(autoRoot(["src/a/x.ts", "src/b/y.ts", "src/index.ts"]), "src");
    assert.equal(autoRoot(["api/x.go", "worker/y.go"]), "");
    assert.equal(autoRoot(["src/main/java/com/acme/web/A.java", "src/main/java/com/acme/db/B.java", "src/main/java/com/acme/App.java"]), "src/main/java/com/acme");
  });
  it("prefers a conventional src folder even with benchmarks and examples beside it", () => {
    const files = [...Array.from({ length: 6 }, (_, i) => `src/m${i % 3}/f${i}.ts`), "bench/a/x.ts", "bench/b/y.ts", "examples/z/w.ts"];
    assert.equal(autoRoot(files), "src");
  });
  it("exempts only the test patterns present, written without YAML anchors", () => {
    assert.deepEqual(testGlobsFor(["src/a.ts", "src/a.test.ts", "src/__tests__/b.ts"]), ["**/__tests__/**", "**/*.test.*"]);
    const dir = layered();
    init(dir);
    cli(dir, "boundaries", "suggest", "--strict", "--write");
    assert.doesNotMatch(read(dir, "harness.yaml"), /[&*]a\d/);
  });
  it("builds module edges, ignoring tests by default", () => {
    const g = buildGraph(layered());
    assert.equal(g.root, "src");
    assert.ok(!g.edges.some((e) => e.from === "src/ui" && e.to === "src/db"), "the test file's import is ignored");
    assert.deepEqual(g.edges.find((e) => e.from === "src/services" && e.to === "src/db")?.count, 1);
  });
  it("suggests transitive layer boundaries with zero violations today", () => {
    const dir = layered();
    const s = suggestBoundaries(dir, buildGraph(dir));
    const db = s.boundaries.find((b) => b.from === "src/db/**")!;
    assert.deepEqual(db.deny, ["src/api/**", "src/services/**", "src/ui/**"]);
    assert.equal(checkBoundaries(dir, s.boundaries).violations.length, 0);
    assert.deepEqual(s.cycles, []);
  });
  it("--strict freezes today's graph, so layer skipping is caught too", () => {
    const dir = layered();
    const s = suggestBoundaries(dir, buildGraph(dir), { strict: true });
    assert.equal(checkBoundaries(dir, s.boundaries).violations.length, 0);
    const ui = s.boundaries.find((b) => b.from === "src/ui/**")!;
    assert.ok(ui.deny.includes("src/db/**") && !ui.deny.includes("src/services/**"));
    write(dir, "src/ui/page.tsx", read(dir, "src/ui/page.tsx") + 'import { q } from "../db/client";\n');
    assert.equal(checkBoundaries(dir, s.boundaries).violations.length, 1);
  });
  it("exempts tests from inferred boundaries, and the written config matches the schema", async () => {
    const dir = layered(); // src/ui/page.test.tsx imports the db directly
    init(dir);
    cli(dir, "boundaries", "suggest", "--strict", "--write");
    const cfg = loadConfig(dir).config!;
    const ui = cfg.boundaries.find((b) => b.from === "src/ui/**")!;
    assert.ok(ui.except?.includes("**/*.test.*"));
    assert.equal(hits(dir, "architecture/boundaries").length, 0, "test file is exempt");
    const { createRequire } = await import("node:module");
    const Ajv = createRequire(import.meta.url)("ajv/dist/2020").default;
    const schema = JSON.parse(fs.readFileSync(path.join(path.dirname(CLI), "..", "schema/harness.schema.json"), "utf8"));
    const YAML = (await import("yaml")).default;
    const validate = new Ajv({ strict: false }).compile(schema);
    assert.ok(validate(YAML.parse(read(dir, "harness.yaml"))), JSON.stringify(validate.errors));
  });
  it("reports cycles instead of layering them", () => {
    const dir = layered();
    write(dir, "src/db/client.ts", 'import { u } from "../services/users";\n');
    const s = suggestBoundaries(dir, buildGraph(dir));
    assert.deepEqual(s.cycles, [["src/db", "src/services"]]);
    // Layers outside the cycle can still be locked; the cycle's members never deny each other.
    const deny = (from: string) => s.boundaries.find((b) => b.from === from)?.deny ?? [];
    assert.ok(!deny("src/db/**").includes("src/services/**") && !deny("src/services/**").includes("src/db/**"));
    assert.equal(checkBoundaries(dir, s.boundaries).violations.length, 0);
  });
  it("--write merges into harness.yaml, keeps comments, and is idempotent", () => {
    const dir = layered();
    init(dir);
    assert.equal(cli(dir, "boundaries", "suggest", "--write").code, 0);
    const yaml = read(dir, "harness.yaml");
    assert.match(yaml, /# Architecture boundaries, checked against real imports/);
    const n = loadConfig(dir).config!.boundaries.length;
    assert.ok(n >= 3);
    cli(dir, "boundaries", "suggest", "--write");
    assert.equal(loadConfig(dir).config!.boundaries.length, n);
    assert.equal(hits(dir, "architecture/boundaries").length, 0);
  });
  it("draws violations red in Mermaid", () => {
    const dir = layered();
    write(dir, "src/db/client.ts", 'import "../ui/page";\n');
    const g = buildGraph(dir);
    const bad = violationEdges(dir, g, [{ from: "src/db/**", deny: ["src/ui/**"] }]);
    assert.deepEqual(bad, [{ from: "src/db", to: "src/ui" }]);
    const mermaid = toMermaid(g, bad);
    const idx = g.edges.findIndex((e) => e.from === "src/db" && e.to === "src/ui");
    assert.match(mermaid, new RegExp(`linkStyle ${idx} stroke:#d73a49`));
  });
});

describe("context x-ray", () => {
  it("follows each tool's loading rules for a path", () => {
    const dir = tmpRepo({ "package.json": JSON.stringify({ name: "m", workspaces: ["packages/*"] }), "packages/api/package.json": NODE_PKG, "packages/api/src/x.ts": "" });
    init(dir, { workspaces: true });
    write(dir, ".cursor/rules/ts.mdc", '---\nglobs: "**/*.ts"\n---\nUse strict TS.\n');
    write(dir, ".cursor/rules/ask.mdc", "---\ndescription: deployment notes\n---\nDeploy with care.\n");
    const ctx = Object.fromEntries(xray(dir, loadConfig(dir).config!, "packages/api/src/x.ts").map((r) => [r.agent, r]));
    assert.deepEqual(ctx.codex.always.map((a) => a.file), ["AGENTS.md", "packages/api/AGENTS.md"]);
    assert.deepEqual(ctx.claude.always.map((a) => a.file), ["CLAUDE.md", "AGENTS.md", "packages/api/CLAUDE.md", "packages/api/AGENTS.md"]);
    assert.ok(ctx.cursor.always.some((a) => a.file === ".cursor/rules/ts.mdc"));
    assert.ok(ctx.cursor.onDemand.some((a) => a.file === ".cursor/rules/ask.mdc"));
    assert.ok(ctx.copilot.always.some((a) => a.file === ".github/instructions/packages-api.instructions.md"));
    assert.ok(ctx.claude.tokens > 0 && ctx.claude.duplicates.length === 0);
  });
  it("flags duplicated instructions", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir, { agents: ["claude"] });
    write(dir, "CLAUDE.md", read(dir, "AGENTS.md") + "\n@AGENTS.md\n");
    const [claude] = xray(dir, loadConfig(dir).config!, ".");
    assert.match(claude.duplicates[0], /AGENTS\.md repeats CLAUDE\.md/);
  });
});

describe("learning loop", () => {
  it("logs violations locally, outside git", NEEDS_GIT, () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir);
    git(dir, "init", "-q");
    recordEvents(dir, "claude-hook", [{ rule: "safety/no-secrets", severity: "error", file: "a.ts", message: "possible AWS access key" }]);
    assert.equal(loadEvents(dir).length, 1);
    assert.equal(git(dir, "check-ignore", TELEMETRY_FILE).trim(), TELEMETRY_FILE);
  });
  it("respects GEARNESS_TELEMETRY=0", () => {
    const dir = tmpRepo({});
    process.env.GEARNESS_TELEMETRY = "0";
    try {
      recordEvents(dir, "mcp", [{ rule: "x/y", severity: "error", message: "m" }]);
    } finally {
      delete process.env.GEARNESS_TELEMETRY;
    }
    assert.equal(loadEvents(dir).length, 0);
  });
  it("turns repeated violations and eval forbidden changes into rules, once", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    const { config } = init(dir);
    const v = { rule: "architecture/boundaries", severity: "error" as const, file: "src/ui/a.ts", message: "imports ../db/x (crosses src/ui/** ✗ src/db/**) - UI talks to services only" };
    recordEvents(dir, "claude-hook", [v]);
    recordEvents(dir, "pre-commit", [v]);
    recordEvents(dir, "mcp", [{ ...v, rule: "safety/no-secrets", message: "possible GitHub token" }]);
    write(dir, ".harness/eval-results/2026-01-01.json", JSON.stringify({ date: "2026-01-01T00:00:00Z", runs: [{ task: "t", forbiddenChanged: ["package-lock.json"] }, { task: "t", forbiddenChanged: ["package-lock.json"] }], variants: [] }));
    const lessons = findLessons(dir);
    assert.deepEqual(lessons.map((l) => [l.key, l.count]), [["boundary:src/ui/**:src/db/**", 2], ["forbid:package-lock.json", 2]]);
    assert.equal(lessons[0].rule, "Code under `src/ui/` must not import from `src/db/` - UI talks to services only");
    assert.equal(applyLessons(dir, config, lessons).length, 2);
    assert.match(read(dir, "AGENTS.md"), /Do not modify `package-lock\.json` unless the task explicitly asks for it\. _\(R-002\)_/);
    assert.ok(findLessons(dir).every((l) => l.learned));
    assert.equal(applyLessons(dir, config, findLessons(dir)).length, 0);
  });
  it("the claude hook feeds the log end to end", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG, "src/ui/a.ts": 'import "../db/x";\n' });
    init(dir);
    write(dir, "harness.yaml", read(dir, "harness.yaml").replace("boundaries: []", 'boundaries:\n  - from: "src/ui/**"\n    deny: ["src/db/**"]'));
    for (let i = 0; i < 2; i++) spawnSync("node", [CLI, "check", "--hook", "claude"], { input: JSON.stringify({ cwd: dir, tool_input: { file_path: "src/ui/a.ts" } }), env: TEST_ENV });
    const r = cli(dir, "learn");
    assert.match(r.out, /2× imports from src\/db inside src\/ui/);
  });
});

describe("mcp rules for path", () => {
  it("tells the agent what applies to a file before it edits", async () => {
    const { handle } = await import("../mcp.js");
    const dir = layered();
    init(dir);
    cli(dir, "boundaries", "suggest", "--write");
    const r = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "harness_rules_for_path", arguments: { path: "src/db/client.ts" } } }, dir)) as { result: { content: { text: string }[] } };
    const data = JSON.parse(r.result.content[0].text);
    assert.deepEqual(data.instructions.map((i: { file: string }) => i.file), ["AGENTS.md"]);
    assert.deepEqual(data.boundaries[0].deny, ["src/api/**", "src/services/**", "src/ui/**"]);
    assert.equal(data.verify.test, "npm run test");
  });
});

describe("init extras", () => {
  it("writes .harness/.gitignore for local data", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir);
    assert.equal(read(dir, ".harness/.gitignore"), "telemetry/\n");
  });
});
