import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, loadConfig } from "../config.js";
import {
  mergeClaudeMcpJson,
  mergeClaudeSettings,
  mergeCodexToml,
  mergeHooksJson,
  mergeMcpJson,
  removeFromClaudeSettings,
  removeFromCodexToml,
  removeFromHooksJson,
  removeFromMcpJson,
  removeMarkerBlock,
  upsertMarkerBlock,
} from "./merge.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/setup → agent-office 根目录
const OFFICE_ROOT = resolve(HERE, "../../../..");
const HOOKS_DIR = join(OFFICE_ROOT, "hooks");

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

1. 会话开始处理任务前，先调用 \`register_agent\` 登记（沿用系统注入的工号；若无则自拟简短工号）。
2. 开始新一轮工作前调用 \`read_inbox\` 查看是否有 @你 的消息，优先响应同事的协作请求。
3. 完成阶段性工作后调用 \`publish_brief\` 发布结构化简报（结果/进展/决策/产物/阻塞/下一步）。
4. 需要其他成员协助时用 \`send_message\` 并 @对方工号；\`get_context\` 可查看花名册、任务与最新简报。
5. 认领任务用 \`claim_task\`，状态变化及时 \`update_task\`。
`;

const AGENTS_MD_BLOCK = `## Agent Office 协作协议（Codex）

本机运行着多 Agent 协作办公室（MCP 服务名 \`agent_office\`，网页 http://127.0.0.1:${DEFAULT_PORT}）。

- 会话开始处理任务前，调用 \`register_agent\` 登记（kind 填 \`codex-cli\`，工号自拟且保持稳定，如 \`codex-主力\`）。
- 每轮开始前调用 \`read_inbox\` 查看 @你 的消息；完成阶段性工作后调用 \`publish_brief\` 发布简报。
- 需要其他成员（含 Cursor 中的 Agent）协助时，用 \`send_message\` 并 @对方工号；\`get_context\` 可查花名册与最新简报。`;

const CLAUDE_MD_BLOCK = `## Agent Office 协作协议（Claude Code）

本机运行着多 Agent 协作办公室（MCP 服务名 \`agent-office\`，网页 http://127.0.0.1:${DEFAULT_PORT}）。
你的工号会在会话开始时由系统注入（claude-xxxxxx）。

- 每轮开始前调用 \`read_inbox\` 查看 @你 的消息；完成阶段性工作后调用 \`publish_brief\` 发布简报。
- 需要其他成员（含 Cursor/Codex 中的 Agent）协助时，用 \`send_message\` 并 @对方工号；\`get_context\` 可查花名册与最新简报。`;

/** 用户级路径：三家客户端在任意目录启动都能自动入驻 */
interface UserPaths {
  cursorMcp: string;
  cursorHooks: string;
  codexConfig: string;
  codexAgentsMd: string;
  claudeSettings: string;
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
  const b = backup(path);
  if (b) backups.push(b);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

export function install(workspace: string | null): void {
  const config = loadConfig();
  const mcpUrl = `http://127.0.0.1:${config.port}/mcp`;
  const user = userPaths();
  const node = process.execPath;
  const cursorHookCmd = `"${node}" "${join(HOOKS_DIR, "cursor-hook.mjs")}"`;
  const codexNotifyCmd = [node, join(HOOKS_DIR, "codex-notify.mjs")];
  const claudeHookCmd = `"${node}" "${join(HOOKS_DIR, "claude-hook.mjs")}"`;
  const backups: string[] = [];
  const notes: string[] = [];

  // ---------- 用户级：任意目录的会话都自动入驻 ----------

  // 1. Cursor：全局 MCP + 全局 hooks（协作规则由 sessionStart hook 注入）
  backupAndWrite(user.cursorMcp, mergeMcpJson(readIfExists(user.cursorMcp), mcpUrl), backups);
  backupAndWrite(
    user.cursorHooks,
    mergeHooksJson(readIfExists(user.cursorHooks), cursorHookCmd),
    backups,
  );

  // 2. Codex：全局 config.toml（MCP + notify）+ 全局 AGENTS.md 协作协议
  const codexBackup = backup(user.codexConfig);
  if (codexBackup) backups.push(codexBackup);
  mkdirSync(dirname(user.codexConfig), { recursive: true });
  const merged = mergeCodexToml(readIfExists(user.codexConfig), {
    mcpUrl,
    notifyCommand: codexNotifyCmd,
  });
  writeFileSync(user.codexConfig, merged.toml, "utf8");
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

  // 3. Claude：全局 hooks + user-scope MCP
  backupAndWrite(
    user.claudeSettings,
    mergeClaudeSettings(readIfExists(user.claudeSettings), claudeHookCmd),
    backups,
  );
  if (registerClaudeUserMcp(mcpUrl)) {
    notes.push("已注册 Claude 用户级 MCP（claude mcp add --scope user agent-office）。");
  } else {
    notes.push(
      `未检测到 claude CLI 或注册失败；请手工执行：claude mcp add --scope user --transport http agent-office ${mcpUrl}`,
    );
  }

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
  console.log("    3. 重启 Cursor 会话、Codex 终端与 Claude Code 会话以加载新配置。");
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

  // 用户级
  edit(user.cursorMcp, removeFromMcpJson);
  edit(user.cursorHooks, (c) =>
    removeFromHooksJson(c) ?? JSON.stringify({ version: 1, hooks: {} }, null, 2) + "\n",
  );
  edit(user.codexConfig, removeFromCodexToml);
  edit(user.codexAgentsMd, removeMarkerBlock);
  edit(user.claudeSettings, removeFromClaudeSettings);
  removeClaudeUserMcp();

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
