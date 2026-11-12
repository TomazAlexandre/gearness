// Protocol compliance: the MCP server must work with the official SDK client, not just our own tests.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { init } from "../init.js";
import { NODE_PKG, read, tmpRepo, write } from "./helpers.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

describe("mcp server with the official SDK client", () => {
  it("handshakes, lists tools and answers calls", async () => {
    const dir = tmpRepo({ "package.json": NODE_PKG, "src/ui/a.ts": 'import "../db/x";\n' });
    init(dir);
    write(dir, "harness.yaml", read(dir, "harness.yaml").replace("boundaries: []", 'boundaries:\n  - from: "src/ui/**"\n    deny: ["src/db/**"]'));
    const client = new Client({ name: "compliance", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--cwd", dir] }));
    try {
      assert.equal(client.getServerVersion()?.name, "gearness");
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === "harness_can_import"));
      const denied = await client.callTool({ name: "harness_can_import", arguments: { file: "src/ui/a.ts", import: "../db/pool" } });
      assert.equal((denied.structuredContent as { allowed: boolean }).allowed, false);
      const checked = await client.callTool({ name: "harness_check_files", arguments: { files: ["src/ui/a.ts"] } });
      assert.equal((checked.structuredContent as { ok: boolean }).ok, false);
      const bad = await client.callTool({ name: "harness_record_lesson", arguments: { failure: "x", fix: "lint", artifact: "nope.js" } });
      assert.equal(bad.isError, true);
    } finally {
      await client.close();
    }
  });
});
