// One detection pass over every pane. Shared by the list, watch, and picker
// modes. Threads per-pane memory across calls so "working" (content changed
// since last look) and idle-debounce work in the live modes.

import { capturePane, listPanes } from "./tmux.ts";
import { createGitCache } from "./git.ts";
import { resolveState, type PaneMemory } from "./detect.ts";
import type { AgentStatus } from "./types.ts";

export interface ScanOptions {
  all: boolean;
}

export async function scan(
  opts: ScanOptions,
  memory: Map<string, PaneMemory>,
): Promise<{ statuses: AgentStatus[]; memory: Map<string, PaneMemory> }> {
  const panes = await listPanes({ all: opts.all });
  const gitCache = createGitCache();
  const nextMemory = new Map<string, PaneMemory>();

  // Resolve concurrently but keep results in tmux pane order (session → window →
  // pane) so the grouped view is stable across refreshes rather than ordered by
  // whichever capture-pane happened to finish first.
  const resolved = await Promise.all(
    panes.map(async (pane): Promise<AgentStatus | null> => {
      const lines = await capturePane(pane.id);
      const resolution = resolveState(pane, lines, memory.get(pane.id));
      if (!resolution) return null; // not an agent pane
      nextMemory.set(pane.id, resolution.memory);
      const git = await gitCache(pane.path);
      return {
        pane,
        agent: resolution.agent,
        state: resolution.state,
        matchedRule: resolution.matchedRule,
        git,
      };
    }),
  );
  const statuses = resolved.filter((s): s is AgentStatus => s !== null);
  return { statuses, memory: nextMemory };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fire-once: sample twice with a short delay so "working" can be detected via
// content change even without a persistent watcher.
export async function scanOnce(
  opts: ScanOptions,
  delayMs: number,
): Promise<AgentStatus[]> {
  let memory = new Map<string, PaneMemory>();
  ({ memory } = await scan(opts, memory));
  await sleep(delayMs);
  const { statuses } = await scan(opts, memory);
  return statuses;
}
