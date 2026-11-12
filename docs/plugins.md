# Custom rules and plugins

Teams encode their own guardrails as rules. A rule is a plain object; `check(ctx)` returns findings.

```js
// .harness/rules/no-console.mjs   (loaded automatically)
export default {
  id: "team/no-console-log",          // must look like scope/name and not clash with built-ins
  pillar: "architecture",             // context | commands | architecture | tooling | safety | feedback
  weight: 4,                          // points in the score (0–50)
  severity: "warn",                   // error | warn | info
  description: "Production code uses the logger, never console.log.",
  check: ({ files, read }) =>
    files([".ts", ".js"])
      .filter((f) => !f.includes("test") && /console\.log\(/.test(read(f) ?? ""))
      .map((f) => ({ message: "console.log in production code", file: f, hint: "use src/logger.ts" })),
};
```

A file may export one rule or an array. For types and editor completion, `import { defineRule } from "gearness"`.

## The context (`ctx`)

| Member | Description |
|---|---|
| `cwd` | Absolute path of the harness root |
| `config` | Parsed `harness.yaml` |
| `read(rel)` | File contents (CRLF normalized) or `null` |
| `exists(rel)` | Whether a path exists |
| `files(exts?)` | Repository files, skipping dependencies and build output |
| `glob(pattern)` | Files matching a glob (`**`, `*`, `?`) |
| `now` | Current date (injectable in tests) |

A finding is `{ message, file?, line?, hint?, severity? }`. A rule that throws becomes an error finding instead of
crashing the run.

## Sharing rules as a package

Publish a package whose default export is a rule or an array of rules (for example `gearness-preset-nextjs`),
install it as a dev dependency and list it in `harness.yaml`:

```yaml
plugins:
  - gearness-preset-nextjs
```

Rules run as code with your permissions, exactly like ESLint plugins: only use packages you trust.
