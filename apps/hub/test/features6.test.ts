import { describe, expect, it } from "vitest";
import { OfficeBus } from "../src/domain/bus.js";
import { OfficeService } from "../src/domain/office.js";
import { OfficeStore } from "../src/domain/store.js";
import {
  handleClaudeHook,
  handleCodexNotify,
  handleCursorHook,
  handleZcodeHook,
} from "../src/integrations/ingest.js";

function makeOffice() {
  const store = new OfficeStore(":memory:");
  return new OfficeService(store, new OfficeBus());
}

describe("托管孪生去重", () => {
  it("托管 Codex 的 notify 不再登记重复员工", () => {
    const office = makeOffice();
    const managed = office.store.registerAgent({
      name: "codex-画布",
      kind: "codex-managed",
      meta: { threadId: "t-abc" },
    });

    handleCodexNotify(office, {
      type: "agent-turn-complete",
      "thread-id": "t-abc",
      "last-assistant-message": "干完了",
    });

    const codexAgents = office.store.listAgents().filter((a) => a.kind === "codex-cli");
    expect(codexAgents).toHaveLength(0);
    expect(office.store.getAgentById(managed.id)!.status).toBe("online");
    // 没有产生重复简报（托管调度器自己会发）
    expect(office.store.listBriefs()).toHaveLength(0);
  });

  it("陌生 thread 的 notify 照常登记为手工会话", () => {
    const office = makeOffice();
    office.store.registerAgent({
      name: "codex-画布",
      kind: "codex-managed",
      meta: { threadId: "t-abc" },
    });
    handleCodexNotify(office, {
      type: "agent-turn-complete",
      "thread-id": "t-other",
      "last-assistant-message": "我是真人终端",
    });
    expect(office.store.listAgents().filter((a) => a.kind === "codex-cli")).toHaveLength(1);
  });

  it("托管 Claude 的 hooks 不注入、不登记", () => {
    const office = makeOffice();
    office.store.registerAgent({
      name: "claude-研发",
      kind: "claude-managed",
      meta: { sessionId: "s-abc" },
    });

    const out = handleClaudeHook(office, {
      hook_event_name: "SessionStart",
      session_id: "s-abc",
      cwd: "D:\\proj",
    });
    expect(out).toEqual({});
    expect(office.store.listAgents().filter((a) => a.kind === "claude-cli")).toHaveLength(0);
  });

  it("托管 Cursor 的 hooks 不登记重复员工", () => {
    const office = makeOffice();
    office.store.registerAgent({
      name: "cursor-研发",
      kind: "cursor-managed",
      meta: { cursorAgentId: "conv-1" },
    });
    const out = handleCursorHook(office, {
      hook_event_name: "sessionStart",
      conversation_id: "conv-1",
    });
    expect(out).toEqual({});
    expect(office.store.listAgents().filter((a) => a.kind === "cursor-ide")).toHaveLength(0);
  });
});

describe("ZCode hooks 摄入", () => {
  it("SessionStart 登记 zcode-xxxxxx 并注入协作约定", () => {
    const office = makeOffice();
    const out = handleZcodeHook(office, {
      hook_event_name: "SessionStart",
      session_id: "z-abc",
      cwd: "D:\\proj",
    });

    const agents = office.store.listAgents().filter((a) => a.kind === "zcode-cli");
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toMatch(/^zcode-/);
    expect(out.additionalContext).toContain(`你的工号是「${agents[0].name}」`);
  });

  it("Stop 用 transcript 兜底简报，SessionEnd 下线", () => {
    const office = makeOffice();
    handleZcodeHook(office, { hook_event_name: "SessionStart", session_id: "z-b" });
    const stopOut = handleZcodeHook(
      office,
      { hook_event_name: "Stop", session_id: "z-b", transcript_path: "t.jsonl" },
      () => "我把接口接完了。",
    );

    expect(stopOut).toEqual({});
    const briefs = office.store.listBriefs();
    expect(briefs).toHaveLength(1);
    expect(briefs[0].source).toBe("zcode-hook");
    expect(briefs[0].result).toContain("接口接完");

    handleZcodeHook(office, { hook_event_name: "SessionEnd", session_id: "z-b" });
    expect(office.store.listAgents().find((a) => a.kind === "zcode-cli")!.status).toBe("offline");
  });
});

