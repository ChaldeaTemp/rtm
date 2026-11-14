import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { checkPortAvailable, findAvailablePort } from "../src/hub/port-finder.js";
import { AgentHubServer } from "../src/hub/server.js";

function reserveEphemeralPort(): Promise<{ port: number; server: net.Server }> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("无法分配临时端口"));
        return;
      }
      resolve({ port: addr.port, server: srv });
    });
  });
}

function closeNetServer(srv: net.Server): Promise<void> {
  return new Promise((resolve) => {
    srv.close(() => resolve());
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function run(): Promise<void> {
  const rootDir = process.cwd();
  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-p6-"));

  try {
    // 1. Port checker & conflict avoidance
    const occupied = await reserveEphemeralPort();
    const occupiedPort = occupied.port;
    try {
      const checkOccupied = await checkPortAvailable(occupiedPort);
      assert.equal(checkOccupied.available, false, "已占用端口应返回 available: false");

      const suggested = await findAvailablePort(occupiedPort, 50);
      assert.notEqual(suggested, occupiedPort, "findAvailablePort 不应返回被占用的端口");
      const checkSuggested = await checkPortAvailable(suggested);
      assert.equal(checkSuggested.available, true, "自动分配的端口应空闲可用");
      console.log(`PASS 1: 端口冲突检测与自动分配 (${occupiedPort} -> ${suggested})`);

      // 2. strictPort rejects cleanly when port is occupied
      const strictServer = new AgentHubServer({
        baseCwd: tmpWorkspace,
        port: occupiedPort,
        strictPort: true,
        writeRuntimeFile: false,
      });
      await assert.rejects(
        () => strictServer.start(occupiedPort),
        /unavailable|EADDRINUSE|已被占用/i,
        "strictPort=true 在端口被占用时应明确拒绝启动",
      );
      console.log("PASS 2: strictPort 冲突拒绝启动");

      // 3. Cross-platform desktop launcher: double-click wrappers exist, and the launch plan
      //    skips an occupied port and honours an explicit workspace.
      assert.equal(fs.existsSync(path.join(rootDir, "RTM.vbs")), true, "RTM.vbs 应存在于项目根目录");
      assert.equal(fs.existsSync(path.join(rootDir, "RTM.command")), true, "RTM.command 应存在于项目根目录");
      const dryOut = execFileSync(
        process.execPath,
        [
          path.join(rootDir, "node_modules", "tsx", "dist", "cli.mjs"),
          path.join(rootDir, "src", "index.ts"),
          "desktop",
          "--dry-run",
          "--port",
          String(occupiedPort),
          "--cwd",
          tmpWorkspace,
        ],
        { encoding: "utf8", windowsHide: true, cwd: rootDir },
      ).trim();
      const parsed = JSON.parse(dryOut.split(String.fromCharCode(10)).pop() ?? "{}") as {
        ok: boolean;
        port: number;
        preferredPortAvailable: boolean;
        cwd: string;
      };
      assert.equal(parsed.ok, true);
      assert.equal(parsed.preferredPortAvailable, false, "启动器应检测到首选端口被占用");
      assert.notEqual(parsed.port, occupiedPort, "启动器应跳过冲突端口");
      assert.equal(path.resolve(parsed.cwd), path.resolve(tmpWorkspace), "启动器应使用指定的工作目录");
      console.log(`PASS 3: 桌面启动器计划校验通过 (${occupiedPort} -> ${parsed.port})`);
    } finally {
      await closeNetServer(occupied.server);
    }

    // 4. Headless desktop daemon mode (--desktop --strict-port --no-open --auto-exit)
    const daemonPort = await findAvailablePort(44800, 100);
    const tsxCli = path.join(rootDir, "node_modules", "tsx", "dist", "cli.mjs");
    const srcEntry = path.join(rootDir, "src", "index.ts");
    const child = spawn(
      process.execPath,
      [
        tsxCli,
        srcEntry,
        "--desktop",
        "--strict-port",
        "--no-open",
        "--auto-exit",
        "--auto-exit-grace-ms",
        "400",
        "--port",
        String(daemonPort),
        "--cwd",
        tmpWorkspace,
      ],
      {
        cwd: rootDir,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    let stderrText = "";
    child.stderr?.on("data", (chunk) => {
      stderrText += chunk.toString();
    });

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    try {
      const baseUrl = `http://127.0.0.1:${daemonPort}`;
      let healthy = false;
      for (let i = 0; i < 60; i++) {
        if (child.exitCode !== null) break;
        try {
          const res = await fetch(`${baseUrl}/api/health`);
          if (res.ok) {
            const health = (await res.json()) as { ok: boolean; desktopMode?: boolean; port?: number };
            assert.equal(health.ok, true);
            assert.equal(health.desktopMode, true);
            assert.equal(health.port, daemonPort);
            healthy = true;
            break;
          }
        } catch {
          // wait until ready
        }
        await sleep(150);
      }
      assert.equal(healthy, true, `desktop 后台服务应在 stdin EOF 后保持存活并就绪: ${stderrText}`);

      // Verify desktop assets & endpoints
      const manifestRes = await fetch(`${baseUrl}/manifest.webmanifest`);
      assert.equal(manifestRes.status, 200);
      const manifest = (await manifestRes.json()) as { name: string; display: string };
      assert.equal(manifest.display, "standalone");

      const iconRes = await fetch(`${baseUrl}/ui/icon.svg`);
      assert.equal(iconRes.status, 200);
      const svgBody = await iconRes.text();
      assert.equal(svgBody.includes("<svg"), true);

      const checkRes = await fetch(`${baseUrl}/api/ports/check?port=${daemonPort}`);
      assert.equal(checkRes.status, 200);
      const checkJson = (await checkRes.json()) as { available: boolean };
      assert.equal(checkJson.available, false, "正在监听的端口应报告为不可用");

      const suggestRes = await fetch(`${baseUrl}/api/ports/suggest?preferred=${daemonPort}`);
      assert.equal(suggestRes.status, 200);
      const suggestJson = (await suggestRes.json()) as { port: number };
      assert.notEqual(suggestJson.port, daemonPort, "suggest 应返回不同于当前占用端口的新端口");

      const switchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-p6-cwd-"));
      try {
        const cwdRes = await fetch(`${baseUrl}/api/workspace/cwd`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: switchCwd }),
        });
        assert.equal(cwdRes.status, 200);
        const cwdJson = (await cwdRes.json()) as {
          ok: boolean;
          baseCwd: string;
          group: { cwd: string };
        };
        assert.equal(cwdJson.ok, true);
        assert.equal(path.resolve(cwdJson.baseCwd), path.resolve(switchCwd));
        assert.equal(path.resolve(cwdJson.group.cwd), path.resolve(switchCwd));
      } finally {
        fs.rmSync(switchCwd, { recursive: true, force: true });
      }

      // Connect WebSocket, read snapshot, close WS -> trigger auto-exit
      const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}/ws`);
      const snapshot = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("等待 WS snapshot 超时")), 4000);
        ws.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (msg.type === "snapshot") {
            clearTimeout(timer);
            resolve(msg);
          }
        });
      });
      assert.equal(snapshot.desktopMode, true);
      assert.equal(snapshot.port, daemonPort);

      ws.close();
      const exitResult = await Promise.race([
        exitPromise,
        sleep(6000).then(() => ({ timeout: true as const })),
      ]);

      if ("timeout" in exitResult) {
        assert.fail("最后一个 WS 窗口关闭后，--auto-exit 未在预期时间内自动退出");
      }
      assert.equal(exitResult.code, 0, "auto-exit 应以退出码 0 正常退出");
      console.log(`PASS 4: 桌面无控制台模式、manifest/端口接口及 WS 关闭自动退出均通过 (port=${daemonPort})`);
    } finally {
      if (child.exitCode === null) {
        child.kill();
      }
    }
  } finally {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
