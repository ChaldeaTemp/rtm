#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import type { AgentId, PermissionMode } from "./types.js";
import { findAvailablePort } from "./hub/port-finder.js";
import { checkAdaptersHealth, PROJECT_ROOT } from "./hub/process-tree.js";
import { AgentHubServer, readRuntimeFile } from "./hub/server.js";
import { createDesktopShortcut, planDesktopLaunch, saveDesktopPrefs } from "./desktop.js";
import { runRepl } from "./cli/repl.js";
import { openInteractiveWindow } from "./ui/launcher.js";

function parseCliFlags(argv: string[]): {
  command?: string;
  lead?: AgentId;
  cwd: string;
  port: number;
  openUi: boolean;
  noOpen: boolean;
  desktopMode: boolean;
  strictPort: boolean;
  autoExit: boolean;
  autoExitGraceMs?: number;
  permissionMode: PermissionMode;
  positionals: string[];
  /** --port / --cwd were given, so they override the saved desktop preferences. */
  portExplicit: boolean;
  cwdExplicit: boolean;
  /** desktop: show the folder dialog even though a workspace is remembered. */
  chooseDir: boolean;
  /** desktop: print the launch plan as JSON and exit without starting anything. */
  dryRun: boolean;
} {
  let command: string | undefined;
  let lead: AgentId | undefined;
  let cwd = process.cwd();
  let port = 4317;
  let openUi = false;
  let noOpen = false;
  let desktopMode = false;
  let strictPort = false;
  let autoExit = false;
  let autoExitGraceMs: number | undefined;
  let permissionMode: PermissionMode = "approve-all";
  const positionals: string[] = [];
  let portExplicit = false;
  let cwdExplicit = false;
  let chooseDir = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--ui" || arg === "--app") {
      openUi = true;
    } else if (arg === "--desktop") {
      desktopMode = true;
      openUi = true;
    } else if (arg === "--no-open") {
      noOpen = true;
    } else if (arg === "--strict-port") {
      strictPort = true;
    } else if (arg === "--auto-exit") {
      autoExit = true;
    } else if (arg === "--auto-exit-grace-ms" && argv[i + 1]) {
      const val = Number(argv[++i]!);
      if (Number.isFinite(val) && val >= 100) {
        autoExitGraceMs = val;
      }
    } else if (arg === "--lead" && argv[i + 1]) {
      const val = argv[++i]!.trim();
      if (val) {
        lead = val;
      } else {
        throw new Error(`Invalid --lead agent: ${val}`);
      }
    } else if (arg === "--cwd" && argv[i + 1]) {
      cwd = path.resolve(argv[++i]!);
      cwdExplicit = true;
    } else if (arg === "--port" && argv[i + 1]) {
      port = Number(argv[++i]!) || 4317;
      portExplicit = true;
    } else if (arg === "--choose-dir") {
      chooseDir = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--approve" && argv[i + 1]) {
      const val = argv[++i]!;
      if (val === "all" || val === "approve-all") permissionMode = "approve-all";
      else if (val === "reads" || val === "approve-reads") permissionMode = "approve-reads";
      else if (val === "manual") permissionMode = "manual";
      else throw new Error(`Invalid --approve mode: ${val}`);
    } else if (!command && (arg === "status" || arg === "exec" || arg === "ui" || arg === "desktop" || arg === "shortcut")) {
      command = arg;
      if (arg === "ui") openUi = true;
    } else {
      positionals.push(arg);
    }
  }

  return {
    command,
    lead,
    cwd,
    port,
    openUi,
    noOpen,
    desktopMode,
    strictPort,
    autoExit,
    autoExitGraceMs,
    permissionMode,
    positionals,
    portExplicit,
    cwdExplicit,
    chooseDir,
    dryRun,
  };
}

async function main(): Promise<void> {
  const opts = parseCliFlags(process.argv.slice(2));

  if (opts.command === "shortcut") {
    console.log(`Desktop shortcut created: ${createDesktopShortcut()}`);
    return;
  }

  if (opts.command === "desktop") {
    const plan = await planDesktopLaunch({
      port: opts.portExplicit ? opts.port : undefined,
      cwd: opts.cwdExplicit ? opts.cwd : undefined,
      chooseDir: opts.chooseDir,
      ignoreRunning: opts.dryRun,
    });
    if (opts.dryRun) {
      console.log(JSON.stringify({ ok: true, ...plan }));
      return;
    }
    if (plan.reuseUrl) {
      // Already running: a second launch only brings up another window.
      if (!opts.noOpen) openInteractiveWindow(plan.reuseUrl, true);
      console.log(`RTM is already running at ${plan.reuseUrl}`);
      return;
    }
    opts.desktopMode = true;
    opts.openUi = true;
    opts.autoExit = plan.autoExit;
    opts.port = plan.port;
    opts.cwd = plan.cwd;
    saveDesktopPrefs({ port: plan.port, cwd: plan.cwd, autoExit: plan.autoExit });
  }

  if (opts.command === "status") {
    const adapters = checkAdaptersHealth();
    const runtime = readRuntimeFile();
    console.log(
      JSON.stringify(
        {
          adapters,
          runningHub: runtime ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Without --lead the hub resolves the lead itself: persisted default, then first ready agent.
  const defaultLead = opts.lead;

  let exiting = false;
  let hub!: AgentHubServer;
  const cleanup = async () => {
    if (exiting) return;
    exiting = true;
    try {
      await hub.stop();
    } finally {
      process.exit(0);
    }
  };

  hub = new AgentHubServer({
    baseCwd: opts.cwd,
    port: opts.port,
    defaultLead,
    permissionMode: opts.permissionMode,
    strictPort: opts.strictPort,
    desktopMode: opts.desktopMode,
    autoExitOnWindowClose: opts.autoExit,
    autoExitGraceMs: opts.autoExitGraceMs,
    onAutoExit: () => {
      void cleanup();
    },
  });

  process.once("SIGINT", () => {
    void cleanup();
  });
  process.once("SIGTERM", () => {
    void cleanup();
  });

  const url = await hub.start(opts.port);

  try {
    if (opts.command === "exec") {
      const prompt = opts.positionals.join(" ").trim();
      if (!prompt) {
        throw new Error("Usage: rtm exec [--lead claude|codex|agy] \"<prompt>\"");
      }
      const res = await hub.runLeadChat({ prompt, leadAgent: defaultLead });
      console.log(res.outputText);
      return;
    }

    if (opts.desktopMode) {
      console.log(`RTM desktop server listening at ${url} (cwd: ${hub.baseCwd})`);
      if (opts.openUi && !opts.noOpen) {
        const launched = openInteractiveWindow(url, true);
        console.log(`Interactive UI opened (${launched.mode}) at ${url}`);
      }
      await new Promise<void>(() => {});
      return;
    }

    if (opts.openUi && !opts.noOpen) {
      const launched = openInteractiveWindow(url, true);
      console.log(`Interactive UI opened (${launched.mode}) at ${url}`);
    }

    await runRepl(hub);
  } finally {
    if (!exiting) {
      await hub.stop();
    }
  }
}

main().catch((err) => {
  console.error("[rtm] Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
