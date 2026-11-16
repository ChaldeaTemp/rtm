// Configuration counts for scene boards: agents, shared skills, rules and MCP servers,
// scoped to one directory. Reads are cached per scope and cancellable; a late answer for an
// old scope never lands in the current one. Unknown and failed counts are never shown as 0.

import { summarizeAgents, summarizeMcp, summarizeResources } from "./board-classic-model.js";

export const CONFIG_KEYS = ["agents", "resources", "rules", "mcp"];

/**
 * @param {{ getState(): any, getCards(): any[], getProject(): string, getPublishCwd(): string,
 *   projectKey(v: string): string, apiFetch: typeof fetch, onUpdate(): void }} api
 */
export function createSceneConfig(api) {
  const config = { scope: "", seq: 0, controller: null, entries: new Map() };

  function currentScope() {
    const project = api.getProject();
    if (project) {
      const state = api.getState();
      const fromCards = api.getCards().find((card) => card.cwd && api.projectKey(card.cwd) === project)?.cwd;
      const fromProjects = (state.projects || []).find((item) => item?.path && api.projectKey(item.path) === project)?.path;
      return fromCards || fromProjects || project;
    }
    return String(api.getPublishCwd() || api.getState().baseCwd || "").trim();
  }

  async function fetchJson(url, signal) {
    const res = await api.apiFetch(url, { signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok !== true) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  /** Loads the current scope when it changed, or always when `force`. */
  function ensure(force = false) {
    const scope = currentScope();
    if (!scope || (!force && scope === config.scope)) return;
    config.controller?.abort();
    const controller = new AbortController();
    const seq = ++config.seq;
    config.scope = scope;
    config.controller = controller;
    let entry = config.entries.get(scope);
    if (!entry) {
      entry = { resources: { status: "loading", data: null, error: "" }, mcp: { status: "loading", data: null, error: "" } };
      config.entries.set(scope, entry);
    } else {
      for (const part of [entry.resources, entry.mcp]) part.status = "loading";
    }
    const query = `?cwd=${encodeURIComponent(scope)}`;
    const load = (part, url, pick) => fetchJson(url, controller.signal).then((data) => {
      if (seq !== config.seq) return;
      Object.assign(part, { status: "ok", data: pick(data), error: "" });
    }, (err) => {
      if (seq !== config.seq) return;
      Object.assign(part, { status: "error", error: err?.message || String(err) });
    });
    void Promise.all([
      load(entry.resources, `/api/resources${query}`, (data) => (Array.isArray(data.resources) ? data.resources : [])),
      load(entry.mcp, `/api/mcp${query}`, (data) => (Array.isArray(data.servers) ? data.servers : [])),
    ]).then(() => {
      if (seq === config.seq) api.onUpdate();
    });
  }

  /** Drops in-flight reads; the next ensure() loads again. Cached results stay for display. */
  function reset() {
    config.controller?.abort();
    config.controller = null;
    config.seq++;
    config.scope = "";
  }

  /** { status: loading|ok|error, error, summary: {included, excluded} | null } */
  function summarize(key) {
    if (key === "agents") {
      const agents = Array.isArray(api.getState().agents) ? api.getState().agents : [];
      return { status: agents.length ? "ok" : "loading", error: "", summary: agents.length ? summarizeAgents(agents) : null };
    }
    const entry = config.entries.get(config.scope);
    const part = key === "mcp" ? entry?.mcp : entry?.resources;
    if (!part) return { status: "loading", error: "", summary: null };
    const summary = part.data
      ? key === "mcp" ? summarizeMcp(part.data) : summarizeResources(part.data, key === "rules" ? "rule" : "skill")
      : null;
    return { status: part.status, error: part.error, summary };
  }

  /** key → { value: number|null, state: ok|stale|loading|error } */
  function counts() {
    const out = {};
    for (const key of CONFIG_KEYS) {
      const { status, summary } = summarize(key);
      const value = summary ? summary.included.length : null;
      const state = status === "ok" ? "ok" : summary ? (status === "error" ? "stale" : "ok") : status;
      out[key] = { value, state };
    }
    return out;
  }

  return {
    ensure,
    reset,
    summarize,
    counts,
    currentScope,
    get scope() {
      return config.scope;
    },
  };
}
