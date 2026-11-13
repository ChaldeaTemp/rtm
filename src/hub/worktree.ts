import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface WorkspaceResolution {
  baseCwd: string;
  effectiveCwd: string;
  isWorktree: boolean;
  branch?: string;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function sanitizeName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "session";
}

function ensureWorktreeExclude(repoRoot: string): void {
  const excludePath = path.join(repoRoot, ".git", "info", "exclude");
  if (!fs.existsSync(path.dirname(excludePath))) {
    return;
  }
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes(".agent-hub-worktrees/")) {
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(excludePath, `${prefix}.agent-hub-worktrees/\n`, "utf8");
  }
}

/**
 * Resolves either a shared cwd or an isolated git worktree directory for a session.
 */
export function ensureSessionWorkspace(
  baseCwd: string,
  sessionName: string,
  isolateWorktree: boolean,
): WorkspaceResolution {
  const resolvedBase = path.resolve(baseCwd);
  if (!isolateWorktree) {
    return {
      baseCwd: resolvedBase,
      effectiveCwd: resolvedBase,
      isWorktree: false,
    };
  }

  let repoRoot: string;
  try {
    repoRoot = runGit(resolvedBase, ["rev-parse", "--show-toplevel"]);
  } catch (err) {
    throw new Error(
      `Cannot enable isolate_worktree because "${resolvedBase}" is not inside a git repository: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new Error(
      `Cannot enable isolate_worktree in "${repoRoot}" because the repository has no commits yet. Create an initial commit first.`,
    );
  }

  ensureWorktreeExclude(repoRoot);

  const safeName = sanitizeName(sessionName);
  const worktreesRoot = path.join(repoRoot, ".agent-hub-worktrees");
  const targetDir = path.join(worktreesRoot, safeName);
  const branch = `agent-hub/${safeName}`;

  if (fs.existsSync(targetDir)) {
    let activeBranch = branch;
    try {
      activeBranch = runGit(targetDir, ["rev-parse", "--abbrev-ref", "HEAD"]) || branch;
    } catch {
      // Keep expected branch name
    }
    return {
      baseCwd: resolvedBase,
      effectiveCwd: targetDir,
      isWorktree: true,
      branch: activeBranch,
    };
  }

  fs.mkdirSync(worktreesRoot, { recursive: true });
  runGit(repoRoot, ["worktree", "add", "-B", branch, targetDir, "HEAD"]);

  return {
    baseCwd: resolvedBase,
    effectiveCwd: targetDir,
    isWorktree: true,
    branch,
  };
}

/**
 * Removes a previously created git worktree directory if it exists under .agent-hub-worktrees.
 */
export function removeSessionWorktree(baseCwd: string, worktreePath: string): void {
  const repoRoot = runGit(path.resolve(baseCwd), ["rev-parse", "--show-toplevel"]);
  const resolvedTarget = path.resolve(worktreePath);
  const expectedParent = path.resolve(repoRoot, ".agent-hub-worktrees");
  if (!resolvedTarget.startsWith(expectedParent + path.sep)) {
    throw new Error(`Refusing to remove worktree outside ${expectedParent}: ${resolvedTarget}`);
  }
  runGit(repoRoot, ["worktree", "remove", "--force", resolvedTarget]);
}

/**
 * Produces a concise git branch, status, and diff summary for a workspace.
 */
export function summarizeWorkspaceChanges(cwd: string): string {
  try {
    const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = runGit(cwd, ["status", "--short"]);
    const diffStat = runGit(cwd, ["diff", "--stat"]);
    const lines = [`Branch: ${branch || "(detached)"}`];
    lines.push(status ? `Status:\n${status}` : "Status: clean");
    if (diffStat) {
      lines.push(`Diff stat:\n${diffStat}`);
    }
    return lines.join("\n");
  } catch {
    return "Workspace: (not a git repository or git status unavailable)";
  }
}
