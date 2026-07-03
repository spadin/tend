// Agent manifests — the declarative rule sets. This is the file you tune.
//
// Detection philosophy: read what's already on the screen rather than demand
// agents speak a protocol. Each rule matches a region of the
// captured terminal; the highest-priority match wins. "blocked" is deliberately
// strict (only fires on a positive match of a known approval UI) so you don't
// get false "needs you" alarms; everything else falls back to idle.
//
// These patterns are a starting point. Run `tend --debug <pane>` against a
// live pane to see exactly what text each region extracts, then adjust.

import type { Manifest } from "./types.ts";

const claude: Manifest = {
  agent: "claude",
  match: ["claude"],
  // Claude Code renames its process comm to its version (e.g. "2.1.200"), so the
  // literal name never appears — this catches it regardless of screen state.
  commandPattern: "^\\d+\\.\\d+\\.\\d+",
  // Persistent on-screen chrome, for the rare case comm is generic (`node`).
  // These are strings Claude keeps visible in SOME state during a live session —
  // the mode footer, the shortcuts hint, the interrupt hint, the permission
  // prompt — NOT the welcome banner, which scrolls away mid-conversation.
  signature: [
    "shift+tab to cycle", // mode footer (auto/plan mode)
    "? for shortcuts", // default footer
    "esc to interrupt", // working footer
    "for agents", // "← for agents" footer
    "Do you want to proceed?", // permission prompt
    "No, and tell Claude", // permission prompt option
    "Claude Code", // welcome banner (fresh session)
  ],
  rules: [
    // Scrollback / transcript / picker screens don't reflect live state — hold.
    {
      id: "transcript_or_picker",
      state: "unknown",
      priority: 950,
      region: "full",
      anyContains: ["(END)", "Select a model", "Choose a model", "─ Transcript ─"],
      skipStateUpdate: true,
    },
    // Blocked = a *live* permission/approval prompt: the selection cursor (❯)
    // sits on a numbered choice while Claude waits for you. Keying on the live
    // cursor (not the question text) is deliberate — the cursor vanishes the
    // instant you answer, so a prompt lingering in the scroll buffer no longer
    // counts as blocked. `not` guards against a stale answered prompt whose text
    // is still on screen but whose cursor has moved on.
    {
      id: "selection_prompt",
      state: "blocked",
      priority: 900,
      region: { bottom_non_empty_lines: 15 },
      regex: "^\\s*❯\\s+\\d+\\.\\s", // e.g. "❯ 1. Yes"
      not: ["esc to interrupt"], // if it's generating, it isn't waiting on you
    },
    // Actively generating — Claude shows an interrupt hint while working.
    {
      id: "working_interrupt_hint",
      state: "working",
      priority: 700,
      region: { bottom_non_empty_lines: 8 },
      anyContains: ["esc to interrupt", "(esc to interrupt)"],
    },
    // Empty prompt box with the caret and no menu chrome = idle, awaiting input.
    {
      id: "idle_prompt",
      state: "idle",
      priority: 100,
      region: "prompt_box_body",
      regex: "^\\s*[>❯]",
      not: ["esc to interrupt", "1. Yes", "Do you want"],
    },
  ],
};

const codex: Manifest = {
  agent: "codex",
  match: ["codex"],
  signature: ["OpenAI Codex", "Codex CLI", "codex>"],
  rules: [
    {
      id: "approval_prompt",
      state: "blocked",
      priority: 900,
      region: { bottom_non_empty_lines: 20 },
      anyContains: [
        "Allow command",
        "Approve this command",
        "Run this command?",
        "wants to run",
        "Do you want to apply",
      ],
    },
    {
      id: "working_interrupt_hint",
      state: "working",
      priority: 700,
      region: { bottom_non_empty_lines: 8 },
      anyContains: ["Esc to interrupt", "esc to interrupt", "Working", "Thinking"],
    },
    {
      id: "idle_prompt",
      state: "idle",
      priority: 100,
      region: "prompt_box_body",
      regex: "^\\s*[>❯▌]",
      not: ["Esc to interrupt", "Allow command"],
    },
  ],
};

// Generic fallback for any other terminal agent: no screen rules, so its state
// comes purely from PTY activity (content changed since last tick = working).
// Add signatures/rules here as you bring more agents into the fold.
export const MANIFESTS: Manifest[] = [claude, codex];

// Ordered agent-name → manifest lookup used by the detector.
export function manifestFor(agent: string): Manifest | undefined {
  return MANIFESTS.find((m) => m.agent === agent);
}
