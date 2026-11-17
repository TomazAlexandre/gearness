import { readFileSync } from "node:fs";

/** Single place to change project identity before publishing. */
export const TOOL = "gearness";
export const PACKAGE = "gearness";
export const REPO_URL = "https://github.com/TomazAlexandre/gearness";
export const SCHEMA_URL = "https://raw.githubusercontent.com/TomazAlexandre/gearness/main/schema/harness.schema.json";

/** Read from package.json, the file release-please bumps, so the reported version can never drift from the published one. */
function readVersion(): string {
  try {
    return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  } catch {
    return "0.0.0-unknown";
  }
}
export const VERSION = readVersion();
