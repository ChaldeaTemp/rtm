import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AgentHubServer } from "../src/hub/server.js";
import { PROJECT_ROOT } from "../src/hub/process-tree.js";
import type { AgentResourceBudget, SharedResourceItem, TelemetrySnapshot, SessionRecord } from "../src/types.js";
import { dataDir } from "../src/hub/data-dir.js";

async function main(): Promise<void> {
  const agentHubDir = dataDir(PROJECT_ROOT);
  const hadAgentHubDir = fs.existsSync(agentHubDir);
  const hadResourcesDir = fs.existsSync(path.join(agentHubDir, "resources"));

  const hub = new AgentHubServer({
    baseCwd: PROJECT_ROOT,
    port: 0,
    defaultLead: "claude",
    permissionMode: "approve-all",
    writeRuntimeFile: false,
  });
  const url = await hub.start(0);
  console.log(`Verification Hub listening at ${url}`);

  let createdRuleId: string | undefined;

  try {
    console.log("\n=== 1. Shared Resource Discovery & Native Coverage Deduplication ===");
    const resListResp = await fetch(`${url}/api/resources`);
    assert.equal(resListResp.status, 200);
    const resListJson = (await resListResp.json()) as {
      ok: boolean;
      resources: SharedResourceItem[];
      budgets: AgentResourceBudget[];
    };
    assert.equal(resListJson.ok, true);

    const rules = resListJson.resources.filter((r) => r.kind === "rule");
    const skills = resListJson.resources.filter((r) => r.kind === "skill");
    console.log(`Discovered ${rules.length} deduplicated rules, ${skills.length} deduplicated skills`);
    assert.ok(rules.some((r) => r.origin === "codex-global"), "Expected codex global rule to be discovered");
    assert.ok(rules.some((r) => r.origin === "agy-plugin"), "Expected agy plugin rule to be discovered");
    assert.ok(skills.length > 20, `Expected >20 deduplicated skills, got ${skills.length}`);

    const compactInput = skills.find((s) => s.name === "compact-input");
    assert.ok(compactInput, "Expected compact-input skill to be discovered");
    assert.ok(compactInput.nativeAgents.includes("codex"), "compact-input should be native to codex");
    assert.ok(compactInput.nativeAgents.includes("agy"), "compact-input should be native to agy");
    assert.ok(compactInput.bridgedAgents.includes("claude"), "compact-input should be bridged to claude");
    console.log(
      "[compact-input coverage]",
      JSON.stringify({
        nativeAgents: compactInput.nativeAgents,
        bridgedAgents: compactInput.bridgedAgents,
        sourcesCount: compactInput.sources.length,
        indexTokens: compactInput.indexTokens,
        fullTokens: compactInput.fullTokens,
      }),
    );

    const skillContentResp = await fetch(`${url}/api/resources/content?skill=compact-input`);
    assert.equal(skillContentResp.status, 200);
    const skillContentJson = (await skillContentResp.json()) as { ok: boolean; content: string };
    assert.equal(skillContentJson.ok, true);
    assert.ok(skillContentJson.content.includes("compact-input"));

    console.log("\n=== 2. Create Temporary Hub Rule & Verify Runtime Injection into claude (reclaude) ===");
    const createRuleResp = await fetch(`${url}/api/resources/rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "verify-codename",
        scope: "project",
        content: "When asked for the Hub verification codename, reply with ORBIT-742 and nothing else.",
      }),
    });
    assert.equal(createRuleResp.status, 200);
    const createRuleJson = (await createRuleResp.json()) as { ok: boolean; item: SharedResourceItem };
    assert.equal(createRuleJson.ok, true);
    createdRuleId = createRuleJson.item.id;
    console.log(`Created temporary project rule: ${createRuleJson.item.primaryPath}`);

    const grpResp = await fetch(`${url}/api/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Phase 2-3 Verify Task", leadAgent: "claude" }),
    });
    const grpJson = (await grpResp.json()) as { ok: boolean; group: { groupId: string } };
    assert.equal(grpJson.ok, true);

    const chatResp = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: grpJson.group.groupId,
        prompt: "What is the Hub verification codename? Reply with the codename only. Do not call tools.",
      }),
    });
    assert.equal(chatResp.status, 200);
    const chatJson = (await chatResp.json()) as { ok: boolean; sessionKey: string; outputText: string };
    assert.equal(chatJson.ok, true);
    console.log(`[claude reply] ${chatJson.outputText.trim()}`);
    assert.ok(
      chatJson.outputText.includes("ORBIT-742"),
      `Expected injected rule codename ORBIT-742 in claude output, got: ${chatJson.outputText}`,
    );

    console.log("\n=== 3. Verify Telemetry Capture & Context Breakdown ===");
    const telResp = await fetch(`${url}/api/telemetry`);
    assert.equal(telResp.status, 200);
    const telJson = (await telResp.json()) as {
      ok: boolean;
      telemetry: TelemetrySnapshot;
      sessions: SessionRecord[];
    };
    assert.equal(telJson.ok, true);
    console.log("[Telemetry Totals]", JSON.stringify(telJson.telemetry.totals, null, 2));
    console.log("[Claude Agent Totals]", JSON.stringify(telJson.telemetry.byAgent.claude, null, 2));

    assert.ok(telJson.telemetry.totals.turns >= 1, "Expected >= 1 recorded turn");
    assert.ok(telJson.telemetry.totals.totalTokens > 0, "Expected totalTokens > 0");
    assert.ok(telJson.telemetry.byAgent.claude.totalTokens > 0, "Expected claude totalTokens > 0");

    const claudeSession = telJson.sessions.find((s) => s.sessionKey === chatJson.sessionKey);
    assert.ok(claudeSession?.contextBreakdown, "Expected contextBreakdown on claude session");
    console.log(
      "[Claude Session Context Breakdown]",
      JSON.stringify(
        {
          sharedRulesTokens: claudeSession.contextBreakdown.sharedRulesTokens,
          skillsIndexTokens: claudeSession.contextBreakdown.skillsIndexTokens,
          injectedRulesCount: claudeSession.contextBreakdown.injectedRules.length,
          injectedSkillsCount: claudeSession.contextBreakdown.injectedSkillsCount,
        },
        null,
        2,
      ),
    );
    assert.ok(claudeSession.contextBreakdown.sharedRulesTokens > 0, "Expected sharedRulesTokens > 0");
    assert.ok(claudeSession.contextBreakdown.skillsIndexTokens > 0, "Expected skillsIndexTokens > 0");

    console.log("\n=== 4. UI Assets & HTTP Endpoints ===");
    for (const assetPath of [
      "/",
      "/ui/styles.css",
      "/ui/panels.css",
      "/ui/app.js",
      "/ui/panels.js",
      "/api/resources",
      "/api/telemetry",
    ]) {
      const r = await fetch(`${url}${assetPath}`);
      assert.equal(r.status, 200, `Expected HTTP 200 on ${assetPath}`);
    }

    await hub.deleteGroup(grpJson.group.groupId);
    console.log("\nALL PHASE 2 & PHASE 3 VERIFICATIONS PASSED!");
  } finally {
    if (createdRuleId) {
      await fetch(`${url}/api/resources/rules/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: createdRuleId }),
      }).catch(() => {});
    }
    await hub.stop();
    if (!hadResourcesDir && fs.existsSync(path.join(agentHubDir, "resources"))) {
      fs.rmSync(path.join(agentHubDir, "resources"), { recursive: true, force: true });
    }
    if (!hadAgentHubDir && fs.existsSync(agentHubDir)) {
      fs.rmSync(agentHubDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error("PHASE 2-3 VERIFICATION FAILED:", err);
  process.exit(1);
});
