import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

/** 合并 .cursor/mcp.json：保留已有 server，插入/覆盖 agent-office */
export function mergeMcpJson(existing: string | null, mcpUrl: string): string {
  let doc: any = { mcpServers: {} };
  if (existing?.trim()) {
    try {
      doc = JSON.parse(existing);
    } catch {
      throw new Error("现有 mcp.json 不是合法 JSON，请先手工修复");
    }
  }
  if (typeof doc !== "object" || doc === null) doc = {};
  doc.mcpServers = doc.mcpServers ?? {};
  doc.mcpServers["agent-office"] = { url: mcpUrl };
  return JSON.stringify(doc, null, 2) + "\n";
}

export function removeFromMcpJson(existing: string): string {
  const doc = JSON.parse(existing);
  if (doc?.mcpServers) delete doc.mcpServers["agent-office"];
  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * 合并 OpenCode 用户级配置 ~/.config/opencode/opencode.json：
 * 在 mcp 下插入/覆盖 hub（remote/HTTP 型，直连 Hub 的 /mcp）。幂等。
 */
export function mergeOpencodeConfig(existing: string | null, mcpUrl: string): string {
  let doc: any = {};
  if (existing?.trim()) {
    try {
      doc = JSON.parse(existing);
    } catch {
      throw new Error("现有 OpenCode opencode.json 不是合法 JSON，请先手工修复");
    }
  }
  doc.mcp = doc.mcp ?? {};
  doc.mcp["agent-office"] = { type: "remote", url: mcpUrl, enabled: true };
  return JSON.stringify(doc, null, 2) + "\n";
}

export function removeFromOpencodeConfig(existing: string): string {
  const doc = JSON.parse(existing);
  if (doc?.mcp) {
    delete doc.mcp["agent-office"];
    if (Object.keys(doc.mcp).length === 0) delete doc.mcp;
  }
  return JSON.stringify(doc, null, 2) + "\n";
}

// ---------- Kimi Code CLI（hooks 在 config.toml，MCP 在 mcp.json） ----------

const KIMI_HOOK_MARK = "kimi-hook.mjs";

/** Kimi hooks 事件与 Claude 同构（摄入端只处理这五个） */
const KIMI_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "Stop",
  "SessionEnd",
] as const;

/**
 * 合并 ~/.kimi-code/config.toml：为每个事件追加 [[hooks]]（stdin JSON → 转发脚本）。
 * 按 kimi-hook.mjs 标记幂等去重，保留用户已有的其他 hooks。
 */
export function mergeKimiToml(
  existing: string | null,
  hookCommand: string,
): string {
  let doc: Record<string, any> = {};
  if (existing?.trim()) {
    doc = parseToml(existing) as Record<string, any>;
  }
  const hooks: any[] = Array.isArray(doc.hooks) ? doc.hooks : [];
  for (const event of KIMI_HOOK_EVENTS) {
    if (
      hooks.some(
        (h) =>
          typeof h === "object" &&
          h !== null &&
          (h as Record<string, unknown>).event === event &&
          typeof (h as Record<string, unknown>).command === "string" &&
          ((h as Record<string, unknown>).command as string).includes(KIMI_HOOK_MARK),
      )
    ) {
      continue;
    }
    hooks.push({ event, command: hookCommand });
  }
  doc.hooks = hooks;
  return stringifyToml(doc) + "\n";
}

export function removeFromKimiToml(existing: string): string {
  const doc = parseToml(existing) as Record<string, any>;
  if (Array.isArray(doc.hooks)) {
    doc.hooks = doc.hooks.filter(
      (h: any) =>
        !(
          typeof h === "object" &&
          h !== null &&
          typeof (h as Record<string, unknown>).command === "string" &&
          ((h as Record<string, unknown>).command as string).includes(KIMI_HOOK_MARK)
        ),
    );
    if (doc.hooks.length === 0) delete doc.hooks;
  }
  return stringifyToml(doc) + "\n";
}

// ---------- Qoder（MCP 与 hooks 都在 ~/.qoder/settings.json） ----------

const QODER_HOOK_MARK = "qoder-hook.mjs";

/** Qoder 事件（Cursor 同构，大驼峰）；摄入端处理这五个 */
const QODER_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "Stop",
  "SessionEnd",
] as const;

/**
 * 合并 ~/.qoder/settings.json：写 mcpServers.agent-office（VS Code 风格 url）
 * + hooks（Cursor 风格 event → [{ command }]），按 qoder-hook.mjs 标记幂等去重。
 * Qoder 为 2025 新发布，settings.json 的 MCP 字段名以实测为准；repair 可重跑修正。
 */
