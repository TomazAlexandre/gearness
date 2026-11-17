import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { VERSION } from "../meta.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };

describe("reported version", () => {
  it("is the version in package.json, which release-please bumps", () => {
    assert.equal(VERSION, pkg.version);
  });

  it("is what the CLI prints for --version and in --help", () => {
    const cli = path.join(ROOT, "dist", "cli.js");
    const run = (arg: string) => spawnSync(process.execPath, [cli, arg], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } }).stdout;
    assert.equal(run("--version").trim(), pkg.version);
    assert.match(run("--help"), new RegExp(`gearness ${pkg.version.replace(/\./g, "\\.")} - harness engineering as code`));
  });
});
