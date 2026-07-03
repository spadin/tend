# AGENTS.md — working on tend

Context for AI agents (and humans) modifying this repo. Read this before touching
detection, tmux glue, or the dashboard. User-facing usage lives in
[README.md](README.md); this file is the *why* and the *gotchas*.

## What this is

`tend` reports the status of AI coding agents (Claude Code, Codex, …) running
inside **tmux** panes — blocked / working / idle — grouped by session, with a
live selectable dashboard that can jump you (or another window) to an agent. It
deliberately does **not** multiplex, split, or manage windows — tmux already
does that.

## Running & dev loop

- **Local dev needs no build.** Node ≥ 22.18 runs the TypeScript directly:
  `node src/index.ts`. Don't add a bundler or a dev-time transpile step.
- **Distribution DOES need a build — don't remove it.** Node refuses to
  type-strip files under `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so an installed/published
  package can't run the raw `.ts`. `npm run build` (`tsconfig.build.json`) emits
  `dist/` with `./x.ts` import specifiers rewritten to `./x.js`; `bin` points at
  `dist/index.js`; the `prepare` hook builds it automatically on install / git
  install / publish. `dist/` is gitignored (built on demand, never committed).
- Typecheck with `npx tsc --noEmit` (it's `noEmit`; tsc is only a checker here).
- **Zero runtime dependencies.** The only deps are dev-only `@types/node` +
  `typescript`. Keep it that way — everything is Node stdlib + shelling out to
  `tmux`/`git`. Don't reach for a TUI/ANSI/arg-parsing library.
- The tool must be run where a tmux server is reachable. Inside tmux it scans the
  current session by default; outside (or with no `--current`) it scans all.

## Architecture (one job per file)

| File | Role |
|------|------|
| `src/types.ts` | Data model: `AgentState`, `Rule`, `Manifest`, `PaneInfo`, `AgentStatus`. |
| `src/regions.ts` | Region extractors — pure string slicers over captured pane text. |
| `src/manifests.ts` | **The detection rules you tune.** Per-agent identity + state patterns. |
| `src/detect.ts` | Engine: `identifyAgent` + `resolveState` (signal arbitration). |
| `src/tmux.ts` | All tmux shelling: list panes, capture, switch/select clients, list clients. |
| `src/git.ts` | Git branch/dirty/ahead-behind via the `git` binary, cached per repo root. |
| `src/scan.ts` | One detection pass over all panes; shared by every mode. |
| `src/nav.ts` | Jump logic (switch-client / attach / target another client). |
| `src/render.ts` | Grouped/JSON output, state glyph + spinner, ANSI helpers. |
| `src/pick.ts` | Interactive dashboard (raw-mode TUI): keys, animation, target cycling. |
| `src/index.ts` | CLI arg parsing + mode dispatch. |

Data flow: `scan()` → `listPanes()` (tmux) → per pane `capturePane()` +
`resolveState()` → `AgentStatus[]` → `render*` / `pick`.

## The detection model

Two independent halves, both driven by **data, not code**:

1. **Identity** (`identifyAgent`): match `pane_current_command` against a
   manifest's `match` names → its `commandPattern` regex → screen `signature`
   substrings. Highest-confidence source wins.
2. **State** (`resolveState` + manifest `rules`): capture the pane's rendered
   screen, run the agent's rules by `priority` (highest match wins) over a
   `region` of the screen; then arbitrate against PTY activity.

Arbitration order in `resolveState` (do not casually reorder):
`skipStateUpdate` (hold prev) → **blocked** (active match only) → **working**
(content changed since last scan) → working (on-screen interrupt hint) → **idle**
(debounced: must persist two scans) → else keep previous.

## Invariants & gotchas (each was a real bug — don't reintroduce)

- **tmux sanitizes control chars in `-F` output to `_`** — including a chosen
  field separator *and even newlines*. So you cannot pack multiple fields into
  one `-F` line. `listPanes` queries **one field per call**, each paired with
  `#{pane_id}` and split on the first `|` (pane ids are `%<digits>`, never
  contain `|`), then merges by id. Keep this pattern for any new pane/client
  field. (`src/tmux.ts`)
- **Claude Code renames its process comm to its version string** (e.g.
  `2.1.200`), so `pane_current_command` is *not* `claude`. Identity relies on the
  semver `commandPattern` (`^\d+\.\d+\.\d+`). Screen `signature`s must be
  *persistent* chrome (mode footer, `esc to interrupt`, permission prompt) — the
  welcome banner scrolls off mid-session and must not be relied on. (`manifests.ts`)
