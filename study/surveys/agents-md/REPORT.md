# How do real AGENTS.md files look? A first survey

*Run on 2026-11-18 (UTC) with gearness's context rules. Aggregates only: no repository is named and no per-repository
result is published.*

## What we did

We sampled public GitHub repositories tagged `agents-md` (not forks, not archived, up to 30 MB) in two views, the most
starred and the most recently updated, downloaded each as a clone-like copy (with a git repository, because some rules read
`.gitignore`) and ran gearness's context rules on the `AGENTS.md` at its root.

- 160 repositories sampled and downloaded.
- **112 have an `AGENTS.md` at the root** and were analysed. The other 48 are tagged `agents-md` but keep no such file
  at the root (it may live in a subfolder, or the tag marks tooling about the format).

## What we found

**Size.** Median 75 lines, 90th percentile 186, longest 398.

**Signs of real project knowledge.** `context/entry-substance` looks for five: enough real content, at least two sections,
a runnable command, a pointer to an existing file or folder, and at least one explicit rule.

| Signs present (of 5) | Repositories |
|---|---|
| 5 | 58.9% |
| 4 | 27.7% |
| 3 | 9.8% |
| 2 or fewer | 3.6% |

Which sign is most often missing: a runnable command (28.6% of files), then structure and explicit rules (10.7% each),
pointers (7.1%) and content (4.5%). Some of the files without a command are not software projects at all (collections of
instructions or notes), so this is not a claim that those files are poor.

**Share of repositories with at least one finding, by rule.**

| Rule | Repositories |
|---|---|
| `context/entry-substance` (at least one of the five signs missing) | 41.1% |
| `context/entry-size` (long for an entry file) | 23.2% |
| `context/stale-references` (a path in code formatting that does not exist) | 13.4% |
| `context/placeholders` (scaffold markers left in) | 3.6% |
| `context/broken-links` | 0.9% |

**Speed.** Median 4 ms per repository, 90th percentile 12 ms, slowest 32 ms. The rules are deterministic and run offline.

## What the survey changed in gearness

We read samples of the findings before trusting the numbers, and found two problems:

1. **The first run was wrong, not the files.** Downloaded archives carry no `.git`, and `context/stale-references` skips
   paths the repository ignores. Once every copy got a git repository, as a real clone has, the share with a stale reference
   fell from 24% to 13%. The published numbers use the corrected setup.
2. **A real detector gap.** A command written with an environment assignment in front, such as
   `PYTHONPATH=src python -m unittest ...`, was not recognised as a command. Fixed, with other common runners and
   `./script.sh` forms added. The share of files without a command fell from 37% to 29%.

What remains after our fixes still includes paths that are examples rather than claims (a doc that shows where a *future*
file would go) and directories created when a tool runs. A deterministic rule cannot tell those from a genuinely stale
path, so **read `stale-references` as "worth a look", not as an error count**.

The gate we put on `context/placeholders` (full credit needs at least 3 of the 5 signs) affects only **3.6%** of these
real files, so it is conservative: it catches the thinnest entry files and leaves almost all real ones alone.

## What these numbers do not say

- **They do not say who writes better instructions.** The population is self-selected: repositories whose owners tagged
  them `agents-md`. Many are templates, tools or experiments, not production services, and the two views overlap in
  character. Do not generalise to "most repositories".
- **A finding is not a defect.** Each rule is a heuristic with false positives, as the audit above shows.
- **They say nothing about outcomes.** Whether a file with five signs makes an agent fail less than one with two is exactly
  what the effectiveness study in `study/` is for. This survey only describes what exists.
- A single snapshot, from one sampling procedure; repeating it later gives a slightly different sample because the
  "recently updated" view moves.

## Reproduce it

```bash
npm ci && npm run build
node study/surveys/agents-md/survey.mjs            # about 3 minutes; set GITHUB_TOKEN to avoid the search rate limit
```

It writes `study/surveys/agents-md/results/summary-<date>.json`.
