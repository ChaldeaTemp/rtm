#!/bin/bash
# Double-click launcher for macOS (also works on Linux): starts RTM in the background.
cd "$(dirname "$0")" || exit 1
mkdir -p .agent-hub
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required: https://nodejs.org"
  read -r -p "Press Enter to close."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install || { read -r -p "npm install failed. Press Enter to close."; exit 1; }
fi
nohup node node_modules/tsx/dist/cli.mjs src/index.ts desktop \
  > .agent-hub/desktop.stdout.log 2> .agent-hub/desktop.stderr.log &
disown
