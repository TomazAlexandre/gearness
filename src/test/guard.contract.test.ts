import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { HarnessConfig } from "../config.js";
import { GUARD_HOSTS, editedFiles, guardDecision, respond, runGuard, type GuardDecision, type GuardHost } from "../guard.js";

const config = { protected: ["package-lock.json", "dist/**"] } as unknown as HarnessConfig;
const DENY: GuardDecision = { allow: false, reason: "gearness: package-lock.json is protected", blocked: [{ file: "package-lock.json", glob: "package-lock.json" }] };
const ALLOW: GuardDecision = { allow: true, blocked: [] };

function tmpRepo(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "guard-contract-")));
}
function withRepo(fn: (root: string) => void): void {
  const root = tmpRepo();
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const patch = (...files: string[]) => `*** Begin Patch\n${files.map((f) => `*** Update File: ${f}\n@@\n-old\n+SECRET-CONTENT`).join("\n")}\n*** End Patch`;

// ---- What each host expects on stdout --------------------------------------------------------------------------------

test("claude: allow is silence, deny is the PreToolUse JSON", () => {
  assert.equal(respond("claude", ALLOW), "");
  const out = respond("claude", DENY);
  assert.ok(out.endsWith("\n") && !out.endsWith("\n\n"));
  assert.deepEqual(JSON.parse(out), {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DENY.reason },
  });
});

test("codex: same shape as claude, and it never prints an explicit allow (Codex rejects it)", () => {
  assert.equal(respond("codex", ALLOW), "");
  assert.equal(respond("codex", DENY), respond("claude", DENY));
  assert.ok(!respond("codex", ALLOW).includes("allow"));
});

test("cursor: allow is an explicit allow, deny carries both messages", () => {
  assert.equal(respond("cursor", ALLOW), '{"permission":"allow"}\n');
  assert.deepEqual(JSON.parse(respond("cursor", DENY)), { permission: "deny", user_message: DENY.reason, agent_message: DENY.reason });
});

test("every answer, for every host and decision, is empty or one valid JSON document", () => {
  for (const host of GUARD_HOSTS) {
    for (const d of [ALLOW, DENY]) {
      const out = respond(host, d);
      if (out === "") continue;
      assert.doesNotThrow(() => JSON.parse(out), `${host} ${d.allow ? "allow" : "deny"}`);
      assert.equal(out.trim().split("\n").length, 1, "must be a single line");
    }
  }
});

// ---- Safety rule: a gearness problem must never block an agent -------------------------------------------------------

test("malformed or hostile input answers allow, in the host's own format, without throwing", () => {
  const inputs = ["", "   ", "not json", "{", "null", "[]", '"text"', "42", '{"tool_name":42}', '{"tool_input":"x"}', '{"cwd":123}', '{"workspace_roots":"x"}'];
  withRepo((cwd) => {
    for (const host of GUARD_HOSTS as readonly GuardHost[]) {
      for (const input of inputs) {
        let out = "";
        assert.doesNotThrow(() => {
          out = runGuard(host, input, cwd);
        }, `${host} <- ${JSON.stringify(input)}`);
        assert.equal(out, respond(host, ALLOW), `${host} <- ${JSON.stringify(input)}`);
      }
    }
  });
});

test("no harness.yaml anywhere up the tree means allow", () => {
  withRepo((cwd) => {
    const input = JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(cwd, "package-lock.json") } });
    for (const host of GUARD_HOSTS) assert.equal(runGuard(host, input, cwd), respond(host, ALLOW));
  });
});

// ---- Payload shapes each host really sends ---------------------------------------------------------------------------

test("claude Write/Edit/MultiEdit with an absolute path", () => {
  withRepo((root) => {
    for (const tool of ["Write", "Edit", "MultiEdit"]) {
      const d = guardDecision(root, config, { tool_name: tool, tool_input: { file_path: path.join(root, "package-lock.json") } });
      assert.equal(d.allow, false, tool);
    }
  });
});

test("claude with a relative path resolves against the payload cwd", () => {
  withRepo((root) => {
    const d = guardDecision(root, config, { tool_name: "Edit", cwd: path.join(root, "dist"), tool_input: { file_path: "bundle.js" } });
    assert.equal(d.allow, false);
    assert.equal(d.blocked[0]?.file, "dist/bundle.js");
  });
});

test("cursor: workspace_roots is the base for relative paths, camelCase tool names are accepted", () => {
  withRepo((root) => {
    const d = guardDecision(root, config, { toolName: "StrReplace", workspace_roots: [root], toolInput: { path: "package-lock.json" } });
    assert.equal(d.allow, false);
  });
});

test("codex apply_patch: protected file is found in the patch, however deep the host nests it", () => {
  withRepo((root) => {
    const flat = { tool_name: "apply_patch", cwd: root, tool_input: { command: patch("package-lock.json") } };
    const nested = { tool_name: "apply_patch", cwd: root, tool_input: { a: { b: [{ patch: patch("dist/x.js") }] } } };
    assert.equal(guardDecision(root, config, flat).allow, false);
    assert.equal(guardDecision(root, config, nested).allow, false);
  });
});

test("reads and shell commands are never refused here", () => {
  withRepo((root) => {
    const p = path.join(root, "package-lock.json");
    for (const tool of ["Read", "Grep", "Glob", "Bash", "WebFetch"]) {
      assert.equal(guardDecision(root, config, { tool_name: tool, tool_input: { file_path: p, command: `rm ${p}` } }).allow, true, tool);
    }
  });
});

test("one unprotected file in a multi-file patch does not hide a protected one", () => {
  withRepo((root) => {
    const d = guardDecision(root, config, { tool_name: "apply_patch", cwd: root, tool_input: { command: patch("src/ok.ts", "package-lock.json") } });
    assert.equal(d.allow, false);
    assert.deepEqual(d.blocked.map((b) => b.file), ["package-lock.json"]);
  });
});

test("the denial reason carries paths and globs, never any content of the edit", () => {
  withRepo((root) => {
    const d = guardDecision(root, config, { tool_name: "apply_patch", cwd: root, tool_input: { command: patch("package-lock.json") } });
    assert.equal(d.allow, false);
    assert.ok(!d.reason?.includes("SECRET-CONTENT"));
    assert.ok(d.reason?.includes("package-lock.json"));
  });
});

test("editedFiles reads every header kind of an apply_patch patch", () => {
  const text = "*** Begin Patch\n*** Add File: a.txt\n*** Update File: b.txt\n*** Delete File: c.txt\n*** Move to: d.txt\n*** End Patch";
  assert.deepEqual(editedFiles({ tool_input: { command: text } }).sort(), ["a.txt", "b.txt", "c.txt", "d.txt"]);
});
