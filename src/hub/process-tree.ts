import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_AGENTS, type AdapterHealth, type AgentDefinition, type AgentId } from "../types.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(THIS_DIR, "../..");
const LOCAL_SECRETS_FILE = path.join(PROJECT_ROOT, ".agent-hub", "secrets.json");

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

function resolveGenericCommand(
  rawCommand: string,
  args: string[],
  env?: Record<string, string>,
): ResolvedCommand {
  const trimmed = rawCommand.trim();
  const isPathLike = trimmed.includes("/") || trimmed.includes("\\") || path.isAbsolute(trimmed);
  let resolvedCmd = trimmed;
  if (isPathLike) {
    resolvedCmd = path.isAbsolute(trimmed) ? trimmed : path.resolve(PROJECT_ROOT, trimmed);
  } else {
    const pathCandidates =
      process.platform === "win32"
        ? [trimmed, `${trimmed}.exe`, `${trimmed}.cmd`, `${trimmed}.bat`]
        : [trimmed];
    resolvedCmd = findExecutableInPath(pathCandidates) ?? trimmed;
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
 * Reads optional local API keys/tokens from .agent-hub/secrets.json without touching global user configs.
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
    return {
      command: opencodeExe ?? (process.platform === "win32" ? "opencode.exe" : "opencode"),
      args: customDef?.args?.length ? customDef.args : ["acp"],
      env: envOut,
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
 * Resolves the direct Node + tsx CLI command for spawning the local peer MCP server without .cmd shims.
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

  if (fs.existsSync(mcpTs) && fs.existsSync(tsxCli)) {
    return {
      command: process.execPath,
      args: [
        tsxCli,
        mcpTs,
        "--hub-url",
        params.hubUrl,
        "--caller",
        params.callerAgent,
        "--caller-session",
        params.callerSession,
        "--depth",
        String(params.depth),
        ...extraGroupArgs,
      ],
    };
  }

  return {
    command: process.execPath,
    args: [
      mcpJs,
      "--hub-url",
      params.hubUrl,
      "--caller",
      params.callerAgent,
      "--caller-session",
      params.callerSession,
      "--depth",
      String(params.depth),
      ...extraGroupArgs,
    ],
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

function checkAgentAuthReady(
  agent: AgentId,
  localSecrets: Record<string, string>,
  customDef?: AgentDefinition,
): {
  authReady: boolean;
  authHint?: string;
} {
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
      return { authReady: true };
    }

    const reclaudeExe = resolveReclaudeExecutable(localSecrets);
    if (reclaudeExe) {
      try {
        const res = spawnSync(reclaudeExe, ["status"], {
          encoding: "utf8",
          timeout: 4000,
          windowsHide: true,
        });
        if (res.status === 0 && res.stdout) {
          const claudeBlock = res.stdout.match(/\[claude\]([\s\S]*?)(?:\r?\n\[|$)/i)?.[1] ?? "";
          const hasLocalBind = /本机绑定[：:]\s*[1-9]\d*/.test(claudeBlock);
          const hasDefaultOrg = /缺省组织[：:]\s*\S+/.test(claudeBlock) && !/未登录/.test(claudeBlock);
          if (hasLocalBind || hasDefaultOrg) {
            return { authReady: true };
          }
        }
      } catch {
        // Fall through to reclaude authHint
      }
      return {
        authReady: false,
        authHint: "reclaude 未绑定 Claude 账号：请运行 reclaude login 完成绑定",
      };
    }

    try {
      const res =
        process.platform === "win32"
          ? spawnSync("cmd.exe", ["/d", "/c", "claude", "auth", "status"], {
              encoding: "utf8",
              timeout: 4000,
              windowsHide: true,
            })
          : spawnSync("claude", ["auth", "status"], {
              encoding: "utf8",
              timeout: 4000,
            });
      if (res.status === 0 && res.stdout) {
        const parsed = JSON.parse(res.stdout) as { loggedIn?: boolean };
        if (parsed.loggedIn === true) {
          return { authReady: true };
        }
      }
    } catch {
      // Fall through to authHint
    }

    return {
      authReady: false,
      authHint: "Claude CLI 未登录：请运行 claude login，或在 .agent-hub/secrets.json 配置 ANTHROPIC_API_KEY",
    };
  }

  if (agent === "codex") {
    const codexAuthFile = path.join(os.homedir(), ".codex", "auth.json");
    const hasAuth = Boolean(
      process.env.OPENAI_API_KEY ||
        localSecrets.OPENAI_API_KEY ||
        fs.existsSync(codexAuthFile),
    );
    return hasAuth
      ? { authReady: true }
      : {
          authReady: false,
          authHint: "Codex 未认证：请运行 codex login 或在环境变量/.agent-hub/secrets.json 配置 OPENAI_API_KEY",
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
    return hasAuth
      ? { authReady: true }
      : {
          authReady: false,
          authHint: "OpenCode 未检测到配置或凭证：请运行 opencode auth login 或检查 ~/.config/opencode/opencode.json",
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
    return hasAuth
      ? { authReady: true }
      : {
          authReady: false,
          authHint: "Kimi CLI 未检测到登录凭证：请运行 kimi login 或在环境变量配置 KIMI_API_KEY",
        };
  }

  if (agent === "agy") {
    const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY || localSecrets.GEMINI_API_KEY);
    if (hasGeminiKey) {
      return { authReady: true };
    }

    const adapterMode = (process.env.AGY_ADAPTER_MODE || localSecrets.AGY_ADAPTER_MODE || "").toLowerCase();
    const agyExe = adapterMode === "sdk" ? undefined : resolveAgyExecutable(localSecrets);
    if (agyExe) {
      if (process.platform === "win32") {
        try {
          const res = spawnSync("cmdkey", ["/list"], {
            encoding: "utf8",
            timeout: 3000,
            windowsHide: true,
          });
          if (res.status === 0 && /gemini:antigravity/i.test(res.stdout ?? "")) {
            return { authReady: true };
          }
        } catch {
          // Fall through to authHint
        }
      } else {
        const cliDir = path.join(os.homedir(), ".gemini", "antigravity-cli");
        if (
          fs.existsSync(path.join(cliDir, "oauth_creds.json")) ||
          fs.existsSync(path.join(cliDir, "credentials.json"))
        ) {
          return { authReady: true };
        }
      }
      return {
        authReady: false,
        authHint:
          "Antigravity CLI 已安装但未登录：请在终端运行 agy 或 agy acp --login 完成一次 Google 账号登录（无需配置 GEMINI_API_KEY）",
      };
    }

    return {
      authReady: false,
      authHint: "未检测到 GEMINI_API_KEY：请在环境变量或 .agent-hub/secrets.json 中设置以启用 google-antigravity SDK",
    };
  }

  return { authReady: true };
}

/**
 * Checks whether local entrypoints for each adapter exist on disk and whether local auth is ready.
 */
export function checkAdaptersHealth(definitions?: AgentDefinition[]): AdapterHealth[] {
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
    const auth = checkAgentAuthReady(agent, localSecrets, def);
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
      command: argv,
      customCommand: def.command,
      customArgs: def.args,
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