export function mergeQoderConfig(
  existing: string | null,
  opts: { mcpUrl: string; hookCommand: string },
): string {
  let doc: any = {};
  if (existing?.trim()) {
    try {
      doc = JSON.parse(existing);
    } catch {
      throw new Error("现有 Qoder settings.json 不是合法 JSON，请先手工修复");
    }
  }
  doc.mcpServers = doc.mcpServers ?? {};
  doc.mcpServers["agent-office"] = { url: opts.mcpUrl };
  doc.hooks = doc.hooks ?? {};
  for (const event of QODER_HOOK_EVENTS) {
    const list: any[] = Array.isArray(doc.hooks[event]) ? doc.hooks[event] : [];
    const filtered = list.filter(
      (h) => !(typeof h?.command === "string" && h.command.includes(QODER_HOOK_MARK)),
    );
    filtered.push({ command: opts.hookCommand });
    doc.hooks[event] = filtered;
  }
  return JSON.stringify(doc, null, 2) + "\n";
}

export function removeFromQoderConfig(existing: string): string {
  const doc = JSON.parse(existing);
  if (doc?.mcpServers) {
    delete doc.mcpServers["agent-office"];
    if (Object.keys(doc.mcpServers).length === 0) delete doc.mcpServers;
  }
  if (doc?.hooks) {
    for (const event of Object.keys(doc.hooks)) {
      if (!Array.isArray(doc.hooks[event])) continue;
      doc.hooks[event] = doc.hooks[event].filter(
        (h: any) => !(typeof h?.command === "string" && h.command.includes(QODER_HOOK_MARK)),
      );
      if (doc.hooks[event].length === 0) delete doc.hooks[event];
    }
    if (Object.keys(doc.hooks).length === 0) delete doc.hooks;
  }
  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * 合并 WorkBuddy 用户级 mcp.json：插入/覆盖 agent-office（stdio 型，
 * 经 SDK stdio 代理转发到 Hub 的 HTTP /mcp）。幂等。
 */
export function mergeWorkbuddyMcpJson(
  existing: string | null,
  opts: { command: string; args: string[] },
): string {
  let doc: any = { mcpServers: {} };
  if (existing?.trim()) {
    try {
      doc = JSON.parse(existing);
    } catch {
      throw new Error("现有 WorkBuddy mcp.json 不是合法 JSON，请先手工修复");
    }
  }
  doc.mcpServers = doc.mcpServers ?? {};
  doc.mcpServers["agent-office"] = { type: "stdio", command: opts.command, args: opts.args };
  return JSON.stringify(doc, null, 2) + "\n";
}

const HOOK_EVENTS = [
  "sessionStart",
  "beforeSubmitPrompt",
  "beforeShellExecution",
  "afterFileEdit",
  "afterAgentResponse",
  "stop",
  "sessionEnd",
] as const;

const HOOK_MARK = "cursor-hook.mjs";

/** 合并 .cursor/hooks.json：保留已有 hook，为每个事件追加我们的转发器（幂等） */
export function mergeHooksJson(existing: string | null, hookCommand: string): string {
  let doc: any = { version: 1, hooks: {} };
  if (existing?.trim()) {
    try {
      doc = JSON.parse(existing);
    } catch {
      throw new Error("现有 hooks.json 不是合法 JSON，请先手工修复");
    }
  }
  doc.version = doc.version ?? 1;
  doc.hooks = doc.hooks ?? {};
  for (const event of HOOK_EVENTS) {
    const list: any[] = Array.isArray(doc.hooks[event]) ? doc.hooks[event] : [];
    const filtered = list.filter(
      (h) => !(typeof h?.command === "string" && h.command.includes(HOOK_MARK)),
    );
    filtered.push({ command: hookCommand });
    doc.hooks[event] = filtered;
  }
  return JSON.stringify(doc, null, 2) + "\n";
}

export function removeFromHooksJson(existing: string): string | null {
  const doc = JSON.parse(existing);
  if (doc?.hooks) {
    for (const event of Object.keys(doc.hooks)) {
      if (Array.isArray(doc.hooks[event])) {
        doc.hooks[event] = doc.hooks[event].filter(
          (h: any) => !(typeof h?.command === "string" && h.command.includes(HOOK_MARK)),
        );
        if (doc.hooks[event].length === 0) delete doc.hooks[event];
      }
    }
    if (Object.keys(doc.hooks).length === 0) return null;
  }
  return JSON.stringify(doc, null, 2) + "\n";
}

const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "Stop",
  "SessionEnd",
] as const;

const CLAUDE_HOOK_MARK = "claude-hook.mjs";

/**
 * 合并 Claude Code settings.json 的 hooks（结构：
 * hooks.<Event> = [{ matcher?, hooks: [{type:"command", command}] }]），幂等。
 */
