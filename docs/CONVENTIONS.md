# Conventions - gearness

> The patterns agents should copy, and the ones they should not. Point to real files as examples.

## Do
- New rule: add an object to `RULES` in `src/rules.ts` with `id` (`pillar/kebab-name`), weight, severity, a one-sentence
  description that explains *why*, and a `hint` on every finding. Add a test in `src/test/gearness.test.ts`, then run
  `npm run docs:rules` to regenerate `docs/rules.md`.
- New agent adapter: add it to `ADAPTERS` in `src/adapters.ts`, to `AGENTS` in `src/config.ts`, to `detectAgents()` if the
  tool leaves a footprint, and to `NESTABLE` in `src/init.ts` if it reads instructions from subdirectories.
- New import language: extend `extractImports()` in `src/imports.ts` and add a test with comments and aliases.
- New stack: extend `detect()` in `src/detect.ts` and add a detection test.
- Keep runtime dependencies at one (`yaml`). Use Node built-ins for everything else.

## Don't
- Don't call the network or an LLM from core commands. `eval` is the only command that runs an agent, and only the one the user configures.
- Don't print from library modules; return data and let `cli.ts` format it.
- Don't change exit codes (0 ok, 1 findings/gate failed, 2 usage/config error) without a major version bump.

## Naming
Rule ids `pillar/kebab-case`. Files `kebab-case.ts`. Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`).

## Tests
Run `npm run test`. Every rule needs a test that makes it fire and one that shows it stays quiet on a fresh scaffold.
Tests build throwaway repos with `tmpRepo()` from `src/test/helpers.ts`; never touch the real working tree.
