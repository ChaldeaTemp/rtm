# 自定义插件设想与范围边界

> 当前状态：设计设想记录，暂未动手实现。
> 本文整理自定义插件的目录形式、能力范围与现有模块的衔接方式，后续改动后端时再分步落地。

## 一、核心思路：复用四类现有原语的目录包

不单造新的执行引擎或前端框架，而是把同一业务场景或团队规范下配套的规则、技能、工具和编排打包成「目录 + `plugin.json` 清单」。

插件包本身不写运行代码，只声明四类内容并直接交给现有的四个模块消化：

1. **共享规则（`rules/*.md`）**：由 `src/hub/resources.ts` 的 `SharedResourceManager` 扫描，经 `buildInjectionForAgent` 拼入首轮提示词或 `systemPrompt`。
2. **技能指南（`skills/*/SKILL.md`）**：连同同级 `scripts/`、`references/`，由现有技能发现逻辑扫描，只把名称、路径和摘要注入会话，按需读取细节，不塞满上下文。
3. **MCP 工具服务（`mcp.json`）**：由 `src/hub/acp-pool.ts` 在 `startSession` 里调用 `conn.agent.buildSession(...)` 与 `builder.withMcpServer(...)` 随会话拉起（与内置 `agent-hub-peers` 同机制）。
4. **只读工作流模板（`workflows/*.json`）**：复用 `src/hub/workflow-templates.ts` 中的 `WorkflowTemplate` / `WorkflowStepInput` 结构，合入工作流面板的模板下拉框，可直接载入成草稿但不会被界面修改覆盖。

## 二、目录结构与 `plugin.json` 清单草案

### 1. 标准目录树

```text
<plugin-root>/<plugin-id>/
├── plugin.json                 # 插件清单（必需）
├── rules/                      # 共享规则（可选）
│   └── api-conventions.md
├── skills/                     # 技能说明与辅助脚本/资料（可选）
│   └── db-migration/
│       ├── SKILL.md
│       ├── scripts/
│       └── references/
├── mcp.json                    # MCP 服务启动配置（可选）
└── workflows/                  # 预设工作流模板（可选，只读）
    └── feature-review.json
```

### 2. `plugin.json` 清单字段

```json
{
  "id": "backend-standards",
  "name": "后端研发规范包",
  "version": "0.1.0",
  "description": "包含接口规范规则、数据库迁移技能、代码审查工作流模板与文档查询 MCP。",
  "defaultScope": "project",
  "agents": ["claude", "codex", "kimi", "opencode", "agy"],
  "sessionRoles": ["lead"],
  "components": {
    "rulesDir": "rules",
    "skillsDir": "skills",
    "mcpFile": "mcp.json",
    "workflowsDir": "workflows"
  },
  "envRequired": [
    {
      "name": "INTERNAL_DOCS_TOKEN",
      "description": "用于鉴权内部文档查询 MCP 服务",
      "hint": "请在系统环境变量或 ~/.rtm/plugin-secrets.json 中配置"
    }
  ]
}
```

字段说明：
- `id`、`name`、`version`、`description`：唯一标识与界面展示信息。
- `defaultScope`：建议生效层级（`global` 或 `project`）。
- `agents`：默认对该插件生效的 Agent 列表；用户后续可在界面按 Agent 覆盖开关。
- `sessionRoles`：定义插件里 `mcp.json` 默认注入的会话角色，推荐默认 `["lead"]`（原因见第三节）。
- `components`：各能力子目录或清单路径，缺省时按约定目录扫描，不需要的组件可以省略。
- `envRequired`：**只写环境变量名与缺失说明，不写实际密钥**。密钥从系统环境变量或本地 `~/.rtm/plugin-secrets.json` 读取，避免随插件包泄漏进 Git。

## 三、三层范围边界（核心约束）

为了避免安全隐患、事件循环卡顿、跨项目污染和上下文/内存爆炸，明确划定以下三层边界。

### 1. 能力边界：先包什么，暂不包什么

| 类别 | 是否纳入 | 说明 |
|---|---|---|
| 规则、`SKILL.md`、MCP 服务、工作流模板 | 纳入 | 都是纯声明文件或独立 MCP 子进程，子进程崩溃不影响 Hub 主进程 |
| 任意前端 JS 插件 | 暂不开放 | 不直接向工作台注入外部脚本；需要交互界面的输出继续走现有的沙箱 HTML 交互组件（`interactive.js`） |
| Hub 进程内生命周期 Hook 脚本 | 暂不开放 | 不同步执行外部 JS/Shell Hook，防止阻塞 Node 事件循环或干扰多项目隔离；流程约束优先放进规则或封装为 MCP 工具 |

### 2. 来源与可见范围

按扫描优先级列出四类来源：

