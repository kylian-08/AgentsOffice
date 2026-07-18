import {
  parseMentions,
  SUPERVISOR_NAME,
  type AgentCard,
  type BriefInput,
  type KbDoc,
  type TaskStatus,
} from "@agent-office/protocol";
import type { OfficeBus } from "./bus.js";
import { LogBook } from "./logbook.js";
import type { OfficeStore } from "./store.js";
import { TerminalLog } from "./terminal.js";
import { truncate } from "../util.js";

export type ManagedDispatcher = (
  agent: AgentCard,
  message: { fromName: string; text: string; taskId?: string | null },
) => void;

export const USER_AGENT_NAME = "老板";

const MANAGED_KINDS = new Set(["codex-managed", "cursor-managed", "claude-managed"]);

/**
 * 办公室领域服务：统一消息路由、任务与简报入口。
 * MCP 工具、REST API、hooks 摄入全部经由这里，保证行为一致。
 */
export class OfficeService {
  private managedDispatcher: ManagedDispatcher | null = null;
  /** 正在运行的托管执行的终止函数（agentId → kill） */
  private runKills = new Map<string, () => void>();
  readonly terminals: TerminalLog;
  readonly logs: LogBook;

  constructor(
    readonly store: OfficeStore,
    readonly bus: OfficeBus,
  ) {
    this.terminals = new TerminalLog(bus);
    this.logs = new LogBook(bus);
    // 托管终端每一行同时汇入统一日志流
    this.terminals.onLine = (agentId, line) => {
      this.logs.append({
        level: line.kind === "error" ? "error" : "info",
        source: "terminal",
        agentName: this.store.getAgentById(agentId)?.name ?? null,
        text: line.text,
      });
    };
    // 确保人类用户与主管席位存在（boss 可能已改过称呼，按 kind 判断）
    if (!store.listAgents().some((a) => a.kind === "user")) {
      store.registerAgent({ name: USER_AGENT_NAME, kind: "user", status: "online" });
    }
    if (!store.getAgentByName(SUPERVISOR_NAME)) {
      store.registerAgent({ name: SUPERVISOR_NAME, kind: "supervisor", status: "online" });
    }
  }

  /** boss（人类用户）的当前称呼 */
  bossName(): string {
    return this.store.listAgents().find((a) => a.kind === "user")?.name ?? USER_AGENT_NAME;
  }

  setManagedDispatcher(dispatcher: ManagedDispatcher): void {
    this.managedDispatcher = dispatcher;
  }

  private emit(type: string, payload?: unknown): void {
    this.bus.publish({ type, payload });
  }

  event(input: { type: string; agentId?: string | null; text?: string | null }): void {
    const event = this.store.insertEvent(input);
    this.emit("event", event);
    this.logs.append({
      level: input.type === "run-error" ? "error" : "info",
      source: "event",
      agentName: event.agentName,
      text: `[${input.type}] ${input.text ?? ""}`.trim(),
    });
  }

  // ---------- 消息 ----------

