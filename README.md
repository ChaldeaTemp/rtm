<div align="center">
  <img src="src/ui/icon-192.png" width="56" height="56" alt="">
  <h1>RTM · Round Table Meeting</h1>
  <p><strong>Give your coding agents a shared task.</strong></p>
  <p>When code, tests, and review happen in separate chats, you carry the context between them. RTM brings Claude Code, Codex, and other CLI agents into one local workbench.</p>
  <p>
    <a href="#get-started"><strong>Get started ↓</strong></a>
    &nbsp;·&nbsp;
    <a href="guide/README.en.md">User guide</a>
    &nbsp;·&nbsp;
    <a href="guide/README.md">中文指南</a>
  </p>
</div>

![RTM in its Roundtable theme, showing a CSV export task with Codex leading, two agents' results, and a pending integration review](guide/screenshots/rtm-workbench.png)

## One task, from brief to review

> Add CSV export to the reports page. Keep the active filters and check empty results, commas, quotes, and line breaks.

Give Codex the brief. It delegates the export UI to OpenCode and the edge-case tests to Claude Code. Both results show up in the original task. The integration review waits for both and gets the same export rules.

[See the review step in action ↗](guide/screenshots/workflow-review.gif)

## Get started

You'll need Node.js 22+ and at least one configured agent. Use two to try delegation. The workbench runs locally from source and connects to your CLI agents through the Agent Client Protocol (ACP).

```bash
git clone https://github.com/ChaldeaTemp/rtm.git
cd rtm
npm ci
npm run desktop
```

For setup and platform details, see the [user guide](guide/README.en.md).

[Changelog](CHANGELOG.md) · [MIT License](LICENSE)
