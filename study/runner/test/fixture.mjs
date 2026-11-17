// Builds a tiny but complete study on disk: a target repo with two bugs, hidden checks, reference patches,
// a fake agent that only fixes the bugs when the harness gives it an AGENTS.md, and two conditions.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUNNER = path.resolve(HERE, "..");
export const CLI = path.resolve(HERE, "../../../dist/cli.js");
export const READY = fs.existsSync(CLI) && spawnSync("git", ["--version"]).status === 0 && spawnSync("tar", ["--version"]).status === 0;

const w = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

export function buildStudy({ runs = 2, wrapper = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "study e2e-"));
  const target = path.join(root, "target");
  const study = path.join(root, "study");
  w(target, "package.json", '{"name":"calc","type":"module"}\n');
  w(target, "add.mjs", "export const add = (a, b) => a - b;\n");
  w(target, "mul.mjs", "export const mul = (a, b) => a + b;\n");
  w(target, "CLAUDE.md", "legacy hand-written instructions\n");
  w(target, ".claude/settings.json", "{}\n");
  w(target, "docs/guide/AGENTS.md", "nested agent file\n");
  for (const a of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-qm", "base"]]) spawnSync("git", a, { cwd: target });
  // a later commit: the "solution", which must never be reachable from a trial repository
  w(target, "add.mjs", "export const add = (a, b) => a + b;\n");
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-qam", "fix add (the secret solution)"], { cwd: target });
  const base = spawnSync("git", ["rev-parse", "HEAD~1"], { cwd: target, encoding: "utf8" }).stdout.trim();

  w(study, "fake-agent.mjs", `import fs from "node:fs";
if (fs.existsSync("AGENTS.md")) { // pretend the harness is what makes the agent succeed
  fs.writeFileSync("add.mjs", "export const add = (a, b) => a + b;\\n");
  fs.writeFileSync("mul.mjs", "export const mul = (a, b) => a * b;\\n");
}
`);
  for (const [id, fn, args, want] of [["fix-add", "add", "2, 3", 5], ["fix-mul", "mul", "2, 3", 6]]) {
    w(study, `tasks/${id}.yaml`, `id: ${id}\nprompt: |\n  Fix ${fn}() so it computes correctly.\ncheck: node "{{HIDDEN}}/${id}.mjs"\nforbid: []\n`);
    w(study, `hidden/${id}.mjs`, `import path from "node:path";\nimport { pathToFileURL } from "node:url";\nconst m = await import(pathToFileURL(path.join(process.cwd(), "${fn}.mjs")).href);\nprocess.exit(m.${fn}(${args}) === ${want} ? 0 : 1);\n`);
  }
  // a fake `claude` for the real wrapper (agent.mjs): same "harness makes it succeed" rule, plus a cost in its JSON
  w(study, "fake-claude.mjs", `import fs from "node:fs";
if (!process.argv.includes("-p")) { console.log("fake-claude 1.0"); process.exit(0); } // like \`claude --version\`: no side effects
if (fs.existsSync("AGENTS.md")) {
  fs.writeFileSync("add.mjs", "export const add = (a, b) => a + b;\\n");
  fs.writeFileSync("mul.mjs", "export const mul = (a, b) => a * b;\\n");
}
console.log(JSON.stringify({ type: "result", result: "ok", total_cost_usd: 0.5, num_turns: 4, usage: { input_tokens: 10, output_tokens: 5 } }));
`);
  w(study, "reference/fix-add.patch", "--- a/add.mjs\n+++ b/add.mjs\n@@ -1 +1 @@\n-export const add = (a, b) => a - b;\n+export const add = (a, b) => a + b;\n");
  w(study, "reference/fix-mul.patch", "--- a/mul.mjs\n+++ b/mul.mjs\n@@ -1 +1 @@\n-export const mul = (a, b) => a + b;\n+export const mul = (a, b) => a * b;\n");
  w(study, "conditions/full/AGENTS.md", "# Guide\nUse the correct operators.\n");
  w(study, "study.yaml", `id: e2e-demo
agent: ${wrapper ? "node {runner}/agent.mjs --prompt-env GEARNESS_PROMPT" : `node "${path.join(study, "fake-agent.mjs")}" --prompt-env GEARNESS_PROMPT`}
runs: ${runs}
parallel: 2
seed: 7
target:
  path: ../target
  commit: ${base}
tasks: tasks
hidden: hidden
conditions:
  none: {}
  full:
    overlay: conditions/full
`);
  return { root, target, study, studyFile: path.join(study, "study.yaml"), base, fakeClaude: path.join(study, "fake-claude.mjs") };
}

export function node(script, args, opts = {}) {
  // cwd defaults to a temp dir: a test must never be able to write into the repository it is testing
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: os.tmpdir(), ...opts });
}
