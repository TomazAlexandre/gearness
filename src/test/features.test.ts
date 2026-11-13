import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ADAPTERS, detectAgents, sync } from "../adapters.js";
import { loadConfig, parseConfig } from "../config.js";
import { detect, detectWorkspaces } from "../detect.js";
import { agentCommand, loadTasks, newTask, runEval } from "../eval.js";
import { checkBoundaries, extractImports } from "../imports.js";
import { init } from "../init.js";
import { loadExtraRules } from "../plugins.js";
import { evaluate, evaluateTree } from "../score.js";
import { expandDirGlobs, headingAnchors, markdownLinks, matchesGlob } from "../util.js";
import { NODE_PKG, read, tmpRepo, write, NEEDS_GIT, TEST_ENV } from "./helpers.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const rulesHit = (dir: string, rule: string) => {
  const { config } = loadConfig(dir);
  return evaluate(dir, config!).diagnostics.filter((d) => d.rule === rule);
};
const gitInit = (dir: string) => {
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, stdio: "pipe" });
  g("init", "-q");
  g("add", "-A");
  g("commit", "-qm", "init");
  return g;
};

describe("globs", () => {
  it("matches directories, prefixes and extensions", () => {
    assert.ok(matchesGlob("src/db", "src/db/**"));
    assert.ok(matchesGlob("src/db/a/b.ts", "src/db/**"));
    assert.ok(!matchesGlob("src/dbx/a.ts", "src/db/**"));
    assert.ok(matchesGlob("lodash/fp", "lodash"));
    assert.ok(matchesGlob("a/b/c.py", "**/*.py"));
  });
  it("expands workspace globs to direct children only", () => {
    const dir = tmpRepo({ "packages/a/x.txt": "", "packages/b/src/y.txt": "", "apps/web/z.txt": "" });
    assert.deepEqual(expandDirGlobs(dir, ["packages/*", "apps/web"]), ["apps/web", "packages/a", "packages/b"]);
  });
});

describe("detect: more stacks and runners", () => {
  it("rust", () => assert.equal(detect(tmpRepo({ "Cargo.toml": '[package]\nname = "core"\n' })).commands.lint, "cargo clippy -- -D warnings"));
  it("dotnet", () => assert.equal(detect(tmpRepo({ "App.sln": "" })).stack, "dotnet"));
  it("prefers just and task targets", () => {
    const d = detect(tmpRepo({ "go.mod": "module x\n", justfile: "test:\n  go test ./...\n", "Taskfile.yml": "version: '3'\ntasks:\n  lint:\n    cmds: [golangci-lint run]\n" }));
    assert.equal(d.commands.test, "just test");
    assert.equal(d.commands.lint, "task lint");
  });
  it("workspaces from npm, pnpm, cargo and go.work", () => {
    assert.deepEqual(detectWorkspaces(tmpRepo({ "package.json": JSON.stringify({ workspaces: ["packages/*", "!packages/old"] }) })), ["packages/*"]);
    assert.deepEqual(detectWorkspaces(tmpRepo({ "pnpm-workspace.yaml": "packages:\n  - apps/*\n" })), ["apps/*"]);
    assert.deepEqual(detectWorkspaces(tmpRepo({ "Cargo.toml": '[workspace]\nmembers = ["crates/a", "crates/b"]\n' })), ["crates/a", "crates/b"]);
    assert.deepEqual(detectWorkspaces(tmpRepo({ "go.work": "go 1.22\nuse (\n\t./api\n\t./worker\n)\n" })), ["api", "worker"]);
  });
});

