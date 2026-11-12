# Contributing to gearness

Thanks for helping! This repo is harnessed with gearness itself, so humans and agents follow the same guide:
[AGENTS.md](AGENTS.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/CONVENTIONS.md](docs/CONVENTIONS.md).

## Setup

```bash
npm ci
npm test              # build + node:test suite
node dist/cli.js doctor
```

## Good first contributions

- **A new rule.** Open an issue with the *Rule proposal* template first: what failure it prevents and how to detect it
  deterministically. Then follow "New rule" in docs/CONVENTIONS.md.
- **A new stack** in `src/detect.ts` (PHP, Ruby, Elixir…). There is an eval task for Ruby in `.harness/evals/` -
  try solving it with your agent and compare with `gearness eval`.
- **A new agent adapter** in `src/adapters.ts` (Aider, Zed, JetBrains AI…).
- **A new import language** for boundaries in `src/imports.ts` (Java, Kotlin, C#, Ruby…).
- **A rule preset** package for a framework - see [docs/plugins.md](docs/plugins.md).
- **Hooks for more agents** in `src/install.ts` and `src/check.ts` (Cursor, Gemini CLI, Codex) as their hook APIs settle.
- **New MCP tools** in `src/mcp.ts` - keep them read-only unless a write is essential, and annotate writes.
- Translations of the docs.

## Pull requests

- One concern per PR, Conventional Commit title (`feat:`, `fix:`, `docs:`).
- `npm run typecheck`, `npm test` and `node dist/cli.js doctor --ci` must pass (CI runs them on Node 18, 20 and 22).
- If you changed rules, run `npm run docs:rules`.
- If you found a class of bug that could recur, record it: `node dist/cli.js ratchet add …`.

## Code of conduct

Be kind and assume good intent. Harassment of any kind is not tolerated; maintainers may remove content or contributors that violate this.
