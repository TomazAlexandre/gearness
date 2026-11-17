#!/usr/bin/env node
// Runs Claude Code headlessly and records cost, turns and tokens for the study report.
// gearness eval does not capture them, and cost is a core metric: a harness that doubles the bill must say so.
//
// As the study `agent` (the literal GEARNESS_PROMPT makes `gearness eval` leave the prompt out of the command line,
// so a multi-line prompt never has to survive shell quoting on any OS):
//     agent: node {runner}/agent.mjs --prompt-env GEARNESS_PROMPT
//
// Env:   STUDY_METRICS      JSONL file to append one line per run to (set by run.mjs)
//        STUDY_CONDITION    condition name (set by run.mjs)
//        STUDY_CLAUDE_BIN   agent binary (default: claude). A .mjs/.js path is run with node (useful for wrappers).
//        STUDY_CLAUDE_ARGS  extra arguments, space separated. REPLACES the defaults below. Pin the model: `--model <id>`.
//        STUDY_PROMPT_VIA   `arg` (default on Linux/macOS) or `stdin` (default on Windows, where .cmd shims need a shell
//                           and a prompt must not go through cmd.exe quoting).
//
// NOTE: not verified against a live Claude Code in the environment where this was written. Two assumptions to confirm
// on your first pilot run: (1) `claude -p` reads the prompt from stdin when none is given as an argument;
// (2) the JSON field names read below (total_cost_usd, num_turns, duration_ms, usage, is_error) match the CLI's
// `--output-format json` result. Anything missing is recorded as null, never guessed.
import fs from "node:fs";
import { spawnBin } from "./lib.mjs";

const argv = process.argv.slice(2);
const promptEnv = argv[0] === "--prompt-env" ? argv[1] : null;
const prompt = promptEnv ? process.env[promptEnv] : (argv[0] ?? process.env.GEARNESS_PROMPT);
if (!prompt) {
  console.error("usage: agent.mjs --prompt-env GEARNESS_PROMPT   (or: agent.mjs <prompt>)");
  process.exit(2);
}
const bin = process.env.STUDY_CLAUDE_BIN || "claude";
const extra = process.env.STUDY_CLAUDE_ARGS
  ? process.env.STUDY_CLAUDE_ARGS.split(/\s+/).filter(Boolean)
  : ["--permission-mode", "acceptEdits", "--allowedTools", "Bash,Edit,Write,Read,Glob,Grep"];
const via = process.env.STUDY_PROMPT_VIA ?? (process.platform === "win32" ? "stdin" : "arg");

const started = Date.now();
const r =
  via === "stdin"
    ? spawnBin(bin, ["-p", "--output-format", "json", ...extra], { input: prompt })
    : spawnBin(bin, ["-p", prompt, "--output-format", "json", ...extra]);
if (r.error || r.status === 127) {
  console.error(`could not start ${bin}: ${r.error ? r.error.message : String(r.stderr ?? "").trim() || "command not found"}`);
  process.exit(127);
}

let result = null;
try {
  const parsed = JSON.parse(r.stdout);
  result = Array.isArray(parsed) ? parsed.findLast((m) => m?.type === "result") ?? null : parsed;
} catch {
  /* not JSON: keep the raw output for the log */
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const line = {
  ts: new Date().toISOString(),
  condition: process.env.STUDY_CONDITION ?? null,
  task: process.env.GEARNESS_TASK ?? null,
  exit: r.status,
  wallMs: Date.now() - started,
  costUsd: num(result?.total_cost_usd ?? result?.cost_usd),
  turns: num(result?.num_turns),
  apiMs: num(result?.duration_ms),
  inputTokens: num(result?.usage?.input_tokens),
  outputTokens: num(result?.usage?.output_tokens),
  isError: typeof result?.is_error === "boolean" ? result.is_error : null,
};
if (process.env.STUDY_METRICS) fs.appendFileSync(process.env.STUDY_METRICS, JSON.stringify(line) + "\n");

process.stdout.write((typeof result?.result === "string" ? result.result : r.stdout ?? "") + "\n");
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status ?? 1);
