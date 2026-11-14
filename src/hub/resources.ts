import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ALL_AGENTS,
  type AgentId,
  type AgentResourceBudget,
  type InjectedItemSummary,
  type ResourceKind,
  type ResourceScope,
  type SharedResourceItem,
} from "../types.js";
import type { AgentRegistry } from "./agent-registry.js";
import { dataDir } from "./data-dir.js";

const MANAGED_START = "<!-- agent-hub:shared:start -->";
const MANAGED_END = "<!-- agent-hub:shared:end -->";
const MANAGED_BLOCK_RE = /<!--\s*agent-hub:shared:start\s*-->[\s\S]*?<!--\s*agent-hub:shared:end\s*-->/g;
const MAX_RULE_INJECTION_TOKENS = 16_000;
const MAX_SKILLS_INDEX_TOKENS = 1100;

function formatCompactSkillIndexLine(
  name: string,
  scope: ResourceScope,
  description: string,
): string {
  const desc = description.replace(/\s+/g, " ").trim().slice(0, 96);
  return `- \`${name}\` [${scope}]: ${desc}`;
}

/**
 * Builds concise workbench tool instructions so agents prefer Hub UI tools
 * over headless-blocking CLI prompts or plain-text workarounds.
 */
export function buildHubWorkbenchGuide(role: "lead" | "sub" = "lead"): string {
  const lines = [
    "<agent_hub_workbench>",
    "You are running inside the Agent Hub graphical workbench (`agent-hub-peers` MCP server is connected):",
    "- Interactive options / quizzes / user confirmation forms: ALWAYS call MCP tool `hub_ask_user` (`single` | `multi` | `text` fields) to render clickable option cards in the UI and await the user's answer. NEVER call CLI-native TUI `question` or terminal-stdin prompt tools (headless ACP stdio has no TUI listener and will hang).",
    "- Interactive charts / diagrams / visual widgets / HTML previews: Call MCP tool `ui_render_artifact` (`kind`: `\"html\"` | `\"svg\"` | `\"mermaid\"`) to render live sandboxed cards inline in chat.",
  ];
  lines.push(
    "- Progress panel: the user follows long tasks on a Progress panel and should never have to ask where things stand. As soon as the work turns out to be multi-step, call `progress_update` with the goal and the steps. Call it again, without being asked and before you reply, whenever the goal changes, a step starts, finishes or gets blocked, or the plan itself changes. Keep step titles short; put details in `note`.",
  );
  if (role === "sub") {
    lines.push(
      "- Shared task context: your prompt may start with a <task_context> block holding the task's background, the sections chosen for you, and results of earlier steps. It also lists other sections by name; call `context_get` with a section key only when you actually need one.",
    );
  }
  if (role === "lead") {
    lines.push(
      "- Peer agent collaboration: Call `peer_list_agents`, `peer_ask` (sync), or `peer_dispatch` + `peer_status` (parallel sub-sessions) when delegating subtasks.",
      "- Multi-step delegation with dependencies: Call `workflow_propose` to draft the steps; the user reviews and publishes the draft in the Workflow panel, so do not dispatch those steps yourself.",
      "- Handing over the lead: when the user asks you to pass this task to another agent, call `lead_handoff` with that agent's id and a complete brief, then tell the user in one sentence and stop. Never do this on your own initiative.",
      "- Shared task context: sub-sessions do not see this conversation. Whatever several of them need (goal, conventions, constraints, where materials are) goes into the task's shared context once, via `shared_context`/`sections` of `workflow_propose` or `context_put`, and is delivered to them automatically. Keep delegation prompts to what is specific to that delegation; never paste the same background into each one.",
    );
  }
  lines.push("</agent_hub_workbench>", "", "");
  return lines.join("\n");
}

export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  const cjkMatches = trimmed.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = Math.max(0, trimmed.length - cjkCount);
  return Math.max(1, Math.ceil(cjkCount * 1.2 + nonCjkCount / 4));
}