- **Blocked must key on the LIVE selection cursor** (`^\s*❯\s+\d+\.`), not the
  question text. The prompt text ("Do you want to proceed?") lingers in the
  scroll buffer after you answer; the `❯ 1.` cursor disappears the instant you
  answer. **Blocked is also never inherited** — `resolveState`'s `keep()` demotes
  a held `blocked` to `idle`, so a stale block can't persist. (`detect.ts`,
  `manifests.ts`)
- **Dashboard redraw must erase each line's tail (`\x1b[K`)**, not just clear
  below the last line. Otherwise a line that gets *shorter* (e.g. a `· 1 blocked`
  suffix that goes away) leaves ghost text. Don't switch back to a full-screen
  `\x1b[2J` clear — it flickers against the ~90ms spinner tick. (`pick.ts`)
- **The spinner animates on its own ~90ms timer, separate from the 800ms scan**,
  and only ticks while something is `working` (an all-idle board stays quiet). Do
  not scan tmux on the animation tick — `render()` only rebuilds strings.
- **Cross-window jump uses `switch-client -c <client_tty>`.** tmux is
  client-server: each attached terminal is a client identified by its tty.
  `selfClientTty()` is only meaningful **inside** tmux — guard it with
  `insideTmux()`, or a plain-terminal dashboard will mislabel the one real client
  as "self" and find no targets. (`nav.ts`, `pick.ts`, `index.ts`)
- **Jump behavior is context-dependent:** targeting another client, or self
  inside tmux, keeps the dashboard alive; self *outside* tmux means `tmux attach`
  (takes over the terminal), so there it exits. (`nav.ts::jumpToPane`)
- **`scan()` preserves tmux pane order** (resolve concurrently, then filter in
  order) so the grouped view is stable across refreshes — don't `push` in
  async-completion order.

## Changing detection rules (the common task)

Agent TUIs drift, so `manifests.ts` is expected to need tuning. Workflow:

1. `node src/index.ts --debug <pane>` against a live agent pane. It prints what
   each region extractor pulls out and marks which rules ✓ match.
2. Adjust the rule's `region` / `contains` / `anyContains` / `regex` / `not`.
   Rules are `{ id, state, priority, region, … }`; highest matching priority
   wins. Regions: `full`, `after_last_horizontal_rule`, `prompt_box_body`,
   `{ bottom_non_empty_lines: N }` (see `regions.ts`).
3. Prefer matching the **live** interactive element over lingering text (see the
   blocked invariant above), and set `skipStateUpdate: true` for scrollback /
   picker screens that shouldn't author state.

## Testing (no framework — use throwaway tmux servers)

There's no test runner; verify against **isolated tmux servers** on a dedicated
socket so you never touch the user's real session:

```sh
SOCK=/tmp/tend-test.sock
tmux -S "$SOCK" new-session -d -s demo -n runner
# simulate an agent by printing its TUI into a pane:
tmux -S "$SOCK" new-window -t demo -n agent
tmux -S "$SOCK" send-keys -t demo:agent "clear; printf '%s\n' 'Do you want to proceed?' '❯ 1. Yes' '  2. No'" Enter
# run tend FROM INSIDE that server (so its plain `tmux` calls hit $SOCK):
tmux -S "$SOCK" send-keys -t demo:runner "node /abs/path/src/index.ts --once --json > /tmp/out.json 2>&1" Enter
tmux -S "$SOCK" kill-server   # always clean up
```

Key testing facts:
- tend always talks to the **default** socket via plain `tmux`; to test against
  `-S <socket>` you must run it *inside* a pane of that server (its `$TMUX` then
  points there).
- The interactive dashboard reads a real PTY, so drive it with
  `tmux send-keys -t <pane> Down` / `Enter` / `o` / `q` and read it back with
  `tmux capture-pane -p`.
- **Cross-window / `switch-client` tests need ≥2 real clients.** Attach them via a
  *second* tmux server whose panes run `tmux -S <first-socket> attach -t <sess>`
  (a plain `&`-backgrounded `attach` won't get a sized PTY on macOS).
- `capture-pane -p` strips color; assert on glyphs/text, use `--debug` or logic
  for color/state.

## Conventions

- TypeScript with `erasableSyntaxOnly` + `verbatimModuleSyntax` — no enums,
  no namespaces, no param-properties; `import type` for types; **import with the
  `.ts` extension** (`./tmux.ts`). Target/module per `tsconfig.json` (NodeNext).
- Comments explain the *why* (especially the invariants above), not the *what*.
- Keep the CLI's snapshot path (`--once`/`--json`/piped) side-effect-free and
  exiting; only the dashboard holds the terminal.

## License

`tend` is MIT — see `LICENSE`. All the code here is original; keep it that way.
