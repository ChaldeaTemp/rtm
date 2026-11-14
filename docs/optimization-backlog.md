# 性能与 CLI 集成优化清单

> 记录时间：2026-11-13。代码基线：`d77fa8c` 加上当时工作区里还没提交的改动（图片附件、elicitation 桥接、opencode 关闭原生 `question` 工具等）。
> 下文的行号都对应这个基线，代码改动后需要重新定位。

## 一、诊断结论

### 1. 实测数据

测量方式：起一个私有 hub，发极短提示词「只回复两个字：好的」。复测脚本：`npx tsx scripts/bench-turn-latency.ts claude,codex 3`。

| 场景 | claude | codex |
|---|---|---|
| 新任务第 1 条消息：会话启动（进程 + initialize + session/new） | 2.3–2.6 s | 3.0 s |
| 新任务第 1 条消息：启动完成后到首个字 | 4.1–4.2 s | 5.9 s |
| **新任务第 1 条消息合计** | **6.6 s** | **9.2 s** |
| 同一任务第 2 条及以后 | 1.2–1.6 s | 1.9 s |

只做握手探测的耗时：claude 6.3 s，codex 4.2 s，agy 2.9 s，opencode 2.2 s，kimi 2.0 s。

### 2. 原因分析

- **会话热起来以后，hub 自身开销可以忽略**，慢主要集中在每个任务和每个子会话的第一条消息：
  - 会话要等收到消息才开始启动；
  - 第一轮在用户消息前拼了约 2.5k token 的共享规则和工作台说明，prompt cache 又是冷的。
- **`peer_dispatch` 每新开一个子会话，都要再付一遍上面这笔冷启动成本。**
- **健康检查会同步阻塞事件循环**：`checkAdaptersHealth` 里用了 `spawnSync`，比如 `cmdkey /list`、`reclaude status`（最长等 4 s）。
  - 本机实测每次阻塞约 100 ms。
  - 调用的地方很多：每次 WebSocket 快照（连接或重连时）、`/api/health`（一次请求调两遍，peer MCP 也会调）、`/api/agents`、`broadcastAgentsUpdated`。
  - 阻塞期间流式输出和所有接口请求都会卡住。
- **共享资源每次都全量扫盘**：`getAgentBudgets` 实测约 51 ms/次，没有缓存，快照和多个接口都会调用。

### 3. 被丢掉的 CLI 原生能力

适配器版本：claude-agent-acp 0.106、codex-acp 2.6。

| 原生能力 | 现状 |
|---|---|
| 工具调用的 `content`（diff、命令输出、文本结果）、`locations`、`rawOutput` | 被丢弃，界面上只剩标题和状态 |
| 文字与工具调用的先后顺序 | 丢失：`text` 是整段拼接，`toolCalls` 单独成一个列表 |
| `plan`（TodoWrite、codex 计划） | 被忽略；客户端也没声明 `plan` 能力 |
| `available_commands_update`（斜杠命令） | 被忽略；第一轮拼了前缀，导致第一条消息里的 `/xxx` 失效 |
| `current_mode_update`、会话模式 | 被忽略；只有 hub 自己的三档权限策略 |
| claude 的原生提问（ACP elicitation） | hub 已接好界面，但工作台说明里禁止 Agent 使用原生提问 |
| `session/new` 的 `systemPrompt` | 没用上，规则塞在第一条用户消息里 |
| `session/list`、`resume` | 没用上，hub 重启后所有会话丢失 |

## 二、待办项

每一项都写了：做法、涉及位置、验证方式、预估工作量、依赖。建议按 A1 → A5 → A2 → B1 的顺序先做。

### A. 速度

#### A1 会话预热（收益最大）

- **做法**
  - 在 `AcpPool` 上暴露 `warmSession(options)`，内部复用 `ensureSession`。
  - 新增接口 `POST /api/sessions/warm { groupId }`，按任务的主导 Agent、模型、cwd 提前启动 `${groupId}__lead` 会话。
  - 前端在三个时机调用：新建任务、`selectGroup` 切到一个还没有会话的任务、输入框第一次 `input`。每个任务只调一次，结果不用等。
  - 可选：hub 启动后预热默认任务；`peer_dispatch` 时按 `targetAgent` 维护一个备用进程（需要评估内存占用）。
