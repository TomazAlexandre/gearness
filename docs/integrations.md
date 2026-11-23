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

## Protected paths: refusing edits before they happen

The Claude Code hook above checks a file **after** the edit. `protected` in `harness.yaml` (see
[configuration.md](configuration.md#protected-paths)) works the other way: `gearness guard` runs **before** an agent edits a
file and refuses the edit when the path is protected. The agent is told which path and which rule, and nothing else.

```bash
gearness install                 # Claude Code: adds a PreToolUse guard while `protected` is not empty
gearness install --only cursor   # Cursor (experimental): .cursor/hooks.json
gearness install --only codex    # Codex (experimental): .codex/hooks.json
```

Run `gearness install` again after you change `protected`: the Claude Code guard is added when the list has entries and
removed when it is empty, so a project that does not use the feature pays for no extra process per edit.

| Agent | Hook | Status |
|---|---|---|
| Claude Code | `PreToolUse` on `Edit`, `MultiEdit`, `Write`, `NotebookEdit` | Follows the documented hook format |
| Cursor | `preToolUse` on `Write`, `Edit`, `Delete`, `StrReplace` | **Experimental.** Built from Cursor's documentation; not yet confirmed inside the agent |
| Codex | `PreToolUse` on `apply_patch` (also matches `Edit` and `Write`) | **Experimental.** Built from Codex's documentation; not yet confirmed inside the agent |

**What it does not do.** Read this before relying on it.

- It looks at **paths** in the agent's file-editing tools. A shell command such as `sed -i` or `echo > file` is not
  intercepted. It is a guardrail for the common case, not a security boundary.
- Codex only runs a project's hooks once the project is trusted and you have reviewed the hook in `/hooks`; restart Codex after
  installing. A Cursor hook that fails lets the action through by default, and so does this one: **a problem inside gearness
  never blocks an agent**, by design, so a missing or broken install protects nothing instead of stopping your work.
- Agents differ in what they report for an edit, and these formats move. If a host sends a shape the guard does not recognise,
  the edit is allowed.

**Checking it.** After installing, ask the agent to edit a protected file. The edit must be refused with a message naming the
path. If it is not, the hook is not loaded (trust, restart, or the wrong folder). You can also feed the guard a payload by hand:

```bash
echo '{"tool_name":"Write","tool_input":{"file_path":"src/generated/api.ts"}}' | gearness guard --host cursor
```

It prints `{"permission":"deny",...}` for a protected path and `{"permission":"allow"}` otherwise. Claude Code and Codex hosts
print a denial the same way and print nothing to allow, because Codex rejects an explicit `allow`.

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
