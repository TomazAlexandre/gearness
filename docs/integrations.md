# The harness in the agent loop

CI catches problems minutes after a push. The cheapest moment to correct an agent is seconds after it makes the
mistake, while the context is still in its window. `gearness install` wires the harness into that loop:

```bash
gearness install                     # Claude Code hook + git pre-commit + MCP server registrations
gearness install --only claude,mcp   # pick integrations
gearness install --command "npx gearness"   # how hooks invoke gearness (default: detected)
gearness install --uninstall         # remove everything gearness added
```

Everything is merged into existing files (your other hooks and settings are kept), is idempotent, and is reversible.
Commit the generated files so the whole team, and every agent session, gets them.

## Claude Code hook

`.claude/settings.json` gets a `PostToolUse` hook on `Edit|MultiEdit|Write` that runs `gearness check --hook claude`.
After each edit, the changed file is checked against:

- architecture boundaries (the nearest `harness.yaml`, so monorepo workspaces use their own),
- leaked secrets,
- broken links, missing anchors and stale path references, when the file is a context doc.

On a violation the hook exits with code 2 and writes the problem to stderr; Claude Code shows that to the agent, which
fixes it immediately. When the agent edits `AGENTS.md`, the hook also regenerates every adapter file, so Cursor,
Copilot and the rest never drift. Malformed input or files outside the repository never block the agent.

## Git pre-commit

`gearness check --staged` checks the staged files before each commit, for humans and agents alike. gearness writes to
`.husky/pre-commit` when the repository uses husky, prints a snippet for `lefthook.yml` or `.pre-commit-config.yaml`
when those exist, and otherwise installs a plain `.git/hooks/pre-commit` (appending to an existing one).

## MCP server

`gearness mcp` is a Model Context Protocol server over stdio. `install` registers it in `.mcp.json` (Claude Code), and
for the agents your harness targets in `.cursor/mcp.json`, `.vscode/mcp.json` (Copilot) and `.gemini/settings.json`.

| Tool | What the agent gets |
|---|---|
| `harness_overview` | Entry file, docs map, verify commands, boundaries, workspaces, score and top gaps |
| `harness_rules_for_path` | Before editing: instruction files and boundaries that apply to that file, docs to read |
| `harness_verify_commands` | The exact commands that must pass before a task is done |
| `harness_can_import` | Whether a file may import a module, resolved through aliases, with the boundary's reason |
| `harness_check_files` | The `check` results for files it changed, before it reports the task as finished |
| `harness_record_lesson` | Adds a learned rule or a mechanical guardrail to the ratchet (with the user's agreement) |

The server is read-only except for `harness_record_lesson`, which is annotated as a write so clients can ask first.

## Learning from what the loop catches

Every violation caught by the hook, the pre-commit check or `harness_check_files` is logged locally. Run
`gearness learn` to see what agents keep getting wrong, and `--apply` to teach it. See [learning.md](learning.md).