1. **全局插件（`~/.rtm/plugins/<plugin-id>/`）**：对本机所有工作区可见，适合通用规范、个人常用 MCP（如笔记、通用检索）。
2. **项目级插件（`<cwd>/.rtm/plugins/<plugin-id>/`）**：仅在当前工作区打开时可见，可随项目 Git 仓库提交，沉淀团队专属的研发规范、检查脚本与预设工作流。
   - **项目级安全门槛**：首次在某工作区扫描到携带 `mcp.json`（会启动外部可执行命令）的项目级插件时，默认设为「未信任/停用」；必须在设置界面经用户显式点击启用并确认来源后，Hub 才允许拉起其 MCP 子进程。
3. **本地开发挂载（`~/.rtm/plugin-links.json` 记录外部路径）**：方便开发者直接把工作中的目录挂进 Hub 调试，不用每次复制文件。
4. **已有目录只读兼容**：继续兼容 `SharedResourceManager.collectPluginDirs` 目前扫描的 `~/.gemini/config/plugins/`（如 `core-habits`），若目录里已带有规则或技能可直接识别，不改动原有外部目录。

### 3. 生效粒度：工作区 × Agent × 会话角色

1. **工作区级**：全局插件可以在 `~/.rtm` 设默认开关，同时允许在单项目里独立覆写（例如某项目不需要全局前端规范包）。
2. **Agent 级**：沿用设置 → 资源页现有的按 Agent 开关（`claude`、`codex`、`kimi`、`opencode`、`agy`），同一插件可只对擅长代码审查的 Agent 开启，或在某 Agent 上下文吃紧时单独关闭。
3. **会话角色级（防止工作流并发拉爆进程和上下文）**：
   - `rules` 与 `skills` 摘要：可同时注入主导会话（`lead`）和子会话（`sub`），也可在插件里标明只给主导看，减少子会话前缀 token 消耗。
   - `mcpServers`：**默认仅挂载到主导会话（`lead`）**。工作流开启 6~10 个并行子会话时，每个子会话都是独立 CLI 进程；如果默认把重型 MCP 全部挂载给每个 `sub`，一次发布可能拉起数十个冗余子进程。子会话只有在该插件显式声明 `sessionRoles` 含 `"sub"` 或工作流步骤手动勾选所需插件时才挂载对应 MCP。

## 四、与现有模块的衔接落点

后续真正动手实现时，主要串联四个位置：

1. **`src/hub/resources.ts`（`SharedResourceManager`）**
   - 扩充插件目录扫描（`~/.rtm/plugins`、`<cwd>/.rtm/plugins`、本地挂载清单及只读兼容目录），解析 `plugin.json`。
   - 返回插件聚合元信息、包含的子资源列表与 `envRequired` 缺失检查结果。
   - 提供插件整包启停、项目信任标记与按 Agent 覆写配置的读写。
2. **`src/hub/acp-pool.ts`（`startSession` 与 `buildSystemInjection`）**
   - 创建会话时结合当前 `cwd`、`agent` 与角色（`lead` / `sub`），过滤出启用的插件，把通过环境检查的 MCP 服务追加到 `builder.withMcpServer(...)`（同时做重名检查，避免和内置 `agent-hub-peers` 或同名服务冲突）。
   - 若插件缺失必要环境变量，不强行启动损坏的 MCP，而是在会话元数据或界面状态里给出明确缺参提示。
3. **`src/hub/workflow-templates.ts`（`WorkflowTemplateStore`）**
   - 合并返回已启用插件 `workflows/*.json` 中的预设编排模板，标记来源插件名与只读状态；工作流面板从 `/api/workflows/templates` 拉取时即可直接选用。
4. **`src/ui/panels.js`（`renderResourcesPanel`）**
   - 在设置 → 资源页里增加「插件包」分组（或过滤标签）：一卡对应一个插件，直接显示版本、来源位置（全局 / 项目）、内含项数（X 规则 / Y 技能 / Z MCP / W 模板）、缺失环境变量警告以及整包与按 Agent 开关。

## 五、建议的后续实施顺序

等到确认要开工时，按三小步推进最稳妥，每一步都能独立验证：

1. **第一步（纯内容型插件包，风险最低）**：支持扫描 `plugin.json` + `rules/` + `skills/` + `workflows/`，只接入规则、技能和只读工作流模板，并在设置 → 资源页展示与开关控制。
2. **第二步（接入受控 `mcp.json`）**：增加 `mcp.json` 解析、`envRequired` 检测、`lead` / `sub` 角色挂载限制与会话日志状态展示。
3. **第三步（安全确认与开发挂载）**：补上项目级含 MCP 插件的首次信任确认弹窗，以及外部本地插件目录一键挂载/卸载与重载缓存按钮。
