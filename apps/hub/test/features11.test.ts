import { describe, expect, it, vi } from "vitest";
import type { AgentCard } from "@agent-office/protocol";
import { buildManagedPrompt } from "@agent-office/protocol";
import { OfficeBus } from "../src/domain/bus.js";
import { OfficeService } from "../src/domain/office.js";
import { createManagedDispatcher } from "../src/domain/runners.js";
import { OfficeStore } from "../src/domain/store.js";
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

describe("职位与岗位档案交接", () => {
  it("职位 CRUD 与任免：接任同步 title，卸任清除", () => {
    const office = makeOffice();
    const created = office.createRole("测试", "负责回归与验收");
    expect(created.ok).toBe(true);
    const role = created.role!;
    // 重名拒绝
    expect(office.createRole("测试").ok).toBe(false);

    const agent = office.store.registerAgent({ name: "codex-1", kind: "codex-managed" });
    expect(office.assignRole(agent.id, role.id).ok).toBe(true);
    let fresh = office.store.getAgentById(agent.id)!;
    expect((fresh.meta as { roleId?: string }).roleId).toBe(role.id);
    expect((fresh.meta as { title?: string }).title).toBe("测试");

    // 在岗名单
    expect(office.store.listRoles()[0].holderNames).toEqual(["codex-1"]);

    // 卸任
    expect(office.assignRole(agent.id, null).ok).toBe(true);
    fresh = office.store.getAgentById(agent.id)!;
    expect((fresh.meta as { roleId?: string }).roleId).toBeUndefined();
    expect((fresh.meta as { title?: string }).title).toBeUndefined();
  });

  it("岗位档案：笔记、定向消息、历任简报都跟职位走，接任者完整继承", () => {
    const office = makeOffice();
    const role = office.createRole("git 库管理").role!;
    const codex = office.store.registerAgent({ name: "codex-1", kind: "codex-cli" });
    office.assignRole(codex.id, role.id);

    // 老板发给在岗者的定向消息进档案（账号密码类信息）
    office.sendMessage({ fromName: "老板", text: "@codex-1 仓库账号 admin 密码 s3cret" });

    // 在岗者写档案笔记
    const noteResult = office.writeRoleNote({
      roleId: role.id,
      title: "仓库架构",
      content: "monorepo，主分支 master，CI 用 GitHub Actions",
      author: "codex-1",
    });
    expect(noteResult.ok).toBe(true);

    // 在岗者发简报（打上职位标）
    office.publishBrief({
      agentName: "codex-1",
      kind: "manual",
      source: "mcp",
      brief: { title: "完成仓库迁移", result: "已把 3 个仓库迁到新组织" },
    });

    // codex-1 下线删除后，档案仍完整
    office.deleteAgent(codex.id);
    const dossier = office.roleDossier(role.id)!;
    expect(dossier.notes).toHaveLength(1);
    expect(dossier.notes[0].content).toContain("monorepo");
    expect(dossier.messages.some((m) => m.text.includes("s3cret"))).toBe(true);
    expect(dossier.briefs.some((b) => b.title === "完成仓库迁移")).toBe(true);

    // 新 claude 接任，拿到同一份档案
    const claude = office.store.registerAgent({ name: "claude-新人", kind: "claude-managed" });
    expect(office.assignRole(claude.id, role.id).ok).toBe(true);
    const inherited = office.agentRoleDossier(office.store.getAgentById(claude.id)!)!;
    expect(inherited.notes[0].title).toBe("仓库架构");
    expect(inherited.messages.some((m) => m.text.includes("s3cret"))).toBe(true);
  });

  it("托管派发时职位档案注入提示词", async () => {
    const office = makeOffice();
    const role = office.createRole("架构分析").role!;
    const prompts: string[] = [];
    office.setManagedDispatcher(
      createManagedDispatcher(office, testConfig, {
        "claude-managed": vi.fn(async (_a: AgentCard, prompt: string) => {
          prompts.push(prompt);
          return { text: "收到" };
        }),
      }),
    );
    const claude = office.store.registerAgent({ name: "claude-2", kind: "claude-managed" });
    office.assignRole(claude.id, role.id);
    office.writeRoleNote({
      roleId: role.id,
      title: "服务端拓扑",
      content: "Flask 6000 端口 + GPU 网关",
      author: "前任",
    });

    office.sendMessage({ fromName: "老板", text: "@claude-2 继续分析架构" });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain("架构分析");
    expect(prompts[0]).toContain("服务端拓扑");
    expect(prompts[0]).toContain("role_note_write");
  });

  it("buildManagedPrompt 无职位时不出现档案段落", () => {
    const prompt = buildManagedPrompt({ agentName: "a", senderName: "老板", text: "干活" });
    expect(prompt).not.toContain("职位档案");
  });

  it("撤销职位：清空在岗者任职并删除档案", () => {
    const office = makeOffice();
    const role = office.createRole("临时岗").role!;
    const agent = office.store.registerAgent({ name: "codex-x", kind: "codex-managed" });
    office.assignRole(agent.id, role.id);
    office.writeRoleNote({ roleId: role.id, title: "n", content: "c" });

    expect(office.deleteRole(role.id).ok).toBe(true);
    expect(office.store.listRoles()).toHaveLength(0);
    expect(office.store.listRoleNotes(role.id)).toHaveLength(0);
    const fresh = office.store.getAgentById(agent.id)!;
    expect((fresh.meta as { roleId?: string }).roleId).toBeUndefined();
  });

  it("清空频道消息：只清目标频道，投递与档案索引一并清理", () => {
    const office = makeOffice();
    const group = office.createGroup("画布").group!;
    const agent = office.store.registerAgent({ name: "codex-1", kind: "codex-cli" });
    office.assignGroups(agent.id, [group.id]);

    office.sendMessage({ fromName: "老板", text: "大群消息 @codex-1" });
    office.sendMessage({ fromName: "老板", text: "组内消息", channel: group.id });
    expect(office.store.listMessages().filter((m) => m.channel === "hall")).toHaveLength(1);

    const result = office.clearChannel("hall");
    expect(result.ok).toBe(true);
    expect(result.cleared).toBe(1);
    const remaining = office.store.listMessages();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].channel).toBe(group.id);
    // 未读投递随消息一起清掉
    expect(office.store.pendingCount(agent.id)).toBe(0);
    // 不存在的频道报错
    expect(office.clearChannel("nope").ok).toBe(false);
  });
});

