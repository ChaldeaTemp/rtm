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
  env?: Record<string, string>;
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
    const entry = path.join(
      PROJECT_ROOT,
      "node_modules",
      "@agentclientprotocol",
      "claude-agent-acp",
      "dist",
      "index.js",
    );
    return {
      command: process.execPath,
      args: [entry],
      env: Object.keys(localSecrets).length ? localSecrets : undefined,
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
  return hasGeminiKey
    ? { authReady: true }
    : {
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
    const targetFile = resolved.args[0];
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