- **注意**
  - 预热出来的会话如果一直没用，不要无限堆积。可以设置空闲 N 分钟后关闭，或者给每个 Agent 设一个上限。
  - 切换主导 Agent 时，旧会话按现有逻辑处理即可。
- **涉及位置**：`src/hub/acp-pool.ts` 中 `ensureSession`（约 472 行）；`src/hub/server.ts` 的路由区；`src/ui/app.js` 中 `selectGroup`（约 554 行）、输入框 `input` 监听（约 2585 行）、`createTaskGroup`。
- **验证**：用 bench 脚本，先调 warm、等 3 s 再发消息，第一条消息的 total 应从约 6.6 s 降到约 4 s 以内。
- **预估工作量**：小到中。

#### A2 规则和工作台说明改走 `systemPrompt`

- **做法**
  - `initialize` 返回的 `agentCapabilities.sessionCapabilities.systemPrompt` 存在时，在 session/new 里传 `systemPrompt: { mode: "append", content: [{ type: "text", text }] }`。
  - 文本内容为 `buildHubWorkbenchGuide(role)` 加上 `buildInjectionForAgent().promptPrefix`。
  - 适配器不支持时，退回现在 `runTurn` 里的首轮前缀逻辑（约 832–855 行）。
  - 遥测里 `sharedRulesTokens` 等统计口径保持不变，额外记录本次走的是「system」还是「prefix」。
- **涉及位置**：`acp-pool.ts` 中 `createSession` 的 `buildSession`（约 627–644 行）和 `runTurn` 的注入段。需要确认 SDK 的 `buildSession` 能不能带 `systemPrompt`，不能就直接发 `session/new` 请求。
- **验证**：
  1. claude 第一轮的首字耗时下降；
  2. 第一条消息直接发 `/compact` 等斜杠命令能生效；
  3. 遥测页注入统计仍然正确。
- **预估工作量**：中。
- **依赖**：无。和 B3（斜杠命令）配合效果最好。

#### A3 共享资源扫描加缓存

- **做法**：`discoverInternal(cwd)` 的结果按 cwd 缓存。可以用几秒的过期时间，也可以按扫描目录的 mtime 失效。启用、停用、保存、删除、同步规则时主动清掉缓存。`getAgentBudgets` 只扫一次，复用给 5 个 Agent。
- **涉及位置**：`src/hub/resources.ts` 中 `discoverInternal`（约 470 行）、`getAgentBudgets`（约 632 行）。
- **验证**：`getAgentBudgets` 从约 51 ms 降到 5 ms 以下；资源页的启停操作立即生效。
- **预估工作量**：小。

#### A4 前端渲染合批

- **做法**
  - `tool_event` 改用 `scheduleStreamingMessageDom` 合批，不再每个事件都同步重建消息节点。
  - `session_updated`、`task_updated` 触发的侧栏、头部、右侧面板重绘也按帧合批。
  - `renderMessages` 和 `updateStreamingMessageDom` 重建消息时，复用已有的交互组件 iframe 节点，不再重新加载。
- **涉及位置**：`src/ui/app.js` 中 WebSocket 处理（约 2334–2388 行）、`buildArtifactCardElement`（约 1405 行）、`renderMessages`（约 1709 行）。
- **验证**：在长对话里连续触发工具调用，Performance 面板里单帧脚本耗时明显下降；交互组件不再闪烁、不再重复加载。
- **预估工作量**：小到中。

#### A5 健康检查改成异步并加缓存（新发现，建议优先）

- **做法**
  - `checkAgentAuthReady` 里的 `spawnSync` 改成异步的 `execFile`。
  - 结果在 registry 里缓存 30–60 s；快照、`/api/health`、`/api/agents` 直接读缓存，后台刷新。
  - `/api/health` 只算一次，不要调两遍 `getHealthList`。
- **涉及位置**：`src/hub/process-tree.ts` 中 `checkAgentAuthReady`（约 371 行）、`checkAdaptersHealth`（约 559 行）；`agent-registry.ts` 中 `getHealthList`（约 260 行）；`server.ts` 中 `createSnapshot`（约 1280 行）、`/api/health`（约 2255 行）、`/api/agents`（约 2591 行）。`src/index.ts status` 命令可以继续用同步版本。
- **验证**：快照生成耗时小于 10 ms；流式输出过程中刷新页面或打开 Agent 页，输出不会顿一下。
- **预估工作量**：小。

