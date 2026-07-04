#!/usr/bin/env node
// tend — status of AI coding agents across your tmux sessions.
//
//   tend                 list agents grouped by session (all sessions) once
//   tend watch           live-updating grouped list
//   tend pick            interactive picker — select an agent and jump to it
//   tend jump <pane>     jump straight to a pane id (e.g. jump %3)
//   tend --json          machine-readable output (once)
//   tend --current       limit to the current session (default: all sessions)
//   tend --debug <pane>  dump each region's extracted text, for rule tuning
//
// Flags: --interval <ms> (watch/pick refresh, default 800),
//        --once-delay <ms> (fire-once activity sampling window, default 350).

import { capturePane, listClients, listPanes, selfClientTty } from "./tmux.ts";
import { identifyAgent } from "./detect.ts";
import { extractRegion } from "./regions.ts";
import { manifestFor } from "./manifests.ts";
import { scan, scanOnce, type ScanOptions } from "./scan.ts";
import { runPicker } from "./pick.ts";
import { insideTmux, jumpToPane } from "./nav.ts";
import type { PaneMemory } from "./detect.ts";
import {
  CLEAR_SCREEN,
  dim,
  renderGrouped,
  renderJson,
  summaryLine,
} from "./render.ts";

interface Options {
  // "default" = dashboard in a terminal, snapshot when piped. "watch" = the
  // dashboard, explicitly requested (repaints even when piped).
  mode: "default" | "watch" | "jump" | "debug" | "clients";
  json: boolean;
  all: boolean;
  once: boolean; // force a one-off snapshot even on an interactive terminal
  readonly: boolean;
  interval: number;
  onceDelay: number;
  target?: string; // pane id for jump/debug
  targetClient?: string; // --to <tty>: open jumps in this client (window)
  other: boolean; // --other: open jumps in the one other attached client
  popup: boolean; // --popup: dashboard exits after a jump (for tmux display-popup)
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    mode: "default",
    json: false,
    all: true, // scan every session by default (global view across all sessions)
    once: false,
    readonly: false,
    interval: 800,
    onceDelay: 350,
    other: false,
    popup: false,
  };
  const args = [...argv];
  while (args.length) {
    const a = args.shift()!;
    switch (a) {
      case "watch":
      case "pick": // alias — watch is the selectable dashboard
      case "select":
        opts.mode = "watch";
        break;
      case "clients":
        opts.mode = "clients";
        break;
      case "--once":
      case "ls":
        opts.once = true;
        break;
      case "--readonly":
        opts.readonly = true;
        break;
      case "--to":
        opts.targetClient = args.shift();
        break;
      case "--other":
        opts.other = true;
        break;
      case "--popup":
        opts.popup = true;
        break;
      case "jump":
        opts.mode = "jump";
        opts.target = args.shift();
        break;
      case "--debug":
        opts.mode = "debug";
        opts.target = args.shift();
        break;
      case "--json":
        opts.json = true;
        break;
      case "--current":
      case "-s":
        opts.all = false;
        break;
      case "--all":
      case "-a":
        opts.all = true;
        break;
      case "--interval":
        opts.interval = Number(args.shift()) || opts.interval;
        break;
      case "--once-delay":
        opts.onceDelay = Number(args.shift()) || opts.onceDelay;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        process.stderr.write(`tend: unknown argument "${a}"\n`);
        process.exit(2);
    }
  }
  return opts;
}

