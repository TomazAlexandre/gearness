import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, serializeConfig } from "../config.js";
import { editedFiles, guardDecision, respond, runGuard } from "../guard.js";
import { install } from "../install.js";
import { tmpRepo } from "./helpers.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const HARNESS = "version: 1\nproject:\n  name: p\nagents: []\nprotected:\n  - src/generated/**\n  - package-lock.json\n  - \"**/*.min.js\"\n";
const repo = (harness = HARNESS) => tmpRepo({ "harness.yaml": harness, "src/app.ts": "x", "src/generated/api.ts": "x" });
const cfg = (dir: string) => loadConfig(dir).config!;
const at = (dir: string, f: string) => path.join(dir, f);
const edit = (tool: string, input: unknown, extra: object = {}) => ({ tool_name: tool, tool_input: input, ...extra });
const patch = (...lines: string[]) => `*** Begin Patch\n${lines.join("\n")}\n*** End Patch`;

describe("editedFiles: the files an edit targets, in each host's own shape", () => {
  it("claude Edit and MultiEdit use file_path", () => {
    assert.deepEqual(editedFiles(edit("Edit", { file_path: "/r/a.ts", old_string: "x", new_string: "y" })), ["/r/a.ts"]);
  });
  it("cursor Write uses file_path too, and tolerates the other usual spellings", () => {
    assert.deepEqual(editedFiles(edit("Write", { file_path: "a.ts", contents: "x" })), ["a.ts"]);
    assert.deepEqual(editedFiles(edit("Write", { target_file: "b.ts" })), ["b.ts"]);
    assert.deepEqual(editedFiles(edit("Write", { path: "c.ts" })), ["c.ts"]);
  });
  it("codex apply_patch: every file header of the patch, however the host nests the text", () => {
    const text = patch("*** Update File: src/a.ts", "@@", "-a", "+b", "*** Add File: src/new.ts", "+x", "*** Delete File: old.ts", "*** Move to: src/moved.ts");
    const expected = ["src/a.ts", "src/new.ts", "old.ts", "src/moved.ts"];
    assert.deepEqual(editedFiles(edit("apply_patch", { command: text })), expected);
    assert.deepEqual(editedFiles(edit("apply_patch", text)), expected);
    assert.deepEqual(editedFiles(edit("apply_patch", { input: { patch: [text] } })), expected);
  });
  it("finds nothing when there is nothing to find", () => {
    for (const p of [{}, null, "x", 42, edit("Edit", null), edit("Shell", { command: "ls" })]) assert.deepEqual(editedFiles(p), []);
  });
});

