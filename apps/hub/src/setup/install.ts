import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IntegrationClient } from "@agent-office/protocol";
import { DEFAULT_PORT, loadConfig } from "../config.js";
import {
  mergeClaudeMcpJson,
  mergeClaudeSettings,
  mergeCodexToml,
  getCodexNotifyCommand,
  mergeHooksJson,
  mergeKimiToml,
  mergeMcpJson,
  mergeOpencodeConfig,
  mergeQoderConfig,
  mergeWorkbuddyMcpJson,
  mergeZcodeConfig,
  removeFromClaudeSettings,
  removeFromCodexToml,
  removeFromHooksJson,
  removeFromKimiToml,
  removeFromMcpJson,
  removeFromOpencodeConfig,
  removeFromQoderConfig,
  removeFromZcodeConfig,
  removeMarkerBlock,
  upsertMarkerBlock,
} from "./merge.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/setup → agent-office 根目录
const OFFICE_ROOT = resolve(HERE, "../../../..");
const MANAGED_HOOK_FILES = [
  "cursor-hook.mjs",
  "codex-notify.mjs",
  "claude-hook.mjs",
  "zcode-hook.mjs",
  "opencode-plugin.mjs",
  "kimi-hook.mjs",
  "qoder-hook.mjs",
] as const;

export function resolveHooksSourceDir(env: NodeJS.ProcessEnv = process.env): string {
  const bundledHooksDir = env.AGENT_OFFICE_HOOKS_DIR?.trim();
  return bundledHooksDir ? resolve(bundledHooksDir) : join(OFFICE_ROOT, "hooks");
}

/**
 * stdio MCP 代理入口（SDK 标准转发器）。桌面端经 AGENT_OFFICE_STDIO_ENTRY
 * 指向打包产物；源码/命令行模式用 hub 编译产物 dist/mcp/stdio.js。
 */
export function resolveStdioEntry(env: NodeJS.ProcessEnv = process.env): string {
  const bundledEntry = env.AGENT_OFFICE_STDIO_ENTRY?.trim();
  return bundledEntry ? resolve(bundledEntry) : join(OFFICE_ROOT, "apps", "hub", "dist", "mcp", "stdio.js");
}

export function resolveHookNode(
  env: NodeJS.ProcessEnv = process.env,
  execPath = process.execPath,
  isElectron = "electron" in process.versions,
): string {
  const configuredNode = env.AGENT_OFFICE_HOOK_NODE?.trim();
  if (configuredNode) return resolve(configuredNode);
  if (!isElectron) return execPath;
  throw new Error("未检测到系统 Node.js，无法安装 Agent Office Hooks");
}

export interface HookCommands {
  cursor: string;
  codexNotify: string[];
  claude: string;
  /** ZCode process 型 hook（command+args 免 shell） */
  zcode: { command: string; args: string[] };
  /** WorkBuddy stdio MCP 代理启动命令（SDK 标准转发到 Hub /mcp） */
  workbuddyBridge: { command: string; args: string[] };
  /** Kimi hooks 命令（config.toml [[hooks]].command，shell 字符串） */
  kimi: string;
  /** Qoder hooks 命令（settings.json hooks 条目 command，shell 字符串） */
  qoder: string;
}

export function buildHookCommands(
  node: string,
  hooksDir: string,
  baseUrl: string,
  stdioEntry = resolveStdioEntry(),
): HookCommands {
  return {
    cursor: `"${node}" "${join(hooksDir, "cursor-hook.mjs")}" "${baseUrl}"`,
    codexNotify: [node, join(hooksDir, "codex-notify.mjs"), baseUrl],
    claude: `"${node}" "${join(hooksDir, "claude-hook.mjs")}" "${baseUrl}"`,
    zcode: { command: node, args: [join(hooksDir, "zcode-hook.mjs"), baseUrl] },
    workbuddyBridge: {
      command: node,
      args: [stdioEntry, baseUrl],
    },
    kimi: `"${node}" "${join(hooksDir, "kimi-hook.mjs")}" "${baseUrl}"`,
    qoder: `"${node}" "${join(hooksDir, "qoder-hook.mjs")}" "${baseUrl}"`,
  };
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(/[-:T]/g, "").slice(0, 14);
}

