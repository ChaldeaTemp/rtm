import path from "node:path";
import type { AgentId, PermissionMode } from "./types.js";
import { checkAdaptersHealth } from "./hub/process-tree.js";
import { AgentHubServer, readRuntimeFile } from "./hub/server.js";
import { runRepl } from "./cli/repl.js";
import { openInteractiveWindow } from "./ui/launcher.js";

function parseCliFlags(argv: string[]): {
  command?: string;
  lead: AgentId;
  cwd: string;
  port: number;
  openUi: boolean;
  permissionMode: PermissionMode;
  positionals: string[];
} {
  let command: string | undefined;
  let lead: AgentId = "claude";
  let cwd = process.cwd();
  let port = 4317;
  let openUi = false;
  let permissionMode: PermissionMode = "approve-all";
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--ui" || arg === "--app") {
      openUi = true;
    } else if (arg === "--lead" && argv[i + 1]) {
      const val = argv[++i]!;
      if (val === "claude" || val === "codex" || val === "agy") {
        lead = val;
      } else {
        throw new Error(`Invalid --lead agent: ${val}`);
      }
    } else if (arg === "--cwd" && argv[i + 1]) {
      cwd = path.resolve(argv[++i]!);
    } else if (arg === "--port" && argv[i + 1]) {
      port = Number(argv[++i]!) || 4317;
    } else if (arg === "--approve" && argv[i + 1]) {
      const val = argv[++i]!;
      if (val === "all" || val === "approve-all") permissionMode = "approve-all";
      else if (val === "reads" || val === "approve-reads") permissionMode = "approve-reads";
      else if (val === "manual") permissionMode = "manual";
      else throw new Error(`Invalid --approve mode: ${val}`);
    } else if (!command && (arg === "status" || arg === "exec" || arg === "ui")) {
      command = arg;
      if (arg === "ui") openUi = true;
    } else {
      positionals.push(arg);
    }
  }

  return { command, lead, cwd, port, openUi, permissionMode, positionals };
}

async function main(): Promise<void> {
  const opts = parseCliFlags(process.argv.slice(2));

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

  const hub = new AgentHubServer({
    baseCwd: opts.cwd,
    port: opts.port,
    defaultLead: opts.lead,
    permissionMode: opts.permissionMode,
  });

  const cleanup = async () => {
    await hub.stop();
    process.exit(0);
  };
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
        throw new Error("Usage: agent-hub exec [--lead claude|codex|agy] \"<prompt>\"");
      }
      const res = await hub.runLeadChat({ prompt, leadAgent: opts.lead });
      console.log(res.outputText);
      return;
    }

    if (opts.openUi) {
      const launched = openInteractiveWindow(url, true);
      console.log(`Interactive UI opened (${launched.mode}) at ${url}`);
    }

    await runRepl(hub);
  } finally {
    await hub.stop();
  }
}

main().catch((err) => {
  console.error("[agent-hub] Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
