// 端到端测量一轮对话的耗时：起一个私有 hub（不写 runtime.json），按任务依次发极短提示词。
// 用法：npx tsx scripts/bench-turn-latency.ts opencode,codex 3（不写 Agent 时默认 opencode）
// 预热模式：npx tsx scripts/bench-turn-latency.ts opencode 2 --warm
//   建任务后先调 /api/sessions/warm，等 3 s（BENCH_WARM_WAIT_MS 可改）再发第一条消息。
// 输出每轮的 total 以及 session 状态变化、首个 chunk 的时间点（毫秒，相对发送时刻）。
import "./isolate-data.js";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { AgentHubServer } from "../src/hub/server.js";

const agents = (process.argv[2] || "opencode").split(",");
const turns = Number(process.argv[3] || 2);
const port = Number(process.env.BENCH_PORT || 4399);
const warm = process.argv.slice(2).includes("--warm");
const warmWaitMs = Number(process.env.BENCH_WARM_WAIT_MS || 3000);

const hub = new AgentHubServer({ baseCwd: process.cwd(), port, strictPort: true, writeRuntimeFile: false });
const url = await hub.start(port);
const ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
await new Promise<void>((resolve, reject) => {
  ws.on("open", () => resolve());
  ws.on("error", reject);
});

let marks: Record<string, number> = {};
let t0 = 0;
const mark = (key: string) => {
  if (!(key in marks)) marks[key] = Math.round(performance.now() - t0);
};
ws.on("message", (raw: WebSocket.RawData) => {
  if (!t0) return;
  const ev = JSON.parse(raw.toString());
  if (ev.type === "session_updated") mark(`session:${ev.session.status}`);
  if (ev.type === "agent_chunk") mark(`first_${ev.channel}_chunk`);
  if (ev.type === "tool_event") mark(`first_tool:${ev.title}`);
});

const post = async (p: string, body: unknown) =>
  (
    await fetch(url + p, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();

for (const agent of agents) {
  const created = await post("/api/groups", { leadAgent: agent, title: `bench-${agent}` });
  const tag = warm ? `${agent}[warm]` : agent;
  if (warm) {
    const w = await post("/api/sessions/warm", { groupId: created.group.groupId });
    console.log(`${tag} warm: ${JSON.stringify(w)}，等待 ${warmWaitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, warmWaitMs));
    const s = hub.pool.getSession(w.sessionKey);
    console.log(`${tag} 发送前会话状态: ${s?.status ?? "未就绪"} promptInjection=${s?.promptInjection ?? "-"}`);
  }
  for (let i = 0; i < turns; i++) {
    marks = {};
    t0 = performance.now();
    const r = await post("/api/chat", {
      groupId: created.group.groupId,
      prompt: "只回复两个字：好的。不要调用任何工具。",
    });
    const total = Math.round(performance.now() - t0);
    console.log(`${tag} turn${i + 1}: total=${total}ms ${JSON.stringify(marks)} inject=${hub.pool.getSession(r.sessionKey)?.promptInjection ?? "-"}${r.ok === false ? ` error=${r.error}` : ""}`);
  }
}

ws.close();
await hub.stop();
process.exit(0);
