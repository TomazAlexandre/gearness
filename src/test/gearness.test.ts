import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { adapterStatus, rewriteLinks, sync } from "../adapters.js";
import { loadConfig, parseConfig } from "../config.js";
import { detect } from "../detect.js";
import { init } from "../init.js";
import { addEntry, loadRatchet } from "../ratchet.js";
import { evaluate } from "../score.js";
import { NODE_PKG, read, tmpRepo, write } from "./helpers.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const ids = (dir: string) => {
  const { config } = loadConfig(dir);
  return evaluate(dir, config!).diagnostics.map((d) => `${d.severity}:${d.rule}`);
};

describe("detect", () => {
  it("detects node scripts and package manager", () => {
    const d = detect(tmpRepo({ "package.json": NODE_PKG, "pnpm-lock.yaml": "" }));
    assert.equal(d.stack, "node");
    assert.equal(d.name, "demo-app");
    assert.equal(d.commands.test, "pnpm run test");
    assert.equal(d.commands.install, "pnpm install");
  });
  it("detects python with uv", () => {
    const d = detect(tmpRepo({ "pyproject.toml": 'name = "svc"\n[tool.ruff]\n', "uv.lock": "" }));
    assert.equal(d.stack, "python");
    assert.equal(d.commands.test, "uv run pytest");
    assert.equal(d.commands.lint, "uv run ruff check .");
  });
  it("prefers Makefile targets", () => {
    const d = detect(tmpRepo({ "go.mod": "module example.com/x/api\n", Makefile: "test:\n\tgo test ./...\n" }));
    assert.equal(d.stack, "go");
    assert.equal(d.commands.test, "make test");
    assert.equal(d.name, "api");
  });
});

describe("config", () => {
  it("rejects invalid config with readable errors", () => {
    const r = parseConfig("version: 2\nstack: cobol\nagents: [vim]\n");
    assert.ok(r.errors.some((e) => e.includes("version")));
    assert.ok(r.errors.some((e) => e.includes("project.name")));
    assert.ok(r.errors.some((e) => e.includes("stack")));
    assert.ok(r.errors.some((e) => e.includes("vim")));
  });
  it("fills defaults", () => {
    const r = parseConfig("version: 1\nproject: { name: x }\n");
    assert.equal(r.config?.context.entry, "AGENTS.md");
    assert.equal(r.config?.gates.minScore, 70);
  });
});

describe("init", () => {
  it("scaffolds a lint-clean harness (no errors or broken links)", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir);
    for (const f of ["harness.yaml", "AGENTS.md", "docs/ARCHITECTURE.md", "docs/STATUS.md", ".harness/ratchet.yaml", ".github/workflows/gearness.yml", "CLAUDE.md", ".cursor/rules/gearness.mdc", ".github/copilot-instructions.md"])
      assert.ok(fs.existsSync(path.join(dir, f)), `${f} should exist`);
    assert.ok(!ids(dir).some((d) => d.startsWith("error")), ids(dir).join(", "));
  });
  it("scores a fresh scaffold below excellent until placeholders are filled", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    const { config } = init(dir);
    const fresh = evaluate(dir, config).score;
    assert.ok(fresh >= 70 && fresh < 90, `fresh score ${fresh}`);
    for (const f of ["AGENTS.md", "docs/ARCHITECTURE.md", "docs/CONVENTIONS.md"]) write(dir, f, read(dir, f).replaceAll("TODO(gearness)", "Filled"));
    sync(dir, config);
    assert.ok(evaluate(dir, config).score > fresh);
  });
  it("imports a hand-written CLAUDE.md instead of losing it", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG, "CLAUDE.md": "# Rules\n- never touch src/generated\n" });
    const r = init(dir);
    assert.deepEqual(r.imported, ["CLAUDE.md"]);
    assert.match(read(dir, "AGENTS.md"), /never touch src\/generated/);
    assert.match(read(dir, "CLAUDE.md"), /@AGENTS\.md/);
  });
  it("refuses to run twice without --force", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir);
    assert.throws(() => init(dir), /already exists/);
  });
  it("keeps an existing AGENTS.md", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG, "AGENTS.md": "# Mine\n" });
    init(dir);
    assert.equal(read(dir, "AGENTS.md"), "# Mine\n");
  });
});

