import "./isolate-data.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findAvailablePort } from "../src/hub/port-finder.js";
import { AgentHubServer } from "../src/hub/server.js";

async function run(): Promise<void> {
  const rootDir = process.cwd();
  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-p7-"));
  const port = await findAvailablePort(45100, 100);
  const hub = new AgentHubServer({
    baseCwd: tmpWorkspace,
    port,
    writeRuntimeFile: false,
  });

  try {
    const baseUrl = await hub.start(port);

    // PASS 1: Create, Archive & Unarchive task group
    const createRes = await fetch(`${baseUrl}/api/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Phase7 归档测试" }),
    });
    assert.equal(createRes.status, 200);
    const created = (await createRes.json()) as {
      ok: boolean;
      group: { groupId: string; title: string; archived?: boolean };
    };
    assert.equal(created.ok, true);
    assert.equal(Boolean(created.group.archived), false);

    const archiveRes = await fetch(`${baseUrl}/api/groups/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: created.group.groupId, archived: true }),
    });
    assert.equal(archiveRes.status, 200);
    const archivedJson = (await archiveRes.json()) as {
      ok: boolean;
      group: { groupId: string; archived?: boolean; archivedAt?: number };
    };
    assert.equal(archivedJson.group.archived, true);
    assert.equal(typeof archivedJson.group.archivedAt, "number");

    const listRes = await fetch(`${baseUrl}/api/groups`);
    const listJson = (await listRes.json()) as {
      groups: Array<{ groupId: string; archived?: boolean }>;
    };
    assert.equal(
      listJson.groups.find((g) => g.groupId === created.group.groupId)?.archived,
      true,
    );

    const unarchiveRes = await fetch(`${baseUrl}/api/groups/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: created.group.groupId, archived: false }),
    });
    const unarchivedJson = (await unarchiveRes.json()) as {
      ok: boolean;
      group: { archived?: boolean };
    };
    assert.equal(unarchivedJson.group.archived, false);
    console.log("PASS 1: 任务归档 / 取消归档接口校验通过");

    // PASS 2: Markdown session export (raw file download + JSON format)
    await fetch(`${baseUrl}/api/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: created.group.groupId,
        title: "测试架构图",
        kind: "svg",
        content: "<svg></svg>",
      }),
    });

    const rawExportRes = await fetch(
      `${baseUrl}/api/groups/export?groupId=${encodeURIComponent(created.group.groupId)}`,
    );
    assert.equal(rawExportRes.status, 200);
    assert.equal(
      rawExportRes.headers.get("content-type")?.includes("text/markdown"),
      true,
      "原始导出接口应返回 text/markdown",
    );
    assert.equal(
      rawExportRes.headers.get("content-disposition")?.includes("attachment;"),
      true,
      "原始导出接口应携带 attachment 下载头",
    );
    const rawMd = await rawExportRes.text();
    assert.equal(rawMd.includes("# Phase7 归档测试"), true);
    assert.equal(rawMd.includes("## 一、主导会话记录"), true);
    assert.equal(rawMd.includes("## 二、委派任务记录"), true);
    assert.equal(rawMd.includes("## 三、子会话完整记录"), true);

    const jsonExportRes = await fetch(
      `${baseUrl}/api/groups/export?groupId=${encodeURIComponent(created.group.groupId)}&format=json`,
    );
    assert.equal(jsonExportRes.status, 200);
    const jsonExport = (await jsonExportRes.json()) as {
      ok: boolean;
      filename: string;
      markdown: string;
    };
    assert.equal(jsonExport.ok, true);
    assert.equal(jsonExport.filename.endsWith(".md"), true);
    assert.equal(jsonExport.markdown, rawMd);
    console.log(`PASS 2: Markdown 会话导出校验通过 (${jsonExport.filename})`);

    // PASS 3: Cancel endpoint graceful handling
    const cancelRes = await fetch(`${baseUrl}/api/peer/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: `kimi:${created.group.groupId}__sub__nonexistent` }),
    });
    assert.equal(cancelRes.status, 200);
    const cancelJson = (await cancelRes.json()) as { ok: boolean; cancelled: boolean };
    assert.equal(cancelJson.ok, true);
    assert.equal(cancelJson.cancelled, false);
    console.log("PASS 3: 会话停止接口边界校验通过");

    // PASS 4: UI static checks & zero native window.prompt / window.confirm
    const uiDir = path.join(rootDir, "src", "ui");
    for (const jsFile of ["app.js", "panels.js", "interactive.js"]) {
      const text = fs.readFileSync(path.join(uiDir, jsFile), "utf8");
      assert.equal(
        /\bwindow\.(prompt|confirm)\s*\(/.test(text),
        false,
        `${jsFile} 不应保留原生 window.prompt 或 window.confirm 调用`,
      );
    }

    const htmlText = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");
    const appText = fs.readFileSync(path.join(uiDir, "app.js"), "utf8");
    const cssText = fs.readFileSync(path.join(uiDir, "panels.css"), "utf8");

    for (const marker of [
      "#groupSearchInput",
      "#toggleArchivedBtn",
      "#exportGroupBtn",
      "#appModalBackdrop",
      "#quickSwitcherBackdrop",
    ]) {
      const id = marker.slice(1);
      assert.equal(htmlText.includes(`id="${id}"`), true, `index.html 缺少 #${id}`);
    }
    assert.equal(cssText.includes(".alma-modal-backdrop[hidden]"), true);
    for (const marker of [
      "data-copy-msg",
      "data-regen-msg",
      "isSessionRunning",
      "syncAttentionIndicators",
      "showPromptModal",
      "showConfirmModal",
      "openQuickSwitcher",
    ]) {
      assert.equal(appText.includes(marker), true, `app.js 缺少 ${marker}`);
    }
    console.log("PASS 4: UI 静态标记与无原生 prompt/confirm 校验通过");
  } finally {
    await hub.stop();
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
