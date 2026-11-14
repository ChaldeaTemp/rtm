import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AdapterHealth, AgentDefinition, AgentId, AgentModelCatalog } from "../types.js";
import { extractModelCatalogFromNewSession } from "./model-catalog.js";
import {
  checkAdaptersHealth,
  findExecutableInPath,
  killProcessTree,
  loadLocalSecrets,
  planAgentAuth,
  resolveAdapterCommand,
  runAuthProbe,
  runAuthProbeSync,
  type AgentAuthResult,
  type AuthProbeSpec,
  type ResolvedCommand,
} from "./process-tree.js";

/** Child-process auth probes are re-run in the background once the cache is older than this. */
const HEALTH_AUTH_TTL_MS = 45_000;

const BUILTIN_DEFINITIONS: AgentDefinition[] = [
  {
    id: "claude",
    label: "Claude",
    color: "#b8542c",
    darkColor: "#ef936c",
    description: "reclaude / Claude Agent ACP",
    enabled: true,
    builtin: true,
    nativeProjectRuleFiles: ["CLAUDE.md", ".claude/rules"],
  },
  {
    id: "codex",
    label: "Codex",
    color: "#0d7148",
    darkColor: "#6fe0a0",
    description: "OpenAI Codex ACP",
    enabled: true,
    builtin: true,
    nativeProjectRuleFiles: ["AGENTS.md"],
  },
  {
    id: "agy",
    label: "Antigravity",
    color: "#2358a6",
    darkColor: "#7cb3ff",
    description: "Google Antigravity CLI (agy acp)",
    enabled: true,
    builtin: true,
    nativeProjectRuleFiles: ["AGENTS.md", "GEMINI.md", ".agents/rules"],
  },
  {
    id: "opencode",
    label: "OpenCode",
    color: "#0891b2",
    darkColor: "#5eead4",
    description: "OpenCode CLI (opencode acp)",
    enabled: true,
    builtin: true,
    nativeProjectRuleFiles: ["AGENTS.md", "CLAUDE.md"],
    nativeGlobalSkillDirs: ["~/.config/opencode/skills"],
  },
  {
    id: "kimi",
    label: "Kimi",
    color: "#7c4dff",
    darkColor: "#b99aff",
    description: "Kimi Code CLI (kimi acp)",
    enabled: true,
    builtin: true,
    nativeProjectRuleFiles: ["AGENTS.md"],
  },
];

export interface AgentPreset {
  id: string;
  label: string;
  command: string;
  args: string[];
  description: string;
  color: string;
}

export interface AgentPresetStatus extends AgentPreset {
  /** The command was found on this machine (PATH lookup). */
  installed: boolean;
  /** An agent with this id is already registered. */
  registered: boolean;
}

/**
 * Known CLIs that speak ACP over stdio. Launch arguments follow the acpx agent registry
 * (node_modules/acpx), except mimo which is not listed there.
 */
const AGENT_PRESETS: AgentPreset[] = [
  { id: "gemini", label: "Gemini", command: "gemini", args: ["--acp"], description: "Google Gemini CLI", color: "#1a73e8" },
  { id: "qwen", label: "Qwen", command: "qwen", args: ["--acp"], description: "Qwen Code CLI", color: "#5b4bd6" },
  { id: "cursor", label: "Cursor", command: "cursor-agent", args: ["acp"], description: "Cursor Agent CLI", color: "#3c4043" },
  { id: "copilot", label: "Copilot", command: "copilot", args: ["--acp", "--stdio"], description: "GitHub Copilot CLI", color: "#8250df" },
  { id: "goose", label: "Goose", command: "goose", args: ["acp"], description: "Block Goose", color: "#c2410c" },
  { id: "mimo", label: "Mimo", command: "mimo", args: ["acp"], description: "Mimo CLI", color: "#3f6212" },
  { id: "qoder", label: "Qoder", command: "qodercli", args: ["--acp"], description: "Qoder CLI", color: "#0f766e" },
  { id: "iflow", label: "iFlow", command: "iflow", args: ["--experimental-acp"], description: "iFlow CLI", color: "#be185d" },
  { id: "kiro", label: "Kiro", command: "kiro-cli-chat", args: ["acp"], description: "Kiro CLI", color: "#7c3aed" },
  { id: "trae", label: "Trae", command: "traecli", args: ["acp", "serve"], description: "Trae CLI", color: "#b45309" },
  { id: "droid", label: "Droid", command: "droid", args: ["exec", "--output-format", "acp"], description: "Factory Droid CLI", color: "#9a3412" },
  { id: "junie", label: "Junie", command: "junie", args: ["--acp=true"], description: "JetBrains Junie", color: "#15803d" },
  { id: "kilocode", label: "Kilo Code", command: "kilo", args: ["acp"], description: "Kilo Code CLI", color: "#a16207" },
  { id: "devin", label: "Devin", command: "devin", args: ["acp"], description: "Devin CLI", color: "#1d4ed8" },
  { id: "grok", label: "Grok", command: "grok", args: ["agent", "stdio"], description: "Grok Build CLI", color: "#404040" },
  { id: "openclaw", label: "OpenClaw", command: "openclaw", args: ["acp"], description: "OpenClaw", color: "#b91c1c" },
];

