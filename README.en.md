# RTM (Round Table Meeting)

[简体中文](README.md) | English

RTM is a local workbench where several command-line coding agents work on one task together. It connects agents such as Claude Code, Codex, OpenCode and Kimi to a single interface: one agent leads the task and the others join as sub-sessions.

> The name and the logo are provisional. This is version 0.1.0, suitable for personal use and small trials.

![Chat view: lead session, progress panel and sub-agents](docs/screenshots/chat.png)

The interface is currently in Chinese only.

## What it does

- **One task, several agents.** Each task has a lead agent. The lead can delegate work to other agents, and is chosen when the task is created. To change it, ask the current lead in the conversation to hand over: it writes a brief, and the new lead confirms what it is taking over before carrying on. If the lead itself is broken and cannot hand over, send `/lead <agent>` in the lead conversation to switch directly.
- **Workflows.** Lay out the work for sub-sessions as steps with dependencies, review it, then publish it in one go. Write the steps yourself or ask the lead to draft them. A step can carry an acceptance gate: another agent reviews the work and a rejection goes back to be redone. A workflow that stopped part-way can continue from its finished steps, and arrangements you reuse can be saved as templates.
- **Shared context.** A task's background, conventions and step results are written once; sub-sessions take what they need instead of having it repeated in every delegation.
- **Progress panel.** Agents keep the task's goal, steps and current state up to date themselves, so you do not have to keep asking where things stand.
- **Session panel.** Context usage, sub-agents, files read and changed, and artifacts of the session you are looking at.
- **Shared rules and skills.** Each agent's own rule files and skills are made available to the others; whatever an agent does not load natively is supplied to it. Each item can be switched off for everyone or for a single agent.
- **Directories and projects.** A task can span several directories, the sidebar groups tasks by project, and tasks can be archived and restored.
- **Survives restarts.** Tasks, messages, workflows and progress are saved and restored.
- **Long runs.** If the backend exits unexpectedly it is restarted and the reason is written to `.rtm/crash.log`. Idle sub-sessions are put to sleep to free memory and wake up with their earlier conversation. When the system is short on memory the UI says so and workflows drop to one step at a time (memory is only measured on Windows for now).

![Workflow: runs left to right, steps in the same column run in parallel](docs/screenshots/workflow.png)

## Requirements

- Node.js 22 or newer.
- At least one ACP-capable command-line agent installed and signed in, for example Claude Code, Codex, OpenCode or Kimi.
- A Chromium-based browser (Edge, Chrome, Brave, ...) to open the interface as an app window. Without one, RTM falls back to the system default browser.
- Windows and macOS share the same launcher. Day-to-day use and verification have been on Windows; the macOS path follows the same logic but has not been run on a real Mac yet.

## Getting started

```bash
npm install
```

Then start it either way:

| | Windows | macOS |
|---|---|---|
| Double-click | `RTM.vbs` | `RTM.command` |
| Command line | `npm run desktop` | `npm run desktop` |

On launch RTM will:

1. Open another window if it is already running.
2. Otherwise reuse the last workspace and port, picking another port if that one is taken. The first launch shows the system folder dialog so you can choose a workspace.
3. Open the interface as an app window. The server exits when you close the window.

To put a launcher on your desktop:

```bash
npm run shortcut
```

`npm run desktop` accepts flags, for example `npm run desktop -- --choose-dir`:

| Flag | Effect |
|---|---|
| `--choose-dir` | Choose the workspace again |
| `--cwd <dir>` | Use this workspace |
| `--port <port>` | Use this port |
| `--lead <agent>` | Default lead agent for this run |
| `--no-open` | Start the server without opening a window |

Other commands:

| Command | Effect |
|---|---|
| `npm run ui` | Start in the current directory and keep an interactive prompt in the terminal |
| `npm start` | Terminal prompt only, no interface |
| `npm run status` | Show which agents are installed and signed in |

## Adding agents

claude, codex, agy, opencode and kimi are built in. Add others under Settings → Agent → Add agent, in one of three ways:

1. Common CLIs found on this machine are detected and can be added with one click.
2. Enter a tool name and let an agent you already have find the launch command and register it.
3. Enter the launch command and arguments yourself.

The long-term default lead is set in the same place.

## Appearance

Settings → General offers three skins, each with a light and a dark variant: Simple, Classic and Round Table.

![Round Table skin, dark](docs/screenshots/skin-roundtable.png)

## Before you use it

- **The default permission mode approves everything.** Agents call tools without asking. Switch to read-only approval or per-call confirmation at the top right of the chat view if you prefer.
- **The server listens on this machine only** (`127.0.0.1`) and rejects requests from other websites. There is no access token, though, so other programs on the same machine can call it.
- **All data lives in `.rtm/`**: tasks and messages in `state.json`, uploads in `uploads/`, agent configuration in `agents.json`. The directory is not tracked by git; an `.agent-hub/` directory left by an earlier version is renamed to `.rtm/` on first start. Also, uploads are never cleaned up automatically.
- **After a restart an agent gets a summary of the earlier conversation**, not the full history.
- **It runs from the source directory only.** Packaged distribution is not supported yet.

## Development

```bash
npm run typecheck
```

`npm run verify:robustness` and `npm run verify:walkthrough` use a built-in mock agent, need no agent sign-in and finish in well under a minute; `npm run verify:mock` runs both plus the type check, and is what CI runs.

`npm run verify` and `verify:phase2-3` through `verify:phase8` are end-to-end checks. They start the real agents on this machine, which must be signed in. Run `npm run build` before `verify:phase8`.

Layout:

- `src/hub/`: the local server (session pool, agent registry, shared resources, workflows, state)
- `src/mcp/`: MCP tools offered to the agents (delegation, questions, progress, workflows)
- `src/ui/`: the interface, plain JavaScript with no build step
- `src/desktop.ts`: the desktop launch flow shared by Windows and macOS
- `scripts/`: verification and benchmark scripts

The tasks and conversations in the screenshots are demo data.

## License

[MIT](LICENSE)
