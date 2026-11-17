# Status

> Handoff file between work sessions (human or agent). Read first, update last. Keep under 40 lines.

## Current focus
Prove that the harness helps: run the pilot in `study/`, then the real study. Publish to npm, tag `v0`, announce.

## Next steps
- Case study: protocol, runner and pilot are in `study/` (see `study/README.md`). Next: run the pilot with `--runs 1`, then build Study A and B.
- Score: a thin entry file went from ~91 to ~69 (`context/entry-substance`, and `context/placeholders` now needs >= 3 of 5 signs of real content). Both are heuristics; H5 tests them against outcomes (`study/PROTOCOL.md` §9).
- Official rule presets (Next.js, Django, Spring, Go services) as npm packages.
- Hooks for Cursor, Gemini CLI and Codex as their hook APIs stabilize.

## Open questions / blockers
- Verify headless flags of the gemini and aider eval presets against current CLI versions.

## Recently done
- Score is capped at 39 when the entry file is missing (it used to be 82). 138 tests passing.
