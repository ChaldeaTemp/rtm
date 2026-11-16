import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { AgentDefinition } from "../types.js";
import { findAvailablePort } from "./port-finder.js";
import { killProcessTree, PROJECT_ROOT, resolveAdapterCommand, resolveGenericCommand } from "./process-tree.js";

const TIMEOUT_MS = 12_000;
const percent = z.number().min(0).max(100);

interface QuotaWindow {
  name?: string;
  minutes?: number;
  usedPercent: number;
  resetsAt?: number;
}

interface Quota {
  windows: QuotaWindow[];
  balance?: { amount: number; currency?: string };
}

type QuotaResult =
  | ({ status: "ok"; checkedAt: number } & Quota)
  | { status: "unsupported" | "unavailable" | "error"; checkedAt: number };

export function supportsAgentQuota(def: AgentDefinition): boolean {
  return def.builtin === true && !def.command?.trim() &&
    (def.id === "codex" || (def.id === "kimi" && (!def.args?.length || def.args.join(" ") === "acp")));
}

const codexWindow = z.object({
  usedPercent: percent,
  windowDurationMins: z.number().positive().nullish(),
  resetsAt: z.number().positive().nullish(),
});
const codexBucket = z.object({
  limitId: z.string().optional(),
  limitName: z.string().nullish(),
  primary: codexWindow.nullish(),
  secondary: codexWindow.nullish(),
  credits: z.object({ balance: z.string().nullish(), unlimited: z.boolean().optional() }).nullish(),
});

function parseCodexQuota(value: unknown): Quota {
  const account = z.object({
    rateLimits: z.unknown(),
    rateLimitsByLimitId: z.record(z.string(), z.unknown()).nullish(),
  }).parse(value);
  const fallback = codexBucket.safeParse(account.rateLimits).data;
  const buckets = new Map<string, z.infer<typeof codexBucket>>();
  if (fallback) buckets.set(fallback.limitId ?? "codex", fallback);
  for (const [id, raw] of Object.entries(account.rateLimitsByLimitId ?? {})) {
    const bucket = codexBucket.safeParse(raw).data;
    if (bucket) buckets.set(bucket.limitId ?? id, bucket);
  }
  const windows: QuotaWindow[] = [];
  for (const [id, bucket] of buckets) {
    for (const window of [bucket.primary, bucket.secondary]) {
      if (window) windows.push({
        name: bucket.limitName ?? (id === "codex" ? undefined : id),
        minutes: window.windowDurationMins ?? undefined,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt ? window.resetsAt * 1000 : undefined,
      });
    }
  }
  const credits = buckets.get("codex")?.credits ?? fallback?.credits;
  const amount = credits?.balance?.trim() && !credits.unlimited ? Number(credits.balance) : NaN;
  return Number.isFinite(amount) && amount >= 0 ? { windows, balance: { amount } } : { windows };
}

async function queryCodex(def: AgentDefinition, cwd: string): Promise<Quota> {
  const env = { ...process.env, ...resolveAdapterCommand(def.id, def).env };
  const args = ["app-server", "--listen", "stdio://"];
  // Resolve the CLI the same way as codex-acp so the quota belongs to the configured account.
  const requireAdapter = createRequire(path.join(PROJECT_ROOT, "node_modules/@agentclientprotocol/codex-acp/dist/index.js"));
  const command = env.CODEX_PATH?.trim()
    ? resolveGenericCommand(env.CODEX_PATH, args)
    : { command: process.execPath, args: [requireAdapter.resolve("@openai/codex/bin/codex.js"), ...args] };
  const child = spawn(command.command, command.args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Quota>((resolve, reject) => {
      const send = (message: object) => child.stdin.write(JSON.stringify(message) + "\n");
      timer = setTimeout(() => reject(new Error("Codex quota request timed out")), TIMEOUT_MS);
      child.once("error", reject);
      child.stdin.on("error", reject);
      child.once("exit", () => reject(new Error("Codex app server exited")));
      lines.on("line", (line) => {
        try {
          const rpc = JSON.parse(line);
          if (rpc.id === 1) {
            if (rpc.error) return reject(new Error("Codex app server initialization failed"));
            send({ method: "initialized" });
            send({ id: 2, method: "account/rateLimits/read" });
          } else if (rpc.id === 2) {
            if (rpc.error) {
              const message = String(rpc.error.message ?? "");
              if (/authentication required|not logged in|api key/i.test(message)) return resolve({ windows: [] });
              return reject(new Error("Codex quota request failed"));
            }
            resolve(parseCodexQuota(rpc.result));
          }
        } catch (error) {
          reject(error);
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "rtm", version: "0.1.0" } } });
    });
  } finally {
    clearTimeout(timer);
    lines.close();
    if (child.exitCode === null && child.signalCode === null) killProcessTree(child.pid);
  }
}

