import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AgentHubServer } from "../src/hub/server.js";
import { PROJECT_ROOT, checkAdaptersHealth } from "../src/hub/process-tree.js";
import { removeSessionWorktree } from "../src/hub/worktree.js";
import type { AgentId } from "../src/types.js";

async function testAdapterProbe(
  hub: AgentHubServer,
  agent: AgentId,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  try {
    const res = await hub.pool.runTurn({
      agent,
      sessionName: `probe-${agent}`,
      baseCwd: PROJECT_ROOT,
      prompt: "Reply with exactly PONG and nothing else. Do not call any tools.",
      isolateWorktree: false,
      injectPeerMcp: false,
    });
    return { ok: /PONG/i.test(res.outputText), output: res.outputText.trim() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await hub.pool.closeSession(`${agent}:probe-${agent}`);
  }
}

async function main(): Promise<void> {
  console.log("=== 1. Adapter Health & Auth Readiness ===");
  const health = checkAdaptersHealth();
  console.log(JSON.stringify(health, null, 2));
  for (const item of health) {
    assert.equal(item.available, true, `Expected adapter ${item.agent} entrypoint to be available`);
  }
  const readyAgents = health.filter((h) => h.available && h.authReady).map((h) => h.agent);
  assert.ok(readyAgents.length >= 2, "Expected claude and codex to be auth-ready");
  const primaryAgent = readyAgents[0]!;

  const hub = new AgentHubServer({
    baseCwd: PROJECT_ROOT,
    port: 0,
    defaultLead: primaryAgent,
    permissionMode: "approve-all",
    writeRuntimeFile: false,
  });
  const url = await hub.start(0);
  console.log(`Hub listening at ${url}`);

  try {
    console.log("\n=== 2. Individual ACP Handshake & PONG Probes ===");
    const probeResults: Record<string, { ok: boolean; output?: string; error?: string }> = {};
    for (const item of health) {
      const r = await testAdapterProbe(hub, item.agent);
      probeResults[item.agent] = r;
      console.log(`[probe ${item.agent}]`, JSON.stringify(r));
      if (item.authReady) {
        assert.equal(r.ok, true, `Expected auth-ready agent ${item.agent} to return PONG`);
      } else {
        assert.equal(r.ok, false);
        assert.ok(r.error && r.error.length > 0, `Expected clear error for unauthenticated ${item.agent}`);
      }
    }
    assert.equal(probeResults.claude?.ok, true, "Expected claude (reclaude) live probe to succeed");
    assert.equal(probeResults.codex?.ok, true, "Expected codex live probe to succeed");

    console.log("\n=== 3. Parallel Task Groups, Sub-Sessions & Isolated Lead Handoff ===");
    const groupA = hub.createGroup({ title: "Task Alpha", leadAgent: "claude" });
    const groupB = hub.createGroup({ title: "Task Beta", leadAgent: "codex" });

    const [resA, resB] = await Promise.all([
      hub.runLeadChat({
        groupId: groupA.groupId,
        prompt:
          'You MUST call the peer_ask MCP tool right now with agent="codex", session="worker-calc", and prompt="Calculate 37 * 43 and reply with only 1591. Do not call any tools.". After peer_ask returns, report the exact answer 1591 back to me.',
      }),
      hub.runLeadChat({
        groupId: groupB.groupId,
        prompt: "Reply with BETA-OK only. Do not call any tools.",
      }),
    ]);

    console.log("[Parallel Task Alpha result]", JSON.stringify(resA, null, 2));
    console.log("[Parallel Task Beta result]", JSON.stringify(resB, null, 2));

    assert.ok(
      resA.peerToolsCalled.some((t) => t.includes("peer_ask")),
      `Expected peer_ask in resA.peerToolsCalled, got ${JSON.stringify(resA.peerToolsCalled)}`,
    );
    assert.ok(resA.outputText.includes("1591"), `Expected 1591 in Task Alpha output: ${resA.outputText}`);
    assert.ok(resB.outputText.includes("BETA-OK"), `Expected BETA-OK in Task Beta output: ${resB.outputText}`);

    const subSessionKey = `codex:${groupA.groupId}__sub__worker-calc`;
    const subSession = hub.pool.getSession(subSessionKey);
    assert.ok(subSession, `Expected sub-session ${subSessionKey} to exist`);
    assert.equal(subSession.groupId, groupA.groupId);
    assert.equal(subSession.role, "sub");
    assert.equal(subSession.label, "worker-calc");

    const subMessages = hub.getMessages({ streamKey: `sub:${subSessionKey}` });
    console.log(`[Sub-session messages count=${subMessages.length}]`);
    assert.ok(subMessages.length >= 2, `Expected >= 2 transcript messages for ${subSessionKey}`);
    assert.ok(
      subMessages.some((m) => m.role === "assistant" && m.text.includes("1591")),
      "Expected sub-session assistant transcript to contain 1591",
    );

    hub.setGroupLeadAgent(groupA.groupId, "codex");
    const handoffPrompt = hub
      .getGroupLedger(groupA.groupId)
      .buildLeadPrompt(
        "codex",
        "Based on the handoff context, what exact 4-digit multiplication result did claude verify? Reply with the number only.",
      );
    console.log("[Task Alpha isolated handoff preview]\n" + handoffPrompt);
    assert.ok(handoffPrompt.includes("<handoff_context>"), "Expected <handoff_context>");
    assert.ok(handoffPrompt.includes("1591"), "Expected 1591 in Task Alpha handoff");
    assert.ok(!handoffPrompt.includes("BETA-OK"), "Task Beta must NOT leak into Task Alpha handoff");

    const followUp = await hub.runLeadChat({
      groupId: groupA.groupId,
      prompt:
        "Based on the handoff context, what exact 4-digit multiplication result did claude verify? Reply with the number only.",
    });
    console.log("[Task Alpha followUp result]", JSON.stringify(followUp, null, 2));
    assert.ok(followUp.outputText.includes("1591"), "Expected followUp on Task Alpha to recall 1591");

    await hub.deleteGroup(groupA.groupId);
    await hub.deleteGroup(groupB.groupId);

    console.log("\n=== 4. On-Demand git worktree Isolation ===");
    const wtTask = await hub.askPeer({
      targetAgent: primaryAgent,
      session: "wt-test",
      prompt: "Reply with the basename of your current working directory and nothing else. Do not edit files.",
      isolateWorktree: true,
      callerAgent: "user",
      callerSession: "verify",
      depth: 0,
    });
    console.log(
      "[worktree task]",
      JSON.stringify(
        {
          taskId: wtTask.taskId,
          worktreePath: wtTask.worktreePath,
          branch: wtTask.branch,
          outputText: wtTask.outputText.trim(),
        },
        null,
        2,
      ),
    );

    const expectedWtPath = path.join(PROJECT_ROOT, ".agent-hub-worktrees", "wt-test");
    assert.equal(
      wtTask.worktreePath?.toLowerCase(),
      expectedWtPath.toLowerCase(),
      `Expected worktreePath ${wtTask.worktreePath} to match ${expectedWtPath}`,
    );
    assert.equal(wtTask.branch, "agent-hub/wt-test");
    assert.ok(fs.existsSync(expectedWtPath), "Expected worktree directory to exist");

    const gitStatus = execFileSync("git", ["-C", PROJECT_ROOT, "status", "--short"], {
      encoding: "utf8",
    });
    assert.ok(
      !gitStatus.includes(".agent-hub-worktrees"),
      "Main working tree git status should ignore .agent-hub-worktrees",
    );

    await hub.pool.closeSession(`${primaryAgent}:${wtTask.groupId}__sub__wt-test`).catch(() => false);
    await hub.pool.closeSession(`${primaryAgent}:wt-test`).catch(() => false);
    await new Promise((r) => setTimeout(r, 300));
    removeSessionWorktree(PROJECT_ROOT, expectedWtPath);
    execFileSync("git", ["-C", PROJECT_ROOT, "branch", "-D", "agent-hub/wt-test"], {
      stdio: "ignore",
    });
    console.log("Worktree and temporary branch cleaned up successfully.");

    console.log("\n=== 5. Alma UI Static Assets & Group APIs ===");
    for (const assetPath of ["/", "/ui/styles.css", "/ui/app.js", "/api/groups"]) {
      const r = await fetch(`${url}${assetPath}`);
      assert.equal(r.status, 200, `Expected GET ${assetPath} to return 200, got ${r.status}`);
    }
    console.log("All UI assets & group API endpoints returned HTTP 200.");

    console.log("\n=== VERIFY PHASE 1 PASSED ===");
  } finally {
    await hub.stop();
  }
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
