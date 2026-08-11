import { describe, expect, it } from "vitest";
import { inspectIntegrationConfigs } from "../src/setup/status.js";

const url = "http://127.0.0.1:4517/mcp";

/** 带新字段的完整（缺省）输入 */
function baseInput(): Record<string, string | null> {
  return {
    cursorMcp: null,
    cursorHooks: null,
    codexConfig: null,
    codexInstructions: null,
    claudeMcp: null,
    claudeSettings: null,
    zcodeConfig: null,
    zcodeInstructions: null,
    workbuddyMcp: null,
    workbuddySkill: null,
    opencodeConfig: null,
    opencodeInstructions: null,
    opencodePlugin: null,
    kimiMcp: null,
    kimiConfig: null,
    kimiInstructions: null,
    qoderSettings: null,
    qoderInstructions: null,
    kiloConfig: null,
    kiloInstructions: null,
    traeMcp: null,
  };
}

const NO_RUNTIME = { codex: false, claude: false, opencode: false, kimi: false, qoder: false, kilo: false } as const;

describe("接入健康诊断", () => {
  it("只有 CLI 时不会把 Codex 标成可用", () => {
    const result = inspectIntegrationConfigs(
      {
        ...baseInput(),
        codexConfig: "[mcp_servers.node_repl]\ncommand = 'node'\n",
      },
      { codex: true, claude: true, opencode: false },
      url,
      () => true,
    );

    expect(result.codex.ready).toBe(false);
    expect(result.codex.issues).toContain("MCP 未配置");
    expect(result.codex.issues).toContain("Notify 未配置");
    expect(result.codex.issues).toContain("协作协议未配置");
  });

  it("结构化识别十家完整接入配置", () => {
    const zcodeConfig = JSON.stringify({
      mcp: { servers: { "agent-office": { type: "http", url } } },
      hooks: {
        enabled: true,
        events: {
          SessionStart: [{ hooks: [{ type: "process", command: "node", args: ["zcode-hook.mjs"] }] }],
        },
      },
    });
    const workbuddyMcp = JSON.stringify({
      mcpServers: {
        "agent-office": { command: "node", args: ["stdio.js", url] },
      },
    });
    const opencodeConfig = JSON.stringify({
      mcp: { "agent-office": { type: "remote", url, enabled: true } },
    });
    const kimiMcp = JSON.stringify({ mcpServers: { "agent-office": { url } } });
    const kimiConfig = `[[hooks]]\nevent = "SessionStart"\ncommand = "node kimi-hook.mjs"\n`;
    const qoderSettings = JSON.stringify({
      mcpServers: { "agent-office": { url } },
      hooks: { SessionStart: [{ command: "node qoder-hook.mjs" }] },
    });
    const kiloConfig = JSON.stringify({
      mcp: { "agent-office": { type: "remote", url, enabled: true } },
    });
    const traeMcp = JSON.stringify({ mcpServers: { "agent-office": { url } } });
    const result = inspectIntegrationConfigs(
      {
        cursorMcp: JSON.stringify({ mcpServers: { "agent-office": { url } } }),
        cursorHooks: JSON.stringify({ hooks: { sessionStart: [{ command: "cursor-hook.mjs" }] } }),
        codexConfig: `notify = ["node", "codex-notify.mjs"]\n[mcp_servers.agent_office]\nurl = "${url}"\n`,
        codexInstructions: "<!-- AGENT-OFFICE:BEGIN -->\n规则\n<!-- AGENT-OFFICE:END -->",
        claudeMcp: JSON.stringify({ mcpServers: { "agent-office": { type: "http", url } } }),
        claudeSettings: JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "claude-hook.mjs" }] }] } }),
        zcodeConfig,
        zcodeInstructions: "<!-- AGENT-OFFICE:BEGIN -->\n规则\n<!-- AGENT-OFFICE:END -->",
        workbuddyMcp,
        workbuddySkill: "<!-- AGENT-OFFICE:BEGIN -->\n规则\n<!-- AGENT-OFFICE:END -->",
        opencodeConfig,
        opencodeInstructions: "<!-- AGENT-OFFICE:BEGIN -->\n规则\n<!-- AGENT-OFFICE:END -->",
        opencodePlugin: "export const plugin = async () => ({ event: async () => {} });",
        kimiMcp,
        kimiConfig,
        kimiInstructions: "<!-- AGENT-OFFICE:BEGIN -->\n规则\n<!-- AGENT-OFFICE:END -->",
        qoderSettings,
        qoderInstructions: "<!-- AGENT-OFFICE:BEGIN -->\n规则\n<!-- AGENT-OFFICE:END -->",
        kiloConfig,
        kiloInstructions: "<!-- AGENT-OFFICE:BEGIN -->\n规则\n<!-- AGENT-OFFICE:END -->",
        traeMcp,
      },
      { codex: true, claude: true, opencode: true, kimi: true, qoder: true, kilo: true },
      url,
      () => true,
    );

    expect(result.cursor.ready).toBe(true);
    expect(result.codex.ready).toBe(true);
    expect(result.claude.ready).toBe(true);
    expect(result.zcode.ready).toBe(true);
    expect(result.workbuddy.ready).toBe(true);
    expect(result.opencode.ready).toBe(true);
    expect(result.kimi.ready).toBe(true);
    expect(result.qoder.ready).toBe(true);
    expect(result.kilo.ready).toBe(true);
    expect(result.trae.ready).toBe(true);
  });

  it("Kimi/Qoder 缺 hooks 或协议块时不算接入完成", () => {
    const result = inspectIntegrationConfigs(
      {
        ...baseInput(),
        kimiMcp: JSON.stringify({ mcpServers: { "agent-office": { url } } }),
        qoderSettings: JSON.stringify({ mcpServers: { "agent-office": { url } } }),
      },
      { ...NO_RUNTIME, kimi: true, qoder: true },
      url,
      () => true,
    );

    expect(result.kimi.mcpConfigured).toBe(true);
    expect(result.kimi.hookConfigured).toBe(false);
    expect(result.kimi.ready).toBe(false);
    expect(result.qoder.hookConfigured).toBe(false);
    expect(result.qoder.ready).toBe(false);
  });

  it("OpenCode 缺插件或协议块时不算接入完成", () => {
    const result = inspectIntegrationConfigs(
      {
        ...baseInput(),
        opencodeConfig: JSON.stringify({
          mcp: { "agent-office": { type: "remote", url, enabled: true } },
        }),
        opencodeInstructions: "<!-- AGENT-OFFICE:BEGIN -->",
        opencodePlugin: null,
      },
      NO_RUNTIME,
      url,
      () => true,
    );

    expect(result.opencode.mcpConfigured).toBe(true);
    expect(result.opencode.hookConfigured).toBe(false);
    expect(result.opencode.ready).toBe(false);
    expect(result.opencode.issues).toContain("插件 未配置");
  });

  it("ZCode 缺 hooks.enabled 或协议块时不算接入完成", () => {
    const result = inspectIntegrationConfigs(
      {
        ...baseInput(),
        zcodeConfig: JSON.stringify({
          mcp: { servers: { "agent-office": { type: "http", url } } },
          // 没有 enabled: true —— 配置 hooks 不会执行
          hooks: { events: {} },
        }),
        zcodeInstructions: "<!-- AGENT-OFFICE:BEGIN -->",
      },
      { codex: false, claude: false, opencode: false },
      url,
      () => true,
    );

    expect(result.zcode.mcpConfigured).toBe(true);
    expect(result.zcode.hookConfigured).toBe(false);
    expect(result.zcode.ready).toBe(false);
  });

  it("WorkBuddy 缺桥接脚本或 SKILL 协议时不算接入完成", () => {
    const result = inspectIntegrationConfigs(
      {
        ...baseInput(),
        workbuddyMcp: JSON.stringify({
          mcpServers: { "agent-office": { command: "node", args: ["missing/stdio.js"] } },
        }),
        workbuddySkill: null,
      },
      { codex: false, claude: false, opencode: false },
      url,
      () => false,
    );

    expect(result.workbuddy.ready).toBe(false);
    expect(result.workbuddy.issues).toContain("桥接 未配置");
    expect(result.workbuddy.issues).toContain("SKILL 协议未配置");
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
        zcodeConfig: "{broken",
        zcodeInstructions: "",
        workbuddyMcp: "null",
        workbuddySkill: "",
        opencodeConfig: "{broken",
        opencodeInstructions: "",
        opencodePlugin: null,
        kimiMcp: "null",
        kimiConfig: "not = [valid",
        kimiInstructions: "",
        qoderSettings: "{broken",
        qoderInstructions: "",
        kiloConfig: "{broken",
        kiloInstructions: "",
        traeMcp: "null",
      },
      NO_RUNTIME,
      url,
      () => false,
    );

    expect(result.cursor.ready).toBe(false);
    expect(result.codex.runtimeAvailable).toBe(false);
    expect(result.claude.ready).toBe(false);
    expect(result.zcode.ready).toBe(false);
    expect(result.workbuddy.ready).toBe(false);
    expect(result.opencode.ready).toBe(false);
    expect(result.kimi.ready).toBe(false);
    expect(result.qoder.ready).toBe(false);
    expect(result.kilo.ready).toBe(false);
    expect(result.trae.ready).toBe(false);
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
        zcodeConfig: JSON.stringify({
          mcp: { servers: { "agent-office": { type: "http", url } } },
          hooks: { enabled: true, events: { SessionStart: [{ hooks: [{ type: "process", command: "node", args: ["missing/zcode-hook.mjs"] }] }] } },
        }),
        zcodeInstructions: "<!-- AGENT-OFFICE:BEGIN -->",
        workbuddyMcp: JSON.stringify({
          mcpServers: { "agent-office": { command: "node", args: ["missing/stdio.js"] } },
        }),
        workbuddySkill: "<!-- AGENT-OFFICE:BEGIN -->",
      },
      { codex: true, claude: true, opencode: false },
      url,
      () => false,
    );

    expect(result.cursor.issues).toContain("Hooks 未配置");
    expect(result.codex.issues).toContain("Notify 未配置");
    expect(result.claude.issues).toContain("Hooks 未配置");
    expect(result.zcode.issues).toContain("Hooks 未配置");
    expect(result.workbuddy.issues).toContain("桥接 未配置");
  });
});
