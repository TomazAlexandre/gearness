# Status

> Handoff file between work sessions (human or agent). Read first, update last. Keep under 40 lines.

## Current focus
Prove that the harness helps: run the pilot in `study/`, then the real study. Publish to npm, tag `v0`, announce.

## Next steps
- Case study: protocol, runner and pilot are in `study/` (see `study/README.md`). Next: run the pilot with `--runs 1`, then build Study A and B.
- Score: a trivial entry file still scores ~91 (see `study/PROTOCOL.md` §9). Consider a substance rule before freezing the protocol.
- Official rule presets (Next.js, Django, Spring, Go services) as npm packages.
- Hooks for Cursor, Gemini CLI and Codex as their hook APIs stabilize.

## Open questions / blockers
- Verify headless flags of the gemini and aider eval presets against current CLI versions.

## Recently done
- Score is capped at 39 when the entry file is missing (it used to be 82). 111 tests passing.
