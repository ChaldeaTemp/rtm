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
  assert.ok(readyAgents.length >= 1, "Expected at least one auth-ready agent for live verification");
  const primaryAgent = readyAgents[0]!;
  console.log(`Primary ready agent for live checks: ${primaryAgent}`);

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

    console.log("\n=== 3. Cross-Session MCP (peer_ask) & Lead Handoff ===");
    const leadAgent: AgentId = readyAgents.includes("claude") ? "claude" : primaryAgent;
    const peerAgent: AgentId = readyAgents.includes("codex") && leadAgent !== "codex" ? "codex" : primaryAgent;
    hub.setLeadAgent(leadAgent);
    const leadResult = await hub.runLeadChat({
      leadAgent,
      prompt:
        `You MUST call the peer_ask MCP tool right now with agent="${peerAgent}", session="worker-calc", and prompt="Calculate 37 * 43 and reply with only 1591. Do not call any tools.". After peer_ask returns, report the exact answer 1591 back to me.`,
    });
    console.log("[lead result]", JSON.stringify(leadResult, null, 2));
    assert.ok(
      leadResult.peerToolsCalled.some((t) => t.includes("peer_ask")),
      `Expected peer_ask tool call in peerToolsCalled, got: ${JSON.stringify(leadResult.peerToolsCalled)}`,
    );
    assert.ok(
      leadResult.outputText.includes("1591"),
      `Expected lead output to contain 1591, got: ${leadResult.outputText}`,
    );

    const nextLead: AgentId = leadAgent !== peerAgent ? peerAgent : (leadAgent === "claude" ? "codex" : "claude");
    hub.setLeadAgent(nextLead);
    const handoffPrompt = hub.ledger.buildLeadPrompt(
      nextLead,
      "Based on the handoff context, what exact multiplication result (4 digits) did we just verify via peer_ask? Reply with the number only.",
    );
    console.log("[handoff prompt preview]\n" + handoffPrompt);
    assert.ok(handoffPrompt.includes("<handoff_context>"), "Expected <handoff_context> block");
    assert.ok(handoffPrompt.includes("1591"), "Expected handoff context to contain 1591");
    assert.ok(handoffPrompt.includes("peer_ask"), "Expected handoff context to record peer_ask");

    const followUp = await hub.runLeadChat({
      leadAgent: nextLead,
      prompt: "Based on the handoff context, what exact multiplication result (4 digits) did we just verify via peer_ask? Reply with the number only.",
    });
    console.log("[followUp result]", JSON.stringify(followUp, null, 2));
    assert.ok(
      followUp.outputText.includes("1591") || followUp.outputText.includes("37"),
      "Expected follow-up to preserve multi-turn handoff context",
    );

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

    await hub.pool.closeSession(`${primaryAgent}:wt-test`);
    await new Promise((r) => setTimeout(r, 300));
    removeSessionWorktree(PROJECT_ROOT, expectedWtPath);
    execFileSync("git", ["-C", PROJECT_ROOT, "branch", "-D", "agent-hub/wt-test"], {
      stdio: "ignore",
    });
    console.log("Worktree and temporary branch cleaned up successfully.");

    console.log("\n=== VERIFY PHASE 1 PASSED ===");
  } finally {
    await hub.stop();
  }
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