  /**
   * 发送消息并路由 @提及。
   * 托管 Agent 立即调度执行；手工会话进入收件箱等待下一轮读取。
   */
  sendMessage(input: {
    fromName: string;
    text: string;
    taskId?: string | null;
  }): {
    messageId: string;
    routed: Array<{ name: string; mode: "managed" | "inbox" | "supervisor" }>;
    unmatched: boolean;
  } {
    const sender =
      this.store.getAgentByName(input.fromName) ??
      this.store.registerAgent({ name: input.fromName, kind: "user" });
    const roster = this.store.listAgents();
    const rosterNames = roster.map((a) => a.name);
    const { targets, all } = parseMentions(input.text, rosterNames);

    const targetAgents = new Map<string, AgentCard>();
    for (const name of targets) {
      const agent = this.store.getAgentByName(name);
      if (agent && agent.id !== sender.id) targetAgents.set(agent.id, agent);
    }
    if (all) {
      // @all 只广播给普通成员；主管只响应显式 @主管，避免每次广播都触发自动分派
      for (const agent of roster) {
        if (agent.id !== sender.id && agent.kind !== "user" && agent.kind !== "supervisor") {
          targetAgents.set(agent.id, agent);
        }
      }
    }

    const messageId = this.store.createMessage({
      fromAgentId: sender.id,
      text: input.text,
      mentionAgentIds: [...targetAgents.keys()],
      taskId: input.taskId ?? null,
    });
    this.logs.append({
      source: "message",
      agentName: sender.name,
      text: truncate(input.text.replaceAll(/\s+/g, " "), 300),
    });

    const routed: Array<{ name: string; mode: "managed" | "inbox" | "supervisor" }> = [];
    for (const agent of targetAgents.values()) {
      if (agent.kind === "supervisor") {
        // @主管 → 立即转为一次自动分派
        this.store.markDeliveriesRead(agent.id, [messageId]);
        routed.push({ name: agent.name, mode: "supervisor" });
        this.dispatchWork({
          title: truncate(input.text.replaceAll(/@[\p{L}\p{N}_./-]+\s*/gu, "").trim() || input.text, 120),
          description: input.text,
          requestedBy: sender.name,
          auto: true,
        });
        continue;
      }
      if (MANAGED_KINDS.has(agent.kind) && this.managedDispatcher) {
        routed.push({ name: agent.name, mode: "managed" });
        this.managedDispatcher(agent, {
          fromName: sender.name,
          text: input.text,
          taskId: input.taskId ?? null,
        });
      } else {
        routed.push({ name: agent.name, mode: "inbox" });
      }
    }

    this.emit("message", { messageId });
    if (targetAgents.size > 0) {
      this.event({
        type: "route",
        agentId: sender.id,
        text: `@ ${[...targetAgents.values()].map((a) => a.name).join("、")}`,
      });
    }
    const hasMentionSyntax = /@[\p{L}\p{N}_./-]+/u.test(input.text);
    return { messageId, routed, unmatched: targetAgents.size === 0 && hasMentionSyntax };
  }

  readInbox(agentName: string): {
    agent: AgentCard;
    messages: Array<{ messageId: string; fromName: string; text: string; taskId: string | null; createdAt: number }>;
  } | null {
    const agent = this.store.getAgentByName(agentName);
    if (!agent) return null;
    const messages = this.store.pendingMessagesFor(agent.id);
    this.store.markDeliveriesRead(agent.id);
    this.store.setAgentStatus(agent.id, "online");
    if (messages.length > 0) this.emit("inbox-read", { agent: agent.name });
    return { agent, messages };
  }

  // ---------- 简报 ----------

  publishBrief(input: {
    agentName: string;
    kind: "manual" | "auto";
    source: string;
    brief: BriefInput;
    idempotencyKey?: string;
  }): { ok: boolean; duplicated: boolean } {
    const agent = this.store.getAgentByName(input.agentName);
    if (!agent) return { ok: false, duplicated: false };
    const inserted = this.store.insertBrief({
      agentId: agent.id,
      kind: input.kind,
      source: input.source,
      brief: input.brief,
      idempotencyKey: input.idempotencyKey,
    });
    if (inserted) {
      this.emit("brief", inserted);
      this.logs.append({
        source: "brief",
        agentName: agent.name,
        text: `${input.brief.title} — ${truncate(input.brief.result.replaceAll(/\s+/g, " "), 200)}`,
      });
      this.event({
        type: "brief",
        agentId: agent.id,
        text: `发布简报：${truncate(input.brief.title, 60)}`,
      });
      return { ok: true, duplicated: false };
    }
    return { ok: true, duplicated: true };
  }

  // ---------- 任务 ----------

  createTask(input: {
    title: string;
    description?: string | null;
    createdBy?: string | null;
    assigneeName?: string | null;
  }) {
    const assignee = input.assigneeName
      ? this.store.getAgentByName(input.assigneeName)
      : null;
    const task = this.store.createTask({
      title: input.title,
      description: input.description,
      createdBy: input.createdBy,
      assigneeAgentId: assignee?.id ?? null,
    });
    this.emit("task", task);
    this.event({ type: "task", text: `新任务：${truncate(input.title, 60)}` });
    return task;
  }

  claimTask(agentName: string, taskId: string) {
    const agent = this.store.getAgentByName(agentName);
    const task = this.store.getTask(taskId);
    if (!agent || !task) return null;
    if (task.assigneeAgentId && task.assigneeAgentId !== agent.id && task.status !== "open") {
      return { conflict: true as const, task };
    }
    const updated = this.store.updateTask(taskId, {
      status: "claimed",
      assigneeAgentId: agent.id,
    });
    this.emit("task", updated);
    this.event({ type: "task", agentId: agent.id, text: `认领任务：${task.title}` });
    return { conflict: false as const, task: updated };
  }

