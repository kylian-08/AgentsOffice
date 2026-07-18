import { describe, expect, it, vi } from "vitest";
import type { AgentCard } from "@agent-office/protocol";
import { OfficeBus } from "../src/domain/bus.js";
import { OfficeService } from "../src/domain/office.js";
import { createManagedDispatcher, Semaphore } from "../src/domain/runners.js";
import { OfficeStore } from "../src/domain/store.js";
import type { OfficeConfig } from "../src/config.js";

const testConfig: OfficeConfig = {
  port: 4517,
  dataDir: ":memory:",
  cursorModel: "composer-2.5",
  codexTurnTimeoutMs: 1000,
  maxConcurrentRuns: 2,
};

function makeOffice() {
  const store = new OfficeStore(":memory:");
  return new OfficeService(store, new OfficeBus());
}

describe("项目组与频道", () => {
  it("建组/分配成员/解散，组名唯一", () => {
    const office = makeOffice();
    const created = office.createGroup("画布");
    expect(created.ok).toBe(true);
    expect(office.createGroup("画布").ok).toBe(false);
    expect(office.createGroup("  ").ok).toBe(false);

    const a = office.store.registerAgent({ name: "codex-画布", kind: "codex-managed" });
    expect(office.assignGroup(a.id, created.group!.id).ok).toBe(true);
    const card = office.store.listAgents().find((x) => x.id === a.id)!;
    expect(card.groupId).toBe(created.group!.id);
    expect(card.groupName).toBe("画布");
    expect(office.store.listGroups()[0].memberCount).toBe(1);

    // boss/主管不入组
    const boss = office.store.listAgents().find((x) => x.kind === "user")!;
    expect(office.assignGroup(boss.id, created.group!.id).ok).toBe(false);

    // 解散后成员回大群
    expect(office.deleteGroup(created.group!.id).ok).toBe(true);
    expect(office.store.getAgentById(a.id)!.groupId).toBeNull();
  });

  it("消息落到指定频道，组频道 @all 只喊本组人", () => {
    const office = makeOffice();
    const g = office.createGroup("画布").group!;
    const inGroup = office.store.registerAgent({ name: "codex-组内", kind: "codex-cli" });
    const outGroup = office.store.registerAgent({ name: "codex-组外", kind: "codex-cli" });
    office.assignGroup(inGroup.id, g.id);

    const result = office.sendMessage({ fromName: "老板", text: "@all 开个组会", channel: g.id });
    expect(result.routed.map((r) => r.name)).toEqual(["codex-组内"]);
    expect(office.store.pendingCount(inGroup.id)).toBe(1);
    expect(office.store.pendingCount(outGroup.id)).toBe(0);

    const msg = office.store.listMessages().at(-1)!;
    expect(msg.channel).toBe(g.id);

    // 大群 @all 喊所有人
    office.sendMessage({ fromName: "老板", text: "@all 全员通知" });
    expect(office.store.listMessages().at(-1)!.channel).toBe("hall");
    expect(office.store.pendingCount(outGroup.id)).toBe(1);

    // 无效频道回落大群
    office.sendMessage({ fromName: "老板", text: "落哪里", channel: "no-such-group" });
    expect(office.store.listMessages().at(-1)!.channel).toBe("hall");
  });

  it("托管回复落回来源频道；组内可显式 @ 组外成员", async () => {
    const office = makeOffice();
    const g = office.createGroup("算力平台").group!;
    office.setManagedDispatcher(
      createManagedDispatcher(office, testConfig, {
        "codex-managed": async () => ({ text: "组会开完了" }),
      }),
    );
    const worker = office.store.registerAgent({ name: "codex-网关", kind: "codex-managed" });
    office.assignGroup(worker.id, g.id);

    office.sendMessage({ fromName: "老板", text: "@codex-网关 汇报进度", channel: g.id });
    await vi.waitFor(() => {
      const reply = office.store.listMessages().find((m) => m.text === "组会开完了");
      expect(reply).toBeTruthy();
      expect(reply!.channel).toBe(g.id);
    });

    // 显式 @ 不受组限制：组频道里也能点名组外成员
    const outsider = office.store.registerAgent({ name: "claude-外援", kind: "claude-cli" });
    office.sendMessage({ fromName: "老板", text: "@claude-外援 来支援", channel: g.id });
    expect(office.store.pendingCount(outsider.id)).toBe(1);
  });
});