### B. 保留 CLI 原生能力

#### B1 工具调用卡片（按时间顺序，能看到 diff 和输出）

- **做法**
  - 后端：`tool_call` 和 `tool_call_update` 透传 `content`、`locations`、`rawOutput`；`SessionToolCall` 补充这几个字段。`content` 里的大段文本要截断，比如单条最多 20 KB，并保留「已截断」标记。
  - 消息模型：增加一个按时间排列的 `parts` 列表，元素是 `{ type: "text" | "tool" | "thought", ... }`。`text` 和 `toolCalls` 保留，用于兼容和导出。
  - 前端：按 `parts` 顺序渲染。工具卡片默认折叠，展开后显示 diff（按行着色）、终端输出、文件位置。
- **涉及位置**：`acp-pool.ts` 的 `tool_call` 分支（约 942–972 行）；`server.ts` 中 `activeAssistantBySession` 的 `tool_event` 合并逻辑（约 505–529 行）；`types.ts` 中 `SessionToolCall` 和 `ChatMessageRecord`；`app.js` 中 `buildMessageElement`（约 1511 行）、`tool_event` 处理。
- **验证**：让 claude 和 codex 各编辑一个文件、跑一条命令，界面上能按顺序看到「文字 → 编辑卡片（含 diff）→ 命令卡片（含输出）→ 文字」。
- **预估工作量**：中到大。

#### B2 任务清单（plan）

- **做法**：`initialize` 时声明 `clientCapabilities.plan`；处理 `sessionUpdate === "plan"`，把计划条目挂到当前助手消息或会话上；前端渲染成清单，标出进行中和已完成。
- **涉及位置**：`acp-pool.ts` 中 `initialize`（约 621 行）和更新循环；`types.ts`；`app.js`。
- **验证**：claude 用 TodoWrite、codex 生成计划时，清单能实时更新。
- **预估工作量**：小到中。

#### B3 斜杠命令补全

- **做法**：处理 `available_commands_update`，按会话缓存命令列表并推送给前端；输入框以 `/` 开头时弹出补全，支持上下键和回车选择。
- **涉及位置**：`acp-pool.ts` 的更新循环；`server.ts` 的事件转发；`app.js` 的输入框逻辑。
- **验证**：输入 `/` 能看到 `/compact` 和用户自定义命令，选中后发送能正常执行。第一轮的执行依赖 A2。
- **预估工作量**：小到中。

#### B4 原生会话模式切换

- **做法**：读取 session/new 返回的 `modes`，处理 `current_mode_update`；在头部展示模式下拉框，切换时调用 `session/set_mode`。和 hub 的三档权限策略并存：模式由 Agent 自己控制，hub 的策略只负责审批弹窗。
- **涉及位置**：`acp-pool.ts` 的 `createSession` 和更新循环；`server.ts` 新增 `/api/sessions/mode`；`app.js` 头部控件。
- **验证**：claude 切到计划模式后只出计划、不改文件；切到自动接受编辑后不再弹编辑审批。
- **预估工作量**：中。

#### B5 工作台说明按 Agent 能力区分

- **做法**：`buildHubWorkbenchGuide` 增加参数，说明当前 Agent 是否支持 elicitation。支持的（claude）允许使用原生提问，`hub_ask_user` 作为备选；不支持的继续强制使用 `hub_ask_user`。opencode 关闭 `question` 工具的配置保持不变。
- **涉及位置**：`src/hub/resources.ts` 中 `buildHubWorkbenchGuide`（约 35 行）；`acp-pool.ts` 调用处，根据 `initializeCapabilities` 判断。
- **验证**：claude 使用原生 AskUserQuestion 时，界面能正常弹出选项卡并回传答案。
- **预估工作量**：小。

#### B6 会话恢复（工作量最大，建议单独做一轮）

- **做法**：持久化任务、消息和会话映射（`acpSessionId`、agent、cwd）；hub 启动后懒恢复，第一次发消息时调用 `session/resume` 或 `session/load`；另外可以提供「导入 CLI 历史会话」入口，通过 `session/list` 列出。
- **依赖**：最好在 B1 之后做，因为消息模型会变。
- **验证**：重启 hub 后，原任务能继续对话，并且模型记得之前的上下文。
- **预估工作量**：大。
