import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { HarnessConfig } from "../config.js";
import { guardDecision } from "../guard.js";

const config = { protected: ["package-lock.json", "dist/**"] } as unknown as HarnessConfig;
const write = (file: string) => ({ tool_name: "Write", tool_input: { file_path: file } });

function tmpRepo(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "guard-")));
}

test("blocks a protected file reached through a symlinked path (macOS /var -> /private/var)", (t) => {
  const real = tmpRepo();
  const link = `${real}-link`;
  try {
    fs.symlinkSync(real, link, "junction");
  } catch {
    t.skip("cannot create symlinks on this machine");
    return;
  }
  try {
    const d = guardDecision(real, config, write(path.join(link, "package-lock.json")));
    assert.equal(d.allow, false);
    assert.equal(d.blocked[0]?.file, "package-lock.json");
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test("blocks a protected file that does not exist yet", () => {
  const root = tmpRepo();
  try {
    const d = guardDecision(root, config, write(path.join(root, "dist", "new", "file.js")));
    assert.equal(d.allow, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("still allows files outside the repository and unprotected files", () => {
  const root = tmpRepo();
  try {
    assert.equal(guardDecision(root, config, write(path.join(os.tmpdir(), "elsewhere.txt"))).allow, true);
    assert.equal(guardDecision(root, config, write(path.join(root, "src", "index.ts"))).allow, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ignores case on case-insensitive platforms", (t) => {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    t.skip("case-sensitive platform");
    return;
  }
  const root = tmpRepo();
  try {
    const d = guardDecision(root, config, write(path.join(root, "Package-Lock.json")));
    assert.equal(d.allow, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
