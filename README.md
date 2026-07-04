# tend

Status of the AI coding agents running inside your **tmux** session — at a glance.

`tend` scans your tmux panes, figures out which ones are AI agents (Claude
Code, Codex, …), and reports whether each is **blocked** (waiting on you),
**working**, or **idle** — plus the git branch state of each pane's directory.

It's small and focused: it does **not** multiplex, split panes, manage windows,
or persist sessions — tmux already does all of that. It answers one question:
*what are my agents doing right now?*

A state glyph carries each agent's state — shape *and* color, so it reads even
without color: **`●` red = blocked**, **`⠧` yellow (animated spinner) = working**,
**`○` green = idle**, `◌` grey = unknown.

```
▸ api  (1)
  ● %1    claude    feature/x ↑2 ✱
▸ web  (2)
  ⠧ %5    claude    main
  ○ %0    codex     main ✱
3 agent(s) across 2 session(s) — 1 blocked, 1 working, 1 idle
```

## Install

`tend` needs **tmux** and **Node ≥ 20**. Install it from npm:

```sh
npm install -g @sandropadin/tend    # global — puts `tend` on your PATH
# or run it without installing:
npx @sandropadin/tend
```

**From source** (to hack on it) — Node ≥ 22.18 runs the TypeScript directly, no
build step:

```sh
git clone https://github.com/spadin/tend.git && cd tend
npm install          # dev-only deps (types); the tool itself is stdlib-only
node src/index.ts    # run it, or `npm link` to put `tend` on your PATH
```

## Usage

By default it scans **every tmux session** and groups agents by session:

```sh
tend                 # live, selectable dashboard (default in a terminal)
tend --once          # print a grouped snapshot and exit
tend jump %3         # jump straight to a pane id
tend jump %3 --to T  # open pane %3 in another window (client tty T)
tend clients         # list attached tmux clients (terminal windows)
tend --json          # machine-readable snapshot (for status bars, scripts)
tend --current       # limit to the current session only
tend --readonly      # dashboard without selection (display-only pane)
tend --debug %3      # dump what each region extractor sees, for rule tuning
```

Bare `tend` opens the dashboard when run in a terminal, but **falls back to a
one-off snapshot when its output is piped or redirected** — so `tend | grep`
and `tend > file` still behave like a snapshot. `--json` and `--once` always
snapshot.

Options: `--interval <ms>` (dashboard refresh, default 800), `--once-delay <ms>`
(snapshot activity-sampling window, default 350).

### The dashboard

`tend` (or `tend watch`) is a live, grouped list of every agent across every
session — and it's **selectable**, so it doubles as a navigator: monitor and
jump in one surface.

```
tend  ↑/↓ move · enter jump · o target · r refresh · q quit
opens in: this window

▸ alpha  (1)
❯ ⠹ %1    claude    main ✱
▸ beta  (2)  · 1 blocked
  ● %2    claude    main ✱
  ○ %3    claude    main ✱
```

The glyph shape + color carries the state (`●` red blocked, `⠹` yellow working —
an animated spinner, `○` green idle), so you never need the word.

- **↑/↓** (or `j`/`k`) move the cursor over agents, **Enter** jumps to that pane,
  **r** refreshes, **q**/**Esc**/**Ctrl-C** quits. It re-scans on an interval so
  states stay current.
- **Jumping keeps the dashboard alive.** Inside tmux, Enter `switch-client`s your
  attached client to the agent's pane but leaves the monitor running in its own
  pane — a persistent surface you can switch back to, not a one-shot chooser.
  (Outside tmux, jumping means `tmux attach`, which takes over the terminal, so
  there it exits when you detach.)
- `--readonly` (or piping the output) gives the old non-interactive repaint, for
  a display-only status pane.
- `tend jump %3` jumps non-interactively — handy to bind to a tmux key.

### Opening agents in another window

Run the dashboard in one terminal window and keep a second window for actually
working — then open blocked agents *over there* while the dashboard stays put.
This works because tmux is client-server: each terminal window that attaches is a
separate **client**, and tend can move a specific one.

> **The second window must be an attached tmux client on the same server.** In
> that other terminal, run `tmux attach` (or `tmux new -s scratch`). A plain
> shell that isn't running tmux — or one attached to a different socket
> (`tmux -L`/`-S …`) — is not a client and won't appear as a target. Check with
> `tend clients`: if it lists only one line, `o` has nowhere to go.