describe("guardDecision: protected paths are refused before the edit", () => {
  it("refuses edits to a protected folder, file and nested glob, in every edit tool", () => {
    const d = repo();
    for (const tool of ["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch", "StrReplace", "Delete"])
      for (const f of ["src/generated/api.ts", "package-lock.json", "web/dist/app.min.js"]) {
        const r = guardDecision(d, cfg(d), edit(tool, { file_path: at(d, f) }));
        assert.equal(r.allow, false, `${tool} ${f}`);
        assert.equal(r.blocked[0]!.file, f);
      }
  });

  it("lets everything else through: other files, reads, shell commands, unknown tools, no tool name", () => {
    const d = repo();
    assert.equal(guardDecision(d, cfg(d), edit("Edit", { file_path: at(d, "src/app.ts") })).allow, true);
    assert.equal(guardDecision(d, cfg(d), edit("package-lock.json.bak", { file_path: at(d, "src/app.ts") })).allow, true);
    for (const tool of ["Read", "Grep", "Shell", "Bash", "Task", "mcp__x__y", "", "Unknown"])
      assert.equal(guardDecision(d, cfg(d), edit(tool, { file_path: at(d, "src/generated/api.ts"), command: "cat src/generated/api.ts" })).allow, true, tool);
    assert.equal(guardDecision(d, cfg(d), { tool_input: { file_path: at(d, "src/generated/api.ts") } }).allow, true, "no tool name: never guess");
    assert.equal(guardDecision(d, cfg(d), edit("Edit", { file_path: at(d, "package-lock.json.bak") })).allow, true, "a glob is not a prefix of a different name");
  });

  it("resolves relative paths from the payload's cwd, and cannot be dodged with .. segments", () => {
    const d = repo();
    assert.equal(guardDecision(d, cfg(d), edit("Edit", { file_path: "generated/api.ts" }, { cwd: at(d, "src") })).allow, false);
    assert.equal(guardDecision(d, cfg(d), edit("Edit", { file_path: at(d, "src/app/../generated/api.ts") })).allow, false);
    assert.equal(guardDecision(d, cfg(d), edit("Edit", { file_path: "generated/api.ts" }, { workspace_roots: [at(d, "src")] })).allow, false);
  });

  it("ignores paths outside the repository", () => {
    const d = repo();
    assert.equal(guardDecision(d, cfg(d), edit("Edit", { file_path: path.join(os.tmpdir(), "elsewhere", "src/generated/api.ts") })).allow, true);
    assert.equal(guardDecision(d, cfg(d), edit("Edit", { file_path: "../../outside/src/generated/api.ts" }, { cwd: at(d, "src") })).allow, true, "two levels up from src/ leaves the repository");
    assert.equal(guardDecision(d, cfg(d), edit("Edit", { file_path: "../src/generated/api.ts" }, { cwd: at(d, "src") })).allow, false, "one level up and back down is still inside it");
  });

  it("one protected file among several refuses the whole call and names only the protected ones", () => {
    const d = repo();
    const r = guardDecision(d, cfg(d), edit("apply_patch", { command: patch("*** Update File: src/app.ts", "*** Update File: src/generated/api.ts") }));
    assert.equal(r.allow, false);
    assert.deepEqual(r.blocked.map((b) => b.file), ["src/generated/api.ts"]);
    assert.ok(r.reason!.includes("src/generated/api.ts") && !r.reason!.includes("src/app.ts"));
  });

  it("a long list is cut at five names", () => {
    const d = repo();
    const lines = Array.from({ length: 8 }, (_, i) => `*** Update File: src/generated/f${i}.ts`);
    const r = guardDecision(d, cfg(d), edit("apply_patch", { command: patch(...lines) }));
    assert.match(r.reason!, /f4\.ts and more/);
    assert.ok(!r.reason!.includes("f5.ts"));
  });

  it("the reason carries paths and globs only, never content from the edit", () => {
    const d = repo();
    const secret = "AKIA_SECRET_TOKEN_12345";
    const r = guardDecision(d, cfg(d), edit("apply_patch", { command: patch("*** Update File: src/generated/api.ts", `+const key = "${secret}";`) }));
    assert.equal(r.allow, false);
    assert.ok(!r.reason!.includes(secret));
    const w = guardDecision(d, cfg(d), edit("Edit", { file_path: at(d, "src/generated/api.ts"), old_string: secret, new_string: secret }));
    assert.ok(!w.reason!.includes(secret));
  });

  it("a harness that protects nothing allows everything", () => {
    const d = repo("version: 1\nproject:\n  name: p\nagents: []\n");
    assert.equal(guardDecision(d, cfg(d), edit("Edit", { file_path: at(d, "src/generated/api.ts") })).allow, true);
  });
});

describe("respond: the exact answer each host accepts", () => {
  const deny = { allow: false, reason: "no", blocked: [{ file: "a", glob: "a" }] };
  const allow = { allow: true, blocked: [] };
  it("claude and codex deny with hookSpecificOutput, and allow by staying silent", () => {
    for (const host of ["claude", "codex"] as const) {
      const out = JSON.parse(respond(host, deny));
      assert.deepEqual(out, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } });
      assert.equal(respond(host, allow), "", `${host}: an explicit allow is rejected by Codex, so allow is silence`);
    }
  });
  it("cursor answers every time, with permission allow or deny", () => {
    assert.deepEqual(JSON.parse(respond("cursor", allow)), { permission: "allow" });
    assert.deepEqual(JSON.parse(respond("cursor", deny)), { permission: "deny", user_message: "no", agent_message: "no" });
  });
});

describe("runGuard never lets a gearness problem stop an agent", () => {
  const junk = ["not json", "", "   ", "[]", "null", "42", '"s"', "{", '{"tool_name":"Edit","tool_input":42}', '{"tool_name":"Edit","tool_input":{"file_path":{"a":[1]}}}', '{"tool_name":{"x":1},"cwd":5}', JSON.stringify({ tool_name: "Edit", cwd: "/nonexistent/place", tool_input: { file_path: "/x" } })];
  it("malformed or hostile input is allowed, with valid output for the host", () => {
    const d = repo();
    for (const input of junk) {
      for (const host of ["claude", "codex"] as const) assert.equal(runGuard(host, input, d), "", `${host} ${input}`);
      assert.deepEqual(JSON.parse(runGuard("cursor", input, d)), { permission: "allow" }, input);
    }
  });
  it("no harness.yaml anywhere means allow", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "guard-bare-"));
    assert.equal(runGuard("claude", JSON.stringify(edit("Edit", { file_path: path.join(bare, "src/generated/api.ts") })), bare), "");
  });
  it("a broken harness.yaml means allow, not a crash", () => {
    const d = tmpRepo({ "harness.yaml": "protected: [unclosed\n  - : :\n" });
    assert.deepEqual(JSON.parse(runGuard("cursor", JSON.stringify(edit("Write", { file_path: at(d, "src/generated/api.ts") })), d)), { permission: "allow" });
  });
  it("finds the repository from the payload's cwd, even from a subfolder", () => {
    const d = repo();
    // patch paths are relative to the agent's working directory: from src/, "generated/api.ts" is src/generated/api.ts
    const out = runGuard("codex", JSON.stringify(edit("apply_patch", { command: patch("*** Update File: generated/api.ts") }, { cwd: at(d, "src") })), os.tmpdir());
    assert.match(out, /"permissionDecision":"deny"/);
    const other = runGuard("codex", JSON.stringify(edit("apply_patch", { command: patch("*** Update File: src/generated/api.ts") }, { cwd: at(d, "src") })), os.tmpdir());
    assert.equal(other, "", "the same header from src/ points at src/src/generated, which is not protected");
  });
});

