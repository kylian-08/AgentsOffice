import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ClientIntegrationHealth, OfficeHealth } from "@agent-office/protocol";
import { cliExists } from "../util.js";

interface IntegrationConfigContents {
  cursorMcp: string | null;
  cursorHooks: string | null;
  codexConfig: string | null;
  codexInstructions: string | null;
  claudeMcp: string | null;
  claudeSettings: string | null;
  zcodeConfig: string | null;
  zcodeInstructions: string | null;
  workbuddyMcp: string | null;
  workbuddySkill: string | null;
  opencodeConfig: string | null;
  opencodeInstructions: string | null;
  opencodePlugin: string | null;
  kimiMcp: string | null;
  kimiConfig: string | null;
  kimiInstructions: string | null;
  qoderSettings: string | null;
  qoderInstructions: string | null;
  kiloConfig: string | null;
  kiloInstructions: string | null;
  traeMcp: string | null;
}

interface RuntimeAvailability {
  codex: boolean;
  claude: boolean;
  opencode: boolean;
  kimi: boolean;
  qoder: boolean;
  kilo: boolean;
}

function parseJson(content: string | null): Record<string, unknown> | null {
  if (!content?.trim()) return null;
  try {
    const value = JSON.parse(content) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseTomlConfig(content: string | null): Record<string, unknown> | null {
  if (!content?.trim()) return null;
  try {
    return parseToml(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hookPaths(value: unknown, marker: string): string[] {
  if (typeof value === "string") {
    if (!value.includes(marker)) return [];
    const quoted = [...value.matchAll(/["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((path) => path.includes(marker));
    if (quoted.length > 0) return quoted;
    const trimmed = value.trim();
    return trimmed.endsWith(marker) ? [trimmed] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => hookPaths(item, marker));
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap((item) => hookPaths(item, marker));
}

function hasUsableHook(
  value: unknown,
  marker: string,
  hookExists: (path: string) => boolean,
): boolean {
  return hookPaths(value, marker).some((path) => hookExists(path));
}

function hasMcpServer(value: unknown, serverName: string, mcpUrl: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const servers = record.mcpServers ?? record.mcp_servers;
  if (typeof servers === "object" && servers !== null) {
    const server = (servers as Record<string, unknown>)[serverName];
    if (typeof server === "object" && server !== null) {
      const url = (server as Record<string, unknown>).url;
      if (url === mcpUrl) return true;
    }
  }
  return Object.values(record).some((item) => hasMcpServer(item, serverName, mcpUrl));
}

/** ZCode 的 MCP 定义在 config.json 的 mcp.servers.<name>（HTTP url 型） */
function hasZcodeMcpServer(value: unknown, serverName: string, mcpUrl: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const servers = (record.mcp as Record<string, unknown> | undefined)?.servers;
  if (typeof servers === "object" && servers !== null) {
    const server = (servers as Record<string, unknown>)[serverName];
    if (typeof server === "object" && server !== null) {
      return (server as Record<string, unknown>).url === mcpUrl;
    }
  }
  return false;
}

/** OpenCode 的 MCP 定义在 opencode.json 的 mcp.<name>（remote/HTTP url 型）；Kilo 同构 */
function hasOpencodeMcpServer(value: unknown, serverName: string, mcpUrl: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const servers = (record.mcp as Record<string, unknown> | undefined);
  if (typeof servers === "object" && servers !== null) {
    const server = (servers as Record<string, unknown>)[serverName];
    if (typeof server === "object" && server !== null) {
      return (server as Record<string, unknown>).url === mcpUrl;
    }
  }
  return false;
}

/** Kimi hooks 在 config.toml 的 [[hooks]]（event + command 含转发器标记） */
function hasKimiHook(value: unknown, marker: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const hooks = (value as Record<string, unknown>).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) =>
      typeof h === "object" &&
      h !== null &&
      typeof (h as Record<string, unknown>).command === "string" &&
      ((h as Record<string, unknown>).command as string).includes(marker),
  );
}

/** Qoder hooks 在 settings.json 的 hooks.<Event>（Cursor 风格，含转发器标记） */
function hasQoderHook(value: unknown, marker: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  return hookPaths((value as Record<string, unknown>).hooks, marker).length > 0;
}

/** ZCode 配置文件 hooks：顶层 hooks.enabled 打开且 events 里带我们的转发器 */
function hasZcodeHook(
  value: unknown,
  marker: string,
  hookExists: (path: string) => boolean,
): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const hooks = record.hooks as Record<string, unknown> | undefined;
  if (typeof hooks !== "object" || hooks === null || hooks.enabled !== true) return false;
  return hookPaths(hooks, marker).some((path) => hookExists(path));
}

/**
 * WorkBuddy 的 agent-office 是 stdio 型 MCP 代理（SDK 转发入口 stdio.js）：
 * 在 command / args 的任意字符串里命中标记即认为 MCP 已配置。
 */
function hasWorkbuddyBridge(value: unknown, marker: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const servers = record.mcpServers ?? record.mcp_servers;
  if (typeof servers === "object" && servers !== null) {
    const server = (servers as Record<string, unknown>)["agent-office"];
    if (typeof server === "object" && server !== null) {
      const s = server as Record<string, unknown>;
      const flat = [s.command, ...(Array.isArray(s.args) ? s.args : [])].filter(
        (x): x is string => typeof x === "string",
      );
      if (flat.some((arg) => arg.includes(marker))) return true;
    }
  }
  return false;
}

function result(input: {
  runtimeAvailable: boolean | null;
  mcpConfigured: boolean;
  hookConfigured: boolean;
  instructionsConfigured: boolean | null;
  labels: { runtime: string; hook: string; instructions?: string };
}): ClientIntegrationHealth {
  const issues: string[] = [];
  if (input.runtimeAvailable === false) issues.push(`未检测到 ${input.labels.runtime}`);
  if (!input.mcpConfigured) issues.push("MCP 未配置");
  if (!input.hookConfigured) issues.push(`${input.labels.hook}未配置`);
  if (input.instructionsConfigured === false) {
    issues.push(`${input.labels.instructions ?? "协作协议"}未配置`);
  }
  return {
    ready:
      input.runtimeAvailable !== false &&
      input.mcpConfigured &&
      input.hookConfigured &&
      input.instructionsConfigured !== false,
    runtimeAvailable: input.runtimeAvailable,
    mcpConfigured: input.mcpConfigured,
    hookConfigured: input.hookConfigured,
    instructionsConfigured: input.instructionsConfigured,
    issues,
  };
}

export function inspectIntegrationConfigs(
  contents: IntegrationConfigContents,
  runtime: RuntimeAvailability,
  mcpUrl: string,
  hookExists: (path: string) => boolean = existsSync,
): OfficeHealth["integrations"] {
  const cursorMcp = parseJson(contents.cursorMcp);
  const cursorHooks = parseJson(contents.cursorHooks);
  const codexConfig = parseTomlConfig(contents.codexConfig);
  const claudeMcp = parseJson(contents.claudeMcp);
  const claudeSettings = parseJson(contents.claudeSettings);
  const zcodeConfig = parseJson(contents.zcodeConfig);
  const workbuddyMcp = parseJson(contents.workbuddyMcp);
  const opencodeConfig = parseJson(contents.opencodeConfig);
  const kimiMcp = parseJson(contents.kimiMcp);
  const kimiConfig = parseTomlConfig(contents.kimiConfig);
  const qoderSettings = parseJson(contents.qoderSettings);
  const kiloConfig = parseJson(contents.kiloConfig);
  const traeMcp = parseJson(contents.traeMcp);

  return {
    cursor: result({
      runtimeAvailable: null,
      mcpConfigured: hasMcpServer(cursorMcp, "agent-office", mcpUrl),
      hookConfigured: hasUsableHook(cursorHooks, "cursor-hook.mjs", hookExists),
      instructionsConfigured: null,
      labels: { runtime: "Cursor", hook: "Hooks " },
    }),
    codex: result({
      runtimeAvailable: runtime.codex,
      mcpConfigured: hasMcpServer(codexConfig, "agent_office", mcpUrl),
      hookConfigured: hasUsableHook(codexConfig?.notify, "codex-notify.mjs", hookExists),
      instructionsConfigured:
        contents.codexInstructions?.includes("<!-- AGENT-OFFICE:BEGIN -->") ?? false,
      labels: { runtime: "Codex CLI", hook: "Notify ", instructions: "协作协议" },
    }),
    claude: result({
      runtimeAvailable: runtime.claude,
      mcpConfigured: hasMcpServer(claudeMcp, "agent-office", mcpUrl),
      hookConfigured: hasUsableHook(claudeSettings, "claude-hook.mjs", hookExists),
      instructionsConfigured: null,
      labels: { runtime: "Claude CLI", hook: "Hooks " },
    }),
    zcode: result({
      runtimeAvailable: null,
      mcpConfigured: hasZcodeMcpServer(zcodeConfig, "agent-office", mcpUrl),
      hookConfigured: hasZcodeHook(zcodeConfig, "zcode-hook.mjs", hookExists),
      instructionsConfigured:
        contents.zcodeInstructions?.includes("<!-- AGENT-OFFICE:BEGIN -->") ?? false,
      labels: { runtime: "ZCode", hook: "Hooks ", instructions: "协作协议" },
    }),
    workbuddy: result({
      runtimeAvailable: null,
      mcpConfigured: hasWorkbuddyBridge(workbuddyMcp, "stdio.js"),
      hookConfigured: hasUsableHook(workbuddyMcp, "stdio.js", hookExists),
      instructionsConfigured:
        contents.workbuddySkill?.includes("<!-- AGENT-OFFICE:BEGIN -->") ?? false,
      labels: { runtime: "WorkBuddy", hook: "桥接 ", instructions: "SKILL 协议" },
    }),
    opencode: result({
      runtimeAvailable: runtime.opencode,
      mcpConfigured: hasOpencodeMcpServer(opencodeConfig, "agent-office", mcpUrl),
      hookConfigured: contents.opencodePlugin?.includes("plugin") === true,
      instructionsConfigured:
        contents.opencodeInstructions?.includes("<!-- AGENT-OFFICE:BEGIN -->") ?? false,
      labels: { runtime: "OpenCode", hook: "插件 ", instructions: "协作协议" },
    }),
    kimi: result({
      runtimeAvailable: runtime.kimi,
      mcpConfigured: hasMcpServer(kimiMcp, "agent-office", mcpUrl),
      hookConfigured: hasKimiHook(kimiConfig, "kimi-hook.mjs"),
      instructionsConfigured:
        contents.kimiInstructions?.includes("<!-- AGENT-OFFICE:BEGIN -->") ?? false,
      labels: { runtime: "Kimi CLI", hook: "Hooks ", instructions: "协作协议" },
    }),
    qoder: result({
      runtimeAvailable: runtime.qoder,
      mcpConfigured: hasMcpServer(qoderSettings, "agent-office", mcpUrl),
      hookConfigured: hasQoderHook(qoderSettings, "qoder-hook.mjs"),
      instructionsConfigured:
        contents.qoderInstructions?.includes("<!-- AGENT-OFFICE:BEGIN -->") ?? false,
      labels: { runtime: "Qoder", hook: "Hooks ", instructions: "协作协议" },
    }),
    kilo: result({
      runtimeAvailable: runtime.kilo,
      mcpConfigured: hasOpencodeMcpServer(kiloConfig, "agent-office", mcpUrl),
      // Kilo 无 hooks 机制，视为无需配置即满足
      hookConfigured: true,
      instructionsConfigured:
        contents.kiloInstructions?.includes("<!-- AGENT-OFFICE:BEGIN -->") ?? false,
      labels: { runtime: "Kilo CLI", hook: "— ", instructions: "协作协议" },
    }),
    trae: result({
      runtimeAvailable: null,
      mcpConfigured: hasMcpServer(traeMcp, "agent-office", mcpUrl),
      // Trae 无 hooks 机制，视为无需配置即满足
      hookConfigured: true,
      instructionsConfigured: null,
      labels: { runtime: "Trae", hook: "— " },
    }),
  };
}

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export async function readOfficeHealth(input: {
  port: number;
  dataDir: string;
  cursorKey: boolean;
}): Promise<OfficeHealth> {
  const userHome = homedir();
  const mcpUrl = `http://127.0.0.1:${input.port}/mcp`;
  const [codexCli, claudeCli, opencodeCli, kimiCli, qoderCli, kiloCli] = await Promise.all([
    cliExists("codex"),
    cliExists("claude"),
    cliExists("opencode"),
    cliExists("kimi"),
    cliExists("qodercli"),
    cliExists("kilo"),
  ]);
  const integrations = inspectIntegrationConfigs(
    {
      cursorMcp: read(join(userHome, ".cursor", "mcp.json")),
      cursorHooks: read(join(userHome, ".cursor", "hooks.json")),
      codexConfig: read(join(userHome, ".codex", "config.toml")),
      codexInstructions: read(join(userHome, ".codex", "AGENTS.md")),
      claudeMcp: read(join(userHome, ".claude.json")),
      claudeSettings: read(join(userHome, ".claude", "settings.json")),
      zcodeConfig: read(join(userHome, ".zcode", "cli", "config.json")),
      zcodeInstructions: read(join(userHome, ".zcode", "AGENTS.md")),
      workbuddyMcp: read(join(userHome, ".workbuddy", "mcp.json")),
      workbuddySkill: read(join(userHome, ".workbuddy", "skills", "agent-office", "SKILL.md")),
      opencodeConfig: read(join(userHome, ".config", "opencode", "opencode.json")),
      opencodeInstructions: read(join(userHome, ".config", "opencode", "AGENTS.md")),
      opencodePlugin: read(join(userHome, ".config", "opencode", "plugins", "agent-office.mjs")),
      kimiMcp: read(join(userHome, ".kimi-code", "mcp.json")),
      kimiConfig: read(join(userHome, ".kimi-code", "config.toml")),
      kimiInstructions: read(join(userHome, ".kimi-code", "SYSTEM.md")),
      qoderSettings: read(join(userHome, ".qoder", "settings.json")),
      qoderInstructions: read(join(userHome, ".qoder", "AGENTS.md")),
      kiloConfig: read(join(userHome, ".config", "kilocode", "kilocode.json")),
      kiloInstructions: read(join(userHome, ".config", "kilocode", "AGENTS.md")),
      traeMcp: read(join(process.env.APPDATA ?? userHome, "Trae CN", "User", "mcp.json")),
    },
    { codex: codexCli, claude: claudeCli, opencode: opencodeCli, kimi: kimiCli, qoder: qoderCli, kilo: kiloCli },
    mcpUrl,
  );
  return {
    ok: true,
    port: input.port,
    dataDir: input.dataDir,
    codexCli,
    claudeCli,
    opencodeCli,
    cursorKey: input.cursorKey,
    integrations,
  };
}
