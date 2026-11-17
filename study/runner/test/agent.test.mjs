import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { node, RUNNER } from "./fixture.mjs";

const AGENT = path.join(RUNNER, "agent.mjs");

/** A fake `claude` written as a .mjs file: portable, because the wrapper runs script paths with node on every OS. */
function fakeClaude(dir, body) {
  const f = path.join(dir, "fake-claude.mjs");
  fs.writeFileSync(f, body);
  return f;
}

// Echoes the prompt it received, and says whether it came as an argument or on stdin.
const ECHO = `import fs from "node:fs";
const a = process.argv.slice(2);
const i = a.indexOf("-p");
const viaArg = a[i + 1] !== undefined && !a[i + 1].startsWith("--");
const prompt = viaArg ? a[i + 1] : fs.readFileSync(0, "utf8");
console.log(JSON.stringify({ type: "result", result: (viaArg ? "arg:" : "stdin:") + prompt, total_cost_usd: 0.42, num_turns: 7, duration_ms: 1234, usage: { input_tokens: 100, output_tokens: 50 }, is_error: false }));
`;
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "study agent-"));
const env = (d, extra = {}) => ({ ...process.env, STUDY_CLAUDE_BIN: fakeClaude(d, ECHO), STUDY_METRICS: path.join(d, "m.jsonl"), ...extra });

test("records cost, turns and tokens and prints the agent's answer (prompt as argument)", () => {
  const d = dir();
  const r = node(AGENT, ["--prompt-env", "GEARNESS_PROMPT"], { env: env(d, { STUDY_PROMPT_VIA: "arg", GEARNESS_PROMPT: "do the thing", STUDY_CONDITION: "full", GEARNESS_TASK: "t1" }) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /arg:do the thing/);
  const m = JSON.parse(fs.readFileSync(path.join(d, "m.jsonl"), "utf8").trim());
  assert.deepEqual([m.condition, m.task, m.costUsd, m.turns, m.inputTokens, m.outputTokens, m.isError], ["full", "t1", 0.42, 7, 100, 50, false]);
});

test("stdin mode (the Windows default) delivers a multi-line prompt with quotes and shell characters intact", () => {
  const d = dir();
  const tricky = 'line one\nline "two" & more | pipes > redirects\n100% done ^ caret $HOME `tick`';
  const r = node(AGENT, ["--prompt-env", "GEARNESS_PROMPT"], { env: env(d, { STUDY_PROMPT_VIA: "stdin", GEARNESS_PROMPT: tricky }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trimEnd(), "stdin:" + tricky);
});

test("the prompt can also be a positional argument or default to GEARNESS_PROMPT", () => {
  const d = dir();
  assert.match(node(AGENT, ["positional prompt"], { env: env(d, { STUDY_PROMPT_VIA: "arg" }) }).stdout, /arg:positional prompt/);
  assert.match(node(AGENT, [], { env: env(d, { STUDY_PROMPT_VIA: "arg", GEARNESS_PROMPT: "from env" }) }).stdout, /arg:from env/);
  assert.equal(node(AGENT, [], { env: { ...process.env, GEARNESS_PROMPT: "" } }).status, 2);
});

test("missing fields become null, never guesses; non-JSON output is passed through", () => {
  const d = dir();
  const bin = fakeClaude(d, `console.log("plain text, not json")`);
  const r = node(AGENT, ["x"], { env: { ...process.env, STUDY_CLAUDE_BIN: bin, STUDY_METRICS: path.join(d, "m.jsonl") } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /plain text/);
  const m = JSON.parse(fs.readFileSync(path.join(d, "m.jsonl"), "utf8").trim());
  assert.equal(m.costUsd, null);
  assert.equal(m.turns, null);
});

test("propagates the agent's exit code", () => {
  const d = dir();
  assert.equal(node(AGENT, ["x"], { env: { ...process.env, STUDY_CLAUDE_BIN: fakeClaude(d, `process.exit(3)`) } }).status, 3);
});

test("a missing agent binary is exit 127, with and without the shell path (cmd.exe on Windows)", () => {
  for (const STUDY_SHELL of ["0", "1"]) {
    const r = node(AGENT, ["x"], { env: { ...process.env, STUDY_SHELL, STUDY_CLAUDE_BIN: "definitely-not-an-installed-agent-xyz" } });
    assert.equal(r.status, 127, `STUDY_SHELL=${STUDY_SHELL}: ${r.stderr}`);
    assert.match(r.stderr, /could not start/);
  }
});

test("shell path (what Windows uses for claude.cmd) runs a real executable and quotes arguments", { skip: process.platform === "win32" ? "POSIX-only fixture" : false }, () => {
  const d = dir();
  const bin = path.join(d, "fake claude.sh"); // a space in the name, like C:\\Users\\Tomaz Malfoy
  fs.writeFileSync(bin, '#!/bin/sh\necho \'{"type":"result","result":"shell-ok","total_cost_usd":1}\'\n');
  fs.chmodSync(bin, 0o755);
  const r = node(AGENT, ["x"], { env: { ...process.env, STUDY_SHELL: "1", STUDY_CLAUDE_BIN: bin, STUDY_METRICS: path.join(d, "m.jsonl") } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /shell-ok/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, "m.jsonl"), "utf8").trim()).costUsd, 1);
});
