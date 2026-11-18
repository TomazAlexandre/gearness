import { REPO_URL } from "./meta.js";

/** Markers that tell `gearness badge --write` where the badge lives. Nothing outside them is ever touched. */
export const BADGE_START = "<!-- gearness:badge -->";
export const BADGE_END = "<!-- /gearness:badge -->";

export function badgeColor(score: number): string {
  return score >= 90 ? "brightgreen" : score >= 75 ? "green" : score >= 60 ? "yellow" : score >= 40 ? "orange" : "red";
}

export function badgeUrl(score: number, grade: string): string {
  return `https://img.shields.io/badge/harness-${score}%2F100_${grade}-${badgeColor(score)}`;
}

export function badgeMarkdown(score: number, grade: string): string {
  return `[![harness score](${badgeUrl(score, grade)})](${REPO_URL})`;
}

/**
 * Replaces what is between the markers with the badge. Returns null when the markers are missing (the caller explains how to add
 * them) and keeps the file's own line endings. `changed` is false when the badge was already current, so --write is idempotent
 * and --check can tell a stale badge from a fresh one.
 */
export function updateBadgeBlock(text: string, markdown: string): { text: string; changed: boolean } | null {
  const start = text.indexOf(BADGE_START);
  if (start === -1) return null;
  const end = text.indexOf(BADGE_END, start + BADGE_START.length);
  if (end === -1) return null;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const next = `${text.slice(0, start)}${BADGE_START}${eol}${markdown}${eol}${BADGE_END}${text.slice(end + BADGE_END.length)}`;
  return { text: next, changed: next !== text };
}
