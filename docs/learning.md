# The learning loop

A harness should improve from what agents actually do, not from guesses. gearness closes that loop:

1. **Catch.** The Claude Code hook, the pre-commit hook and the MCP `harness_check_files` tool catch violations as
   they happen, and append them to `.harness/telemetry/events.jsonl`. The log is local: it never leaves the machine,
   and `.harness/.gitignore` keeps it out of git. Set `GEARNESS_TELEMETRY=0` to disable it.
2. **Find patterns.** `gearness learn` groups events (and forbidden-file changes from eval runs) into recurring
   mistakes: the same boundary crossed again and again, credentials pasted into code, docs left pointing to moved files,
   a lockfile touched during unrelated tasks.
3. **Teach.** `gearness learn --apply` turns each recurring mistake (2+ times by default, `--min` to change) into a
   learned rule in `AGENTS.md` and an entry in the ratchet log, then re-syncs every agent's instruction file.

```text
$ gearness learn

  What agents keep getting wrong (seen 2+ times)

  7× imports from src/db inside src/ui · 3 day(s) · claude-hook, pre-commit  caught, not yet taught
     → rule: Code under `src/ui/` must not import from `src/db/` - UI talks to services only
  2× changes package-lock.json during unrelated tasks · 1 day(s) · eval  not guarded
     → rule: Do not modify `package-lock.json` unless the task explicitly asks for it
```

Why teach a rule that a hook already enforces? Because every caught violation still costs the agent a failed attempt,
tokens and time. Telling it up front makes the first attempt right. Lessons are recorded once: running `learn --apply`
again adds nothing new.

Pair it with `gearness eval --baseline` to measure whether the learned rules actually raise the pass rate.