function printHelp(): void {
  process.stdout.write(
    [
      "tend — status of AI coding agents across your tmux sessions",
      "",
      "Usage:",
      "  tend                 live, selectable dashboard — ↑/↓ move, enter jumps",
      "                         (falls back to a one-off snapshot when piped)",
      "  tend --once          print a grouped snapshot and exit",
      "  tend jump <pane>     jump to a pane id (e.g. jump %3)",
      "  tend clients         list attached tmux clients (terminal windows)",
      "  tend --json          machine-readable snapshot",
      "  tend --current       limit to the current session",
      "  tend --readonly      dashboard without selection (display-only pane)",
      "  tend --debug <pane>  dump extracted regions for a pane (rule tuning)",
      "",
      "Open jumps in another window (keep the dashboard put):",
      "  In the dashboard, press `o` to cycle where Enter opens: this window →",
      "  each other attached client → back. Or preset it:",
      "  --to <tty>         open jumps in that client (see `tend clients`)",
      "  --other            open jumps in the one other attached client",
      "",
      "Options:",
      "  --popup            exit the dashboard after a jump — for tmux display-popup",
      "  --interval <ms>    dashboard refresh interval (default 800)",
      "  --once-delay <ms>  activity sampling window for --once (default 350)",
      "",
    ].join("\n"),
  );
}

const scanOpts = (o: Options): ScanOptions => ({ all: o.all });

