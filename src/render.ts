// Terminal rendering: agents grouped by tmux session, with colored state dots
// and a git column. No dependencies — raw ANSI. Falls back to plain text when
// stdout isn't a TTY (piped) or NO_COLOR is set.

import type { AgentState, AgentStatus, GitStatus } from "./types.ts";

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

export const color = (code: string, s: string) =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
export const dim = (s: string) => color("2", s);
export const bold = (s: string) => color("1", s);

// Braille spinner frames for the "working" state (classic dots animation).
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// The state indicator: a distinct *shape* per state (so it reads even without
// color) plus color. "working" animates through the spinner; `frame` advances it.
export function stateGlyph(state: AgentState, frame = 0): string {
  switch (state) {
    case "blocked":
      return color("31", "●"); // red filled — needs you
    case "working":
      return color("33", SPINNER[frame % SPINNER.length]!); // yellow spinner
    case "idle":
      return color("32", "○"); // green hollow — waiting for input
    case "unknown":
      return color("90", "◌"); // grey dotted — unknown
  }
}

export function gitCell(git: GitStatus | null): string {
  if (!git || !git.branch) return dim("—");
  let s = git.branch;
  const marks: string[] = [];
  if (git.ahead) marks.push(`↑${git.ahead}`);
  if (git.behind) marks.push(`↓${git.behind}`);
  if (git.dirty) marks.push(color("33", "✱"));
  if (marks.length) s += " " + marks.join(" ");
  return s;
}

// Pad by *visible* width, ignoring ANSI escapes.
export function pad(s: string, width: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return s + " ".repeat(Math.max(0, width - visible));
}

const STATE_ORDER: Record<AgentState, number> = {
  blocked: 0,
  working: 1,
  idle: 2,
  unknown: 3,
};

export interface SessionGroup {
  session: string;
  agents: AgentStatus[];
}

// Group agents by tmux session (insertion order = tmux's session order), with
// each session's agents sorted blocked→working→idle so the ones needing you
// float to the top.
export function groupBySession(statuses: AgentStatus[]): SessionGroup[] {
  const groups = new Map<string, AgentStatus[]>();
  for (const s of statuses) {
    const key = s.pane.sessionName;
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(s);
  }
  return [...groups.entries()].map(([session, agents]) => ({
    session,
    agents: agents.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]),
  }));
}

// One agent row: state glyph + pane id + agent + git. The glyph's shape+color
// carries the state (● red blocked, spinner yellow working, ○ green idle); the
// pane id is the jump reference. `cursor` renders a caret; `frame` animates the
// working spinner.
export function agentRow(s: AgentStatus, cursor = false, frame = 0): string {
  const caret = cursor ? bold("❯ ") : "  ";
  return (
    caret +
    `${stateGlyph(s.state, frame)} ` +
    pad(s.pane.id, 6) +
    pad(bold(s.agent), 10) +
    gitCell(s.git)
  );
}

export function renderGrouped(statuses: AgentStatus[], frame = 0): string {
  if (statuses.length === 0) {
    return dim("No AI agents detected in any tmux session.");
  }
  const lines: string[] = [];
  for (const { session, agents } of groupBySession(statuses)) {
    const blocked = agents.filter((a) => a.state === "blocked").length;
    const suffix = blocked ? color("31", ` · ${blocked} blocked`) : "";
    lines.push(bold(`▸ ${session}`) + dim(`  (${agents.length})`) + suffix);
    for (const a of agents) lines.push(agentRow(a, false, frame));
    lines.push("");
  }
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

export function renderJson(statuses: AgentStatus[]): string {
  return JSON.stringify(
    statuses.map((s) => ({
      pane: s.pane.id,
      agent: s.agent,
      state: s.state,
      matchedRule: s.matchedRule,
      session: s.pane.sessionName,
      window: s.pane.windowName,
      path: s.pane.path,
      git: s.git,
    })),
    null,
    2,
  );
}

export const CLEAR_SCREEN = "\x1b[2J\x1b[H";

export function summaryLine(statuses: AgentStatus[]): string {
  const counts = { blocked: 0, working: 0, idle: 0, unknown: 0 };
  for (const s of statuses) counts[s.state]++;
  const sessions = new Set(statuses.map((s) => s.pane.sessionName)).size;
  return dim(
    `${statuses.length} agent(s) across ${sessions} session(s) — ` +
      `${counts.blocked} blocked, ${counts.working} working, ${counts.idle} idle`,
  );
}
