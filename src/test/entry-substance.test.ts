import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { RULES, substanceSignals } from "../rules.js";
import { evaluate } from "../score.js";
import { tmpRepo } from "./helpers.js";

const BARE = "version: 1\nproject:\n  name: p\nagents: []\n";
const SOLID = `# Shop API

Orders and payments service.

## Commands

- Install: \`npm ci\`
- Test: \`npm test\`
- Lint: \`npm run lint\`

## Conventions

- Money is always integer cents; never use floats.
- Handlers live in \`src/handlers/\` and must not import from \`src/db/\` directly.
- Do not edit \`src/generated/\` by hand.
- Prefer the injected clock over \`Date.now()\`.

## Map

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
`;
const FILES = { "docs/ARCHITECTURE.md": "# a\n", "src/handlers/a.ts": "x", "src/db/b.ts": "x", "src/generated/c.ts": "x" };
const repo = (agents: string, extra: Record<string, string> = {}) => tmpRepo({ "harness.yaml": BARE, "AGENTS.md": agents, ...FILES, ...extra });
const run = (dir: string) => evaluate(dir, loadConfig(dir).config!);
const found = (dir: string) => run(dir).diagnostics.filter((d) => d.rule === "context/entry-substance");
const ids = (text: string, exists: (p: string) => boolean = () => false) => substanceSignals(text, exists).filter((s) => !s.ok).map((s) => s.id);

describe("context/entry-substance", () => {
  it("is registered in the context pillar", () => {
    const r = RULES.find((x) => x.id === "context/entry-substance");
    assert.ok(r);
    assert.equal(r!.pillar, "context");
  });

  it("flags an entry file that is a title and one command", () => {
    const d = repo("# gearness\n\nRun `npm test` before you finish.\n");
    assert.deepEqual(ids("# gearness\n\nRun `npm test` before you finish.\n").sort(), ["content", "pointers", "rules", "structure"]);
    assert.equal(found(d).length, 4);
  });

  it("accepts a substantive entry file", () => {
    assert.equal(found(repo(SOLID)).length, 0);
  });

  it("gives partial credit per signal, so thin scores below substantive", () => {
    const thin = run(repo("# gearness\n\nRun `npm test` before you finish.\n"));
    const solid = run(repo(SOLID));
    const t = thin.results.find((r) => r.rule.id === "context/entry-substance")!;
    assert.ok(Math.abs(t.earned - (t.rule.weight * 1) / 5) < 1e-9, "1 of 5 signals met");
    assert.ok(thin.score < solid.score);
  });

  it("counts commands written in fenced blocks, with or without a shell prompt", () => {
    assert.ok(!ids("```bash\n$ npm test\n```\n").includes("commands"));
    assert.ok(!ids("```\nmake check\n```\n").includes("commands"));
    assert.ok(ids("Use the tests.\n").includes("commands"));
  });

  it("recognises commands that start with environment assignments, other runners and scripts", () => {
    for (const c of ["PYTHONPATH=src python -m unittest discover -s tests", "CI=1 FORCE_COLOR=0 npm test", "swift test", "flutter test", "mix test", "./scripts/test.sh", "bazel test //..."]) {
      assert.ok(!ids(`Run \`${c}\` before committing.`).includes("commands"), c);
    }
    for (const c of ["docs/guide.md", "src/handlers/", "FOO=bar", "./README.md"]) {
      assert.ok(ids(`See \`${c}\` for details.`).includes("commands"), `${c} is not a command`);
    }
  });

  it("does not count scaffold placeholders, headings or fenced code as real content", () => {
    const scaffold = Array.from({ length: 20 }, (_, i) => `TODO(gearness) fill in line ${i}`).join("\n");
    assert.ok(ids(scaffold).includes("content"));
    const headingsOnly = Array.from({ length: 20 }, (_, i) => `## Section ${i}`).join("\n");
    assert.ok(ids(headingsOnly).includes("content"));
    const codeOnly = "```\n" + Array.from({ length: 20 }, (_, i) => `echo ${i}`).join("\n") + "\n```\n";
    assert.ok(ids(codeOnly).includes("content"));
  });

  it("ignores '#' comment lines inside code fences when counting headings", () => {
    assert.ok(ids("```bash\n## not a heading\n### nor this\n```\n").includes("structure"));
  });

  it("only credits pointers to files and folders that exist", () => {
    const exists = (p: string) => p === "src/handlers" || p === "docs/guide.md";
    assert.ok(!ids("See `src/handlers/` for the code.", exists).includes("pointers"), "folder, trailing slash");
    assert.ok(!ids("Read [the guide](./docs/guide.md).", exists).includes("pointers"), "markdown link");
    assert.ok(ids("See `src/nowhere/` and [x](https://example.com).", exists).includes("pointers"), "dead path and external URL do not count");
  });

  it("stays quiet when the entry file is missing (the score cap covers that case)", () => {
    const d = tmpRepo({ "harness.yaml": BARE });
    assert.equal(found(d).length, 0);
  });

  it("can be disabled like any rule", () => {
    const d = repo("# t\n", { "harness.yaml": `${BARE}rules:\n  disable: [context/entry-substance]\n` });
    assert.equal(found(d).length, 0);
  });
});
