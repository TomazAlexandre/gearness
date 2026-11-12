import path from "node:path";
import type { Diagnostic } from "./rules.js";
import { readFile, writeFile } from "./util.js";

/** Applies the safe fixes attached to diagnostics. Paths are relative to `root`. Returns the files changed. */
export function applyFixes(root: string, diagnostics: Diagnostic[]): string[] {
  const byFile = new Map<string, { find: string; replace: string }[]>();
  for (const d of diagnostics) if (d.fix && d.file) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d.fix]);
  const changed: string[] = [];
  for (const [file, fixes] of byFile) {
    const abs = path.join(root, file);
    const before = readFile(abs);
    if (before === null) continue;
    let text = before;
    for (const f of fixes) text = text.split(f.find).join(f.replace);
    if (text !== before) {
      writeFile(abs, text);
      changed.push(file);
    }
  }
  return changed;
}
