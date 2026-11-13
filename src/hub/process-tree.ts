import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterHealth, AgentId } from "../types.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(THIS_DIR, "../..");

export interface ResolvedCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Resolves a Windows-safe direct executable and argument list for each supported ACP adapter.
 */
export function resolveAdapterCommand(agent: AgentId): ResolvedCommand {
  if (agent === "claude") {
    const entry = path.join(
      PROJECT_ROOT,
      "node_modules",
      "@agentclientprotocol",
      "claude-agent-acp",
      "dist",
      "index.js",
    );
    return { command: process.execPath, args: [entry] };
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
    return { command: process.execPath, args: [entry] };
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

/**
 * Checks whether local entrypoints for each adapter exist on disk.
 */
export function checkAdaptersHealth(): AdapterHealth[] {
  const agents: AgentId[] = ["claude", "codex", "agy"];
  return agents.map((agent) => {
    const resolved = resolveAdapterCommand(agent);
    const argv = [resolved.command, ...resolved.args];
    const targetFile = resolved.args[0];
    if (!fs.existsSync(resolved.command)) {
      return {
        agent,
        available: false,
        command: argv,
        reason: `Executable not found: ${resolved.command}`,
      };
    }
    if (targetFile && !fs.existsSync(targetFile)) {
      return {
        agent,
        available: false,
        command: argv,
        reason: `Adapter entrypoint not found: ${targetFile}`,
      };
    }
    return {
      agent,
      available: true,
      command: argv,
    };
  });
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
