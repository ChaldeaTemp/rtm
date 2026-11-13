import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export interface PortCheckResult {
  available: boolean;
  reason?: string;
}

function tryBindPort(host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (err) => {
      try {
        server.close();
      } catch {
        // ignore
      }
      reject(err);
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
        } else {
          resolve();
        }
      });
    });
  });
}

/**
 * Checks whether a TCP port is free on both 0.0.0.0 and 127.0.0.1.
 */
export async function checkPortAvailable(port: number): Promise<PortCheckResult> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return {
      available: false,
      reason: "Port must be an integer between 1024 and 65535",
    };
  }

  for (const host of ["0.0.0.0", "127.0.0.1"]) {
    try {
      await tryBindPort(host, port);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const msg = err instanceof Error ? err.message : String(err);
      return {
        available: false,
        reason: code ? `${code} (${host}:${port})` : msg,
      };
    }
  }

  return { available: true };
}

/**
 * Scans starting from preferredPort (default 4317) to find the first conflict-free TCP port.
 */
export async function findAvailablePort(preferredPort = 4317, maxScan = 100): Promise<number> {
  const start =
    Number.isInteger(preferredPort) && preferredPort >= 1024 && preferredPort <= 65535
      ? preferredPort
      : 4317;

  const limit = Math.min(65535, start + Math.max(1, maxScan));
  for (let candidate = start; candidate <= limit; candidate++) {
    const check = await checkPortAvailable(candidate);
    if (check.available) {
      return candidate;
    }
  }

  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen({ port: 0, host: "127.0.0.1" }, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : start;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

/**
 * Opens an OS-native folder selection dialog and returns the selected directory path.
 */
export async function pickNativeDirectory(
  initialDir?: string,
): Promise<{ cancelled: boolean; path?: string }> {
  const resolvedInitial = initialDir ? path.resolve(initialDir) : process.cwd();
  const safeInitial = fs.existsSync(resolvedInitial) ? resolvedInitial : process.cwd();

  if (process.platform === "win32") {
    const psScript = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "Add-Type -AssemblyName System.Windows.Forms",
      "$owner = New-Object System.Windows.Forms.Form",
      "$owner.TopMost = $true",
      "$owner.ShowInTaskbar = $false",
      "$owner.StartPosition = 'Manual'",
      "$owner.Location = New-Object System.Drawing.Point(-32000, -32000)",
      "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dlg.Description = 'Agent Hub Workspace'",
      "$dlg.ShowNewFolderButton = $true",
      `$initPath = ${JSON.stringify(safeInitial)}`,
      "if (Test-Path -LiteralPath $initPath -PathType Container) { $dlg.SelectedPath = $initPath }",
      "$res = $dlg.ShowDialog($owner)",
      "if ($res -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.SelectedPath) {",
      "  @{ cancelled = $false; path = $dlg.SelectedPath } | ConvertTo-Json -Compress",
      "} else {",
      "  @{ cancelled = $true } | ConvertTo-Json -Compress",
      "}",
      "$dlg.Dispose()",
      "$owner.Dispose()",
    ].join("; ");

    return await new Promise<{ cancelled: boolean; path?: string }>((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Sta", "-Command", psScript],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) {
          reject(new Error(`Folder dialog failed (${code}): ${stderr.trim() || "unknown error"}`));
          return;
        }
        try {
          const line = stdout.trim().split(/\r?\n/).pop() || "{}";
          const parsed = JSON.parse(line) as { cancelled?: boolean; path?: string };
          resolve({
            cancelled: Boolean(parsed.cancelled || !parsed.path),
            path: parsed.path ? path.resolve(parsed.path) : undefined,
          });
        } catch (err) {
          reject(
            new Error(
              `Failed to parse folder dialog output: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
      });
    });
  }

  if (process.platform === "darwin") {
    return await new Promise<{ cancelled: boolean; path?: string }>((resolve) => {
      const child = spawn("osascript", ["-e", "POSIX path of (choose folder)"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.once("exit", (code) => {
        const picked = stdout.trim();
        if (code === 0 && picked) {
          resolve({ cancelled: false, path: path.resolve(picked) });
        } else {
          resolve({ cancelled: true });
        }
      });
    });
  }

  return { cancelled: true };
}
