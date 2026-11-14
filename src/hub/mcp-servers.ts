import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentId } from "../types.js";
import { t } from "./i18n.js";

/**
 * MCP servers shared across agents.
 *
 * Every agent CLI keeps its own list of MCP servers, so the same server has to be configured
 * once per agent. The hub reads the lists that already exist (Codex, Claude, a project's
 * `.mcp.json`) plus its own, and passes the servers the user switched on to the agents that
 * do not have them, in `session/new`. Nothing is written into any agent's own configuration.
 *
 * Limits that keep this safe and cheap:
 *  - a discovered server is off until the user switches it on;
 *  - it goes to lead sessions only unless sub-sessions are ticked as well: every stdio server
 *    is one more process per session, and a workflow starts many sessions;
 *  - a project's `.mcp.json` runs commands chosen by whoever wrote the repository, so it needs
 *    the user's approval, and the approval is for that exact content;
 *  - a server whose environment variables are missing is not started.
 */

export type McpTransport = "stdio" | "http";
export type McpSource = "rtm" | "codex" | "claude" | "project";
export type McpRole = "lead" | "sub";

export interface McpServerDef {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Names of variables to copy from the hub's own environment (Codex `env_vars`). */
  envVars?: string[];
  url?: string;
  headers?: Record<string, string>;
}

export interface SharedMcpServer extends McpServerDef {
  id: string;
  source: McpSource;
  sourcePath: string;
  /** Agents that load this server from their own configuration; the hub does not add it there. */
  nativeAgents: AgentId[];
  enabled: boolean;
  roles: McpRole[];
  disabledAgents: AgentId[];
  /** Variables the definition refers to that are not set. */
  missingEnv: string[];
  /** False for a project file the user has not approved in its current form. */
  trusted: boolean;
}

/** What goes into ACP `session/new`. */
export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
  | { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> };

interface StoredState {
  servers: McpServerDef[];
  state: Record<string, { enabled?: boolean; roles?: McpRole[]; disabledAgents?: string[] }>;
  /** Approved project files: absolute path -> sha256 of the approved content. */
  trust: Record<string, string>;
}

const RESERVED_NAMES = new Set(["agent-hub-peers"]);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Replaces `${VAR}` and `${VAR:-default}`; collects the names that have no value. */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv, missing: Set<string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
    const found = env[name];
    if (found !== undefined && found !== "") return found;
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return "";
  });
}

function parseTomlValue(raw: string): unknown {
  const text = raw.trim();
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\"));
    } catch {
      return text.slice(1, text.lastIndexOf('"'));
    }
  }
  if (text.startsWith("'")) return text.slice(1, text.lastIndexOf("'"));
  if (text.startsWith("[")) {
    const items: unknown[] = [];
    const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) items.push(m[2] !== undefined ? m[2] : parseTomlValue(`"${m[1]}"`));
    return items;
  }
  if (text === "true" || text === "false") return text === "true";
  const num = Number(text);
  return Number.isFinite(num) ? num : text;
}

/**
 * Reads the `[mcp_servers.<name>]` tables (and their `.env` sub-tables) of a Codex config.
 * Only the small subset of TOML those tables use: one `key = value` per line.
 */
export function parseCodexMcpServers(toml: string): McpServerDef[] {
  const tables = new Map<string, { main: Record<string, unknown>; env: Record<string, unknown> }>();
  let current: Record<string, unknown> | undefined;
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = undefined;
      const m = /^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))(\.env)?$/.exec(header[1]!.trim());
      if (m) {
        const name = (m[1] ?? m[2] ?? m[3])!;
        const table = tables.get(name) ?? { main: {}, env: {} };
        tables.set(name, table);
        current = m[4] ? table.env : table.main;
      }
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    current[line.slice(0, eq).trim().replace(/^["']|["']$/g, "")] = parseTomlValue(line.slice(eq + 1));
  }
  const out: McpServerDef[] = [];
  for (const [name, { main, env }] of tables) {
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const envMap = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)]));
    if (typeof main.url === "string" && main.url) {
      out.push({ name, transport: "http", url: main.url });
    } else if (typeof main.command === "string" && main.command) {
      out.push({ name, transport: "stdio", command: main.command, args: strings(main.args), env: envMap, envVars: strings(main.env_vars) });
    }
  }
  return out;
}

