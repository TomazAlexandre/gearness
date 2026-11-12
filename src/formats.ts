import { REPO_URL, TOOL, VERSION } from "./meta.js";
import type { Diagnostic, Rule } from "./rules.js";

/** GitHub Actions workflow commands: inline annotations on the PR diff. */
export function toGithubAnnotations(ds: Diagnostic[]): string {
  const esc = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const prop = (s: string) => esc(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
  return ds
    .map((d) => {
      const level = d.severity === "error" ? "error" : d.severity === "warn" ? "warning" : "notice";
      const props = [d.file ? `file=${prop(d.file)}` : "", d.line ? `line=${d.line}` : "", `title=${prop(`${TOOL} ${d.rule}`)}`].filter(Boolean).join(",");
      return `::${level} ${props}::${esc(d.message + (d.hint ? ` - ${d.hint}` : ""))}`;
    })
    .join("\n");
}

/** SARIF 2.1.0 for GitHub code scanning and other static-analysis dashboards. */
export function toSarif(ds: Diagnostic[], rules: Rule[]): object {
  const level = (s: Diagnostic["severity"]) => (s === "error" ? "error" : s === "warn" ? "warning" : "note");
  const used = rules.filter((r) => ds.some((d) => d.rule === r.id));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: TOOL,
            version: VERSION,
            informationUri: REPO_URL,
            rules: used.map((r) => ({
              id: r.id,
              name: r.id.replace(/[/-](\w)/g, (_, c: string) => c.toUpperCase()),
              shortDescription: { text: r.description },
              helpUri: `${REPO_URL}/blob/main/docs/rules.md`,
              defaultConfiguration: { level: level(r.severity) },
              properties: { pillar: r.pillar, weight: r.weight },
            })),
          },
        },
        results: ds.map((d) => ({
          ruleId: d.rule,
          level: level(d.severity),
          message: { text: d.message + (d.hint ? ` (${d.hint})` : "") },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: d.file ?? "harness.yaml" },
                ...(d.line ? { region: { startLine: d.line } } : {}),
              },
            },
          ],
        })),
      },
    ],
  };
}