describe("rules", () => {
  const fresh = () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir);
    return dir;
  };
  it("detects adapter drift and fixes it with sync", () => {
    const dir = fresh();
    write(dir, "AGENTS.md", read(dir, "AGENTS.md") + "\nExtra rule.\n");
    assert.ok(ids(dir).includes("error:tooling/adapters-in-sync"));
    const { config } = loadConfig(dir);
    sync(dir, config!);
    assert.ok(!ids(dir).includes("error:tooling/adapters-in-sync"));
  });
  it("detects broken links but ignores links inside code", () => {
    const dir = fresh();
    write(dir, "AGENTS.md", read(dir, "AGENTS.md") + "\nSee [x](docs/missing.md).\n```md\n[y](docs/also-missing.md)\n```\n");
    const { config } = loadConfig(dir);
    const broken = evaluate(dir, config!).diagnostics.filter((d) => d.rule === "context/broken-links");
    assert.equal(broken.length, 1);
    assert.match(broken[0].message, /missing\.md/);
  });
  it("detects commands that point to missing scripts", () => {
    const dir = fresh();
    write(dir, "harness.yaml", read(dir, "harness.yaml").replace("test: npm run test", "test: npm run test:e2e"));
    assert.ok(ids(dir).includes("error:commands/resolvable"));
  });
  it("detects secrets in context files", () => {
    const dir = fresh();
    write(dir, "docs/CONVENTIONS.md", "token: ghp_" + "a".repeat(36) + "\n");
    assert.ok(ids(dir).includes("error:safety/no-secrets"));
  });
  it("respects rules.disable", () => {
    const dir = fresh();
    write(dir, "harness.yaml", read(dir, "harness.yaml").replace("disable: []", "disable: [context/placeholders]"));
    assert.ok(!ids(dir).some((d) => d.includes("context/placeholders")));
  });
});

describe("ratchet", () => {
  it("doc fixes write a learned rule into the entry file", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir);
    const e = addEntry(dir, "AGENTS.md", { failure: "edited generated code", fix: "doc", rule: "Never edit src/generated" });
    assert.equal(e.id, "R-001");
    assert.match(read(dir, "AGENTS.md"), /Never edit src\/generated\. _\(R-001\)_/);
    assert.equal(loadRatchet(dir).entries.length, 1);
  });
  it("mechanical fixes require an existing artifact", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir);
    assert.throws(() => addEntry(dir, "AGENTS.md", { failure: "x", fix: "lint", artifact: "eslint.config.js" }), /does not exist/);
    write(dir, "eslint.config.js", "export default [];\n");
    assert.equal(addEntry(dir, "AGENTS.md", { failure: "x", fix: "lint", artifact: "eslint.config.js" }).id, "R-001");
  });
  it("flags a learned rule that was silently deleted", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    init(dir);
    addEntry(dir, "AGENTS.md", { failure: "x", fix: "doc", rule: "Rule one" });
    write(dir, "AGENTS.md", read(dir, "AGENTS.md").replace(/- Rule one.*\n/, ""));
    assert.ok(ids(dir).includes("error:feedback/ratchet-valid"));
  });
});

describe("adapters", () => {
  it("rewrites relative links for copies in other folders", () => {
    const out = rewriteLinks("[a](docs/A.md#x) [b](https://x.dev) [c](#top)", "AGENTS.md", ".github/copilot-instructions.md");
    assert.equal(out, "[a](../docs/A.md#x) [b](https://x.dev) [c](#top)");
  });
  it("never overwrites hand-written files without force", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG, "AGENTS.md": "# A\n" });
    init(dir, { agents: ["copilot"] });
    write(dir, ".github/copilot-instructions.md", "mine\n");
    const { config } = loadConfig(dir);
    sync(dir, config!);
    assert.equal(read(dir, ".github/copilot-instructions.md"), "mine\n");
    assert.equal(adapterStatus(dir, config!)[0].state, "unmanaged");
  });
});

describe("cli", () => {
  const run = (dir: string, ...args: string[]) => {
    try {
      return { code: 0, out: execFileSync("node", [CLI, ...args, "--cwd", dir], { env: { ...process.env, NO_COLOR: "1" } }).toString() };
    } catch (e) {
      const err = e as { status: number; stdout: Buffer };
      return { code: err.status, out: err.stdout.toString() };
    }
  };
  it("doctor --ci passes on a fresh scaffold and fails on errors", () => {
    const dir = tmpRepo({ "package.json": NODE_PKG });
    assert.equal(run(dir, "init").code, 0);
    const ok = run(dir, "doctor", "--ci", "--json");
    assert.equal(ok.code, 0);
    assert.equal(typeof JSON.parse(ok.out).score, "number");
    fs.rmSync(path.join(dir, "docs/ARCHITECTURE.md"));
    assert.equal(run(dir, "doctor", "--ci").code, 1);
  });
  it("lint exits 2 without harness.yaml", () => {
    assert.equal(run(tmpRepo({}), "lint").code, 2);
  });
});