describe("imports and boundaries", () => {
  it("extracts JS/TS imports, ignoring comments", () => {
    const refs = extractImports("src/ui/a.ts", `import x from "../db/a";\n// import y from "../db/b";\nconst z = require('./z');\nexport * from "lodash";\nawait import("../db/c.js");`);
    assert.deepEqual(refs.map((r) => r.target ?? r.spec), ["src/db/a", "src/ui/z", "lodash", "src/db/c"]);
  });
  it("extracts Python absolute and relative imports", () => {
    const refs = extractImports("app/web/v.py", "import os, app.db.raw as r\nfrom ..db.session import S\nfrom . import utils\n");
    assert.deepEqual(refs.map((r) => r.target), ["os", "app/db/raw", "app/db/session", "app/web"]);
  });
  it("extracts Go imports inside the module", () => {
    const refs = extractImports("cmd/api/main.go", 'import (\n\t"fmt"\n\tdb "example.com/shop/internal/db"\n)\n', "example.com/shop");
    assert.deepEqual(refs.map((r) => r.target ?? r.spec), ["fmt", "internal/db"]);
  });
  it("reports violations and lets a layer import itself", () => {
    const dir = tmpRepo({ "src/ui/page.ts": 'import { q } from "../db/client";\nimport axios from "axios";\n', "src/db/index.ts": 'import { c } from "./client";\n' });
    const { violations } = checkBoundaries(dir, [{ from: "src/**", deny: ["src/db/**", "axios"] }]);
    assert.deepEqual(violations.map((v) => `${v.file}:${v.line}:${v.spec}`), ["src/ui/page.ts:1:../db/client", "src/ui/page.ts:2:axios"]);
  });
  it("is info-only until boundaries are declared, error on violation", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG, "src/ui/a.ts": 'import "../db/x";\n' });
    init(dir);
    assert.equal(rulesHit(dir, "architecture/boundaries")[0].severity, "info");
    write(dir, "harness.yaml", read(dir, "harness.yaml").replace("boundaries: []", 'boundaries:\n  - from: "src/ui/**"\n    deny: ["src/db/**"]'));
    assert.equal(rulesHit(dir, "architecture/boundaries")[0].severity, "error");
  });
  it("parses boundary config, accepting a single deny string", () => {
    const r = parseConfig('version: 1\nproject: {name: x}\nboundaries:\n  - from: "a/**"\n    deny: "b/**"\n');
    assert.deepEqual(r.config?.boundaries, [{ from: "a/**", deny: ["b/**"] }]);
    assert.ok(parseConfig("version: 1\nproject: {name: x}\nboundaries: [{from: a}]\n").errors.length);
  });
});

describe("markdown", () => {
  it("collects reference-style links and GitHub anchors", () => {
    assert.deepEqual(markdownLinks("see [a][1]\n\n[1]: docs/x.md#y\n").map((l) => l.target), ["docs/x.md#y"]);
    assert.deepEqual([...headingAnchors("# Hello, World!\n## Ações & Regras\n# Hello, World!")], ["hello-world", "ações--regras", "hello-world-1"]);
  });
  it("flags missing anchors in local and linked docs", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir);
    write(dir, "AGENTS.md", read(dir, "AGENTS.md") + "\n[ok](docs/ARCHITECTURE.md#modules) [bad](docs/ARCHITECTURE.md#nope) [self](#commands) [selfbad](#zzz)\n");
    const msgs = rulesHit(dir, "context/broken-links").map((d) => d.message);
    assert.deepEqual(msgs, ["anchor #nope not found in docs/ARCHITECTURE.md", "anchor #zzz not found in AGENTS.md"]);
  });
  it("flags an entry file over the token budget", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir);
    write(dir, "AGENTS.md", read(dir, "AGENTS.md") + "x".repeat(12_000));
    assert.ok(rulesHit(dir, "context/entry-size").some((d) => d.message.includes("tokens")));
  });
});

describe("agents", () => {
  it("detects tools already in use and generates their files", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG, ".windsurf/x": "", ".clinerules/old.md": "x", "GEMINI.md": "# mine\n- rule\n" });
    assert.deepEqual(detectAgents(dir).sort(), ["cline", "gemini", "windsurf"]);
    const r = init(dir);
    assert.ok(r.config.agents.includes("windsurf"));
    assert.match(read(dir, ".windsurf/rules/gearness.md"), /trigger: always_on/);
    assert.match(read(dir, "GEMINI.md"), /@AGENTS\.md/);
    assert.match(read(dir, "AGENTS.md"), /From `GEMINI.md`/);
    assert.ok(fs.existsSync(path.join(dir, ADAPTERS.cline.file!)));
  });
});