- In the dashboard, press **`o`** to cycle where Enter opens the agent: **this
  window → each other attached client → back**. The header shows the current
  target (`opens in: ttys023 · scratch`). Pick a blocked agent, hit Enter, and it
  opens in that other window while the dashboard never moves.
- `tend clients` lists the attached windows (their ttys and current sessions),
  marking the current one.
- Preset the target instead of cycling: `--other` (the one other attached client)
  or `--to <tty>` (a specific one). Works for both the dashboard and
  `tend jump %3 --to /dev/ttys023`.

So the setup you'd use: `tend` in window A (your monitor), a plain shell or
scratch tmux session in window B. Watch A, press `o` once to aim at B, and every
Enter sends the selected agent to B.

### tmux status-bar integration

```tmux
set -g status-right "#(cd #{pane_current_path} && tend --json | jq -r '...')"
```

Or bind a key to a quick popup dashboard — `--popup` makes it exit after you
pick an agent, so the popup closes and drops you onto that pane:

```tmux
bind-key g display-popup -E "tend --popup"
```

## How it works

Two signals, arbitrated:

1. **Which agent is in a pane** — tmux's `#{pane_current_command}` gives the
   foreground process name. Note Claude Code renames its process to its **version
   string**
   (e.g. `2.1.200`), so we match a semver `commandPattern`, not the literal
   name. This is the most reliable signal because it's present no matter what's
   scrolled into view. If the command is generic (`node`), we fall back to a
   **screen signature** — persistent footer chrome (`shift+tab to cycle`,
   `esc to interrupt`), not the welcome banner, which scrolls away.

2. **What state it's in** — we `capture-pane` the rendered screen and run
   declarative **manifest rules** (see [`src/manifests.ts`](src/manifests.ts))
   against slices of it. Highest-priority matching rule wins.

Arbitration (in [`src/detect.ts`](src/detect.ts)):

- **blocked** comes from the screen and is *strong* — it wins immediately. It's
  deliberately strict (only a positive match of a known approval UI) so you
  don't get false "needs you" alarms; everything unmatched falls back to idle.
- **working** comes from **activity** — the pane's content changed since the
  last look (we diff `capture-pane` snapshots). A visible "esc to interrupt"
  hint is a secondary signal.
- **idle** is debounced: it must persist across two reads, so a single quiet
  frame mid-task doesn't flap the status.
- Scrollback / model-picker / transcript screens are recognized and **hold** the
  previous state instead of authoring a bogus one.

Git facts come from shelling out to the real `git` binary (no libgit2), memoized
per repo root within each scan so N panes in one repo cost one set of calls.

## Tuning the rules

The detection is **data, not code**. Each
rule is `{ id, state, priority, region, contains?, anyContains?, regex?, not? }`.
When an agent's TUI changes, or you add a new agent, edit
[`src/manifests.ts`](src/manifests.ts) — no engine changes needed.

Workflow: run `tend --debug <pane>` against a live agent pane. It prints the
text each region extractor (`full`, `after_last_horizontal_rule`,
`prompt_box_body`, `bottom_non_empty_lines`) pulls out, and marks which rules
match. Adjust patterns until the ✓ marks line up with reality.

The shipped Claude/Codex rules are a **starting point** — TUIs vary by version,
so expect to tune them against your own agents.

## Layout

| File | Role |
|------|------|
| `src/types.ts` | Data model (states, rules, manifests) |
| `src/regions.ts` | Region extractors — pure string slicers |
| `src/manifests.ts` | **The rules you tune** — per-agent detection patterns |
| `src/tmux.ts` | tmux glue (`list-panes`, `capture-pane`, switch/select) |
| `src/git.ts` | Git status via the `git` binary, cached per repo |
| `src/detect.ts` | The engine: identify agent + arbitrate state |
| `src/scan.ts` | One detection pass over all panes (shared by all modes) |
| `src/nav.ts` | Jump to a pane (switch-client inside tmux / attach outside) |
| `src/render.ts` | Grouped / JSON output |
| `src/pick.ts` | Interactive selectable dashboard (raw-mode TUI) |
| `src/index.ts` | CLI (once / watch / jump / debug) |

## License

MIT — see [LICENSE](LICENSE). All original code; use it however you like.