/** Reads a `mcpServers` object in the JSON shape Claude Code and `.mcp.json` use. */
export function parseJsonMcpServers(raw: unknown): McpServerDef[] {
  if (!raw || typeof raw !== "object") return [];
  const out: McpServerDef[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const record = (x: unknown): Record<string, string> =>
      x && typeof x === "object" ? Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, val]) => [k, String(val)])) : {};
    if ((v.type === "http" || v.type === "streamable-http" || (!v.command && typeof v.url === "string")) && typeof v.url === "string") {
      if (v.type === "sse") continue;
      out.push({ name, transport: "http", url: v.url, headers: record(v.headers) });
    } else if (typeof v.command === "string" && v.command) {
      out.push({
        name,
        transport: "stdio",
        command: v.command,
        args: Array.isArray(v.args) ? v.args.map(String) : [],
        env: record(v.env),
      });
    }
  }
  return out;
}

export class McpServerManager {
  constructor(
    private readonly file: string,
    private readonly homeDir = os.homedir(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private load(): StoredState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<StoredState>;
      return {
        servers: Array.isArray(parsed.servers) ? parsed.servers : [],
        state: parsed.state && typeof parsed.state === "object" ? parsed.state : {},
        trust: parsed.trust && typeof parsed.trust === "object" ? parsed.trust : {},
      };
    } catch {
      return { servers: [], state: {}, trust: {} };
    }
  }

