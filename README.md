# gearness

[![CI](https://github.com/TomazAlexandre/gearness/actions/workflows/ci.yml/badge.svg)](https://github.com/TomazAlexandre/gearness/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/gearness)](https://www.npmjs.com/package/gearness)
[![node](https://img.shields.io/node/v/gearness)](package.json)
[![license](https://img.shields.io/github/license/TomazAlexandre/gearness)](LICENSE)

**Harness engineering as code.** Scaffold, lint, score and evolve the harness that keeps AI coding agents reliable in your repository.

*Gear* for your agents' *harness*. 🇧🇷 [Leia em português](README.pt-BR.md)

```text
$ npx gearness init && npx gearness doctor

  Harness score  76/100  grade B   (loja-api)

  Context        █████████████░░░░░░░  63%
  Verification   ████████████████████ 100%
  Architecture   ████████████░░░░░░░░  60%
  Agent tooling  ████████████████████ 100%
  Safety         ████████████████████ 100%
  Feedback loop  ████████████████░░░░  81%

  Highest-impact fixes
  1. +30.0 pts 1 unfilled TODO(gearness) marker(s) - AGENTS.md (+2 more)
     ↳ replace with concrete facts about this codebase - this is where most of the value is
  2. +3.2 pts no architecture boundaries declared - harness.yaml
     ↳ declare at least one rule like `from: src/ui/**` / `deny: [src/db/**]` under `boundaries`
  3. +2.0 pts no agent hook or pre-commit hook runs gearness
     ↳ run `gearness install` - agents get feedback seconds after an edit instead of minutes later in CI
  4. +1.6 pts no ratchet entries yet - .harness/ratchet.yaml
     ↳ next time an agent repeats a mistake, run `gearness ratchet add`
  5. +1.6 pts no eval tasks yet - .harness/evals
     ↳ create one with `gearness eval new <id>`

  Agents  claude ✓   cursor ✓   copilot ✓   codex ✓
```

## Why

`Agent = Model + Harness`. The model is shared by everyone; the harness - the instructions, docs, checks, feedback
loops and guardrails around it - is what makes agents reliable *in your codebase*. Most teams build it ad hoc:
an `AGENTS.md` that grows forever, a `CLAUDE.md` that silently diverges from the Cursor rules, links that rot,
and the same agent mistake fixed by hand for the tenth time.

gearness makes the harness an artifact you can **declare, verify, measure and gate in CI**, like tests or infrastructure.

- **Deterministic.** No LLM calls, no network. Runs in CI in under a second.
- **Agent-agnostic.** `AGENTS.md` is the single source of truth; Claude Code, Cursor and Copilot files are generated from it. Codex reads it natively.
- **Non-destructive.** Never overwrites hand-written files. Existing `CLAUDE.md`/Copilot/Cursor instructions are imported, not lost.
- **Measures, not just scaffolds.** A 0–100 score across six pillars, with the highest-impact fixes first.
- **Proves it works.** `gearness eval` runs real tasks against your agent and compares harness versions on the same code.
- **Enforces architecture.** Declared layer boundaries are checked against real imports (TS/JS, Python, Go).
- **Lives in the agent loop.** A Claude Code hook and an MCP server give agents feedback seconds after an edit, not minutes later in CI.
- **Catches and fixes doc rot.** Dead paths, links and anchors are flagged; renames are fixed automatically from git history.
- **Infers your architecture.** Proposes the layer boundaries your code already respects, verified, and draws the graph.
- **Learns from mistakes.** Violations caught in the loop become learned rules, so agents stop repeating them.
- **Scales to monorepos and teams.** Per-workspace harnesses, custom rules and shareable rule packages.

## Quick start

```bash
npx gearness init       # detects your stack and scaffolds the harness
# fill the TODO(gearness) markers with real knowledge about your codebase
npx gearness doctor     # score + top fixes
npx gearness lint       # problems, eslint-style (exit 1 on errors)
npx gearness install    # Claude Code hook + pre-commit + MCP server, so agents get feedback while they work
npx gearness boundaries suggest --write   # lock in the architecture you already have
```

Requires Node.js 18+ on Linux, macOS or Windows. Detects Node, Python, Go, Java, Rust and .NET projects,
plus Makefile, justfile and Taskfile targets. Monorepo? `npx gearness init --workspaces`.

## What `init` creates

| File | Purpose |
|---|---|
| `harness.yaml` | Declarative description of the harness: commands, context docs, agents, gates |
| `AGENTS.md` | Entry point for agents - a short **map**, not a manual |
| `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md` | Deeper context, read on demand (progressive disclosure) |
| `docs/STATUS.md` | Handoff between sessions: read first, update last |
| `.harness/ratchet.yaml` | Log of agent failures turned into durable guardrails |
| `.github/workflows/gearness.yml` | CI gate: lint + minimum score |
| `CLAUDE.md`, `.cursor/rules/gearness.mdc`, `.github/copilot-instructions.md`, … | Generated adapters for the agents you use (Claude Code, Cursor, Copilot, Gemini CLI, Windsurf, Cline; Codex reads `AGENTS.md` natively) |

## Commands

| Command | What it does |
|---|---|
| `gearness init` | Scaffold the harness. `--workspaces`, `--stack`, `--agents`, `--no-ci`, `--dry-run`, `--force` |
| `gearness lint` | Report problems across the repo and its workspaces. `--fix`, `--format text\|json\|github\|sarif` |
| `gearness doctor` | Score by pillar and top fixes. `--ci` gates, `--base <ref> --no-regress` blocks PRs that make it worse, `--markdown` |
| `gearness sync` | Regenerate adapters from `AGENTS.md`. `--check` for CI, `--force` to replace hand-written files |
| `gearness ratchet add` | Record an agent failure and the guardrail that now prevents it |
| `gearness ratchet list` | Show the ratchet log and the share of mechanical guardrails |
| `gearness check [files]` | Fast check of changed files. `--staged` for pre-commit, `--hook claude` for Claude Code |
| `gearness install` | Wire hooks and the MCP server into the repo. `--only`, `--command`, `--uninstall` |
| `gearness mcp` | MCP server (stdio) so agents can query the harness while they work |
| `gearness eval` | Run eval tasks against an agent. `--runs`, `--parallel`, `--baseline <ref>`, `--agent`, `--min-pass-rate` |
| `gearness eval new <id>` / `list` / `report` | Scaffold, list tasks, or show the pass-rate trend |
| `gearness boundaries suggest` | Infer layer boundaries from imports, verified against the code. `--write` |
| `gearness graph` | Module dependency graph: Mermaid, DOT or JSON, violations and cycles highlighted |
| `gearness context [path]` | Context X-ray: what each agent loads for a path, token cost, duplicates |
| `gearness learn` | Turn mistakes agents repeat into learned rules. `--apply`, `--min` |
| `gearness explain <rule>` | What a rule checks and its findings in this repo |
| `gearness badge` | Print a README badge with the current score |
| `gearness rules` | List all rules (built-in and custom), pillars and weights |

Exit codes: `0` ok · `1` findings or gate failed · `2` usage or config error.

## The ratchet

Harness engineering's core habit: when an agent makes a mistake twice, don't fix the output - change the system so
the mistake becomes hard to repeat, and never let that fix silently disappear.

```bash
# Best: a mechanical guardrail (lint rule, test, type, hook, CI check). It must already exist.
gearness ratchet add --fix lint --artifact eslint.config.js \
  --failure "Agent imported the database layer from a controller"

# When it can't be automated yet: a learned rule, written into AGENTS.md and synced to every agent.
gearness ratchet add --fix doc \
  --failure "Agent edited generated code" --rule "Never edit src/generated; run npm run codegen"
```

`lint` then fails if a recorded artifact is deleted or a learned rule is removed from `AGENTS.md`.
`ratchet list` shows how many of your lessons are mechanical - the number to push up over time.

## In the agent loop

```text
$ gearness install
  + claude  .claude/settings.json added
  + git     .git/hooks/pre-commit added
  + mcp     .mcp.json added
```

Now, seconds after Claude Code edits a file that crosses a boundary or leaks a key, it reads:

```text
gearness: this change breaks the repository's harness rules.
- src/ui/page.tsx:1 imports ../db/pool (crosses src/ui/** ✗ src/db/**) - UI talks to services only [architecture/boundaries]
  fix: go through the allowed layer instead of importing across the boundary
```

…and fixes it before moving on. Through the MCP server, agents can also ask `harness_can_import` before writing an
import and `harness_check_files` before declaring a task done. See [docs/integrations.md](docs/integrations.md).

## Infer the architecture you already have

```text
$ gearness boundaries suggest --write

  Architecture inferred from imports (6 modules under src, 9 cross-module imports)
  3 boundaries that the code already respects (verified: 0 violations today)
  ✓ added 3 boundaries to harness.yaml
```

No one has to write layering rules by hand: gearness reads the import graph, proposes "lower layers never import the
layers above them" for every one-directional dependency, verifies each proposal has zero violations today, and reports
cycles instead of hiding them. `--strict` freezes the whole graph, so an agent cannot add a new coupling (or skip a
layer) without a deliberate change to `harness.yaml`. Tests are exempt automatically. `gearness graph --markdown`
renders it as a Mermaid diagram with violations in red.
See [docs/architecture.md](docs/architecture.md).

## Context X-ray

```text
$ gearness context packages/api/src/index.ts

  claude    ~894 tokens always loaded
    ● CLAUDE.md                                   52  repository root
    ● AGENTS.md                                  425  imported by CLAUDE.md
    ● packages/api/CLAUDE.md                      52  nested in packages/api/
    ● packages/api/AGENTS.md                     365  imported by packages/api/CLAUDE.md
    ○ docs/ARCHITECTURE.md                       172  linked from the entry file
  copilot   ~878 tokens always loaded
    ● .github/copilot-instructions.md            457  repository-wide
    ● .github/instructions/packages-api.…        421  applyTo packages/api/**
  windsurf  ~468 tokens always loaded
    ● .windsurf/rules/gearness.md                468  trigger: always_on
```

What each agent actually loads for a given path, following each tool's documented rules: nested files, `@imports`,
glob-scoped rules, `applyTo`. It shows the token cost, duplicated instructions, and gaps (above: Windsurf gets no
workspace-specific rules).

## A harness that learns

Every violation the hooks and MCP catch is logged locally. `gearness learn` finds what agents keep getting wrong and
`--apply` turns it into learned rules in `AGENTS.md`, so the next session gets it right the first time.
See [docs/learning.md](docs/learning.md).

## Evals: prove the harness helps

```text
$ gearness eval --baseline main --runs 3

  task                         current   main          Δ
  add-health-endpoint          3/3       1/3           +67%
  fix-pagination-bug           2/3       2/3           0%

  Pass rate  current 83%   main 50%   Δ +33 pp
```

Each run happens in a throwaway git worktree with the **same code** and a **different harness**, so the delta comes
from your harness change. Tasks are YAML files with a prompt, a check command and files the agent must not touch.
Works with Claude Code, Codex, Aider, Gemini CLI or any command. See [docs/eval.md](docs/eval.md).

## Architecture boundaries

```yaml
boundaries:
  - from: "src/ui/**"
    deny: ["src/db/**", "axios"]
    message: UI goes through services
```

```text
src/ui/page.tsx
  :1    error  imports ../db/client (crosses src/ui/** ✗ src/db/**) - UI goes through services
```

## Custom rules

Drop a file in `.harness/rules/` or share rules as an npm package - see [docs/plugins.md](docs/plugins.md).

## Scoring

Twenty-one rules across six pillars - **context**, **verification**, **architecture**, **agent tooling**, **safety** and
**feedback loop** - each worth points. A freshly scaffolded harness scores around 75: the structure is there, the
knowledge isn't yet. See [docs/rules.md](docs/rules.md) for every rule and [docs/principles.md](docs/principles.md) for the reasoning.

## CI

`init` adds `.github/workflows/gearness.yml`. Or use the action directly:

```yaml
- uses: actions/checkout@v7
- uses: TomazAlexandre/gearness@v0
  with:
    min-score: 80   # optional, overrides gates.minScore
```

On pull requests the generated workflow also compares with the base branch and fails if the harness got worse
(`doctor --base origin/main --no-regress`). The action annotates problems inline on the PR diff, can keep one up-to-date report comment on the PR (`comment: true`), writes a markdown report to the job summary, can emit SARIF for
code scanning (`sarif: true`), and exposes the score as `steps.<id>.outputs.score`.
Add the score to your README with `gearness badge`.

## Configuration

See [docs/configuration.md](docs/configuration.md); a JSON Schema gives you autocompletion in VS Code and JetBrains. Minimal example:

```yaml
version: 1
project:
  name: loja-api
stack: node
commands:
  test: npm run test
  lint: npm run lint
context:
  entry: AGENTS.md
  docs: [docs/ARCHITECTURE.md, docs/CONVENTIONS.md]
  status: docs/STATUS.md
agents: [claude, cursor, copilot, codex]
gates:
  minScore: 70
```

## Roadmap

- [x] `init`, `lint`, `doctor`, `sync`, `ratchet`, GitHub Action
- [x] `gearness eval` with baselines, forbidden files and pass-rate gates
- [x] Custom rules and plugin packages
- [x] Architecture boundaries (TS/JS, Python, Go)
- [x] Monorepos, Gemini CLI / Windsurf / Cline, Rust / .NET, just / Taskfile, Windows
- [x] Claude Code hook, pre-commit, MCP server; GitHub annotations and SARIF; stale-doc detection
- [x] TypeScript path aliases, Java / Kotlin / C# boundaries; parallel evals and trends; JSON Schema
- [x] Architecture inference and graph, context X-ray, learning loop, regression gate, rename-aware doc fixes
- [ ] Official rule presets (Next.js, Django, Spring, Go services)
- [ ] Hooks for Cursor, Gemini CLI and Codex as their hook APIs stabilize
- [ ] Optional LLM-assisted plugins (suggest a guardrail for a ratchet entry, draft ARCHITECTURE.md)

## See it in 60 seconds

```bash
npm run build && bash scripts/demo.sh
```

The demo creates a small layered app, infers and freezes its architecture, installs the Claude Code hook, simulates an
agent importing the database from the UI (caught instantly, twice), learns a rule from it, and prints the graph,
the context X-ray and the score.

## Contributing

Issues and PRs welcome - see [CONTRIBUTING.md](CONTRIBUTING.md). This repository is harnessed with gearness itself:
start with [AGENTS.md](AGENTS.md).

## License

MIT © [Tomaz Alexandre](https://github.com/TomazAlexandre)
