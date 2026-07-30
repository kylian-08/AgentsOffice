import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  mergeCodexToml,
  getCodexNotifyCommand,
  mergeHooksJson,
  mergeMcpJson,
  removeFromCodexToml,
  removeFromHooksJson,
  removeFromMcpJson,
  removeMarkerBlock,
  upsertMarkerBlock,
} from "../src/setup/merge.js";

const MCP_URL = "http://127.0.0.1:4517/mcp";

describe("mergeMcpJson", () => {
  it("空文件生成合法配置", () => {
    const out = JSON.parse(mergeMcpJson(null, MCP_URL));
    expect(out.mcpServers["agent-office"].url).toBe(MCP_URL);
  });

  it("保留既有 server", () => {
    const existing = JSON.stringify({ mcpServers: { blender: { command: "uv" } } });
    const out = JSON.parse(mergeMcpJson(existing, MCP_URL));
    expect(out.mcpServers.blender.command).toBe("uv");
    expect(out.mcpServers["agent-office"].url).toBe(MCP_URL);
  });

  it("幂等：重复合并不产生变化", () => {
    const once = mergeMcpJson(null, MCP_URL);
    const twice = mergeMcpJson(once, MCP_URL);
    expect(twice).toBe(once);
  });

  it("卸载后恢复原样", () => {
    const existing = JSON.stringify({ mcpServers: { blender: { command: "uv" } } }, null, 2);
    const merged = mergeMcpJson(existing, MCP_URL);
    const removed = JSON.parse(removeFromMcpJson(merged));
    expect(removed.mcpServers["agent-office"]).toBeUndefined();
    expect(removed.mcpServers.blender.command).toBe("uv");
  });

  it("非法 JSON 抛出明确错误", () => {
    expect(() => mergeMcpJson("{oops", MCP_URL)).toThrow("mcp.json");
  });
});

describe("mergeHooksJson", () => {
  const CMD = '"C:\\node.exe" "D:\\office\\hooks\\cursor-hook.mjs"';

  it("写入五个事件且幂等", () => {
    const once = mergeHooksJson(null, CMD);
    const twice = mergeHooksJson(once, CMD);
    const doc = JSON.parse(twice);
    for (const event of ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse", "stop", "sessionEnd"]) {
      expect(doc.hooks[event]).toHaveLength(1);
      expect(doc.hooks[event][0].command).toBe(CMD);
    }
  });

  it("保留用户已有 hook", () => {
    const existing = JSON.stringify({
      version: 1,
      hooks: { stop: [{ command: "./my-audit.sh" }] },
    });
    const doc = JSON.parse(mergeHooksJson(existing, CMD));
    expect(doc.hooks.stop).toHaveLength(2);
    expect(doc.hooks.stop[0].command).toBe("./my-audit.sh");
  });

  it("卸载只移除我们的条目", () => {
    const existing = JSON.stringify({
      version: 1,
      hooks: { stop: [{ command: "./my-audit.sh" }] },
    });
    const merged = mergeHooksJson(existing, CMD);
    const removed = JSON.parse(removeFromHooksJson(merged)!);
    expect(removed.hooks.stop).toHaveLength(1);
    expect(removed.hooks.stop[0].command).toBe("./my-audit.sh");
    expect(removed.hooks.sessionStart).toBeUndefined();
  });
});

describe("upsertMarkerBlock", () => {
  it("追加与替换幂等", () => {
    const original = "# AGENTS\n\n既有内容\n";
    const once = upsertMarkerBlock(original, "协作协议 v1");
    expect(once).toContain("既有内容");
    expect(once).toContain("协作协议 v1");
    const updated = upsertMarkerBlock(once, "协作协议 v2");
    expect(updated).toContain("协作协议 v2");
    expect(updated).not.toContain("协作协议 v1");
    expect(updated.match(/AGENT-OFFICE:BEGIN/g)).toHaveLength(1);
  });

  it("移除后不留标记", () => {
    const withBlock = upsertMarkerBlock("# Title\n", "内容");
    const removed = removeMarkerBlock(withBlock);
    expect(removed).not.toContain("AGENT-OFFICE");
    expect(removed).toContain("# Title");
  });
});

describe("mergeCodexToml", () => {
  const NOTIFY = ["C:\\node.exe", "D:\\office\\hooks\\codex-notify.mjs"];

  it("保留既有配置并添加 MCP 与 notify", () => {
    const existing = [
      'model = "gpt-5.6-sol"',
      "",
      "[mcp_servers.blender]",
      'command = "uv.exe"',
      "",
      "[projects.'D:\\ZZDH']",
      'trust_level = "trusted"',
    ].join("\n");
    const { toml, notifySkipped } = mergeCodexToml(existing, {
      mcpUrl: MCP_URL,
      notifyCommand: NOTIFY,
    });
    expect(notifySkipped).toBe(false);
    const doc = parseToml(toml) as any;
    expect(doc.model).toBe("gpt-5.6-sol");
    expect(doc.mcp_servers.blender.command).toBe("uv.exe");
    expect(doc.mcp_servers.agent_office.url).toBe(MCP_URL);
    expect(doc.notify).toEqual(NOTIFY);
    expect(doc.projects["D:\\ZZDH"].trust_level).toBe("trusted");
  });

  it("已有他人 notify 时跳过且不覆盖", () => {
    const existing = 'notify = ["python", "other.py"]';
    const { toml, notifySkipped } = mergeCodexToml(existing, {
      mcpUrl: MCP_URL,
      notifyCommand: NOTIFY,
    });
    expect(notifySkipped).toBe(true);
    const doc = parseToml(toml) as any;
    expect(doc.notify).toEqual(["python", "other.py"]);
  });

  it("显式链式接管时替换 notify，并能在卸载时恢复", () => {
    const previous = ["codex-computer-use.exe", "turn-ended"];
    const chainPath = "D:\\office\\hooks\\codex-notify-chain.json";
    const chained = [...NOTIFY, chainPath];
    const { toml, notifySkipped } = mergeCodexToml(
      `notify = ["${previous[0]}", "${previous[1]}"]`,
      {
        mcpUrl: MCP_URL,
        notifyCommand: chained,
        replaceExistingNotify: true,
      },
    );

    expect(notifySkipped).toBe(false);
    expect(getCodexNotifyCommand(toml)).toEqual(chained);
    const restored = parseToml(
      removeFromCodexToml(toml, (path) => (path === chainPath ? previous : null)),
    ) as any;
    expect(restored.notify).toEqual(previous);
  });

  it("我们自己的 notify 可以重复合并", () => {
    const first = mergeCodexToml(null, { mcpUrl: MCP_URL, notifyCommand: NOTIFY });
    const second = mergeCodexToml(first.toml, { mcpUrl: MCP_URL, notifyCommand: NOTIFY });
    expect(second.notifySkipped).toBe(false);
  });

  it("卸载移除我们的键并保留其余", () => {
    const { toml } = mergeCodexToml('model = "x"\n[mcp_servers.blender]\ncommand = "uv"', {
      mcpUrl: MCP_URL,
      notifyCommand: NOTIFY,
    });
    const doc = parseToml(removeFromCodexToml(toml)) as any;
    expect(doc.mcp_servers.agent_office).toBeUndefined();
    expect(doc.mcp_servers.blender.command).toBe("uv");
    expect(doc.notify).toBeUndefined();
    expect(doc.model).toBe("x");
  });
});
