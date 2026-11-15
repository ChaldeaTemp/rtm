import "./isolate-data.js";

// Manual browser fixture for the classic board: an isolated hub with mock agents and board
// tasks in every state the scene maps (queued, running, question / stalled / interrupted
// waits, delivered, failed incl. a cancelled one, done) across two project directories.
// Usage: tsx scripts/fixture-classic-board.ts [port]   — stays running until killed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentHubServer } from "../src/hub/server.js";

type Json = Record<string, any>;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOCK = path.join(ROOT, "scripts", "mock-agent.mjs");
const port = Number(process.argv[2]) || 4399;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtm-classic-fixture-"));
const projA = path.join(tmp, "alpha-app");
const projB = path.join(tmp, "beta-service");
const stateDir = path.join(tmp, "mock-state");
for (const dir of [projA, projB, stateDir]) fs.mkdirSync(dir, { recursive: true });
// Project A: one project rule, one project skill and a project MCP file. Project B: one rule.
fs.writeFileSync(path.join(projA, "AGENTS.md"), "# Alpha rules\n\nKeep changes small.\n");
fs.mkdirSync(path.join(projA, ".claude", "skills", "alpha-release"), { recursive: true });
fs.writeFileSync(path.join(projA, ".claude", "skills", "alpha-release", "SKILL.md"), "---\nname: alpha-release\ndescription: Release checklist for alpha\n---\nSteps.\n");
fs.writeFileSync(path.join(projA, ".mcp.json"), JSON.stringify({ mcpServers: { "alpha-docs": { command: "node", env: { TOKEN: "${RTM_FIXTURE_MISSING}" } } } }));
fs.writeFileSync(path.join(projB, "CLAUDE.md"), "# Beta rules\n\nAlways add tests.\n");

const hub = new AgentHubServer({ baseCwd: projA, port, writeRuntimeFile: false, persistState: true, defaultLead: "mock-a" });
(hub as any).memory.sampler = async () => ({ availableMB: 9000, totalMB: 57000 });
const url = await hub.start(port);
const post = (p: string, body: unknown): Promise<Json> =>
  fetch(url + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Json>);
const cards = async (): Promise<Json[]> => ((await (await fetch(url + "/api/board")).json()) as Json).cards ?? [];

for (const id of ["mock-a", "mock-b"]) {
  const res = await post("/api/agents/save", {
    id, label: id.toUpperCase(), description: "mock", enabled: true,
    command: process.execPath, args: [MOCK], env: { MOCK_STATE_DIR: stateDir, MOCK_SLOW_MS: "3600000" },
  });
  if (!res.ok) throw new Error(res.error);
}
await post("/api/settings", { boardParallel: 8 });

const publish = async (cwd: string, items: Array<{ brief: string; title?: string }>): Promise<string[]> => {
  const res = await post("/api/board/publish", { items: items.map((item) => ({ ...item, cwd, leadAgent: "mock-a" })) });
  if (!res.ok) throw new Error(res.error);
  return res.groups.map((g: Json) => g.groupId);
};
const until = async (cond: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await cond()); i++) await sleep(150);
};
const status = async (id: string) => (await cards()).find((c) => c.groupId === id)?.board.status;

// Everything that must start runs first, while there are free slots.
const [, , ask, stall, intr, deliver, fail, cancel] = await publish(projA, [
  { brief: "SLOW 调整中文操作文案", title: "调整中文操作文案" },
  { brief: "SLOW 核对深色模式", title: "核对深色模式" },
  { brief: "SLOW 确认新版导航顺序", title: "确认新版导航顺序" },
  { brief: "SLOW 选择文档站访问权限方案", title: "选择文档站访问权限方案" },
  { brief: "SLOW 检查断线恢复", title: "检查断线恢复" },
  { brief: "SLOW 发布前回归检查", title: "发布前回归检查" },
  { brief: "SLOW 导入数据去重", title: "导入数据去重" },
  { brief: "SLOW 优化日志归档", title: "优化日志归档" },
]);
await publish(projB, [{ brief: "SLOW 接口文档更新", title: "接口文档更新" }]);
await until(async () => (await cards()).filter((c) => c.board.status === "running").length >= 9);

void hub.askUserQuestion({ groupId: ask, sessionKey: `mock-a:${ask}__lead`, title: "Pick", questions: [{ id: "a", question: "新版导航把“设置”放在第几位？", type: "text" }] });
const mark = (id: string, patch: Json) => {
  const group = (hub as any).groups.get(id);
  Object.assign(group.board, patch);
  (hub as any).boardChanged(group);
};
mark(stall, { stalled: true });
mark(intr, { interrupted: true });
fs.mkdirSync(path.join(projA, "out"), { recursive: true });
fs.writeFileSync(path.join(projA, "out", "regression.md"), "# Regression\n\nAll green.\n");
await post("/api/board/report", { groupId: deliver, outcome: "delivered", summary: "回归检查已完成，全部通过。", deliverables: [{ kind: "file", path: "out/regression.md", note: "回归报告" }, { kind: "text", note: "共 42 项" }] });
await post("/api/board/report", { groupId: fail, outcome: "failed", summary: "无法访问数据源", reason: "数据源连接超时" });
await post("/api/board/action", { groupId: cancel, action: "cancel" });

// Fill the remaining slots, then queue the rest so they stay queued.
await post("/api/settings", { boardParallel: 1 });
await publish(projA, [
  { brief: "SLOW q", title: "整理发布说明" },
  { brief: "SLOW q", title: "补充搜索空态" },
  { brief: "SLOW q", title: "<img src=x onerror=alert(1)> 一个特别特别长的任务标题，用来检查标题在明细与清单中是否会被挤压或者撑破主场景的布局" },
  { brief: "SLOW q", title: "增加数据校验" },
  { brief: "SLOW q", title: "更新配置说明" },
]);
await publish(projB, [{ brief: "SLOW q", title: "任务导出说明" }, { brief: "SLOW q", title: "历史数据校验报告" }]);

// One accepted task for the "finished" entry.
const [doneId] = await publish(projB, [{ brief: "quick", title: "文档预览构建" }]);
mark(doneId, { status: "running", startedAt: Date.now() });
await post("/api/board/report", { groupId: doneId, outcome: "delivered", summary: "预览构建完成" });
await post("/api/board/action", { groupId: doneId, action: "confirm" });

const summary = (await cards()).reduce<Record<string, number>>((acc, c) => {
  const key = c.board.status === "running" && c.waiting ? `waiting:${c.waitingReason}` : c.board.status;
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});
console.log(`FIXTURE READY ${url}`);
console.log(`projects: ${projA} | ${projB}`);
console.log(JSON.stringify(summary));
console.log(`cancelled task status: ${await status(cancel)}`);

const stop = async () => {
  await hub.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
