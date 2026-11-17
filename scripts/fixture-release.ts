import "./isolate-data.js";
// Visual-only fixtures. No subscription requests or real model handshakes are made.
import { AgentQuotaReader } from "../src/hub/agent-quota.js";
import { AgentRegistry } from "../src/hub/agent-registry.js";

AgentQuotaReader.prototype.read = async function (def) {
  const low = def.id === "kimi";
  return { status: "ok", checkedAt: Date.now(), windows: [
    { minutes: 300, usedPercent: low ? 94 : 28, resetsAt: Date.now() + 7200000 },
    { minutes: 10080, usedPercent: low ? 76 : 45, resetsAt: Date.now() + 172800000 },
  ] };
};
AgentRegistry.prototype.getHealthList = function (includeDisabled = false) {
  return (includeDisabled ? this.listDefinitions() : this.listEnabledDefinitions()).map((def) => ({
    ...def, agent: def.id, available: true, authReady: true, command: [def.command || `${def.id} (visual fixture)`],
    quotaSupported: ["claude", "codex", "kimi"].includes(def.id),
    modelCatalog: this.getModelCatalog(def.id), discoveredModelIds: this.getDiscoveredModelIds(def.id),
  }));
};
AgentRegistry.prototype.discoverModels = async function (agent) {
  return { agent, models: [{ id: "fixture", name: "Visual fixture" }], updatedAt: Date.now() };
};
if (process.argv.includes("--empty")) {
  const { AgentHubServer } = await import("../src/hub/server.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const hub = new AgentHubServer({ baseCwd: mkdtempSync(join(tmpdir(), "rtm-empty-")), writeRuntimeFile: false });
  (hub as any).memory.sampler = async () => ({ availableMB: 9000, totalMB: 16000 });
  console.log(`EMPTY FIXTURE ${await hub.start(Number(process.argv[2]) || 4397)}`);
  process.on("SIGINT", async () => { await hub.stop(); process.exit(0); });
} else {
  await import("./fixture-classic-board.js");
}
