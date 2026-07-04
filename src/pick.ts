// Interactive live dashboard: a grouped list of agents across all tmux sessions
// that re-scans on an interval AND lets you act on it. Arrow keys (or j/k) move
// the cursor; Enter jumps to that pane; o cycles where the jump opens; r
// refreshes; q / Esc / Ctrl-C quits.
//
// Jump target: by default Enter opens the agent in *this* window (the one the
// dashboard runs in), keeping the dashboard alive in its own pane. Press `o` to
// cycle the target to another attached client (another terminal window), so you
// can watch here and open blocked agents over there — the dashboard never moves.
// (When targeting this window from a plain terminal — not inside tmux — jumping
// means `tmux attach`, which takes over the terminal, so there we exit.)

import { scan, type ScanOptions } from "./scan.ts";
import { insideTmux, jumpToPane, listClients, selfClientTty, type TmuxClient } from "./nav.ts";
import { agentRow, bold, dim, groupBySession, summaryLine } from "./render.ts";
import type { PaneMemory } from "./detect.ts";
import type { AgentStatus } from "./types.ts";

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CURSOR_HOME = "\x1b[H"; // move to top-left without clearing (no flicker)
const CLEAR_EOL = "\x1b[K"; // erase from cursor to end of *line*
const CLEAR_BELOW = "\x1b[J"; // erase from cursor to end of screen
const ANIM_MS = 90; // spinner tick — faster than the scan interval

