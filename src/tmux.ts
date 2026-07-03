// tmux glue. tmux has already done the hard part for us: #{pane_current_command}
// is the foreground process's comm, and capture-pane hands us the rendered
// screen for free. We just ask nicely.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PaneInfo } from "./types.ts";

const exec = promisify(execFile);

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await exec("tmux", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// tmux sanitizes ANY control character in -F output (including our separator and
// even newlines) to "_", so we can't pack multiple free-text fields into one
// formatted line. Instead we query one field per call, each paired with the
// pane id. pane_id is always "%<digits>" — it can't contain the "|" delimiter or
// a newline — so we split once on the first "|" and the value may then contain
// anything (spaces, "|", unicode) without ambiguity. Keying the merge by id
// makes it robust to the pane set changing between calls.
async function column(
  scope: string[],
  field: string,
): Promise<Array<[string, string]>> {
  const stdout = await tmux(["list-panes", ...scope, "-F", `#{pane_id}|${field}`]);
  const rows: Array<[string, string]> = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const i = line.indexOf("|");
    if (i < 0) continue;
    rows.push([line.slice(0, i), line.slice(i + 1)]);
  }
  return rows;
}

export async function isServerRunning(): Promise<boolean> {
  try {
    await tmux(["list-panes", "-a"]);
    return true;
  } catch {
    return false;
  }
}

// Enumerate panes. Scope defaults to the current session when run inside tmux,
// or all sessions with `all: true` (or when run outside tmux).
export async function listPanes(opts: { all: boolean }): Promise<PaneInfo[]> {
  const insideTmux = Boolean(process.env.TMUX);
  const scope = opts.all || !insideTmux ? ["-a"] : ["-s"];

  const [commands, pids, paths, titles, sessions, windows, windowIdx, actives] =
    await Promise.all([
      column(scope, "#{pane_current_command}"),
      column(scope, "#{pane_pid}"),
      column(scope, "#{pane_current_path}"),
      column(scope, "#{pane_title}"),
      column(scope, "#{session_name}"),
      column(scope, "#{window_name}"),
      column(scope, "#{window_index}"),
      column(scope, "#{pane_active}"),
    ]);

  // Seed one PaneInfo per id from the first column, then fill from the rest.
  // Keyed by id, so a pane appearing/vanishing mid-scan can't misalign fields.
  const byId = new Map<string, PaneInfo>();
  for (const [id] of commands) {
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        command: "",
        pid: 0,
        path: "",
        title: "",
        sessionName: "",
        windowName: "",
        windowIndex: "",
        active: false,
      });
    }
  }
  const fill = (rows: Array<[string, string]>, set: (p: PaneInfo, v: string) => void) => {
    for (const [id, value] of rows) {
      const p = byId.get(id);
      if (p) set(p, value);
    }
  };
  fill(commands, (p, v) => (p.command = v));
  fill(pids, (p, v) => (p.pid = Number(v) || 0));
  fill(paths, (p, v) => (p.path = v));
  fill(titles, (p, v) => (p.title = v));
  fill(sessions, (p, v) => (p.sessionName = v));
  fill(windows, (p, v) => (p.windowName = v));
  fill(windowIdx, (p, v) => (p.windowIndex = v));
  fill(actives, (p, v) => (p.active = v === "1"));

  return [...byId.values()];
}

// Capture the visible screen of a pane as plain text lines (no escape codes).
// -p prints to stdout; trailing blank lines trimmed.
export async function capturePane(paneId: string): Promise<string[]> {
  const stdout = await tmux(["capture-pane", "-p", "-t", paneId]);
  return stdout.replace(/\n+$/, "").split("\n");
}

// Move the *currently attached* tmux client to a pane: switch its session, then
// select the window and pane. A pane id (%N) resolves up to its window/session,
// so we only need the session name for switch-client. Use when already inside
// tmux (process.env.TMUX set).
export async function switchToPane(sessionName: string, paneId: string): Promise<void> {
  await tmux(["switch-client", "-t", sessionName]);
  await tmux(["select-window", "-t", paneId]);
  await tmux(["select-pane", "-t", paneId]);
}

// Like switchToPane, but moves a *specific* client (by its tty) rather than the
// current one. This is how the dashboard in one window drives another window:
// select-window/select-pane set the agent session's active window+pane server-
// side, and switch-client -c points that other client at it.
export async function switchClientToPane(
  clientTty: string,
  sessionName: string,
  paneId: string,
): Promise<void> {
  await tmux(["switch-client", "-c", clientTty, "-t", sessionName]);
  await tmux(["select-window", "-t", paneId]);
  await tmux(["select-pane", "-t", paneId]);
}

export interface TmuxClient {
  tty: string; // client_tty, e.g. "/dev/ttys004" — the client's identity
  session: string; // session it's currently attached to
}

// All attached clients. Uses the same "id | value" split trick as listPanes to
// dodge tmux's control-character sanitization; client_tty never contains "|".
export async function listClients(): Promise<TmuxClient[]> {
  let stdout = "";
  try {
    stdout = await tmux(["list-clients", "-F", "#{client_tty}|#{client_session}"]);
  } catch {
    return [];
  }
  const clients: TmuxClient[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const i = line.indexOf("|");
    if (i < 0) continue;
    clients.push({ tty: line.slice(0, i), session: line.slice(i + 1) });
  }
  return clients;
}

// The tty of the client this process is running under (best effort). Used to
// tell "this window" apart from the others when choosing a jump target.
export async function selfClientTty(): Promise<string | null> {
  try {
    const tty = (await tmux(["display-message", "-p", "#{client_tty}"])).trim();
    return tty || null;
  } catch {
    return null;
  }
}

// Pre-select the target window/pane on the server (no client needed), so a
// subsequent `tmux attach` lands with that pane active. Use when NOT inside
// tmux — the caller then execs `tmux attach-session -t <sessionName>`.
export async function preselectPane(paneId: string): Promise<void> {
  await tmux(["select-window", "-t", paneId]);
  await tmux(["select-pane", "-t", paneId]);
}
