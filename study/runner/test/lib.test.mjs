import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commandExists, isInvalid, loadStudy, shellPath, shuffled, StudyError, stripAgentFiles, stripEvalLeaks } from "../lib.mjs";
import { rng } from "../stats.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "study-lib-"));
const put = (root, rel, text = "x") => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

test("stripAgentFiles removes agent files at any depth and keeps real code", () => {
  const d = tmp();
  for (const f of ["AGENTS.md", "CLAUDE.md", "pkg/CLAUDE.md", ".cursor/rules/a.mdc", ".claude/settings.json", ".github/copilot-instructions.md", ".mcp.json", "src/app.ts", "README.md", "node_modules/x/CLAUDE.md"]) put(d, f);
  const removed = stripAgentFiles(d);
  for (const f of ["AGENTS.md", "CLAUDE.md", "pkg/CLAUDE.md", ".cursor", ".claude", ".github/copilot-instructions.md", ".mcp.json"]) assert.ok(removed.includes(f), `${f} should be removed`);
  assert.ok(fs.existsSync(path.join(d, "src/app.ts")) && fs.existsSync(path.join(d, "README.md")));
  assert.ok(fs.existsSync(path.join(d, "node_modules/x/CLAUDE.md")), "node_modules is never touched");
});

test("stripAgentFiles also removes the context docs a gearness harness.yaml declares, and .harness", () => {
  const d = tmp();
  put(d, "harness.yaml", "version: 1\nproject: {name: x}\ncontext:\n  entry: AGENTS.md\n  docs: [docs/ARCHITECTURE.md]\n  status: docs/STATUS.md\n");
  for (const f of ["AGENTS.md", "docs/ARCHITECTURE.md", "docs/STATUS.md", "docs/other.md", ".harness/ratchet.yaml", ".harness/evals/t.yaml"]) put(d, f);
  stripAgentFiles(d);
  assert.deepEqual(["harness.yaml", "AGENTS.md", "docs/ARCHITECTURE.md", "docs/STATUS.md", ".harness"].filter((f) => fs.existsSync(path.join(d, f))), []);
  assert.ok(fs.existsSync(path.join(d, "docs/other.md")), "unrelated docs stay");
});

test("a harness.yaml cannot make strip delete files outside the repository", () => {
  const d = tmp();
  put(d, "harness.yaml", "context:\n  entry: ../../etc/passwd\n  docs: [/etc/hosts]\n");
  assert.doesNotThrow(() => stripAgentFiles(d));
});

test("stripEvalLeaks only removes eval tasks and results", () => {
  const d = tmp();
  for (const f of [".harness/evals/t.yaml", ".harness/eval-results/r.json", ".harness/ratchet.yaml", "AGENTS.md"]) put(d, f);
  const removed = stripEvalLeaks(d);
  assert.deepEqual(removed.sort(), [".harness/eval-results", ".harness/evals"]);
  assert.ok(fs.existsSync(path.join(d, ".harness/ratchet.yaml")) && fs.existsSync(path.join(d, "AGENTS.md")));
});

test("isInvalid separates infrastructure noise from real failures", () => {
  const base = { passed: false, reason: "check failed (exit 1)", agentExit: 0, changedFiles: 2 };
  assert.equal(isInvalid({ ...base, passed: true, reason: "ok" }), false);
  assert.equal(isInvalid(base), false, "a wrong answer is a valid failure");
  assert.equal(isInvalid({ ...base, reason: "setup failed", agentExit: null }), true);
  assert.equal(isInvalid({ ...base, agentExit: 1, changedFiles: 0 }), true, "agent crashed and touched nothing");
  assert.equal(isInvalid({ ...base, agentExit: 127, changedFiles: 0 }), true, "agent binary missing");
  assert.equal(isInvalid({ ...base, agentExit: 1, changedFiles: 3 }), false, "crashed after editing: still a failure of the run");
  assert.equal(isInvalid({ ...base, agentExit: null, reason: "agent timed out", changedFiles: 0 }), false, "a timeout is a legitimate failure");
});

test("shuffled is deterministic for a seed and keeps every element", () => {
  const a = shuffled(["a", "b", "c", "d"], rng(5)), b = shuffled(["a", "b", "c", "d"], rng(5));
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort(), ["a", "b", "c", "d"]);
});

test("loadStudy reports every problem at once and resolves paths relative to the file", () => {
  const d = tmp();
  put(d, "bad.yaml", "id: Bad Id\nruns: 0\n");
  assert.throws(() => loadStudy(path.join(d, "bad.yaml")), (e) => e instanceof StudyError && /kebab-case/.test(e.message) && /runs/.test(e.message) && /target/.test(e.message) && /conditions/.test(e.message));
  put(d, "ok.yaml", "id: ok\nagent: claude\ntarget: {path: ../t, commit: HEAD}\ntasks: tasks\nconditions: {none: {}, full: {overlay: ov, strip: false}}\n");
  const s = loadStudy(path.join(d, "ok.yaml"));
  assert.equal(s.target.path, path.resolve(d, "../t"));
  assert.equal(s.conditions.full.strip, false);
  assert.equal(s.conditions.none.strip, true);
  assert.equal(s.runs, 5);
});

test("shellPath quotes for the platform's shell: double quotes for cmd.exe, single quotes for sh", () => {
  const win = "C:\\Users\\Tomaz Malfoy\\Documents\\gearness-main\\study\\runner\\agent.mjs";
  assert.equal(shellPath(win, "win32"), `"${win}"`);
  assert.equal(shellPath("/home/a b/agent.mjs", "linux"), "'/home/a b/agent.mjs'");
  assert.equal(shellPath("it's a path/x", "linux"), `'it'\\''s a path/x'`);
  assert.equal(shellPath("C:\\tools\\agent.mjs", "win32"), "C:\\tools\\agent.mjs", "safe paths stay bare");
  assert.equal(shellPath("/opt/agent.mjs", "linux"), "/opt/agent.mjs");
});

test("{runner}/agent.mjs in study.yaml becomes ONE quoted token even when the path has spaces", () => {
  const d = tmp();
  put(d, "s.yaml", "id: s\nagent: node {runner}/agent.mjs --prompt-env GEARNESS_PROMPT\ntarget: {path: ../t, commit: HEAD}\ntasks: tasks\nconditions: {none: {}}\n");
  const a = loadStudy(path.join(d, "s.yaml")).agent;
  assert.ok(!a.includes("{runner}"));
  assert.match(a, /^node \S*agent\.mjs\S* --prompt-env GEARNESS_PROMPT$|^node (["'])[^"']*agent\.mjs\1 --prompt-env GEARNESS_PROMPT$/);
});

test("commandExists resolves an explicit path with or without the extension and never reads a message", () => {
  const d = tmp();
  put(d, "bin/claude.cmd", "@echo off");
  put(d, "bin/tool", "x");
  assert.equal(commandExists(path.join(d, "bin", "claude")), true, "claude -> claude.cmd, how npm installs it on Windows");
  assert.equal(commandExists(path.join(d, "bin", "claude.cmd")), true);
  assert.equal(commandExists(path.join(d, "bin", "tool")), true);
  assert.equal(commandExists(path.join(d, "bin", "missing")), false);
  assert.equal(commandExists("C:\\definitely\\not\\here\\claude"), false);
});
