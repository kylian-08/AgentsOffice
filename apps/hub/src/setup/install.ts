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

interface InstallPaths {
  workspace: string;
  cursorMcp: string;
  cursorHooks: string;
  cursorRule: string;
  agentsMd: string;
  codexConfig: string;
  claudeSettings: string;
  claudeMcp: string;
  claudeMd: string;
}

function resolvePaths(workspace: string): InstallPaths {
  return {
    workspace,
    cursorMcp: join(workspace, ".cursor", "mcp.json"),
    cursorHooks: join(workspace, ".cursor", "hooks.json"),
    cursorRule: join(workspace, ".cursor", "rules", "agent-office.mdc"),
    agentsMd: join(workspace, "AGENTS.md"),
    codexConfig: join(homedir(), ".codex", "config.toml"),
    // Claude hooks 装到用户级：无论在哪个目录启动 claude 都能自动入驻
    claudeSettings: join(homedir(), ".claude", "settings.json"),
    claudeMcp: join(workspace, ".mcp.json"),
    claudeMd: join(workspace, "CLAUDE.md"),
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

export function install(workspace: string): void {
  const config = loadConfig();
  const mcpUrl = `http://127.0.0.1:${config.port}/mcp`;
  const paths = resolvePaths(workspace);
  const node = process.execPath;
  const cursorHookCmd = `"${node}" "${join(HOOKS_DIR, "cursor-hook.mjs")}"`;
  const codexNotifyCmd = [node, join(HOOKS_DIR, "codex-notify.mjs")];
  const claudeHookCmd = `"${node}" "${join(HOOKS_DIR, "claude-hook.mjs")}"`;
  const backups: string[] = [];
  const notes: string[] = [];

  // 1. Cursor MCP
  const mcpBackup = backup(paths.cursorMcp);
  if (mcpBackup) backups.push(mcpBackup);
  mkdirSync(dirname(paths.cursorMcp), { recursive: true });
  writeFileSync(paths.cursorMcp, mergeMcpJson(readIfExists(paths.cursorMcp), mcpUrl), "utf8");

  // 2. Cursor hooks
  const hooksBackup = backup(paths.cursorHooks);
  if (hooksBackup) backups.push(hooksBackup);
  writeFileSync(
    paths.cursorHooks,
    mergeHooksJson(readIfExists(paths.cursorHooks), cursorHookCmd),
    "utf8",
  );

  // 3. Cursor 规则
  mkdirSync(dirname(paths.cursorRule), { recursive: true });
  writeFileSync(paths.cursorRule, RULE_CONTENT, "utf8");

  // 4. AGENTS.md 标记块
  const agentsBackup = backup(paths.agentsMd);
  if (agentsBackup) backups.push(agentsBackup);
  writeFileSync(
    paths.agentsMd,
    upsertMarkerBlock(readIfExists(paths.agentsMd), AGENTS_MD_BLOCK),
    "utf8",
  );

  // 5. Codex config.toml
  const codexBackup = backup(paths.codexConfig);
  if (codexBackup) backups.push(codexBackup);
  mkdirSync(dirname(paths.codexConfig), { recursive: true });
  const merged = mergeCodexToml(readIfExists(paths.codexConfig), {
    mcpUrl,
    notifyCommand: codexNotifyCmd,
  });
  writeFileSync(paths.codexConfig, merged.toml, "utf8");
  if (merged.notifySkipped) {
    notes.push(
      "~/.codex/config.toml 已存在其他 notify 配置，未覆盖；如需回帧简报请手工把 codex-notify.mjs 加入 notify。",
    );
  }

  // 6. Claude Code：用户级 hooks + 用户级 MCP + 项目级 .mcp.json / CLAUDE.md
  const claudeSettingsBackup = backup(paths.claudeSettings);
  if (claudeSettingsBackup) backups.push(claudeSettingsBackup);
  mkdirSync(dirname(paths.claudeSettings), { recursive: true });
  writeFileSync(
    paths.claudeSettings,
    mergeClaudeSettings(readIfExists(paths.claudeSettings), claudeHookCmd),
    "utf8",
  );
  const claudeMcpBackup = backup(paths.claudeMcp);
  if (claudeMcpBackup) backups.push(claudeMcpBackup);
  writeFileSync(
    paths.claudeMcp,
    mergeClaudeMcpJson(readIfExists(paths.claudeMcp), mcpUrl),
    "utf8",
  );
  const claudeMdBackup = backup(paths.claudeMd);
  if (claudeMdBackup) backups.push(claudeMdBackup);
  writeFileSync(
    paths.claudeMd,
    upsertMarkerBlock(readIfExists(paths.claudeMd), CLAUDE_MD_BLOCK),
    "utf8",
  );
  // 用户级 MCP：让任意目录启动的 claude 会话都能调用办公室工具
  // （.mcp.json 只在项目目录内生效，这里再注册一份 user scope）
  if (registerClaudeUserMcp(mcpUrl)) {
    notes.push("已注册 Claude 用户级 MCP（claude mcp add --scope user agent-office）。");
  } else {
    notes.push(
      `未检测到 claude CLI 或注册失败；如需在项目目录外使用，请手工执行：claude mcp add --scope user --transport http agent-office ${mcpUrl}`,
    );
  }

  console.log("[agent-office] 安装完成。");
  console.log(`  工作区: ${workspace}`);
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

export function uninstall(workspace: string): void {
  const paths = resolvePaths(workspace);
  const touched: string[] = [];

  const mcp = readIfExists(paths.cursorMcp);
  if (mcp) {
    backup(paths.cursorMcp);
    writeFileSync(paths.cursorMcp, removeFromMcpJson(mcp), "utf8");
    touched.push(paths.cursorMcp);
  }
  const hooks = readIfExists(paths.cursorHooks);
  if (hooks) {
    backup(paths.cursorHooks);
    const remaining = removeFromHooksJson(hooks);
    writeFileSync(
      paths.cursorHooks,
      remaining ?? JSON.stringify({ version: 1, hooks: {} }, null, 2) + "\n",
      "utf8",
    );
    touched.push(paths.cursorHooks);
  }
  const agentsMd = readIfExists(paths.agentsMd);
  if (agentsMd) {
    backup(paths.agentsMd);
    writeFileSync(paths.agentsMd, removeMarkerBlock(agentsMd), "utf8");
    touched.push(paths.agentsMd);
  }
  const codex = readIfExists(paths.codexConfig);
  if (codex) {
    backup(paths.codexConfig);
    writeFileSync(paths.codexConfig, removeFromCodexToml(codex), "utf8");
    touched.push(paths.codexConfig);
  }
  const claudeSettings = readIfExists(paths.claudeSettings);
  if (claudeSettings) {
    backup(paths.claudeSettings);
    writeFileSync(paths.claudeSettings, removeFromClaudeSettings(claudeSettings), "utf8");
    touched.push(paths.claudeSettings);
  }
  const claudeMcp = readIfExists(paths.claudeMcp);
  if (claudeMcp) {
    backup(paths.claudeMcp);
    writeFileSync(paths.claudeMcp, removeFromMcpJson(claudeMcp), "utf8");
    touched.push(paths.claudeMcp);
  }
  const claudeMd = readIfExists(paths.claudeMd);
  if (claudeMd) {
    backup(paths.claudeMd);
    writeFileSync(paths.claudeMd, removeMarkerBlock(claudeMd), "utf8");
    touched.push(paths.claudeMd);
  }
  removeClaudeUserMcp();
  console.log("[agent-office] 已卸载接入配置（均有备份）。规则文件如需删除请手工移除：");
  console.log(`  - ${paths.cursorRule}`);
  for (const t of touched) console.log(`  已更新: ${t}`);
}

// ---------- CLI ----------
const [, , command, ...rest] = process.argv;
if (command === "install" || command === "uninstall") {
  let workspace = process.cwd();
  const flagIdx = rest.indexOf("--workspace");
  if (flagIdx !== -1 && rest[flagIdx + 1]) workspace = resolve(rest[flagIdx + 1]);
  if (command === "install") install(workspace);
  else uninstall(workspace);
}
