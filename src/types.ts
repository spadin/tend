// Core data model. The whole detection system is data, not code: manifests
// describe how to recognize an agent and how to read its state off the rendered
// terminal.

export type AgentState = "blocked" | "working" | "idle" | "unknown";

// Which slice of the captured pane text a rule looks at. See src/regions.ts for
// the region extractor implementations.
export type Region =
  | "full" // the entire capture
  | "after_last_horizontal_rule" // everything below the last ─── rule (the live area)
  | "prompt_box_body" // the interior of the input box (between its top/bottom borders)
  | { bottom_non_empty_lines: number }; // the last N non-blank lines

export interface Rule {
  id: string;
  state: AgentState;
  priority: number; // highest matching rule wins
  region: Region;
  contains?: string[]; // ALL of these substrings must be present (case-insensitive)
  anyContains?: string[]; // AT LEAST ONE of these must be present
  regex?: string; // regex (multiline, case-insensitive) that must match
  not?: string[]; // NONE of these substrings may be present
  // When true and this rule matches, hold the previously-known state instead of
  // overwriting it. Used for scrollback / transcript / menu screens that don't
  // reflect live agent state.
  skipStateUpdate?: boolean;
}

export interface Manifest {
  agent: string; // display name, e.g. "claude"
  // pane_current_command values that identify this agent directly (fast path).
  match: string[];
  // Regex matched against pane_current_command. Claude Code renames its own
  // process comm to its version string (e.g. "2.1.200"), so the literal name
  // "claude" never appears — a semver pattern catches it. This is the most
  // reliable signal because it's available regardless of what's scrolled into
  // view, unlike screen signatures.
  commandPattern?: string;
  // Substrings that identify the agent from the *screen*, used when the process
  // name is generic (e.g. Claude launched as `node`). These must be strings the
  // agent keeps on screen in ANY state — persistent footer/chrome, not the
  // welcome banner (which scrolls away mid-conversation).
  signature: string[];
  rules: Rule[];
}

export interface PaneInfo {
  id: string; // tmux pane id, e.g. "%3"
  command: string; // #{pane_current_command}
  pid: number; // #{pane_pid}
  path: string; // #{pane_current_path}
  title: string; // #{pane_title}
  sessionName: string; // #{session_name}
  windowName: string; // #{window_name}
  windowIndex: string; // #{window_index}
  active: boolean;
}

export interface GitStatus {
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

export interface AgentStatus {
  pane: PaneInfo;
  agent: string;
  state: AgentState;
  matchedRule: string | null;
  git: GitStatus | null;
}