describe("gearness guard, as an agent runs it", () => {
  const run = (dir: string, host: string | undefined, input: string) => spawnSync(process.execPath, [CLI, "guard", ...(host ? ["--host", host] : [])], { cwd: dir, input, encoding: "utf8" });
  it("answers on stdout in the host's format and always exits 0", () => {
    const d = repo();
    const payload = JSON.stringify(edit("Write", { file_path: at(d, "src/generated/api.ts") }, { hook_event_name: "preToolUse" }));
    const r = run(d, "cursor", payload);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).permission, "deny");
    assert.equal(run(d, "codex", payload).status, 0);
    const ok = run(d, "cursor", JSON.stringify(edit("Write", { file_path: at(d, "src/app.ts") })));
    assert.deepEqual(JSON.parse(ok.stdout), { permission: "allow" });
    assert.equal(run(d, "claude", "garbage").stdout, "");
  });
  it("a missing or unknown host is a usage error, not a silent allow", () => {
    const d = repo();
    assert.notEqual(run(d, undefined, "{}").status, 0);
    assert.notEqual(run(d, "gemini", "{}").status, 0);
  });
});

describe("harness.yaml: protected", () => {
  it("is read, defaults to an empty list, and survives a round trip", () => {
    const d = repo();
    assert.deepEqual(cfg(d).protected, ["src/generated/**", "package-lock.json", "**/*.min.js"]);
    assert.deepEqual(cfg(repo("version: 1\nproject:\n  name: p\n")).protected, []);
    const again = tmpRepo({ "harness.yaml": serializeConfig(cfg(d)) });
    assert.deepEqual(cfg(again).protected, cfg(d).protected);
  });
  it("rejects anything that is not a repo-relative glob", () => {
    for (const bad of ["protected: not-a-list", "protected: [\"/etc/passwd\"]", "protected: [\"C:\\\\x\"]", "protected: [\"../outside\"]", "protected: [\"a/../b\"]", "protected: [1]"]) {
      const d = tmpRepo({ "harness.yaml": `version: 1\nproject:\n  name: p\n${bad}\n` });
      const r = loadConfig(d);
      assert.equal(r.config, undefined, bad);
      assert.ok(r.errors?.some((e) => /protected/.test(e)), bad);
    }
  });
});

