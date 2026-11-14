#!/bin/bash
# Double-click launcher for macOS (also works on Linux): starts RTM in the background.
cd "$(dirname "$0")" || exit 1
mkdir -p .rtm
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required: https://nodejs.org"
  read -r -p "Press Enter to close."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install || { read -r -p "npm install failed. Press Enter to close."; exit 1; }
fi
# RTM writes its own logs to .rtm/desktop.*.log.
nohup node node_modules/tsx/dist/cli.mjs src/index.ts desktop > /dev/null 2>&1 &
disown
