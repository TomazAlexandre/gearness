#!/usr/bin/env node
// Survey: how do real AGENTS.md files look to gearness' rules?
// Samples public repositories tagged `agents-md` (two views: most starred, most recently updated), downloads each as a
// tarball, gives it a git repository (a real clone has one, and some rules read .gitignore), runs the context rules on the
// root AGENTS.md and writes ONLY aggregates. Per-repository rows are never written to the repository.
//   node study/surveys/agents-md/survey.mjs [--limit 160] [--pages 2] [--topic agents-md] [--keep]
// Set GITHUB_TOKEN to lift the unauthenticated search limit (10 requests/minute). Needs Node 18+, git and tar.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../../dist");
const SIGNS = ["content", "structure", "commands", "pointers", "rules"];
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const quantile = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };

/** Pure aggregation over analysed rows (testable). Context rules only: other pillars depend on a config the repos do not have. */
export function summarize(rows, minSubstance = 3) {
  const n = rows.length;
  const share = (k) => (n ? Math.round((1000 * k) / n) / 10 : null);
  const signCount = Array.from({ length: 6 }, (_, k) => rows.filter((r) => r.nSignals === k).length);
  const byRule = {};
  for (const r of rows) for (const id of Object.keys(r.rules)) byRule[id] = (byRule[id] ?? 0) + 1;
  const contextRules = Object.fromEntries(Object.entries(byRule).filter(([id]) => id.startsWith("context/") || id === "safety/no-secrets").sort((a, b) => b[1] - a[1]).map(([id, k]) => [id, { repos: k, share: share(k) }]));
  const missingSign = Object.fromEntries(SIGNS.map((s) => [s, share(rows.filter((r) => !r.signals[s]).length)]));
  return {
    analysed: n,
    lines: { median: median(rows.map((r) => r.lines)), p90: quantile(rows.map((r) => r.lines), 0.9), max: Math.max(0, ...rows.map((r) => r.lines)) },
    signsOfRealContent: Object.fromEntries(signCount.map((k, i) => [i, { repos: k, share: share(k) }])),
    belowSubstanceGate: { repos: rows.filter((r) => r.nSignals < minSubstance).length, share: share(rows.filter((r) => r.nSignals < minSubstance).length) },
    shareMissingEachSign: missingSign,
    reposWithFinding: contextRules,
    evaluationMs: { median: median(rows.map((r) => r.ms)), p90: quantile(rows.map((r) => r.ms), 0.9), max: Math.max(0, ...rows.map((r) => r.ms)) },
  };
}

async function api(url, token) {
  const r = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "gearness-survey", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status} ${r.status === 403 ? "(rate limited: set GITHUB_TOKEN)" : ""}`);
  return r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sample({ topic, pages, limit, token }) {
  const repos = new Map();
  for (const sort of ["stars", "updated"])
    for (let page = 1; page <= pages; page++) {
      const d = await api(`https://api.github.com/search/repositories?q=topic:${topic}&sort=${sort}&order=desc&per_page=50&page=${page}`, token);
      for (const r of d.items) if (!r.fork && !r.archived && r.size <= 30000 && !repos.has(r.full_name)) repos.set(r.full_name, { stars: r.stargazers_count, view: sort });
      await sleep(token ? 500 : 7000);
    }
  return [...repos].slice(0, limit);
}

async function download(name, dest) {
  if (fs.existsSync(path.join(dest, ".git"))) return true;
  fs.mkdirSync(dest, { recursive: true });
  const res = await fetch(`https://codeload.github.com/${name}/tar.gz/HEAD`);
  if (!res.ok) return false;
  const tgz = `${dest}.tgz`;
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  const x = spawnSync("tar", ["-xf", tgz, "-C", dest, "--strip-components=1"], { stdio: "ignore" });
  fs.rmSync(tgz, { force: true });
  if (x.status !== 0) return false;
  spawnSync("git", ["init", "-q"], { cwd: dest });
  return true;
}

async function pool(items, size, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

async function analyse(dir, meta, { loadConfig, evaluate, substanceSignals }) {
  const entry = path.join(dir, "AGENTS.md");
  if (!fs.existsSync(entry)) return null;
  const text = fs.readFileSync(entry, "utf8");
  const sig = substanceSignals(text, (rel) => { try { return fs.existsSync(path.join(dir, rel)); } catch { return false; } });
  fs.writeFileSync(path.join(dir, "harness.yaml"), "version: 1\nproject:\n  name: survey\nagents: []\n");
  const cfg = loadConfig(dir);
  if (!cfg.config) return null;
  const t0 = Date.now();
  const rep = evaluate(dir, cfg.config);
  const rules = {};
  for (const d of rep.diagnostics) rules[d.rule] = (rules[d.rule] ?? 0) + 1;
  return { ...meta, lines: text.split("\n").length, signals: Object.fromEntries(sig.map((s) => [s.id, s.ok])), nSignals: sig.filter((s) => s.ok).length, rules, ms: Date.now() - t0 };
}

export async function main(argv) {
  const { values: v } = parseArgs({ args: argv, options: { limit: { type: "string" }, pages: { type: "string" }, topic: { type: "string" }, keep: { type: "boolean" } } });
  if (!fs.existsSync(path.join(DIST, "score.js"))) throw new Error("run `npm run build` first");
  const mods = { ...(await import(pathToFileURL(path.join(DIST, "config.js")))), ...(await import(pathToFileURL(path.join(DIST, "score.js")))), ...(await import(pathToFileURL(path.join(DIST, "rules.js")))) };
  const token = process.env.GITHUB_TOKEN;
  const topic = v.topic ?? "agents-md";
  const picked = await sample({ topic, pages: Number(v.pages ?? 2), limit: Number(v.limit ?? 160), token });
  console.error(`sampled ${picked.length} repositories tagged ${topic}; downloading...`);
  const work = path.join(os.tmpdir(), "gearness-survey"); // outside the repository: nothing to ignore, nothing to commit by accident
  const ok = await pool(picked, 6, async ([name, meta]) => ({ name, meta, ok: await download(name, path.join(work, name.replace("/", "__"))).catch(() => false) }));
  const rows = [];
  for (const r of ok.filter((x) => x.ok)) {
    const row = await analyse(path.join(work, r.name.replace("/", "__")), { view: r.meta.view, stars: r.meta.stars }, mods).catch(() => null);
    if (row) rows.push(row);
  }
  const summary = { date: new Date().toISOString().slice(0, 10), gearness: JSON.parse(fs.readFileSync(path.resolve(DIST, "../package.json"), "utf8")).version, population: `public repositories tagged "${topic}" on GitHub, not forks or archived, up to 30 MB`, sampled: picked.length, downloaded: ok.filter((x) => x.ok).length, withRootAgentsMd: rows.length, ...summarize(rows), byView: Object.fromEntries(["stars", "updated"].map((vw) => [vw, { n: rows.filter((r) => r.view === vw).length, belowGate: summarize(rows.filter((r) => r.view === vw)).belowSubstanceGate.share, medianLines: summarize(rows.filter((r) => r.view === vw)).lines.median }])) };
  fs.mkdirSync(path.join(HERE, "results"), { recursive: true });
  const file = path.join(HERE, "results", `summary-${summary.date}.json`);
  fs.writeFileSync(file, JSON.stringify(summary, null, 2) + "\n");
  if (!v.keep) fs.rmSync(work, { recursive: true, force: true });
  console.log(JSON.stringify(summary, null, 2));
  console.error(`written to ${file}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`error ${e.message}`); process.exit(1); });
