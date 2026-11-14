// A minimal ACP agent for regression scripts: no model, no network, answers by simple rules.
// Register it as a custom agent (command: node, args: [this file]) and tests run in seconds
// without starting real agent CLIs.
//
// Rules, checked in order against the prompt text:
//   - acceptance review prompt  -> if prompt contains CHECK_FILE:<relpath>, checks that the file exists
//                                  in process.cwd() and <workspace_changes> appears in the prompt;
//                                  otherwise "VERDICT: FAIL" for the first MOCK_REVIEW_FAILS reviews
//                                  (counted in MOCK_STATE_DIR), then "VERDICT: PASS";
//                                  a file MOCK_STATE_DIR/review-fails overrides the number
//   - WRITE_FILE:<rel>:<val>    -> writes file relative to process.cwd() (delayed until <gate_failure
//                                  if DELAY_WRITE_UNTIL_GATE_RETRY is present; skipped in reviewer)
//   - contains "CODEWORD?"      -> the first OSPREY-<n> found in the prompt, else "unknown"
//   - contains "SLOW"           -> answers after MOCK_SLOW_MS (default 1500 ms)
//   - contains "FAILME"         -> "STATUS: FAILED - no access", unless the prompt carries
//                                  <lead_guidance>, then "STATUS: DONE"
//   - contains <workbench_update> -> logged to MOCK_STATE_DIR/updates.log, answered "ack"
//   - anything else             -> "ok: <start of the prompt>"
//   - workflow/rework/gate prompt -> appends "\nSTATUS: DONE" unless OMIT_STATUS or reply already has STATUS:
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const stateDir = process.env.MOCK_STATE_DIR || process.cwd();
const reviewFails = Number(process.env.MOCK_REVIEW_FAILS || 0);
const slowMs = Number(process.env.MOCK_SLOW_MS || 1500);

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function bump(name) {
  const file = path.join(stateDir, `${name}.count`);
  let count = 0;
  try {
    count = Number(fs.readFileSync(file, "utf8").trim()) || 0;
  } catch {
    count = 0;
  }
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, String(count + 1), "utf8");
  return count + 1;
}

function currentReviewFails() {
  try {
    return Number(fs.readFileSync(path.join(stateDir, "review-fails"), "utf8").trim()) || 0;
  } catch {
    return reviewFails;
  }
}

function appendLog(filename, entry) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(path.join(stateDir, filename), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Best effort.
  }
}

function buildConfigOptions(sess) {
  const models = [
    { value: "mock-default", name: "Mock Default" },
    { value: "mock-fast", name: "Mock Fast" },
    { value: "mock-smart", name: "Mock Smart" },
  ];
  if (sess.model && !models.some((m) => m.value === sess.model)) {
    models.push({ value: sess.model, name: sess.model });
  }
  return [
    {
      id: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: sess.model,
      options: models,
    },
    {
      id: "reasoning_effort",
      category: "thought_level",
      name: "Thinking Effort",
      type: "select",
      currentValue: sess.effort,
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra High" },
        { value: "max", name: "Max" },
      ],
    },
  ];
}