function backup(path: string): string | null {
  if (!existsSync(path)) return null;
  const backupPath = `${path}.bak-${timestamp()}`;
  copyFileSync(path, backupPath);
  return backupPath;
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

const RULE_CONTENT = `---
alwaysApply: true
---

# Agent Office 协作规则

本机运行着多 Agent 协作办公室（MCP 服务名 \`agent-office\`，网页 http://127.0.0.1:${DEFAULT_PORT}）。

1. 会话开始处理任务前，先调用 \`register_agent\` 登记（沿用系统注入的工号；若无则自拟简短工号；\`model\` 参数填你当前实际使用的 AI 模型名）。
2. 开始新一轮工作前调用 \`read_inbox\` 查看是否有 @你 的消息，优先响应同事的协作请求；中途切换了模型就在 \`read_inbox\` 时带 \`model\` 参数更新。
3. 完成阶段性工作后调用 \`publish_brief\` 发布结构化简报（结果/进展/决策/产物/阻塞/下一步）。
4. 需要其他成员协助时用 \`send_message\` 并 @对方工号；\`get_context\` 可获取办公室全景上下文（花名册/任务/简报/知识库目录）。
5. 认领任务用 \`claim_task\`，状态变化及时 \`update_task\`。
6. 只完成任务一个阶段、需要同事接手时调用 \`handoff_task\`，保存产物/决策/下一步并自动唤醒接班员工；不要只在最终回复里写 @工号。
7. 遇到疑难问题先 \`kb_search\` / \`kb_list\` 查公共知识库；解决了值得沉淀的问题用 \`kb_write\` 记录（分类/标题/根因/解决步骤）。\`read_logs\` 可查看办公室实时日志。
`;

const AGENTS_MD_BLOCK = `## Agent Office 协作协议（Codex）

本机运行着多 Agent 协作办公室（MCP 服务名 \`agent_office\`，网页 http://127.0.0.1:${DEFAULT_PORT}）。

- 会话开始处理任务前，调用 \`register_agent\` 登记（kind 填 \`codex-cli\`，工号自拟且保持稳定，如 \`codex-主力\`；\`model\` 填你当前使用的模型名）。
- 每轮开始前调用 \`read_inbox\` 查看 @你 的消息；完成阶段性工作后调用 \`publish_brief\` 发布简报。
- 需要其他成员（含 Cursor 中的 Agent）协助时，用 \`send_message\` 并 @对方工号；\`get_context\` 可获取办公室全景上下文（花名册/任务/简报/知识库目录）。
- 阶段任务需要接力时调用 \`handoff_task\` 保存交接材料并自动唤醒接班员工；不要只在最终回复里写 @工号。
- 遇到疑难问题先 \`kb_search\` 查公共知识库；解决后用 \`kb_write\` 沉淀方案；\`read_logs\` 可查看办公室实时日志。`;

const CLAUDE_MD_BLOCK = `## Agent Office 协作协议（Claude Code）

本机运行着多 Agent 协作办公室（MCP 服务名 \`agent-office\`，网页 http://127.0.0.1:${DEFAULT_PORT}）。
你的工号会在会话开始时由系统注入（claude-xxxxxx）。

- 每轮开始前调用 \`read_inbox\` 查看 @你 的消息；完成阶段性工作后调用 \`publish_brief\` 发布简报。
- 需要其他成员（含 Cursor/Codex 中的 Agent）协助时，用 \`send_message\` 并 @对方工号；\`get_context\` 可获取办公室全景上下文（花名册/任务/简报/知识库目录）。
- 阶段任务需要接力时调用 \`handoff_task\` 保存交接材料并自动唤醒接班员工；不要只在最终回复里写 @工号。
- 遇到疑难问题先 \`kb_search\` 查公共知识库；解决后用 \`kb_write\` 沉淀方案；\`read_logs\` 可查看办公室实时日志。`;

const ZCODE_MD_BLOCK = `## Agent Office 协作协议（ZCode）

本机运行着多 Agent 协作办公室（MCP 服务名 \`agent-office\`，网页 http://127.0.0.1:${DEFAULT_PORT}）。
你的工号会在会话开始时由系统注入（zcode-xxxxxx）。

- 每轮开始前调用 \`read_inbox\` 查看 @你 的消息；完成阶段性工作后调用 \`publish_brief\` 发布简报。
- 需要其他成员（含 Cursor/Codex/Claude 中的 Agent）协助时，用 \`send_message\` 并 @对方工号；\`get_context\` 可获取办公室全景上下文（花名册/任务/简报/知识库目录）。
- 阶段任务需要接力时调用 \`handoff_task\` 保存交接材料并自动唤醒接班员工；不要只在最终回复里写 @工号。
- 遇到疑难问题先 \`kb_search\` 查公共知识库；解决后用 \`kb_write\` 沉淀方案；\`read_logs\` 可查看办公室实时日志。`;

/** WorkBuddy 无 hooks/指令文件，靠 SKILL.md 注入协作协议 */
const WORKBUDDY_SKILL_BLOCK = `---
name: agent-office
description: 接入本机 Agent Office 多 Agent 协作办公室（MCP 服务 agent-office，网页 http://127.0.0.1:${DEFAULT_PORT}）。当用户提到办公室、同事、协作、交接，或需要收发消息/简报/任务/知识库时使用。调用 register_agent 登记工号，read_inbox 查 @你 的消息，publish_brief 发布简报，send_message 呼叫同事，handoff_task 交接任务，get_context 获取全景上下文，kb_search/kb_write 查询与沉淀知识。
---

# Agent Office 协作协议（WorkBuddy）

本机运行着多 Agent 协作办公室（MCP 服务名 \`agent-office\`）。你的工号自拟且保持稳定（如 \`workbuddy-主力\`）。

1. 开始参与协作前调用 \`register_agent\` 登记（name 填工号、kind 填 \`workbuddy-cli\`、model 填你当前使用的模型名）。
2. 每轮开始前调用 \`read_inbox\` 查看 @你 的消息，优先响应同事的协作请求。
3. 完成阶段性工作后调用 \`publish_brief\` 发布结构化简报（结果/进展/决策/产物/阻塞/下一步）。
4. 需要其他成员协助时用 \`send_message\` 并 @对方工号；\`get_context\` 可获取办公室全景（花名册/任务/简报/知识库目录）。
5. 阶段任务需要接力时调用 \`handoff_task\` 保存交接材料并自动唤醒接班员工；不要只在最终回复里写 @工号。
6. 遇到疑难问题先 \`kb_search\` 查公共知识库；解决后用 \`kb_write\` 沉淀方案。`;

/** OpenCode 用本地插件上报事件（无传统 JSON hooks），协议走 AGENTS.md */
const OPENCODE_MD_BLOCK = `## Agent Office 协作协议（OpenCode）

本机运行着多 Agent 协作办公室（MCP 服务名 \`agent-office\`，网页 http://127.0.0.1:${DEFAULT_PORT}）。
你的工号会在会话启动时由本地插件注入（opencode-xxxxxx）；插件失效时请手动调用 \`register_agent\` 登记。

- 每轮开始前调用 \`read_inbox\` 查看 @你 的消息；完成阶段性工作后调用 \`publish_brief\` 发布简报。
- 需要其他成员（含 Cursor/Codex/Claude 中的 Agent）协助时，用 \`send_message\` 并 @对方工号；\`get_context\` 可获取办公室全景上下文（花名册/任务/简报/知识库目录）。
- 阶段任务需要接力时调用 \`handoff_task\` 保存交接材料并自动唤醒接班员工；不要只在最终回复里写 @工号。
- 遇到疑难问题先 \`kb_search\` 查公共知识库；解决后用 \`kb_write\` 沉淀方案；\`read_logs\` 可查看办公室实时日志。`;

/** Kimi 无 AGENTS.md 约定，官方用 SYSTEM.md；协议块写入用户级 SYSTEM.md */
const KIMI_MD_BLOCK = `## Agent Office 协作协议（Kimi）

本机运行着多 Agent 协作办公室（MCP 服务名 \`agent-office\`，网页 http://127.0.0.1:${DEFAULT_PORT}）。
你的工号会在会话开始时由系统注入（kimi-xxxxxx）。

- 每轮开始前调用 \`read_inbox\` 查看 @你 的消息；完成阶段性工作后调用 \`publish_brief\` 发布简报。
- 需要其他成员（含 Cursor/Codex/Claude 中的 Agent）协助时，用 \`send_message\` 并 @对方工号；\`get_context\` 可获取办公室全景上下文（花名册/任务/简报/知识库目录）。
- 阶段任务需要接力时调用 \`handoff_task\` 保存交接材料并自动唤醒接班员工；不要只在最终回复里写 @工号。
- 遇到疑难问题先 \`kb_search\` 查公共知识库；解决后用 \`kb_write\` 沉淀方案；\`read_logs\` 可查看办公室实时日志。`;

const QODER_MD_BLOCK = `## Agent Office 协作协议（Qoder）

本机运行着多 Agent 协作办公室（MCP 服务名 \`agent-office\`，网页 http://127.0.0.1:${DEFAULT_PORT}）。
你的工号会在会话开始时由系统注入（qoder-xxxxxx）。

- 每轮开始前调用 \`read_inbox\` 查看 @你 的消息；完成阶段性工作后调用 \`publish_brief\` 发布简报。
- 需要其他成员（含 Cursor/Codex/Claude 中的 Agent）协助时，用 \`send_message\` 并 @对方工号；\`get_context\` 可获取办公室全景上下文（花名册/任务/简报/知识库目录）。
- 阶段任务需要接力时调用 \`handoff_task\` 保存交接材料并自动唤醒接班员工；不要只在最终回复里写 @工号。
- 遇到疑难问题先 \`kb_search\` 查公共知识库；解决后用 \`kb_write\` 沉淀方案；\`read_logs\` 可查看办公室实时日志。`;

/** Kilo CLI 是 OpenCode 的 fork，协议块沿用 AGENTS.md */
const KILO_MD_BLOCK = `## Agent Office 协作协议（Kilo）

本机运行着多 Agent 协作办公室（MCP 服务名 \`agent-office\`，网页 http://127.0.0.1:${DEFAULT_PORT}）。

- 开始参与协作前调用 \`register_agent\` 登记（name 填工号、kind 填 \`kilo-cli\`、model 填你当前使用的模型名）。
- 每轮开始前调用 \`read_inbox\` 查看 @你 的消息；完成阶段性工作后调用 \`publish_brief\` 发布简报。
- 需要其他成员协助时用 \`send_message\` 并 @对方工号；\`get_context\` 可获取办公室全景（花名册/任务/简报/知识库目录）。
- 阶段任务需要接力时调用 \`handoff_task\` 保存交接材料并自动唤醒接班员工；不要只在最终回复里写 @工号。
- 遇到疑难问题先 \`kb_search\` 查公共知识库；解决后用 \`kb_write\` 沉淀方案。`;

/** 用户级路径：各家客户端在任意目录启动都能自动入驻 */
interface UserPaths {
  cursorMcp: string;
  cursorHooks: string;
  codexConfig: string;
  codexAgentsMd: string;
  claudeSettings: string;
  zcodeConfig: string;
  zcodeAgentsMd: string;
  workbuddyMcp: string;
  workbuddySkill: string;
  opencodeConfig: string;
  opencodeAgentsMd: string;
  opencodePlugin: string;
  kimiMcp: string;
  kimiConfig: string;
  kimiSystemMd: string;
  qoderSettings: string;
  qoderAgentsMd: string;
  kiloConfig: string;
  kiloAgentsMd: string;
  traeMcp: string;
}

/** 工作区路径：可选的「办公室工作区」，写入可随仓库共享的项目级文件 */
interface WorkspacePaths {
  workspace: string;
  cursorRule: string;
  agentsMd: string;
  claudeMcp: string;
  claudeMd: string;
  // 旧版本装在工作区的 Cursor 配置，卸载/升级时清理
  legacyCursorMcp: string;
  legacyCursorHooks: string;
}

function userPaths(): UserPaths {
  return {
    cursorMcp: join(homedir(), ".cursor", "mcp.json"),
    cursorHooks: join(homedir(), ".cursor", "hooks.json"),
    codexConfig: join(homedir(), ".codex", "config.toml"),
    codexAgentsMd: join(homedir(), ".codex", "AGENTS.md"),
    claudeSettings: join(homedir(), ".claude", "settings.json"),
    zcodeConfig: join(homedir(), ".zcode", "cli", "config.json"),
    zcodeAgentsMd: join(homedir(), ".zcode", "AGENTS.md"),
    workbuddyMcp: join(homedir(), ".workbuddy", "mcp.json"),
    workbuddySkill: join(homedir(), ".workbuddy", "skills", "agent-office", "SKILL.md"),
    opencodeConfig: join(homedir(), ".config", "opencode", "opencode.json"),
    opencodeAgentsMd: join(homedir(), ".config", "opencode", "AGENTS.md"),
    opencodePlugin: join(homedir(), ".config", "opencode", "plugins", "agent-office.mjs"),
    kimiMcp: join(homedir(), ".kimi-code", "mcp.json"),
    kimiConfig: join(homedir(), ".kimi-code", "config.toml"),
    kimiSystemMd: join(homedir(), ".kimi-code", "SYSTEM.md"),
    qoderSettings: join(homedir(), ".qoder", "settings.json"),
    qoderAgentsMd: join(homedir(), ".qoder", "AGENTS.md"),
    kiloConfig: join(homedir(), ".config", "kilocode", "kilocode.json"),
    kiloAgentsMd: join(homedir(), ".config", "kilocode", "AGENTS.md"),
    traeMcp: join(process.env.APPDATA ?? homedir(), "Trae CN", "User", "mcp.json"),
  };
}

function workspacePaths(workspace: string): WorkspacePaths {
  return {
    workspace,
    cursorRule: join(workspace, ".cursor", "rules", "agent-office.mdc"),
    agentsMd: join(workspace, "AGENTS.md"),
    claudeMcp: join(workspace, ".mcp.json"),
    claudeMd: join(workspace, "CLAUDE.md"),
    legacyCursorMcp: join(workspace, ".cursor", "mcp.json"),
    legacyCursorHooks: join(workspace, ".cursor", "hooks.json"),
  };
}

/** 注册/刷新 Claude 用户级 MCP（幂等：先删后加，失败不阻塞安装） */
function registerClaudeUserMcp(mcpUrl: string): boolean {
  try {
    try {
      execSync("claude mcp remove --scope user agent-office", {
        stdio: "ignore",
        timeout: 15_000,
      });
    } catch {
      /* 不存在时忽略 */
    }
    execSync(`claude mcp add --scope user --transport http agent-office ${mcpUrl}`, {
      stdio: "ignore",
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

function removeClaudeUserMcp(): void {
  try {
    execSync("claude mcp remove --scope user agent-office", {
      stdio: "ignore",
      timeout: 15_000,
    });
  } catch {
    /* CLI 不存在或未注册时忽略 */
  }
}

/** 备份后写入，返回备份路径（如有） */
function backupAndWrite(path: string, content: string, backups: string[]): void {
  if (readIfExists(path) === content) return;
  const b = backup(path);
  if (b) backups.push(b);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function syncManagedHooks(
  sourceDir: string,
  targetDir: string,
  filenames: readonly (typeof MANAGED_HOOK_FILES)[number][],
  backups: string[],
): void {
  for (const filename of filenames) {
    const source = join(sourceDir, filename);
    if (!existsSync(source)) throw new Error(`缺少 Hook 资源: ${source}`);
    const target = join(targetDir, filename);
    const content = readFileSync(source, "utf8");
    if (readIfExists(target) === content) continue;
    backupAndWrite(target, content, backups);
  }
}

interface UserInstallContext {
  config: ReturnType<typeof loadConfig>;
  mcpUrl: string;
  user: UserPaths;
  backups: string[];
  notes: string[];
  commands: HookCommands;
  hooksDir: string;
}

const CLIENT_HOOK_FILE: Record<
  IntegrationClient,
  (typeof MANAGED_HOOK_FILES)[number] | null
> = {
  cursor: "cursor-hook.mjs",
  codex: "codex-notify.mjs",
  claude: "claude-hook.mjs",
  zcode: "zcode-hook.mjs",
  // WorkBuddy 无 hooks：它通过 stdio MCP 代理接入（见 installWorkbuddy）
  workbuddy: null,
  // OpenCode 无传统 hooks，用本地插件（拷贝到 ~/.config/opencode/plugins/，见 installOpencode）
  opencode: "opencode-plugin.mjs",
  kimi: "kimi-hook.mjs",
  qoder: "qoder-hook.mjs",
  // Kilo/Trae 无 hooks：Kilo 用 OpenCode 同款 remote MCP，Trae 用 VS Code 风格 MCP（均手动登记）
  kilo: null,
  trae: null,
};

function prepareUserInstall(client?: IntegrationClient): UserInstallContext {
  const config = loadConfig();
  const baseUrl = `http://127.0.0.1:${config.port}`;
  const mcpUrl = `${baseUrl}/mcp`;
  const user = userPaths();
  const backups: string[] = [];
  const notes: string[] = [];
  const node = resolveHookNode();
  const hooksDir = resolve(config.dataDir, "hooks");
  const hookFiles = client
    ? [CLIENT_HOOK_FILE[client]].filter((f): f is NonNullable<typeof f> => f !== null)
    : MANAGED_HOOK_FILES;
  syncManagedHooks(resolveHooksSourceDir(), hooksDir, hookFiles, backups);
  const commands = buildHookCommands(node, hooksDir, baseUrl);
  return { config, mcpUrl, user, backups, notes, commands, hooksDir };
}

function installCursor(context: UserInstallContext): void {
  const { user, mcpUrl, commands, backups } = context;
  backupAndWrite(user.cursorMcp, mergeMcpJson(readIfExists(user.cursorMcp), mcpUrl), backups);
  backupAndWrite(
    user.cursorHooks,
    mergeHooksJson(readIfExists(user.cursorHooks), commands.cursor),
    backups,
  );
}

function installCodex(context: UserInstallContext): void {
  const { user, mcpUrl, commands, backups, notes, hooksDir } = context;
  const existingCodexConfig = readIfExists(user.codexConfig);
  const existingNotify = getCodexNotifyCommand(existingCodexConfig);
  const notifyIsOurs = existingNotify?.some((item) => item.includes("codex-notify.mjs")) ?? false;
  const chainPath = join(hooksDir, "codex-notify-chain.json");
  let notifyCommand = commands.codexNotify;
  if (existingNotify && !notifyIsOurs) {
    backupAndWrite(
      chainPath,
      JSON.stringify({ command: existingNotify }, null, 2) + "\n",
      backups,
    );
    notifyCommand = [...notifyCommand, chainPath];
    notes.push("已通过 Agent Office Notify 链保留现有 Codex notify 命令。");
  } else {
    const existingChainPath = existingNotify?.find((item) =>
      item.endsWith("codex-notify-chain.json"),
    );
    if (existingChainPath && existsSync(existingChainPath)) {
      const chainContent = readFileSync(existingChainPath, "utf8");
      backupAndWrite(chainPath, chainContent, backups);
      notifyCommand = [...notifyCommand, chainPath];
    }
  }
  const merged = mergeCodexToml(existingCodexConfig, {
    mcpUrl,
    notifyCommand,
    replaceExistingNotify: Boolean(existingNotify && !notifyIsOurs),
  });
  backupAndWrite(user.codexConfig, merged.toml, backups);
  if (merged.notifySkipped) {
    notes.push(
      "~/.codex/config.toml 已存在其他 notify 配置，未覆盖；如需回帧简报请手工把 codex-notify.mjs 加入 notify。",
    );
  }
  backupAndWrite(
    user.codexAgentsMd,
    upsertMarkerBlock(readIfExists(user.codexAgentsMd), AGENTS_MD_BLOCK),
    backups,
  );
}

function installClaude(context: UserInstallContext): void {
  const { user, mcpUrl, commands, backups, notes } = context;
  backupAndWrite(
    user.claudeSettings,
    mergeClaudeSettings(readIfExists(user.claudeSettings), commands.claude),
    backups,
  );
  if (registerClaudeUserMcp(mcpUrl)) {
    notes.push("已注册 Claude 用户级 MCP（claude mcp add --scope user agent-office）。");
  } else {
    notes.push(
      `未检测到 claude CLI 或注册失败；请手工执行：claude mcp add --scope user --transport http agent-office ${mcpUrl}`,
    );
  }
}

function installZcode(context: UserInstallContext): void {
  const { user, mcpUrl, commands, backups } = context;
  backupAndWrite(
    user.zcodeConfig,
    mergeZcodeConfig(readIfExists(user.zcodeConfig), {
      mcpUrl,
      hookCommand: commands.zcode,
    }),
    backups,
  );
  backupAndWrite(
    user.zcodeAgentsMd,
    upsertMarkerBlock(readIfExists(user.zcodeAgentsMd), ZCODE_MD_BLOCK),
    backups,
  );
}

function installWorkbuddy(context: UserInstallContext): void {
  const { user, commands, backups } = context;
  backupAndWrite(
    user.workbuddyMcp,
    mergeWorkbuddyMcpJson(readIfExists(user.workbuddyMcp), commands.workbuddyBridge),
    backups,
  );
  backupAndWrite(
    user.workbuddySkill,
    upsertMarkerBlock(readIfExists(user.workbuddySkill), WORKBUDDY_SKILL_BLOCK),
    backups,
  );
}

function installOpencode(context: UserInstallContext): void {
  const { user, mcpUrl, backups } = context;
  backupAndWrite(
    user.opencodeConfig,
    mergeOpencodeConfig(readIfExists(user.opencodeConfig), mcpUrl),
    backups,
  );
  backupAndWrite(
    user.opencodeAgentsMd,
    upsertMarkerBlock(readIfExists(user.opencodeAgentsMd), OPENCODE_MD_BLOCK),
    backups,
  );
  // 本地插件（事件上报 → 自动入驻/回帧简报）：从 hooks 源同步到 opencode 插件目录
  const source = join(resolveHooksSourceDir(), "opencode-plugin.mjs");
  const content = readFileSync(source, "utf8");
  if (readIfExists(user.opencodePlugin) !== content) {
    backupAndWrite(user.opencodePlugin, content, backups);
  }
}

function installKimi(context: UserInstallContext): void {
  const { user, mcpUrl, commands, backups } = context;
  // MCP 是标准 mcpServers 结构（~/.kimi-code/mcp.json）
  backupAndWrite(user.kimiMcp, mergeMcpJson(readIfExists(user.kimiMcp), mcpUrl), backups);
  // hooks 在 config.toml 的 [[hooks]]（事件与 Claude 同构）
  backupAndWrite(
    user.kimiConfig,
    mergeKimiToml(readIfExists(user.kimiConfig), commands.kimi),
    backups,
  );
  // 官方无 AGENTS.md 约定，用用户级 SYSTEM.md 承载协议
  backupAndWrite(
    user.kimiSystemMd,
    upsertMarkerBlock(readIfExists(user.kimiSystemMd), KIMI_MD_BLOCK),
    backups,
  );
}

function installQoder(context: UserInstallContext): void {
  const { user, mcpUrl, commands, backups } = context;
  // MCP + hooks 都在 ~/.qoder/settings.json
  backupAndWrite(
    user.qoderSettings,
    mergeQoderConfig(readIfExists(user.qoderSettings), { mcpUrl, hookCommand: commands.qoder }),
    backups,
  );
  backupAndWrite(
    user.qoderAgentsMd,
    upsertMarkerBlock(readIfExists(user.qoderAgentsMd), QODER_MD_BLOCK),
    backups,
  );
}

function installKilo(context: UserInstallContext): void {
  const { user, mcpUrl, backups } = context;
  // OpenCode 的 fork：remote MCP + 用户级 AGENTS.md
  backupAndWrite(user.kiloConfig, mergeOpencodeConfig(readIfExists(user.kiloConfig), mcpUrl), backups);
  backupAndWrite(
    user.kiloAgentsMd,
    upsertMarkerBlock(readIfExists(user.kiloAgentsMd), KILO_MD_BLOCK),
    backups,
  );
}

function installTrae(context: UserInstallContext): void {
  const { user, mcpUrl, backups } = context;
  // VS Code fork：用户级 User/mcp.json，标准 mcpServers 结构；无 hooks，手动登记
  backupAndWrite(user.traeMcp, mergeMcpJson(readIfExists(user.traeMcp), mcpUrl), backups);
}

export function repairIntegration(client: IntegrationClient): void {
  const context = prepareUserInstall(client);
  if (client === "cursor") installCursor(context);
  else if (client === "codex") installCodex(context);
  else if (client === "claude") installClaude(context);
  else if (client === "zcode") installZcode(context);
  else if (client === "workbuddy") installWorkbuddy(context);
  else if (client === "opencode") installOpencode(context);
  else if (client === "kimi") installKimi(context);
  else if (client === "qoder") installQoder(context);
  else if (client === "kilo") installKilo(context);
  else installTrae(context);
  console.log(`[agent-office] ${client} 接入修复完成。`);
  for (const backupPath of context.backups) console.log(`  备份: ${backupPath}`);
  for (const note of context.notes) console.log(`  注意: ${note}`);
}

export function install(workspace: string | null): void {
  const context = prepareUserInstall();
  installCursor(context);
  installCodex(context);
  installClaude(context);
  installZcode(context);
  installWorkbuddy(context);
  installOpencode(context);
  installKimi(context);
  installQoder(context);
  installKilo(context);
  installTrae(context);
  const { config, mcpUrl, backups, notes } = context;

  // ---------- 工作区级（可选）：标记「办公室工作区」，写入可随仓库共享的文件 ----------
  if (workspace) {
    const ws = workspacePaths(workspace);
    mkdirSync(dirname(ws.cursorRule), { recursive: true });
    writeFileSync(ws.cursorRule, RULE_CONTENT, "utf8");
    backupAndWrite(
      ws.agentsMd,
      upsertMarkerBlock(readIfExists(ws.agentsMd), AGENTS_MD_BLOCK),
      backups,
    );
    backupAndWrite(ws.claudeMcp, mergeClaudeMcpJson(readIfExists(ws.claudeMcp), mcpUrl), backups);
    backupAndWrite(
      ws.claudeMd,
      upsertMarkerBlock(readIfExists(ws.claudeMd), CLAUDE_MD_BLOCK),
      backups,
    );
    // 清理旧版本装在工作区的 Cursor 配置，避免 hooks 双份触发
    cleanupLegacyWorkspaceCursor(ws, backups);
  }

  console.log("[agent-office] 安装完成（用户级，全部客户端任意目录可用）。");
  if (workspace) console.log(`  办公室工作区: ${workspace}`);
  console.log(`  MCP 端点: ${mcpUrl}`);
  if (backups.length > 0) {
    console.log("  备份文件:");
    for (const b of backups) console.log(`    - ${b}`);
  }
  for (const n of notes) console.log(`  注意: ${n}`);
  console.log("  下一步:");
  console.log("    1. 启动中枢: cd agent-office && pnpm start（或双击 启动办公室.bat）");
  console.log(`    2. 打开网页: http://127.0.0.1:${config.port}`);
  console.log("    3. 重启 Cursor 会话、Codex 终端、Claude Code、ZCode 与 OpenCode 会话以加载新配置。");
}

/** 移除旧版本写入工作区的 .cursor/mcp.json 与 hooks.json 中的 agent-office 条目 */
function cleanupLegacyWorkspaceCursor(ws: WorkspacePaths, backups: string[]): void {
  const legacyMcp = readIfExists(ws.legacyCursorMcp);
  if (legacyMcp?.includes("agent-office")) {
    backupAndWrite(ws.legacyCursorMcp, removeFromMcpJson(legacyMcp), backups);
  }
  const legacyHooks = readIfExists(ws.legacyCursorHooks);
  if (legacyHooks?.includes("cursor-hook.mjs")) {
    const remaining = removeFromHooksJson(legacyHooks);
    backupAndWrite(
      ws.legacyCursorHooks,
      remaining ?? JSON.stringify({ version: 1, hooks: {} }, null, 2) + "\n",
      backups,
    );
  }
}

export function uninstall(workspace: string | null): void {
  const user = userPaths();
  const touched: string[] = [];

  const edit = (path: string, transform: (content: string) => string | null): void => {
    const content = readIfExists(path);
    if (!content) return;
    backup(path);
    const next = transform(content);
    if (next !== null) {
      writeFileSync(path, next, "utf8");
      touched.push(path);
    }
  };

  const loadNotifyChain = (path: string): string[] | null => {
    try {
      const command = (JSON.parse(readFileSync(path, "utf8")) as { command?: unknown }).command;
      return Array.isArray(command) && command.every((item) => typeof item === "string")
        ? command
        : null;
    } catch {
      return null;
    }
  };

  // 用户级
  edit(user.cursorMcp, removeFromMcpJson);
  edit(user.cursorHooks, (c) =>
    removeFromHooksJson(c) ?? JSON.stringify({ version: 1, hooks: {} }, null, 2) + "\n",
  );
  edit(user.codexConfig, (content) => removeFromCodexToml(content, loadNotifyChain));
  edit(user.codexAgentsMd, removeMarkerBlock);
  edit(user.claudeSettings, removeFromClaudeSettings);
  removeClaudeUserMcp();
  edit(user.zcodeConfig, removeFromZcodeConfig);
  edit(user.zcodeAgentsMd, removeMarkerBlock);
  edit(user.workbuddyMcp, removeFromMcpJson);
  edit(user.workbuddySkill, removeMarkerBlock);
  edit(user.opencodeConfig, removeFromOpencodeConfig);
  edit(user.opencodeAgentsMd, removeMarkerBlock);
  // OpenCode 插件由我们创建，卸载后删除（backupAndWrite 会先备份）
  if (readIfExists(user.opencodePlugin) !== null) {
    backup(user.opencodePlugin);
    rmSync(user.opencodePlugin, { force: true });
    touched.push(user.opencodePlugin);
  }
  edit(user.kimiMcp, removeFromMcpJson);
  edit(user.kimiConfig, removeFromKimiToml);
  edit(user.kimiSystemMd, removeMarkerBlock);
  edit(user.qoderSettings, removeFromQoderConfig);
  edit(user.qoderAgentsMd, removeMarkerBlock);
  edit(user.kiloConfig, removeFromOpencodeConfig);
  edit(user.kiloAgentsMd, removeMarkerBlock);
  edit(user.traeMcp, removeFromMcpJson);
  // WorkBuddy 的 skill 目录由我们创建，卸载后若为空则顺手清理
  if (readIfExists(user.workbuddySkill) === null) {
    const skillDir = dirname(user.workbuddySkill);
    try {
      if (existsSync(skillDir) && readdirSync(skillDir).length === 0) rmSync(skillDir, { recursive: true, force: true });
    } catch {
      /* 清理失败不阻塞卸载 */
    }
  }

  // 工作区级（含旧版本遗留的 Cursor 配置）
  if (workspace) {
    const ws = workspacePaths(workspace);
    edit(ws.agentsMd, removeMarkerBlock);
    edit(ws.claudeMcp, removeFromMcpJson);
    edit(ws.claudeMd, removeMarkerBlock);
    edit(ws.legacyCursorMcp, removeFromMcpJson);
    edit(ws.legacyCursorHooks, (c) =>
      removeFromHooksJson(c) ?? JSON.stringify({ version: 1, hooks: {} }, null, 2) + "\n",
    );
    console.log("[agent-office] 规则文件如需删除请手工移除：");
    console.log(`  - ${ws.cursorRule}`);
  }
  console.log("[agent-office] 已卸载接入配置（均有备份）。");
  for (const t of touched) console.log(`  已更新: ${t}`);
}

// ---------- CLI ----------
// install [--workspace <路径>]：用户级安装；--workspace 可选，用于标记办公室工作区
const [, , command, ...rest] = process.argv;
if (command === "install" || command === "uninstall") {
  let workspace: string | null = null;
  const flagIdx = rest.indexOf("--workspace");
  if (flagIdx !== -1 && rest[flagIdx + 1]) workspace = resolve(rest[flagIdx + 1]);
  if (command === "install") install(workspace);
  else uninstall(workspace);
}