const shortTty = (tty: string) => tty.replace(/^\/dev\//, "");

export async function runPicker(
  opts: ScanOptions,
  intervalMs: number,
  initialTarget?: string,
  exitOnJump = false, // --popup: end the session after a jump so the popup closes
): Promise<void> {
  let statuses: AgentStatus[] = [];
  let memory = new Map<string, PaneMemory>();
  let cursorPaneId: string | null = null; // track selection by id across rescans
  let clients: TmuxClient[] = [];
  let targetTty: string | null = initialTarget ?? null; // null = this window
  let selfTty: string | null = null;
  let done = false;
  let statusMsg = ""; // transient line (e.g. "sent … to …")
  let frame = 0; // spinner animation frame
  let timer: ReturnType<typeof setInterval> | undefined;
  let animTimer: ReturnType<typeof setInterval> | undefined;

  const out = process.stdout;
  const input = process.stdin;

  // Flattened, display-ordered list of selectable agent rows (grouped order).
  const selectable = (): AgentStatus[] => groupBySession(statuses).flatMap((g) => g.agents);
  const otherClients = (): TmuxClient[] => clients.filter((c) => c.tty !== selfTty);

  const currentIndex = (): number => {
    const list = selectable();
    if (list.length === 0) return -1;
    const i = list.findIndex((s) => s.pane.id === cursorPaneId);
    return i >= 0 ? i : 0;
  };

  const moveCursor = (delta: number) => {
    const list = selectable();
    if (list.length === 0) return;
    const next = Math.min(list.length - 1, Math.max(0, currentIndex() + delta));
    cursorPaneId = list[next]!.pane.id;
    statusMsg = ""; // clear the note once you start moving again
  };

  // Cycle the jump target: this window → each other client → back.
  const cycleTarget = () => {
    const others = otherClients();
    if (others.length === 0) {
      // Nothing to target — tell the user how to get a second window instead of
      // silently doing nothing.
      statusMsg =
        clients.length <= 1
          ? "no other tmux client — run `tmux attach` in another terminal window"
          : "no other client detected (couldn't tell this window apart)";
      render();
      return;
    }
    const cycle: Array<string | null> = [null, ...others.map((c) => c.tty)];
    let idx = cycle.indexOf(targetTty);
    if (idx < 0) idx = 0;
    targetTty = cycle[(idx + 1) % cycle.length] ?? null;
    statusMsg = "";
    render();
  };

  const targetLabel = (): string => {
    if (!targetTty) return "this window";
    const c = clients.find((x) => x.tty === targetTty);
    return shortTty(targetTty) + (c ? ` · ${c.session}` : "");
  };

  const render = () => {
    const groups = groupBySession(statuses);
    const selectedId = selectable()[currentIndex()]?.pane.id ?? null;
    const others = otherClients().length;
    const lines: string[] = [];
    lines.push(
      bold("tend") + dim("  ↑/↓ move · enter jump · o target · r refresh · q quit"),
    );
    // Show where Enter opens, plus how many other windows are available to target.
    const windowsNote = others > 0 ? `  (${others} other window${others > 1 ? "s" : ""})` : "";
    lines.push(dim(`opens in: ${targetLabel()}${windowsNote}`) + (statusMsg ? dim(`   ${statusMsg}`) : ""));
    if (groups.length === 0) {
      lines.push(dim("No AI agents detected in any tmux session."));
    } else {
      for (const { session, agents } of groups) {
        const blocked = agents.filter((a) => a.state === "blocked").length;
        const suffix = blocked ? `  \x1b[31m· ${blocked} blocked\x1b[0m` : "";
        lines.push(bold(`▸ ${session}`) + dim(`  (${agents.length})`) + suffix);
        for (const a of agents) {
          lines.push(agentRow(a, a.pane.id === selectedId, frame));
        }
        lines.push("");
      }
    }
    lines.push(summaryLine(statuses));
    // Home + overwrite, erasing each line's tail (CLEAR_EOL) so a line that got
    // shorter doesn't leave ghost text (e.g. a stale "· 1 blocked" suffix), plus
    // CLEAR_BELOW for when this frame has fewer lines. No full-screen wipe, so
    // the ~90ms spinner repaints stay flicker-free.
    out.write(CURSOR_HOME + lines.map((l) => l + CLEAR_EOL).join("\n") + "\n" + CLEAR_BELOW);
  };

  const refresh = async () => {
    const result = await scan(opts, memory);
    memory = result.memory;
    statuses = result.statuses;
    clients = await listClients();
    // If our chosen target client went away, fall back to this window.
    if (targetTty && !clients.some((c) => c.tty === targetTty)) targetTty = null;
    if (cursorPaneId === null) cursorPaneId = selectable()[0]?.pane.id ?? null;
    if (!done) render();
  };

  const cleanup = () => {
    if (timer) clearInterval(timer);
    if (animTimer) clearInterval(animTimer);
    input.setRawMode?.(false);
    input.pause();
    input.removeListener("data", onKey);
    out.write(SHOW_CURSOR + ALT_OFF);
  };

  // Tear down and exit after a jump that has already completed (the switch-client
  // paths). Used in --popup mode so `display-popup -E` closes onto the agent.
  const finishAfterJump = () => {
    done = true;
    cleanup();
    process.exit(0);
  };

  const jump = async () => {
    const target = selectable()[currentIndex()];
    if (!target) return;

    // Targeting another client: move that window, keep the dashboard put.
    if (targetTty) {
      try {
        await jumpToPane(target.pane, { client: targetTty });
        if (exitOnJump) finishAfterJump();
        statusMsg = `→ sent ${target.agent} (${target.pane.id}) to ${shortTty(targetTty)}`;
      } catch {
        statusMsg = `⚠ ${shortTty(targetTty)} unavailable`;
      }
      render();
      return;
    }

    // Targeting this window, inside tmux: switch our client. Normally we keep the
    // dashboard alive in its own pane; in --popup mode we exit so the popup closes
    // onto the agent instead of lingering on top of it.
    if (insideTmux()) {
      await jumpToPane(target.pane);
      if (exitOnJump) finishAfterJump();
      statusMsg = `→ jumped to ${target.agent} in ${target.pane.sessionName} (${target.pane.id})`;
      render();
      return;
    }

    // This window, outside tmux: attach takes over the terminal → tear down.
    done = true;
    cleanup();
    await jumpToPane(target.pane);
    process.exit(0);
  };

  function onKey(buf: Buffer) {
    const key = buf.toString("utf8");
    if (key === "\x03" || key === "q" || key === "\x1b") {
      done = true;
      cleanup();
      process.exit(0);
    } else if (key === "\r" || key === "\n") {
      void jump();
    } else if (key === "\x1b[A" || key === "k") {
      moveCursor(-1);
      render();
    } else if (key === "\x1b[B" || key === "j") {
      moveCursor(1);
      render();
    } else if (key === "o" || key === "\t") {
      cycleTarget();
    } else if (key === "r") {
      void refresh();
    }
  }

  // Setup terminal. We only have a "self" client to exclude when we're actually
  // running inside a tmux client; from a plain terminal every attached client is
  // a legitimate target (and tmux would otherwise report one of them as "self").
  selfTty = insideTmux() ? await selfClientTty() : null;
  out.write(ALT_ON + HIDE_CURSOR);
  input.setRawMode?.(true);
  input.resume();
  input.setEncoding?.("utf8");
  input.on("data", onKey);
  process.on("SIGINT", () => {
    done = true;
    cleanup();
    process.exit(0);
  });

  await refresh();
  timer = setInterval(() => void refresh(), intervalMs);
  // Advance the spinner only while something is working, so an all-idle board
  // stays quiet (no needless repaints).
  animTimer = setInterval(() => {
    if (done || !statuses.some((s) => s.state === "working")) return;
    frame++;
    render();
  }, ANIM_MS);
}