export function stripManagedHubBlock(raw: string): string {
  return raw.replace(MANAGED_BLOCK_RE, "").trim();
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function parseSkillFrontmatter(raw: string): {
  name?: string;
  description?: string;
  body: string;
} {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { body: normalized };
  }
  const endIdx = normalized.indexOf("\n---", 4);
  if (endIdx < 0) {
    return { body: normalized };
  }
  const header = normalized.slice(4, endIdx);
  const afterClose = normalized.indexOf("\n", endIdx + 4);
  const body = afterClose >= 0 ? normalized.slice(afterClose + 1).trim() : "";

  const lines = header.split("\n");
  let name: string | undefined;
  let description: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1]!;
    const rawVal = (match[2] ?? "").trim();

    let resolved = "";
    if (/^[>|][+-]?$/.test(rawVal)) {
      const blockLines: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j]!;
        if (nextLine.trim() === "") {
          blockLines.push("");
          j++;
          continue;
        }
        if (!/^[ \t]+/.test(nextLine)) {
          break;
        }
        blockLines.push(nextLine.trim());
        j++;
      }
      i = j - 1;
      resolved = rawVal.startsWith(">") ? blockLines.join(" ").replace(/\s+/g, " ").trim() : blockLines.join("\n").trim();
    } else {
      resolved = unquoteYamlScalar(rawVal);
    }

    if (key === "name" && resolved) {
      name = resolved;
    } else if (key === "description" && resolved) {
      description = resolved;
    }
  }

  return { name, description, body };
}

interface RawCandidate {
  kind: ResourceKind;
  scope: ResourceScope;
  origin: string;
  name: string;
  description: string;
  filePath: string;
  nativeAgents: AgentId[];
  content: string;
  dedupKey: string;
  updatedAt: number;
}

interface ResourceConfigFile {
  disabledIds: string[];
}

export interface AgentInjectionPayload {
  promptPrefix: string;
  sharedRulesTokens: number;
  skillsIndexTokens: number;
  injectedRules: InjectedItemSummary[];
  injectedSkillsCount: number;
  nativeRulesCount: number;
  nativeSkillsCount: number;
  /** Bridged rules that did not fit the rule budget; the prompt lists them by path instead. */
  droppedRules: InjectedItemSummary[];
}

function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function slugifyRuleName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || `rule-${Date.now().toString(36)}`;
}

function extractRuleSummary(filePath: string, body: string): { title: string; description: string } {
  const lines = body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim());
  const heading = lines.find((l) => /^#\s+/.test(l));
  const title = heading ? heading.replace(/^#+\s*/, "").trim() : path.basename(filePath, ".md");
  const descLine = lines.find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("<!--"));
  const description = (descLine ?? title).replace(/^[-*]\s*/, "").slice(0, 180);
  return { title, description };
}

function listMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md"))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function listSkillFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === ".system" || entry.name.startsWith(".")) {
        continue;
      }
      const skillFile = path.join(rootDir, entry.name, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        results.push(skillFile);
      }
    }
  } catch {
    // ignore unreadable directory
  }
  return results;
}

function mergeAgents(a: AgentId[], b: AgentId[], activeAgents: readonly AgentId[]): AgentId[] {
  const set = new Set<AgentId>([...a, ...b]);
  const ordered = activeAgents.filter((agent) => set.has(agent));
  for (const agent of set) {
    if (!ordered.includes(agent)) {
      ordered.push(agent);
    }
  }
  return ordered;
}

