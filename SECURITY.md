# Security policy

## Supported versions

Security fixes are released for the latest minor version.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on https://github.com/TomazAlexandre/gearness.

You will get an answer within a few days. Once a fix is ready, it is released and the advisory is published with
credit to the reporter (unless you prefer otherwise).

## Scope notes

- `gearness eval` runs the agent and the commands you configure in your eval tasks. Treat task files like scripts.
- Custom rules (`.harness/rules/`, `plugins`) are code and run with your permissions, like ESLint plugins.
- The violation log in `.harness/telemetry/` never leaves your machine; nothing is sent over the network.
- **Where gearness starts a shell.** `gearness eval` (`src/eval.ts`) runs, through the platform shell, the agent command and the
  `setup` and `check` commands you wrote in `harness.yaml` and `.harness/evals/*.yaml`. That is the feature, the same trust as
  `npm run`: only run it on repositories you trust, and never on an untrusted pull request. The prompt is shell-quoted, or
  passed in `GEARNESS_PROMPT`, and is never built from repository content you did not configure. Everything else (`lint`, `doctor`,
  `check`, `sync`, the MCP server) reads files and runs no shell command.
- The `study/` directory is development tooling for the effectiveness study. It is not part of the published npm package.
  Its runner starts a shell only to run commands written by the study author (task `check` and `setup`), and, on Windows, to start
  the agent's `.cmd` shim with fixed arguments (the prompt travels on stdin).
- The MCP server declares all four tool hints on every tool. Five tools are read-only; `harness_record_lesson` is the only one that
  writes, and it only appends to the ratchet log and the entry file.
