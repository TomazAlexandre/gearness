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