export function mergeClaudeSettings(existing: string | null, hookCommand: string): string {
  let doc: any = {};
  if (existing?.trim()) {
    try {
      doc = JSON.parse(existing);
    } catch {
      throw new Error("现有 Claude settings.json 不是合法 JSON，请先手工修复");
    }
  }
  doc.hooks = doc.hooks ?? {};
  for (const event of CLAUDE_HOOK_EVENTS) {
    const groups: any[] = Array.isArray(doc.hooks[event]) ? doc.hooks[event] : [];
    const filtered = groups.filter(
      (g) =>
        !(Array.isArray(g?.hooks) &&
          g.hooks.some(
            (h: any) => typeof h?.command === "string" && h.command.includes(CLAUDE_HOOK_MARK),
          )),
    );
    filtered.push({ hooks: [{ type: "command", command: hookCommand }] });
    doc.hooks[event] = filtered;
  }
  return JSON.stringify(doc, null, 2) + "\n";
}

export function removeFromClaudeSettings(existing: string): string {
  const doc = JSON.parse(existing);
  if (doc?.hooks) {
    for (const event of Object.keys(doc.hooks)) {
      if (!Array.isArray(doc.hooks[event])) continue;
      doc.hooks[event] = doc.hooks[event].filter(
        (g: any) =>
          !(Array.isArray(g?.hooks) &&
            g.hooks.some(
              (h: any) => typeof h?.command === "string" && h.command.includes(CLAUDE_HOOK_MARK),
            )),
      );
      if (doc.hooks[event].length === 0) delete doc.hooks[event];
    }
    if (Object.keys(doc.hooks).length === 0) delete doc.hooks;
  }
  return JSON.stringify(doc, null, 2) + "\n";
}

// ---------- ZCode（Claude Code 兼容分支） ----------

const ZCODE_HOOK_MARK = "zcode-hook.mjs";

/** ZCode 的 hook 事件名与 Claude Code 一致（大驼峰），摄入端也只处理这五个 */
const ZCODE_HOOK_EVENTS = CLAUDE_HOOK_EVENTS;

/**
 * 合并 ZCode 用户级配置 ~/.zcode/cli/config.json：
 * - 在 mcp.servers 插入/覆盖 agent-office（HTTP 型）
 * - 打开顶层 hooks.enabled（配置文件 hooks 默认关闭）
 * - 为五个事件追加 process 型转发 hook（按 zcode-hook.mjs 标记幂等去重）
 * process 型 hook 免 shell，Windows 下不会因引号/空格出错。
 */
export function mergeZcodeConfig(
  existing: string | null,
  opts: {
    mcpUrl: string;
    hookCommand: { command: string; args: string[] };
    hookTimeoutMs?: number;
  },
): string {
  let doc: any = {};
  if (existing?.trim()) {
    try {
      doc = JSON.parse(existing);
    } catch {
      throw new Error("现有 ZCode config.json 不是合法 JSON，请先手工修复");
    }
  }
  doc.mcp = doc.mcp ?? {};
  doc.mcp.servers = doc.mcp.servers ?? {};
  doc.mcp.servers["agent-office"] = { type: "http", url: opts.mcpUrl };

  doc.hooks = doc.hooks ?? {};
  doc.hooks.enabled = true;
  doc.hooks.events = doc.hooks.events ?? {};
  for (const event of ZCODE_HOOK_EVENTS) {
    const groups: any[] = Array.isArray(doc.hooks.events[event]) ? doc.hooks.events[event] : [];
    const filtered = groups.filter(
      (g) =>
        !(Array.isArray(g?.hooks) &&
          g.hooks.some(
            (h: any) => typeof h?.command === "string" && h.command.includes(ZCODE_HOOK_MARK),
          )),
    );
    filtered.push({
      hooks: [
        {
          type: "process",
          command: opts.hookCommand.command,
          args: opts.hookCommand.args,
          timeoutMs: opts.hookTimeoutMs ?? 5000,
        },
      ],
    });
    doc.hooks.events[event] = filtered;
  }
  return JSON.stringify(doc, null, 2) + "\n";
}

export function removeFromZcodeConfig(existing: string): string {
  const doc = JSON.parse(existing);
  if (doc?.mcp?.servers) {
    delete doc.mcp.servers["agent-office"];
    if (Object.keys(doc.mcp.servers).length === 0) delete doc.mcp.servers;
    if (doc.mcp && Object.keys(doc.mcp).length === 0) delete doc.mcp;
  }
  if (doc?.hooks?.events) {
    for (const event of Object.keys(doc.hooks.events)) {
      if (!Array.isArray(doc.hooks.events[event])) continue;
      doc.hooks.events[event] = doc.hooks.events[event].filter(
        (g: any) =>
          !(Array.isArray(g?.hooks) &&
            g.hooks.some(
              (h: any) => typeof h?.command === "string" && h.command.includes(ZCODE_HOOK_MARK),
            )),
      );
      if (doc.hooks.events[event].length === 0) delete doc.hooks.events[event];
    }
    if (Object.keys(doc.hooks.events).length === 0) {
      delete doc.hooks.events;
      // enabled 是我们打开的；若 hooks 只剩开关则一并清掉
      if (doc.hooks && Object.keys(doc.hooks).every((k) => k === "enabled")) {
        delete doc.hooks.enabled;
      }
      if (doc.hooks && Object.keys(doc.hooks).length === 0) delete doc.hooks;
    }
  }
  return JSON.stringify(doc, null, 2) + "\n";
}

