# Principles

These are the ideas the rules encode. Each rule in [rules.md](rules.md) exists to make one of them checkable.

1. **The repository is the system of record.** What an agent needs to know lives in versioned files next to the code,
   not in someone's head or a chat history. → `context/entry-exists`, `context/docs-exist`
2. **A map, not a manual.** The entry file is short and points to deeper docs that are read only when needed
   (progressive disclosure). Long entry files bury what matters. → `context/entry-size`, `context/docs-referenced`
3. **Structure without knowledge is not a harness.** Templates are a starting point; the value is the project-specific
   facts you write into them. → `context/placeholders` (proportional credit)
4. **Agents must be able to verify their own work.** If there is no test or static check command, "done" is a guess.
   → `commands/defined`, `commands/resolvable`, `commands/documented`
5. **One source of truth across tools.** Every agent tool reads the same rules; generated adapters prevent drift.
   → `tooling/adapters-in-sync`
6. **Context is egress.** Everything in instruction files is sent to model providers. → `safety/no-secrets`
7. **Mechanical enforcement beats prose.** Agents can ignore a sentence; they cannot ignore a failing CI check.
   → `feedback/ci-gate`, the `ratchet` command's preference for lint/test/type/hook/ci fixes
8. **Ratchet, never regress.** Every repeated failure becomes a durable guardrail, and removing one is a visible event.
   → `feedback/ratchet-valid`, `feedback/ratchet-active`
9. **Architecture is a guardrail, not a diagram.** Layer rules written only in prose are the first thing an agent
   shortcuts. Declared boundaries are checked against real imports. → `architecture/boundaries`
10. **Measure, don't assume.** A harness change is a hypothesis; evals on the same code with different harnesses test it.
   → `feedback/evals-defined`, `gearness eval --baseline`
11. **Feedback belongs in the loop.** The cheapest moment to correct an agent is seconds after the mistake, while the
   context is still in its window - not in a CI run after the session ended. → `feedback/agent-loop`, `gearness install`
12. **Docs rot like code.** A doc that cites a renamed file is a confident wrong instruction. → `context/stale-references`
13. **The harness learns from behavior.** Mistakes caught in the loop are data; recurring ones become rules.
   → `gearness learn`
14. **Never let it get worse.** The harness itself is ratcheted: a change that lowers the score or adds errors is
   blocked like a failing test. → `doctor --base --no-regress`
15. **Handoffs are explicit.** Long work spans sessions and context windows; a status file carries state between them.
   → `context/status-fresh`
16. **Monorepos get local context.** Each workspace has its own short entry file; the root links them.
   → `context/workspaces`
