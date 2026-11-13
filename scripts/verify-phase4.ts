import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AgentHubServer } from "../src/hub/server.js";

const AGENTS_CONFIG_FILE = path.join(process.cwd(), ".agent-hub", "agents.json");

async function httpJson<T>(url: string, init?: RequestInit): Promise<{ status: number; data: T }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON from ${url} (${res.status}), got: ${text.slice(0, 200)}`);
  }
  return { status: res.status, data };
}

async function main(): Promise<void> {
  const hadConfig = fs.existsSync(AGENTS_CONFIG_FILE);
  const prevConfig = hadConfig ? fs.readFileSync(AGENTS_CONFIG_FILE, "utf8") : undefined;

  const hub = new AgentHubServer({
    baseCwd: process.cwd(),
    port: 0,
    writeRuntimeFile: false,
    permissionMode: "approve-all",
  });

  try {
    const baseUrl = await hub.start(0);
    console.log("[phase4] Hub started at", baseUrl);

    // 1. Built-in 5 agents available & authReady
    const agentsRes = await httpJson<{
      ok: boolean;
      agents: Array<{
        agent: string;
        builtin: boolean;
        enabled: boolean;
        available: boolean;
        authReady: boolean;
        reason?: string;
      }>;
    }>(`${baseUrl}/api/agents`);
    assert.equal(agentsRes.status, 200);
    assert.equal(agentsRes.data.ok, true);

    for (const id of ["claude", "codex", "agy", "opencode", "kimi"]) {
      const found = agentsRes.data.agents.find((a) => a.agent === id);
      assert.ok(found, `Missing built-in agent: ${id}`);
      assert.equal(found.builtin, true, `Expected ${id} to be builtin`);
      assert.equal(found.available, true, `Expected ${id} to be available: ${found.reason ?? ""}`);
      assert.equal(found.authReady, true, `Expected ${id} authReady=true: ${found.reason ?? ""}`);
    }
    console.log("[phase4] 1. All 5 built-in agents healthy & authReady");

    // 2. Real ACP handshakes for kimi and opencode
    for (const id of ["kimi", "opencode"]) {
      const probe = await httpJson<{
        ok: boolean;
        sessionId?: string;
        latencyMs: number;
        error?: string;
      }>(`${baseUrl}/api/agents/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      assert.equal(probe.status, 200);
      assert.equal(probe.data.ok, true, `ACP handshake failed for ${id}: ${probe.data.error ?? "unknown"}`);
      assert.ok(probe.data.sessionId, `Expected sessionId from ${id} handshake`);
      console.log(`[phase4] 2. ACP handshake passed for ${id} (${probe.data.latencyMs}ms, session=${probe.data.sessionId})`);
    }

    // 3. Real chat turn with kimi lead
    const grpRes = await httpJson<{ ok: boolean; group: { groupId: string; leadAgent: string } }>(
      `${baseUrl}/api/groups`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Phase4 Kimi Check", leadAgent: "kimi" }),
      },
    );
    assert.equal(grpRes.status, 200);
    assert.equal(grpRes.data.group.leadAgent, "kimi");

    const chatRes = await httpJson<{
      ok: boolean;
      outputText?: string;
      error?: string;
    }>(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: grpRes.data.group.groupId,
        prompt: "只回复 OK 两个字母，不要调用任何工具",
      }),
    });
    assert.equal(chatRes.status, 200, `kimi /api/chat failed: ${chatRes.data.error ?? ""}`);
    assert.equal(chatRes.data.ok, true);
    assert.ok((chatRes.data.outputText ?? "").trim().length > 0, "Expected non-empty reply from kimi");

    const telRes = await httpJson<{
      ok: boolean;
      telemetry: { byAgent: Record<string, { turns: number }> };
    }>(`${baseUrl}/api/telemetry`);
    assert.equal(telRes.status, 200);
    assert.ok((telRes.data.telemetry.byAgent.kimi?.turns ?? 0) >= 1, "Expected kimi telemetry turns >= 1");
    console.log(`[phase4] 3. Live kimi turn succeeded: "${(chatRes.data.outputText ?? "").trim()}"`);

    // 4. Custom agent horizontal scaling CRUD (save -> resource budget -> toggle off -> delete)
    const saveCustom = await httpJson<{ ok: boolean; agent: { id: string } }>(`${baseUrl}/api/agents/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "custom-echo",
        label: "custom-echo",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 500)"],
        color: "#4338ca",
        description: "Phase 4 test custom ACP agent",
        enabled: true,
      }),
    });
    assert.equal(saveCustom.status, 200);
    assert.equal(saveCustom.data.agent.id, "custom-echo");

    const resAfterSave = await httpJson<{
      ok: boolean;
      budgets: Array<{ agent: string }>;
    }>(`${baseUrl}/api/resources`);
    assert.ok(
      resAfterSave.data.budgets.some((b) => b.agent === "custom-echo"),
      "Expected custom-echo in resource budgets when enabled",
    );

    const toggleOff = await httpJson<{ ok: boolean }>(`${baseUrl}/api/agents/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "custom-echo", enabled: false }),
    });
    assert.equal(toggleOff.status, 200);

    const resAfterDisable = await httpJson<{
      ok: boolean;
      budgets: Array<{ agent: string }>;
    }>(`${baseUrl}/api/resources`);
    assert.equal(
      resAfterDisable.data.budgets.some((b) => b.agent === "custom-echo"),
      false,
      "Disabled custom-echo should not appear in enabled resource budgets",
    );

    const delCustom = await httpJson<{ ok: boolean; deleted: boolean }>(`${baseUrl}/api/agents/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "custom-echo" }),
    });
    assert.equal(delCustom.status, 200);
    assert.equal(delCustom.data.deleted, true);
    console.log("[phase4] 4. Custom agent CRUD & budget integration verified");

    // 5. Generative interactive Artifact API & HTML serving
    const artCreate = await httpJson<{
      ok: boolean;
      artifact: { artifactId: string; title: string; kind: string };
      previewUrl: string;
    }>(`${baseUrl}/api/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: grpRes.data.group.groupId,
        agent: "kimi",
        title: "Phase 4 Interactive Widget",
        kind: "html",
        content: `<div id="demo-widget">Hello Interactive World</div><script>window.__demo=1;</script>`,
        height: 260,
      }),
    });
    assert.equal(artCreate.status, 200);
    const artifactId = artCreate.data.artifact.artifactId;
    assert.ok(artifactId);

    const artList = await httpJson<{
      ok: boolean;
      artifacts: Array<{ artifactId: string }>;
    }>(`${baseUrl}/api/artifacts`);
    assert.ok(artList.data.artifacts.some((a) => a.artifactId === artifactId));

    const artPageRes = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}`);
    assert.equal(artPageRes.status, 200);
    const artHtml = await artPageRes.text();
    assert.ok(artHtml.includes("demo-widget"), "Expected artifact body inside /artifacts/:id HTML");
    assert.ok(artHtml.includes("__hubArtifactId"), "Expected iframe resize reporter script in /artifacts/:id HTML");

    const msgs = hub.getMessages({ groupId: grpRes.data.group.groupId });
    assert.ok(
      msgs.some((m) => Array.isArray(m.artifactIds) && m.artifactIds.includes(artifactId)),
      "Expected message record linking created artifactId",
    );
    console.log("[phase4] 5. Generative Artifact creation, serving & message linking verified");

    // 6. Structured interactive Question round-trip (ask -> list pending -> resolve -> caller unblocks)
    const askPromise = httpJson<{
      ok: boolean;
      questionId: string;
      cancelled: boolean;
      answers: Record<string, unknown>;
    }>(`${baseUrl}/api/questions/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: grpRes.data.group.groupId,
        agent: "kimi",
        title: "Phase 4 Decision Card",
        questions: [
          {
            id: "q1",
            question: "请选择执行方案",
            type: "single",
            options: ["方案A", "方案B"],
          },
        ],
        timeoutSeconds: 20,
      }),
    });

    let pendingId = "";
    for (let i = 0; i < 30; i++) {
      const qList = await httpJson<{
        ok: boolean;
        questions: Array<{ questionId: string; fields: Array<{ id: string }> }>;
      }>(`${baseUrl}/api/questions`);
      const match = qList.data.questions.find((q) => q.fields.some((f) => f.id === "q1"));
      if (match) {
        pendingId = match.questionId;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(pendingId, "Expected pending question in GET /api/questions");

    const resolveRes = await httpJson<{ ok: boolean; resolved: boolean }>(`${baseUrl}/api/questions/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questionId: pendingId,
        answers: { q1: "方案A" },
        cancelled: false,
      }),
    });
    assert.equal(resolveRes.status, 200);
    assert.equal(resolveRes.data.resolved, true);

    const askDone = await askPromise;
    assert.equal(askDone.status, 200);
    assert.equal(askDone.data.cancelled, false);
    assert.deepEqual(askDone.data.answers, { q1: "方案A" });
    console.log("[phase4] 6. Interactive Question blocking & resolution round-trip verified");

    // 7. UI assets reachable & contain new tabs/scripts
    const uiIndex = await fetch(`${baseUrl}/`);
    assert.equal(uiIndex.status, 200);
    const uiIndexHtml = await uiIndex.text();
    assert.ok(uiIndexHtml.includes("Agent 接入"), "Expected 04 Agent 接入 tab in index.html");
    assert.ok(uiIndexHtml.includes("/ui/interactive.js"), "Expected /ui/interactive.js script tag in index.html");

    const uiInteractive = await fetch(`${baseUrl}/ui/interactive.js`);
    assert.equal(uiInteractive.status, 200);

    const uiPanelsCss = await fetch(`${baseUrl}/ui/panels.css`);
    assert.equal(uiPanelsCss.status, 200);
    console.log("[phase4] 7. UI HTML/JS/CSS assets verified");
  } finally {
    await hub.stop();
    if (hadConfig && prevConfig !== undefined) {
      fs.mkdirSync(path.dirname(AGENTS_CONFIG_FILE), { recursive: true });
      fs.writeFileSync(AGENTS_CONFIG_FILE, prevConfig, "utf8");
    } else if (fs.existsSync(AGENTS_CONFIG_FILE)) {
      fs.unlinkSync(AGENTS_CONFIG_FILE);
    }
  }
}

main().catch((err) => {
  console.error("[phase4] FAILED:", err);
  process.exit(1);
});
