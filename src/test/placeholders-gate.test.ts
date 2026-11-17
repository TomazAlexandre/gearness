import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { init } from "../init.js";
import { MIN_SUBSTANCE, substanceSignals } from "../rules.js";
import { evaluate } from "../score.js";
import { PLACEHOLDER } from "../templates.js";
import { tmpRepo } from "./helpers.js";

const BARE = "version: 1\nproject:\n  name: p\nagents: []\n";
const WEIGHT = 30;
const run = (dir: string) => evaluate(dir, loadConfig(dir).config!);
const placeholders = (dir: string) => run(dir).results.find((r) => r.rule.id === "context/placeholders")!;
const repo = (agents?: string, extra: Record<string, string> = {}) => tmpRepo({ "harness.yaml": BARE, ...(agents === undefined ? {} : { "AGENTS.md": agents }), ...extra });
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);

// Built to carry exactly N of the five signs: content, structure, commands, pointers, rules.
const THREE = `# T\n\n## Commands\n\n- Test: \`npm test\`\n\n## Notes\n\n${Array.from({ length: 8 }, (_, i) => `The service handles step ${i} of the flow.`).join("\n")}\n`;
const TWO = "# T\n\n## Commands\n\n- Test: `npm test`\n\n## Notes\n\nShort.\n";
const ONE = "# gearness\n\nRun `npm test` before you finish.\n";

describe("context/placeholders needs real content, not just no markers", () => {
  it("the fixtures carry the number of signs their names claim", () => {
    const n = (t: string) => substanceSignals(t, () => false).filter((x) => x.ok).length;
    assert.deepEqual([n(ONE), n(TWO), n(THREE)], [1, 2, 3]);
  });

  it("an entry file with 3 or more signs keeps full credit and gets no extra finding", () => {
    assert.equal(MIN_SUBSTANCE, 3);
    const p = placeholders(repo(THREE));
    near(p.earned, WEIGHT);
    assert.ok(!p.diagnostics.some((d) => /markers left/.test(d.message)));
  });

  it("credit falls in proportion below that: 2 signs earn two thirds, 1 earns one third", () => {
    near(placeholders(repo(TWO)).earned, (WEIGHT * 2) / 3);
    near(placeholders(repo(ONE)).earned, (WEIGHT * 1) / 3);
  });

  it("an empty entry file earns nothing from this rule", () => {
    near(placeholders(repo("# t\n")).earned, 0);
  });

  it("explains why points were lost, pointing at entry-substance", () => {
    const d = placeholders(repo(ONE)).diagnostics.find((x) => /markers left/.test(x.message))!;
    assert.ok(d);
    assert.match(d.message, /only 1 of 5 signs/);
    assert.match(d.hint ?? "", /entry-substance/);
  });

  it("never raises credit: leftover scaffold markers still cost points, whatever else the file has", () => {
    const scaffold = `${THREE}\n${Array.from({ length: 6 }, () => `${PLACEHOLDER} fill this in`).join("\n")}\n`;
    near(placeholders(repo(scaffold)).earned, 0);
  });

  it("a missing entry file is left to the score cap", () => {
    const r = run(repo());
    near(r.results.find((x) => x.rule.id === "context/placeholders")!.earned, WEIGHT);
    assert.ok(r.cap, "the cap is what stops this project from scoring well");
  });

  it("a freshly initialised project is unchanged: its markers already cost the points", () => {
    const dir = tmpRepo({ "package.json": '{"name":"x","scripts":{"test":"echo t"}}\n' });
    init(dir, { force: false });
    const r = run(dir);
    assert.equal(r.cap, undefined);
    near(r.results.find((x) => x.rule.id === "context/placeholders")!.earned, 0);
    assert.ok(!r.diagnostics.some((d) => /markers left/.test(d.message)), "no double reporting next to the marker finding");
  });

  it("a thin entry file now scores in the C band, below a substantive one", () => {
    const thin = run(repo(ONE));
    const solid = run(repo(THREE));
    assert.ok(thin.score < solid.score);
    assert.ok(thin.score <= 75, `thin scored ${thin.score}`);
  });

  it("can still be disabled like any rule", () => {
    const d = repo(ONE, { "harness.yaml": `${BARE}rules:\n  disable: [context/placeholders]\n` });
    assert.equal(run(d).results.find((x) => x.rule.id === "context/placeholders"), undefined);
  });
});
