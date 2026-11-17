import assert from "node:assert/strict";
import test from "node:test";
import { analyze, render } from "../report.mjs";

const row = (condition, task, run, passed, extra = {}) => ({ study: "s", condition, task, run, passed, invalid: false, reason: passed ? "ok" : "check failed (exit 1)", forbidden: 0, durationMs: 60000, ...extra });
const rows = [];
for (const t of ["t1", "t2", "t3", "t4"]) for (let r = 1; r <= 5; r++) {
  rows.push(row("full", t, r, true));
  rows.push(row("minimal", t, r, t === "t1" && r <= 2));
  rows.push(row("none", t, r, false));
}

test("analyze: pass rates, comparisons and verdicts on a clear effect", () => {
  const a = analyze({ rows }, { B: 2000, seed: 1 });
  assert.deepEqual(a.conditions, ["full", "minimal", "none"]);
  assert.equal(a.perCond.full.macro.mean, 1);
  assert.equal(a.perCond.none.macro.mean, 0);
  assert.ok(Math.abs(a.perCond.minimal.macro.mean - 0.1) < 1e-9);
  const fm = a.comparisons.find((c) => c.a === "full" && c.b === "minimal");
  assert.equal(fm.primary, true);
  assert.equal(fm.verdict, "full better");
  assert.equal(a.comparisons.find((c) => c.a === "minimal" && c.b === "none").primary, false);
});

test("analyze: no effect is reported as inconclusive, never as a win", () => {
  const same = [];
  for (const t of ["t1", "t2", "t3"]) for (let r = 1; r <= 4; r++) for (const c of ["full", "minimal"]) same.push(row(c, t, r, (t === "t1" ? r % 2 : 1) === 1));
  const a = analyze({ rows: same }, { B: 2000, seed: 1 });
  assert.equal(a.comparisons[0].verdict, "inconclusive");
});

test("invalid runs are excluded from the primary rate and counted as failures in the sensitivity column", () => {
  const rs = [row("full", "t1", 1, true), row("full", "t1", 2, true), row("full", "t1", 3, false, { invalid: true, reason: "setup failed" })];
  const a = analyze({ rows: rs }, { B: 200, seed: 1 });
  assert.equal(a.perCond.full.macro.mean, 1);
  assert.equal(a.perCond.full.invalid, 1);
  assert.ok(Math.abs(a.perCond.full.strictMacro - 2 / 3) < 1e-9);
});

test("cost comes from metrics and the harness score correlation needs enough points", () => {
  const metrics = [{ condition: "full", costUsd: 0.5 }, { condition: "full", costUsd: 1.5 }, { condition: "none", costUsd: 0.2 }];
  const a = analyze({ rows, metrics, scores: [{ study: "s", condition: "full", score: 90 }, { study: "s", condition: "none", score: 10 }] }, { B: 200, seed: 1 });
  assert.equal(a.perCond.full.meanCost, 1);
  assert.equal(a.perCond.minimal.meanCost, null);
  assert.equal(a.correlation.rho, null);
});

test("render states what it measured and what it cannot claim", () => {
  const md = render(analyze({ rows }, { B: 500, seed: 1 }), [{ study: "s" }]);
  for (const s of ["## Pass rate by condition", "## Pass rate per task", "pre-registered", "exploratory", "## Sensitivity", "cluster bootstrap", "Read this before quoting a number", "full better"]) assert.ok(md.includes(s), `missing: ${s}`);
});
