# Architecture - gearness

> Read this before changing more than one module. Keep it current: an outdated map is worse than no map.

## Overview
A single-package TypeScript CLI with one runtime dependency (`yaml`). Everything flows from `harness.yaml`:
it is parsed into a `HarnessConfig`, rules run against the repository, and results are printed or scored.
No network access, no LLM calls: every command is deterministic so it can run in CI.

## Modules
| Path | Responsibility | May depend on |
|---|---|---|
| `src/cli.ts` | Argument parsing, output formatting (text, JSON, markdown), exit codes | everything |
| `src/index.ts` | Public API for plugins and programmatic use (`defineRule`, types) | library modules |
| `src/config.ts` | `harness.yaml` schema, validation, defaults, serialization | `util`, `meta` |
| `src/detect.ts` | Stack, command, task-runner and workspace detection | `util`, `config` (types) |
| `src/templates.ts` | Content of every scaffolded file | `config` (types), `meta`, `util` |
| `src/init.ts` | Scaffolding (recursive for workspaces), imports legacy instruction files | `detect`, `templates`, `adapters`, `config` |
| `src/adapters.ts` | Renders and checks agent-specific files from the entry file; detects tools in use | `config`, `util` |
| `src/ratchet.ts` | Ratchet log (`.harness/ratchet.yaml`) and learned-rule insertion | `templates`, `util` |
| `src/imports.ts` | Import extraction (TS/JS with tsconfig aliases, Python, Go, Java, Kotlin, C#) and boundary checking | `config` (types), `util` |
| `src/rules.ts` | Built-in rule registry and the rule context (`Ctx`) | `adapters`, `ratchet`, `imports`, `detect`, `config`, `util` |
| `src/plugins.ts` | Loads and validates custom rules (`.harness/rules/*.mjs`, `plugins`) | `rules`, `config` |
| `src/score.ts` | Score per pillar; `evaluateTree` covers workspaces | `rules`, `plugins`, `config` |
| `src/eval.ts` | Eval tasks, git-worktree isolation, parallel agent runs with process-tree timeouts, history | `adapters`, `templates`, `config`, `util` |
| `src/check.ts` | Fast per-file checks for hooks and pre-commit; nearest-harness lookup in monorepos | `rules`, `imports`, `adapters`, `config` |
| `src/install.ts` | Wires hooks (Claude Code, git/husky) and MCP registrations into the repo, idempotently | `config`, `meta`, `util` |
| `src/mcp.ts` | MCP server over stdio: overview, verify commands, can-import, check files, record lesson | `check`, `imports`, `ratchet`, `score`, `config` |
| `src/formats.ts` | GitHub annotations and SARIF output | `rules` (types), `meta` |
| `src/commands.ts` | Shell command parsing: scripts, task runners, package-manager consistency, commands in docs | `detect`, `util` |
| `src/graph.ts` | Module graph from imports, boundary inference (verified), Mermaid/DOT rendering | `imports`, `util` |
| `src/xray.ts` | Context X-ray: what each agent tool loads for a path | `config` (types), `util` |
| `src/learn.ts` | Local violation log and recurring-mistake detection → learned rules | `eval`, `ratchet`, `util` |
| `src/compare.ts` | Evaluates the harness at a git ref in a worktree and diffs findings | `score`, `config` |
| `src/fix.ts` | Applies safe fixes attached to diagnostics (`lint --fix`) | `util` |
| `src/test/` | `node:test` suites, one temp repo per test | anything |

## Boundaries (enforced)
These are declared in `harness.yaml` and checked by `architecture/boundaries` on every CI run.
- Only `cli.ts` writes to stdout/stderr or sets exit codes. Library modules return data or throw `Error`.
- Rules never write files and must not import `init` or `eval`. Fixing is done by `sync`/`init`, invoked explicitly.
- `init` and `sync` never overwrite a file that lacks the `gearness:generated` marker unless `--force` is passed
  (exception: legacy files whose content `init` just imported into the entry file). Tests cover this.

## Data flow
`cli lint|doctor` → `loadConfig` → `evaluateTree` (root + each workspace) → `loadExtraRules` → `evaluate` →
`runRules` → each `Rule.check(ctx)` → diagnostics → weighted credit per rule → score and pillars → printed by `cli.ts`.

`cli check --hook claude` → payload on stdin → `checkFiles` (nearest harness per file) → boundaries + secrets +
per-file context rules → exit 2 with feedback on stderr, which Claude Code shows to the agent.

`cli eval` → `loadTasks` → per task × variant × run: `git worktree add` at HEAD → overlay harness files
(working tree, or `--baseline` ref) → commit → setup → agent → `git status` (forbidden files) → check → cleanup →
summary saved to `.harness/eval-results/`.

## Decisions
- Deterministic core, LLM features only as future opt-in plugins (CI-safe, no data leaves the machine).
- `AGENTS.md` is the single source of truth; other agents get generated adapters, never hand copies.
- Placeholder rule uses proportional credit so an unfilled scaffold cannot score an A.
- Eval compares *harness variants on the same code* (HEAD), so a pass-rate delta is attributable to the harness.
- Text is read with CRLF normalized so Windows checkouts (autocrlf) never look drifted.
- File listing uses `git ls-files` when available, so `.gitignore` is honored and large repos stay fast.
- The MCP server is hand-written (newline-delimited JSON-RPC) to keep a single runtime dependency.
- Hooks never block on malformed input: a broken payload exits 0, only real violations exit 2.
