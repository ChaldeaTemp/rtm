import assert from "node:assert/strict";
import { AgentHubServer } from "../src/hub/server.js";
import type { AgentModelCatalog, SessionRecord, TaskGroup } from "../src/types.js";

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
  const hub = new AgentHubServer({
    baseCwd: process.cwd(),
    port: 0,
    writeRuntimeFile: false,
    permissionMode: "approve-all",
  });

  try {
    const baseUrl = await hub.start(0);
    console.log("[phase5] Hub started at", baseUrl);

    // 1. Model & Thinking Effort Discovery API across kimi and codex
    const kimiModelsRes = await httpJson<{ ok: boolean; agent: string; catalog: AgentModelCatalog }>(
      `${baseUrl}/api/models?agent=kimi&refresh=1`,
    );
    assert.equal(kimiModelsRes.status, 200);
    assert.equal(kimiModelsRes.data.ok, true);
    const kimiCatalog = kimiModelsRes.data.catalog;
    assert.equal(kimiCatalog.modelControl, "config_option");
    assert.ok(kimiCatalog.models.length >= 2, `Expected >=2 kimi models, got ${kimiCatalog.models.length}`);
    assert.ok(
      kimiCatalog.effort && kimiCatalog.effort.options.length >= 2,
      "Expected kimi effort options to be discovered",
    );
    console.log(
      `[phase5] 1a. Kimi discovered ${kimiCatalog.models.length} models (default=${kimiCatalog.currentModelId}, effort=${kimiCatalog.effort.configId}:${kimiCatalog.effort.currentValue})`,
    );

    const codexModelsRes = await httpJson<{ ok: boolean; agent: string; catalog: AgentModelCatalog }>(
      `${baseUrl}/api/models?agent=codex&refresh=1`,
    );
    assert.equal(codexModelsRes.status, 200);
    assert.equal(codexModelsRes.data.ok, true);
    const codexCatalog = codexModelsRes.data.catalog;
    assert.equal(codexCatalog.modelControl, "config_option");
    assert.ok(codexCatalog.models.length >= 2, `Expected >=2 codex models, got ${codexCatalog.models.length}`);
    assert.ok(
      codexCatalog.effort && codexCatalog.effort.options.length >= 2,
      "Expected codex reasoning effort options",
    );
    console.log(
      `[phase5] 1b. Codex discovered ${codexCatalog.models.length} models (default=${codexCatalog.currentModelId}, effort=${codexCatalog.effort.configId}:${codexCatalog.effort.currentValue})`,
    );

    // 2. Pre-session cold-start model + effort selection on a new task group
    const createGroupRes = await httpJson<{ ok: boolean; group: TaskGroup }>(`${baseUrl}/api/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Phase5 Model Test", leadAgent: "kimi" }),
    });
    assert.equal(createGroupRes.status, 200);
    const groupId = createGroupRes.data.group.groupId;

    const preferredModel =
      kimiCatalog.models.find(
        (m) => m.id !== kimiCatalog.currentModelId && m.id.startsWith("kimi-code/"),
      ) ??
      kimiCatalog.models.find((m) => m.id !== kimiCatalog.currentModelId) ??
      kimiCatalog.models[0]!;
    const preferredEffort =
      kimiCatalog.effort.options.find((o) => o.id !== kimiCatalog.effort!.currentValue)?.id ??
      kimiCatalog.effort.options[0]!.id;

    const setGroupModelRes = await httpJson<{ ok: boolean; group: TaskGroup }>(
      `${baseUrl}/api/groups/model`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupId,
          agent: "kimi",
          model: preferredModel.id,
          effort: preferredEffort,
        }),
      },
    );
    assert.equal(setGroupModelRes.status, 200);
    assert.equal(setGroupModelRes.data.group.leadModel, preferredModel.id);
    assert.equal(setGroupModelRes.data.group.leadEffort, preferredEffort);
    console.log(
      `[phase5] 2a. Pre-session selection saved on ${groupId}: model=${preferredModel.id}, effort=${preferredEffort}`,
    );

    const chatRes = await httpJson<{ ok: boolean; sessionKey: string; outputText: string }>(
      `${baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupId,
          prompt: "Reply with exactly OK and do not call any tools.",
        }),
      },
    );
    assert.equal(chatRes.status, 200);
    assert.equal(chatRes.data.ok, true);

    const sessionAfterColdStart = hub.pool.getSession(chatRes.data.sessionKey);
    assert.ok(sessionAfterColdStart, "Expected live kimi session to exist after chat");
    assert.equal(
      sessionAfterColdStart.currentModelId,
      preferredModel.id,
      `Expected cold-start session model ${preferredModel.id}, got ${sessionAfterColdStart.currentModelId}`,
    );
    assert.equal(
      sessionAfterColdStart.currentEffort,
      preferredEffort,
      `Expected cold-start session effort ${preferredEffort}, got ${sessionAfterColdStart.currentEffort}`,
    );

    const telemetry = hub.getTelemetrySnapshot();
    const lastTurn = telemetry.recentTurns.find((t) => t.sessionKey === chatRes.data.sessionKey);
    assert.ok(lastTurn, "Expected telemetry turn record for cold-start session");
    assert.equal(
      lastTurn.usage.modelId,
      preferredModel.id,
      `Expected telemetry usage.modelId=${preferredModel.id}, got ${lastTurn.usage.modelId}`,
    );
    console.log(
      `[phase5] 2b. Cold-start applied model=${sessionAfterColdStart.currentModelId}, effort=${sessionAfterColdStart.currentEffort}, telemetry=${lastTurn.usage.modelId}`,
    );

    // 3. Live session dynamic model switch via POST /api/sessions/model
    const nextModel =
      kimiCatalog.models.find(
        (m) => m.id !== preferredModel.id && m.id.startsWith("kimi-code/"),
      ) ?? kimiCatalog.models.find((m) => m.id !== preferredModel.id);
    assert.ok(nextModel, "Expected a second model to switch to");

    const switchRes = await httpJson<{ ok: boolean; session: SessionRecord }>(
      `${baseUrl}/api/sessions/model`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionKey: chatRes.data.sessionKey,
          model: nextModel.id,
        }),
      },
    );
    assert.equal(switchRes.status, 200);
    assert.equal(switchRes.data.ok, true);
    assert.equal(
      switchRes.data.session.currentModelId,
      nextModel.id,
      `Expected live switched model ${nextModel.id}, got ${switchRes.data.session.currentModelId}`,
    );
    console.log(`[phase5] 3. Live session switched dynamically -> ${switchRes.data.session.currentModelId}`);

    // 4. Verify UI static assets contain model selector elements & handlers
    for (const [assetPath, needle] of [
      ["/", "modelSelect"],
      ["/", "effortSelect"],
      ["/ui/app.js", "refreshModelsBtn"],
      ["/ui/interactive.js", "agentCfgDefaultModel"],
      ["/ui/panels.css", ".composer-model-bar"],
    ] as const) {
      const resp = await fetch(`${baseUrl}${assetPath}`);
      assert.equal(resp.status, 200, `Expected 200 for ${assetPath}`);
      const text = await resp.text();
      assert.ok(text.includes(needle), `Expected ${assetPath} to include ${needle}`);
    }
    console.log("[phase5] 4. Verified UI model selector & config assets");
    console.log("[phase5] PASS: all model discovery, cold-start, live switch, and UI checks passed.");
  } finally {
    await hub.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[phase5] FAIL:", err);
    process.exit(1);
  });
