// Scene boards' configuration reads (src/ui/board-scene-config.js): directory scope order,
// late answers for an old scope, unknown vs zero, and failures keeping the last result.
// Uses a scripted fetch; no hub or browser needed.

import { createSceneConfig } from "../src/ui/board-scene-config.js";

type Json = Record<string, any>;
let failed = 0;
function check(name: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` (${extra})` : ""}`);
  if (!ok) failed += 1;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// Each request waits until the test answers it.
const pending: Array<{ url: string; resolve: (body: Json) => void; reject: (err: Error) => void; signal?: AbortSignal }> = [];
const apiFetch = (url: string, init?: { signal?: AbortSignal }) => new Promise<Response>((resolve, reject) => {
  pending.push({
    url,
    signal: init?.signal,
    resolve: (body) => resolve(new Response(JSON.stringify(body), { status: 200 })),
    reject,
  });
});
const answer = async (match: (url: string) => boolean, body: Json | Error) => {
  for (const req of pending.filter((r) => match(r.url))) {
    pending.splice(pending.indexOf(req), 1);
    if (body instanceof Error) req.reject(body);
    else req.resolve(body);
  }
  await tick();
  await tick();
};

const state: Json = { baseCwd: "D:/base", projects: [{ path: "D:/projB" }], agents: [] };
const cards: Json[] = [{ cwd: "D:/projA" }];
let project = "";
let publishCwd = "";
let updates = 0;
const config = createSceneConfig({
  getState: () => state,
  getCards: () => cards,
  getProject: () => project,
  getPublishCwd: () => publishCwd,
  projectKey: (v: string) => v.toLowerCase(),
  apiFetch: apiFetch as unknown as typeof fetch,
  onUpdate: () => { updates += 1; },
});

const resources = (n: number, m = 0) => ({
  ok: true,
  resources: [
    ...Array.from({ length: n }, (_, i) => ({ id: `s${i}`, kind: "skill", enabled: true })),
    ...Array.from({ length: m }, (_, i) => ({ id: `r${i}`, kind: "rule", enabled: true })),
  ],
});
const mcp = (ids: string[]) => ({ ok: true, servers: ids.map((id) => ({ id, enabled: true, trusted: true, missingEnv: [] })) });

console.log("=== Scope order ===");
check("falls back to baseCwd", config.currentScope() === "D:/base");
publishCwd = "D:/publish";
check("publish directory before baseCwd", config.currentScope() === "D:/publish");
project = "d:/proja";
check("selected project from cards first", config.currentScope() === "D:/projA");
project = "d:/projb";
check("selected project from the project list", config.currentScope() === "D:/projB");

console.log("=== Loading, zero and unknown ===");
project = "d:/proja";
config.ensure();
check("both reads carry the scope", pending.length === 2 && pending.every((r) => r.url.includes(encodeURIComponent("D:/projA"))), pending.map((r) => r.url).join(" "));
let counts = config.counts();
check("unknown is not zero", counts.resources.value === null && counts.resources.state === "loading" && counts.mcp.value === null);
check("agents unknown until listed", counts.agents.value === null);
await answer((u) => u.startsWith("/api/resources"), resources(3, 2));
await answer((u) => u.startsWith("/api/mcp"), mcp([]));
counts = config.counts();
check("counts after load", counts.resources.value === 3 && counts.rules.value === 2 && counts.mcp.value === 0 && counts.mcp.state === "ok");
check("listeners told once loaded", updates === 1);
config.ensure();
check("same scope is not reloaded", pending.length === 0);

console.log("=== Late answers ===");
project = "d:/projb";
config.ensure();
const aborted = pending.filter((r) => r.signal?.aborted).length;
project = "d:/proja";
config.ensure();
check("switching scope aborts the old reads", aborted === 0 && pending.filter((r) => r.url.includes("projB")).every((r) => r.signal?.aborted));
await answer((u) => u.includes("projB") && u.startsWith("/api/resources"), resources(9));
await answer((u) => u.includes("projB") && u.startsWith("/api/mcp"), mcp(["x", "y"]));
counts = config.counts();
check("a late answer for B does not land in A", config.scope === "D:/projA" && counts.resources.value === 3 && counts.mcp.value === 0);
await answer((u) => u.includes("projA") && u.startsWith("/api/resources"), resources(4, 1));
await answer((u) => u.includes("projA") && u.startsWith("/api/mcp"), mcp(["m1"]));
counts = config.counts();
check("the current scope's answer lands", counts.resources.value === 4 && counts.rules.value === 1 && counts.mcp.value === 1);

console.log("=== Failures ===");
config.ensure(true);
await answer((u) => u.startsWith("/api/resources"), new Error("disk busy"));
await answer((u) => u.startsWith("/api/mcp"), mcp(["m1", "m2"]));
counts = config.counts();
const res = config.summarize("resources");
check("a failed refresh keeps the last result, marked stale", counts.resources.value === 4 && counts.resources.state === "stale" && res.status === "error" && res.error === "disk busy");
check("the other part still updates", counts.mcp.value === 2 && counts.mcp.state === "ok");
project = "d:/projb";
config.ensure();
await answer((u) => u.startsWith("/api/resources"), new Error("offline"));
await answer((u) => u.startsWith("/api/mcp"), new Error("offline"));
counts = config.counts();
check("a first-time failure is an error, not zero", counts.resources.value === null && counts.resources.state === "error" && counts.mcp.state === "error");
config.reset();
check("reset forgets the active scope", config.scope === "");

state.agents = [{ agent: "codex", enabled: true }, { agent: "kimi", enabled: false }];
check("agent count from state", config.counts().agents.value === 1 && config.summarize("agents").summary?.excluded.length === 1);

console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nScene config verification passed completely.");
process.exit(failed ? 1 : 0);
