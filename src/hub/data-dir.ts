import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where RTM keeps its data inside a directory (the install root, a workspace, or the home dir). */
export const DATA_DIR_NAME = ".rtm";
/** The name used before the rename; directories under it are moved over on first use. */
const LEGACY_DATA_DIR_NAME = ".agent-hub";

const resolved = new Map<string, string>();

/**
 * The data directory under `base`. If only the old `.agent-hub` directory exists there it is
 * renamed to `.rtm`, so existing tasks, settings and rules carry over. Should the rename fail
 * (for example because another process holds a file open), the old directory keeps being used
 * rather than starting from an empty one.
 */
export function dataDir(base: string): string {
  const key = path.resolve(base);
  const cached = resolved.get(key);
  if (cached) {
    return cached;
  }
  const current = path.join(key, DATA_DIR_NAME);
  const legacy = path.join(key, LEGACY_DATA_DIR_NAME);
  let result = current;
  if (!fs.existsSync(current) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, current);
    } catch {
      result = legacy;
    }
  }
  resolved.set(key, result);
  return result;
}

function defaultUserDataDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "RTM");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "RTM");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "rtm");
}

function isWritableDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, "", "utf8");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * The install-level data directory: tasks, settings, uploads, runtime info. `RTM_DATA_DIR`
 * redirects it, which is how tests and benchmarks keep their hubs away from real data.
 * When installed into a read-only location or under `node_modules`, falls back to the OS
 * per-user data directory.
 */
export function installDataDir(projectRoot: string): string {
  const override = process.env.RTM_DATA_DIR?.trim();
  if (override) {
    fs.mkdirSync(override, { recursive: true });
    return path.resolve(override);
  }
  const resolvedRoot = path.resolve(projectRoot);
  if (!/[/\\]node_modules([/\\]|$)/i.test(resolvedRoot)) {
    const candidate = dataDir(resolvedRoot);
    if (isWritableDir(candidate)) {
      return candidate;
    }
  }
  const fallback = defaultUserDataDir();
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}
