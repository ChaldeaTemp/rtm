import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../hub/process-tree.js";
import { installDataDir } from "../hub/data-dir.js";

const WINDOWS_APP_BROWSERS = [
  path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
  path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
  path.join(process.env.LOCALAPPDATA ?? "", "Microsoft\\Edge\\Application\\msedge.exe"),
  path.join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
];

const MAC_APP_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Arc.app/Contents/MacOS/Arc",
];

const LINUX_APP_BROWSER_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];

/** A Chromium-family browser that can open the workbench as a chromeless app window. */
function findAppBrowserExecutable(): string | undefined {
  if (process.platform === "win32") {
    return WINDOWS_APP_BROWSERS.find((candidate) => candidate && fs.existsSync(candidate));
  }
  if (process.platform === "darwin") {
    const home = process.env.HOME ?? "";
    return [...MAC_APP_BROWSERS, ...MAC_APP_BROWSERS.map((p) => path.join(home, p))].find((candidate) =>
      fs.existsSync(candidate),
    );
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of LINUX_APP_BROWSER_NAMES) {
      const candidate = path.join(dir, name);
      if (dir && fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Opens the interactive workbench either as a dedicated borderless desktop app window
 * (via Edge/Chrome --app) or in the system default browser.
 */
export function openInteractiveWindow(
  url: string,
  preferAppWindow = true,
  options?: { profileDir?: string },
): { mode: "app" | "browser"; executable?: string } {
  if (preferAppWindow) {
    const exe = findAppBrowserExecutable();
    if (exe) {
      const profileDir =
        options?.profileDir ?? path.join(installDataDir(PROJECT_ROOT), "desktop-browser-profile");
      fs.mkdirSync(profileDir, { recursive: true });
      const child = spawn(
        exe,
        [
          `--app=${url}`,
          `--user-data-dir=${profileDir}`,
          "--window-size=1420,900",
          "--no-first-run",
          "--no-default-browser-check",
          // App window, not a browser: no translate bar, no password or autofill prompts.
          "--disable-features=Translate,AutofillServerCommunication,PasswordManagerOnboarding",
          "--disable-save-password-bubble",
        ],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        },
      );
      // A missing browser/opener must not crash the hub.
      child.on("error", () => {});
      child.unref();
      return { mode: "app", executable: exe };
    }
  }

  if (process.platform === "win32") {
    const child = spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    // A missing browser/opener must not crash the hub.
    child.on("error", () => {});
    child.unref();
    return { mode: "browser" };
  }

  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [url], {
    detached: true,
    stdio: "ignore",
  });
  // A missing browser/opener must not crash the hub.
  child.on("error", () => {});
  child.unref();
  return { mode: "browser", executable: opener };
}
