import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPortAvailable, findAvailablePort, pickNativeDirectory } from "./hub/port-finder.js";
import { PROJECT_ROOT } from "./hub/process-tree.js";
import { readRuntimeFile } from "./hub/server.js";

/**
 * Desktop launch, the same on Windows and macOS: remember the last workspace and port, reuse
 * a hub that is already running, otherwise start one and open it in an app window.
 * `RTM.vbs` (Windows) and `RTM.command` (macOS) are thin double-click wrappers around
 * `rtm desktop`.
 */

const PREFS_FILE = path.join(PROJECT_ROOT, ".agent-hub", "desktop-prefs.json");
const DEFAULT_PORT = 4317;

export interface DesktopPrefs {
  port: number;
  cwd: string;
  autoExit: boolean;
}

export interface DesktopLaunchPlan {
  /** A hub is already up: just open a window on it. */
  reuseUrl?: string;
  port: number;
  /** False when the preferred port was taken and another one was picked. */
  preferredPortAvailable: boolean;
  cwd: string;
  autoExit: boolean;
}

export function loadDesktopPrefs(): Partial<DesktopPrefs> {
  try {
    // The file may carry a BOM when it was last written by the old PowerShell launcher.
    const raw = fs.readFileSync(PREFS_FILE, "utf8").replace(/^﻿/, "");
    const parsed = JSON.parse(raw) as Partial<DesktopPrefs>;
    return {
      port: typeof parsed.port === "number" ? parsed.port : undefined,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      autoExit: typeof parsed.autoExit === "boolean" ? parsed.autoExit : undefined,
    };
  } catch {
    return {};
  }
}

export function saveDesktopPrefs(prefs: DesktopPrefs): void {
  try {
    fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify({ ...prefs, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  } catch {
    // Preferences are a convenience; the launch itself does not depend on them.
  }
}

function isDirectory(dir: string | undefined): dir is string {
  try {
    return Boolean(dir) && fs.statSync(dir!).isDirectory();
  } catch {
    return false;
  }
}

/** The hub recorded in runtime.json, if its process is alive and it answers. */
async function findRunningHub(): Promise<string | undefined> {
  const runtime = readRuntimeFile();
  if (!runtime?.url || !runtime.pid) {
    return undefined;
  }
  try {
    process.kill(runtime.pid, 0);
  } catch {
    return undefined;
  }
  try {
    const res = await fetch(`${runtime.url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? runtime.url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decides how to launch. Explicit flags win over saved preferences. With no usable workspace
 * (first run), or when asked to, the OS folder dialog is shown; cancelling it falls back to
 * the home directory rather than aborting the launch.
 */
export async function planDesktopLaunch(input: {
  port?: number;
  cwd?: string;
  chooseDir?: boolean;
  ignoreRunning?: boolean;
}): Promise<DesktopLaunchPlan> {
  const prefs = loadDesktopPrefs();
  const autoExit = prefs.autoExit ?? true;

  if (!input.ignoreRunning && !input.cwd && !input.chooseDir) {
    const reuseUrl = await findRunningHub();
    if (reuseUrl) {
      return {
        reuseUrl,
        port: Number(new URL(reuseUrl).port),
        preferredPortAvailable: true,
        cwd: prefs.cwd ?? os.homedir(),
        autoExit,
      };
    }
  }

  let cwd = isDirectory(input.cwd) ? path.resolve(input.cwd) : isDirectory(prefs.cwd) ? prefs.cwd : undefined;
  if (input.chooseDir || !cwd) {
    const picked = await pickNativeDirectory(cwd ?? os.homedir()).catch(() => undefined);
    cwd = picked && !picked.cancelled && isDirectory(picked.path) ? picked.path : (cwd ?? os.homedir());
  }

  const preferred = input.port ?? prefs.port ?? DEFAULT_PORT;
  const preferredPortAvailable = (await checkPortAvailable(preferred)).available;
  const port = preferredPortAvailable ? preferred : await findAvailablePort(preferred + 1);
  return { port, preferredPortAvailable, cwd, autoExit };
}

/**
 * Puts a launcher on the user's desktop: a .lnk with the app icon on Windows, a .command
 * file on macOS. Returns the path it created.
 */
export function createDesktopShortcut(): string {
  const desktopDir = path.join(os.homedir(), "Desktop");
  if (process.platform === "win32") {
    const lnkPath = path.join(desktopDir, "RTM.lnk");
    const vbsPath = path.join(PROJECT_ROOT, "RTM.vbs");
    const iconPath = path.join(PROJECT_ROOT, "src", "ui", "icon.ico");
    const q = (value: string) => value.replace(/'/g, "''");
    const script = [
      "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('" + q(lnkPath) + "')",
      "$s.TargetPath = 'wscript.exe'",
      "$s.Arguments = '//nologo \"" + q(vbsPath) + "\"'",
      "$s.WorkingDirectory = '" + q(PROJECT_ROOT) + "'",
      "$s.IconLocation = '" + q(iconPath) + "'",
      "$s.Description = 'RTM'",
      "$s.Save()",
    ].join("; ");
    execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true });
    return lnkPath;
  }
  const target = path.join(desktopDir, "RTM.command");
  const launcher = path.join(PROJECT_ROOT, "RTM.command");
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.writeFileSync(target, `#!/bin/bash\nexec "${launcher}"\n`, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(target, 0o755);
  return target;
}
