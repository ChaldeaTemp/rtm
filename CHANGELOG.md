# Changelog

## 0.1.0 — 2026-11-17

First public version.

### Tasks and agents

- One task, several agents: a lead agent delegates to sub-sessions through MCP tools.
- The lead is chosen when a task is created. It hands over from inside the conversation with a
  brief for its successor; `/lead <agent>` switches directly when the lead cannot.
- Queue a message while an agent is working, or interrupt it with guidance.
- Tasks span several directories, are grouped by project, and can be archived.
- Modern, Classic and Roundtable boards share task state, decision queues and acceptance.
- Archived tasks can be found by title or ID, viewed read-only, exported and restored.
  Interrupted tasks wait for an explicit continuation after restoration.

### Workflows

- Draft a DAG of sub-session steps (by hand or by the lead), review it, publish it.
- Acceptance gates: a second agent reviews a step and a rejection is sent back for rework.
- Resume a workflow that stopped part-way, retry failed steps, limit how many steps run at once.
- Save arrangements as templates.
- Shared task context with named sections, so background is written once.

### Staying up

- State is saved and restored across restarts.
- A supervisor restarts the hub after a crash and records the reason in `.rtm/crash.log`.
- Idle sub-sessions are put to sleep and wake with their history.
- Low-memory warning and automatic back-off (Windows).

### Resources

- Rules and skills of each agent are bridged to the others; items can be switched off for
  everyone or for one agent, and an agent is told when one of its own items is switched off.

### Interface

- Three skins in light and dark, Markdown with highlighting and diffs, Mermaid, progress and
  session panels, workflow flowchart, desktop notifications.
- One launcher for Windows and macOS.
- An empty workbench offers a fresh start instead of retaining the previous task.
- Roundtable workbench panels match the navy-and-gold operations room.
- Subscription cards show remaining allowance, reset times and data freshness. Claude
  supports model aliases, native OAuth usage and ReClaude's local account snapshot.

### Distribution and validation

- First GitHub Release, distributed as source with a SHA-256 checksum. Node.js 22+,
  dependency installation and a configured coding agent are required.
- Windows build, mock-agent regressions and desktop browser flows were verified.
- The macOS launcher has not been tested on a Mac. Native Claude / ReClaude model and
  quota integration has not been tested against live accounts; ReClaude quota is a local
  snapshot, and native Claude's OAuth usage endpoint may change.
