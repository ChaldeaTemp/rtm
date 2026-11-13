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
  console.log("=== 1. Adapter Health ===");
  const health = checkAdaptersHealth();
  console.log(JSON.stringify(health, null, 2));

  const hub = new AgentHubServer({
    baseCwd: PROJECT_ROOT,
    port: 0,
    defaultLead: "claude",
    permissionMode: "approve-all",
    writeRuntimeFile: false,
  });
  const url = await hub.start(0);
  console.log(`Hub listening at ${url}`);

  try {
    console.log("\n=== 2. Individual ACP Handshake & PONG Probes ===");
    const probeResults: Record<string, unknown> = {};
    for (const agent of ["claude", "codex", "agy"] as const) {
      const r = await testAdapterProbe(hub, agent);
      probeResults[agent] = r;
      console.log(`[probe ${agent}]`, JSON.stringify(r));
    }

    console.log("\n=== 3. Cross-Agent MCP (claude -> codex) & Lead Handoff ===");
    const claudeResult = await hub.runLeadChat({
      leadAgent: "claude",
      prompt:
        "Please call the peer_ask tool with agent='codex' and prompt='Calculate 37 * 43 and reply in one sentence with the number only.' Then report codex's exact answer to me.",
    });
    console.log("[claude lead result]", JSON.stringify(claudeResult, null, 2));
    assert.ok(
      claudeResult.peerToolsCalled.some((t) => t.includes("peer_ask")) ||
        claudeResult.outputText.includes("1591"),
      "Expected claude to call peer_ask or report 1591",
    );

    hub.setLeadAgent("codex");
    const codexHandoff = await hub.runLeadChat({
      leadAgent: "codex",
      prompt: "What multiplication did the previous turn ask about and what was the result?",
    });
    console.log("[codex handoff result]", JSON.stringify(codexHandoff, null, 2));
    assert.ok(
      codexHandoff.outputText.includes("1591"),
      "Expected codex handoff to recall 1591 from <handoff_context>",
    );

    console.log("\n=== 4. On-Demand git worktree Isolation ===");
    const wtTask = await hub.askPeer({
      targetAgent: "codex",
      session: "wt-test",
      prompt: "Reply with your current working directory name and nothing else. Do not edit files.",
      isolateWorktree: true,
      callerAgent: "user",
      callerSession: "verify",
      depth: 0,
    });
    console.log("[worktree task]", JSON.stringify({
      taskId: wtTask.taskId,
      worktreePath: wtTask.worktreePath,
      branch: wtTask.branch,
      outputText: wtTask.outputText.trim(),
    }, null, 2));

    const expectedWtPath = path.join(PROJECT_ROOT, ".agent-hub-worktrees", "wt-test");
    assert.equal(wtTask.worktreePath, expectedWtPath);
    assert.equal(wtTask.branch, "agent-hub/wt-test");
    assert.ok(fs.existsSync(expectedWtPath), "Expected worktree directory to exist");

    const gitStatus = execFileSync("git", ["-C", PROJECT_ROOT, "status", "--short"], {
      encoding: "utf8",
    });
    assert.ok(
      !gitStatus.includes(".agent-hub-worktrees"),
      "Main working tree git status should ignore .agent-hub-worktrees",
    );

    await hub.pool.closeSession("codex:wt-test");
    removeSessionWorktree(PROJECT_ROOT, expectedWtPath);
    console.log("Worktree cleaned up successfully.");

    console.log("\n=== SUMMARY ===");
    console.log(JSON.stringify({ probeResults }, null, 2));
  } finally {
    await hub.stop();
  }
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