describe("重启恢复（消息表即持久队列）", () => {
  it("托管员工的积压未读在启动恢复时重新派发", async () => {
    const store = new OfficeStore(":memory:");
    const office = new OfficeService(store, new OfficeBus());
    const agent = store.registerAgent({ name: "codex-研发", kind: "codex-managed" });
    // 模拟旧进程：没有调度器时消息只能积压
    office.sendMessage({ fromName: "老板", text: "@codex-研发 修复登录 bug" });
    expect(store.pendingCount(agent.id)).toBe(1);

    // 模拟新进程启动：挂上调度器后恢复
    const dispatched: Array<{ name: string; text: string; channel?: string }> = [];
    office.setManagedDispatcher((a, m) =>
      dispatched.push({ name: a.name, text: m.text, channel: m.channel }),
    );
    const recovered = office.recoverPendingDispatches();
    expect(recovered).toBe(1);
    expect(dispatched).toHaveLength(1);
    // 单条积压保持原文原发件人语义
    expect(dispatched[0].text).toBe("@codex-研发 修复登录 bug");
    expect(store.pendingCount(agent.id)).toBe(0);

    // 再跑一遍无事发生（幂等）
    expect(office.recoverPendingDispatches()).toBe(0);
  });

  it("多条积压合并成一轮任务；手工会话不参与恢复", () => {
    const office = makeOffice();
    const managed = office.store.registerAgent({ name: "codex-a", kind: "codex-managed" });
    const manual = office.store.registerAgent({ name: "codex-手工", kind: "codex-cli" });
    office.sendMessage({ fromName: "老板", text: "@codex-a 第一件事 @codex-手工 你也看看" });
    office.sendMessage({ fromName: "老板", text: "@codex-a 第二件事" });

    const dispatched: Array<{ name: string; text: string }> = [];
    office.setManagedDispatcher((a, m) => dispatched.push({ name: a.name, text: m.text }));
    expect(office.recoverPendingDispatches()).toBe(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].name).toBe("codex-a");
    expect(dispatched[0].text).toContain("第一件事");
    expect(dispatched[0].text).toContain("第二件事");
    // 手工会话的未读保留（等它下轮自己读）
    expect(office.store.pendingCount(manual.id)).toBe(1);
    expect(office.store.pendingCount(managed.id)).toBe(0);
  });
});

describe("全局并发闸门", () => {
  it("Semaphore 限制同时进行数，释放后放行等待者", async () => {
    const gate = new Semaphore(2);
    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    expect(gate.inUse).toBe(2);

    let third = false;
    const p3 = gate.acquire().then((release) => {
      third = true;
      return release;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(third).toBe(false);

    r1();
    r1(); // 重复释放不生效
    const r3 = await p3;
    expect(third).toBe(true);
    expect(gate.inUse).toBe(2);
    r2();
    r3();
    expect(gate.inUse).toBe(0);
  });

  it("不同员工的托管回合数被闸门压到上限以内", async () => {
    const office = makeOffice();
    let running = 0;
    let peak = 0;
    const runner = vi.fn(async (_a: AgentCard, _p: string) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 30));
      running -= 1;
      return { text: "done" };
    });
    office.setManagedDispatcher(
      createManagedDispatcher(office, { ...testConfig, maxConcurrentRuns: 2 }, {
        "codex-managed": runner,
      }),
    );
    for (let i = 1; i <= 4; i += 1) {
      office.store.registerAgent({ name: `codex-w${i}`, kind: "codex-managed" });
    }
    office.sendMessage({ fromName: "老板", text: "@codex-w1 活 @codex-w2 活 @codex-w3 活 @codex-w4 活" });

    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(4), { timeout: 3000 });
    expect(peak).toBeLessThanOrEqual(2);
  });
});
