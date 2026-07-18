import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OfficeBus } from "../src/domain/bus.js";
import { OfficeService } from "../src/domain/office.js";
import { buildCodexExecArgs, createManagedDispatcher } from "../src/domain/runners.js";
import { OfficeStore } from "../src/domain/store.js";
import { handleClaudeHook } from "../src/integrations/ingest.js";
import {
  mergeClaudeMcpJson,
  mergeClaudeSettings,
  removeFromClaudeSettings,
} from "../src/setup/merge.js";

function makeOffice() {
  const store = new OfficeStore(":memory:");
  return new OfficeService(store, new OfficeBus());
}

describe("Agent 改名与模型", () => {
  it("改名成功并保留消息关联", () => {
    const office = makeOffice();
    const agent = office.store.registerAgent({ name: "codex-old", kind: "codex-cli" });
    office.sendMessage({ fromName: "老板", text: "@codex-old 干活" });

    const renamed = office.renameAgent(agent.id, { name: "codex-新名", model: "gpt-5.6-sol" });
    expect(renamed?.name).toBe("codex-新名");
    expect((renamed?.meta as any).model).toBe("gpt-5.6-sol");
    // 旧消息通过 ID 关联，改名后收件箱不丢
    expect(office.store.pendingCount(agent.id)).toBe(1);
    const inbox = office.readInbox("codex-新名");
    expect(inbox?.messages).toHaveLength(1);
  });

  it("工号冲突返回 null", () => {
    const office = makeOffice();
    office.store.registerAgent({ name: "a1", kind: "codex-cli" });
    const b = office.store.registerAgent({ name: "b1", kind: "codex-cli" });
    expect(office.renameAgent(b.id, { name: "a1" })).toBeNull();
  });

  it("仅更新模型不改名", () => {
    const office = makeOffice();
    const agent = office.store.registerAgent({ name: "a1", kind: "cursor-ide" });
    const updated = office.renameAgent(agent.id, { model: "opus-4.8" });
    expect(updated?.name).toBe("a1");
    expect((updated?.meta as any).model).toBe("opus-4.8");
  });
});

describe("主管分派", () => {
  it("自动分派优先选择空闲托管成员", () => {
    const office = makeOffice();
    const dispatched: string[] = [];
    office.setManagedDispatcher((agent) => dispatched.push(agent.name));
    office.store.registerAgent({ name: "cursor-手工", kind: "cursor-ide" });
    office.store.registerAgent({ name: "codex-托管", kind: "codex-managed" });

    const result = office.dispatchWork({ title: "修复登录", auto: true });
    expect(result?.assignedTo).toEqual(["codex-托管"]);
    expect(dispatched).toEqual(["codex-托管"]);
    const task = office.store.listTasks()[0];
    expect(task.assigneeName).toBe("codex-托管");
  });

  it("无托管成员时选未读最少的在线手工会话", () => {
    const office = makeOffice();
    office.store.registerAgent({ name: "a1", kind: "codex-cli" });
    office.store.registerAgent({ name: "a2", kind: "cursor-ide" });
    office.sendMessage({ fromName: "老板", text: "@a1 先垫一条未读" });

    const result = office.dispatchWork({ title: "写文档", auto: true });
    expect(result?.assignedTo).toEqual(["a2"]);
  });

  it("用户指定多个成员时全部收到消息", () => {
    const office = makeOffice();
    office.store.registerAgent({ name: "a1", kind: "codex-cli" });
    office.store.registerAgent({ name: "a2", kind: "claude-cli" });
    const result = office.dispatchWork({ title: "联调", agentNames: ["a1", "a2"] });
    expect(result?.assignedTo.sort()).toEqual(["a1", "a2"]);
    const a1 = office.store.getAgentByName("a1")!;
    const a2 = office.store.getAgentByName("a2")!;
    expect(office.store.pendingCount(a1.id)).toBe(1);
    expect(office.store.pendingCount(a2.id)).toBe(1);
  });

  it("没有可用成员时返回 null", () => {
    const office = makeOffice();
    expect(office.dispatchWork({ title: "没人干", auto: true })).toBeNull();
  });

  it("@主管 消息触发自动分派", () => {
    const office = makeOffice();
    office.store.registerAgent({ name: "codex-托管", kind: "codex-managed" });
    const dispatched: string[] = [];
    office.setManagedDispatcher((agent) => dispatched.push(agent.name));

    const result = office.sendMessage({ fromName: "老板", text: "@主管 处理一下超分服务报警" });
    expect(result.routed).toContainEqual({ name: "主管", mode: "supervisor" });
    expect(dispatched).toEqual(["codex-托管"]);
    expect(office.store.listTasks()).toHaveLength(1);
    expect(office.store.listTasks()[0].title).toContain("超分服务报警");
  });
});

