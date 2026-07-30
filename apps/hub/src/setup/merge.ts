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
