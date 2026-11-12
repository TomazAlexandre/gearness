// Cross-platform test runner: Windows shells don't expand globs, and Node < 21 can't take globs in --test.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join("dist", "test");
const files = readdirSync(dir).filter((f) => f.endsWith(".test.js")).map((f) => join(dir, f));
const git = spawnSync("git", ["--version"], { stdio: "ignore" });
if (git.error || git.status !== 0)
  console.warn("\n⚠  git was not found in PATH: tests that need git will be SKIPPED.\n   Install it from https://git-scm.com/downloads (Windows: winget install --id Git.Git -e) and open a new terminal.\n");
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
