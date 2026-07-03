// The detection engine: identify the agent in a pane, then resolve its state by
// arbitrating three signals:
//   1. blocked/idle come from the screen (manifest rules),
//   2. working comes from PTY activity (content changed since last tick),
//   3. skipStateUpdate screens (scrollback/menus) hold the previous state.
// Blocked is strong and wins; otherwise activity beats a stale idle read; idle
// is debounced so a quiet frame mid-task doesn't flap the status.

import { extractRegion } from "./regions.ts";
import { manifestFor, MANIFESTS } from "./manifests.ts";
import type { AgentState, Manifest, PaneInfo, Rule } from "./types.ts";

export function identifyAgent(pane: PaneInfo, captureText: string): string | null {
  const cmd = pane.command.toLowerCase();
  // 1. Exact / substring command-name match (e.g. comm is literally "claude").
  for (const m of MANIFESTS) {
    if (m.match.some((name) => cmd === name || cmd.includes(name))) return m.agent;
  }
  // 2. Command-pattern match — catches Claude Code, whose comm is its version
  //    string (e.g. "2.1.200"). Most reliable: independent of screen scroll.
  for (const m of MANIFESTS) {
    if (m.commandPattern && new RegExp(m.commandPattern).test(pane.command)) {
      return m.agent;
    }
  }
  // 3. Screen signature — for agents launched under a generic comm (node/python)
  //    whose version-rename doesn't apply. Matches persistent on-screen chrome.
  const hay = captureText.toLowerCase();
  for (const m of MANIFESTS) {
    if (m.signature.some((sig) => hay.includes(sig.toLowerCase()))) return m.agent;
  }
  return null;
}

function ruleMatches(rule: Rule, regionText: string): boolean {
  const hay = regionText.toLowerCase();
  if (rule.contains && !rule.contains.every((s) => hay.includes(s.toLowerCase()))) {
    return false;
  }
  if (rule.anyContains && !rule.anyContains.some((s) => hay.includes(s.toLowerCase()))) {
    return false;
  }
  if (rule.not && rule.not.some((s) => hay.includes(s.toLowerCase()))) {
    return false;
  }
  if (rule.regex) {
    const re = new RegExp(rule.regex, "im");
    if (!re.test(regionText)) return false;
  }
  return true;
}

interface RuleVerdict {
  state: AgentState;
  ruleId: string | null;
  hold: boolean; // skipStateUpdate matched — keep previous state
}

// Evaluate the manifest against captured lines; highest-priority match wins.
function evaluateRules(manifest: Manifest, lines: string[]): RuleVerdict {
  const sorted = [...manifest.rules].sort((a, b) => b.priority - a.priority);
  for (const rule of sorted) {
    const regionText = extractRegion(lines, rule.region);
    if (ruleMatches(rule, regionText)) {
      return { state: rule.state, ruleId: rule.id, hold: rule.skipStateUpdate === true };
    }
  }
  return { state: "unknown", ruleId: null, hold: false };
}

// Per-pane memory the watcher threads across ticks. Fire-once mode simulates it
// by sampling a pane twice with a short delay (see collectOnce).
export interface PaneMemory {
  lastCaptureHash: string;
  lastState: AgentState;
  pendingIdle: boolean; // idle seen once; require a second read before committing
}

export interface Resolution {
  agent: string;
  state: AgentState;
  matchedRule: string | null;
  memory: PaneMemory;
}

function hashLines(lines: string[]): string {
  // Cheap content fingerprint — we only need "did it change", not crypto.
  let h = 0;
  const s = lines.join("\n");
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return `${s.length}:${h}`;
}

export function resolveState(
  pane: PaneInfo,
  lines: string[],
  prev: PaneMemory | undefined,
): Resolution | null {
  const captureText = lines.join("\n");
  const agent = identifyAgent(pane, captureText);
  if (agent === null) return null;

  const manifest = manifestFor(agent);
  const verdict = manifest
    ? evaluateRules(manifest, lines)
    : { state: "unknown" as AgentState, ruleId: null, hold: false };

  const hash = hashLines(lines);
  const changed = prev !== undefined && prev.lastCaptureHash !== hash;
  const previousState: AgentState = prev?.lastState ?? "unknown";

  let state: AgentState;
  let pendingIdle = false;

  // "blocked" must be earned by an active match every scan — never inherited.
  // Holding it (on scrollback or an ambiguous frame) is exactly what keeps a
  // stale "1 blocked" on the board after you've answered the prompt.
  const keep = (prevState: AgentState): AgentState =>
    prevState === "unknown" || prevState === "blocked" ? "idle" : prevState;

  if (verdict.hold) {
    // Scrollback / menu screen: don't author state, keep what we had.
    state = keep(previousState);
  } else if (verdict.state === "blocked") {
    state = "blocked"; // strong signal, wins immediately
  } else if (changed) {
    state = "working"; // PTY activity is the authority for "working"
  } else if (verdict.state === "working") {
    state = "working"; // explicit interrupt-hint on screen
  } else if (verdict.state === "idle") {
    // Debounce: require idle to persist for two reads before committing, so a
    // single quiet frame between output bursts doesn't flip us to idle.
    if (previousState === "working" && prev?.pendingIdle !== true) {
      state = "working";
      pendingIdle = true;
    } else {
      state = "idle";
    }
  } else {
    // Known agent, nothing matched: fall back without inheriting a stale block.
    state = keep(previousState);
  }

  return {
    agent,
    state,
    matchedRule: verdict.ruleId,
    memory: { lastCaptureHash: hash, lastState: state, pendingIdle },
  };
}
