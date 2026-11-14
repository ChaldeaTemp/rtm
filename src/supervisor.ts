import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { installDataDir } from "./hub/data-dir.js";
import { killProcessTree, PROJECT_ROOT } from "./hub/process-tree.js";

/**
 * Keeps the desktop hub alive. The hub runs in a child process; when that child dies without
 * having been asked to (a crash, an out-of-memory abort, being killed), the supervisor writes
 * down what happened, cleans up the agent processes the dead hub left behind, and starts it
 * again. The window that is already open reconnects on its own and the hub restores its state
 * from disk. A clean exit (window closed, Ctrl+C) ends the supervisor too.
 */

/** Set in the child's environment so it runs the hub instead of supervising again. */
export const SUPERVISED_ENV = "RTM_SUPERVISED";

const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const STDERR_TAIL_CHARS = 4000;

export function crashLogPath(): string {
  return path.join(installDataDir(PROJECT_ROOT), "crash.log");
}

/** Appends one entry to the crash log. Never throws: this runs while things are going wrong. */
export function appendCrashLog(title: string, detail?: string): void {
  try {
    const lines = [`[${new Date().toISOString()}] ${title}`];
    if (detail?.trim()) lines.push(detail.trim().replace(/^/gm, "    "));
    fs.appendFileSync(crashLogPath(), `${lines.join("\n")}\n`, "utf8");
  } catch {
    // Nothing more we can do.
  }
}

/** Direct children of a process that may itself be gone already. */
export function listChildPids(parentPid: number): number[] {
  try {
    const out =
      process.platform === "win32"
        ? spawnSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | ForEach-Object { $_.ProcessId }`,
            ],
            { encoding: "utf8", windowsHide: true, timeout: 15000 },
          ).stdout
        : spawnSync("pgrep", ["-P", String(parentPid)], { encoding: "utf8", timeout: 5000 }).stdout;
    return String(out ?? "")
      .split(/\s+/)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    return [];
  }
}

/** Decides whether to restart after a crash: at most MAX_CRASHES within CRASH_WINDOW_MS. */
export function shouldRestart(crashTimes: number[], now: number): boolean {
  return crashTimes.filter((t) => now - t < CRASH_WINDOW_MS).length <= MAX_CRASHES;
}

export async function superviseDesktop(argv: string[]): Promise<number> {
  const crashTimes: number[] = [];
  let stopping = false;
  let currentChild: ReturnType<typeof spawn> | undefined;

  const stop = () => {
    stopping = true;
    if (currentChild?.pid) killProcessTree(currentChild.pid);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let extraArgs: string[] = [];
  for (;;) {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...argv, ...extraArgs], {
      env: { ...process.env, [SUPERVISED_ENV]: "1" },
      stdio: ["ignore", "inherit", "pipe"],
      windowsHide: true,
    });
    currentChild = child;
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("error", (err) => {
        stderrTail += `\n${err.message}`;
        resolve({ code: 1, signal: null });
      });
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    if (stopping || exit.code === 0) {
      return 0;
    }

    const now = Date.now();
    crashTimes.push(now);
    appendCrashLog(
      `hub exited unexpectedly (pid ${child.pid ?? "?"}, code ${exit.code ?? "none"}, signal ${exit.signal ?? "none"})`,
      stderrTail || "(nothing on stderr: the process was killed from outside or ran out of memory)",
    );

    // Agent processes started by the dead hub keep running and keep their memory; the new hub
    // cannot reach them, so they go.
    if (child.pid) {
      for (const orphan of listChildPids(child.pid)) killProcessTree(orphan);
    }

    if (!shouldRestart(crashTimes, now)) {
      appendCrashLog(`giving up: ${MAX_CRASHES + 1} crashes within ${CRASH_WINDOW_MS / 60000} minutes`);
      return 1;
    }
    appendCrashLog("restarting hub");
    // The window from the first launch is still there and reconnects by itself.
    extraArgs = ["--no-open"];
    await new Promise((r) => setTimeout(r, 1500));
  }
}
