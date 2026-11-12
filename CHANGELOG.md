# Changelog

## 0.1.0

First public release.

**Harness as code**
- `init` detects the stack (Node, Python, Go, Java, Rust, .NET; Makefile, justfile, Taskfile) and scaffolds
  `harness.yaml`, a short `AGENTS.md` map, context docs, a status file, the ratchet log and a CI gate. Existing
  `CLAUDE.md` / Copilot / Cursor / Gemini / Windsurf instructions are imported, never lost. `--workspaces` for monorepos.
- One source of truth: adapters for Claude Code, Cursor, Copilot (including per-workspace path instructions),
  Gemini CLI, Windsurf and Cline are generated from `AGENTS.md` and kept in sync. Codex reads it natively.
- JSON Schema for `harness.yaml` (editor autocompletion and validation).

**Lint and score**
- 21 rules across context, verification, architecture, agent tooling, safety and feedback; 0–100 score by pillar.
- Broken links and anchors, stale path references (fixed automatically from git rename history with `lint --fix`),
  commands in docs that cannot run or use the wrong package manager, leaked secrets, entry file token budget.
- Output as text, JSON, GitHub annotations or SARIF; `doctor --markdown`; `badge`; `explain <rule>`.
- `doctor --base <ref> --no-regress` blocks pull requests that make the harness worse.

**Architecture**
- Boundaries checked against real imports in TS/JS (with tsconfig aliases), Python, Go, Java, Kotlin and C#.
- `boundaries suggest` infers the layering the code already follows, verified to have zero violations;
  `--strict` freezes the dependency graph. `graph` renders it as Mermaid/DOT with violations and cycles.

**In the agent loop**
- `check` with a Claude Code hook (violations go straight back to the agent), pre-commit (`--staged`) and an MCP
  server with `harness_overview`, `harness_rules_for_path`, `harness_can_import`, `harness_check_files`,
  `harness_verify_commands` and `harness_record_lesson`. `install` wires it all, idempotently and reversibly.
- `context <path>` shows what each agent loads, its token cost and duplicated instructions.
- `learn` turns mistakes agents repeat into learned rules; `ratchet` records every guardrail.

**Evals**
- `eval` runs YAML tasks against Claude Code, Codex, Aider, Gemini CLI or any command in isolated git worktrees,
  in parallel, comparing harness versions on the same code (`--baseline`), with forbidden files, timeouts that kill
  the whole process tree, pass-rate gates and trend reports.

**Platform**
- Node 18+, Linux, macOS and Windows; custom rules and plugin packages; GitHub Action with PR comment, job summary
  and SARIF.
