import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasGit } from "../util.js";

export function tmpRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gearness-test-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

export const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
export const write = (dir: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};

export const NODE_PKG = JSON.stringify({ name: "demo-app", scripts: { build: "tsc", test: "vitest run", lint: "eslint ." } });

/** Options for tests that need the git executable: skipped with a clear reason when it is missing. */
export const NEEDS_GIT = { skip: hasGit() ? false : "git not found in PATH (install it to run this test)" };
