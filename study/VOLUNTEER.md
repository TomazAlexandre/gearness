# Run the study on your own repository

Help answer one question with real data: **does the instruction harness in a repository make a coding agent fail less?**
You run one command on a repository you already work on. The kit builds the tasks from your own git history, so you write
nothing. Results from volunteers are published as *community replications*, separate from the maintainers' own studies.

## What you need

- A git repository with a test command that passes on a clean checkout (`npm test`, `pytest`, `go test ./...`).
- Some history: a handful of commits that fixed or changed something **and touched tests in the same commit**.
- An agent instruction file (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`...) committed **before** those commits. Without it the
  `full` condition would equal `none` and the repository teaches us nothing.
- Node 18+, git, and Claude Code logged in (`claude --version` works). **The measured step uses your plan or API credits**, so
  read "Cost" first.

## Steps (run from a clone of this repository, after `npm ci && npm run build`)

```bash
# 1. Build the tasks from YOUR repository's history. Free: it only reads git.
node study/runner/mine.mjs --repo /path/to/your/repo --test "npm test" --setup "npm ci" --count 5

# 2. Open the generated study/studies/volunteer/*/tasks/*.yaml and read each prompt.
#    It comes from the commit message: delete any sentence that says HOW it was fixed.

# 3. Validate every task and see the plan. Free. Tasks that do not fail on the old code and pass with the real fix are dropped.
node study/runner/batch.mjs study/studies/volunteer

# 4. Measure. This calls the agent. Add --runs 1 for the cheapest possible first try.
node study/runner/batch.mjs study/studies/volunteer --yes
```

Step 4 writes `study/studies/volunteer/report.md`. That is the file to share.

## What the study does to your repository

Nothing. Each run happens in a temporary copy built from `git archive` of the *parent* commit, with no git history, so the
agent cannot read the real fix. The restored tests and the checks live outside that copy. Three conditions are compared on the
same task: `none` (every agent instruction file removed), `minimal` (one line: how to run the tests) and `full` (your own
harness exactly as it was at that commit).

## Cost

One agent run per task × condition × round: `--count 5` with the default `--runs 3` is 5 × 3 × 3 = 45 runs. Start with
`--count 2 --runs 1` (6 runs) to see what one costs on your account. If you use a subscription, runs count against its
limits; with an API key they are billed per token. The plan printed by step 3 shows the total before anything is spent.

## What to share, and what not to

Share `report.md` plus the versions it prints. It contains task ids (`vol-1`...), pass rates, cost and duration, never your
code. **Do not share** `results/raw/*.json` or the `.work` folder: they contain the agent's output, which can include your
source code, and `manifest.json` contains local paths. Open an issue titled "Community replication" and paste the report.

## What this can and cannot tell us

Tasks come from your history, so they are real, but few and not chosen to flatter any harness. With 5 tasks the confidence
intervals are wide and most differences will be reported as *inconclusive*, which is an honest result. Many volunteers
together are what turn "inconclusive" into an answer.
