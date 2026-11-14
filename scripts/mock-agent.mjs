// A minimal ACP agent for regression scripts: no model, no network, answers by simple rules.
// Register it as a custom agent (command: node, args: [this file]) and tests run in seconds
// without starting real agent CLIs.
//
// Rules, checked in order against the prompt text:
//   - acceptance review prompt  -> "VERDICT: FAIL" for the first MOCK_REVIEW_FAILS reviews
//                                  (counted in MOCK_STATE_DIR), then "VERDICT: PASS";
//                                  a file MOCK_STATE_DIR/review-fails overrides the number
//   - contains "CODEWORD?"      -> the first OSPREY-<n> found in the prompt, else "unknown"
//   - contains "SLOW"           -> answers after MOCK_SLOW_MS (default 1500 ms)
//   - anything else             -> "ok: <start of the prompt>"
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

function answer(text) {
  if (text.includes("acceptance reviewer")) {
    const n = bump("review");
    return n <= currentReviewFails() ? `Problem: attempt ${n} is incomplete.\nVERDICT: FAIL` : "Looks right.\nVERDICT: PASS";
  }
  if (text.includes("did not accept your work")) {
    return `reworked (${bump("rework")})`;
  }
  if (text.includes("CODEWORD?")) {
    return /OSPREY-\d+/.exec(text)?.[0] ?? "unknown";
  }
  return `ok: ${text.replace(/\s+/g, " ").trim().slice(-60)}`;
}

let sessionSeq = 0;
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
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: `mock-${process.pid}-${++sessionSeq}` } });
  } else if (msg.method === "session/prompt") {
    const sessionId = msg.params?.sessionId;
    const blocks = Array.isArray(msg.params?.prompt) ? msg.params.prompt : [];
    const text = blocks.map((b) => (b?.type === "text" ? String(b.text ?? "") : "")).join("\n");
    const reply = () => {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer(text) } } },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    };
    if (text.includes("SLOW")) setTimeout(reply, slowMs);
    else reply();
  } else if (msg.id !== undefined && msg.method) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
