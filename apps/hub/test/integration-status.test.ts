import { describe, expect, it } from "vitest";
import { inspectIntegrationConfigs } from "../src/setup/status.js";

const url = "http://127.0.0.1:4517/mcp";

describe("接入健康诊断", () => {
  it("只有 CLI 时不会把 Codex 标成可用", () => {
    const result = inspectIntegrationConfigs(
      {
        cursorMcp: null,
        cursorHooks: null,
        codexConfig: "[mcp_servers.node_repl]\ncommand = 'node'\n",
        codexInstructions: null,
        claudeMcp: null,
        claudeSettings: null,
      },
      { codex: true, claude: true },
      url,
      () => true,
    );

    expect(result.codex.ready).toBe(false);
    expect(result.codex.issues).toContain("MCP 未配置");
    expect(result.codex.issues).toContain("Notify 未配置");
    expect(result.codex.issues).toContain("协作协议未配置");
  });

  it("结构化识别三家完整接入配置", () => {
    const result = inspectIntegrationConfigs(
      {
        cursorMcp: JSON.stringify({ mcpServers: { "agent-office": { url } } }),
        cursorHooks: JSON.stringify({ hooks: { sessionStart: [{ command: "cursor-hook.mjs" }] } }),
        codexConfig: `notify = ["node", "codex-notify.mjs"]\n[mcp_servers.agent_office]\nurl = "${url}"\n`,
        codexInstructions: "<!-- AGENT-OFFICE:BEGIN -->\n规则\n<!-- AGENT-OFFICE:END -->",
        claudeMcp: JSON.stringify({ mcpServers: { "agent-office": { type: "http", url } } }),
        claudeSettings: JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "claude-hook.mjs" }] }] } }),
      },
      { codex: true, claude: true },
      url,
      () => true,
    );

    expect(result.cursor.ready).toBe(true);
    expect(result.codex.ready).toBe(true);
    expect(result.claude.ready).toBe(true);
  });

  it("配置损坏时返回缺失状态而不是抛错", () => {
    const result = inspectIntegrationConfigs(
      {
        cursorMcp: "{broken",
        cursorHooks: "[]",
        codexConfig: "not = [valid",
        codexInstructions: "",
        claudeMcp: "null",
        claudeSettings: "{}",
      },
      { codex: false, claude: false },
      url,
      () => false,
    );

    expect(result.cursor.ready).toBe(false);
    expect(result.codex.runtimeAvailable).toBe(false);
    expect(result.claude.ready).toBe(false);
  });

  it("Hook 配置指向不存在的脚本时不会标成可用", () => {
    const result = inspectIntegrationConfigs(
      {
        cursorMcp: JSON.stringify({ mcpServers: { "agent-office": { url } } }),
        cursorHooks: JSON.stringify({ hooks: { sessionStart: [{ command: "missing/cursor-hook.mjs" }] } }),
        codexConfig: `notify = ["node", "missing/codex-notify.mjs"]\n[mcp_servers.agent_office]\nurl = "${url}"\n`,
        codexInstructions: "<!-- AGENT-OFFICE:BEGIN -->",
        claudeMcp: JSON.stringify({ mcpServers: { "agent-office": { url } } }),
        claudeSettings: JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "missing/claude-hook.mjs" }] }] } }),
      },
      { codex: true, claude: true },
      url,
      () => false,
    );

    expect(result.cursor.issues).toContain("Hooks 未配置");
    expect(result.codex.issues).toContain("Notify 未配置");
    expect(result.claude.issues).toContain("Hooks 未配置");
  });
});
