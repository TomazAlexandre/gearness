// Dependency-free statistics for the study report.
// All randomness is seeded: the same raw results always produce the same report.

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Wilson score interval for k successes in n trials (better than the normal approximation for small n). */
export function wilson(k, n, z = 1.96) {
  if (n === 0) return { p: NaN, lo: NaN, hi: NaN };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

/** mulberry32: small, fast, seedable PRNG returning floats in [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentileCI(draws, alpha = 0.05) {
  const s = [...draws].sort((a, b) => a - b);
  const lo = s[Math.floor((alpha / 2) * s.length)];
  const hi = s[Math.min(s.length - 1, Math.ceil((1 - alpha / 2) * s.length) - 1)];
  return { lo, hi };
}

/** Macro average: the mean over tasks of each task's pass rate. perTask = { taskId: [0|1, ...] } */
export function macro(perTask) {
  const rates = Object.values(perTask).filter((r) => r.length).map(mean);
  return mean(rates);
}

const resampleRate = (runs, rand) => {
  let k = 0;
  for (let i = 0; i < runs.length; i++) k += runs[Math.floor(rand() * runs.length)];
  return k / runs.length;
};

/**
 * Cluster bootstrap of the macro pass rate. Runs of one task are not independent observations, so we
 * resample tasks first and runs within each drawn task second. With few tasks the interval is wide: that is honest.
 */
export function bootstrapMacro(perTask, { B = 10000, seed = 1 } = {}) {
  const tasks = Object.keys(perTask).filter((t) => perTask[t].length);
  if (!tasks.length) return { mean: NaN, lo: NaN, hi: NaN };
  const rand = rng(seed);
  const draws = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < tasks.length; i++) s += resampleRate(perTask[tasks[Math.floor(rand() * tasks.length)]], rand);
    draws.push(s / tasks.length);
  }
  return { mean: macro(perTask), ...percentileCI(draws) };
}

/** Paired cluster bootstrap of macro(a) - macro(b) over the tasks both conditions have. */
export function bootstrapDiff(a, b, { B = 10000, seed = 1 } = {}) {
  const tasks = Object.keys(a).filter((t) => a[t].length && b[t]?.length);
  if (!tasks.length) return { mean: NaN, lo: NaN, hi: NaN, tasks: 0 };
  const rand = rng(seed);
  const draws = [];
  for (let i = 0; i < B; i++) {
    let s = 0;
    for (let j = 0; j < tasks.length; j++) {
      const t = tasks[Math.floor(rand() * tasks.length)];
      s += resampleRate(a[t], rand) - resampleRate(b[t], rand);
    }
    draws.push(s / tasks.length);
  }
  const point = mean(tasks.map((t) => mean(a[t]) - mean(b[t])));
  return { mean: point, ...percentileCI(draws), tasks: tasks.length };
}

function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; // average rank for ties
    i = j + 1;
  }
  return r;
}

/** Spearman rank correlation (NaN when either series is constant). */
export function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return NaN;
  const rx = ranks(xs), ry = ranks(ys);
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : NaN;
}