async function runOnce(opts: Options): Promise<void> {
  const statuses = await scanOnce(scanOpts(opts), opts.onceDelay);
  if (opts.json) {
    process.stdout.write(renderJson(statuses) + "\n");
  } else {
    process.stdout.write(renderGrouped(statuses) + "\n\n" + summaryLine(statuses) + "\n");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runWatch(opts: Options): Promise<void> {
  let memory = new Map<string, PaneMemory>();
  process.on("SIGINT", () => {
    process.stdout.write("\x1b[?25h\n");
    process.exit(0);
  });
  process.stdout.write("\x1b[?25l"); // hide cursor
  let frame = 0;
  for (;;) {
    const result = await scan(scanOpts(opts), memory);
    memory = result.memory;
    const header = new Date().toLocaleTimeString();
    process.stdout.write(
      CLEAR_SCREEN +
        `tend · ${header}\n\n` +
        renderGrouped(result.statuses, frame++) +
        "\n\n" +
        summaryLine(result.statuses) +
        "\n" +
        dim("Ctrl-C to exit") +
        "\n",
    );
    await sleep(opts.interval);
  }
}

// Resolve which client (window) a jump should open in, from --to / --other.
// Returns a client tty, or null to use the current window. Exits with guidance
// when --other is ambiguous.
async function resolveTargetClient(opts: Options): Promise<string | null> {
  if (opts.targetClient) return opts.targetClient;
  if (!opts.other) return null;
  const clients = await listClients();
  const self = insideTmux() ? await selfClientTty() : null;
  const others = clients.filter((c) => c.tty !== self);
  if (others.length === 1) return others[0]!.tty;
  if (others.length === 0) {
    process.stderr.write("tend: --other found no other attached client.\n");
    process.exit(1);
  }
  process.stderr.write(
    "tend: --other is ambiguous — multiple other clients attached:\n" +
      others.map((c) => `  ${c.tty}  (${c.session})`).join("\n") +
      "\nPick one with --to <tty>.\n",
  );
  process.exit(1);
}

async function runClients(): Promise<void> {
  const clients = await listClients();
  const self = insideTmux() ? await selfClientTty() : null;
  if (clients.length === 0) {
    process.stdout.write(dim("No tmux clients attached.\n"));
    return;
  }
  for (const c of clients) {
    const mark = c.tty === self ? dim(" (this window)") : "";
    process.stdout.write(`${c.tty}  → ${c.session}${mark}\n`);
  }
}

async function runJump(opts: Options): Promise<void> {
  const target = opts.target;
  if (!target) {
    process.stderr.write("tend jump requires a pane id, e.g. jump %3\n");
    process.exit(2);
  }
  const wanted = target.startsWith("%") ? target : `%${target}`;
  const panes = await listPanes({ all: true });
  const pane = panes.find((p) => p.id === wanted);
  if (!pane) {
    process.stderr.write(`tend: pane "${target}" not found\n`);
    process.exit(1);
  }
  const client = await resolveTargetClient(opts);
  await jumpToPane(pane, client ? { client } : {});
  const where = client ? `${client}` : `${pane.sessionName} (${pane.id})`;
  process.stdout.write(dim(`→ ${where}\n`));
}

// Debug: show what each region extractor pulls from a pane so you can see why a
// rule did or didn't match, then iterate on manifests.ts.
async function runDebug(opts: Options): Promise<void> {
  const target = opts.target;
  if (!target) {
    process.stderr.write("tend --debug requires a pane id, e.g. --debug %3\n");
    process.exit(2);
  }
  const wanted = target.startsWith("%") ? target : `%${target}`;
  const panes = await listPanes({ all: true });
  const pane = panes.find((p) => p.id === wanted);
  if (!pane) {
    process.stderr.write(`tend: pane "${target}" not found\n`);
    process.exit(1);
  }
  const lines = await capturePane(pane.id);
  const agent = identifyAgent(pane, lines.join("\n"));
  process.stdout.write(
    `pane ${pane.id}  command=${pane.command}  agent=${agent ?? "(none)"}\n`,
  );
  const regions = [
    "full",
    "after_last_horizontal_rule",
    "prompt_box_body",
    { bottom_non_empty_lines: 6 },
  ] as const;
  for (const region of regions) {
    const label = typeof region === "object" ? "bottom_non_empty_lines(6)" : region;
    process.stdout.write(`\n\x1b[1m── region: ${label} ──\x1b[0m\n`);
    process.stdout.write(extractRegion(lines, region) + "\n");
  }
  if (agent) {
    const manifest = manifestFor(agent);
    process.stdout.write(`\n\x1b[1m── manifest rules for ${agent} ──\x1b[0m\n`);
    for (const rule of manifest?.rules ?? []) {
      const regionText = extractRegion(lines, rule.region);
      const matched = ruleWouldMatch(rule, regionText);
      const mark = matched ? "\x1b[32m✓\x1b[0m" : "\x1b[90m·\x1b[0m";
      process.stdout.write(`  ${mark} [${rule.priority}] ${rule.id} → ${rule.state}\n`);
    }
  }
}

// Small duplicate of the engine's predicate, kept here so --debug has no need to
// export internals. If you change ruleMatches in detect.ts, mirror it here.
function ruleWouldMatch(
  rule: { contains?: string[]; anyContains?: string[]; not?: string[]; regex?: string },
  regionText: string,
): boolean {
  const hay = regionText.toLowerCase();
  if (rule.contains && !rule.contains.every((s) => hay.includes(s.toLowerCase()))) return false;
  if (rule.anyContains && !rule.anyContains.some((s) => hay.includes(s.toLowerCase()))) return false;
  if (rule.not && rule.not.some((s) => hay.includes(s.toLowerCase()))) return false;
  if (rule.regex && !new RegExp(rule.regex, "im").test(regionText)) return false;
  return true;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  switch (opts.mode) {
    case "default":
    case "watch": {
      // A snapshot is forced by --json / --once, and is also the right default
      // when output is piped (so `tend | grep` and `tend > file` behave).
      if (opts.json || opts.once) {
        await runOnce(opts);
        break;
      }
      const interactiveTty =
        process.stdin.isTTY === true && process.stdout.isTTY === true;
      if (interactiveTty && !opts.readonly) {
        // Optional preset target window from --to/--other; `o` cycles it live.
        const initialTarget =
          opts.targetClient ?? (opts.other ? await resolveTargetClient(opts) : null);
        await runPicker(scanOpts(opts), opts.interval, initialTarget ?? undefined, opts.popup);
      } else if (opts.readonly) {
        await runWatch(opts); // display-only repaint (explicit)
      } else if (opts.mode === "watch") {
        await runWatch(opts); // `tend watch` piped → repaint loop (explicit)
      } else {
        await runOnce(opts); // bare `tend` piped → one-off snapshot
      }
      break;
    }
    case "jump":
      await runJump(opts);
      break;
    case "clients":
      await runClients();
      break;
    case "debug":
      await runDebug(opts);
      break;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`tend: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
