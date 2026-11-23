# Status

> Handoff file between work sessions (human or agent). Read first, update last. Keep under 40 lines.

## Current focus
Prove that a harness makes agents fail less, with real agent runs. Everything around it is built and tested; the one thing
missing is a working run of a real agent (see blockers).

## Next steps
1. Unblock the pilot. In a terminal run `claude -p "say hi" --output-format json` and `echo say hi | claude -p --output-format json`.
   If stdin is rejected, set `STUDY_PROMPT_VIA=arg`. Then `node study/runner/run.mjs study/studies/pilot-gearness/study.yaml --conditions full --runs 1 --yes`
   and read `results/metrics.jsonl` (cost, turns, tokens) and the `logTail` of one run. Do not commit pilot results.
2. Confirm the Cursor and Codex guard hooks inside the real agents (ask the agent to edit a protected file; it must be refused).
3. Publish `study/surveys/agents-md/REPORT.md` as a post; invite replications (`study/VOLUNTEER.md`, issue template "Community replication").
4. After the study has results: rule presets (Next.js, Django, Spring, Go). LLM-assisted plugins last; keep the core deterministic.
5. Housekeeping on GitHub: About description and topics, label `replication`, keep README badges current (`gearness badge --check`).

## Open questions / blockers
- The first pilot run failed in 2.8 s (agent error, 0 tokens); the cause is unknown until step 1 above is done.
- The `gemini` eval preset is outdated for free accounts (Gemini CLI free tier ended 2026-06-18); Antigravity CLI and `aider` flags are unverified.
- Cursor and Codex hooks are built from vendor documentation and untested inside the agents; Gemini CLI hook not started.
- Compare with `better-harness` (claims controlled experiments) before claiming to be first to measure.
- Scoring is heuristic: `study/PROTOCOL.md` section 9 lists what H5 will test. Do not re-tune scores after seeing outcomes.

## Recently done
- Score: capped at 39 without an entry file; `context/entry-substance`; `context/placeholders` needs 3 of 5 signs of content.
- `gearness badge --write/--check`, MCP tool hints, version read from package.json, command detection with env prefixes.
- Study kit: protocol, runner, validation gate, volunteer mode (`mine.mjs`, `batch.mjs`), AGENTS.md survey of 112 repositories.
- `protected` paths and `gearness guard` for Claude Code, plus experimental Cursor and Codex hooks. 180 tests passing.