describe("Claude hooks 摄入", () => {
  it("SessionStart 登记并返回 hookSpecificOutput", () => {
    const office = makeOffice();
    const out = handleClaudeHook(office, {
      hook_event_name: "SessionStart",
      session_id: "sess-abc",
      cwd: "D:\\字字动画",
    }) as any;
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("claude-");
    const agent = office.store.listAgents().find((a) => a.kind === "claude-cli");
    expect(agent?.workspace).toBe("D:\\字字动画");
  });

  it("Stop 从 transcript 提取最后助手消息为兜底简报（幂等）", () => {
    const office = makeOffice();
    const dir = mkdtempSync(join(tmpdir(), "claude-transcript-"));
    const transcript = join(dir, "t.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "修一下" } }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "已修复并通过测试。" }] },
        }),
      ].join("\n"),
      "utf8",
    );
    const payload = {
      hook_event_name: "Stop",
      session_id: "sess-abc",
      transcript_path: transcript,
    };
    handleClaudeHook(office, payload);
    handleClaudeHook(office, payload);
    const briefs = office.store.listBriefs();
    expect(briefs).toHaveLength(1);
    expect(briefs[0].result).toBe("已修复并通过测试。");
    expect(briefs[0].source).toBe("claude-hook");
  });

  it("PreToolUse 更新实时活动", () => {
    const office = makeOffice();
    handleClaudeHook(office, {
      hook_event_name: "PreToolUse",
      session_id: "sess-x",
      tool_name: "Bash",
    });
    const agent = office.store.listAgents().find((a) => a.kind === "claude-cli")!;
    expect((agent.meta as any).lastActivity).toContain("Bash");
  });
});

describe("Claude 配置合并", () => {
  const CMD = '"C:\\node.exe" "D:\\office\\hooks\\claude-hook.mjs"';

  it("settings.json 合并幂等且保留用户 hook", () => {
    const existing = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "my-audit.sh" }] }] },
      model: "opus",
    });
    const once = mergeClaudeSettings(existing, CMD);
    const twice = mergeClaudeSettings(once, CMD);
    const doc = JSON.parse(twice);
    expect(doc.model).toBe("opus");
    expect(doc.hooks.Stop).toHaveLength(2);
    expect(doc.hooks.SessionStart).toHaveLength(1);
    expect(doc.hooks.UserPromptSubmit[0].hooks[0].command).toBe(CMD);
  });

  it("卸载只移除我们的 hook", () => {
    const existing = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "my-audit.sh" }] }] },
    });
    const merged = mergeClaudeSettings(existing, CMD);
    const removed = JSON.parse(removeFromClaudeSettings(merged));
    expect(removed.hooks.Stop).toHaveLength(1);
    expect(removed.hooks.SessionStart).toBeUndefined();
  });

  it(".mcp.json 合并保留既有 server", () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: "x" } } });
    const doc = JSON.parse(mergeClaudeMcpJson(existing, "http://127.0.0.1:4517/mcp"));
    expect(doc.mcpServers.other.command).toBe("x");
    expect(doc.mcpServers["agent-office"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:4517/mcp",
    });
  });
});

describe("codex exec 参数拼装", () => {
  it("首轮：--sandbox 与 -C 直传", () => {
    const args = buildCodexExecArgs({ sandbox: "workspace-write" }, "D:\\proj");
    expect(args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-C",
      "D:\\proj",
      "-",
    ]);
  });

  it("续聊：resume 不接受 --sandbox/-C，改用 -c sandbox_mode", () => {
    const args = buildCodexExecArgs({ threadId: "t-1", sandbox: "read-only" }, "D:\\proj");
    expect(args).toEqual([
      "exec",
      "resume",
      "t-1",
      "--json",
      "--skip-git-repo-check",
      "-c",
      "sandbox_mode=read-only",
      "-",
    ]);
    expect(args).not.toContain("--sandbox");
    expect(args).not.toContain("-C");
  });
});

describe("托管执行失败路径", () => {
  it("失败也标记收件箱已读，重复错误折叠", async () => {
    const office = makeOffice();
    const dispatch = createManagedDispatcher(
      office,
      { port: 0, dataDir: "", cursorModel: "auto", codexTurnTimeoutMs: 1000 } as any,
      {
        "codex-managed": async () => {
          throw new Error("error: unexpected argument '--sandbox' found\n  tip: ...");
        },
      },
    );
    office.setManagedDispatcher(dispatch);
    const agent = office.store.registerAgent({ name: "codex-x", kind: "codex-managed" });

    office.sendMessage({ fromName: "老板", text: "@codex-x 干活" });
    await vi.waitFor(() => expect(office.store.pendingCount(agent.id)).toBe(0));

    office.sendMessage({ fromName: "老板", text: "@codex-x 干活" });
    await vi.waitFor(() => {
      const errors = office.store
        .listEvents()
        .filter((e) => e.type === "run-error");
      expect(errors).toHaveLength(2);
      // 第二条相同错误被折叠，不再重复长文本
      expect(errors.some((e) => e.text?.includes("相同的错误"))).toBe(true);
    });
    expect(office.store.pendingCount(agent.id)).toBe(0);
    // 错误文本被压成单行
    const first = office.store.listEvents().find((e) => e.type === "run-error");
    expect(first?.text).not.toContain("\n");
  });
});

describe("活动记录", () => {
  it("setActivity 写入 meta 并可清除", () => {
    const office = makeOffice();
    const agent = office.store.registerAgent({ name: "a1", kind: "cursor-ide" });
    office.setActivity(agent.id, "执行命令：npm test");
    let fresh = office.store.getAgentById(agent.id)!;
    expect((fresh.meta as any).lastActivity).toBe("执行命令：npm test");
    office.setActivity(agent.id, null);
    fresh = office.store.getAgentById(agent.id)!;
    expect((fresh.meta as any).lastActivity).toBeNull();
  });
});