describe("唤醒离席员工（转托管）", () => {
  it("codex-cli 带 threadId 可转托管，积压未读立即派发", async () => {
    const office = makeOffice();
    const dispatched: Array<{ name: string; text: string }> = [];
    office.setManagedDispatcher((agent, message) =>
      dispatched.push({ name: agent.name, text: message.text }),
    );
    const agent = office.store.registerAgent({
      name: "codex-主力",
      kind: "codex-cli",
      meta: { threadId: "t-1" },
    });
    office.sendMessage({ fromName: "老板", text: "@codex-主力 你人呢" });
    office.store.setAgentStatusQuiet(agent.id, "offline");

    const result = office.promoteAgent(agent.id);
    expect(result.ok).toBe(true);
    const fresh = office.store.getAgentById(agent.id)!;
    expect(fresh.kind).toBe("codex-managed");
    expect(fresh.status).toBe("online");
    expect((fresh.meta as any).threadId).toBe("t-1");
    // 积压消息被立即派发且收件箱清空
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].text).toContain("你人呢");
    expect(office.store.pendingCount(agent.id)).toBe(0);
  });

  it("claude-cli 带 sessionId 可转托管；cursor-ide 与无凭证的拒绝", () => {
    const office = makeOffice();
    const claude = office.store.registerAgent({
      name: "claude-git库管理",
      kind: "claude-cli",
      meta: { sessionId: "s-1" },
    });
    expect(office.promoteAgent(claude.id).ok).toBe(true);
    expect(office.store.getAgentById(claude.id)!.kind).toBe("claude-managed");

    const cursor = office.store.registerAgent({ name: "cursor-x", kind: "cursor-ide" });
    const cursorResult = office.promoteAgent(cursor.id);
    expect(cursorResult.ok).toBe(false);
    expect(cursorResult.error).toContain("Cursor");

    const bare = office.store.registerAgent({ name: "codex-裸", kind: "codex-cli" });
    expect(office.promoteAgent(bare.id).ok).toBe(false);
  });

  it("转托管后原会话的 notify 被识别为孪生，不再登记重复员工", () => {
    const office = makeOffice();
    const agent = office.store.registerAgent({
      name: "codex-主力",
      kind: "codex-cli",
      meta: { threadId: "t-1" },
    });
    office.promoteAgent(agent.id);
    handleCodexNotify(office, {
      type: "agent-turn-complete",
      "thread-id": "t-1",
      "last-assistant-message": "人类在原终端里又敲了一轮",
    });
    expect(office.store.listAgents().filter((a) => a.name.startsWith("codex-")).length).toBe(1);
  });
});

describe("闲置清扫", () => {
  it("超过阈值的手工会话标记离席，托管/在期会话不动", () => {
    const office = makeOffice();
    const stale = office.store.registerAgent({ name: "cursor-旧", kind: "cursor-ide" });
    const fresh = office.store.registerAgent({ name: "codex-新", kind: "codex-cli" });
    const managed = office.store.registerAgent({ name: "codex-托管", kind: "codex-managed" });
    // 手动把 stale 的 last_seen_at 拨回 1 小时前
    office.store.db
      .prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?")
      .run(Date.now() - 3_600_000, stale.id);

    const swept = office.sweepIdleSessions(30 * 60_000);
    expect(swept).toBe(1);
    expect(office.store.getAgentById(stale.id)!.status).toBe("offline");
    expect(office.store.getAgentById(fresh.id)!.status).toBe("online");
    expect(office.store.getAgentById(managed.id)!.status).toBe("online");
    // 离席时间保持原样（未被 sweep 顶掉）
    expect(office.store.getAgentById(stale.id)!.lastSeenAt).toBeLessThan(
      Date.now() - 3_500_000,
    );
    // 再扫一遍不重复计数
    expect(office.sweepIdleSessions(30 * 60_000)).toBe(0);
  });
});
