import { describe, expect, it, vi } from "vitest";
import { OfficeBus } from "../src/domain/bus.js";
import { OfficeService } from "../src/domain/office.js";
import { OfficeStore } from "../src/domain/store.js";
import { createManagedDispatcher } from "../src/domain/runners.js";
import type { OfficeConfig } from "../src/config.js";

const testConfig: OfficeConfig = {
  port: 4517,
  dataDir: ":memory:",
  cursorModel: "composer-2.5",
  codexTurnTimeoutMs: 1000,
};

function makeOffice() {
  const store = new OfficeStore(":memory:");
  return new OfficeService(store, new OfficeBus());
}

describe("发版一：任务状态机 + 验收环", () => {
  it("非法迁移被拒（claimed 直接 done 不行；open 直接 done 不行）", () => {
    const office = makeOffice();
    const task = office.createTask({ title: "t1" });
    // open → done 非法
    expect(office.updateTask({ taskId: task.id, status: "done" })).toMatchObject({
      error: expect.stringContaining("非法任务状态迁移"),
    });
    // claimed → done 非法
    office.updateTask({ taskId: task.id, status: "claimed" });
    expect(office.updateTask({ taskId: task.id, status: "done" })).toMatchObject({
      error: expect.stringContaining("非法任务状态迁移"),
    });
  });

  it("合法流转 claimed → in_progress → review → done 全部通过", () => {
    const office = makeOffice();
    const agent = office.store.registerAgent({ name: "c1", kind: "codex-managed" });
    const task = office.createTask({ title: "t2", assigneeName: "c1" });
    expect(office.updateTask({ taskId: task.id, status: "in_progress" })?.status).toBe("in_progress");
    expect(office.updateTask({ taskId: task.id, status: "review" })?.status).toBe("review");
    expect(office.updateTask({ taskId: task.id, status: "done" })?.status).toBe("done");
    expect(office.store.getTask(task.id)!.status).toBe("done");
  });

  it("handoff 落定后任务自动推进到 review", async () => {
    const office = makeOffice();
    const ran: string[] = [];
    office.setManagedDispatcher(
      createManagedDispatcher(office, testConfig, {
        "codex-managed": vi.fn(async (a) => {
          ran.push(a.name);
          return { text: "阶段完成" };
        }),
      }),
    );
    const source = office.store.registerAgent({ name: "a", kind: "codex-cli", meta: { threadId: "t" } });
    const successor = office.store.registerAgent({ name: "b", kind: "codex-managed" });
    const task = office.createTask({ title: "t3", assigneeName: "a" });

    const result = office.handoffTask({
      fromAgent: "a",
      toAgent: "b",
      taskId: task.id,
      summary: "前半段完成",
      idempotencyKey: "h1",
    });
    expect(result.ok).toBe(true);
    // 交接执行完成（accepted）后，任务从 in_progress 推进到 review
    await vi.waitFor(() => expect(ran.length).toBe(1));
    expect(office.store.getTask(task.id)!.status).toBe("review");
  });

  it("review → in_progress 打回合法，验收标准可创建时填写", () => {
    const office = makeOffice();
    const task = office.createTask({
      title: "t4",
      acceptanceCriteria: "接口返回 200 且字段齐全",
    });
    expect(task.acceptanceCriteria).toContain("200");
    office.updateTask({ taskId: task.id, status: "claimed" });
    office.updateTask({ taskId: task.id, status: "in_progress" });
    office.updateTask({ taskId: task.id, status: "review" });
    expect(office.updateTask({ taskId: task.id, status: "in_progress" })?.status).toBe("in_progress");
  });
});

