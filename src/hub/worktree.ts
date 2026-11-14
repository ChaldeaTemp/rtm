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
  if (!lines.includes(".rtm-worktrees/")) {
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(excludePath, `${prefix}.rtm-worktrees/\n`, "utf8");
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
  const worktreesRoot = path.join(repoRoot, ".rtm-worktrees");
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

export interface WorktreeInspection {
  branch: string;
  clean: boolean;
  statusLines: string[];
  diffStat: string;
  diff: string;
  truncated: boolean;
}

export interface WorktreeMergeResult {
  merged: boolean;
  alreadyUpToDate?: boolean;
  branch: string;
  commit?: string;
  summary: string;
}

const MAX_DIFF_CHARS = 60_000;

function runGitWithBuffer(cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function assertWorktreeInsideRepo(repoRoot: string, worktreePath: string): string {
  const resolvedTarget = path.resolve(worktreePath);
  const allowedParents = [
    path.resolve(repoRoot, ".rtm-worktrees"),
    path.resolve(repoRoot, ".agent-hub-worktrees"),
  ];
  const normTarget = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget;
  const insideAllowed = allowedParents.some((parent) => {
    const normParent = process.platform === "win32" ? parent.toLowerCase() : parent;
    return normTarget.startsWith(normParent + path.sep);
  });
  if (!insideAllowed) {
    throw new Error(`拒绝访问非托管目录之外的 worktree：${resolvedTarget}`);
  }
  return resolvedTarget;
}

/**
 * Removes a previously created git worktree directory if it exists under .rtm-worktrees
 * (or legacy .agent-hub-worktrees), and best-effort deletes its `agent-hub/*` branch.
 */
export function removeSessionWorktree(baseCwd: string, worktreePath: string): void {
  const repoRoot = runGit(path.resolve(baseCwd), ["rev-parse", "--show-toplevel"]);
  const resolvedTarget = assertWorktreeInsideRepo(repoRoot, worktreePath);
  let branchName = "";
  if (fs.existsSync(resolvedTarget)) {
    try {
      branchName = runGit(resolvedTarget, ["rev-parse", "--abbrev-ref", "HEAD"]);
    } catch {
      // Ignore branch detection errors
    }
  }
  try {
    runGit(repoRoot, ["worktree", "remove", "--force", resolvedTarget]);
  } catch (err) {
    if (fs.existsSync(resolvedTarget)) {
      throw err;
    }
  }
  const fallbackBranch = `agent-hub/${path.basename(resolvedTarget)}`;
  const targetBranch =
    branchName.startsWith("agent-hub/") ? branchName : fallbackBranch;
  if (targetBranch.startsWith("agent-hub/")) {
    try {
      runGit(repoRoot, ["branch", "-D", targetBranch]);
    } catch {
      // Branch may already be deleted or checked out elsewhere
    }
  }
}

/**
 * Inspects committed and uncommitted changes in an isolated session worktree compared against
 * the main workspace HEAD.
 */
export function inspectWorktreeChanges(baseCwd: string, worktreePath: string): WorktreeInspection {
  const repoRoot = runGit(path.resolve(baseCwd), ["rev-parse", "--show-toplevel"]);
  const resolvedTarget = assertWorktreeInsideRepo(repoRoot, worktreePath);
  if (!fs.existsSync(resolvedTarget)) {
    throw new Error("该会话关联的 worktree 目录已不存在");
  }

  const branch = runGit(resolvedTarget, ["rev-parse", "--abbrev-ref", "HEAD"]) || "(detached)";
  const statusRaw = runGit(resolvedTarget, ["status", "--short"]);
  const statusLines = statusRaw
    ? statusRaw.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean)
    : [];
  const baseHead = runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);

  let diffStat = "";
  let diff = "";
  try {
    diffStat = runGitWithBuffer(resolvedTarget, ["diff", "--stat", baseHead]).trim();
    diff = runGitWithBuffer(resolvedTarget, ["diff", baseHead]);
  } catch {
    diffStat = "";
    diff = "";
  }

  const untracked = statusLines
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3).trim().replace(/^"(.*)"$/, "$1"));
  const untrackedChunks: string[] = [];
  for (const relPath of untracked.slice(0, 12)) {
    const absPath = path.join(resolvedTarget, relPath);
    try {
      const stat = fs.statSync(absPath);
      if (!stat.isFile() || stat.size > 64 * 1024) {
        untrackedChunks.push(`--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1 @@\n+[新增文件 (${stat.size} 字节)]`);
        continue;
      }
      const raw = fs.readFileSync(absPath);
      if (raw.includes(0)) {
        untrackedChunks.push(`--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1 @@\n+[新增二进制文件 (${stat.size} 字节)]`);
        continue;
      }
      const lines = raw.toString("utf8").split(/\r?\n/);
      const preview = lines.slice(0, 200).map((line) => `+${line}`).join("\n");
      const more = lines.length > 200 ? `\n+...（共 ${lines.length} 行，预览已省略后续内容）` : "";
      untrackedChunks.push(`diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n${preview}${more}`);
    } catch {
      // Ignore unreadable untracked entry
    }
  }

  let combined = [diff.trimEnd(), ...untrackedChunks].filter(Boolean).join("\n\n");
  let truncated = false;
  if (combined.length > MAX_DIFF_CHARS) {
    combined = `${combined.slice(0, MAX_DIFF_CHARS)}\n\n... [Diff 输出超过 ${MAX_DIFF_CHARS} 字符，已截断]`;
    truncated = true;
  }

  const clean = statusLines.length === 0 && combined.length === 0;
  return {
    branch,
    clean,
    statusLines,
    diffStat,
    diff: combined,
    truncated,
  };
}

