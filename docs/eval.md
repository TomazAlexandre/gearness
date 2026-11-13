# Evals: measure whether your harness helps

`gearness lint` tells you whether the harness is *well formed*. `gearness eval` tells you whether it *works*:
it gives an agent real tasks and checks the results mechanically.

## A task

```yaml
# .harness/evals/add-health-endpoint.yaml   (create with: gearness eval new add-health-endpoint)
id: add-health-endpoint
prompt: |
  Add a GET /health endpoint that returns {"status":"ok"} and is covered by a test.
setup: "npm ci"                    # optional, runs before the agent; its output is not counted as changes
check: "npm test -- health"        # must exit 0 only when the task is done right
forbid:                            # files the agent must not touch
  - "src/generated/**"
  - "package-lock.json"
timeoutSeconds: 900
```

Good tasks are ones your team actually delegates, with a check that is hard to pass by accident.
Start with 3–5 tasks that cover the mistakes in your ratchet log.

## Running

```bash
gearness eval                                   # all tasks, agent from harness.yaml (default: claude)
gearness eval --agent codex --runs 3            # presets: claude, codex, aider, gemini
gearness eval --agent "my-agent --task {prompt}"   # any command; {prompt} is shell-quoted, also in $GEARNESS_PROMPT
gearness eval --baseline main --runs 3          # compare your uncommitted harness against main's harness
gearness eval --task add-health-endpoint --keep # one task, keep the worktree for inspection
gearness eval --min-pass-rate 0.8               # exit 1 below 80% (for scheduled CI)
gearness eval --runs 3 --parallel 3             # three worktrees at a time
gearness eval report                            # pass-rate trend per task across saved runs
gearness eval report --markdown                 # same, as a table for PRs or wikis
```

## Scheduled evals in CI

Evals call a real agent, so they need its credentials and cost money: run them on a schedule, not on every push.

```yaml
# .github/workflows/harness-eval.yml
name: harness-eval
on:
  schedule: [{ cron: "0 6 * * 1" }]   # Mondays
  workflow_dispatch:
jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v7
        with: { node-version: 24 }
      - run: npm install -g @anthropic-ai/claude-code
      - run: npx --yes gearness@0 eval --runs 3 --parallel 3 --min-pass-rate 0.7
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - if: always()
        run: npx --yes gearness@0 eval report --markdown >> "$GITHUB_STEP_SUMMARY"
```

## How it works

Runs execute in a bounded pool (`--parallel`), each in its own worktree; git operations on your repository are
serialized. A run that exceeds its timeout has its whole process tree killed, so a hung agent never hangs the eval.

For every task × variant × run, gearness creates a throwaway `git worktree` at `HEAD`, replaces the harness files
(`harness.yaml`, entry file, context docs, adapters, `.harness/rules`) with the variant's version, runs `setup`,
runs the agent, then checks `git status` for forbidden changes and runs `check`. The worktree is removed afterwards
and your working tree is never touched. Results go to `.harness/eval-results/<timestamp>.json`
(commit them if you want history, or add the folder to `.gitignore`).

The **code** is always `HEAD`; only the **harness** differs between variants. That is what makes the delta
attributable to your harness change.

## Caveats

- Agents are nondeterministic. Use `--runs 3` or more before trusting a delta, and treat small differences as noise.
- Agents run with their own permissions inside the worktree. Review the preset command and prefer sandboxed modes.
- Evals cost money and time; run them on demand or on a schedule, not on every push.
- Only committed code is used. Uncommitted *harness* files are included (that is the point); uncommitted code is not.
