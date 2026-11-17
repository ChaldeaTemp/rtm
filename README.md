<div align="center">
  <img src="src/ui/icon-192.png" width="56" height="56" alt="">
  <h1>RTM · Round Table Meeting</h1>
  <p><strong>Connect your coding agents. Let them talk.</strong></p>
  <p>Bring Claude Code, Codex, OpenCode, Kimi, and other ACP-compatible agents into one local workbench. Publish tasks, follow their progress, review deliveries, and let agents delegate work and share context.</p>
  <p>
    <a href="#get-started"><strong>Get started ↓</strong></a>
    &nbsp;·&nbsp;
    <a href="#connect-and-collaborate">See it in action</a>
    &nbsp;·&nbsp;
    <a href="guide/README.en.md">User guide</a>
    &nbsp;·&nbsp;
    <a href="guide/README.md">中文指南</a>
  </p>
</div>

<p align="center">
  <img src="guide/screenshots/rtm-workbench.png" width="100%" alt="RTM workbench showing Codex, Claude, and OpenCode sessions together, with their results and task progress">
</p>

## Connect and collaborate

### One task board, three ways to see your work

Publish a brief and choose a lead. RTM queues tasks, shows decisions that need you, and keeps deliveries open until you accept them. Switch between **Modern**, the **Classic task register**, and the **Roundtable operations room** without changing task state.

<p align="center">
  <img src="guide/screenshots/board-roundtable.png" width="100%" alt="Roundtable operations room showing queued tasks, running agents, decisions and deliveries">
  <br><sub>Roundtable board · demo data</sub>
</p>

The workbench opens the same task's conversation, workflow and files. When there is no active task, a home view offers a fresh start. **Archive** is available from every board and the workbench: review history, copy a task ID, export it, or restore it to continue.

### Connect your CLI agents

Set up Claude Code, Codex, OpenCode, and other ACP-compatible agents in the same workbench. Pick which one leads new tasks.

Subscription cards show remaining allowance and reset times for supported accounts, separately from the workbench's token usage. Codex and Kimi use their CLI services; native Claude uses OAuth usage, while ReClaude displays the selected account's local usage snapshot with its timestamp. Claude also offers model aliases when the detected list is incomplete. See [account and model setup](guide/README.en.md#models-and-ai-subscriptions) for configuration and limitations.

<p align="center">
  <img src="guide/screenshots/agent-connections.png" width="100%" alt="Agent settings with Claude, Codex, and OpenCode enabled and Codex selected as the default lead">
  <br><sub>Settings → Agent</sub>
</p>

### Let agents talk to each other

An agent can ask another agent a question or delegate work and get its answer back in the same task.

<p align="center">
  <img src="guide/screenshots/agent-communication.png" width="100%" alt="A Claude sub-session showing a question delegated by Codex and Claude’s reply">
  <br><sub>Chat → Sub-session</sub>
</p>

## Give them a shared workspace

### Share the task context

Record the brief and decisions once. Agents can reference the sections they need and pick up earlier results.

<p align="center">
  <img src="guide/screenshots/shared-context.png" width="100%" alt="Shared context editor showing a named CSV formatting section referenced by a workflow step">
  <br><sub>Workflow → Shared context</sub>
</p>

### See the workflow

See who owns each step, what can run in parallel, and what is waiting on a dependency.

<p align="center">
  <img src="guide/screenshots/visual-workflows.png" width="100%" alt="Visual workflow with Codex, OpenCode, and Claude steps branching in parallel and rejoining for integration tests">
  <br><sub>Workflow → Canvas</sub>
</p>

### Manage shared skills in one place

See which skills each agent loads natively or gets through RTM. Enable or disable shared skills for individual agents from the same panel.

<p align="center">
  <img src="guide/screenshots/shared-skills.png" width="100%" alt="Shared skills panel showing project skills and their per-agent native, injected, and disabled settings">
  <br><sub>Settings → Resources → Shared skills</sub>
</p>

<sub>Screenshots use demo data.</sub>

## Get started

You'll need Node.js 22+ and at least one configured agent. Connect two to try agent-to-agent communication. RTM runs locally from source and connects to agents through the Agent Client Protocol (ACP).

```bash
git clone https://github.com/ChaldeaTemp/rtm.git
cd rtm
npm ci
npm run desktop
```

For setup and platform details, see the [user guide](guide/README.en.md).

[Changelog](CHANGELOG.md) · [MIT License](LICENSE)