  updateTask(input: {
    taskId: string;
    status?: TaskStatus;
    assigneeName?: string | null;
    byAgentName?: string;
    note?: string;
  }) {
    const task = this.store.getTask(input.taskId);
    if (!task) return null;
    let assigneeAgentId: string | null | undefined = undefined;
    if (input.assigneeName !== undefined) {
      assigneeAgentId = input.assigneeName
        ? (this.store.getAgentByName(input.assigneeName)?.id ?? null)
        : null;
    }
    const updated = this.store.updateTask(input.taskId, {
      status: input.status,
      assigneeAgentId,
    });
    this.emit("task", updated);
    const by = input.byAgentName ? this.store.getAgentByName(input.byAgentName) : null;
    this.event({
      type: "task",
      agentId: by?.id ?? null,
      text: `任务「${truncate(task.title, 40)}」→ ${input.status ?? task.status}${input.note ? `：${truncate(input.note, 80)}` : ""}`,
    });
    return updated;
  }

  // ---------- Agent 管理 ----------

  renameAgent(
    agentId: string,
    patch: { name?: string; model?: string; title?: string },
  ): AgentCard | null {
    const agent = this.store.getAgentById(agentId);
    if (!agent) return null;
    if (patch.name && patch.name.trim() && patch.name.trim() !== agent.name) {
      const renamed = this.store.renameAgent(agentId, patch.name.trim());
      if (!renamed) return null; // 工号冲突
      this.event({
        type: "rename",
        agentId,
        text:
          agent.kind === "user"
            ? `boss 的称呼改为「${patch.name.trim()}」`
            : `「${agent.name}」改名为「${patch.name.trim()}」`,
      });
    }
    if (patch.model !== undefined) {
      this.store.updateAgentMeta(agentId, { model: patch.model.trim() || undefined });
    }
    if (patch.title !== undefined) {
      this.store.updateAgentMeta(agentId, { title: patch.title.trim() || undefined });
    }
    this.emit("agent", { agentId });
    return this.store.getAgentById(agentId);
  }

  /** 删除员工：boss 与主管不可删；正在执行的先终止 */
  deleteAgent(agentId: string): { ok: boolean; error?: string } {
    const agent = this.store.getAgentById(agentId);
    if (!agent) return { ok: false, error: "成员不存在" };
    if (agent.kind === "user" || agent.kind === "supervisor") {
      return { ok: false, error: "boss 与主管席位不可删除" };
    }
    this.stopRun(agentId);
    this.terminals.clear(agentId);
    this.store.deleteAgent(agentId);
    this.event({ type: "leave", text: `「${agent.name}」已被移出办公室` });
    this.emit("agent", { agentId });
    return { ok: true };
  }

  /** 员工回复入群：只播报不再触发 @ 路由，避免托管互相唤醒形成循环 */
  postReply(agentId: string, text: string, taskId?: string | null): string | null {
    const agent = this.store.getAgentById(agentId);
    if (!agent) return null;
    const messageId = this.store.createMessage({
      fromAgentId: agent.id,
      text,
      mentionAgentIds: [],
      taskId: taskId ?? null,
    });
    this.logs.append({
      source: "message",
      agentName: agent.name,
      text: truncate(text.replaceAll(/\s+/g, " "), 300),
    });
    this.emit("message", { messageId });
    return messageId;
  }

  // ---------- 托管运行控制 ----------

  registerRunKill(agentId: string, kill: () => void): void {
    this.runKills.set(agentId, kill);
  }

  clearRunKill(agentId: string): void {
    this.runKills.delete(agentId);
  }

  /** 终止某员工当前的托管执行；无运行时返回 false */
  stopRun(agentId: string): boolean {
    const kill = this.runKills.get(agentId);
    if (!kill) return false;
    this.runKills.delete(agentId);
    try {
      kill();
    } catch {
      /* 进程可能已退出 */
    }
    this.event({ type: "stop", agentId, text: "boss 终止了当前执行" });
    return true;
  }

  /** 记录实时活动（不落 events 表，避免刷屏；经 SSE 推送） */
  setActivity(agentId: string, activity: string | null): void {
    this.store.setAgentActivity(agentId, activity);
    this.emit("activity", { agentId, activity });
  }

  // ---------- 主管分派 ----------