describe("gearness install: the guard hooks", () => {
  const read = (d: string, f: string) => JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
  const exists = (d: string, f: string) => fs.existsSync(path.join(d, f));
  const cmd = { command: "npx gearness" };

  it("claude gets a PreToolUse guard only while the harness protects something", () => {
    const d = repo();
    assert.equal(install(d, cfg(d), { only: ["claude"], ...cmd })[0]!.action, "added");
    const s = read(d, ".claude/settings.json");
    assert.equal(s.hooks.PreToolUse[0].matcher, "Edit|MultiEdit|Write|NotebookEdit");
    assert.equal(s.hooks.PreToolUse[0].hooks[0].command, "npx gearness guard --host claude");
    assert.ok(s.hooks.PostToolUse[0].hooks[0].command.endsWith("check --hook claude"), "the existing post-edit check is unchanged");
    assert.equal(install(d, cfg(d), { only: ["claude"], ...cmd })[0]!.action, "unchanged", "idempotent");

    const none = repo("version: 1\nproject:\n  name: p\nagents: []\n");
    install(none, cfg(none), { only: ["claude"], ...cmd });
    assert.equal(read(none, ".claude/settings.json").hooks.PreToolUse, undefined, "no guard when nothing is protected");
  });

  it("an install made before the guard existed is upgraded, and the guard goes away when protected is emptied", () => {
    const d = tmpRepo({ "harness.yaml": "version: 1\nproject:\n  name: p\nagents: []\n" });
    install(d, cfg(d), { only: ["claude"], ...cmd });
    fs.writeFileSync(path.join(d, "harness.yaml"), HARNESS);
    assert.equal(install(d, cfg(d), { only: ["claude"], ...cmd })[0]!.action, "updated");
    assert.ok(read(d, ".claude/settings.json").hooks.PreToolUse);
    fs.writeFileSync(path.join(d, "harness.yaml"), "version: 1\nproject:\n  name: p\nagents: []\n");
    assert.equal(install(d, cfg(d), { only: ["claude"], ...cmd })[0]!.action, "removed");
    assert.equal(read(d, ".claude/settings.json").hooks.PreToolUse, undefined);
    assert.ok(read(d, ".claude/settings.json").hooks.PostToolUse, "the post-edit check stays");
  });

  it("claude: the user's own hooks survive install and uninstall", () => {
    const d = repo();
    const mine = { matcher: "Bash", hooks: [{ type: "command", command: "./my-hook.sh" }] };
    fs.mkdirSync(path.join(d, ".claude"));
    fs.writeFileSync(path.join(d, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["x"] }, hooks: { PreToolUse: [mine], Stop: [mine] } }));
    install(d, cfg(d), { only: ["claude"], ...cmd });
    assert.deepEqual(read(d, ".claude/settings.json").hooks.PreToolUse[0], mine);
    install(d, cfg(d), { only: ["claude"], remove: true });
    const after = read(d, ".claude/settings.json");
    assert.deepEqual(after.hooks, { PreToolUse: [mine], Stop: [mine] });
    assert.deepEqual(after.permissions, { allow: ["x"] });
  });

  it("cursor and codex are opt-in: a plain install writes neither", () => {
    const d = repo();
    install(d, cfg(d), cmd);
    assert.ok(!exists(d, ".cursor/hooks.json") && !exists(d, ".codex/hooks.json"));
  });

  it("cursor: writes its own file format, keeps the user's entries, is idempotent and uninstalls cleanly", () => {
    const d = repo();
    const a = install(d, cfg(d), { only: ["cursor"], ...cmd })[0]!;
    assert.equal(a.action, "added");
    assert.match(a.note ?? "", /experimental/);
    assert.deepEqual(read(d, ".cursor/hooks.json"), { version: 1, hooks: { preToolUse: [{ command: "npx gearness guard --host cursor", matcher: "Write|Edit|Delete|StrReplace" }] } });
    assert.equal(install(d, cfg(d), { only: ["cursor"], ...cmd })[0]!.action, "unchanged");
    install(d, cfg(d), { only: ["cursor"], remove: true });
    assert.ok(!exists(d, ".cursor/hooks.json"), "the file is removed when nothing else is in it");

    const mine = { command: "./audit.sh", matcher: "Shell" };
    fs.mkdirSync(path.join(d, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(d, ".cursor/hooks.json"), JSON.stringify({ version: 1, hooks: { preToolUse: [mine], afterFileEdit: [{ command: "./fmt.sh" }] } }));
    install(d, cfg(d), { only: ["cursor"], ...cmd });
    assert.deepEqual(read(d, ".cursor/hooks.json").hooks.preToolUse[0], mine);
    install(d, cfg(d), { only: ["cursor"], remove: true });
    assert.deepEqual(read(d, ".cursor/hooks.json"), { version: 1, hooks: { preToolUse: [mine], afterFileEdit: [{ command: "./fmt.sh" }] } });
  });

  it("codex: apply_patch matcher, command hook, a note about trust, and a clean uninstall", () => {
    const d = repo();
    const a = install(d, cfg(d), { only: ["codex"], ...cmd })[0]!;
    assert.equal(a.action, "added");
    assert.match(a.note ?? "", /trusted/);
    assert.deepEqual(read(d, ".codex/hooks.json"), { hooks: { PreToolUse: [{ matcher: "apply_patch|Edit|Write", hooks: [{ type: "command", command: "npx gearness guard --host codex" }] }] } });
    assert.equal(install(d, cfg(d), { only: ["codex"], ...cmd })[0]!.action, "unchanged");
    install(d, cfg(d), { only: ["codex"], remove: true });
    assert.ok(!exists(d, ".codex/hooks.json"));

    const mine = { matcher: "startup", hooks: [{ type: "command", command: "./start.sh" }] };
    fs.mkdirSync(path.join(d, ".codex"));
    fs.writeFileSync(path.join(d, ".codex/hooks.json"), JSON.stringify({ hooks: { SessionStart: [mine] } }));
    install(d, cfg(d), { only: ["codex"], ...cmd });
    install(d, cfg(d), { only: ["codex"], remove: true });
    assert.deepEqual(read(d, ".codex/hooks.json"), { hooks: { SessionStart: [mine] } });
  });

  it("recognises its own hook however gearness is invoked", () => {
    const d = repo();
    for (const command of ["npx gearness", "node dist/cli.js", "gearness"]) {
      install(d, cfg(d), { only: ["cursor", "codex"], command });
      install(d, cfg(d), { only: ["cursor", "codex"], remove: true });
      assert.ok(!exists(d, ".cursor/hooks.json") && !exists(d, ".codex/hooks.json"), command);
    }
  });
});
