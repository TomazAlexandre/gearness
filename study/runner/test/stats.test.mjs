import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapDiff, bootstrapMacro, macro, rng, spearman, wilson } from "../stats.mjs";

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test("wilson interval matches the textbook value for 5/10", () => {
  const w = wilson(5, 10);
  close(w.p, 0.5);
  close(w.lo, 0.2366);
  close(w.hi, 0.7634);
});

test("wilson handles the edges without leaving [0,1]", () => {
  const all = wilson(10, 10), none = wilson(0, 10);
  assert.equal(all.hi, 1);
  assert.ok(all.lo > 0.6 && all.lo < 0.8);
  assert.equal(none.lo, 0);
  assert.ok(Number.isNaN(wilson(0, 0).p));
});

test("rng is deterministic per seed and differs across seeds", () => {
  const a = rng(42), b = rng(42), c = rng(43);
  const xs = [a(), a(), a()], ys = [b(), b(), b()];
  assert.deepEqual(xs, ys);
  assert.notDeepEqual(xs, [c(), c(), c()]);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test("macro averages per-task rates, not pooled runs", () => {
  // task a: 1/1, task b: 0/9 -> macro 0.5 (a pooled rate would be 0.1)
  close(macro({ a: [1], b: [0, 0, 0, 0, 0, 0, 0, 0, 0] }), 0.5);
});

test("bootstrapMacro: degenerate data gives a degenerate interval; mixed data a wide one", () => {
  const all = bootstrapMacro({ a: [1, 1, 1], b: [1, 1, 1] }, { B: 500, seed: 3 });
  assert.deepEqual([all.mean, all.lo, all.hi], [1, 1, 1]);
  const mixed = bootstrapMacro({ a: [1, 1, 1, 1], b: [0, 0, 0, 0], c: [1, 0, 1, 0] }, { B: 2000, seed: 3 });
  close(mixed.mean, 0.5);
  assert.ok(mixed.lo < 0.5 && mixed.hi > 0.5);
  assert.deepEqual(mixed, bootstrapMacro({ a: [1, 1, 1, 1], b: [0, 0, 0, 0], c: [1, 0, 1, 0] }, { B: 2000, seed: 3 }));
});

test("bootstrapDiff separates a clear effect and straddles zero for noise", () => {
  const good = { t1: [1, 1, 1], t2: [1, 1, 1], t3: [1, 1, 0] };
  const bad = { t1: [0, 0, 0], t2: [0, 0, 1], t3: [0, 0, 0] };
  const clear = bootstrapDiff(good, bad, { B: 2000, seed: 5 });
  assert.ok(clear.mean > 0.6 && clear.lo > 0, JSON.stringify(clear));
  const same = bootstrapDiff(good, good, { B: 2000, seed: 5 });
  assert.equal(same.mean, 0);
  assert.ok(same.lo <= 0 && same.hi >= 0);
  assert.equal(bootstrapDiff({ a: [1] }, { b: [1] }).tasks, 0);
});

test("spearman: perfect, reversed, ties and constant series", () => {
  close(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  close(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  close(spearman([1, 2, 2, 4], [1, 2, 2, 4]), 1);
  assert.ok(Number.isNaN(spearman([1, 1, 1], [1, 2, 3])));
  assert.ok(Number.isNaN(spearman([1, 2], [1, 2])));
});