describe("清空频道连操作记录", () => {
  it("hall 清空可连全部事件一起清；组频道只清本组成员事件", () => {
    const office = makeOffice();
    const group = office.createGroup("画布").group!;
    const inGroup = office.store.registerAgent({ name: "codex-in", kind: "codex-cli" });
    const outGroup = office.store.registerAgent({ name: "codex-out", kind: "codex-cli" });
    office.assignGroups(inGroup.id, [group.id]);
    office.event({ type: "run", agentId: inGroup.id, text: "组内事件" });
    office.event({ type: "run", agentId: outGroup.id, text: "组外事件" });

    // 组频道清空：只清组员事件
    office.sendMessage({ fromName: "老板", text: "组内消息", channel: group.id });
    const r1 = office.clearChannel(group.id, { includeEvents: true });
    expect(r1.ok).toBe(true);
    const remainAgents = office.store.listEvents().filter((e) => e.agentId);
    expect(remainAgents.some((e) => e.agentId === outGroup.id)).toBe(true);
    expect(remainAgents.some((e) => e.agentId === inGroup.id && e.text === "组内事件")).toBe(false);

    // hall 清空：全部事件清光
    const r2 = office.clearChannel("hall", { includeEvents: true });
    expect(r2.ok).toBe(true);
    expect(office.store.listEvents().filter((e) => e.type !== "channel")).toHaveLength(0);
  });
});