  /**
   * 分派工作：指定成员或由主管自动挑选。
   * 自动规则：优先空闲的托管成员（可立即执行），其次在线手工会话（按未读最少）。
   */
  dispatchWork(input: {
    title: string;
    description?: string | null;
    agentNames?: string[];
    auto?: boolean;
    requestedBy?: string;
  }): {
    task: ReturnType<OfficeStore["getTask"]>;
    assignedTo: string[];
    reason: string;
  } | null {
    let targets: AgentCard[] = [];
    let reason = "";
    if (input.agentNames && input.agentNames.length > 0) {
      targets = input.agentNames
        .map((n) => this.store.getAgentByName(n))
        .filter((a): a is AgentCard => Boolean(a));
      reason = "由用户指定";
    } else {
      const candidates = this.store
        .listAgents()
        .filter((a) => a.kind !== "user" && a.kind !== "supervisor" && a.status !== "offline");
      const managedIdle = candidates.filter(
        (a) => MANAGED_KINDS.has(a.kind) && a.status === "online",
      );
      const manualOnline = candidates
        .filter((a) => !MANAGED_KINDS.has(a.kind))
        .sort((x, y) => (x.pendingCount ?? 0) - (y.pendingCount ?? 0));
      const pick = managedIdle[0] ?? manualOnline[0] ?? candidates[0];
      if (pick) {
        targets = [pick];
        reason = managedIdle[0]
          ? "主管自动分派：选择空闲托管成员（可立即执行）"
          : "主管自动分派：选择当前最空闲的在线成员";
      }
    }
    if (targets.length === 0) {
      this.event({ type: "dispatch", text: `分派失败：没有可用成员（${input.title}）` });
      return null;
    }

    const task = this.createTask({
      title: input.title,
      description: input.description ?? null,
      createdBy: SUPERVISOR_NAME,
      assigneeName: targets.length === 1 ? targets[0].name : null,
    });
    const mentions = targets.map((a) => `@${a.name}`).join(" ");
    this.sendMessage({
      fromName: SUPERVISOR_NAME,
      text: `${mentions} 新任务「${input.title}」${input.description ? `：${input.description}` : ""}（任务ID: ${task.id}）。请认领并在完成后发布简报。${input.requestedBy ? `——由 ${input.requestedBy} 发起` : ""}`,
      taskId: task.id,
    });
    this.event({
      type: "dispatch",
      text: `主管把「${truncate(input.title, 50)}」分派给 ${targets.map((a) => a.name).join("、")}（${reason}）`,
    });
    return { task, assignedTo: targets.map((a) => a.name), reason };
  }

  // ---------- 公共知识库 ----------

  kbWrite(input: {
    id?: string;
    category: string;
    title: string;
    content: string;
    tags?: string[];
    author?: string | null;
  }): { doc: KbDoc; created: boolean } | null {
    if (input.id) {
      const doc = this.store.updateKbDoc(input.id, {
        category: input.category,
        title: input.title,
        content: input.content,
        tags: input.tags,
      });
      if (!doc) return null;
      this.emit("kb", { id: doc.id });
      this.logs.append({
        source: "kb",
        agentName: input.author ?? null,
        text: `更新知识库文档「${doc.category} / ${doc.title}」`,
      });
      return { doc, created: false };
    }
    const doc = this.store.createKbDoc(input);
    this.emit("kb", { id: doc.id });
    this.event({
      type: "kb",
      agentId: input.author ? (this.store.getAgentByName(input.author)?.id ?? null) : null,
      text: `知识库新增「${doc.category} / ${truncate(doc.title, 50)}」`,
    });
    return { doc, created: true };
  }

  kbDelete(id: string): boolean {
    const doc = this.store.getKbDoc(id);
    if (!doc) return false;
    this.store.deleteKbDoc(id);
    this.emit("kb", { id });
    this.logs.append({ source: "kb", text: `删除知识库文档「${doc.category} / ${doc.title}」` });
    return true;
  }

  // ---------- 上下文 ----------

  /** 办公室全景上下文：花名册、任务、简报、知识库目录（对所有 Agent 开放） */
  getContext(limitBriefs = 10) {
    return {
      bossName: this.bossName(),
      roster: this.store.listAgents().map((a) => ({
        name: a.name,
        kind: a.kind,
        status: a.status,
        workspace: a.workspace,
        model: (a.meta as { model?: string }).model ?? null,
        title: (a.meta as { title?: string }).title ?? null,
      })),
      openTasks: this.store.listTasks().filter((t) => t.status !== "done" && t.status !== "cancelled"),
      briefs: this.store.listBriefs(limitBriefs),
      kbCatalog: this.store.kbCatalog(),
    };
  }
}
