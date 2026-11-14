import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { extractModelCatalogFromConfigOptions } from "../src/hub/model-catalog.js";
import {
  PROJECT_ROOT,
  resolveAdapterCommand,
  resolvePeerMcpLaunch,
} from "../src/hub/process-tree.js";
import { buildHubWorkbenchGuide, SharedResourceManager } from "../src/hub/resources.js";
import { AgentHubServer } from "../src/hub/server.js";

// Valid 1x1 transparent PNG (67 bytes)
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const MOCK_ACP_SCRIPT_SOURCE = `
import readline from "node:readline";

const imageCapable = process.argv.includes("--image-capable");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let nextReqId = 1000;
const pendingClientRequests = new Map();
let sawElicitationCap = false;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

function sendRequest(method, params) {
  const id = nextReqId++;
  return new Promise((resolve, reject) => {
    pendingClientRequests.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (msg.id !== undefined && msg.method === undefined) {
    const waiter = pendingClientRequests.get(msg.id);
    if (waiter) {
      pendingClientRequests.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message || "RPC error"));
      else waiter.resolve(msg.result);
    }
    return;
  }

  if (msg.method === "initialize") {
    sawElicitationCap = Boolean(msg.params?.clientCapabilities?.elicitation?.form);
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? 1,
        agentInfo: { name: "mock-phase8-agent", version: "1.0.0" },
        agentCapabilities: {
          promptCapabilities: { image: imageCapable, embeddedContext: true },
        },
      },
    });
    return;
  }

  if (msg.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "mock-sess-1",
      },
    });
    return;
  }

  if (msg.method === "session/prompt") {
    const sessionId = msg.params?.sessionId || "mock-sess-1";
    const blocks = Array.isArray(msg.params?.prompt) ? msg.params.prompt : [];
    const textJoined = blocks
      .filter((b) => b && b.type === "text")
      .map((b) => b.text || "")
      .join("\\n");
    const imgBlock = blocks.find((b) => b && b.type === "image");
    const hasWorkbenchGuide = textJoined.includes("<agent_hub_workbench>");
    const hasFallbackPathBlock = textJoined.includes("<attached_images>");

    let styleAnswer = "none";
    if (imageCapable) {
      const elicitResp = await sendRequest("elicitation/create", {
        mode: "form",
        sessionId,
        message: "请选择输出风格",
        requestedSchema: {
          type: "object",
          title: "回答风格确认",
          properties: {
            style: {
              type: "string",
              description: "回答风格",
              enum: ["简洁", "详细"],
            },
          },
          required: ["style"],
        },
      });
      styleAnswer = String(elicitResp?.content?.style || elicitResp?.action || "none");
    }

    const imgBytes = imgBlock ? Buffer.from(imgBlock.data || "", "base64").byteLength : 0;
    const replyText = [
      "MOCK_RESULT",
      "ELICIT_CAP=" + sawElicitationCap,
      "GUIDE=" + hasWorkbenchGuide,
      "IMG_BLOCK=" + Boolean(imgBlock),
      "IMG_BYTES=" + imgBytes,
      "FALLBACK_PATH=" + hasFallbackPathBlock,
      "STYLE=" + styleAnswer,
    ].join(" ");

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: replyText },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { stopReason: "end_turn" },
    });
    return;
  }

  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
`;

