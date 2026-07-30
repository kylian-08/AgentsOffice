import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHookCommands,
  resolveHookNode,
  resolveHooksSourceDir,
} from "../src/setup/install.js";

describe("接入安装资源路径", () => {
  it("桌面包优先使用主进程注入的 hooks 目录", () => {
    const bundled = resolve("D:/AgentOffice/resources/app/hooks");

    expect(resolveHooksSourceDir({ AGENT_OFFICE_HOOKS_DIR: bundled })).toBe(bundled);
  });

  it("源码运行时仍能找到仓库 hooks 目录", () => {
    expect(existsSync(resolve(resolveHooksSourceDir({}), "codex-notify.mjs"))).toBe(true);
  });

  it("Electron Hub 必须使用主进程发现的系统 Node", () => {
    const node = resolve("C:/Program Files/nodejs/node.exe");
    expect(resolveHookNode({ AGENT_OFFICE_HOOK_NODE: node }, "AgentOffice.exe", true)).toBe(node);
    expect(() => resolveHookNode({}, "AgentOffice.exe", true)).toThrow("系统 Node.js");
  });

  it("三个 Hook 命令都携带稳定脚本路径和 Hub 地址", () => {
    const node = resolve("C:/Program Files/nodejs/node.exe");
    const hooks = resolve("C:/Users/test/.agent-office/hooks");
    const baseUrl = "http://127.0.0.1:4519";
    const commands = buildHookCommands(node, hooks, baseUrl);

    expect(commands.cursor).toContain(resolve(hooks, "cursor-hook.mjs"));
    expect(commands.cursor).toContain(baseUrl);
    expect(commands.codexNotify).toEqual([
      node,
      resolve(hooks, "codex-notify.mjs"),
      baseUrl,
    ]);
    expect(commands.claude).toContain(resolve(hooks, "claude-hook.mjs"));
    expect(commands.claude).toContain(baseUrl);
  });
});