/** 合并 Claude Code 项目级 .mcp.json：插入/覆盖 agent-office（HTTP） */
export function mergeClaudeMcpJson(existing: string | null, mcpUrl: string): string {
  let doc: any = { mcpServers: {} };
  if (existing?.trim()) {
    try {
      doc = JSON.parse(existing);
    } catch {
      throw new Error("现有 .mcp.json 不是合法 JSON，请先手工修复");
    }
  }
  doc.mcpServers = doc.mcpServers ?? {};
  doc.mcpServers["agent-office"] = { type: "http", url: mcpUrl };
  return JSON.stringify(doc, null, 2) + "\n";
}

/** 在文本中插入/替换标记块（用于 AGENTS.md / CLAUDE.md） */
export function upsertMarkerBlock(
  content: string | null,
  block: string,
  begin = "<!-- AGENT-OFFICE:BEGIN -->",
  end = "<!-- AGENT-OFFICE:END -->",
): string {
  const wrapped = `${begin}\n${block.trim()}\n${end}`;
  if (!content) return wrapped + "\n";
  const beginIdx = content.indexOf(begin);
  const endIdx = content.indexOf(end);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    return (
      content.slice(0, beginIdx) + wrapped + content.slice(endIdx + end.length)
    );
  }
  return content.trimEnd() + "\n\n" + wrapped + "\n";
}

export function removeMarkerBlock(
  content: string,
  begin = "<!-- AGENT-OFFICE:BEGIN -->",
  end = "<!-- AGENT-OFFICE:END -->",
): string {
  const beginIdx = content.indexOf(begin);
  const endIdx = content.indexOf(end);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return content;
  return (content.slice(0, beginIdx) + content.slice(endIdx + end.length))
    .replaceAll(/\n{3,}/g, "\n\n");
}

export interface CodexMergeResult {
  toml: string;
  notifySkipped: boolean;
}

export function getCodexNotifyCommand(existing: string | null): string[] | null {
  if (!existing?.trim()) return null;
  const notify = (parseToml(existing) as Record<string, unknown>).notify;
  return Array.isArray(notify) && notify.every((item) => typeof item === "string")
    ? [...notify]
    : null;
}

/**
 * 合并 ~/.codex/config.toml：
 * - 插入/覆盖 [mcp_servers.agent_office]
 * - notify 为空时写入我们的转发器；已有他人 notify 则跳过并提示
 */
export function mergeCodexToml(
  existing: string | null,
  opts: { mcpUrl: string; notifyCommand: string[]; replaceExistingNotify?: boolean },
): CodexMergeResult {
  let doc: Record<string, any> = {};
  if (existing?.trim()) {
    doc = parseToml(existing) as Record<string, any>;
  }
  doc.mcp_servers = doc.mcp_servers ?? {};
  doc.mcp_servers.agent_office = { url: opts.mcpUrl };

  let notifySkipped = false;
  const currentNotify = doc.notify;
  const isOurs =
    Array.isArray(currentNotify) &&
    currentNotify.some((x: unknown) => typeof x === "string" && x.includes("codex-notify.mjs"));
  if (currentNotify === undefined || isOurs || opts.replaceExistingNotify) {
    doc.notify = opts.notifyCommand;
  } else {
    notifySkipped = true;
  }
  return { toml: stringifyToml(doc) + "\n", notifySkipped };
}

export function removeFromCodexToml(
  existing: string,
  loadNotifyChain?: (path: string) => string[] | null,
): string {
  const doc = parseToml(existing) as Record<string, any>;
  if (doc.mcp_servers) {
    delete doc.mcp_servers.agent_office;
    if (Object.keys(doc.mcp_servers).length === 0) delete doc.mcp_servers;
  }
  if (
    Array.isArray(doc.notify) &&
    doc.notify.some((x: unknown) => typeof x === "string" && x.includes("codex-notify.mjs"))
  ) {
    const chainPath = doc.notify.find(
      (item: unknown) => typeof item === "string" && item.endsWith("codex-notify-chain.json"),
    ) as string | undefined;
    const previousNotify = chainPath ? loadNotifyChain?.(chainPath) : null;
    if (previousNotify?.length) doc.notify = previousNotify;
    else delete doc.notify;
  }
  return stringifyToml(doc) + "\n";
}