function applyWriteDirectives(writes) {
  for (const { rel, content } of writes) {
    const target = path.resolve(process.cwd(), rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
}

function answer(text, sess) {
  if (text.includes("acceptance reviewer")) {
    const checkMatch = /CHECK_FILE:([^\s<]+)/.exec(text);
    if (checkMatch) {
      const rel = checkMatch[1];
      const exists = fs.existsSync(path.resolve(process.cwd(), rel));
      const hasWorkspaceChanges = text.includes("<workspace_changes>");
      if (exists && hasWorkspaceChanges) {
        return `Verified ${rel} in ${process.cwd()} with workspace changes.\nVERDICT: PASS`;
      }
      return `Problem: CHECK_FILE ${rel} failed (exists=${exists}, hasWorkspaceChanges=${hasWorkspaceChanges}).\nVERDICT: FAIL`;
    }
    const n = bump("review");
    return n <= currentReviewFails() ? `Problem: attempt ${n} is incomplete.\nVERDICT: FAIL` : "Looks right.\nVERDICT: PASS";
  }

  const isGateRetry = text.includes("<gate_failure");
  const hasStickyOmit = /\bOMIT_STATUS\b/.test(text);
  const hasOnceOmit = !isGateRetry && /\bOMIT_STATUS_ONCE\b/.test(text);
  const omitStatus = hasStickyOmit || hasOnceOmit || (isGateRetry && Boolean(sess?.omitStatus));
  if (sess) {
    if (hasStickyOmit) {
      sess.omitStatus = true;
    } else if (!isGateRetry) {
      sess.omitStatus = false;
    }
  }

  const writes = [...text.matchAll(/WRITE_FILE:([^:\s<]+):([^\s<]+)/g)].map((m) => ({
    rel: m[1],
    content: m[2],
  }));
  if (text.includes("DELAY_WRITE_UNTIL_GATE_RETRY")) {
    if (sess && writes.length > 0) {
      sess.delayedWrites = writes;
    }
  } else if (isGateRetry && sess?.delayedWrites?.length) {
    applyWriteDirectives(sess.delayedWrites);
    sess.delayedWrites = [];
  } else if (writes.length > 0) {
    applyWriteDirectives(writes);
  }

  let reply;
  if (text.includes("did not accept your work")) {
    reply = `reworked (${bump("rework")})`;
  } else if (text.includes("<workbench_update>")) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.appendFileSync(path.join(stateDir, "updates.log"), `${JSON.stringify({ text })}\n`, "utf8");
    } catch {
      // Best effort.
    }
    reply = "ack: handled the update";
  } else if (text.includes("FAILME")) {
    reply = text.includes("<lead_guidance>") ? "Did it the other way.\nSTATUS: DONE" : "Could not reach the service.\nSTATUS: FAILED - no access";
  } else if (text.includes("CODEWORD?")) {
    reply = /OSPREY-\d+/.exec(text)?.[0] ?? "unknown";
  } else {
    reply = `ok: ${text.replace(/\s+/g, " ").trim().slice(-60)}`;
  }

  const needsStatus =
    text.includes("End your reply with exactly one status line:") ||
    text.includes("did not accept your work") ||
    isGateRetry;
  if (needsStatus && !omitStatus && !/^\s*\**\s*STATUS:\s*\**\s*(DONE|BLOCKED|FAILED)\b/im.test(reply)) {
    reply = `${reply}\nSTATUS: DONE`;
  }
  return reply;
}

let sessionSeq = 0;
const sessions = new Map();
/** The slow prompt in flight, so a session/cancel can end it the way a real agent would. */
let pendingSlow;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } });
  } else if (msg.method === "session/new") {
    const sessionId = `mock-${process.pid}-${++sessionSeq}`;
    const sess = { model: "mock-default", effort: "medium", omitStatus: false, delayedWrites: [] };
    sessions.set(sessionId, sess);
    // Lets a test see which MCP servers, cwd, and defaults the hub passed to this session.
    appendLog("session-new.log", {
      mcp: (msg.params?.mcpServers ?? []).map((s) => s.name),
      cwd: process.cwd(),
      sessionId,
      model: sess.model,
      effort: sess.effort,
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId, configOptions: buildConfigOptions(sess) } });
  } else if (msg.method === "session/set_config_option") {
    const sessionId = msg.params?.sessionId;
    const sess = sessions.get(sessionId);
    if (sess) {
      const configId = String(msg.params?.configId ?? "");
      const value = String(msg.params?.value ?? "");
      if (configId === "model" && value) sess.model = value;
      if ((configId === "reasoning_effort" || configId === "effort" || configId === "thought_level") && value) {
        sess.effort = value;
      }
      appendLog("session-turns.log", {
        event: "set_config_option",
        sessionId,
        cwd: process.cwd(),
        model: sess.model,
        effort: sess.effort,
        configId,
        value,
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: buildConfigOptions(sess) } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  } else if (msg.method === "session/set_model") {
    const sessionId = msg.params?.sessionId;
    const sess = sessions.get(sessionId);
    if (sess && typeof msg.params?.modelId === "string" && msg.params.modelId) {
      sess.model = msg.params.modelId;
      appendLog("session-turns.log", {
        event: "set_model",
        sessionId,
        cwd: process.cwd(),
        model: sess.model,
        effort: sess.effort,
      });
    }
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    const sessionId = msg.params?.sessionId;
    const sess = sessions.get(sessionId);
    const blocks = Array.isArray(msg.params?.prompt) ? msg.params.prompt : [];
    const text = blocks.map((b) => (b?.type === "text" ? String(b.text ?? "") : "")).join("\n");
    appendLog("session-turns.log", {
      event: "prompt",
      sessionId,
      cwd: process.cwd(),
      model: sess?.model,
      effort: sess?.effort,
      preview: text.replace(/\s+/g, " ").trim(),
    });
    const reply = () => {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer(text, sess) } } },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    };
    if (text.includes("SLOW")) {
      pendingSlow = { id: msg.id, timer: setTimeout(() => { pendingSlow = undefined; reply(); }, text.includes("VERYSLOW") ? 20000 : slowMs) };
    } else reply();
  } else if (msg.method === "session/cancel") {
    if (pendingSlow) {
      clearTimeout(pendingSlow.timer);
      send({ jsonrpc: "2.0", id: pendingSlow.id, result: { stopReason: "cancelled" } });
      pendingSlow = undefined;
    }
  } else if (msg.id !== undefined && msg.method) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
