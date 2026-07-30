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
}

interface RuntimeAvailability {
  codex: boolean;
  claude: boolean;
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
  const [codexCli, claudeCli] = await Promise.all([cliExists("codex"), cliExists("claude")]);
  const integrations = inspectIntegrationConfigs(
    {
      cursorMcp: read(join(userHome, ".cursor", "mcp.json")),
      cursorHooks: read(join(userHome, ".cursor", "hooks.json")),
      codexConfig: read(join(userHome, ".codex", "config.toml")),
      codexInstructions: read(join(userHome, ".codex", "AGENTS.md")),
      claudeMcp: read(join(userHome, ".claude.json")),
      claudeSettings: read(join(userHome, ".claude", "settings.json")),
    },
    { codex: codexCli, claude: claudeCli },
    mcpUrl,
  );
  return {
    ok: true,
    port: input.port,
    dataDir: input.dataDir,
    codexCli,
    claudeCli,
    cursorKey: input.cursorKey,
    integrations,
  };
}
