// Hidden check for add-ruby-stack. Runs with the agent's worktree as the current directory (after `npm test` built dist/).
// A script instead of an inline `node -e` so the task works the same in sh and in cmd.exe.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { detect } = await import(pathToFileURL(path.join(process.cwd(), "dist", "detect.js")).href);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-"));
fs.writeFileSync(path.join(dir, "Gemfile"), 'source "https://rubygems.org"\n');
const r = detect(dir);
process.exit(r.stack === "ruby" && /rspec/.test(r.commands.test || "") ? 0 : 1);
