import path from "node:path";
import type { HarnessConfig } from "./config.js";
import { PACKAGE, REPO_URL } from "./meta.js";
import { posix } from "./util.js";

export const PLACEHOLDER = "TODO(gearness)";
export const LEARNED_START = "<!-- gearness:learned-rules:start -->";
export const LEARNED_END = "<!-- gearness:learned-rules:end -->";
export const RATCHET_FILE = ".harness/ratchet.yaml";
export const WORKFLOW_FILE = ".github/workflows/gearness.yml";

const listJoin = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

const rel = (from: string, to: string) => posix(path.relative(path.dirname(from), to)) || ".";

const DOC_BLURB: Record<string, string> = {
  architecture: "modules, boundaries and data flow. Read before touching more than one module.",
  conventions: "code style, naming, patterns to follow and patterns to avoid.",
};

export function agentsMd(config: HarnessConfig, imported: { source: string; content: string }[] = [], workspaces: string[] = []): string {
  const entry = config.context.entry;
  const cmds = Object.entries(config.commands);
  const commandTable = cmds.length
    ? ["| Purpose | Command |", "|---|---|", ...cmds.map(([k, v]) => `| ${k} | \`${v}\` |`)].join("\n")
    : `${PLACEHOLDER}: list the commands that build, lint and test this project (and add them to harness.yaml).`;
  const verify = ["test", "lint", "typecheck"].filter((c) => config.commands[c]);
  const doneLine = verify.length
    ? `A task is **not done** until ${listJoin(verify.map((v) => `\`${v}\``))} pass${verify.length === 1 ? "es" : ""}.`
    : "A task is **not done** until the project's checks pass.";

  const map = config.context.docs.map((d) => {
    const key = path.basename(d, path.extname(d)).toLowerCase();
    const title = path.basename(d, path.extname(d)).replace(/[-_]/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
    return `- [${title}](${rel(entry, d)}) - ${DOC_BLURB[key] ?? "read when working in this area."}`;
  });
  if (config.context.status)
    map.push(`- [Status](${rel(entry, config.context.status)}) - work in progress and handoff notes. **Read first, update last.**`);

  const wsBlock = workspaces.length
    ? [
        "",
        "## Workspaces",
        "Each workspace has its own entry file with local commands and rules. Read the one for the code you are changing.",
        "",
        ...workspaces.map((w) => `- [${w}](${rel(entry, `${w}/${path.posix.basename(entry)}`)})`),
      ]
    : [];

  const importedBlock = imported.length
    ? [
        "",
        "## Imported instructions",
        `Moved here by \`gearness init\` so every agent reads the same rules. ${PLACEHOLDER}: merge into the sections above, then delete this section.`,
        ...imported.flatMap((i) => ["", `### From \`${i.source}\``, "", i.content.trim().replace(/^#{1,3} /gm, "#### ")]),
      ]
    : [];

  return [
    `# AGENTS.md - ${config.project.name}`,
    "",
    "> Entry point for AI coding agents. This file is a **map, not a manual**: keep it short and link to deeper docs.",
    `> It is the single source of truth for all agent tools. Edit it here, then run \`gearness sync\`.`,
    "",
    "## Project",
    config.project.description ?? `${PLACEHOLDER}: one paragraph on what this project does, for whom, and what must never break.`,
    "",
    "## Commands",
    doneLine,
    "",
    commandTable,
    "",
    "## Map",
    ...(map.length ? map : [`${PLACEHOLDER}: link the docs an agent should read for each area.`]),
    "",
    "## Working agreement",
    config.context.status
      ? `1. Read \`${config.context.status}\` before starting; update it before you stop.`
      : "1. Restate the goal and plan before making changes.",
    "2. Make small, reviewable changes. One concern per change.",
    "3. Do not edit generated files, lockfiles or vendored code unless the task requires it.",
    "4. When a check fails, fix the cause. Never disable, skip or weaken a check to make it pass.",
    "5. When unsure about a boundary or convention, read the linked doc instead of guessing.",
    "",
    "## Learned rules",
    "Added after real agent failures (history in `.harness/ratchet.yaml`). Do not remove without discussion.",
    "",
    LEARNED_START,
    LEARNED_END,
    ...wsBlock,
    ...importedBlock,
    "",
  ].join("\n");
}

export function architectureMd(name: string): string {
  return `# Architecture - ${name}

> Read this before changing more than one module. Keep it current: an outdated map is worse than no map.

## Overview
${PLACEHOLDER}: two or three sentences on the system's purpose and its main moving parts.

## Modules
| Path | Responsibility | May depend on |
|---|---|---|
| \`${PLACEHOLDER}\` | | |

## Boundaries (enforced)
${PLACEHOLDER}: rules that must hold, e.g. "UI never imports from the database layer".
Prefer encoding each boundary as a lint rule or test, then link it here.

## Data flow
${PLACEHOLDER}: how a typical request or job moves through the system.

## Decisions
Record significant decisions as short ADRs (one file each, e.g. in an \`adr\` folder next to this doc) and link them here.
`;
}

export function conventionsMd(config: HarnessConfig): string {
  return `# Conventions - ${config.project.name}

> The patterns agents should copy, and the ones they should not. Point to real files as examples.

## Do
- ${PLACEHOLDER}: e.g. "New endpoints follow \`src/api/users.ts\`."

## Don't
- ${PLACEHOLDER}: e.g. "Don't add new dependencies without noting why in the PR."

## Naming
${PLACEHOLDER}: files, functions, tests, branches.

## Tests
${config.commands.test ? `Run \`${config.commands.test}\`. ` : ""}${PLACEHOLDER}: where tests live and what every change must cover.
`;
}

export function statusMd(): string {
  return `# Status

> Handoff file between work sessions (human or agent). Read first, update last. Keep under 40 lines.

## Current focus
Nothing in progress.

## Next steps
-

## Open questions / blockers
-

## Recently done
- Harness initialized with gearness.
`;
}

export function ratchetYaml(): string {
  return `# Ratchet log: every agent failure that should never happen again becomes a durable artifact
# (a lint rule, a test, a hook, a CI gate or a documented rule). Add entries with \`gearness ratchet add\`.
entries: []
`;
}

export function workflowYml(): string {
  return `# Harness gate: keeps agent instructions valid and the harness score above gates.minScore.
# Generated by gearness (${REPO_URL}).
name: harness

on:
  pull_request:
  push:
    branches: [main]

jobs:
  harness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Lint harness (inline PR annotations)
        run: npx --yes ${PACKAGE}@0 lint --format github
      - name: Harness score gate
        run: npx --yes ${PACKAGE}@0 doctor --ci
      - name: Harness must not regress vs the base branch
        if: github.event_name == 'pull_request'
        run: npx --yes ${PACKAGE}@0 doctor --ci --no-regress --base "origin/$GITHUB_BASE_REF"
      - name: Harness report
        if: always()
        run: |
          if [ -n "$GITHUB_BASE_REF" ]; then base="--base origin/$GITHUB_BASE_REF"; fi
          npx --yes ${PACKAGE}@0 doctor --markdown $base >> "$GITHUB_STEP_SUMMARY"
`;
}

export function evalTaskYaml(id: string, config: HarnessConfig): string {
  const check = config.commands.test ?? `${PLACEHOLDER}: command that exits 0 only if the task was done right`;
  return `# Eval task for \`gearness eval\`. The agent gets \`prompt\` in a throwaway git worktree;
# the task passes when \`check\` exits 0 and no file matching \`forbid\` was changed.
id: ${id}
prompt: |
  ${PLACEHOLDER}: a realistic task your team gives agents, written the way you would write it.
# Optional: runs before the agent (e.g. install dependencies in the fresh worktree).
${config.commands.install ? `setup: ${JSON.stringify(config.commands.install)}` : "# setup: npm ci"}
check: ${JSON.stringify(check)}
forbid:
  - "${config.context.entry}"
timeoutSeconds: ${config.eval.timeoutSeconds}
`;
}
