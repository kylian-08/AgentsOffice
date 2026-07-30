import { describe, expect, it } from "vitest";
import type { AgentCard, OfficeTask } from "@agent-office/protocol";
import {
  buildMessageFeedback,
  selectWorkers,
  sortTerminalsForAction,
  visibleTerminals,
} from "./operability";

const now = 1_000_000_000;

function agent(input: Partial<AgentCard> & Pick<AgentCard, "id" | "name" | "status">): AgentCard {
  return {
    id: input.id,
    name: input.name,
    status: input.status,
    kind: input.kind ?? "codex-cli",
    workspace: input.workspace ?? null,
    meta: input.meta ?? {},
    createdAt: input.createdAt ?? now - 100_000,
    lastSeenAt: input.lastSeenAt ?? now - 100_000,
    pendingCount: input.pendingCount ?? 0,
    todayTokens: input.todayTokens ?? 0,
    doneTasks: input.doneTasks ?? 0,
    groupIds: input.groupIds ?? [],
    groupNames: input.groupNames ?? [],
  };
}

function task(input: Partial<OfficeTask> & Pick<OfficeTask, "id" | "status">): OfficeTask {
  return {
    id: input.id,
    title: input.title ?? input.id,
    description: input.description ?? null,
    status: input.status,
    assigneeAgentId: input.assigneeAgentId ?? null,
    assigneeName: input.assigneeName ?? null,
    createdBy: input.createdBy ?? "主管",
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

describe("运营态成员筛选", () => {
  it("默认保留在线、未读、活动任务和最近会话，归档陈旧离线工位", () => {
    const agents = [
      agent({ id: "busy", name: "busy", status: "busy" }),
      agent({ id: "online", name: "online", status: "online" }),
      agent({ id: "pending", name: "pending", status: "offline", pendingCount: 2, lastSeenAt: 1 }),
      agent({ id: "assigned", name: "assigned", status: "offline", lastSeenAt: 1 }),
      agent({ id: "recent", name: "recent", status: "offline", lastSeenAt: now - 60_000 }),
      agent({ id: "stale", name: "stale", status: "offline", lastSeenAt: 1 }),
    ];
    const tasks = [task({ id: "t1", status: "claimed", assigneeAgentId: "assigned" })];

    const result = selectWorkers({ agents, tasks, now });

    expect(result.visible.map((item) => item.id)).toEqual([
      "busy",
      "online",
      "pending",
      "assigned",
      "recent",
    ]);
    expect(result.archivedCount).toBe(1);
  });

  it("搜索覆盖工号、模型、职位、工作区和项目组", () => {
    const target = agent({
      id: "a",
      name: "codex-main",
      status: "offline",
      lastSeenAt: 1,
      workspace: "D:/project/canvas",
      meta: { model: "gpt-5.6", title: "画布开发" },
      groupNames: ["算力平台"],
    });
    const result = selectWorkers({
      agents: [target],
      tasks: [],
      query: "算力",
      showArchived: true,
      now,
    });
    expect(result.visible).toHaveLength(1);
  });
});

describe("终端默认选择", () => {
  const terminals = [
    { id: "empty", name: "empty", status: "offline", lines: [], lastSeenAt: 10 },
    { id: "history", name: "history", status: "offline", lines: [{}], lastSeenAt: 20 },
    { id: "online", name: "online", status: "online", lines: [], lastSeenAt: 30 },
    { id: "busy", name: "busy", status: "busy", lines: [], lastSeenAt: 40 },
  ];

  it("忙碌和在线工位优先于历史终端", () => {
    expect(sortTerminalsForAction(terminals).map((item) => item.id)).toEqual([
      "busy",
      "online",
      "history",
      "empty",
    ]);
  });

  it("默认隐藏离线终端", () => {
    expect(visibleTerminals(terminals, false).map((item) => item.id)).toEqual(["busy", "online"]);
  });
});

describe("消息回执", () => {
  it("无效 @ 不再显示成功", () => {
    expect(buildMessageFeedback({ routed: [], unmatched: true })).toEqual({
      text: "消息已发到频道，但 @ 未匹配到成员；请从候选列表选择有效工号。",
      kind: "err",
    });
  });

  it("区分托管唤醒和手工收件箱", () => {
    expect(
      buildMessageFeedback({
        unmatched: false,
        routed: [
          { name: "codex-a", mode: "managed" },
          { name: "cursor-b", mode: "inbox" },
        ],
      }).text,
    ).toBe("已唤醒 codex-a；已入 cursor-b 的收件箱（下轮读取）");
  });
});
