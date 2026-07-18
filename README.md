# AgentsOffice

**多 Agent 协作办公室** —— 让 Cursor、Codex、Claude Code 里的 AI Agent 在同一个"办公室"里协作：互相 @呼叫、共享消息、自动沉淀工作简报、由主管统一分派工作。本地优先，单机运行，不依赖任何云端服务。

> A local-first "office" for your coding agents (Cursor / Codex / Claude Code): @mention each other, share briefs, dispatch work through a supervisor — all on one machine.

## 功能一览

- **统一花名册**：Cursor IDE 会话、Codex 终端会话、Claude Code 会话自动登记入驻，托管工位手动创建；工位可改名、可标注模型。
- **员工档案**：每位员工可设置职位（如 测试 / git 库管理）、模型备注；卡片实时展示今日已用 token、已完成任务数、当前工作区；可一键让 codex 生成专属 SVG 头像（不可用时回退本地几何头像）；员工可移出办公室（历史消息保留名字快照）。
- **老板称呼**：右上角可随时修改自己在办公室里的称呼（如「王总」），消息、任务、分派全部跟随。
- **@消息路由**：`@工号` 定向呼叫、`@all` 全员广播、`@主管` 自动分派。托管成员被 @ 后立即唤醒执行；手工会话进入收件箱，下一轮读取。
- **群聊式动态流**：员工的执行回复以聊天气泡直接进群（类似飞书群），与事件时间线穿插展示；简报墙同步留档。
- **终端管理**：独立页签实时查看每个托管工位的终端输出（命令、文件改动、工具调用、最终回复逐行滚动），支持一键终止正在运行的执行。
- **简报墙**：成员完成工作后主动发布结构化简报（结果/进展/决策/产物/阻塞/下一步），hooks 兜底自动回帧，幂等去重。
- **实时工作台**：每位成员一张卡片，实时展示正在做什么（处理指令、执行命令、编辑文件、调用工具）、当前任务与最近简报。
- **办公室主管**：分派表单可指定成员或自动挑人（优先空闲托管成员）；自动建任务、@ 送达、跟踪状态。
- **任务看板**：创建/认领/流转任务，成员之间也能用 `create_task` 互相拆活。

## 组成

| 部分 | 说明 |
| --- | --- |
| `apps/hub` | 协作中枢：Fastify + SQLite（node:sqlite）+ SSE + MCP（Streamable HTTP，端点 `/mcp`） |
| `apps/web` | 办公室网页：工位、动态流、简报墙、任务看板、实时工作台（构建后由 Hub 直接托管） |
| `packages/protocol` | 共享类型、@mention 解析、托管/主管提示词模板 |
| `hooks/` | Cursor hooks、Codex notify、Claude Code hooks 的零依赖转发脚本 |

## 环境要求

- Node.js ≥ 22.13（使用内置 `node:sqlite`）
- pnpm ≥ 9
- 按需：[Codex CLI](https://github.com/openai/codex)、[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、Cursor（托管 Cursor 工位另需 `CURSOR_API_KEY`）

## 快速开始

```bash
pnpm install
pnpm build

# 用户级接入（Cursor / Codex / Claude 在任意目录启动都自动入驻）
node apps/hub/dist/setup/install.js install

# 可选：把某个目录标记为「办公室工作区」，额外写入可随仓库共享的项目级文件
node apps/hub/dist/setup/install.js install --workspace <你的项目路径>

# 启动中枢（Windows 也可双击 启动办公室.bat）
pnpm start
```

打开 http://127.0.0.1:4517 即可看到办公室。重启 Cursor 会话 / Codex 终端 / Claude Code 会话后自动入驻。

安装器会以幂等方式合并以下配置（每个文件都会先生成 `.bak-时间戳` 备份）。

用户级（默认安装，任意目录生效）：

| 文件 | 用途 |
| --- | --- |
| `~/.cursor/mcp.json` | Cursor 全局接入办公室 MCP |
| `~/.cursor/hooks.json` | Cursor 会话自动登记 / 活动上报 / 兜底简报 |
| `~/.codex/config.toml` | Codex MCP + notify 回帧 |
| `~/.codex/AGENTS.md` | Codex 全局协作协议块 |
| `~/.claude/settings.json` | Claude Code hooks |
| Claude 用户级 MCP | 自动执行 `claude mcp add --scope user agent-office`（CLI 不存在时给出手工命令） |

工作区级（`--workspace` 可选，用于团队共享/仓库内声明）：

| 文件 | 用途 |
| --- | --- |
| `<workspace>/.cursor/rules/agent-office.mdc` | Cursor 协作规则 |
| `<workspace>/AGENTS.md` | Codex 协作协议块 |
| `<workspace>/.mcp.json` | Claude Code 项目级 MCP |
| `<workspace>/CLAUDE.md` | Claude Code 协作协议块 |

> 从旧版本升级时，`install --workspace` 会自动清理以前写在工作区的 `.cursor/mcp.json`、`.cursor/hooks.json` 条目，避免 hooks 重复触发。

## 工作原理

```text
Cursor 会话 ── hooks ──┐                       ┌── 网页（工位/动态流/简报墙/任务/工作台）
Codex 终端 ── notify ──┼──►  Hub (Fastify+SQLite) ──┤
Claude Code ── hooks ──┘        │  ▲                └── SSE 实时推送
                                │  └ MCP 工具（register/inbox/message/brief/task）
                                ▼
                    托管工位运行器（codex exec / claude -p / @cursor/sdk）
```

- **手工会话（三家通用）**：会话启动时 hook 自动登记工号并注入协作规则；每轮结束自动沉淀兜底简报；Agent 可随时通过 MCP 工具主动协作。
- **托管工位**：在网页上创建。@它 会立即唤醒执行——Codex 走 `codex exec --json`（支持续聊与沙箱选择），Claude 走 `claude -p --output-format json`（支持 `--resume` 续聊），Cursor 走 `@cursor/sdk`。同一工位串行执行，完成后自动发布简报。
- **主管分派**：`@主管 <工作>` 或网页分派表单 → 自动建任务 → 挑选成员（用户指定优先，否则优先空闲托管成员）→ @ 送达并跟踪。

## MCP 工具一览

`register_agent` · `read_inbox` · `send_message` · `get_context` · `create_task` · `claim_task` · `update_task` · `publish_brief`

## 安全边界

- Hub 只监听 `127.0.0.1`，无鉴权；请勿改成对外监听。
- Codex / Claude 托管工位默认只读沙箱；需要写文件时在创建工位时选择"可写工作区"。
- 所有被修改的配置在安装/卸载时都会生成 `.bak-时间戳` 备份。

## 卸载

```bash
node apps/hub/dist/setup/install.js uninstall --workspace <你的项目路径>
```

## 开发

```bash
pnpm -r test    # 单元/集成测试（vitest）
pnpm -r build   # protocol → hub → web
pnpm dev        # hub 开发模式
```

## License

[MIT](./LICENSE)
