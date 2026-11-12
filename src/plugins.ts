import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { HarnessConfig } from "./config.js";
import { PILLARS, type Rule, RULES } from "./rules.js";

export const LOCAL_RULES_DIR = ".harness/rules";
const SEVERITIES = ["error", "warn", "info"];

function validate(rule: unknown, source: string): Rule {
  const r = rule as Partial<Rule>;
  const problems: string[] = [];
  if (!r || typeof r !== "object") throw new Error(`${source}: export a rule object or an array of rules`);
  if (typeof r.id !== "string" || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(r.id)) problems.push("`id` must look like `team/rule-name`");
  if (!PILLARS.includes(r.pillar as never)) problems.push(`\`pillar\` must be one of ${PILLARS.join(", ")}`);
  if (typeof r.weight !== "number" || r.weight < 0 || r.weight > 50) problems.push("`weight` must be a number from 0 to 50");
  if (!SEVERITIES.includes(r.severity as string)) problems.push("`severity` must be error, warn or info");
  if (typeof r.description !== "string") problems.push("`description` is required");
  if (typeof r.check !== "function") problems.push("`check(ctx)` must be a function returning findings");
  if (problems.length) throw new Error(`${source}${r?.id ? ` (${r.id})` : ""}: ${problems.join("; ")}`);
  return r as Rule;
}

async function importRules(url: string, source: string): Promise<Rule[]> {
  const mod = await import(url);
  const exported = mod.default ?? mod.rules ?? mod;
  const list = Array.isArray(exported) ? exported : Array.isArray(exported?.rules) ? exported.rules : [exported];
  return list.map((r: unknown) => validate(r, source));
}

/**
 * Loads team rules from .harness/rules/*.{js,mjs} and from npm packages listed in `plugins`.
 * Like ESLint configs, these are code from the repository and run with the user's permissions.
 */
export async function loadExtraRules(cwd: string, config: HarnessConfig): Promise<Rule[]> {
  const rules: Rule[] = [];
  const dir = path.join(cwd, LOCAL_RULES_DIR);
  if (fs.existsSync(dir))
    for (const f of fs.readdirSync(dir).sort())
      if (/\.(m?js)$/.test(f)) rules.push(...(await importRules(pathToFileURL(path.join(dir, f)).href, `${LOCAL_RULES_DIR}/${f}`)));
  const require = createRequire(path.join(cwd, "package.json"));
  for (const name of config.plugins) {
    let resolved: string;
    try {
      resolved = require.resolve(name);
    } catch {
      throw new Error(`plugin "${name}" not found - install it (npm i -D ${name}) or remove it from \`plugins\``);
    }
    rules.push(...(await importRules(pathToFileURL(resolved).href, name)));
  }
  const ids = new Set(RULES.map((r) => r.id));
  for (const r of rules) {
    if (ids.has(r.id)) throw new Error(`duplicate rule id "${r.id}"`);
    ids.add(r.id);
  }
  return rules;
}