  private store(state: StoredState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  private readText(file: string): string | undefined {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  }

  /** Every server the hub knows about for a project directory, with its switches. */
  list(cwd?: string): SharedMcpServer[] {
    const stored = this.load();
    const found: Array<{ def: McpServerDef; source: McpSource; sourcePath: string; native: AgentId[]; trusted: boolean }> = [];

    for (const def of stored.servers) {
      found.push({ def, source: "rtm", sourcePath: this.file, native: [], trusted: true });
    }

    const codexFile = path.join(this.env.CODEX_HOME?.trim() || path.join(this.homeDir, ".codex"), "config.toml");
    const codexText = this.readText(codexFile);
    if (codexText) {
      for (const def of parseCodexMcpServers(codexText)) {
        found.push({ def, source: "codex", sourcePath: codexFile, native: ["codex"], trusted: true });
      }
    }

    const claudeFile = path.join(this.env.CLAUDE_CONFIG_DIR?.trim() || this.homeDir, ".claude.json");
    const claudeText = this.readText(claudeFile);
    if (claudeText) {
      try {
        const parsed = JSON.parse(claudeText) as { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> };
        const scoped = cwd
          ? Object.entries(parsed.projects ?? {}).find(([dir]) => path.resolve(dir).toLowerCase() === path.resolve(cwd).toLowerCase())?.[1]
          : undefined;
        for (const def of [...parseJsonMcpServers(parsed.mcpServers), ...parseJsonMcpServers(scoped?.mcpServers)]) {
          found.push({ def, source: "claude", sourcePath: claudeFile, native: ["claude"], trusted: true });
        }
      } catch {
        // Not valid JSON right now (Claude rewrites this file often): skip it this time.
      }
    }

    if (cwd) {
      const projectFile = path.join(path.resolve(cwd), ".mcp.json");
      const projectText = this.readText(projectFile);
      if (projectText) {
        const trusted = stored.trust[projectFile] === sha256(projectText);
        try {
          const parsed = JSON.parse(projectText) as { mcpServers?: unknown };
          for (const def of parseJsonMcpServers(parsed.mcpServers)) {
            // Claude Code reads a project's .mcp.json itself (after its own approval prompt).
            found.push({ def, source: "project", sourcePath: projectFile, native: ["claude"], trusted });
          }
        } catch {
          // Broken file: nothing to offer.
        }
      }
    }

    const seen = new Set<string>();
    const out: SharedMcpServer[] = [];
    for (const item of found) {
      const id = `${item.source}:${item.def.name}`;
      if (seen.has(id) || RESERVED_NAMES.has(item.def.name)) continue;
      seen.add(id);
      const switches = stored.state[id] ?? {};
      const missing = new Set<string>();
      const expand = (v: string) => expandEnvRefs(v, this.env, missing);
      const def: McpServerDef = {
        ...item.def,
        command: item.def.command !== undefined ? expand(item.def.command) : undefined,
        args: item.def.args?.map(expand),
        env: item.def.env ? Object.fromEntries(Object.entries(item.def.env).map(([k, v]) => [k, expand(v)])) : undefined,
        url: item.def.url !== undefined ? expand(item.def.url) : undefined,
        headers: item.def.headers ? Object.fromEntries(Object.entries(item.def.headers).map(([k, v]) => [k, expand(v)])) : undefined,
      };
      out.push({
        ...def,
        id,
        source: item.source,
        sourcePath: item.sourcePath,
        nativeAgents: item.native,
        // Servers the user added here are meant to be shared; discovered ones are opt-in.
        enabled: switches.enabled ?? item.source === "rtm",
        roles: switches.roles?.length ? switches.roles : ["lead"],
        disabledAgents: (switches.disabledAgents ?? []).map((a) => a.toLowerCase()),
        missingEnv: [...missing],
        trusted: item.trusted,
      });
    }
    return out;
  }

  /** The servers to pass to one session, in ACP form. */
  forSession(input: { agent: AgentId; role: McpRole; cwd?: string; httpSupported: boolean }): AcpMcpServer[] {
    const names = new Set<string>(RESERVED_NAMES);
    const out: AcpMcpServer[] = [];
    for (const server of this.list(input.cwd)) {
      if (!server.enabled || !server.trusted || server.missingEnv.length > 0) continue;
      if (!server.roles.includes(input.role)) continue;
      if (server.disabledAgents.includes(input.agent) || server.nativeAgents.includes(input.agent)) continue;
      if (names.has(server.name)) continue;
      if (server.transport === "http") {
        if (!input.httpSupported || !server.url) continue;
        names.add(server.name);
        out.push({
          type: "http",
          name: server.name,
          url: server.url,
          headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
        });
      } else if (server.command) {
        names.add(server.name);
        const env = { ...(server.env ?? {}) };
        for (const name of server.envVars ?? []) {
          const value = this.env[name];
          if (value !== undefined && env[name] === undefined) env[name] = value;
        }
        out.push({
          name: server.name,
          command: server.command,
          args: server.args ?? [],
          env: Object.entries(env).map(([name, value]) => ({ name, value })),
        });
      }
    }
    return out;
  }

  /** Changes a server's switches. Fields left out keep their value. */
  setState(id: string, patch: { enabled?: boolean; roles?: McpRole[]; agent?: AgentId; agentEnabled?: boolean }): void {
    const stored = this.load();
    const current = stored.state[id] ?? {};
    if (patch.enabled !== undefined) current.enabled = patch.enabled;
    if (patch.roles) {
      const roles = [...new Set(patch.roles.filter((r) => r === "lead" || r === "sub"))];
      current.roles = roles.length > 0 ? roles : ["lead"];
    }
    if (patch.agent && patch.agentEnabled !== undefined) {
      const set = new Set((current.disabledAgents ?? []).map((a) => a.toLowerCase()));
      if (patch.agentEnabled) set.delete(patch.agent);
      else set.add(patch.agent);
      current.disabledAgents = [...set].sort();
    }
    stored.state[id] = current;
    this.store(stored);
  }

  /** Adds or replaces a server kept by the hub itself. */
  save(def: McpServerDef): void {
    const name = (def.name ?? "").trim();
    if (!NAME_RE.test(name)) throw new Error(t("mcpErrName"));
    if (RESERVED_NAMES.has(name)) throw new Error(t("mcpErrReserved", name));
    const clean: McpServerDef =
      def.transport === "http"
        ? { name, transport: "http", url: (def.url ?? "").trim(), headers: def.headers ?? {} }
        : { name, transport: "stdio", command: (def.command ?? "").trim(), args: def.args ?? [], env: def.env ?? {} };
    if (clean.transport === "http" && !/^https?:\/\//i.test(clean.url ?? "")) throw new Error(t("mcpErrUrl"));
    if (clean.transport === "stdio" && !clean.command) throw new Error(t("mcpErrCommand"));
    const stored = this.load();
    stored.servers = [...stored.servers.filter((s) => s.name !== name), clean];
    this.store(stored);
  }

  delete(name: string): void {
    const stored = this.load();
    stored.servers = stored.servers.filter((s) => s.name !== name);
    delete stored.state[`rtm:${name}`];
    this.store(stored);
  }

  /** Approves (or withdraws approval of) a project's `.mcp.json` as it is right now. */
  setProjectTrust(cwd: string, trusted: boolean): void {
    const projectFile = path.join(path.resolve(cwd), ".mcp.json");
    const stored = this.load();
    if (trusted) {
      const text = this.readText(projectFile);
      if (text === undefined) throw new Error(t("mcpErrNoProjectFile"));
      stored.trust[projectFile] = sha256(text);
    } else {
      delete stored.trust[projectFile];
    }
    this.store(stored);
  }
}