const kimiUsage = z.object({ usedRatio: z.number().min(0).max(1), resetAt: z.string().nullish() });
const kimiResponse = z.object({
  code: z.number(),
  data: z.object({
    quota: z.object({
      usages: z.record(z.string(), z.unknown()).nullish(),
      extraUsage: z.object({
        balanceCents: z.number().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      }).nullish(),
    }).nullish(),
  }).nullish(),
});

async function queryKimi(def: AgentDefinition, cwd: string): Promise<Quota> {
  const command = resolveAdapterCommand(def.id, def);
  const env = { ...process.env, ...command.env };
  const home = env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
  const instances = path.join(home, "server", "instances");
  const port = await findAvailablePort(58627);
  const child = spawn(command.command, ["web", "--no-open", "--host", "127.0.0.1", "--port", String(port)],
    { cwd, env, windowsHide: true, stdio: "ignore" });
  let failed = false;
  child.once("error", () => { failed = true; });
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url: string | undefined;
  let token: string | undefined;
  try {
    // Only send the bearer token to the loopback server started by this request.
    while (!url && !failed && child.exitCode === null && child.signalCode === null) {
      for (const file of await fs.readdir(instances).catch(() => [])) {
        if (!file.endsWith(".json")) continue;
        try {
          const record = JSON.parse(await fs.readFile(path.join(instances, file), "utf8"));
          if (child.pid && record.pid === child.pid && record.host === "127.0.0.1" &&
              Number.isInteger(record.port) && record.port >= 1024 && record.port <= 65535) {
            url = `http://127.0.0.1:${record.port}`;
            break;
          }
        } catch {
          // Stale or still-being-written instance record.
        }
      }
      if (!url) await delay(150, undefined, { signal });
    }
    if (!url) throw new Error("Kimi Web could not start");
    while (!failed && child.exitCode === null && child.signalCode === null) {
      const ready = await fetch(`${url}/api/v1/healthz`, { signal, redirect: "error" }).catch(() => null);
      if (ready?.ok) break;
      await delay(150, undefined, { signal });
    }
    if (failed || child.exitCode !== null || child.signalCode !== null) throw new Error("Kimi Web exited before becoming ready");
    token = (await fs.readFile(path.join(home, "server.token"), "utf8")).trim();
    const response = await fetch(`${url}/api/v1/oauth/usage`, {
      headers: { Authorization: `Bearer ${token}` }, signal, redirect: "error",
    });
    if (!response.ok) throw new Error("Kimi quota request failed");
    const data = kimiResponse.parse(await response.json());
    if (data.code !== 0) throw new Error("Kimi quota request failed");
    const quota = data.data?.quota;
    const labels = { limit5h: { minutes: 300 }, limit7d: { minutes: 10080 }, monthTotal: { name: "monthTotal" }, monthCode: { name: "monthCode" } };
    const windows: QuotaWindow[] = [];
    for (const [key, label] of Object.entries(labels)) {
      const value = kimiUsage.safeParse(quota?.usages?.[key]).data;
      if (!value) continue;
      const reset = value.resetAt ? Date.parse(value.resetAt) : NaN;
      windows.push({ ...label, usedPercent: value.usedRatio * 100, resetsAt: Number.isFinite(reset) ? reset : undefined });
    }
    return quota?.extraUsage
      ? { windows, balance: { amount: quota.extraUsage.balanceCents / 100, currency: quota.extraUsage.currency } }
      : { windows };
  } finally {
    if (url && token && child.exitCode === null && child.signalCode === null) {
      try {
        await fetch(`${url}/api/v1/shutdown`, {
          method: "POST", headers: { Authorization: `Bearer ${token}` }, redirect: "error",
          signal: AbortSignal.timeout(700),
        });
        await delay(150);
      } catch {
        // Fall back to terminating only our child below.
      }
    }
    if (child.exitCode === null && child.signalCode === null) killProcessTree(child.pid);
  }
}

export class AgentQuotaReader {
  private readonly cache = new Map<string, Promise<QuotaResult>>();

  invalidate(agent: string): void {
    this.cache.delete(agent);
  }

  read(def: AgentDefinition, cwd: string): Promise<QuotaResult> {
    if (!def.enabled || !supportsAgentQuota(def)) {
      return Promise.resolve({ status: "unsupported", checkedAt: Date.now() });
    }
    const cached = this.cache.get(def.id);
    if (cached) return cached;
    const run = this.query(def, cwd);
    this.cache.set(def.id, run);
    void run.then(({ status }) => {
      setTimeout(() => {
        if (this.cache.get(def.id) === run) this.cache.delete(def.id);
      }, status === "ok" ? 60_000 : 15_000).unref();
    });
    return run;
  }

  private async query(def: AgentDefinition, cwd: string): Promise<QuotaResult> {
    try {
      const quota = await (def.id === "codex" ? queryCodex(def, cwd) : queryKimi(def, cwd));
      const checkedAt = Date.now();
      return quota.windows.length || quota.balance
        ? { status: "ok", checkedAt, ...quota }
        : { status: "unavailable", checkedAt };
    } catch {
      return { status: "error", checkedAt: Date.now() };
    }
  }
}
