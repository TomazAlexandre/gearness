import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BADGE_END, BADGE_START, badgeColor, badgeMarkdown, badgeUrl, updateBadgeBlock } from "../badge.js";
import { init } from "../init.js";
import { tmpRepo } from "./helpers.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const cli = (dir: string, ...args: string[]) => spawnSync(process.execPath, [CLI, "badge", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
const BLOCK = `# t\n\n${BADGE_START}\n${BADGE_END}\n\nKeep this line.\n`;
const project = (readme: string) => {
  const dir = tmpRepo({ "package.json": '{"name":"x","scripts":{"test":"echo t"}}\n', "README.md": readme });
  init(dir, { force: false });
  return dir;
};

describe("badge colours and urls", () => {
  it("uses the documented thresholds", () => {
    assert.deepEqual([100, 90, 89, 75, 74, 60, 59, 40, 39, 0].map(badgeColor), ["brightgreen", "brightgreen", "green", "green", "yellow", "yellow", "orange", "orange", "red", "red"]);
  });
  it("puts score and grade in the url and links to the project", () => {
    assert.equal(badgeUrl(78, "B"), "https://img.shields.io/badge/harness-78%2F100_B-green");
    assert.match(badgeMarkdown(78, "B"), /^\[!\[harness score\]\(https:\/\/img\.shields\.io\/badge\/harness-78%2F100_B-green\)\]\(https:\/\/github\.com\//);
  });
});

describe("updateBadgeBlock", () => {
  const md = "[badge-a]";
  it("fills the block and leaves everything else untouched", () => {
    const r = updateBadgeBlock(BLOCK, md)!;
    assert.equal(r.changed, true);
    assert.equal(r.text, `# t\n\n${BADGE_START}\n${md}\n${BADGE_END}\n\nKeep this line.\n`);
  });
  it("is idempotent and reports when nothing changed", () => {
    const once = updateBadgeBlock(BLOCK, md)!.text;
    const twice = updateBadgeBlock(once, md)!;
    assert.equal(twice.changed, false);
    assert.equal(twice.text, once);
  });
  it("replaces an old badge, including one written on a single line", () => {
    assert.equal(updateBadgeBlock(`a ${BADGE_START}[old]${BADGE_END} b`, md)!.text, `a ${BADGE_START}\n${md}\n${BADGE_END} b`);
  });
  it("keeps Windows line endings", () => {
    const crlf = BLOCK.replace(/\n/g, "\r\n");
    const out = updateBadgeBlock(crlf, md)!.text;
    assert.ok(!/[^\r]\n/.test(out), "no bare LF was introduced");
    assert.ok(out.includes(`${BADGE_START}\r\n${md}\r\n${BADGE_END}`));
  });
  it("returns null when a marker is missing", () => {
    assert.equal(updateBadgeBlock("no markers", md), null);
    assert.equal(updateBadgeBlock(`${BADGE_START} only start`, md), null);
    assert.equal(updateBadgeBlock(`${BADGE_END} before ${BADGE_START}`, md), null);
  });
});

describe("gearness badge --write / --check", () => {
  it("prints the badge by default and changes no file", () => {
    const dir = project(BLOCK);
    assert.match(cli(dir).stdout, /^\[!\[harness score\]/);
    assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), BLOCK);
  });

  it("--write fills the block with the real score, --check then agrees", () => {
    const dir = project(BLOCK);
    const w = cli(dir, "--write");
    assert.equal(w.status, 0, w.stderr);
    const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
    const score = JSON.parse(cli(dir, "--json").stdout).score as number;
    assert.ok(readme.includes(`harness-${score}%2F100_`));
    assert.ok(readme.endsWith("Keep this line.\n"));
    assert.equal(cli(dir, "--check").status, 0);
    assert.match(cli(dir, "--write").stdout, /already up to date/);
  });

  it("--check fails when the score has moved since the badge was written", () => {
    const dir = project(BLOCK);
    cli(dir, "--write");
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# t\n"); // an emptier entry file lowers the score
    const c = cli(dir, "--check");
    assert.equal(c.status, 1);
    assert.match(c.stderr, /out of date/);
    assert.equal(cli(dir, "--write").status, 0);
    assert.equal(cli(dir, "--check").status, 0);
  });

  it("accepts another file, and explains how to add the markers when they are missing", () => {
    const dir = project("# plain\n");
    fs.writeFileSync(path.join(dir, "OTHER.md"), BLOCK);
    assert.equal(cli(dir, "--write", "OTHER.md").status, 0);
    const bad = cli(dir, "--write");
    assert.notEqual(bad.status, 0);
    assert.ok(bad.stderr.includes(BADGE_START) && bad.stderr.includes(BADGE_END));
    assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "# plain\n", "a file without markers is never modified");
  });

  it("fails clearly when the file does not exist", () => {
    const dir = project(BLOCK);
    const r = cli(dir, "--write", "NOPE.md");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /NOPE\.md not found/);
  });
});
