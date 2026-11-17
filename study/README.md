# gearness study kit

Reproducible measurement of one question: **does the harness make an agent fail less?**
Read [PROTOCOL.md](PROTOCOL.md) first. It fixes hypotheses, conditions, metrics and analysis *before* any number exists.

The kit sits on top of `gearness eval`: for every round and every condition it builds an isolated repository and calls
`gearness eval`, then aggregates the raw results into a report.

```text
study/
  PROTOCOL.md            pre-registered rules (freeze before measuring)
  study.example.yaml     template for a new study
  runner/
    run.mjs              run a study: rounds × conditions, interleaved
    validate.mjs         prove every task fails on base code and passes with its reference patch
    report.mjs           raw results -> Markdown report (bootstrap CIs, comparisons, sensitivity)
    agent.mjs            Claude Code headless wrapper that records cost, turns and tokens
    lib.mjs, stats.mjs   trial isolation, config, statistics
    test/                tests, including an end-to-end run with a fake agent
  studies/
    pilot-gearness/      a pilot on this repository (infrastructure check only)
```

Linux, macOS and Windows. Needs Node 18+, git and tar (Windows 10 and later include `tar`), and `npm run build` (the runner calls `dist/cli.js`).
On Windows, set variables in PowerShell with `$env:NAME="value"` and run the commands below from a normal terminal.

## What makes the measurement trustworthy

| Risk | What the runner does |
|---|---|
| The agent finds the real solution in git history | The trial repo is the pinned commit exported **without history**, as a single commit |
| A condition inherits a harness by accident | Every agent file (AGENTS.md, CLAUDE.md, .cursor, .claude, MCP config, a gearness harness and the context docs it declares) is stripped from all conditions, then the overlay is applied |
| The agent reads the check and games it | Tasks live in an untracked folder, never in the agent's worktree; hidden checks are referenced by absolute path from the task file |
| A task measures nothing | `validate.mjs`: the check must fail on base code and pass with the reference patch |
| Model or API drift favours a condition | Conditions run interleaved: each round runs every condition once, in a seeded shuffled order |
| Re-running until the number looks good | `run.mjs` refuses to overwrite results. A re-run is a new study id. It also refuses to measure while PROTOCOL.md has uncommitted changes |
| Run-level tests overstate certainty | The unit of analysis is the task: cluster bootstrap over tasks, then runs |
| Crashes and auth errors counted as agent failures | Invalid runs are detected, excluded from the headline, counted and shown in a sensitivity column |
| Cost hidden behind pass rate | `agent.mjs` records USD, turns and tokens per run |

## Workflow

```bash
npm ci && npm run build

# 1. Write a study: copy the template, add tasks, hidden checks, reference patches, condition overlays.
cp study/study.example.yaml study/studies/my-study/study.yaml

# 2. Prove every task is valid. run.mjs refuses to measure until this has passed for this exact commit and these files.
node study/runner/validate.mjs study/studies/my-study/study.yaml --strict

# 3. Commit PROTOCOL.md and the overlays (freeze). Then see the plan: nothing is sent to the agent.
node study/runner/run.mjs study/studies/my-study/study.yaml

# 4. Measure. This calls the agent and costs real money.
node study/runner/run.mjs study/studies/my-study/study.yaml --yes
#    interrupted? continue with --resume. Never re-run to improve a number.

# 5. Report. Pool several studies by passing several results directories.
node study/runner/report.mjs study/studies/my-study/results
```

Results land in `studies/<id>/results/`: `raw/<condition>.json`, `metrics.jsonl`, `manifest.json`, `report.md`.
Commit them: they are the evidence.

## Writing a task

A task is a `gearness eval` task file in `tasks/`, with two additions:

```yaml
id: fix-rounding
prompt: |                               # from the issue, with NO hints about the solution
  Totals are off by one cent for some carts. Fix it.
setup: npm ci
check: node "{{HIDDEN}}/fix-rounding.mjs"   # {{HIDDEN}} becomes the absolute path of hidden/
forbid: ["src/generated/**"]
```

- Put the PR's test in `hidden/`. Hidden checks run with the worktree as the current directory and must import the
  code from `process.cwd()`.
- Keep `check` and `setup` to **one line that works in both sh and cmd.exe**: call a script (`node "{{HIDDEN}}/x.mjs"`)
  instead of an inline `node -e "..."` with nested quotes.
- Save the PR's diff, **without its tests**, as `reference/<id>.patch` (`git diff` output).
- Run `validate.mjs`. A check that passes on the base code, or fails with the reference patch, is rejected.

## Conditions

| Condition | How to build it |
|---|---|
| `none` | `{}`. Nothing is added. |
| `minimal` | `conditions/minimal/AGENTS.md` with only how to run the tests |
| `bloated` | Run the agent's own init command **once** on the stripped repo and commit the output unedited |
| `full` | `gearness init`, fill the TODO markers, `boundaries suggest --write`, `install`. Without having seen the tasks, within 60 minutes (see PROTOCOL.md §2) |

`strip: false` keeps the target's own harness instead of stripping it (used by the pilot, where the target is gearness itself).

## Before the first paid run

0. **The pinned commit must contain the whole project.** The runner exports `target.commit` with `git archive`, so only what
   is committed exists for the agent. With `commit: HEAD` on a local path, commit your work first (`git add -A`, then
   `git commit`). The plan printed by `run.mjs` shows `repo files` per condition: if that number is tiny, stop.

1. **Confirm the agent can run tests headlessly.** `agent.mjs` allows `Bash,Edit,Write,Read,Glob,Grep` and
   `acceptEdits`. If your Claude Code version needs other flags, set `STUDY_CLAUDE_ARGS` (it **replaces** the defaults,
   so repeat them) and pin the model there (`--model <id>`). Run the pilot with `--runs 1` first and read the log tail of one run.
   The prompt reaches the agent through the environment (`--prompt-env GEARNESS_PROMPT`), so a multi-line prompt never
   passes through shell quoting. `agent.mjs` hands it to `claude` as an argument on Linux/macOS and on stdin on Windows
   (`STUDY_PROMPT_VIA=arg|stdin` overrides). Confirm on the first run that `claude -p` accepts a prompt on stdin.
2. **Confirm cost fields.** `agent.mjs` reads `total_cost_usd`, `num_turns`, `usage` from the agent's JSON output.
   Anything missing is recorded as `null`, never guessed. Check `results/metrics.jsonl` after one run.
3. **Run in a clean environment.** No user-level instruction files (`~/.claude/CLAUDE.md`), ideally a container.
4. **Estimate cost.** The plan printed by step 3 is `conditions × tasks × runs` agent runs. Multiply by the cost per
   run you measured in the pilot.

## Tests

```bash
npm run study:test      # builds, then runs the kit's tests (statistics, isolation, report, end-to-end with a fake agent)
```
