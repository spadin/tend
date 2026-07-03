// Region extractors: pure string functions that slice the captured pane text
// down to the part a rule cares about. Keeping these tiny and pure is what makes
// the rule engine testable.

import type { Region } from "./types.ts";

// A "horizontal rule" line is one made mostly of box-drawing horizontals — the
// borders Claude/Codex draw around their input box and section separators.
const RULE_CHARS = /[─━╌╍]/g;

function isRuleLine(line: string): boolean {
  const matches = line.match(RULE_CHARS);
  return matches !== null && matches.length >= 3;
}

function indicesOfRuleLines(lines: string[]): number[] {
  const idx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isRuleLine(lines[i]!)) idx.push(i);
  }
  return idx;
}

// Everything below the last horizontal rule — isolates the live prompt area
// from scrollback above it.
export function afterLastHorizontalRule(lines: string[]): string[] {
  const rules = indicesOfRuleLines(lines);
  if (rules.length === 0) return lines;
  const last = rules[rules.length - 1]!;
  return lines.slice(last + 1);
}

// The interior of the input box: the lines between the last two horizontal
// rules (the box's top and bottom borders). Falls back to the tail if there
// aren't two borders to bracket.
export function promptBoxBody(lines: string[]): string[] {
  const rules = indicesOfRuleLines(lines);
  if (rules.length < 2) return bottomNonEmptyLines(lines, 3);
  const bottom = rules[rules.length - 1]!;
  const top = rules[rules.length - 2]!;
  return lines.slice(top + 1, bottom);
}

// The last N lines that aren't blank.
export function bottomNonEmptyLines(lines: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    if (lines[i]!.trim().length > 0) out.push(lines[i]!);
  }
  return out.reverse();
}

export function extractRegion(lines: string[], region: Region): string {
  if (typeof region === "object") {
    return bottomNonEmptyLines(lines, region.bottom_non_empty_lines).join("\n");
  }
  switch (region) {
    case "full":
      return lines.join("\n");
    case "after_last_horizontal_rule":
      return afterLastHorizontalRule(lines).join("\n");
    case "prompt_box_body":
      return promptBoxBody(lines).join("\n");
  }
}
