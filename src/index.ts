/**
 * Public API for gearness plugins and programmatic use.
 *
 *   // .harness/rules/no-console.mjs
 *   import { defineRule } from "gearness";
 *   export default defineRule({ id: "team/no-console", pillar: "architecture", weight: 4, severity: "warn", ... });
 */
import type { Rule } from "./rules.js";

export type { Ctx, Diagnostic, Finding, Pillar, Rule, Severity } from "./rules.js";
export type { Boundary, HarnessConfig } from "./config.js";
export type { EvalSummary, EvalTask, TaskRun } from "./eval.js";
export { PILLARS, RULES } from "./rules.js";
export { loadConfig, parseConfig } from "./config.js";
export { evaluate, evaluateTree } from "./score.js";
export { runEval, loadTasks } from "./eval.js";
export { checkBoundaries, extractImports } from "./imports.js";
export { headingAnchors, markdownLinks, matchesGlob } from "./util.js";

/** Identity helper that gives rule authors type checking and editor completion. */
export function defineRule(rule: Rule): Rule {
  return rule;
}
