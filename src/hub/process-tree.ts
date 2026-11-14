import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_AGENTS, type AdapterHealth, type AgentDefinition, type AgentId } from "../types.js";
import { installDataDir } from "./data-dir.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(THIS_DIR, "../..");
const LOCAL_SECRETS_FILE = path.join(installDataDir(PROJECT_ROOT), "secrets.json");

export interface ResolvedCommand {
  command: string;
  args: string[];
  entrypointFile?: string;
  env?: Record<string, string>;
}

export function findExecutableInPath(names: string[]): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function resolveReclaudeExecutable(localSecrets: Record<string, string>): string | undefined {
  const explicit = process.env.CLAUDE_CODE_EXECUTABLE || localSecrets.CLAUDE_CODE_EXECUTABLE;
  if (explicit?.trim() && fs.existsSync(explicit.trim())) {
    return explicit.trim();
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const defaultWin = path.join(localAppData, "Programs", "reclaude", "bin", "reclaude.exe");
    if (fs.existsSync(defaultWin)) {
      return defaultWin;
    }
    return findExecutableInPath(["reclaude.exe", "rec.exe"]);
  }
  return findExecutableInPath(["reclaude", "rec"]);
}

function resolveAgyExecutable(localSecrets: Record<string, string>): string | undefined {
  const explicit = process.env.AGY_EXECUTABLE || localSecrets.AGY_EXECUTABLE;
  if (explicit?.trim() && fs.existsSync(explicit.trim())) {
    return explicit.trim();
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const defaultWin = path.join(localAppData, "agy", "bin", "agy.exe");
    if (fs.existsSync(defaultWin)) {
      return defaultWin;
    }
    return findExecutableInPath(["agy.exe"]);
  }
  for (const candidate of [
    path.join(os.homedir(), ".local", "bin", "agy"),
    "/usr/local/bin/agy",
  ]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return findExecutableInPath(["agy"]);
}

export function resolveOpencodeExecutable(localSecrets: Record<string, string>): string | undefined {
  const explicit = process.env.OPENCODE_EXECUTABLE || localSecrets.OPENCODE_EXECUTABLE;
  if (explicit?.trim() && fs.existsSync(explicit.trim())) {
    return explicit.trim();
  }
  if (process.platform === "win32") {
    const inPath = findExecutableInPath(["opencode.exe", "opencode.cmd", "opencode.ps1"]);
    if (inPath) {
      if (inPath.toLowerCase().endsWith(".exe")) {
        return inPath;
      }
      const dir = path.dirname(inPath);
      const binExe = path.join(dir, "node_modules", "@opencode", "cli", "bin", "opencode.exe");
      if (fs.existsSync(binExe)) {
        return binExe;
      }
    }
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const defaultExe = path.join(localAppData, "opencode", "bin", "opencode.exe");
    if (fs.existsSync(defaultExe)) {
      return defaultExe;
    }
    return undefined;
  }
  for (const candidate of [
    path.join(os.homedir(), ".opencode", "bin", "opencode"),
    path.join(os.homedir(), ".local", "bin", "opencode"),
    "/usr/local/bin/opencode",
  ]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return findExecutableInPath(["opencode"]);
}

export function resolveKimiExecutable(localSecrets: Record<string, string>): string | undefined {
  const explicit = process.env.KIMI_EXECUTABLE || localSecrets.KIMI_EXECUTABLE;
  if (explicit?.trim() && fs.existsSync(explicit.trim())) {
    return explicit.trim();
  }
  const exeName = process.platform === "win32" ? "kimi.exe" : "kimi";
  for (const candidate of [
    path.join(os.homedir(), ".kimi-code", "bin", exeName),
    path.join(os.homedir(), ".kimi", "bin", exeName),
    path.join(os.homedir(), ".local", "bin", exeName),
  ]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return findExecutableInPath(process.platform === "win32" ? ["kimi.exe"] : ["kimi"]);
}

let devinInstallDirCache: string | null | undefined;

/** Where Devin Desktop is installed according to the Windows uninstall registry, if at all. */
function devinInstallDirFromRegistry(): string | undefined {
  if (process.platform !== "win32") return undefined;
  if (devinInstallDirCache !== undefined) return devinInstallDirCache ?? undefined;
  devinInstallDirCache = null;
  for (const hive of ["HKCU", "HKLM"]) {
    try {
      const out = spawnSync(
        "reg",
        ["query", `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, "/s", "/f", "Devin", "/d"],
        { encoding: "utf8", windowsHide: true, timeout: 5000 },
      ).stdout;
      const dir = /InstallLocation\s+REG_SZ\s+(.+)/i.exec(String(out ?? ""))?.[1]?.trim();
      if (dir && fs.existsSync(dir)) {
        devinInstallDirCache = dir;
        return dir;
      }
    } catch {
      // Registry not readable: fall through to the other locations.
    }
  }
  return undefined;
}

/**
 * The Devin CLI is not put on PATH by the Devin Desktop installer; it ships inside the app.
 * Looks on PATH first, then in the places the installers use.
 */
export function resolveDevinExecutable(localSecrets: Record<string, string> = {}): string | undefined {
  const explicit = process.env.DEVIN_EXECUTABLE || localSecrets.DEVIN_EXECUTABLE;
  if (explicit?.trim() && fs.existsSync(explicit.trim())) {
    return explicit.trim();
  }
  const exeName = process.platform === "win32" ? "devin.exe" : "devin";
  const onPath = findExecutableInPath([exeName]);
  if (onPath) return onPath;
  const inApp = (appDir: string) => path.join(appDir, "resources", "app", "extensions", "windsurf", "devin", "bin", exeName);
  const candidates = [path.join(os.homedir(), ".local", "bin", exeName)];
  if (process.platform === "win32") {
    const registryDir = devinInstallDirFromRegistry();
    if (registryDir) candidates.push(inApp(registryDir));
    if (process.env.LOCALAPPDATA) candidates.push(inApp(path.join(process.env.LOCALAPPDATA, "Programs", "Devin")));
  } else if (process.platform === "darwin") {
    candidates.push(
      path.join("/Applications", "Devin.app", "Contents", "Resources", "app", "extensions", "windsurf", "devin", "bin", exeName),
    );
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/** Agents whose CLI lives somewhere an installer chose rather than on PATH. */
function knownInstallFor(commandName: string): string | undefined {
  return commandName.toLowerCase() === "devin" ? resolveDevinExecutable(loadLocalSecrets()) : undefined;
}

function resolveGenericCommand(
  rawCommand: string,
  args: string[],
  env?: Record<string, string>,
): ResolvedCommand {
  const trimmed = rawCommand.trim();
  const isPathLike = trimmed.includes("/") || trimmed.includes("\\") || path.isAbsolute(trimmed);
  let resolvedCmd = trimmed;
  // Windows cannot spawn an extensionless file (e.g. the POSIX shim npm puts next to
  // `tool.cmd`), so a name without an extension resolves to its .exe/.cmd/.bat sibling first.
  const winExts = process.platform === "win32" && !path.extname(trimmed) ? [".exe", ".cmd", ".bat"] : [];
  if (isPathLike) {
    resolvedCmd = path.isAbsolute(trimmed) ? trimmed : path.resolve(PROJECT_ROOT, trimmed);
    const sibling = winExts.map((ext) => `${resolvedCmd}${ext}`).find((file) => fs.existsSync(file));
    if (sibling) {
      resolvedCmd = sibling;
    }
  } else {
    const pathCandidates = [...winExts.map((ext) => `${trimmed}${ext}`), trimmed];
    resolvedCmd = findExecutableInPath(pathCandidates) ?? knownInstallFor(trimmed) ?? trimmed;
  }

  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolvedCmd)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", resolvedCmd, ...args],
      entrypointFile: resolvedCmd,
      env,
    };
  }

  return {
    command: resolvedCmd,
    args,
    env,
  };
}

/**
 * Reads optional local API keys/tokens from .rtm/secrets.json without touching global user configs.
 */
export function loadLocalSecrets(): Record<string, string> {
  if (!fs.existsSync(LOCAL_SECRETS_FILE)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_SECRETS_FILE, "utf8")) as Record<string, unknown>;
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.trim()) {
        secrets[k] = v;
      }
    }
    return secrets;
  } catch {
    return {};
  }
}

/**
 * Resolves a Windows-safe direct executable and argument list for each supported ACP adapter.
 */
export function resolveAdapterCommand(agent: AgentId, customDef?: AgentDefinition): ResolvedCommand {
  const localSecrets = loadLocalSecrets();
  const mergedEnv: Record<string, string> = {
    ...localSecrets,
    ...(customDef?.env ?? {}),
  };
  const envOut = Object.keys(mergedEnv).length ? mergedEnv : undefined;

  if (customDef?.command?.trim()) {
    return resolveGenericCommand(customDef.command, customDef.args ?? [], envOut);
  }

  if (agent === "claude") {
    const reclaudeShim = path.join(PROJECT_ROOT, "bridges", "reclaude-acp.mjs");
    const fallbackEntry = path.join(
      PROJECT_ROOT,
      "node_modules",
      "@agentclientprotocol",
      "claude-agent-acp",
      "dist",
      "index.js",
    );
    const entry = fs.existsSync(reclaudeShim) ? reclaudeShim : fallbackEntry;
    const reclaudeExe = resolveReclaudeExecutable(localSecrets);
    const env: Record<string, string> = { ...mergedEnv };
    if (reclaudeExe) {
      env.CLAUDE_CODE_EXECUTABLE = reclaudeExe;
    }
    return {
      command: process.execPath,
      args: [entry],
      entrypointFile: entry,
      env: Object.keys(env).length ? env : undefined,
    };
  }

  if (agent === "codex") {
    const entry = path.join(
      PROJECT_ROOT,
      "node_modules",
      "@agentclientprotocol",
      "codex-acp",
      "dist",
      "index.js",
    );
    return {
      command: process.execPath,
      args: [entry],
      entrypointFile: entry,
      env: envOut,
    };
  }

  if (agent === "opencode") {
    const opencodeExe = resolveOpencodeExecutable(localSecrets);
    const env: Record<string, string> = { ...mergedEnv };
    if (!env.OPENCODE_CONFIG_CONTENT && !process.env.OPENCODE_CONFIG_CONTENT) {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        tools: { question: false },
        permission: { question: "deny" },
      });
    }
    return {
      command: opencodeExe ?? (process.platform === "win32" ? "opencode.exe" : "opencode"),
      args: customDef?.args?.length ? customDef.args : ["acp"],
      env: Object.keys(env).length ? env : undefined,
    };
  }

  if (agent === "kimi") {
    const kimiExe = resolveKimiExecutable(localSecrets);
    return {
      command: kimiExe ?? (process.platform === "win32" ? "kimi.exe" : "kimi"),
      args: customDef?.args?.length ? customDef.args : ["acp"],
      env: envOut,
    };
  }

  if (agent === "agy") {
    const adapterMode = (process.env.AGY_ADAPTER_MODE || localSecrets.AGY_ADAPTER_MODE || "").toLowerCase();
    const agyExe = adapterMode === "sdk" ? undefined : resolveAgyExecutable(localSecrets);
    if (agyExe) {
      return {
        command: agyExe,
        args: ["acp"],
        env: envOut,
      };
    }

    const venvPython = path.join(
      PROJECT_ROOT,
      ".venv",
      process.platform === "win32" ? "Scripts" : "bin",
      process.platform === "win32" ? "python.exe" : "python",
    );
    const bridgeScript = path.join(PROJECT_ROOT, "bridges", "agy_acp_server.py");
    return {
      command: venvPython,
      args: [bridgeScript],
      entrypointFile: bridgeScript,
      env: {
        ...mergedEnv,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
    };
  }

  return resolveGenericCommand(agent, customDef?.args?.length ? customDef.args : ["acp"], envOut);
}

/**
 * Resolves the direct Node launch command for the local peer MCP server,
 * preferring freshly built dist/ JS to skip tsx/esbuild compilation overhead.
 */
export function resolvePeerMcpLaunch(params: {
  hubUrl: string;
  callerAgent: AgentId;
  callerSession: string;
  depth: number;
  groupId?: string;
}): { command: string; args: string[] } {
  const tsxCli = path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const mcpTs = path.join(PROJECT_ROOT, "src", "mcp", "peer-mcp-server.ts");
  const mcpJs = path.join(PROJECT_ROOT, "dist", "mcp", "peer-mcp-server.js");
  const extraGroupArgs = params.groupId ? ["--group-id", params.groupId] : [];
  const commonFlags = [
    "--hub-url",
    params.hubUrl,
    "--caller",
    params.callerAgent,
    "--caller-session",
    params.callerSession,
    "--depth",
    String(params.depth),
    ...extraGroupArgs,
  ];

  const jsExists = fs.existsSync(mcpJs);
  const tsExists = fs.existsSync(mcpTs);
  const jsFresh =
    jsExists && (!tsExists || fs.statSync(mcpJs).mtimeMs >= fs.statSync(mcpTs).mtimeMs - 500);

  if (jsFresh) {
    return {
      command: process.execPath,
      args: [mcpJs, ...commonFlags],
    };
  }

  if (tsExists && fs.existsSync(tsxCli)) {
    return {
      command: process.execPath,
      args: [tsxCli, mcpTs, ...commonFlags],
    };
  }

  return {
    command: process.execPath,
    args: [mcpJs, ...commonFlags],
  };
}

function readClaudeSettingsEnv(): Record<string, string> {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { env?: Record<string, unknown> };
    const out: Record<string, string> = {};
    if (parsed.env && typeof parsed.env === "object") {
      for (const [k, v] of Object.entries(parsed.env)) {
        if (typeof v === "string" && v.trim()) {
          out[k] = v;
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

export interface AgentAuthResult {
  authReady: boolean;
  authHint?: string;
}

/**
 * An auth check that needs a child process. Kept as data so the same probe can run
 * synchronously (CLI `status`) or asynchronously (hub server, cached by the registry).
 */
export interface AuthProbeSpec {
  /** Stable cache key: agent + probe kind + executable. */
  key: string;
  command: string;
  args: string[];
  timeoutMs: number;
  /** Returns true when stdout of a zero-exit run proves the agent is logged in. */
  interpret: (stdout: string) => boolean;
  failHint: string;
}

export type AgentAuthPlan = { result: AgentAuthResult } | { probe: AuthProbeSpec };

function interpretProbeOutput(
  spec: AuthProbeSpec,
  exitOk: boolean,
  stdout: string | undefined | null,
): AgentAuthResult {
  try {
    if (exitOk && stdout && spec.interpret(stdout)) {
      return { authReady: true };
    }
  } catch {
    // Fall through to authHint
  }
  return { authReady: false, authHint: spec.failHint };
}

export function runAuthProbeSync(spec: AuthProbeSpec): AgentAuthResult {
  try {
    const res = spawnSync(spec.command, spec.args, {
      encoding: "utf8",
      timeout: spec.timeoutMs,
      windowsHide: true,
    });
    return interpretProbeOutput(spec, res.status === 0, res.stdout);
  } catch {
    return { authReady: false, authHint: spec.failHint };
  }
}

export function runAuthProbe(spec: AuthProbeSpec): Promise<AgentAuthResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        spec.command,
        spec.args,
        { encoding: "utf8", timeout: spec.timeoutMs, windowsHide: true },
        (err, stdout) => resolve(interpretProbeOutput(spec, !err, stdout)),
      );
    } catch {
      resolve({ authReady: false, authHint: spec.failHint });
    }
  });
}

/**
 * Cheap part of the auth check (env vars, secrets, credential files). Returns a final
 * result when that is enough, otherwise the child-process probe that still has to run.
 */
export function planAgentAuth(
  agent: AgentId,
  localSecrets: Record<string, string>,
  customDef?: AgentDefinition,
): AgentAuthPlan {
  if (agent === "claude") {
    const claudeEnv = readClaudeSettingsEnv();
    const hasKey = Boolean(
      process.env.ANTHROPIC_API_KEY ||
        process.env.ANTHROPIC_AUTH_TOKEN ||
        localSecrets.ANTHROPIC_API_KEY ||
        localSecrets.ANTHROPIC_AUTH_TOKEN ||
        claudeEnv.ANTHROPIC_API_KEY ||
        claudeEnv.ANTHROPIC_AUTH_TOKEN,
    );
    if (hasKey) {
      return { result: { authReady: true } };
    }

    const reclaudeExe = resolveReclaudeExecutable(localSecrets);
    if (reclaudeExe) {
      return {
        probe: {
          key: `claude:reclaude:${reclaudeExe}`,
          command: reclaudeExe,
          args: ["status"],
          timeoutMs: 4000,
          interpret: (stdout) => {
            const claudeBlock = stdout.match(/\[claude\]([\s\S]*?)(?:\r?\n\[|$)/i)?.[1] ?? "";
            // reclaude localizes its output by LANG, so accept both the Chinese and English wording.
            const hasLocalBind = /(?:本机绑定|local bindings?)[：:]\s*[1-9]\d*/i.test(claudeBlock);
            const hasDefaultOrg =
              /(?:缺省组织|default organization)[：:]\s*\S+/i.test(claudeBlock) &&
              !/未登录|not logged in/i.test(claudeBlock);
            return hasLocalBind || hasDefaultOrg;
          },
          failHint: "reclaude 未绑定 Claude 账号：请运行 reclaude login 完成绑定",
        },
      };
    }

    const viaCmd = process.platform === "win32";
    return {
      probe: {
        key: "claude:cli-auth-status",
        command: viaCmd ? "cmd.exe" : "claude",
        args: viaCmd ? ["/d", "/c", "claude", "auth", "status"] : ["auth", "status"],
        timeoutMs: 4000,
        interpret: (stdout) => (JSON.parse(stdout) as { loggedIn?: boolean }).loggedIn === true,
        failHint: "Claude CLI 未登录：请运行 claude login，或在 .rtm/secrets.json 配置 ANTHROPIC_API_KEY",
      },
    };
  }

  if (agent === "codex") {
    const codexAuthFile = path.join(os.homedir(), ".codex", "auth.json");
    const hasAuth = Boolean(
      process.env.OPENAI_API_KEY ||
        localSecrets.OPENAI_API_KEY ||
        fs.existsSync(codexAuthFile),
    );
    return {
      result: hasAuth
        ? { authReady: true }
        : {
            authReady: false,
            authHint: "Codex 未认证：请运行 codex login 或在环境变量/.rtm/secrets.json 配置 OPENAI_API_KEY",
          },
    };
  }

  if (agent === "opencode") {
    const ocDataAuth = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
    const ocConfig = path.join(os.homedir(), ".config", "opencode", "opencode.json");
    const hasAuth = Boolean(
      process.env.OPENCODE_API_KEY ||
        process.env.OPENAI_API_KEY ||
        process.env.ANTHROPIC_API_KEY ||
        localSecrets.OPENCODE_API_KEY ||
        customDef?.env?.OPENCODE_API_KEY ||
        fs.existsSync(ocDataAuth) ||
        fs.existsSync(ocConfig),
    );
    return {
      result: hasAuth
        ? { authReady: true }
        : {
            authReady: false,
            authHint: "OpenCode 未检测到配置或凭证：请运行 opencode auth login 或检查 ~/.config/opencode/opencode.json",
          },
    };
  }

  if (agent === "kimi") {
    const kimiCredsDir = path.join(os.homedir(), ".kimi-code", "credentials");
    const kimiLegacyCredsDir = path.join(os.homedir(), ".kimi", "credentials");
    const hasCredDir = (dir: string) => {
      if (!fs.existsSync(dir)) return false;
      try {
        return fs.readdirSync(dir).length > 0;
      } catch {
        return false;
      }
    };
    const hasAuth = Boolean(
      process.env.KIMI_API_KEY ||
        process.env.MOONSHOT_API_KEY ||
        localSecrets.KIMI_API_KEY ||
        localSecrets.MOONSHOT_API_KEY ||
        customDef?.env?.KIMI_API_KEY ||
        hasCredDir(kimiCredsDir) ||
        hasCredDir(kimiLegacyCredsDir),
    );
    return {
      result: hasAuth
        ? { authReady: true }
        : {
            authReady: false,
            authHint: "Kimi CLI 未检测到登录凭证：请运行 kimi login 或在环境变量配置 KIMI_API_KEY",
          },
    };
  }

  if (agent === "agy") {
    const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY || localSecrets.GEMINI_API_KEY);
    if (hasGeminiKey) {
      return { result: { authReady: true } };
    }

    const adapterMode = (process.env.AGY_ADAPTER_MODE || localSecrets.AGY_ADAPTER_MODE || "").toLowerCase();
    const agyExe = adapterMode === "sdk" ? undefined : resolveAgyExecutable(localSecrets);
    if (agyExe) {
      const failHint =
        "Antigravity CLI 已安装但未登录：请在终端运行 agy 或 agy acp --login 完成一次 Google 账号登录（无需配置 GEMINI_API_KEY）";
      if (process.platform === "win32") {
        return {
          probe: {
            key: "agy:cmdkey",
            command: "cmdkey",
            args: ["/list"],
            timeoutMs: 3000,
            interpret: (stdout) => /gemini:antigravity/i.test(stdout),
            failHint,
          },
        };
      }
      const cliDir = path.join(os.homedir(), ".gemini", "antigravity-cli");
      const hasCreds =
        fs.existsSync(path.join(cliDir, "oauth_creds.json")) ||
        fs.existsSync(path.join(cliDir, "credentials.json"));
      return { result: hasCreds ? { authReady: true } : { authReady: false, authHint: failHint } };
    }

    return {
      result: {
        authReady: false,
        authHint: "未检测到 GEMINI_API_KEY：请在环境变量或 .rtm/secrets.json 中设置以启用 google-antigravity SDK",
      },
    };
  }

  if (agent === "devin") {
    // `devin auth login` stores its token here; the CLI answers every prompt with
    // "Please log in" without it.
    const credentials =
      process.platform === "win32" && process.env.APPDATA
        ? path.join(process.env.APPDATA, "devin", "credentials.toml")
        : path.join(os.homedir(), ".config", "devin", "credentials.toml");
    let loggedIn = false;
    try {
      loggedIn = fs.statSync(credentials).size > 0;
    } catch {
      loggedIn = false;
    }
    const exe = resolveDevinExecutable(localSecrets);
    return {
      result: loggedIn
        ? { authReady: true }
        : {
            authReady: false,
            authHint: `Devin 命令行未登录：请在终端运行 "${exe ?? "devin"}" auth login`,
          },
    };
  }

  return { result: { authReady: true } };
}

/**
 * The command that signs an agent's CLI in, for the agents whose command is known. Signing in
 * is interactive (it opens a browser or asks for a code), so it runs in a terminal window the
 * user can see, never inside the hub.
 */
export function resolveAgentLoginCommand(
  agent: AgentId,
  localSecrets: Record<string, string> = loadLocalSecrets(),
): { command: string; args: string[] } | undefined {
  if (agent === "devin") {
    const exe = resolveDevinExecutable(localSecrets);
    return exe ? { command: exe, args: ["auth", "login"] } : undefined;
  }
  if (agent === "kimi") {
    const exe = resolveKimiExecutable(localSecrets);
    return exe ? { command: exe, args: ["login"] } : undefined;
  }
  if (agent === "opencode") {
    const exe = resolveOpencodeExecutable(localSecrets);
    return exe ? { command: exe, args: ["auth", "login"] } : undefined;
  }
  if (agent === "codex") {
    const entry = path.join(PROJECT_ROOT, "node_modules", "@openai", "codex", "bin", "codex.js");
    return fs.existsSync(entry) ? { command: process.execPath, args: [entry, "login"] } : undefined;
  }
  if (agent === "agy") {
    const exe = resolveAgyExecutable(localSecrets);
    return exe ? { command: exe, args: [] } : undefined;
  }
  return undefined;
}

/**
 * Opens a terminal window running `command`. Returns the command line as shown to the user.
 * The window stays open afterwards so the result can be read.
 */
export function openTerminalWindow(title: string, command: string, args: string[]): string {
  const quote = (s: string) => (/[\s"&()^]/.test(s) || s === "" ? `"${s.replace(/"/g, '\\"')}"` : s);
  const line = [command, ...args].map(quote).join(" ");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtm-login-"));
  if (process.platform === "win32") {
    const script = path.join(dir, "login.cmd");
    fs.writeFileSync(
      script,
      ["@echo off", "chcp 65001 >nul", `title ${title}`, line, "echo.", "echo Done. You can close this window and go back to RTM.", "pause >nul", ""].join("\r\n"),
      "utf8",
    );
    const child = spawn("cmd.exe", ["/c", "start", "", script], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    return line;
  }
  const script = path.join(dir, "login.command");
  fs.writeFileSync(
    script,
    ["#!/bin/sh", line, "echo", 'echo "Done. You can close this window and go back to RTM."', ""].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  if (process.platform === "darwin") {
    spawn("open", [script], { detached: true, stdio: "ignore" }).unref();
    return line;
  }
  const terminal = findExecutableInPath(["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]);
  if (!terminal) {
    throw new Error(`没有找到可用的终端程序，请手动运行：${line}`);
  }
  spawn(terminal, ["-e", script], { detached: true, stdio: "ignore" }).unref();
  return line;
}

/**
 * Checks whether local entrypoints for each adapter exist on disk and whether local auth is ready.
 * Auth checks that need a child process go through `resolveProbe`; the default runs them
 * synchronously (blocking), callers on a hot path pass a cache lookup instead.
 */
export function checkAdaptersHealth(
  definitions?: AgentDefinition[],
  resolveProbe: (spec: AuthProbeSpec, def: AgentDefinition) => AgentAuthResult = runAuthProbeSync,
): AdapterHealth[] {
  const localSecrets = loadLocalSecrets();
  const defs: AgentDefinition[] =
    definitions ??
    ALL_AGENTS.map((id) => ({
      id,
      label: id,
      color: "#0d7148",
      enabled: true,
      builtin: true,
    }));

  return defs.map((def) => {
    const agent = def.id;
    const resolved = resolveAdapterCommand(agent, def);
    const argv = [resolved.command, ...resolved.args];
    const targetFile = resolved.entrypointFile;
    const plan = planAgentAuth(agent, localSecrets, def);
    const auth = "result" in plan ? plan.result : resolveProbe(plan.probe, def);
    const base: Omit<AdapterHealth, "available"> = {
      agent,
      label: def.label,
      color: def.color,
      darkColor: def.darkColor,
      description: def.description,
      builtin: def.builtin,
      enabled: def.enabled,
      authReady: auth.authReady,
      authHint: auth.authHint,
      canLogin: Boolean(resolveAgentLoginCommand(agent, localSecrets)),
      command: argv,
      customCommand: def.command,
      customArgs: def.args,
      defaultModel: def.defaultModel,
      defaultEffort: def.defaultEffort,
      models: def.models,
      env: def.env,
    };

    const cmdExists =
      fs.existsSync(resolved.command) ||
      (!path.isAbsolute(resolved.command) && Boolean(findExecutableInPath([resolved.command])));
    if (!cmdExists) {
      return {
        ...base,
        available: false,
        reason: `Executable not found: ${resolved.command}`,
      };
    }
    if (targetFile && !fs.existsSync(targetFile)) {
      return {
        ...base,
        available: false,
        reason: `Adapter entrypoint not found: ${targetFile}`,
      };
    }
    return {
      ...base,
      available: true,
    };
  });
}

/**
 * Picks the best default lead agent based on local availability and authentication readiness.
 */
export function pickDefaultLead(preferred?: AgentId): AgentId {
  if (preferred) {
    return preferred;
  }
  const health = checkAdaptersHealth();
  const ready = health.find((h) => h.available && h.authReady);
  return ready?.agent ?? "claude";
}

/**
 * Terminates a child process and its entire descendant tree on Windows/POSIX.
 */
export function killProcessTree(pid: number | undefined): void {
  if (!pid || pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      // Fall through to process.kill
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process already exited
  }
}
