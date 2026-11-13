import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterHealth, AgentId } from "../types.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(THIS_DIR, "../..");
const LOCAL_SECRETS_FILE = path.join(PROJECT_ROOT, ".agent-hub", "secrets.json");

export interface ResolvedCommand {
  command: string;
  args: string[];
  entrypointFile?: string;
  env?: Record<string, string>;
}

function findExecutableInPath(names: string[]): string | undefined {
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
export function resolveAdapterCommand(agent: AgentId): ResolvedCommand {
  const localSecrets = loadLocalSecrets();

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
    const env: Record<string, string> = { ...localSecrets };
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
      env: Object.keys(localSecrets).length ? localSecrets : undefined,
    };
  }

  const adapterMode = (process.env.AGY_ADAPTER_MODE || localSecrets.AGY_ADAPTER_MODE || "").toLowerCase();
  const agyExe = adapterMode === "sdk" ? undefined : resolveAgyExecutable(localSecrets);
  if (agyExe) {
    return {
      command: agyExe,
      args: ["acp"],
      env: Object.keys(localSecrets).length ? localSecrets : undefined,
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
      ...localSecrets,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
  };
}

/**
 * Resolves the direct Node + tsx CLI command for spawning the local peer MCP server without .cmd shims.
 */
export function resolvePeerMcpLaunch(params: {
  hubUrl: string;
  callerAgent: AgentId;
  callerSession: string;
  depth: number;
}): { command: string; args: string[] } {
  const tsxCli = path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const mcpTs = path.join(PROJECT_ROOT, "src", "mcp", "peer-mcp-server.ts");
  const mcpJs = path.join(PROJECT_ROOT, "dist", "mcp", "peer-mcp-server.js");

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

function checkAgentAuthReady(agent: AgentId, localSecrets: Record<string, string>): {
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

/**
 * Checks whether local entrypoints for each adapter exist on disk and whether local auth is ready.
 */
export function checkAdaptersHealth(): AdapterHealth[] {
  const localSecrets = loadLocalSecrets();
  const agents: AgentId[] = ["claude", "codex", "agy"];
  return agents.map((agent) => {
    const resolved = resolveAdapterCommand(agent);
    const argv = [resolved.command, ...resolved.args];
    const targetFile = resolved.entrypointFile;
    const auth = checkAgentAuthReady(agent, localSecrets);
    if (!fs.existsSync(resolved.command)) {
      return {
        agent,
        available: false,
        authReady: auth.authReady,
        authHint: auth.authHint,
        command: argv,
        reason: `Executable not found: ${resolved.command}`,
      };
    }
    if (targetFile && !fs.existsSync(targetFile)) {
      return {
        agent,
        available: false,
        authReady: auth.authReady,
        authHint: auth.authHint,
        command: argv,
        reason: `Adapter entrypoint not found: ${targetFile}`,
      };
    }
    return {
      agent,
      available: true,
      authReady: auth.authReady,
      authHint: auth.authHint,
      command: argv,
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
