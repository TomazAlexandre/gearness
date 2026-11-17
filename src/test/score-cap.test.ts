import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { init } from "../init.js";
import { evaluate, NO_ENTRY_CAP } from "../score.js";
import { tmpRepo } from "./helpers.js";

const BARE = "version: 1\nproject:\n  name: bare\nagents: []\n";
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const doctor = (dir: string, ...args: string[]) => spawnSync(process.execPath, [CLI, "doctor", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } }).stdout;
const score = (dir: string) => evaluate(dir, loadConfig(dir).config!);

describe("score cap: no entry file means no harness", () => {
  it("a project with only a harness.yaml cannot leave the F band", () => {
    const r = score(tmpRepo({ "harness.yaml": BARE, "package.json": '{"name":"x"}\n' }));
    assert.equal(r.score, NO_ENTRY_CAP);
    assert.equal(r.grade, "F");
    assert.ok(r.cap && r.cap.uncapped > NO_ENTRY_CAP, "the cap reports what the score would have been");
    assert.match(r.cap!.reason, /AGENTS\.md/);
  });

  it("the cap lifts as soon as the entry file exists", () => {
    const dir = tmpRepo({ "harness.yaml": BARE, "package.json": '{"name":"x"}\n' });
    const before = score(dir);
    const after = score(tmpRepo({ "harness.yaml": BARE, "package.json": '{"name":"x"}\n', "AGENTS.md": "# bare\n\nRun the tests.\n" }));
    assert.equal(after.cap, undefined);
    assert.ok(after.score > before.score);
  });

  it("a freshly initialised project is not capped", () => {
    const dir = tmpRepo({ "package.json": '{"name":"x","scripts":{"test":"echo t"}}\n' });
    init(dir, { force: false });
    const r = score(dir);
    assert.equal(r.cap, undefined);
    assert.ok(r.score > NO_ENTRY_CAP);
  });

  it("doctor says so, in the terminal and in the markdown for pull requests", () => {
    const dir = tmpRepo({ "harness.yaml": BARE, "package.json": '{"name":"x"}\n' });
    assert.match(doctor(dir), /39\/100\s+grade F/);
    assert.match(doctor(dir), /capped at 39: entry file AGENTS\.md not found \(would be \d+ without the cap\)/);
    assert.match(doctor(dir, "--markdown"), /Capped at 39: entry file AGENTS\.md not found/);
  });

  it("a team that turns the entry rule off opts out of the cap", () => {
    const dir = tmpRepo({ "harness.yaml": `${BARE}rules:\n  disable: [context/entry-exists]\n`, "package.json": "{}\n" });
    assert.equal(score(dir).cap, undefined);
  });
});
