import "./isolate-data.js";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

import { AgentHubServer } from "../src/hub/server.js";
import { negotiateLocale } from "../src/hub/i18n.js";
import { setLanguagePreference, th } from "../src/ui/i18n.js";
import { messages } from "../src/ui/messages.js";
import {
  buildInlinePreviewSrcdoc,
  computeDiffStats,
  highlightCode,
  partitionMessagesForDisplay,
  renderMarkdown,
  renderUnifiedDiff,
} from "../src/ui/markdown.js";

const MOCK_ACP_SOURCE = `
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const mode = process.env.MOCK_MODE || "rich";
const stateDir = process.env.MOCK_STATE_DIR || process.cwd();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

function bumpCounter(name) {
  const file = path.join(stateDir, name + ".count");
  let count = 0;
  try {
    count = Number(fs.readFileSync(file, "utf8").trim()) || 0;
  } catch {
    count = 0;
  }
  count += 1;
  fs.writeFileSync(file, String(count), "utf8");
  return count;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: true } },
      },
    });
    return;
  }

  if (msg.method === "session/new") {
    const sessionId = "sess-" + mode + "-" + Date.now();
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
    if (mode === "rich") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "/review", description: "Code review", input: { hint: "file" } },
              { name: "deploy", description: "Deploy service" },
            ],
          },
        },
      });
    }
    return;
  }

  if (msg.method === "session/prompt") {
    const sessionId = msg.params?.sessionId || "sess-1";
    const blocks = Array.isArray(msg.params?.prompt) ? msg.params.prompt : [];
    const textJoined = blocks.map((b) => (b && b.type === "text" ? String(b.text || "") : "")).join("\\n");

    if (mode === "retry") {
      const attempt = bumpCounter("retry");
      if (attempt === 1) {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "mock transient retry failure" },
        });
        return;
      }
      const fileSeen = textJoined.includes("note.txt");
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "RETRY_OK FILE_SEEN=" + fileSeen },
          },
        },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (mode === "worktree") {
      fs.writeFileSync(path.join(process.cwd(), "wt-added.txt"), "from isolated worktree\\n", "utf8");
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "WORKTREE_WROTE CWD=" + process.cwd() },
          },
        },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (mode === "workflow") {
      if (textJoined.includes("RUN_STEP_2")) {
        const s2Count = bumpCounter("wf-step2");
        if (s2Count === 1) {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32001, message: "step2 forced first failure" },
          });
          return;
        }
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "SECOND_PHASE_OK" },
            },
          },
        });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        return;
      }
      if (textJoined.includes("RUN_STEP_1")) {
        bumpCounter("wf-step1");
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "FIRST_PHASE_DONE" },
            },
          },
        });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        return;
      }
    }

    // Default "rich" mode: emit thought -> tool -> diff update -> text chronologically
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Thinking step 1" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "Edit demo.txt",
          kind: "edit",
          status: "in_progress",
          locations: [{ path: "demo.txt" }],
          rawInput: { path: "demo.txt" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
          content: [
            { type: "diff", path: "demo.txt", oldText: "old\\nline\\n", newText: "new\\nline\\nplus\\n" },
            { type: "content", content: { type: "text", text: "updated demo.txt" } },
          ],
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Done editing file" },
        },
      },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
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
  timeoutMs = 15_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const val = await fn();
    if (predicate(val)) return val;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

function runMarkdownUnitTests(): void {
  console.log("=== 1. Verify markdown.js parser, highlighter, diff & retry folding ===");

  const mdHeading = renderMarkdown("# 主标题\n紧接正文");
  assert.ok(mdHeading.includes("<h1>主标题</h1>"), mdHeading);
  assert.ok(mdHeading.includes("<p>紧接正文</p>"), mdHeading);

  const mdNested = renderMarkdown("1. 第一项\n   - 子项A\n   - [x] 子项完成\n2. 第二项");
  assert.ok(mdNested.includes("<ol>"), mdNested);
  assert.ok(mdNested.includes("<ul>"), mdNested);
  assert.ok(mdNested.includes('type="checkbox" disabled checked'), mdNested);

  const mdAlert = renderMarkdown("> [!WARNING]\n> 注意检查边界条件");
  assert.ok(mdAlert.includes("md-alert") && mdAlert.includes("md-alert-warning"), mdAlert);
  assert.ok(mdAlert.includes("注意检查边界条件"), mdAlert);

  const mdTable = renderMarkdown("| col1 | col2 |\n| :--- | ---: |\n| a | 1 |");
  assert.ok(mdTable.includes("<table>") && mdTable.includes('<th style="text-align:left">col1</th>'), mdTable);
  assert.ok(mdTable.includes('text-align:right'), mdTable);

  const highlighted = highlightCode("ts", 'const msg = "<span>const return</span>"; // const comment');
  assert.ok(highlighted.includes("&lt;span&gt;"), highlighted);
  assert.ok(!highlighted.includes("&lt;span class="), "Single-pass highlight must not match its own HTML tags");
  assert.ok(highlighted.includes('<span class="tok-kw">const</span>'), highlighted);
  assert.ok(highlighted.includes('<span class="tok-cmt">// const comment</span>'), highlighted);

  const stats = computeDiffStats("a\nb\nc", "a\nb2\nc\nd");
  assert.deepEqual(stats, { added: 2, removed: 1 });
  const diffHtml = renderUnifiedDiff("a\nb", "a\nb2", "demo.txt");
  assert.ok(diffHtml.includes("demo.txt"), diffHtml);
  assert.ok(diffHtml.includes("diff-row-del") && diffHtml.includes("diff-row-add"), diffHtml);

  const srcdoc = buildInlinePreviewSrcdoc("html", "<div>Hi</div>", {
    dark: true,
    skin: "roundtable",
    origin: "http://127.0.0.1:4317",
  });
  assert.ok(srcdoc.includes("color-scheme: dark"), srcdoc);
  assert.ok(srcdoc.includes("#161412"), srcdoc);
  assert.ok(srcdoc.includes("<div>Hi</div>"), srcdoc);

  // Duplicated failed retries followed by final attempt should fold previous retries, keeping final turn visible.
  const retryHistory = [
    { messageId: "u1", role: "user", text: "请分析问题" },
    { messageId: "a1", role: "assistant", status: "error", agent: "codex", text: "[Error] ACP session init failed: ENOENT" },
    { messageId: "u2", role: "user", text: "请分析问题" },
    { messageId: "a2", role: "assistant", status: "error", agent: "codex", text: "[Error] ACP session init failed: ENOENT" },
    { messageId: "u3", role: "user", text: "请分析问题" },
    { messageId: "a3", role: "assistant", status: "done", agent: "codex", text: "已完成分析" },
  ];
  const partRetried = partitionMessagesForDisplay(retryHistory);
  assert.equal(partRetried[0]?.kind, "retry-fold");
  assert.equal(partRetried[0]?.attempts, 2);
  assert.equal(partRetried[0]?.messages.length, 4);
  assert.equal(partRetried[1]?.kind, "message");
  assert.equal(partRetried[1]?.message.messageId, "u3");
  assert.equal(partRetried[2]?.kind, "message");
  assert.equal(partRetried[2]?.message.messageId, "a3");

  // Trailing single failed attempt stays unfolded so the user sees the active error and Retry button.
  const trailingError = [
    { messageId: "u1", role: "user", text: "请分析问题" },
    { messageId: "a1", role: "assistant", status: "error", agent: "codex", text: "[Error] failed" },
  ];
  const partTrailing = partitionMessagesForDisplay(trailingError);
  assert.equal(partTrailing.length, 2);
  assert.equal(partTrailing.every((p) => p.kind === "message"), true);

  // Leading/adjacent standalone pure errors fold while trailing error stays visible.
  const consecutiveErrors = [
    { messageId: "e1", role: "assistant", status: "error", agent: "codex", text: "[Error] first" },
    { messageId: "e2", role: "assistant", status: "error", agent: "codex", text: "[Error] second" },
    { messageId: "u1", role: "user", text: "新提问" },
    { messageId: "ok", role: "assistant", status: "done", agent: "codex", text: "正常回答" },
  ];
  const partStandalone = partitionMessagesForDisplay(consecutiveErrors);
  assert.equal(partStandalone[0]?.kind, "retry-fold");
  assert.equal(partStandalone[0]?.attempts, 2);
  assert.equal(partStandalone[1]?.message.messageId, "u1");
  assert.equal(partStandalone[2]?.message.messageId, "ok");

  // In-place retry (reused userMsg + replaced error message) shows no retry-fold.
  const inPlace = [
    { messageId: "u1", role: "user", text: "请分析问题" },
    { messageId: "ok", role: "assistant", status: "done", agent: "codex", text: "成功回答" },
  ];
  const partInPlace = partitionMessagesForDisplay(inPlace);
  assert.equal(partInPlace.length, 2);
  assert.equal(partInPlace.every((p) => p.kind === "message"), true);
}

async function registerMockAgent(
  url: string,
  id: string,
  mockScriptPath: string,
  mode: string,
  stateDir: string,
): Promise<void> {
  const resp = await fetch(`${url}/api/agents/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      label: id,
      description: `Mock agent (${mode})`,
      enabled: true,
      command: process.execPath,
      args: [mockScriptPath],
      env: { MOCK_MODE: mode, MOCK_STATE_DIR: stateDir },
    }),
  });
  assert.equal(resp.status, 200, `Failed to register mock agent ${id}`);
}

