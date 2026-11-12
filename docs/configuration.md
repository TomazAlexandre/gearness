# Configuration (`harness.yaml`)

Editors with YAML language support (VS Code with the Red Hat YAML extension, JetBrains IDEs) get autocompletion and
validation from the JSON Schema referenced on the first line that `gearness init` writes:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/TomazAlexandre/gearness/main/schema/harness.schema.json
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `version` | `1` | - | Schema version. Required. |
| `project.name` | string | - | Required. Shown in reports and generated files. |
| `project.description` | string | - | One paragraph used in the scaffolded `AGENTS.md`. |
| `stack` | `node \| python \| go \| java \| rust \| dotnet \| generic` | detected | Informational; used by presets. |
| `commands` | map name → shell command | detected | How agents verify work. `test` and `lint`/`typecheck` are expected. Commands using `npm/pnpm/yarn/bun run`, `make`, `just` or `task` are checked against their files. |
| `context.entry` | path | `AGENTS.md` | Single source of truth for agent instructions. |
| `context.docs` | paths | architecture + conventions | Deeper docs. Each must exist and be linked from the entry. |
| `context.status` | path | `docs/STATUS.md` | Handoff file; flagged when older than 30 days. Omit to disable. |
| `context.maxEntryLines` | number ≥ 10 | `150` | Line limit for the entry file. |
| `context.maxEntryTokens` | number ≥ 10 | `2500` | Approximate token limit (characters ÷ 4) for the entry file. |
| `agents` | list | `claude, cursor, copilot, codex` + detected | Which adapter files `sync` maintains. |
| `gates.minScore` | 0–100 | `70` | Minimum score for `doctor --ci` (each workspace uses its own). |
| `rules.disable` | list of rule ids | `[]` | Rules to skip (they also leave the score). |
| `boundaries` | list | `[]` | Architecture rules checked against imports (below). |
| `workspaces` | list of globs | `[]` | Monorepo packages that each have their own `harness.yaml`. |
| `plugins` | list of npm packages | `[]` | Packages exporting extra rules. See [plugins.md](plugins.md). |
| `eval.agent` | preset or command | `claude` | Agent used by `gearness eval`. See [eval.md](eval.md). |
| `eval.tasks` | path | `.harness/evals` | Directory of eval task files. |
| `eval.timeoutSeconds` | number | `900` | Default timeout per agent run and per check. |

## Boundaries

```yaml
boundaries:
  - from: "src/ui/**"                 # files the rule applies to
    deny: ["src/db/**", "axios"]      # paths or package names they must not import
    except: ["**/*.test.*"]           # optional: files exempt (tests often reach across layers)
    message: UI goes through services, never straight to the database
```

Imports are read from:

| Language | Forms | Matched as |
|---|---|---|
| TypeScript / JavaScript | `import`, `export … from`, dynamic `import()`, `require` | relative imports and `tsconfig`/`jsconfig` `paths` aliases (e.g. `@/db/x`) resolve to repository paths; packages by name |
| Python | `import a.b`, `from a.b import c`, relative `from ..x import y` | `a/b`, relative imports resolve to repository paths |
| Go | single and grouped imports | module-internal paths relative to `go.mod` (`internal/db`); others by import path |
| Java / Kotlin | `import a.b.C`, `import static …`, wildcards | package path `a/b/C` |
| C# | `using A.B;`, aliases, `global using static` | namespace path `A/B` |

A glob `dir/**` covers the directory itself and everything below it; files inside a denied area may import each other.
Aliases come from `compilerOptions.paths` (+ `baseUrl`) of the harness root's tsconfig; `extends` chains are not followed.

## Workspaces (monorepos)

`gearness init --workspaces` reads workspaces from `package.json`, `pnpm-workspace.yaml`, `Cargo.toml` or `go.work`,
scaffolds a harness in each one and links them from the root `AGENTS.md`. `lint` and `doctor` then cover the whole tree,
and `doctor --ci` fails if any workspace has errors or is below its own `gates.minScore`.
Workspaces get adapters only for tools that read instructions from subdirectories (Claude Code, Cursor, Codex, Gemini);
Copilot reads only the repository root.

## Adapter files

| Agent | File | Strategy |
|---|---|---|
| claude | `CLAUDE.md` | Pointer with `@AGENTS.md` import (always live) |
| gemini | `GEMINI.md` | Pointer with `@AGENTS.md` import |
| codex | - | Reads `AGENTS.md` natively |
| cursor | `.cursor/rules/gearness.mdc` | Copy with `alwaysApply: true`, links rewritten |
| copilot | `.github/copilot-instructions.md` | Copy, links rewritten |
| windsurf | `.windsurf/rules/gearness.md` | Copy with `trigger: always_on` |
| cline | `.clinerules/gearness.md` | Copy |

Generated files carry a `gearness:generated` marker. Files without it are never overwritten unless you pass `--force`
(except legacy files whose content `init` just imported into `AGENTS.md`).
