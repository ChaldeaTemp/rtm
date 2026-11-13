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

const MANAGED_START = "<!-- agent-hub:shared:start -->";
const MANAGED_END = "<!-- agent-hub:shared:end -->";
const MANAGED_BLOCK_RE = /<!--\s*agent-hub:shared:start\s*-->[\s\S]*?<!--\s*agent-hub:shared:end\s*-->/g;
const MAX_RULE_INJECTION_TOKENS = 16_000;

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

function mergeAgents(a: AgentId[], b: AgentId[]): AgentId[] {
  const set = new Set<AgentId>([...a, ...b]);
  return ALL_AGENTS.filter((agent) => set.has(agent));
}

function sha16(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export class SharedResourceManager {
  readonly baseCwd: string;
  readonly homeDir: string;
  private readonly projectHubDir: string;
  private readonly projectRulesDir: string;
  private readonly globalRulesDir: string;
  private readonly configFile: string;

  constructor(baseCwd: string, homeDir = os.homedir()) {
    this.baseCwd = path.resolve(baseCwd);
    this.homeDir = path.resolve(homeDir);
    this.projectHubDir = path.join(this.baseCwd, ".agent-hub");
    this.projectRulesDir = path.join(this.projectHubDir, "resources", "rules");
    this.globalRulesDir = path.join(this.homeDir, ".agent-hub", "resources", "rules");
    this.configFile = path.join(this.projectHubDir, "resources", "config.json");
  }

  private loadDisabledSet(): Set<string> {
    if (!fs.existsSync(this.configFile)) {
      return new Set();
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configFile, "utf8")) as Partial<ResourceConfigFile>;
      return new Set(Array.isArray(parsed.disabledIds) ? parsed.disabledIds : []);
    } catch {
      return new Set();
    }
  }

  private ensureProjectHubGitignore(): void {
    fs.mkdirSync(this.projectHubDir, { recursive: true });
    const gitignorePath = path.join(this.projectHubDir, ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, "*\n", "utf8");
    }
  }

  private saveDisabledSet(disabled: Set<string>): void {
    this.ensureProjectHubGitignore();
    fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
    const payload: ResourceConfigFile = { disabledIds: [...disabled].sort() };
    fs.writeFileSync(this.configFile, JSON.stringify(payload, null, 2), "utf8");
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
    for (const f of listMarkdownFiles(path.join(cwd, ".agent-hub", "resources", "rules"))) {
      pushRule(f, "project", "hub-project", []);
    }
    for (const f of listMarkdownFiles(this.globalRulesDir)) {
      pushRule(f, "global", "hub-global", []);
    }
    pushRule(path.join(cwd, "AGENTS.md"), "project", "project", ["codex", "agy"]);
    pushRule(path.join(cwd, "CLAUDE.md"), "project", "project", ["claude"]);
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
    pushRule(path.join(this.homeDir, ".claude", "CLAUDE.md"), "global", "claude-global", ["claude"]);
    for (const f of listMarkdownFiles(path.join(this.homeDir, ".claude", "rules"))) {
      pushRule(f, "global", "claude-global", ["claude"]);
    }

    // --- Project & Hub Skills ---
    for (const f of listSkillFiles(path.join(cwd, ".agent-hub", "resources", "skills"))) {
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
    for (const f of listSkillFiles(path.join(this.homeDir, ".agent-hub", "resources", "skills"))) {
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
    for (const f of listSkillFiles(path.join(this.homeDir, ".claude", "skills"))) {
      pushSkill(f, "global", "claude-global", ["claude"]);
    }

    return candidates;
  }

  private discoverInternal(cwd = this.baseCwd): Array<SharedResourceItem & { _rawContent: string }> {
    const resolvedCwd = path.resolve(cwd);
    const disabled = this.loadDisabledSet();
    const candidates = this.collectRawCandidates(resolvedCwd);
    const mergedMap = new Map<string, { item: SharedResourceItem & { _rawContent: string } }>();

    for (const c of candidates) {
      const existing = mergedMap.get(c.dedupKey);
      if (!existing) {
        const nativeAgents = ALL_AGENTS.filter((a) => c.nativeAgents.includes(a));
        const bridgedAgents = ALL_AGENTS.filter((a) => !nativeAgents.includes(a));
        const id = c.dedupKey;
        const indexLine =
          c.kind === "skill"
            ? `- \`${c.name}\`: ${c.description} (SKILL.md: ${toForwardSlashes(c.filePath)})`
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
            enabled: !disabled.has(id),
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
        it.nativeAgents = mergeAgents(it.nativeAgents, c.nativeAgents);
        it.bridgedAgents = ALL_AGENTS.filter((a) => !it.nativeAgents.includes(a));
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
    return this.discoverInternal(cwd).map(({ _rawContent: _unused, ...item }) => item);
  }

  buildInjectionForAgent(agent: AgentId, cwd = this.baseCwd): AgentInjectionPayload {
    const items = this.discoverInternal(cwd);
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
    const ruleBlocks: string[] = [];
    let sharedRulesTokens = 0;

    for (const rule of bridgedRules) {
      const block = `### [${rule.scope === "project" ? "Project Rule" : "Global Rule"}] ${rule.name} (source: ${toForwardSlashes(rule.primaryPath)})\n${rule._rawContent}`;
      const tokens = estimateTokens(block);
      if (sharedRulesTokens + tokens > MAX_RULE_INJECTION_TOKENS && injectedRules.length > 0) {
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

    const skillLines = bridgedSkills.map((s) => {
      const desc = s.description.slice(0, 180);
      return `- \`${s.name}\` [${s.scope}]: ${desc} (SKILL.md: ${toForwardSlashes(s.primaryPath)})`;
    });
    const skillsSection =
      skillLines.length > 0
        ? [
            "## Shared Skills Index (Progressive Disclosure)",
            "Below are shared skills bridged across local agents. Only read the corresponding SKILL.md path (or call MCP resource_read_skill) when a task matches its description:",
            ...skillLines,
          ].join("\n")
        : "";
    const skillsIndexTokens = skillsSection ? estimateTokens(skillsSection) : 0;

    if (ruleBlocks.length === 0 && !skillsSection) {
      return {
        promptPrefix: "",
        sharedRulesTokens: 0,
        skillsIndexTokens: 0,
        injectedRules: [],
        injectedSkillsCount: 0,
        nativeRulesCount,
        nativeSkillsCount,
      };
    }

    const sections: string[] = [
      "<shared_resources_context>",
      `Bridged shared resources for ${agent} (automatically excluding rules/skills already loaded natively by ${agent}):`,
    ];
    if (ruleBlocks.length > 0) {
      sections.push("", "## Active Shared Rules", ruleBlocks.join("\n\n"));
    }
    if (skillsSection) {
      sections.push("", skillsSection);
    }
    sections.push("</shared_resources_context>", "");

    return {
      promptPrefix: `${sections.join("\n")}\n`,
      sharedRulesTokens,
      skillsIndexTokens,
      injectedRules,
      injectedSkillsCount: skillLines.length,
      nativeRulesCount,
      nativeSkillsCount,
    };
  }

  getAgentBudgets(cwd = this.baseCwd): AgentResourceBudget[] {
    const items = this.discover(cwd).filter((i) => i.enabled);
    return ALL_AGENTS.map((agent) => {
      const inj = this.buildInjectionForAgent(agent, cwd);
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
      };
    });
  }

  setResourceEnabled(id: string, enabled: boolean): void {
    const disabled = this.loadDisabledSet();
    if (enabled) {
      disabled.delete(id);
    } else {
      disabled.add(id);
    }
    this.saveDisabledSet(disabled);
  }

  saveHubRule(input: { name: string; scope: ResourceScope; content: string }): SharedResourceItem {
    const targetDir = input.scope === "global" ? this.globalRulesDir : this.projectRulesDir;
    if (input.scope === "project") {
      this.ensureProjectHubGitignore();
    }
    fs.mkdirSync(targetDir, { recursive: true });
    const slug = slugifyRuleName(input.name);
    const filePath = path.join(targetDir, `${slug}.md`);
    const body = input.content.trim();
    const contentToWrite = /^#\s+/.test(body) ? `${body}\n` : `# ${input.name.trim()}\n\n${body}\n`;
    fs.writeFileSync(filePath, contentToWrite, "utf8");

    const found = this.discover(this.baseCwd).find(
      (item) => path.resolve(item.primaryPath).toLowerCase() === path.resolve(filePath).toLowerCase(),
    );
    if (!found) {
      throw new Error("Failed to index saved Hub rule");
    }
    return found;
  }

  deleteHubRule(id: string): boolean {
    const item = this.discover(this.baseCwd).find((i) => i.id === id);
    if (!item || (item.origin !== "hub-project" && item.origin !== "hub-global")) {
      return false;
    }
    const resolved = path.resolve(item.primaryPath).toLowerCase();
    const allowedRoots = [
      path.resolve(this.projectRulesDir).toLowerCase(),
      path.resolve(this.globalRulesDir).toLowerCase(),
    ];
    if (!allowedRoots.some((root) => resolved.startsWith(root + path.sep))) {
      return false;
    }
    if (fs.existsSync(item.primaryPath)) {
      fs.unlinkSync(item.primaryPath);
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
      const needle = query.skillName.trim().toLowerCase();
      item =
        items.find((i) => i.kind === "skill" && i.name.toLowerCase() === needle) ??
        items.find((i) => i.kind === "skill" && i.name.toLowerCase().includes(needle));
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

    const lines: string[] = [MANAGED_START, "## Agent Hub Shared Rules & Skills (Synced)"];
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
    return updatedFiles;
  }
}
