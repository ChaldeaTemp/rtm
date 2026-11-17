import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function findExecutableInPath(names) {
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

if (process.env.RTM_CLAUDE_PROVIDER !== "native" && (!process.env.CLAUDE_CODE_EXECUTABLE || !process.env.CLAUDE_CODE_EXECUTABLE.trim())) {
  let found;
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const defaultWin = path.join(localAppData, "Programs", "reclaude", "bin", "reclaude.exe");
    if (fs.existsSync(defaultWin)) {
      found = defaultWin;
    } else {
      found = findExecutableInPath(["reclaude.exe", "rec.exe"]);
    }
  } else {
    found = findExecutableInPath(["reclaude", "rec"]);
  }

  if (found) {
    process.env.CLAUDE_CODE_EXECUTABLE = found;
  }
}

await import("../node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
