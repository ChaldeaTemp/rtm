import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WINDOWS_APP_BROWSERS = [
  path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
  path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
  path.join(process.env.LOCALAPPDATA ?? "", "Microsoft\\Edge\\Application\\msedge.exe"),
  path.join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
];

function findAppBrowserExecutable(): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  return WINDOWS_APP_BROWSERS.find((candidate) => candidate && fs.existsSync(candidate));
}

/**
 * Opens the interactive workbench either as a dedicated borderless desktop app window
 * (via Edge/Chrome --app) or in the system default browser.
 */
export function openInteractiveWindow(
  url: string,
  preferAppWindow = true,
): { mode: "app" | "browser"; executable?: string } {
  if (process.platform === "win32") {
    if (preferAppWindow) {
      const exe = findAppBrowserExecutable();
      if (exe) {
        const child = spawn(exe, [`--app=${url}`, "--window-size=1380,880"], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        });
        child.unref();
        return { mode: "app", executable: exe };
      }
    }
    const child = spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { mode: "browser" };
  }

  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [url], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { mode: "browser", executable: opener };
}