describe("workspaces", () => {
  const mono = () =>
    tmpRepo({
      "package.json": JSON.stringify({ name: "mono", workspaces: ["packages/*"], scripts: { test: "x", lint: "y" } }),
      "packages/api/package.json": NODE_PKG,
      "packages/web/package.json": NODE_PKG,
    });
  it("init --workspaces scaffolds every workspace and links them from the root", () => {
    const dir = mono();
    const r = init(dir, { workspaces: true });
    assert.deepEqual(r.workspaces, ["packages/api", "packages/web"]);
    assert.ok(fs.existsSync(path.join(dir, "packages/api/harness.yaml")));
    assert.ok(!fs.existsSync(path.join(dir, "packages/api/.github/copilot-instructions.md")), "copilot only reads the root");
    assert.match(read(dir, "AGENTS.md"), /\[packages\/api\]\(packages\/api\/AGENTS\.md\)/);
    assert.deepEqual(loadConfig(dir).config?.workspaces, ["packages/*"]);
  });
  it("evaluates each workspace and finds the root CI from a workspace", async () => {
    const dir = mono();
    const { config } = init(dir, { workspaces: true });
    const tree = await evaluateTree(dir, config);
    assert.deepEqual(tree.map((w) => w.dir), [".", "packages/api", "packages/web"]);
    assert.ok(tree.every((w) => !w.report!.diagnostics.some((d) => d.rule === "feedback/ci-gate")));
  });
  it("warns when a workspace has no harness", () => {
    const dir = mono();
    init(dir, { workspaces: true });
    fs.rmSync(path.join(dir, "packages/web/harness.yaml"));
    assert.match(rulesHit(dir, "context/workspaces")[0].message, /packages\/web has no harness\.yaml/);
  });
});

describe("custom rules", () => {
  it("loads local rules and validates them", async () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    const { config } = init(dir);
    write(dir, ".harness/rules/team.mjs", 'export default { id: "team/x", pillar: "safety", weight: 3, severity: "warn", description: "d", check: () => [{ message: "hit" }] };\n');
    const extra = await loadExtraRules(dir, config);
    assert.equal(extra[0].id, "team/x");
    assert.ok(evaluate(dir, config, new Date(), extra).diagnostics.some((d) => d.rule === "team/x"));
    write(dir, ".harness/rules/bad.mjs", 'export default { id: "nope" };\n');
    await assert.rejects(loadExtraRules(dir, config), /team\/rule-name/);
  });
  it("turns a crashing rule into a diagnostic instead of crashing", async () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    const { config } = init(dir);
    write(dir, ".harness/rules/boom.mjs", 'export default { id: "team/boom", pillar: "safety", weight: 1, severity: "warn", description: "d", check: () => { throw new Error("kaput"); } };\n');
    const r = evaluate(dir, config, new Date(), await loadExtraRules(dir, config));
    assert.match(r.diagnostics.find((d) => d.rule === "team/boom")!.message, /rule crashed: kaput/);
  });
  it("reports a missing plugin package clearly", async () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    const { config } = init(dir);
    await assert.rejects(loadExtraRules(dir, { ...config, plugins: ["gearness-preset-missing"] }), /not found/);
  });
});

describe("safety and runners", () => {
  it("detects connection strings with passwords", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir);
    write(dir, "docs/CONVENTIONS.md", "DB: postgres://admin:hunter22@db.internal:5432/app\n");
    assert.ok(rulesHit(dir, "safety/no-secrets").length);
  });
  it("checks just recipes", () => {
    const dir = tmpRepo({ "go.mod": "module x\n", justfile: "test:\n  go test ./...\n" });
    init(dir);
    write(dir, "harness.yaml", read(dir, "harness.yaml").replace("test: just test", "test: just unit"));
    assert.match(rulesHit(dir, "commands/resolvable")[0].message, /justfile has no `unit`/);
  });
});

const fakeAgent = (dir: string) => {
  write(dir, "agent.cjs", `const fs=require("fs");const p=process.env.GEARNESS_PROMPT;
if(fs.readFileSync("AGENTS.md","utf8").includes("MAGIC")) fs.writeFileSync("DONE","1");
if(p.includes("break")) fs.appendFileSync("AGENTS.md","x");
if(p.includes("hang")) setTimeout(()=>{},10000);\n`);
  write(dir, "check.cjs", 'process.exit(require("fs").existsSync("DONE")?0:1);\n');
};