/**
 * Snapshots uncommitted worktree changes onto its branch and merges into the main repo HEAD.
 * Automatically aborts on conflict so the main working tree stays clean.
 */
export function mergeSessionWorktree(baseCwd: string, worktreePath: string): WorktreeMergeResult {
  const repoRoot = runGit(path.resolve(baseCwd), ["rev-parse", "--show-toplevel"]);
  const resolvedTarget = assertWorktreeInsideRepo(repoRoot, worktreePath);
  if (!fs.existsSync(resolvedTarget)) {
    throw new Error("该会话关联的 worktree 目录已不存在，无法合入");
  }

  const branch = runGit(resolvedTarget, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") {
    throw new Error("Worktree 处于 detached HEAD 状态，无法自动合入");
  }

  const worktreeStatus = runGit(resolvedTarget, ["status", "--short"]);
  if (worktreeStatus) {
    runGit(resolvedTarget, ["add", "-A"]);
    runGit(resolvedTarget, ["commit", "-m", "chore(rtm): snapshot worktree changes before merge"]);
  }

  const baseHead = runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  const worktreeHead = runGit(resolvedTarget, ["rev-parse", "--verify", "HEAD"]);

  try {
    execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", worktreeHead, baseHead], {
      stdio: "ignore",
      windowsHide: true,
    });
    return {
      merged: false,
      alreadyUpToDate: true,
      branch,
      commit: baseHead,
      summary: "Worktree 分支相对于主工作区没有新的改动，无需合入。",
    };
  } catch {
    // Has new commits ahead of baseHead; proceed to merge
  }

  try {
    const mergeOutput = runGitWithBuffer(repoRoot, ["merge", "--no-edit", branch]).trim();
    const newHead = runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
    return {
      merged: true,
      branch,
      commit: newHead,
      summary: mergeOutput || `已成功将分支 ${branch} 合入当前主分支。`,
    };
  } catch (err) {
    try {
      runGit(repoRoot, ["merge", "--abort"]);
    } catch {
      // Ignore if merge state did not enter conflicted state (e.g., dirty worktree error)
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`合入分支「${branch}」失败，已自动回滚保持主工作区不变：${detail}`);
  }
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