interface AgentsConfigFile {
  overrides: Record<string, Partial<AgentDefinition>>;
  customAgents: AgentDefinition[];
  /** Agent that leads new task groups; unset means "first ready agent". */
  defaultLead?: string;
}

export interface AgentProbeResult {
  ok: boolean;
  agentInfo?: unknown;
  sessionId?: string;
  modelCatalog?: AgentModelCatalog;
  latencyMs: number;
  error?: string;
}

const VALID_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class AgentRegistry {
  readonly baseCwd: string;
  private readonly hubDir: string;
  private readonly configFile: string;
  private readonly modelsCacheFile: string;
  private readonly persistCache: boolean;
  private readonly modelCatalogs = new Map<AgentId, AgentModelCatalog>();
  private readonly discovering = new Map<AgentId, Promise<AgentModelCatalog>>();
  private configCache?: { mtimeMs: number; size: number; cfg: AgentsConfigFile };
  /** Results of child-process auth probes, keyed by AuthProbeSpec.key. */
  private authProbeCache = new Map<string, AgentAuthResult>();
  private authProbeCheckedAt = 0;
  private healthRefreshing?: Promise<void>;
  private lastHealthSignature?: string;
  private readonly healthListeners = new Set<() => void>();

  constructor(baseCwd: string, options?: { persistCache?: boolean }) {
    this.baseCwd = path.resolve(baseCwd);
    this.hubDir = path.join(this.baseCwd, ".agent-hub");
    this.configFile = path.join(this.hubDir, "agents.json");
    this.modelsCacheFile = path.join(this.hubDir, "models-cache.json");
    this.persistCache = options?.persistCache ?? true;
    this.loadModelsCache();
  }

  private loadModelsCache(): void {
    if (!fs.existsSync(this.modelsCacheFile)) {
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.modelsCacheFile, "utf8")) as Record<
        string,
        AgentModelCatalog
      >;
      if (!parsed || typeof parsed !== "object") {
        return;
      }
      for (const [agent, catalog] of Object.entries(parsed)) {
        if (catalog && typeof catalog === "object" && Array.isArray(catalog.models)) {
          this.modelCatalogs.set(agent, { ...catalog, agent });
        }
      }
    } catch {
      // Ignore corrupt cache file
    }
  }

  private saveModelsCache(): void {
    if (!this.persistCache) {
      return;
    }
    try {
      fs.mkdirSync(this.hubDir, { recursive: true });
      const gitignorePath = path.join(this.hubDir, ".gitignore");
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, "*\n", "utf8");
      }
      const obj = this.getAllModelCatalogs();
      fs.writeFileSync(this.modelsCacheFile, JSON.stringify(obj, null, 2), "utf8");
    } catch {
      // Non-fatal cache write error
    }
  }

  /**
   * The catalog the UI should offer for an agent: what the CLI reported, narrowed to the
   * agent's configured `models` allow-list when one is set. Configured ids the CLI has not
   * reported (yet) are kept, so a list can be set up before the first handshake.
   */
  getModelCatalog(id: AgentId): AgentModelCatalog | undefined {
    const cached = this.modelCatalogs.get(id);
    const allow = this.getDefinition(id)?.models?.filter(Boolean) ?? [];
    if (!cached) {
      return allow.length > 0
        ? { agent: id, models: allow.map((m) => ({ id: m, name: m })), updatedAt: 0 }
        : undefined;
    }
    return this.applyConfiguredModels({
      ...cached,
      models: [...cached.models],
      effort: cached.effort
        ? { ...cached.effort, options: [...cached.effort.options] }
        : undefined,
    });
  }

  /** Narrows a freshly discovered catalog to the agent's allow-list (no-op when unset). */
  applyConfiguredModels(catalog: AgentModelCatalog): AgentModelCatalog {
    const allow = this.getDefinition(catalog.agent)?.models?.filter(Boolean) ?? [];
    if (allow.length === 0) {
      return catalog;
    }
    const byId = new Map(catalog.models.map((m) => [m.id, m]));
    return { ...catalog, models: allow.map((m) => byId.get(m) ?? { id: m, name: m }) };
  }

  /** Every model id the CLI reported for an agent, ignoring the allow-list. */
  getDiscoveredModelIds(id: AgentId): string[] {
    return (this.modelCatalogs.get(id)?.models ?? []).map((m) => m.id);
  }

  getAllModelCatalogs(): Record<string, AgentModelCatalog> {
    const out: Record<string, AgentModelCatalog> = {};
    const ids = new Set<string>([
      ...this.modelCatalogs.keys(),
      ...this.listDefinitions()
        .filter((d) => (d.models?.length ?? 0) > 0)
        .map((d) => d.id),
    ]);
    for (const id of ids) {
      const copy = this.getModelCatalog(id);
      if (copy) {
        out[id] = copy;
      }
    }
    return out;
  }

  updateModelCatalog(catalog: AgentModelCatalog): void {
    if (catalog.models.length === 0 && !catalog.effort) {
      return;
    }
    this.modelCatalogs.set(catalog.agent, {
      ...catalog,
      models: [...catalog.models],
      effort: catalog.effort
        ? { ...catalog.effort, options: [...catalog.effort.options] }
        : undefined,
    });
    this.saveModelsCache();
  }

  /**
   * Returns a private copy of the config. The parsed file is cached in memory and only
   * re-read when its mtime/size changes (external edit), so hot paths cost one statSync.
   */
  private loadConfig(): AgentsConfigFile {
    const stat = fs.statSync(this.configFile, { throwIfNoEntry: false });
    if (!stat) {
      this.configCache = undefined;
      return { overrides: {}, customAgents: [] };
    }
    const cached = this.configCache;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return structuredClone(cached.cfg);
    }
    let cfg: AgentsConfigFile;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configFile, "utf8")) as Partial<AgentsConfigFile>;
      cfg = {
        overrides: parsed.overrides && typeof parsed.overrides === "object" ? parsed.overrides : {},
        customAgents: Array.isArray(parsed.customAgents) ? parsed.customAgents : [],
        defaultLead:
          typeof parsed.defaultLead === "string" && parsed.defaultLead.trim()
            ? parsed.defaultLead.trim().toLowerCase()
            : undefined,
      };
    } catch {
      cfg = { overrides: {}, customAgents: [] };
    }
    this.configCache = { mtimeMs: stat.mtimeMs, size: stat.size, cfg };
    return structuredClone(cfg);
  }

  private saveConfig(cfg: AgentsConfigFile): void {
    fs.mkdirSync(this.hubDir, { recursive: true });
    const gitignorePath = path.join(this.hubDir, ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, "*\n", "utf8");
    }
    const json = JSON.stringify(cfg, null, 2);
    fs.writeFileSync(this.configFile, json, "utf8");
    const stat = fs.statSync(this.configFile, { throwIfNoEntry: false });
    this.configCache = stat
      ? { mtimeMs: stat.mtimeMs, size: stat.size, cfg: JSON.parse(json) as AgentsConfigFile }
      : undefined;
  }

  listDefinitions(): AgentDefinition[] {
    const cfg = this.loadConfig();
    const list: AgentDefinition[] = [];

    for (const base of BUILTIN_DEFINITIONS) {
      const ov = cfg.overrides[base.id];
      list.push({
        ...base,
        ...(ov ?? {}),
        id: base.id,
        builtin: true,
      });
    }

    for (const custom of cfg.customAgents) {
      if (!custom?.id || BUILTIN_DEFINITIONS.some((b) => b.id === custom.id)) {
        continue;
      }
      list.push({
        ...custom,
        label: custom.label || custom.id,
        color: custom.color || "#5c6ac4",
        enabled: custom.enabled !== false,
        builtin: false,
      });
    }

    return list;
  }

  listEnabledDefinitions(): AgentDefinition[] {
    return this.listDefinitions().filter((d) => d.enabled);
  }

  listEnabledIds(): AgentId[] {
    return this.listEnabledDefinitions().map((d) => d.id);
  }

  getDefinition(id: AgentId): AgentDefinition | undefined {
    return this.listDefinitions().find((d) => d.id === id);
  }

  isKnownAgent(id: string): boolean {
    return this.listDefinitions().some((d) => d.id === id);
  }

  isEnabledAgent(id: string): boolean {
    return this.listEnabledDefinitions().some((d) => d.id === id);
  }

  /** Presets with whether each CLI is installed here and whether it is already registered. */
  listPresets(): AgentPresetStatus[] {
    const known = new Set(this.listDefinitions().map((d) => d.id));
    const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
    return AGENT_PRESETS.map((preset) => ({
      ...preset,
      installed: Boolean(findExecutableInPath(exts.map((ext) => `${preset.command}${ext}`))),
      registered: known.has(preset.id),
    }));
  }

  /** Registers a preset by id with its known launch command. */
  addPreset(id: string): AgentDefinition {
    const preset = AGENT_PRESETS.find((p) => p.id === id);
    if (!preset) {
      throw new Error(`Unknown preset "${id}"`);
    }
    return this.upsertAgent({ ...preset, enabled: true });
  }

  /** The persisted default lead, or undefined when unset or no longer an enabled agent. */
  getDefaultLead(): AgentId | undefined {
    const id = this.loadConfig().defaultLead;
    return id && this.isEnabledAgent(id) ? id : undefined;
  }

  /** Persists the default lead for new task groups; pass null/empty to go back to automatic. */
  setDefaultLead(id: string | null | undefined): AgentId | undefined {
    const clean = id?.trim().toLowerCase() || undefined;
    if (clean && !this.isEnabledAgent(clean)) {
      throw new Error(`Cannot set default lead: "${id}" is not an enabled agent.`);
    }
    const cfg = this.loadConfig();
    if (clean) {
      cfg.defaultLead = clean;
    } else {
      delete cfg.defaultLead;
    }
    this.saveConfig(cfg);
    return clean;
  }

  /**
   * Picks the lead for a new task group: explicit choice (e.g. --lead), then the persisted
   * default, then the first enabled agent that is installed and authenticated.
   */
  resolveDefaultLead(preferred?: AgentId): AgentId {
    if (preferred) {
      return preferred;
    }
    const configured = this.getDefaultLead();
    if (configured) {
      return configured;
    }
    const health = this.getHealthList(false);
    return health.find((h) => h.available && h.authReady)?.agent ?? health[0]?.agent ?? "claude";
  }

  resolveCommand(id: AgentId): ResolvedCommand {
    const def = this.getDefinition(id);
    return resolveAdapterCommand(id, def);
  }

  /**
   * Synchronous and cheap on the hot path: definitions, executables and file/env based auth
   * are computed on every call, while auth checks that need a child process come from a cache
   * that is refreshed in the background once it is older than HEALTH_AUTH_TTL_MS (the stale
   * value is returned meanwhile). A probe with no cached result yet (process start, or an
   * agent whose probe was never needed before) is run synchronously once.
   */
  getHealthList(includeDisabled = false): AdapterHealth[] {
    const defs = includeDisabled ? this.listDefinitions() : this.listEnabledDefinitions();
    const list = checkAdaptersHealth(defs, (spec) => {
      let result = this.authProbeCache.get(spec.key);
      if (!result) {
        result = runAuthProbeSync(spec);
        this.authProbeCache.set(spec.key, result);
      }
      return result;
    }).map((item) => ({
      ...item,
      modelCatalog: this.getModelCatalog(item.agent),
      discoveredModelIds: this.getDiscoveredModelIds(item.agent),
    }));

    if (this.authProbeCheckedAt === 0) {
      this.authProbeCheckedAt = Date.now();
    } else if (Date.now() - this.authProbeCheckedAt > HEALTH_AUTH_TTL_MS) {
      // Spawning the probes costs a few ms on Windows; keep it out of the caller's path.
      this.authProbeCheckedAt = Date.now();
      setImmediate(() => void this.refreshHealth());
    }
    return list;
  }

  /**
   * Subscribes to health changes detected by a background/forced refresh. The listener is
   * only called when availability or auth state differs from the previous refresh; read the
   * new state with getHealthList(). Returns an unsubscribe function.
   */
  onHealthChanged(listener: () => void): () => void {
    this.healthListeners.add(listener);
    return () => {
      this.healthListeners.delete(listener);
    };
  }

  /**
   * Re-runs the child-process auth probes asynchronously (never blocks the event loop) and
   * replaces the cache. Concurrent calls share one in-flight refresh.
   */
  refreshHealth(): Promise<void> {
    if (!this.healthRefreshing) {
      this.healthRefreshing = this.runHealthRefresh()
        .catch(() => {
          // Keep the previous cache; the next stale read retries.
        })
        .finally(() => {
          this.healthRefreshing = undefined;
        });
    }
    return this.healthRefreshing;
  }

  private async runHealthRefresh(): Promise<void> {
    // Mark as checked up front so stale reads during the refresh do not queue another one.
    this.authProbeCheckedAt = Date.now();
    const before = this.lastHealthSignature ?? this.healthSignature();

    const localSecrets = loadLocalSecrets();
    const specs = new Map<string, AuthProbeSpec>();
    for (const def of this.listDefinitions()) {
      const plan = planAgentAuth(def.id, localSecrets, def);
      if ("probe" in plan) {
        specs.set(plan.probe.key, plan.probe);
      }
    }
    const entries = await Promise.all(
      [...specs.values()].map(async (spec) => [spec.key, await runAuthProbe(spec)] as const),
    );
    this.authProbeCache = new Map(entries);
    this.authProbeCheckedAt = Date.now();

    const after = this.healthSignature();
    this.lastHealthSignature = after;
    if (after !== before) {
      for (const listener of [...this.healthListeners]) {
        try {
          listener();
        } catch {
          // A failing listener must not break the refresh
        }
      }
    }
  }

  /** Availability + auth state of every definition, using cached probe results only. */
  private healthSignature(): string {
    return JSON.stringify(
      checkAdaptersHealth(
        this.listDefinitions(),
        (spec) => this.authProbeCache.get(spec.key) ?? { authReady: false, authHint: "?" },
      ).map((h) => [h.agent, h.enabled, h.available, h.reason ?? "", h.authReady, h.authHint ?? ""]),
    );
  }

  upsertAgent(input: {
    id: string;
    label?: string;
    color?: string;
    darkColor?: string;
    description?: string;
    enabled?: boolean;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    defaultModel?: string;
    defaultEffort?: string;
    models?: string[];
  }): AgentDefinition {
    const cleanModels =
      input.models === undefined
        ? undefined
        : [...new Set(input.models.map((m) => m.trim()).filter(Boolean))];
    const id = input.id.trim().toLowerCase();
    if (!VALID_AGENT_ID_RE.test(id)) {
      throw new Error(
        `Invalid agent ID "${input.id}". Use lowercase alphanumeric characters, '-' or '_' (max 32 chars).`,
      );
    }

    const cfg = this.loadConfig();
    const isBuiltin = BUILTIN_DEFINITIONS.some((b) => b.id === id);

    if (isBuiltin) {
      const prev = cfg.overrides[id] ?? {};
      const next: Partial<AgentDefinition> = { ...prev };
      if (input.label !== undefined) next.label = input.label.trim() || id;
      if (input.color !== undefined) next.color = input.color.trim();
      if (input.darkColor !== undefined) next.darkColor = input.darkColor.trim();
      if (input.description !== undefined) next.description = input.description.trim();
      if (input.enabled !== undefined) next.enabled = input.enabled;
      if (input.command !== undefined) next.command = input.command.trim() || undefined;
      if (input.args !== undefined) next.args = input.args;
      if (input.env !== undefined) next.env = Object.keys(input.env).length ? input.env : undefined;
      if (input.defaultModel !== undefined) next.defaultModel = input.defaultModel.trim() || undefined;
      if (input.defaultEffort !== undefined) next.defaultEffort = input.defaultEffort.trim() || undefined;
      if (cleanModels !== undefined) next.models = cleanModels.length ? cleanModels : undefined;
      cfg.overrides[id] = next;
      this.saveConfig(cfg);
      return this.getDefinition(id)!;
    }

    const existingIdx = cfg.customAgents.findIndex((a) => a.id === id);
    const prevCustom = existingIdx >= 0 ? cfg.customAgents[existingIdx] : undefined;
    const command = (input.command ?? prevCustom?.command ?? "").trim();
    if (!command) {
      throw new Error(`Custom agent "${id}" requires a command path or executable name.`);
    }

    const def: AgentDefinition = {
      id,
      label: input.label?.trim() || prevCustom?.label || id,
      color: input.color?.trim() || prevCustom?.color || "#5c6ac4",
      darkColor: input.darkColor?.trim() || prevCustom?.darkColor,
      description: input.description?.trim() || prevCustom?.description || `Custom ACP agent (${command})`,
      enabled: input.enabled ?? prevCustom?.enabled ?? true,
      builtin: false,
      command,
      args: input.args ?? prevCustom?.args ?? ["acp"],
      env: input.env ?? prevCustom?.env,
      defaultModel:
        input.defaultModel !== undefined
          ? input.defaultModel.trim() || undefined
          : prevCustom?.defaultModel,
      defaultEffort:
        input.defaultEffort !== undefined
          ? input.defaultEffort.trim() || undefined
          : prevCustom?.defaultEffort,
      models: cleanModels !== undefined ? (cleanModels.length ? cleanModels : undefined) : prevCustom?.models,
    };

    if (existingIdx >= 0) {
      cfg.customAgents[existingIdx] = def;
    } else {
      cfg.customAgents.push(def);
    }
    this.saveConfig(cfg);
    return def;
  }

  toggleAgent(id: AgentId, enabled: boolean): AgentDefinition {
    const existing = this.getDefinition(id);
    if (!existing) {
      throw new Error(`Unknown agent "${id}"`);
    }
    return this.upsertAgent({ id, enabled });
  }

  deleteCustomAgent(id: AgentId): boolean {
    if (BUILTIN_DEFINITIONS.some((b) => b.id === id)) {
      return false;
    }
    const cfg = this.loadConfig();
    const next = cfg.customAgents.filter((a) => a.id !== id);
    if (next.length === cfg.customAgents.length) {
      return false;
    }
    cfg.customAgents = next;
    this.saveConfig(cfg);
    return true;
  }

  async probeHandshake(id: AgentId, cwd = this.baseCwd, timeoutMs = 20_000): Promise<AgentProbeResult> {
    const started = Date.now();
    const resolved = this.resolveCommand(id);
    const child = spawn(resolved.command, resolved.args, {
      cwd,
      env: resolved.env ? { ...process.env, ...resolved.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    // A command that cannot be started emits 'error' on the child; without a listener that
    // is an uncaught exception and takes the whole hub down.
    const spawnFailed = new Promise<never>((_, reject) => {
      child.once("error", (err) =>
        reject(new Error(`Failed to start "${resolved.command}": ${err.message}`)),
      );
    });
    spawnFailed.catch(() => {});

    const stderrTail: string[] = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) {
          stderrTail.push(line);
          if (stderrTail.length > 15) stderrTail.shift();
        }
      }
    });

    let conn: acp.ClientConnection | undefined;
    try {
      if (!child.stdin || !child.stdout) {
        throw new Error(`Failed to open stdio pipes for ${id}`);
      }
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      );
      const clientApp = acp.client({ name: `probe-${id}` });
      conn = clientApp.connect(stream);

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`ACP handshake timed out (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs),
      );

      const initResp = await Promise.race([
        conn.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "agent-hub-probe", version: "0.1.0" },
        }),
        timeoutPromise,
        spawnFailed,
      ]);

      const session = await Promise.race([
        conn.agent.buildSession(path.resolve(cwd)).start(),
        timeoutPromise,
        spawnFailed,
      ]);

      const catalog = extractModelCatalogFromNewSession(id, session.newSessionResponse);
      if (catalog.models.length > 0 || catalog.effort) {
        this.updateModelCatalog(catalog);
      }

      return {
        ok: true,
        agentInfo: initResp.agentInfo,
        sessionId: session.sessionId,
        modelCatalog: catalog,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const tail = stderrTail.slice(-5).join(" | ");
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: tail ? `${msg} (${tail})` : msg,
      };
    } finally {
      try {
        conn?.close();
      } catch {
        // ignore
      }
      killProcessTree(child.pid);
    }
  }

  /**
   * Discovers available models & thinking effort levels for an agent via cache or live ACP probe.
   */
  async discoverModels(id: AgentId, cwd = this.baseCwd, force = false): Promise<AgentModelCatalog> {
    if (!force) {
      const cached = this.getModelCatalog(id);
      if (cached && cached.models.length > 0) {
        return cached;
      }
    }

    const inflight = this.discovering.get(id);
    if (inflight) {
      return inflight;
    }

    const run = (async () => {
      const probe = await this.probeHandshake(id, cwd, 25_000);
      if (!probe.ok) {
        throw new Error(probe.error ?? `Failed to probe models for ${id}`);
      }
      return (
        probe.modelCatalog ??
        this.getModelCatalog(id) ?? {
          agent: id,
          models: [],
          updatedAt: Date.now(),
        }
      );
    })();

    this.discovering.set(id, run);
    try {
      return await run;
    } finally {
      this.discovering.delete(id);
    }
  }
}
