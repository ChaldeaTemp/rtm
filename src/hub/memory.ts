import { execFile } from "node:child_process";
import os from "node:os";
import type { MemoryLevel, MemoryStatus } from "../types.js";

/**
 * How much room the machine has left for more agent processes.
 *
 * On Windows the number that matters is the commit charge: once it reaches the limit,
 * allocations fail and processes die, the hub among them, even while physical memory still
 * looks available. Elsewhere "free" memory is not a usable signal (the OS keeps it low on
 * purpose), so no level is derived there.
 */
export type { MemoryLevel, MemoryStatus } from "../types.js";

export const LOW_MEMORY_MB = 4096;
export const CRITICAL_MEMORY_MB = 2048;

export function levelFor(availableMB: number | undefined): MemoryLevel {
  if (availableMB === undefined) return "ok";
  if (availableMB < CRITICAL_MEMORY_MB) return "critical";
  if (availableMB < LOW_MEMORY_MB) return "low";
  return "ok";
}

function sampleWindowsCommit(): Promise<{ availableMB: number; totalMB: number } | undefined> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$o = Get-CimInstance Win32_OperatingSystem; \"$($o.FreeVirtualMemory) $($o.TotalVirtualMemorySize)\"",
      ],
      { windowsHide: true, timeout: 20000 },
      (err, stdout) => {
        if (err) return resolve(undefined);
        const [freeKb, totalKb] = String(stdout).trim().split(/\s+/).map(Number);
        if (!Number.isFinite(freeKb) || !Number.isFinite(totalKb) || totalKb! <= 0) return resolve(undefined);
        resolve({ availableMB: Math.round(freeKb! / 1024), totalMB: Math.round(totalKb! / 1024) });
      },
    );
  });
}

export class MemoryMonitor {
  private status: MemoryStatus = { level: "ok", sampledAt: 0 };
  private timer?: NodeJS.Timeout;
  private sampling = false;

  constructor(
    private readonly onChange: (status: MemoryStatus, previous: MemoryStatus) => void,
    private readonly intervalMs = 45_000,
    /** Replaceable in tests. */
    private readonly sampler: () => Promise<{ availableMB: number; totalMB: number } | undefined> = process.platform ===
    "win32"
      ? sampleWindowsCommit
      : async () => undefined,
  ) {}

  get(): MemoryStatus {
    return { ...this.status };
  }

  start(): void {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async sample(): Promise<MemoryStatus> {
    if (this.sampling) return this.get();
    this.sampling = true;
    try {
      const measured = await this.sampler();
      const previous = this.status;
      this.status = {
        level: levelFor(measured?.availableMB),
        availableMB: measured?.availableMB,
        totalMB: measured?.totalMB ?? Math.round(os.totalmem() / 1048576),
        sampledAt: Date.now(),
      };
      if (previous.level !== this.status.level || previous.sampledAt === 0) {
        this.onChange(this.get(), previous);
      }
      return this.get();
    } finally {
      this.sampling = false;
    }
  }
}
