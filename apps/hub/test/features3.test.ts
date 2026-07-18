import { describe, expect, it, vi } from "vitest";
import { OfficeBus } from "../src/domain/bus.js";
import { OfficeService } from "../src/domain/office.js";
import { createManagedDispatcher } from "../src/domain/runners.js";
import { OfficeStore } from "../src/domain/store.js";
import { identiconSvg, sanitizeSvg } from "../src/domain/avatar.js";
import type { OfficeConfig } from "../src/config.js";

const testConfig = {
  port: 4517,
  dataDir: ":memory:",
  cursorModel: "composer-2.5",
  codexTurnTimeoutMs: 1000,
} as OfficeConfig;

function makeOffice() {
  const store = new OfficeStore(":memory:");
  return new OfficeService(store, new OfficeBus());
}

describe("删除员工", () => {
  it("删除后历史消息保留名字快照，收件箱清空", () => {
    const office = makeOffice();
    const agent = office.store.registerAgent({ name: "codex-临时", kind: "codex-managed" });
    office.sendMessage({ fromName: "老板", text: "@codex-临时 干活" });
    office.postReply(agent.id, "收到，马上做");

    const result = office.deleteAgent(agent.id);
    expect(result.ok).toBe(true);
    expect(office.store.getAgentById(agent.id)).toBeNull();
    // 历史消息仍显示原名（快照），不显示成"系统"或丢失
    const replies = office.store.listMessages().filter((m) => m.text === "收到，马上做");
    expect(replies).toHaveLength(1);
    expect(replies[0].fromName).toBe("codex-临时");
  });

  it("boss 与主管不可删除", () => {
    const office = makeOffice();
    const boss = office.store.listAgents().find((a) => a.kind === "user")!;
    const supervisor = office.store.listAgents().find((a) => a.kind === "supervisor")!;
    expect(office.deleteAgent(boss.id).ok).toBe(false);
    expect(office.deleteAgent(supervisor.id).ok).toBe(false);
  });
});

describe("老板称呼", () => {
  it("改称呼后默认发件人跟着变", () => {
    const office = makeOffice();
    const boss = office.store.listAgents().find((a) => a.kind === "user")!;
    office.renameAgent(boss.id, { name: "王总" });
    expect(office.bossName()).toBe("王总");

    office.store.registerAgent({ name: "a1", kind: "codex-cli" });
    office.sendMessage({ fromName: office.bossName(), text: "@a1 开工" });
    const msg = office.store.listMessages()[0];
    expect(msg.fromName).toBe("王总");
  });

  it("重启（新 Service 实例）不会再造一个「老板」", () => {
    const store = new OfficeStore(":memory:");
    const office1 = new OfficeService(store, new OfficeBus());
    const boss = store.listAgents().find((a) => a.kind === "user")!;
    office1.renameAgent(boss.id, { name: "老大" });

    const office2 = new OfficeService(store, new OfficeBus());
    const users = store.listAgents().filter((a) => a.kind === "user");
    expect(users).toHaveLength(1);
    expect(office2.bossName()).toBe("老大");
  });
});

describe("token 统计", () => {
  it("按日累计并汇入 listAgents", () => {
    const office = makeOffice();
    const agent = office.store.registerAgent({ name: "codex-a", kind: "codex-managed" });
    office.store.addTokens(agent.id, 1200);
    office.store.addTokens(agent.id, 800);
    expect(office.store.todayTokens(agent.id)).toBe(2000);
    const card = office.store.listAgents().find((a) => a.id === agent.id)!;
    expect(card.todayTokens).toBe(2000);
  });

  it("非法值被忽略", () => {
    const office = makeOffice();
    const agent = office.store.registerAgent({ name: "codex-a", kind: "codex-managed" });
    office.store.addTokens(agent.id, 0);
    office.store.addTokens(agent.id, -5);
    office.store.addTokens(agent.id, Number.NaN);
    expect(office.store.todayTokens(agent.id)).toBe(0);
  });
});

describe("完成任务数", () => {
  it("done 任务计入员工卡片", () => {
    const office = makeOffice();
    const agent = office.store.registerAgent({ name: "a1", kind: "codex-cli" });
    const task = office.createTask({ title: "修 bug", assigneeName: "a1" });
    office.updateTask({ taskId: task.id, status: "done" });
    const card = office.store.listAgents().find((a) => a.id === agent.id)!;
    expect(card.doneTasks).toBe(1);
  });
});

describe("托管执行：回复入群 + 终端 + token", () => {
  it("执行成功后回复成为群消息且不触发 @ 路由，token 入账", async () => {
    const office = makeOffice();
    const dispatch = createManagedDispatcher(office, testConfig, {
      "codex-managed": async (_a, _p, io) => {
        io?.term("$ npm test", "cmd");
        return { text: "测试全部通过 @codex-b 谢谢", usage: 5000 };
      },
    });
    office.setManagedDispatcher(dispatch);
    const agent = office.store.registerAgent({ name: "codex-a", kind: "codex-managed" });
    office.store.registerAgent({ name: "codex-b", kind: "codex-managed" });

    office.sendMessage({ fromName: "老板", text: "@codex-a 跑下测试" });
    await vi.waitFor(() => {
      const reply = office.store
        .listMessages()
        .find((m) => m.fromName === "codex-a" && m.text.includes("测试全部通过"));
      expect(reply).toBeTruthy();
      // postReply 不触发路由：codex-b 不应收到投递
      expect(reply!.deliveries).toHaveLength(0);
    });
    expect(office.store.todayTokens(agent.id)).toBe(5000);
    // 终端缓冲有请求行与命令行
    const lines = office.terminals.get(agent.id).map((l) => l.text);
    expect(lines.some((t) => t.includes("npm test"))).toBe(true);
    expect(lines.some((t) => t.includes("跑下测试"))).toBe(true);
  });

  it("stopRun 调用注册的 kill 并清理句柄", () => {
    const office = makeOffice();
    const agent = office.store.registerAgent({ name: "codex-a", kind: "codex-managed" });
    const kill = vi.fn();
    office.registerRunKill(agent.id, kill);
    expect(office.stopRun(agent.id)).toBe(true);
    expect(kill).toHaveBeenCalledOnce();
    expect(office.stopRun(agent.id)).toBe(false);
  });
});

describe("头像", () => {
  it("本地几何头像稳定且是合法 SVG", () => {
    const a = identiconSvg("小C");
    const b = identiconSvg("小C");
    expect(a).toBe(b);
    expect(a.startsWith("<svg")).toBe(true);
    expect(sanitizeSvg(a)).toBe(a);
  });

  it("拒绝携带脚本或外链的 SVG", () => {
    expect(sanitizeSvg('<svg><script>alert(1)</script></svg>')).toBeNull();
    expect(sanitizeSvg('<svg onload="x()"><rect/></svg>')).toBeNull();
    expect(sanitizeSvg('<svg><a href="http://x"><rect/></a></svg>')).toBeNull();
    expect(sanitizeSvg("没有 svg 标签")).toBeNull();
  });
});
