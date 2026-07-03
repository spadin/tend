// Git status by shelling out to the real `git` binary (no libgit2 dependency).
// Cheap enough for a handful of panes; results are memoized per repo root within
// a single tick so N panes in one repo cost one set of calls.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitStatus } from "./types.ts";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function repoRoot(cwd: string): Promise<string | null> {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

async function computeStatus(cwd: string): Promise<GitStatus | null> {
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) return null; // not a git repo

  const porcelain = await git(cwd, ["status", "--porcelain"]);
  const dirty = porcelain !== null && porcelain.length > 0;

  let ahead = 0;
  let behind = 0;
  const counts = await git(cwd, [
    "rev-list",
    "--left-right",
    "--count",
    "HEAD...@{upstream}",
  ]);
  if (counts) {
    const [a, b] = counts.split(/\s+/);
    ahead = Number(a) || 0;
    behind = Number(b) || 0;
  }

  return { branch: branch === "HEAD" ? null : branch, dirty, ahead, behind };
}

// Per-tick cache keyed by repo root, so panes sharing a repo share the answer.
export function createGitCache() {
  const byRoot = new Map<string, Promise<GitStatus | null>>();
  return async function statusFor(cwd: string): Promise<GitStatus | null> {
    const root = await repoRoot(cwd);
    if (root === null) return null;
    let pending = byRoot.get(root);
    if (!pending) {
      // Compute from the repo root so all panes agree regardless of subdir.
      pending = computeStatus(root);
      byRoot.set(root, pending);
    }
    return pending;
  };
}