function sha16(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

type DiscoveredItem = SharedResourceItem & { _rawContent: string };

/** How long a disk scan is reused. Writes through this manager invalidate it immediately. */
const DISCOVER_CACHE_TTL_MS = 4000;

export class SharedResourceManager {
  readonly baseCwd: string;
  readonly homeDir: string;
  private readonly globalRulesDir: string;
  private registry?: AgentRegistry;
  /** Short-lived scan cache keyed by resolved cwd + active agent list. Entries are read-only. */
  private readonly discoverCache = new Map<string, { at: number; items: DiscoveredItem[] }>();

  constructor(baseCwd: string, homeDir = os.homedir()) {
    this.baseCwd = path.resolve(baseCwd);
    this.homeDir = path.resolve(homeDir);
    this.globalRulesDir = path.join(dataDir(this.homeDir), "resources", "rules");
  }

  private resolveTargetCwd(cwd?: string): string {
    return cwd?.trim() ? path.resolve(cwd) : this.baseCwd;
  }

  private projectHubDirFor(cwd?: string): string {
    return dataDir(this.resolveTargetCwd(cwd));
  }

  private projectRulesDirFor(cwd?: string): string {
    return path.join(this.projectHubDirFor(cwd), "resources", "rules");
  }

  private configFileFor(cwd?: string): string {
    return path.join(this.projectHubDirFor(cwd), "resources", "config.json");
  }

  setAgentRegistry(registry: AgentRegistry): void {
    this.registry = registry;
  }

  private getActiveAgentIds(): AgentId[] {
    return this.registry ? this.registry.listEnabledIds() : [...ALL_AGENTS];
  }

  private loadDisabledSet(cwd?: string): Set<string> {
    const configFile = this.configFileFor(cwd);
    if (!fs.existsSync(configFile)) {
      return new Set();
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, "utf8")) as Partial<ResourceConfigFile>;
      return new Set(Array.isArray(parsed.disabledIds) ? parsed.disabledIds : []);
    } catch {
      return new Set();
    }
  }

  private ensureProjectHubGitignore(cwd?: string): void {
    const hubDir = this.projectHubDirFor(cwd);
    fs.mkdirSync(hubDir, { recursive: true });
    const gitignorePath = path.join(hubDir, ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, "*\n", "utf8");
    }
  }

  private saveDisabledSet(disabled: Set<string>, cwd?: string): void {
    const targetCwd = this.resolveTargetCwd(cwd);
    this.ensureProjectHubGitignore(targetCwd);
    const configFile = this.configFileFor(targetCwd);
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const payload: ResourceConfigFile = { disabledIds: [...disabled].sort() };
    fs.writeFileSync(configFile, JSON.stringify(payload, null, 2), "utf8");
    this.invalidateCache();
  }

  /** Drops cached scans so the next discover() reads the disk again. */
  invalidateCache(): void {
    this.discoverCache.clear();
  }

  private collectPluginDirs(): string[] {
    const pluginsRoot = path.join(this.homeDir, ".gemini", "config", "plugins");
    if (!fs.existsSync(pluginsRoot)) {
      return [];
    }
    try {
      return fs
        .readdirSync(pluginsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(pluginsRoot, d.name));
    } catch {
      return [];
    }
  }

  private collectRawCandidates(cwd: string): RawCandidate[] {
    const candidates: RawCandidate[] = [];
    const seenPaths = new Set<string>();

    const pushRule = (filePath: string, scope: ResourceScope, origin: string, nativeAgents: AgentId[]) => {
      const resolved = path.resolve(filePath);
      const normKey = resolved.toLowerCase();
      if (seenPaths.has(normKey) || !fs.existsSync(resolved)) {
        return;
      }
      try {
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) return;
        const raw = fs.readFileSync(resolved, "utf8");
        const cleanBody = stripManagedHubBlock(raw);
        if (!cleanBody) return;
        seenPaths.add(normKey);
        const normalizedContent = cleanBody.replace(/\r\n/g, "\n").trim();
        const { title, description } = extractRuleSummary(resolved, normalizedContent);
        candidates.push({
          kind: "rule",
          scope,
          origin,
          name: title,
          description,
          filePath: resolved,
          nativeAgents,
          content: normalizedContent,
          dedupKey: `rule:${scope}:${sha16(normalizedContent)}`,
          updatedAt: stat.mtimeMs,
        });
      } catch {
        // ignore unreadable rule file
      }
    };

    const pushSkill = (filePath: string, scope: ResourceScope, origin: string, nativeAgents: AgentId[]) => {
      const resolved = path.resolve(filePath);
      const normKey = resolved.toLowerCase();
      if (seenPaths.has(normKey) || !fs.existsSync(resolved)) {
        return;
      }
      try {
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) return;
        const raw = fs.readFileSync(resolved, "utf8");
        if (!raw.trim()) return;
        seenPaths.add(normKey);
        const dirName = path.basename(path.dirname(resolved));
        const parsed = parseSkillFrontmatter(raw);
        const name = (parsed.name || dirName).trim();
        const description = (
          parsed.description ||
          parsed.body.split("\n").find((l) => l.trim() && !l.startsWith("#")) ||
          name
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 220);
        candidates.push({
          kind: "skill",
          scope,
          origin,
          name,
          description,
          filePath: resolved,
          nativeAgents,
          content: raw,
          dedupKey: `skill:${scope}:${name.toLowerCase()}`,
          updatedAt: stat.mtimeMs,
        });
      } catch {
        // ignore unreadable skill file
      }
    };

    // --- Project & Hub Rules ---
    // A Hub rule that "sync to project files" already wrote into AGENTS.md / CLAUDE.md is read
    // natively by the agents that load that file; bridging it again would send it twice.
    const agentsMdPath = path.join(cwd, "AGENTS.md");
    const claudeMdPath = path.join(cwd, "CLAUDE.md");
    const hasAgentsMd = fs.existsSync(agentsMdPath);
    const agentsMdReaders: AgentId[] = ["codex", "agy", "opencode", "kimi"];
    // opencode falls back to CLAUDE.md only when the project has no AGENTS.md.
    const claudeMdReaders: AgentId[] = hasAgentsMd ? ["claude"] : ["claude", "opencode"];
    const managedBlockOf = (file: string): string => {
      try {
        return (fs.readFileSync(file, "utf8").match(MANAGED_BLOCK_RE) ?? []).join("\n").replace(/\r\n/g, "\n");
      } catch {
        return "";
      }
    };
    const agentsMdBlock = managedBlockOf(agentsMdPath);
    const claudeMdBlock = managedBlockOf(claudeMdPath);
    const syncedReaders = (ruleFile: string): AgentId[] => {
      let body = "";
      try {
        body = stripManagedHubBlock(fs.readFileSync(ruleFile, "utf8")).replace(/\r\n/g, "\n").trim();
      } catch {
        return [];
      }
      if (!body) return [];
      return [
        ...(agentsMdBlock.includes(body) ? agentsMdReaders : []),
        ...(claudeMdBlock.includes(body) ? claudeMdReaders : []),
      ];
    };
    for (const f of listMarkdownFiles(path.join(dataDir(cwd), "resources", "rules"))) {
      pushRule(f, "project", "hub-project", syncedReaders(f));
    }
    for (const f of listMarkdownFiles(this.globalRulesDir)) {
      pushRule(f, "global", "hub-global", syncedReaders(f));
    }
    pushRule(agentsMdPath, "project", "project", agentsMdReaders);
    pushRule(claudeMdPath, "project", "project", claudeMdReaders);
    pushRule(path.join(cwd, "GEMINI.md"), "project", "project", ["agy"]);
    for (const f of listMarkdownFiles(path.join(cwd, ".agents", "rules"))) {
      pushRule(f, "project", "project-agy", ["agy"]);
    }
    for (const f of listMarkdownFiles(path.join(cwd, ".agent", "rules"))) {
      pushRule(f, "project", "project-agy", ["agy"]);
    }
    for (const f of listMarkdownFiles(path.join(cwd, ".claude", "rules"))) {
      pushRule(f, "project", "project-claude", ["claude"]);
    }

    // --- Global Native Rules (Read-Only Discovery) ---
    pushRule(path.join(this.homeDir, ".codex", "AGENTS.md"), "global", "codex-global", ["codex"]);
    for (const f of listMarkdownFiles(path.join(this.homeDir, ".codex", "rules"))) {
      pushRule(f, "global", "codex-global", ["codex"]);
    }
    pushRule(path.join(this.homeDir, ".gemini", "GEMINI.md"), "global", "agy-global", ["agy"]);
    for (const f of listMarkdownFiles(path.join(this.homeDir, ".gemini", "antigravity", "rules"))) {
      pushRule(f, "global", "agy-global", ["agy"]);
    }
    for (const pluginDir of this.collectPluginDirs()) {
      for (const f of listMarkdownFiles(path.join(pluginDir, "rules"))) {
        pushRule(f, "global", "agy-plugin", ["agy"]);
      }
    }
    // Claude Code keeps its global files under CLAUDE_CONFIG_DIR when that is set.
    const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(this.homeDir, ".claude");
    pushRule(path.join(claudeHome, "CLAUDE.md"), "global", "claude-global", ["claude"]);
    for (const f of listMarkdownFiles(path.join(claudeHome, "rules"))) {
      pushRule(f, "global", "claude-global", ["claude"]);
    }

    // --- Project & Hub Skills ---
    for (const f of listSkillFiles(path.join(dataDir(cwd), "resources", "skills"))) {
      pushSkill(f, "project", "hub-project", []);
    }
    for (const f of listSkillFiles(path.join(cwd, ".agents", "skills"))) {
      pushSkill(f, "project", "project-agy", ["agy"]);
    }
    for (const f of listSkillFiles(path.join(cwd, ".agent", "skills"))) {
      pushSkill(f, "project", "project-agy", ["agy"]);
    }
    for (const f of listSkillFiles(path.join(cwd, ".codex", "skills"))) {
      pushSkill(f, "project", "project-codex", ["codex"]);
    }
    for (const f of listSkillFiles(path.join(cwd, ".claude", "skills"))) {
      pushSkill(f, "project", "project-claude", ["claude"]);
    }

    // --- Global Native Skills (Read-Only Discovery) ---
    for (const f of listSkillFiles(path.join(dataDir(this.homeDir), "resources", "skills"))) {
      pushSkill(f, "global", "hub-global", []);
    }
    for (const f of listSkillFiles(path.join(this.homeDir, ".agents", "skills"))) {
      pushSkill(f, "global", "agents-global", ["agy"]);
    }
    for (const pluginDir of this.collectPluginDirs()) {
      for (const f of listSkillFiles(path.join(pluginDir, "skills"))) {
        pushSkill(f, "global", "agy-plugin", ["agy"]);
      }
    }
    for (const f of listSkillFiles(path.join(this.homeDir, ".codex", "skills"))) {
      pushSkill(f, "global", "codex-global", ["codex"]);
    }
    for (const f of listSkillFiles(
      path.join(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(this.homeDir, ".claude"), "skills"),
    )) {
      pushSkill(f, "global", "claude-global", ["claude"]);
    }
    for (const f of listSkillFiles(path.join(this.homeDir, ".config", "opencode", "skills"))) {
      pushSkill(f, "global", "opencode-global", ["opencode"]);
    }

    return candidates;
  }

  /**
   * Returns the (possibly cached) scan result. The returned array and its items are shared
   * with the cache: callers inside this class must treat them as read-only, and anything
   * handed to the outside goes through discover(), which copies.
   */
  private discoverInternal(cwd = this.baseCwd): DiscoveredItem[] {
    const resolvedCwd = path.resolve(cwd);
    const activeAgents = this.getActiveAgentIds();
    const cacheKey = `${resolvedCwd}\n${activeAgents.join(",")}`;
    const now = Date.now();
    const cached = this.discoverCache.get(cacheKey);
    if (cached && now - cached.at < DISCOVER_CACHE_TTL_MS) {
      return cached.items;
    }
    for (const [key, entry] of this.discoverCache) {
      if (now - entry.at >= DISCOVER_CACHE_TTL_MS) {
        this.discoverCache.delete(key);
      }
    }
    const items = this.scanResources(resolvedCwd, activeAgents);
    this.discoverCache.set(cacheKey, { at: Date.now(), items });
    return items;
  }

  private scanResources(resolvedCwd: string, activeAgents: AgentId[]): DiscoveredItem[] {
    const disabled = this.loadDisabledSet(resolvedCwd);
    const candidates = this.collectRawCandidates(resolvedCwd);
    const mergedMap = new Map<string, { item: SharedResourceItem & { _rawContent: string } }>();

    for (const c of candidates) {
      const existing = mergedMap.get(c.dedupKey);
      if (!existing) {
        const nativeAgents = activeAgents.filter((a) => c.nativeAgents.includes(a));
        const bridgedAgents = activeAgents.filter((a) => !nativeAgents.includes(a));
        // Rules are identified by where they live, so editing one keeps its enabled/disabled
        // state. Identical files still merge through the content-based dedupKey.
        const id =
          c.kind === "rule" ? `rule:${c.scope}:p${sha16(path.resolve(c.filePath).toLowerCase())}` : c.dedupKey;
        const indexLine =
          c.kind === "skill"
            ? formatCompactSkillIndexLine(c.name, c.scope, c.description)
            : c.name;
        mergedMap.set(c.dedupKey, {
          item: {
            id,
            kind: c.kind,
            scope: c.scope,
            name: c.name,
            description: c.description,
            origin: c.origin,
            primaryPath: c.filePath,
            sources: [c.filePath],
            nativeAgents,
            bridgedAgents,
            // dedupKey was the id before; honour entries disabled under the old scheme.
            enabled: !disabled.has(id) && !disabled.has(c.dedupKey),
            fullTokens: estimateTokens(c.content),
            indexTokens: c.kind === "skill" ? estimateTokens(indexLine) : estimateTokens(c.content),
            updatedAt: c.updatedAt,
            _rawContent: c.content,
          },
        });
      } else {
        const it = existing.item;
        if (!it.sources.includes(c.filePath)) {
          it.sources.push(c.filePath);
        }
        it.nativeAgents = mergeAgents(it.nativeAgents, c.nativeAgents, activeAgents);
        it.bridgedAgents = activeAgents.filter((a) => !it.nativeAgents.includes(a));
        it.updatedAt = Math.max(it.updatedAt, c.updatedAt);
      }
    }

    const list = [...mergedMap.values()].map((v) => v.item);
    list.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "rule" ? -1 : 1;
      if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return list;
  }

  discover(cwd = this.baseCwd): SharedResourceItem[] {
    return this.discoverInternal(cwd).map(({ _rawContent: _unused, ...item }) => ({
      ...item,
      sources: [...item.sources],
      nativeAgents: [...item.nativeAgents],
      bridgedAgents: [...item.bridgedAgents],
    }));
  }

  buildInjectionForAgent(agent: AgentId, cwd = this.baseCwd): AgentInjectionPayload {
    return this.buildInjectionFromItems(agent, this.discoverInternal(cwd));
  }

  private buildInjectionFromItems(agent: AgentId, items: readonly DiscoveredItem[]): AgentInjectionPayload {
    const enabledItems = items.filter((item) => item.enabled);

    const nativeRulesCount = enabledItems.filter(
      (i) => i.kind === "rule" && i.nativeAgents.includes(agent),
    ).length;
    const nativeSkillsCount = enabledItems.filter(
      (i) => i.kind === "skill" && i.nativeAgents.includes(agent),
    ).length;

    const bridgedRules = enabledItems.filter(
      (i) => i.kind === "rule" && !i.nativeAgents.includes(agent),
    );
    const bridgedSkills = enabledItems.filter(
      (i) => i.kind === "skill" && !i.nativeAgents.includes(agent),
    );

    const injectedRules: InjectedItemSummary[] = [];
    const droppedRules: InjectedItemSummary[] = [];
    const droppedRuleLines: string[] = [];
    const ruleBlocks: string[] = [];
    let sharedRulesTokens = 0;

    for (const rule of bridgedRules) {
      const block = `### [${rule.scope === "project" ? "Project Rule" : "Global Rule"}] ${rule.name} (source: ${toForwardSlashes(rule.primaryPath)})\n${rule._rawContent}`;
      const tokens = estimateTokens(block);
      if (sharedRulesTokens + tokens > MAX_RULE_INJECTION_TOKENS && injectedRules.length > 0) {
        droppedRules.push({ id: rule.id, name: rule.name, kind: "rule", scope: rule.scope, tokens });
        droppedRuleLines.push(`- ${rule.name}: ${toForwardSlashes(rule.primaryPath)}`);
        continue;
      }
      sharedRulesTokens += tokens;
      ruleBlocks.push(block);
      injectedRules.push({
        id: rule.id,
        name: rule.name,
        kind: "rule",
        scope: rule.scope,
        tokens,
      });
    }

    const sortedSkills = [...bridgedSkills].sort((a, b) => {
      if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const skillsHeaderLines = [
      "## Shared Skills Index (Progressive Disclosure)",
      "Below are shared skills bridged across local agents. Call MCP tool resource_read_skill({ skill_name }) (or read its path from resource_list_shared) ONLY when a task matches its description:",
    ];
    let runningSkillTokens = estimateTokens(skillsHeaderLines.join("\n"));
    const skillLines: string[] = [];
    let omittedSkills = 0;
    for (const s of sortedSkills) {
      const line = formatCompactSkillIndexLine(s.name, s.scope, s.description);
      const lineTokens = estimateTokens(line);
      if (runningSkillTokens + lineTokens > MAX_SKILLS_INDEX_TOKENS && skillLines.length > 0) {
        omittedSkills++;
        continue;
      }
      runningSkillTokens += lineTokens;
      skillLines.push(line);
    }
    if (omittedSkills > 0) {
      skillLines.push(`- ... (${omittedSkills} more skills available via MCP resource_list_shared)`);
    }
    const skillsSection =
      skillLines.length > 0 ? [...skillsHeaderLines, ...skillLines].join("\n") : "";
    const skillsIndexTokens = skillsSection ? estimateTokens(skillsSection) : 0;

    // The hub cannot stop an agent from loading what lives in its own config directory, so
    // switching such an item off only works if the agent is told about it.
    const turnedOffNative = items.filter((i) => !i.enabled && i.nativeAgents.includes(agent));
    const turnedOffSection =
      turnedOffNative.length > 0
        ? [
            "## Turned Off In This Workbench",
            "The user switched these off for this workbench. Your own configuration still loads them, so they may show up in your skill list or rules. Treat them as absent here: do not invoke these skills or follow these rules, and where your other instructions tell you to use one of them, that instruction does not apply in this workbench.",
            ...turnedOffNative.map(
              (i) => `- ${i.kind} \`${i.name}\` (${toForwardSlashes(i.primaryPath)})`,
            ),
          ].join("\n")
        : "";
    const turnedOffTokens = turnedOffSection ? estimateTokens(turnedOffSection) : 0;

    if (ruleBlocks.length === 0 && !skillsSection && !turnedOffSection) {
      return {
        promptPrefix: "",
        sharedRulesTokens: 0,
        skillsIndexTokens: 0,
        injectedRules: [],
        injectedSkillsCount: 0,
        nativeRulesCount,
        nativeSkillsCount,
        droppedRules: [],
      };
    }

    const sections: string[] = [
      "<shared_resources_context>",
      `Bridged shared resources for ${agent} (automatically excluding rules/skills already loaded natively by ${agent}):`,
    ];
    if (ruleBlocks.length > 0) {
      sections.push("", "## Active Shared Rules", ruleBlocks.join("\n\n"));
    }
    if (droppedRuleLines.length > 0) {
      sections.push(
        "",
        "## Shared Rules Not Included (size budget reached)",
        "These rules also apply. Read the file when your task touches its subject:",
        droppedRuleLines.join("\n"),
      );
    }
    if (skillsSection) {
      sections.push("", skillsSection);
    }
    if (turnedOffSection) {
      sections.push("", turnedOffSection);
    }
    sections.push("</shared_resources_context>", "");

    return {
      promptPrefix: `${sections.join("\n")}\n`,
      sharedRulesTokens: sharedRulesTokens + turnedOffTokens,
      skillsIndexTokens,
      injectedRules,
      injectedSkillsCount: skillLines.length - (omittedSkills > 0 ? 1 : 0),
      nativeRulesCount,
      nativeSkillsCount,
      droppedRules,
    };
  }

  getAgentBudgets(cwd = this.baseCwd): AgentResourceBudget[] {
    // Scan once and reuse the list for every agent.
    const allItems = this.discoverInternal(cwd);
    const items = allItems.filter((i) => i.enabled);
    return this.getActiveAgentIds().map((agent) => {
      const inj = this.buildInjectionFromItems(agent, allItems);
      const bridgedRules = items.filter((i) => i.kind === "rule" && !i.nativeAgents.includes(agent)).length;
      const bridgedSkills = items.filter((i) => i.kind === "skill" && !i.nativeAgents.includes(agent)).length;
      return {
        agent,
        nativeRules: inj.nativeRulesCount,
        bridgedRules,
        nativeSkills: inj.nativeSkillsCount,
        bridgedSkills,
        rulesTokens: inj.sharedRulesTokens,
        skillsIndexTokens: inj.skillsIndexTokens,
        firstTurnInjectionTokens: inj.sharedRulesTokens + inj.skillsIndexTokens,
        droppedRules: inj.droppedRules.map((r) => r.name),
      };
    });
  }

  setResourceEnabled(id: string, enabled: boolean, cwd = this.baseCwd): void {
    const targetCwd = this.resolveTargetCwd(cwd);
    const disabled = this.loadDisabledSet(targetCwd);
    if (enabled) {
      disabled.delete(id);
    } else {
      disabled.add(id);
    }
    this.saveDisabledSet(disabled, targetCwd);
  }

  saveHubRule(input: {
    name: string;
    scope: ResourceScope;
    content: string;
    cwd?: string;
  }): SharedResourceItem {
    const targetCwd = this.resolveTargetCwd(input.cwd);
    const targetDir = input.scope === "global" ? this.globalRulesDir : this.projectRulesDirFor(targetCwd);
    if (input.scope === "project") {
      this.ensureProjectHubGitignore(targetCwd);
    }
    fs.mkdirSync(targetDir, { recursive: true });
    const slug = slugifyRuleName(input.name);
    const filePath = path.join(targetDir, `${slug}.md`);
    const body = input.content.trim();
    const contentToWrite = /^#\s+/.test(body) ? `${body}\n` : `# ${input.name.trim()}\n\n${body}\n`;
    fs.writeFileSync(filePath, contentToWrite, "utf8");
    this.invalidateCache();

    const found = this.discover(targetCwd).find(
      (item) => path.resolve(item.primaryPath).toLowerCase() === path.resolve(filePath).toLowerCase(),
    );
    if (!found) {
      throw new Error("Failed to index saved Hub rule");
    }
    return found;
  }

  deleteHubRule(id: string, cwd = this.baseCwd): boolean {
    const targetCwd = this.resolveTargetCwd(cwd);
    const item = this.discover(targetCwd).find((i) => i.id === id);
    if (!item || (item.origin !== "hub-project" && item.origin !== "hub-global")) {
      return false;
    }
    const resolved = path.resolve(item.primaryPath).toLowerCase();
    const allowedRoots = [
      path.resolve(this.projectRulesDirFor(targetCwd)).toLowerCase(),
      path.resolve(this.globalRulesDir).toLowerCase(),
    ];
    if (!allowedRoots.some((root) => resolved.startsWith(root + path.sep))) {
      return false;
    }
    if (fs.existsSync(item.primaryPath)) {
      fs.unlinkSync(item.primaryPath);
      this.invalidateCache();
      return true;
    }
    return false;
  }

  readResourceContent(query: {
    id?: string;
    skillName?: string;
    cwd?: string;
  }): { item: SharedResourceItem; content: string } {
    const items = this.discover(query.cwd ?? this.baseCwd);
    let item: SharedResourceItem | undefined;
    if (query.id) {
      item = items.find((i) => i.id === query.id);
    } else if (query.skillName) {
      // Exact name first. A partial name is accepted only when it points at a single skill,
      // and disabled skills are not served at all.
      const needle = query.skillName.trim().toLowerCase();
      const skills = items.filter((i) => i.kind === "skill" && i.enabled);
      const partial = needle ? skills.filter((i) => i.name.toLowerCase().includes(needle)) : [];
      item =
        skills.find((i) => i.name.toLowerCase() === needle) ??
        (partial.length === 1 ? partial[0] : undefined);
      if (!item && partial.length > 1) {
        throw new Error(
          `Skill name "${query.skillName}" is ambiguous: ${partial.map((i) => i.name).slice(0, 8).join(", ")}`,
        );
      }
    }
    if (!item) {
      throw new Error(`Shared resource not found: ${query.id ?? query.skillName ?? ""}`);
    }
    const content = fs.readFileSync(item.primaryPath, "utf8");
    return { item, content };
  }

  syncProjectRuleFiles(cwd = this.baseCwd): string[] {
    const resolvedCwd = path.resolve(cwd);
    const enabledRules = this.discoverInternal(resolvedCwd).filter(
      (i) => i.enabled && i.kind === "rule" && (i.origin === "hub-project" || i.origin === "hub-global"),
    );
    const enabledSkills = this.discover(resolvedCwd).filter((i) => i.enabled && i.kind === "skill");

    const lines: string[] = [MANAGED_START, "## RTM Shared Rules & Skills (Synced)"];
    if (enabledRules.length === 0) {
      lines.push("", "_No Hub-authored shared rules yet._");
    } else {
      for (const r of enabledRules) {
        lines.push("", `### ${r.name} [${r.scope}]`, r._rawContent);
      }
    }
    if (enabledSkills.length > 0) {
      lines.push(
        "",
        `Shared skills available in hub: ${enabledSkills.length} (query via \`resource_list_shared\` / \`resource_read_skill\`).`,
      );
    }
    lines.push("", MANAGED_END);
    const block = lines.join("\n");

    const updatedFiles: string[] = [];
    for (const fileName of ["AGENTS.md", "CLAUDE.md"]) {
      const targetPath = path.join(resolvedCwd, fileName);
      const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
      const stripped = stripManagedHubBlock(existing);
      const next = stripped ? `${stripped}\n\n${block}\n` : `${block}\n`;
      fs.writeFileSync(targetPath, next, "utf8");
      updatedFiles.push(targetPath);
    }
    this.invalidateCache();
    return updatedFiles;
  }
}
