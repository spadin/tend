// Jump the terminal to an agent's pane. Inside tmux we switch the attached
// client instantly; outside tmux we pre-select the pane on the server and then
// hand the terminal to `tmux attach`.

import { spawn } from "node:child_process";
import { preselectPane, switchClientToPane, switchToPane } from "./tmux.ts";
import type { PaneInfo } from "./types.ts";

export { listClients, selfClientTty, type TmuxClient } from "./tmux.ts";

export function insideTmux(): boolean {
  return Boolean(process.env.TMUX);
}

export interface JumpOptions {
  // Send the jump to this client (tty) instead of our own — e.g. open the agent
  // in a different terminal window while the dashboard stays put.
  client?: string;
}

// Jump the terminal to an agent's pane.
//  - opts.client set  → move that other client to the pane (dashboard stays).
//  - inside tmux      → switch our own client and resolve immediately.
//  - outside tmux     → pre-select the pane, then `tmux attach` (blocks until
//                       the user detaches).
export async function jumpToPane(pane: PaneInfo, opts: JumpOptions = {}): Promise<void> {
  const { sessionName, id: paneId } = pane;
  if (opts.client) {
    await switchClientToPane(opts.client, sessionName, paneId);
    return;
  }
  if (insideTmux()) {
    await switchToPane(sessionName, paneId);
    return;
  }
  await preselectPane(paneId);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tmux", ["attach-session", "-t", sessionName], {
      stdio: "inherit",
    });
    child.on("close", () => resolve());
    child.on("error", reject);
  });
}
