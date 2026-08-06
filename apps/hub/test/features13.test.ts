import type { AgentCard } from "@agent-office/protocol";
import { describe, expect, it, vi } from "vitest";
import type { OfficeConfig } from "../src/config.js";
import { OfficeBus } from "../src/domain/bus.js";
import { OfficeService } from "../src/domain/office.js";
import { createManagedDispatcher } from "../src/domain/runners.js";
import { OfficeStore } from "../src/domain/store.js";

const testConfig: OfficeConfig = {
  port: 4517,
  dataDir: ":memory:",
  cursorModel: "composer-2.5",
  codexTurnTimeoutMs: 1000,
};

function makeOffice(): OfficeService {
  return new OfficeService(new OfficeStore(":memory:"), new OfficeBus());
}

describe("任务交接自动唤醒", () => {
  it("把任务原子转给现有托管员工并立即派发，重复请求不重复执行", () => {
    const office = makeOffice();
    const dispatched: Array<{ name: string; text: string }> = [];
    office.setManagedDispatcher((agent, message) => {
      dispatched.push({ name: agent.name, text: message.text });
    });
    const role = office.createRole("后端开发", "负责 Hub").role!;
    const source = office.store.registerAgent({ name: "codex-A", kind: "codex-managed" });
    const target = office.store.registerAgent({ name: "codex-B", kind: "codex-managed" });
    office.assignRole(target.id, role.id);
    const task = office.createTask({ title: "实现交接", assigneeName: source.name });

    const first = office.handoffTask({
      fromAgent: source.name,
      toAgent: target.name,
      taskId: task.id,
      summary: "前半段接口已经完成",
      artifacts: ["apps/hub/src/domain/office.ts"],
      nextSteps: ["补齐 MCP 工具", "运行测试"],
      acceptanceCriteria: ["全量测试通过"],
      idempotencyKey: "task-1:phase-2",
    });

    expect(first.ok).toBe(true);
    expect(first.wakeMode).toBe("managed");
    expect(first.handoff?.status).toBe("dispatched");
    expect(office.store.getTask(task.id)).toMatchObject({
      assigneeAgentId: target.id,
      status: "in_progress",
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].text).toContain("前半段接口已经完成");
    expect(dispatched[0].text).toContain("全量测试通过");

    const duplicate = office.handoffTask({
      fromAgent: source.name,
      toAgent: target.name,
      taskId: task.id,
      summary: "前半段接口已经完成",
      idempotencyKey: "task-1:phase-2",
    });
    expect(duplicate.ok).toBe(true);
    expect(duplicate.duplicated).toBe(true);
    expect(duplicate.handoff?.id).toBe(first.handoff?.id);
    expect(dispatched).toHaveLength(1);
  });

  it("Codex/Claude 有续聊凭证时沿用原会话并转为托管", () => {
    const office = makeOffice();
    const dispatched: string[] = [];
    office.setManagedDispatcher((agent) => dispatched.push(agent.name));
    const source = office.store.registerAgent({ name: "codex-A", kind: "codex-managed" });
    const target = office.store.registerAgent({
      name: "codex-B",
      kind: "codex-cli",
      workspace: "C:/repo",
      meta: { threadId: "thread-b" },
    });

    const result = office.handoffTask({
      fromAgent: source.name,
      toAgent: target.name,
      summary: "请继续分析数据库迁移",
      idempotencyKey: "resume-b",
    });

    expect(result.ok).toBe(true);
    expect(result.wakeMode).toBe("resumed");
    expect(result.agent).toMatchObject({ id: target.id, kind: "codex-managed" });
    expect((result.agent?.meta as { threadId?: string }).threadId).toBe("thread-b");
    expect(dispatched).toEqual([target.name]);
  });

  it("目标无法续聊时创建新 Codex CLI，并继承职位、项目组和工作区", () => {
    const office = makeOffice();
    const dispatched: string[] = [];
    office.setManagedDispatcher((agent) => dispatched.push(agent.name));
    const role = office.createRole("客户端开发", "负责客户端").role!;
    const group = office.createGroup("客户端组").group!;
    const source = office.store.registerAgent({ name: "codex-A", kind: "codex-managed" });
    const cursor = office.store.registerAgent({
      name: "cursor-B",
      kind: "cursor-ide",
      workspace: "D:/project/client",
      meta: { model: "composer" },
    });
    office.assignRole(cursor.id, role.id);
    office.assignGroups(cursor.id, [group.id]);

    const result = office.handoffTask({
      fromAgent: source.name,
      toAgent: cursor.name,
      summary: "UI 前半段完成，继续接后半段",
      idempotencyKey: "spawn-client-b",
    });

    expect(result.ok).toBe(true);
    expect(result.wakeMode).toBe("spawned");
    expect(result.agent?.kind).toBe("codex-managed");
    expect(result.agent?.name).toMatch(/^codex-客户端开发-/);
    expect(result.agent?.workspace).toBe("D:/project/client");
    expect(result.agent?.groupIds).toEqual([group.id]);
    expect(result.agent?.meta).toMatchObject({
      roleId: role.id,
      title: role.name,
      sandbox: "workspace-write",
      predecessorAgentId: cursor.id,
    });
    expect(dispatched).toEqual([result.agent?.name]);
    expect(office.store.getAgentById(cursor.id)?.kind).toBe("cursor-ide");
  });

  it("只指定职位时直接创建新的托管 CLI 继承该职位", () => {
    const office = makeOffice();
    const dispatched: string[] = [];
    office.setManagedDispatcher((agent) => dispatched.push(agent.name));
    const role = office.createRole("测试工程师").role!;
    const source = office.store.registerAgent({
      name: "codex-A",
      kind: "codex-managed",
      workspace: "C:/workspace",
    });

    const result = office.handoffTask({
      fromAgent: source.name,
      toRole: role.name,
      summary: "开发已完成，请执行回归测试",
      idempotencyKey: "spawn-by-role",
    });

    expect(result.ok).toBe(true);
    expect(result.wakeMode).toBe("spawned");
    expect(result.agent?.workspace).toBe("C:/workspace");
    expect((result.agent?.meta as { roleId?: string }).roleId).toBe(role.id);
    expect(dispatched).toEqual([result.agent?.name]);
  });

  it("托管运行成功或失败时回写交接状态", async () => {
    const successOffice = makeOffice();
    const source = successOffice.store.registerAgent({ name: "codex-A", kind: "codex-managed" });
    const target = successOffice.store.registerAgent({ name: "codex-B", kind: "codex-managed" });
    successOffice.setManagedDispatcher(
      createManagedDispatcher(successOffice, testConfig, {
        "codex-managed": vi.fn(async (_agent: AgentCard) => ({ text: "已接手并完成分析" })),
      }),
    );
    const success = successOffice.handoffTask({
      fromAgent: source.name,
      toAgent: target.name,
      summary: "继续完成后半段",
      idempotencyKey: "status-success",
    });
    await vi.waitFor(() => {
      expect(successOffice.store.getTaskHandoff(success.handoff!.id)?.status).toBe("accepted");
    });

    const failedOffice = makeOffice();
    const failedSource = failedOffice.store.registerAgent({ name: "codex-A", kind: "codex-managed" });
    const failedTarget = failedOffice.store.registerAgent({ name: "codex-B", kind: "codex-managed" });
    failedOffice.setManagedDispatcher(
      createManagedDispatcher(failedOffice, testConfig, {
        "codex-managed": vi.fn(async () => {
          throw new Error("runner boom");
        }),
      }),
    );
    const failed = failedOffice.handoffTask({
      fromAgent: failedSource.name,
      toAgent: failedTarget.name,
      summary: "这次执行会失败",
      idempotencyKey: "status-failed",
    });
    await vi.waitFor(() => {
      expect(failedOffice.store.getTaskHandoff(failed.handoff!.id)).toMatchObject({
        status: "failed",
        error: "runner boom",
      });
    });
  });

  it("Hub 重启时补发仅持久化、尚未生成消息的交接", () => {
    const office = makeOffice();
    const source = office.store.registerAgent({ name: "codex-A", kind: "codex-managed" });
    const target = office.store.registerAgent({ name: "codex-B", kind: "codex-managed" });
    const handoff = office.store.createTaskHandoff({
      fromAgentId: source.id,
      toAgentId: target.id,
      summary: "进程退出前只写入了交接记录",
      idempotencyKey: "recover-handoff",
    }).handoff;
    const dispatched: string[] = [];
    office.setManagedDispatcher((agent) => dispatched.push(agent.name));

    expect(office.recoverQueuedHandoffs()).toBe(1);
    expect(dispatched).toEqual([target.name]);
    expect(office.store.getTaskHandoff(handoff.id)).toMatchObject({
      status: "dispatched",
    });
    expect(office.store.findTaskHandoffMessage(handoff.id)).toBeTruthy();
  });
});