async function waitFor<T>(
  fn: () => T | Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const val = await fn();
    if (predicate(val)) return val;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  console.log("=== 1. Verify OpenCode Question Safeguard, Fast MCP Launch, Effort Fallback & Slim Injection ===");
  const opencodeCmd = resolveAdapterCommand("opencode");
  const openCodeCfgRaw = opencodeCmd.env?.OPENCODE_CONFIG_CONTENT;
  assert.ok(openCodeCfgRaw, "opencode adapter must include OPENCODE_CONFIG_CONTENT");
  const openCodeCfg = JSON.parse(openCodeCfgRaw) as {
    tools?: { question?: boolean };
    permission?: { question?: string };
  };
  assert.equal(openCodeCfg.tools?.question, false);
  assert.equal(openCodeCfg.permission?.question, "deny");

  const mcpLaunch = resolvePeerMcpLaunch({
    hubUrl: "http://127.0.0.1:4317",
    callerAgent: "codex",
    callerSession: "codex:grp-default__lead",
    depth: 0,
    groupId: "grp-default",
  });
  assert.equal(
    mcpLaunch.args[0],
    path.join(PROJECT_ROOT, "dist", "mcp", "peer-mcp-server.js"),
    "Freshly compiled dist/mcp/peer-mcp-server.js should be used directly without tsx wrapper",
  );

  const catalog = extractModelCatalogFromConfigOptions("opencode", [
    {
      id: "effort",
      category: "thought_level",
      currentValue: "",
      options: [
        { value: "max", name: "Max" },
        { value: "high", name: "High" },
        { value: "default", name: "Default" },
      ],
    },
  ]);
  assert.equal(catalog.effort?.currentValue, "default", "Empty currentValue should prefer default over max");

  const guide = buildHubWorkbenchGuide("lead");
  assert.ok(guide.includes("hub_ask_user"));
  assert.ok(guide.includes("ui_render_artifact"));
  assert.ok(guide.includes("NEVER call CLI-native TUI `question`"));

  const rm = new SharedResourceManager(PROJECT_ROOT);
  const opencodeInj = rm.buildInjectionForAgent("opencode", PROJECT_ROOT);
  assert.ok(opencodeInj.skillsIndexTokens <= 1350, `Expected slim skills index, got ${opencodeInj.skillsIndexTokens}`);

  console.log("=== 2. Verify Native ImageContent + ACP elicitation/create Bridge + Fallback Image Path ===");
  const mockDir = path.join(PROJECT_ROOT, ".agent-hub");
  fs.mkdirSync(mockDir, { recursive: true });
  const mockScriptPath = path.join(mockDir, "tmp-phase8-mock-agent.mjs");
  fs.writeFileSync(mockScriptPath, MOCK_ACP_SCRIPT_SOURCE.trimStart(), "utf8");

  const createdUploadFiles: string[] = [];
  const agentsConfigPath = path.join(mockDir, "agents.json");
  const hadAgentsConfig = fs.existsSync(agentsConfigPath);
  const prevAgentsConfig = hadAgentsConfig ? fs.readFileSync(agentsConfigPath, "utf8") : "";

  const hub = new AgentHubServer({
    baseCwd: PROJECT_ROOT,
    port: 0,
    defaultLead: "claude",
    permissionMode: "approve-all",
    writeRuntimeFile: false,
  });
  const url = await hub.start(0);
  let ws: WebSocket | undefined;

  try {
    ws = new WebSocket(url.replace(/^http/, "ws") + "/ws");
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", () => resolve());
      ws!.once("error", (err) => reject(err));
    });

    const requestedQuestions: Array<{ questionId: string; title: string }> = [];
    ws.on("message", (raw) => {
      try {
        const evt = JSON.parse(String(raw)) as {
          type?: string;
          question?: { questionId: string; title: string };
        };
        if (evt.type === "question_requested" && evt.question) {
          requestedQuestions.push({
            questionId: evt.question.questionId,
            title: evt.question.title,
          });
          void fetch(`${url}/api/questions/resolve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              questionId: evt.question.questionId,
              answers: { style: "简洁" },
            }),
          });
        }
      } catch {
        // ignore non-JSON frames
      }
    });

    // Save two custom agents pointing to our mock ACP stdio agent (native image + path fallback)
    for (const cfg of [
      { id: "mock-vision", label: "MockVision", args: [mockScriptPath, "--image-capable"] },
      { id: "mock-textonly", label: "MockText", args: [mockScriptPath] },
    ]) {
      const saveResp = await fetch(`${url}/api/agents/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: cfg.id,
          label: cfg.label,
          command: process.execPath,
          args: cfg.args,
          enabled: true,
        }),
      });
      assert.equal(saveResp.status, 200);
    }

    // 2a. Image-only prompt (empty text + 1 PNG) with native promptCapabilities.image = true + elicitation/create
    const grpResp = await fetch(`${url}/api/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Phase 8 Vision Test", leadAgent: "mock-vision" }),
    });
    const grpJson = (await grpResp.json()) as { ok: boolean; group: { groupId: string } };
    assert.equal(grpJson.ok, true);

    const chatResp = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: grpJson.group.groupId,
        prompt: "",
        images: [
          {
            name: "dot.png",
            mimeType: "image/png",
            data: `data:image/png;base64,${TINY_PNG_BASE64}`,
          },
        ],
      }),
    });
    assert.equal(chatResp.status, 200);
    const chatJson = (await chatResp.json()) as { ok: boolean; outputText: string };
    assert.equal(chatJson.ok, true);
    assert.ok(chatJson.outputText.includes("ELICIT_CAP=true"), chatJson.outputText);
    assert.ok(chatJson.outputText.includes("GUIDE=true"), chatJson.outputText);
    assert.ok(chatJson.outputText.includes("IMG_BLOCK=true"), chatJson.outputText);
    const expectedPngBytes = Buffer.from(TINY_PNG_BASE64, "base64").byteLength;
    assert.ok(chatJson.outputText.includes(`IMG_BYTES=${expectedPngBytes}`), chatJson.outputText);
    assert.ok(chatJson.outputText.includes("STYLE=简洁"), chatJson.outputText);

    await waitFor(
      () => requestedQuestions.length,
      (len) => len >= 1,
      4000,
    );
    assert.equal(requestedQuestions[0]!.title, "回答风格确认");

    // Verify stored upload URL, GET /uploads/*, and Markdown export
    const exportResp = await fetch(
      `${url}/api/groups/export?groupId=${encodeURIComponent(grpJson.group.groupId)}&format=json`,
    );
    assert.equal(exportResp.status, 200);
    const exportJson = (await exportResp.json()) as { ok: boolean; markdown: string };
    assert.equal(exportJson.ok, true);
    assert.ok(exportJson.markdown.includes("**附带图片**"), exportJson.markdown);
    assert.ok(exportJson.markdown.includes("dot.png"), exportJson.markdown);

    const group1Messages = hub.getMessages({ groupId: grpJson.group.groupId });
    const userMsg = group1Messages.find((m) => m.role === "user");
    assert.ok(userMsg?.images?.length === 1, "Expected image attachment on user message");
    const imgUrl = userMsg!.images![0]!.url;
    assert.match(imgUrl, /^\/uploads\/img-[a-z0-9_-]+\.png$/i);
    createdUploadFiles.push(path.join(PROJECT_ROOT, ".agent-hub", imgUrl));

    const imgGet = await fetch(`${url}${imgUrl}`);
    assert.equal(imgGet.status, 200);
    assert.equal(imgGet.headers.get("content-type"), "image/png");
    const downloadedBuf = Buffer.from(await imgGet.arrayBuffer());
    assert.equal(downloadedBuf.byteLength, expectedPngBytes);

    // 2b. Fallback local image path injection when promptCapabilities.image = false
    const grp2Resp = await fetch(`${url}/api/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Phase 8 Fallback Test", leadAgent: "mock-textonly" }),
    });
    const grp2Json = (await grp2Resp.json()) as { group: { groupId: string } };
    const chat2Resp = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: grp2Json.group.groupId,
        prompt: "看这张图",
        images: [{ name: "fallback.png", mimeType: "image/png", data: TINY_PNG_BASE64 }],
      }),
    });
    assert.equal(chat2Resp.status, 200);
    const chat2Json = (await chat2Resp.json()) as { ok: boolean; outputText: string };
    assert.equal(chat2Json.ok, true);
    assert.ok(chat2Json.outputText.includes("IMG_BLOCK=false"), chat2Json.outputText);
    assert.ok(chat2Json.outputText.includes("FALLBACK_PATH=true"), chat2Json.outputText);

    const group2Messages = hub.getMessages({ groupId: grp2Json.group.groupId });
    const userMsg2 = group2Messages.find((m) => m.role === "user");
    if (userMsg2?.images?.[0]?.url) {
      createdUploadFiles.push(path.join(PROJECT_ROOT, ".agent-hub", userMsg2.images[0].url));
    }

    console.log("=== 3. Verify Launcher ASCII Purity & UI Syntax ===");
    const ps1Path = path.join(PROJECT_ROOT, "scripts", "desktop-launcher.ps1");
    const ps1Bytes = fs.readFileSync(ps1Path);
    const nonAscii = [...ps1Bytes].filter((b) => b > 127).length;
    assert.equal(nonAscii, 0, `desktop-launcher.ps1 must stay pure ASCII, found ${nonAscii} non-ASCII bytes`);
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$err=$null;[System.Management.Automation.Language.Parser]::ParseFile('${ps1Path.replace(/'/g, "''")}',[ref]$null,[ref]$err)|Out-Null;if($err.Count -gt 0){$err|Format-List;exit 1}`,
      ],
      { stdio: "inherit" },
    );

    execFileSync(process.execPath, ["--check", path.join(PROJECT_ROOT, "src", "ui", "app.js")], {
      stdio: "inherit",
    });

    console.log("\nPhase 8 verification passed completely.");
  } finally {
    try {
      ws?.close();
    } catch {
      // ignore
    }
    await hub.stop();
    if (fs.existsSync(mockScriptPath)) {
      fs.unlinkSync(mockScriptPath);
    }
    for (const filePath of createdUploadFiles) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    if (hadAgentsConfig) {
      fs.writeFileSync(agentsConfigPath, prevAgentsConfig, "utf8");
    } else if (fs.existsSync(agentsConfigPath)) {
      fs.unlinkSync(agentsConfigPath);
    }
  }
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