async function main(): Promise<void> {
  assert.equal(negotiateLocale("fr, en-US;q=0.8, zh;q=0.5"), "en");
  assert.equal(negotiateLocale("en;q=0, zh-TW;q=0.5"), "zh-CN");
  assert.equal(negotiateLocale("fr"), "zh-CN");
  for (const [key, [chinese, english]] of Object.entries(messages)) {
    const placeholders = (value: string) => [...value.matchAll(/\{\d+\}/g)].map(([token]) => token).sort();
    assert.deepEqual(placeholders(chinese), placeholders(english), key);
  }
  setLanguagePreference("en");
  assert.match(renderMarkdown("> [!WARNING]\n> 保留原文"), /Warning[\s\S]*保留原文/);
  assert.equal(th("directoriesFor", "<test & test>"), "Directories for “&lt;test &amp; test&gt;”");
  setLanguagePreference("zh-CN");
  runMarkdownUnitTests();

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rtm-verify-walkthrough-"));
  const projA = path.join(tmpRoot, "proj-a");
  const projB = path.join(tmpRoot, "proj-b");
  const mockStateDir = path.join(tmpRoot, "mock-state");
  fs.mkdirSync(path.join(projA, "src"), { recursive: true });
  fs.mkdirSync(path.join(projB, "src"), { recursive: true });
  fs.mkdirSync(mockStateDir, { recursive: true });
  fs.writeFileSync(path.join(projA, "src", "alpha.ts"), "export const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(projB, "src", "beta.ts"), "export const b = 2;\n", "utf8");
  fs.writeFileSync(path.join(projA, "README.md"), "# Proj A\n", "utf8");

  execFileSync("git", ["-C", projA, "init"], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", projA, "config", "user.email", "test@example.com"], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", projA, "config", "user.name", "Tester"], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", projA, "add", "."], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", projA, "commit", "-m", "init"], { stdio: "ignore", windowsHide: true });

  const mockScriptPath = path.join(tmpRoot, "mock-acp.mjs");
  fs.writeFileSync(mockScriptPath, MOCK_ACP_SOURCE, "utf8");

  const hub = new AgentHubServer({
    baseCwd: projA,
    port: 0,
    defaultLead: "mock-rich",
    permissionMode: "approve-all",
    writeRuntimeFile: false,
  });

  let ws: WebSocket | undefined;
  const wsEvents: Array<{ type: string; [key: string]: unknown }> = [];

  try {
    const url = await hub.start(0);
    await registerMockAgent(url, "mock-rich", mockScriptPath, "rich", mockStateDir);
    await registerMockAgent(url, "mock-retry", mockScriptPath, "retry", mockStateDir);
    await registerMockAgent(url, "mock-wt", mockScriptPath, "worktree", mockStateDir);
    await registerMockAgent(url, "mock-wf", mockScriptPath, "workflow", mockStateDir);

    // Connect WebSocket client and capture broadcast events
    const wsUrl = url.replace(/^http/, "ws") + "/ws";
    ws = new WebSocket(wsUrl);
    ws.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as { type: string; [key: string]: unknown };
        wsEvents.push(parsed);
      } catch {
        // ignore non-json
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", () => resolve());
      ws!.once("error", (err) => reject(err));
    });
    await waitFor(() => wsEvents.length, (n) => n >= 1);

    console.log("=== 2. Verify /ui/markdown.js & Artifact CSP + Theme/Skin Sync ===");
    const mdAssetResp = await fetch(`${url}/ui/markdown.js`);
    assert.equal(mdAssetResp.status, 200);
    const mdAssetText = await mdAssetResp.text();
    assert.ok(mdAssetText.includes("partitionMessagesForDisplay"));

    const grpAResp = await fetch(`${url}/api/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Group A", cwd: projA, leadAgent: "mock-rich" }),
    });
    const grpAJson = (await grpAResp.json()) as { group: { groupId: string } };
    const grpA = grpAJson.group.groupId;

    console.log("=== Verify locale negotiation, exports and workflow errors ===");
    await Promise.all([
      ["en-US", "# Task 1", "## 1. Lead session history", "This workflow has no steps yet"],
      ["zh-CN", "# 任务 1", "## 一、主导会话记录", "工作流还没有步骤"],
    ].map(async ([language, title, heading, errorText]) => {
      const headers = { "Accept-Language": language, "Content-Type": "application/json" };
      const exported = await fetch(`${url}/api/groups/export`, { headers });
      assert.equal(exported.status, 200);
      assert.equal(exported.headers.get("content-language"), negotiateLocale(language));
      const markdown = await exported.text();
      assert.ok(markdown.startsWith(title));
      assert.ok(markdown.includes(heading));
      const namedGroup = await fetch(`${url}/api/groups/export?groupId=${grpA}`, { headers });
      assert.ok((await namedGroup.text()).startsWith("# Group A"));
      const workflow = await fetch(`${url}/api/workflows/run`, {
        method: "POST",
        headers,
        body: JSON.stringify({ groupId: grpA }),
      });
      assert.equal(workflow.status, 400);
      assert.equal((await workflow.json() as { error: string }).error, errorText);
    }));

    const artCreateResp = await fetch(`${url}/api/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: grpA,
        title: "Verify CSP Card",
        kind: "html",
        content: "<div>artifact ok</div>",
      }),
    });
    assert.equal(artCreateResp.status, 200);
    const artCreateJson = (await artCreateResp.json()) as { ok: boolean; previewUrl: string };
    assert.equal(artCreateJson.ok, true);

    const artUrl = new URL(artCreateJson.previewUrl, url);
    artUrl.searchParams.set("theme", "dark");
    artUrl.searchParams.set("skin", "roundtable");
    const artPageResp = await fetch(artUrl);
    assert.equal(artPageResp.status, 200);
    assert.equal(artPageResp.headers.get("content-security-policy"), "sandbox allow-scripts");
    const artHtml = await artPageResp.text();
    assert.ok(artHtml.includes("color-scheme: dark") && artHtml.includes("#171512"), artHtml);

    console.log("=== 3. Verify Multi-cwd Resource Isolation & /api/workspace/files ===");
    const grpBResp = await fetch(`${url}/api/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Group B", cwd: projB, leadAgent: "mock-rich" }),
    });
    const grpBJson = (await grpBResp.json()) as { group: { groupId: string } };
    const grpB = grpBJson.group.groupId;

    const addRuleB = await fetch(`${url}/api/resources/rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "rule-b-only",
        scope: "project",
        content: "Only B should see this rule",
        groupId: grpB,
      }),
    });
    assert.equal(addRuleB.status, 200);

    const resAResp = await fetch(`${url}/api/resources?groupId=${encodeURIComponent(grpA)}`);
    const resAJson = (await resAResp.json()) as { resources: Array<{ name: string }> };
    assert.equal(resAJson.resources.some((r) => r.name === "rule-b-only"), false, "projA must not see projB rule");

    const resBResp = await fetch(`${url}/api/resources?groupId=${encodeURIComponent(grpB)}`);
    const resBJson = (await resBResp.json()) as { resources: Array<{ name: string }> };
    assert.equal(resBJson.resources.some((r) => r.name === "rule-b-only"), true, "projB must see rule-b-only");

    const filesResp = await fetch(`${url}/api/workspace/files?groupId=${encodeURIComponent(grpB)}&q=beta`);
    const filesJson = (await filesResp.json()) as { files: string[] };
    assert.ok(filesJson.files.some((f) => f.includes("beta.ts")), JSON.stringify(filesJson.files));
    assert.equal(filesJson.files.some((f) => f.includes("alpha.ts")), false);

    console.log("=== 4. Verify Chronological parts, tool diffs/outputText & availableCommands ===");
    const richChatResp = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: grpA, prompt: "执行工具并检查排序" }),
    });
    assert.equal(richChatResp.status, 200);
    const richChatJson = (await richChatResp.json()) as { sessionKey: string; outputText: string };
    assert.equal(richChatJson.outputText, "Done editing file");

    const stateResp = await fetch(`${url}/api/telemetry`);
    const stateJson = (await stateResp.json()) as {
      sessions: Array<{ sessionKey: string; availableCommands?: Array<{ name: string; hint?: string }> }>;
    };
    const richSess = stateJson.sessions.find((s) => s.sessionKey === richChatJson.sessionKey);
    assert.ok(richSess?.availableCommands?.some((c) => c.name === "review" && c.hint === "file"));

    const grpAMsgs = hub.getMessages({ groupId: grpA });
    const richAssistant = grpAMsgs.find((m) => m.role === "assistant" && m.text.includes("Done editing file"));
    assert.ok(richAssistant, "Expected assistant message in group A");
    assert.deepEqual(
      (richAssistant!.parts || []).map((p) => p.type),
      ["thought", "tool", "text"],
    );
    const tc1 = richAssistant!.toolCalls?.find((t) => t.toolCallId === "tc-1");
    assert.equal(tc1?.outputText, "updated demo.txt");
    assert.equal(tc1?.diffs?.[0]?.oldText, "old\nline\n");
    assert.equal(tc1?.diffs?.[0]?.newText, "new\nline\nplus\n");

    console.log("=== 5. Verify Retry In-Place (reuseMessageId + replaceAssistantMessageId + message_deleted) ===");
    const grpRetryResp = await fetch(`${url}/api/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Retry Group", cwd: projA, leadAgent: "mock-retry" }),
    });
    const grpRetry = ((await grpRetryResp.json()) as { group: { groupId: string } }).group.groupId;

    const failChatResp = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: grpRetry,
        prompt: "检查附件并回答",
        files: [
          {
            name: "note.txt",
            mimeType: "text/plain",
            data: Buffer.from("SECRET_RETRY_FILE_CONTENT", "utf8").toString("base64"),
          },
        ],
      }),
    });
    assert.equal(failChatResp.status, 400, "First mock-retry attempt must fail");

    const retryMsgsBefore = hub.getMessages({ groupId: grpRetry });
    const userRetryMsg = retryMsgsBefore.find((m) => m.role === "user");
    const errAssistantMsg = retryMsgsBefore.find((m) => m.role === "assistant");
    assert.ok(userRetryMsg && errAssistantMsg);
    assert.equal(errAssistantMsg.status, "error");

    const okRetryResp = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: grpRetry,
        prompt: "",
        reuseMessageId: userRetryMsg.messageId,
        replaceAssistantMessageId: errAssistantMsg.messageId,
      }),
    });
    assert.equal(okRetryResp.status, 200);
    const okRetryJson = (await okRetryResp.json()) as { outputText: string };
    assert.ok(okRetryJson.outputText.includes("RETRY_OK"), okRetryJson.outputText);
    assert.ok(okRetryJson.outputText.includes("FILE_SEEN=true"), okRetryJson.outputText);

    await waitFor(
      () => wsEvents.some((ev) => ev.type === "message_deleted" && ev.messageId === errAssistantMsg.messageId),
      (found) => found === true,
    );
    const retryMsgsAfter = hub.getMessages({ groupId: grpRetry });
    assert.equal(retryMsgsAfter.filter((m) => m.role === "user").length, 1, "User message must be reused in place");
    assert.equal(retryMsgsAfter[0]?.messageId, userRetryMsg.messageId);
    assert.equal(retryMsgsAfter.some((m) => m.messageId === errAssistantMsg.messageId), false);
    assert.equal(retryMsgsAfter.filter((m) => m.role === "assistant").length, 1);

    console.log("=== 6. Verify Git Worktree Diff/Merge & Group Delete Cascade ===");
    const dispatchResp = await fetch(`${url}/api/peer/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetAgent: "mock-wt",
        groupId: grpA,
        prompt: "write wt-added.txt",
        isolateWorktree: true,
      }),
    });
    assert.equal(dispatchResp.status, 202);
    const dispatchJson = (await dispatchResp.json()) as { task: { taskId: string; targetSessionKey: string } };

    const statusResp = await fetch(
      `${url}/api/peer/status?taskId=${encodeURIComponent(dispatchJson.task.taskId)}&waitSeconds=10`,
    );
    const statusJson = (await statusResp.json()) as { task: { status: string } };
    assert.equal(statusJson.task.status, "completed");

    const diffResp = await fetch(
      `${url}/api/worktrees/diff?sessionKey=${encodeURIComponent(dispatchJson.task.targetSessionKey)}`,
    );
    assert.equal(diffResp.status, 200);
    const diffJson = (await diffResp.json()) as { clean: boolean; diff: string; worktreePath: string };
    assert.equal(diffJson.clean, false);
    assert.ok(diffJson.diff.includes("wt-added.txt"), diffJson.diff);
    const mergedWtPath = diffJson.worktreePath;

    const mergeResp = await fetch(`${url}/api/worktrees/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: dispatchJson.task.targetSessionKey, cleanup: true }),
    });
    assert.equal(mergeResp.status, 200);
    const mergeJson = (await mergeResp.json()) as { merged: boolean; cleaned: boolean };
    assert.equal(mergeJson.merged, true);
    assert.equal(mergeJson.cleaned, true);
    assert.equal(fs.existsSync(path.join(projA, "wt-added.txt")), true);
    assert.equal(fs.existsSync(mergedWtPath), false);

    // Cascade delete test: create a group with both an artifact and an isolated worktree, then delete it.
    const grpDelResp = await fetch(`${url}/api/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Delete Cascade Group", cwd: projA, leadAgent: "mock-rich" }),
    });
    const grpDel = ((await grpDelResp.json()) as { group: { groupId: string } }).group.groupId;

    const delArtResp = await fetch(`${url}/api/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: grpDel, title: "Disposable", kind: "html", content: "<div>gone</div>" }),
    });
    const delArtJson = (await delArtResp.json()) as { previewUrl: string };

    const delDispatch = await fetch(`${url}/api/peer/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetAgent: "mock-wt",
        groupId: grpDel,
        prompt: "cascade wt",
        isolateWorktree: true,
      }),
    });
    const delTask = ((await delDispatch.json()) as { task: { taskId: string; targetSessionKey: string } }).task;
    await fetch(`${url}/api/peer/status?taskId=${encodeURIComponent(delTask.taskId)}&waitSeconds=10`);
    const delDiffJson = (await (
      await fetch(`${url}/api/worktrees/diff?sessionKey=${encodeURIComponent(delTask.targetSessionKey)}`)
    ).json()) as { worktreePath: string };
    assert.equal(fs.existsSync(delDiffJson.worktreePath), true);

    const deleteGrpResp = await fetch(`${url}/api/groups/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: grpDel }),
    });
    assert.equal(deleteGrpResp.status, 200);
    assert.equal(fs.existsSync(delDiffJson.worktreePath), false, "deleteGroup must remove session worktree");
    const artAfterDel = await fetch(new URL(delArtJson.previewUrl, url));
    assert.equal(artAfterDel.status, 404, "deleteGroup must clean up group artifacts");

    console.log("=== 7. Verify Workflow retryFailed (/api/workflows/retry) ===");
    const grpWfResp = await fetch(`${url}/api/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Workflow Retry Group", cwd: projA, leadAgent: "mock-rich" }),
    });
    const grpWf = ((await grpWfResp.json()) as { group: { groupId: string } }).group.groupId;

    const wfSaveResp = await fetch(`${url}/api/workflows/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: grpWf,
        steps: [
          { id: "step1", name: "步骤一", agent: "mock-wf", prompt: "RUN_STEP_1" },
          { id: "step2", name: "步骤二", agent: "mock-wf", prompt: "RUN_STEP_2", dependsOn: ["step1"] },
        ],
      }),
    });
    assert.equal(wfSaveResp.status, 200);

    const wfRunResp = await fetch(`${url}/api/workflows/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: grpWf }),
    });
    assert.equal(wfRunResp.status, 200);

    const failedWf = await waitFor(
      async () => {
        const r = await fetch(`${url}/api/workflows?groupId=${encodeURIComponent(grpWf)}`);
        return (await r.json()) as { workflow: { status: string; steps: Array<{ id: string; status: string }> } };
      },
      (data) => data.workflow.status === "failed",
    );
    assert.equal(failedWf.workflow.steps.find((s) => s.id === "step1")?.status, "completed");
    assert.equal(failedWf.workflow.steps.find((s) => s.id === "step2")?.status, "failed");
    assert.equal(fs.readFileSync(path.join(mockStateDir, "wf-step1.count"), "utf8").trim(), "1");
    assert.equal(fs.readFileSync(path.join(mockStateDir, "wf-step2.count"), "utf8").trim(), "1");

    const wfRetryResp = await fetch(`${url}/api/workflows/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: grpWf }),
    });
    assert.equal(wfRetryResp.status, 200);

    const retriedWf = await waitFor(
      async () => {
        const r = await fetch(`${url}/api/workflows?groupId=${encodeURIComponent(grpWf)}`);
        return (await r.json()) as { workflow: { status: string; steps: Array<{ id: string; status: string }> } };
      },
      (data) => data.workflow.status === "completed",
    );
    assert.equal(retriedWf.workflow.steps.find((s) => s.id === "step1")?.status, "completed");
    assert.equal(retriedWf.workflow.steps.find((s) => s.id === "step2")?.status, "completed");
    assert.equal(
      fs.readFileSync(path.join(mockStateDir, "wf-step1.count"), "utf8").trim(),
      "1",
      "retryFailed must not re-run already completed step1",
    );
    assert.equal(fs.readFileSync(path.join(mockStateDir, "wf-step2.count"), "utf8").trim(), "2");

    console.log("\nWalkthrough verification passed completely.");
  } finally {
    try {
      ws?.close();
    } catch {
      // ignore
    }
    await hub.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  }
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