describe("eval", () => {
  const setup = () => {
    const dir = tmpRepo({ "package.json": JSON.stringify({ name: "e", scripts: { test: "node check.cjs" } }) });
    fakeAgent(dir);
    const { config } = init(dir, { agents: ["claude"], ci: false });
    for (const [id, prompt] of [["do-it", "do the thing"], ["break-it", "break the rules"]]) {
      newTask(dir, config, id);
      const f = `.harness/evals/${id}.yaml`;
      write(dir, f, read(dir, f).replace(/prompt: \|\n  .*\n/, `prompt: |\n  ${prompt}\n`).replace(/setup: .*\n/, ""));
    }
    gitInit(dir);
    return { dir, config: loadConfig(dir).config! };
  };
  it("quotes prompts safely for the shell", () => {
    if (process.platform !== "win32") assert.equal(agentCommand("echo", "it's $HOME"), `echo 'it'\\''s $HOME'`);
    assert.match(agentCommand("claude", "x"), /^claude -p /);
  });
  it("rejects tasks with leftover placeholders", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    const { config } = init(dir);
    newTask(dir, config, "todo");
    assert.match(loadTasks(dir, config).errors[0], /placeholders/);
  });
  it("measures the effect of an uncommitted harness change against a baseline ref", NEEDS_GIT, async () => {
    const { dir, config } = setup();
    write(dir, "AGENTS.md", read(dir, "AGENTS.md").replace("## Learned rules", "MAGIC: always create DONE.\n\n## Learned rules"));
    const s = await runEval(dir, config, { agent: "node agent.cjs", baseline: "HEAD", tasks: ["do-it"] });
    assert.deepEqual(s.variants.map((v) => v.passRate), [1, 0]);
    assert.ok(fs.readdirSync(path.join(dir, ".harness/eval-results")).length === 1);
    const worktrees = execFileSync("git", ["worktree", "list"], { cwd: dir }).toString().trim().split("\n");
    assert.equal(worktrees.length, 1, "worktrees are cleaned up");
    assert.match(read(dir, "AGENTS.md"), /MAGIC/, "working tree untouched");
  });
  it("fails a task that changes forbidden files, and times out hung agents", NEEDS_GIT, async () => {
    const { dir, config } = setup();
    const s = await runEval(dir, config, { agent: "node agent.cjs", tasks: ["break-it"] });
    assert.match(s.runs[0].reason, /forbidden files: AGENTS\.md/);
    write(dir, ".harness/evals/hang.yaml", 'id: hang\nprompt: hang forever\ncheck: "node check.cjs"\ntimeoutSeconds: 1\n');
    const started = Date.now();
    const t = await runEval(dir, config, { agent: "node agent.cjs", tasks: ["hang"] });
    assert.ok(Date.now() - started < 8000, "hung agent is killed at the timeout, not awaited");
    assert.equal(t.runs[0].reason, "agent timed out");
  });
  it("cli eval --min-pass-rate gates CI", NEEDS_GIT, () => {
    const { dir } = setup();
    const r = spawnSync("node", [CLI, "eval", "--agent", "node agent.cjs", "--task", "do-it", "--min-pass-rate", "1", "--json", "--cwd", dir], { env: TEST_ENV });
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout.toString()).variants[0].passRate, 0);
  });
});

describe("cli extras", () => {
  it("badge and markdown report", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir);
    const env = TEST_ENV;
    assert.match(execFileSync("node", [CLI, "badge", "--cwd", dir], { env, stdio: "pipe" }).toString(), /img\.shields\.io\/badge\/harness-\d+%2F100/);
    assert.match(execFileSync("node", [CLI, "doctor", "--markdown", "--cwd", dir], { env, stdio: "pipe" }).toString(), /^## .* Harness score: \d+\/100/);
  });
  it("lint --fix syncs adapters inside workspaces too", () => {
    const dir = tmpRepo({ "package.json": JSON.stringify({ name: "m", workspaces: ["packages/*"] }), "packages/a/package.json": NODE_PKG });
    init(dir, { workspaces: true });
    write(dir, "packages/a/AGENTS.md", read(dir, "packages/a/AGENTS.md") + "\nnew rule\n");
    const out = spawnSync("node", [CLI, "lint", "--fix", "--cwd", dir], { env: TEST_ENV }).stdout.toString();
    assert.match(out, /regenerated packages\/a\/\.cursor\/rules\/gearness\.mdc/);
    const { config } = loadConfig(path.join(dir, "packages/a"));
    assert.ok(sync(path.join(dir, "packages/a"), config!).every((r) => r.action !== "written"));
  });
});

describe("windows line endings", () => {
  it("treats CRLF checkouts as in sync and parses their headings", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir);
    write(dir, "AGENTS.md", read(dir, "AGENTS.md") + "[m](docs/ARCHITECTURE.md#modules)\n");
    const { config } = loadConfig(dir);
    sync(dir, config!);
    // Simulate a Windows checkout with core.autocrlf=true.
    for (const f of ["AGENTS.md", ".github/copilot-instructions.md", ".cursor/rules/gearness.mdc", "CLAUDE.md", "docs/ARCHITECTURE.md"])
      fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(dir, f), "utf8").replace(/\n/g, "\r\n"));
    assert.equal(rulesHit(dir, "tooling/adapters-in-sync").length, 0);
    assert.equal(rulesHit(dir, "context/broken-links").length, 0);
  });
});