describe("发版一：知识策展生命周期", () => {
  it("AI 写入默认 pending，检索/目录不可见，批准后可见", () => {
    const office = makeOffice();
    const doc = office.kbWrite({
      category: "网络",
      title: "代理 502",
      content: "绕开系统代理",
      author: "codex-a",
    })!.doc;
    expect(doc.status).toBe("pending");
    // 待审文档不出现在目录与检索
    expect(office.store.kbCatalog()).toHaveLength(0);
    expect(office.store.searchKbDocs("502")).toHaveLength(0);
    // 人工来源默认 active
    const manual = office.kbWrite({
      category: "构建",
      title: "pnpm build",
      content: "全量构建",
      author: "老板",
      sourceType: "manual",
    })!.doc;
    expect(manual.status).toBe("active");
    // 批准后可见
    office.kbSetStatus(doc.id, "active");
    expect(office.store.searchKbDocs("502")).toHaveLength(1);
    expect(office.store.kbCatalog()).toHaveLength(2);
  });

  it("active ↔ retired 退役与恢复，退役后检索不可见", () => {
    const office = makeOffice();
    const doc = office.kbWrite({
      category: "x",
      title: "旧方案",
      content: "已被替换",
      author: "老板",
      sourceType: "manual",
    })!.doc;
    office.kbSetStatus(doc.id, "retired");
    expect(office.store.searchKbDocs("旧方案")).toHaveLength(0);
    office.kbSetStatus(doc.id, "active");
    expect(office.store.searchKbDocs("旧方案")).toHaveLength(1);
  });
});

describe("发版一：僵尸员工清理与离职档案", () => {
  it("闲置清扫覆盖全部手工会话 kind", () => {
    const office = makeOffice();
    const kinds = [
      "cursor-ide",
      "codex-cli",
      "claude-cli",
      "zcode-cli",
      "workbuddy-cli",
      "opencode-cli",
      "kimi-cli",
      "qoder-cli",
      "kilo-cli",
      "trae-ide",
    ] as const;
    for (const [i, kind] of kinds.entries()) {
      office.store.registerAgent({ name: `s${i}`, kind });
      office.store.setAgentStatusQuiet(`s${i}`, "online");
    }
    // 全部拨回 1 小时前 → 全部被清扫为 offline
    for (let i = 0; i < kinds.length; i++) {
      office.store.db
        .prepare("UPDATE agents SET last_seen_at = ? WHERE name = ?")
        .run(Date.now() - 3_600_000, `s${i}`);
    }
    expect(office.sweepIdleSessions(30 * 60_000)).toBe(kinds.length);
  });

  it("超期离线归档：名册剔除、历史保留、同名重注册自动复活", () => {
    const office = makeOffice();
    const agent = office.store.registerAgent({ name: "codex-旧", kind: "codex-cli" });
    office.store.setAgentStatusQuiet(agent.id, "offline");
    office.store.db
      .prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?")
      .run(Date.now() - 100 * 60 * 60_000, agent.id);

    const archived = office.archiveStaleAgents(72 * 60 * 60_000);
    expect(archived).toBe(1);
    const stored = office.store.getAgentById(agent.id)!;
    expect(stored.status).toBe("archived");
    // get_context 名册剔除 archived
    const ctx = office.getContext();
    expect(ctx.roster.some((r) => r.name === "codex-旧")).toBe(false);
    // @ 提及不命中 archived
    const routed = office.sendMessage({ fromName: "老板", text: "@codex-旧 干活" });
    expect(routed.routed).toHaveLength(0);
    // 同名重注册 → 复活
    const revived = office.store.registerAgent({ name: "codex-旧", kind: "codex-cli" });
    expect(revived.status).toBe("online");
    expect(office.store.getAgentById(agent.id)!.status).toBe("online");
  });

  it("名下仍有未完成任务时不归档", () => {
    const office = makeOffice();
    const agent = office.store.registerAgent({ name: "codex-忙", kind: "codex-cli" });
    office.store.setAgentStatusQuiet(agent.id, "offline");
    office.store.db
      .prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?")
      .run(Date.now() - 100 * 60 * 60_000, agent.id);
    office.createTask({ title: "未完成", assigneeName: "codex-忙" });
    expect(office.archiveStaleAgents(72 * 60 * 60_000)).toBe(0);
    expect(office.store.getAgentById(agent.id)!.status).toBe("offline");
  });
});
