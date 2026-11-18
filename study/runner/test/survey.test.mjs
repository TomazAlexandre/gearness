import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "../../surveys/agents-md/survey.mjs";

const row = (n, extra = {}) => ({ lines: 50, nSignals: n, signals: { content: n > 0, structure: n > 1, commands: n > 2, pointers: n > 3, rules: n > 4 }, rules: {}, ms: 5, ...extra });

test("summarize counts signs, the gate and the shares correctly", () => {
  const s = summarize([row(5), row(5), row(3), row(1)]);
  assert.equal(s.analysed, 4);
  assert.equal(s.signsOfRealContent[5].repos, 2);
  assert.equal(s.signsOfRealContent[5].share, 50);
  assert.deepEqual(s.belowSubstanceGate, { repos: 1, share: 25 });
  assert.equal(s.shareMissingEachSign.content, 0);
  assert.equal(s.shareMissingEachSign.rules, 50, "rows with 3 and 1 signs lack an explicit rule");
});

test("only context rules and secrets are reported: other pillars depend on a config the repositories do not have", () => {
  const s = summarize([row(5, { rules: { "context/entry-size": 1, "commands/defined": 1, "feedback/ci-gate": 1, "safety/no-secrets": 2 } }), row(5)]);
  assert.deepEqual(Object.keys(s.reposWithFinding).sort(), ["context/entry-size", "safety/no-secrets"]);
  assert.equal(s.reposWithFinding["context/entry-size"].share, 50);
});

test("lines and timing use medians and percentiles, and an empty survey does not crash", () => {
  const s = summarize([row(5, { lines: 10, ms: 1 }), row(5, { lines: 20, ms: 3 }), row(5, { lines: 400, ms: 9 })]);
  assert.equal(s.lines.median, 20);
  assert.equal(s.lines.max, 400);
  assert.equal(s.evaluationMs.median, 3);
  const empty = summarize([]);
  assert.equal(empty.analysed, 0);
  assert.equal(empty.belowSubstanceGate.share, null);
});
