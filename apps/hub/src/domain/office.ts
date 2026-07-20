import {
  HALL_CHANNEL,
  parseMentions,
  SUPERVISOR_NAME,
  type AgentCard,
  type BriefInput,
  type KbDoc,
  type OfficeGroup,
  type OfficeRole,
  type RoleDossier,
  type TaskStatus,
} from "@agent-office/protocol";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { OfficeBus } from "./bus.js";
import { LogBook } from "./logbook.js";
import type { OfficeStore } from "./store.js";
import { TerminalLog } from "./terminal.js";
import { truncate } from "../util.js";

export type ManagedDispatcher = (
  agent: AgentCard,
  message: {
    fromName: string;
    text: string;
    taskId?: string | null;
    raw?: boolean;
    /** 回复要落回的频道（hall 或项目组 ID） */
    channel?: string;
    /** 附图 URL（/files/xxx），派发时解析成本地路径注入提示词 */
    images?: string[];
  },
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
  /** 上传目录（服务器启动时注入），用于把附图 URL 解析成本地绝对路径 */
  uploadsDir: string | null = null;

  constructor(
    readonly store: OfficeStore,
    readonly bus: OfficeBus,
  ) {
    this.terminals = new TerminalLog(bus);
    this.logs = new LogBook(bus);
    // 托管终端每一行同时汇入统一日志流，并落库到该员工的对话历史
    this.terminals.onLine = (agentId, line) => {
      this.logs.append({
        level: line.kind === "error" ? "error" : "info",
        source: "terminal",
        agentName: this.store.getAgentById(agentId)?.name ?? null,
        text: line.text,
      });
      this.store.appendHistory(agentId, line.kind, line.text);
      this.emit("history", { agentId });
    };
    // 确保人类用户与主管席位存在（boss 可能已改过称呼，按 kind 判断）
    if (!store.listAgents().some((a) => a.kind === "user")) {
      store.registerAgent({ name: USER_AGENT_NAME, kind: "user", status: "online" });
    }
    if (!store.getAgentByName(SUPERVISOR_NAME)) {
      store.registerAgent({ name: SUPERVISOR_NAME, kind: "supervisor", status: "online" });
    }
  }

  /** 附图 URL（/files/xxx）→ 本地绝对路径；只认 uploads 目录下真实存在的文件 */
  resolveImagePaths(urls: string[] | undefined): string[] {
    if (!urls || urls.length === 0 || !this.uploadsDir) return [];
    return urls
      .map((u) => join(this.uploadsDir!, basename(u)))
      .filter((p) => existsSync(p));
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
    /** 频道：hall（默认大群）或项目组 ID */
    channel?: string;
    /** 附图 URL（/files/xxx） */
    images?: string[];
  }): {
    messageId: string;
    routed: Array<{ name: string; mode: "managed" | "inbox" | "supervisor" }>;
    unmatched: boolean;
  } {
    const sender =
      this.store.getAgentByName(input.fromName) ??
      this.store.registerAgent({ name: input.fromName, kind: "user" });
    const channel =
      input.channel && this.store.getGroupById(input.channel) ? input.channel : HALL_CHANNEL;
    const roster = this.store.listAgents();
    const rosterNames = roster.map((a) => a.name);
    const { targets, all } = parseMentions(input.text, rosterNames);

    const targetAgents = new Map<string, AgentCard>();
    for (const name of targets) {
      const agent = this.store.getAgentByName(name);
      if (agent && agent.id !== sender.id) targetAgents.set(agent.id, agent);
    }
    if (all) {
      // @all 只广播给普通成员；组频道里只喊本组人；主管只响应显式 @主管
      for (const agent of roster) {
        if (agent.id === sender.id || agent.kind === "user" || agent.kind === "supervisor") {
          continue;
        }
        if (channel !== HALL_CHANNEL && !agent.groupIds?.includes(channel)) continue;
        targetAgents.set(agent.id, agent);
      }
    }

    const messageId = this.store.createMessage({
      fromAgentId: sender.id,
      text: input.text,
      mentionAgentIds: [...targetAgents.keys()],
      taskId: input.taskId ?? null,
      channel,
      images: input.images,
    });
    // 定向给在岗者的消息进岗位档案，接任者可完整继承（账号、指示、结论都在里面）
    for (const agent of targetAgents.values()) {
      const roleId = (agent.meta as { roleId?: string }).roleId;
      if (roleId) this.store.tagRoleMessage(roleId, messageId);
    }
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
          channel,
          images: input.images,
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
    messages: Array<{
      messageId: string;
      fromName: string;
      text: string;
      taskId: string | null;
      channel: string;
      images: string[];
      createdAt: number;
    }>;
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

  // ---------- 项目组 ----------

  createGroup(name: string): { ok: boolean; error?: string; group?: OfficeGroup } {
    const group = this.store.createGroup(name);
    if (!group) return { ok: false, error: "组名为空或已存在" };
    this.event({ type: "group", text: `新建项目组「${group.name}」` });
    this.emit("group", { groupId: group.id });
    return { ok: true, group };
  }

  deleteGroup(groupId: string): { ok: boolean; error?: string } {
    const group = this.store.getGroupById(groupId);
    if (!group) return { ok: false, error: "项目组不存在" };
    this.store.deleteGroup(groupId);
    this.event({ type: "group", text: `项目组「${group.name}」已解散，成员回到大群` });
    this.emit("group", { groupId });
    return { ok: true };
  }

  /** 整体覆盖员工的组归属；支持同时在多个组，传空数组表示退出所有组 */
  assignGroups(agentId: string, groupIds: string[]): { ok: boolean; error?: string } {
    const agent = this.store.getAgentById(agentId);
    if (!agent) return { ok: false, error: "成员不存在" };
    if (agent.kind === "user" || agent.kind === "supervisor") {
      return { ok: false, error: "boss 与主管不归属任何项目组（全频道可见）" };
    }
    if (!this.store.setAgentGroups(agentId, groupIds)) {
      return { ok: false, error: "存在无效的项目组" };
    }
    const names = this.store
      .agentGroupIds(agentId)
      .map((gid) => this.store.getGroupById(gid)?.name)
      .filter(Boolean);
    this.event({
      type: "group",
      agentId,
      text:
        names.length > 0
          ? `「${agent.name}」的项目组调整为：${names.join("、")}`
          : `「${agent.name}」退出所有项目组，回到大群`,
    });
    this.emit("agent", { agentId });
    return { ok: true };
  }

  // ---------- 职位（岗位上下文交接） ----------

  createRole(name: string, description?: string): { ok: boolean; error?: string; role?: OfficeRole } {
    if (!name.trim()) return { ok: false, error: "职位名不能为空" };
    const role = this.store.createRole(name, description);
    if (!role) return { ok: false, error: "职位已存在" };
    this.event({ type: "role", text: `新建职位「${role.name}」` });
    this.emit("role", { roleId: role.id });
    return { ok: true, role };
  }

  deleteRole(roleId: string): { ok: boolean; error?: string } {
    const role = this.store.getRoleById(roleId);
    if (!role) return { ok: false, error: "职位不存在" };
    this.store.deleteRole(roleId);
    this.event({ type: "role", text: `职位「${role.name}」已撤销，档案一并清除` });
    this.emit("role", { roleId });
    this.emit("agent", {});
    return { ok: true };
  }

  /** 任免：把职位（连同全部岗位档案）交给某位员工；roleId 传 null 卸任 */
  assignRole(agentId: string, roleId: string | null): { ok: boolean; error?: string } {
    const agent = this.store.getAgentById(agentId);
    if (!agent) return { ok: false, error: "成员不存在" };
    if (agent.kind === "user") return { ok: false, error: "boss 不占用职位" };
    const prevRoleId = (agent.meta as { roleId?: string }).roleId;
    if (!this.store.setAgentRole(agentId, roleId)) {
      return { ok: false, error: "职位不存在" };
    }
    if (roleId && roleId !== prevRoleId) {
      const role = this.store.getRoleById(roleId)!;
      const dossier = this.roleDossier(roleId);
      this.event({
        type: "role",
        agentId,
        text: `「${agent.name}」接任职位「${role.name}」，继承岗位档案（${dossier?.notes.length ?? 0} 条笔记 / ${dossier?.briefs.length ?? 0} 份历任简报 / ${dossier?.messages.length ?? 0} 条岗位消息）`,
      });
    } else if (!roleId && prevRoleId) {
      const prev = this.store.getRoleById(prevRoleId);
      this.event({
        type: "role",
        agentId,
        text: `「${agent.name}」卸任「${prev?.name ?? "职位"}」，岗位档案保留待下一任接手`,
      });
    }
    this.emit("agent", { agentId });
    return { ok: true };
  }

  /** 职位交接档案：笔记 + 历任简报 + 岗位收到过的定向消息 */
  roleDossier(roleId: string): RoleDossier | null {
    const role = this.store.listRoles().find((r) => r.id === roleId);
    if (!role) return null;
    return {
      role,
      notes: this.store.listRoleNotes(roleId),
      briefs: this.store.roleBriefs(roleId, 10).map((b) => ({
        agentName: b.agentName,
        title: b.title,
        result: b.result,
        createdAt: b.createdAt,
      })),
      messages: this.store.roleMessages(roleId, 30),
    };
  }

  /** 员工当前职位的交接档案（无职位返回 null） */
  agentRoleDossier(agent: AgentCard): RoleDossier | null {
    const roleId = (agent.meta as { roleId?: string }).roleId;
    return roleId ? this.roleDossier(roleId) : null;
  }

  writeRoleNote(input: {
    roleId?: string;
    roleName?: string;
    title: string;
    content: string;
    author?: string;
  }): { ok: boolean; error?: string; noteId?: string } {
    const role = input.roleId
      ? this.store.getRoleById(input.roleId)
      : this.store.listRoles().find((r) => r.name.toLowerCase() === input.roleName?.trim().toLowerCase());
    if (!role) return { ok: false, error: "职位不存在" };
    const note = this.store.createRoleNote({
      roleId: role.id,
      title: input.title,
      content: input.content,
      author: input.author ?? null,
    });
    if (!note) return { ok: false, error: "笔记写入失败" };
    this.event({
      type: "role",
      text: `「${input.author ?? "匿名"}」向职位「${role.name}」档案写入笔记：${truncate(input.title, 60)}`,
    });
    this.emit("role", { roleId: role.id });
    return { ok: true, noteId: note.id };
  }

  /** 清空某频道的全部消息（大群或项目组频道） */
  clearChannel(channel: string): { ok: boolean; error?: string; cleared?: number } {
    if (channel !== HALL_CHANNEL && !this.store.getGroupById(channel)) {
      return { ok: false, error: "频道不存在" };
    }
    const cleared = this.store.clearChannelMessages(channel);
    const label =
      channel === HALL_CHANNEL ? "大群" : `#${this.store.getGroupById(channel)?.name}`;
    this.event({ type: "channel", text: `${label} 的 ${cleared} 条消息已清空` });
    this.emit("message", {});
    return { ok: true, cleared };
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
  postReply(
    agentId: string,
    text: string,
    taskId?: string | null,
    channel?: string,
  ): string | null {
    const agent = this.store.getAgentById(agentId);
    if (!agent) return null;
    const messageId = this.store.createMessage({
      fromAgentId: agent.id,
      text,
      mentionAgentIds: [],
      taskId: taskId ?? null,
      channel: channel && this.store.getGroupById(channel) ? channel : HALL_CHANNEL,
    });
    this.logs.append({
      source: "message",
      agentName: agent.name,
      text: truncate(text.replaceAll(/\s+/g, " "), 300),
    });
    this.emit("message", { messageId });
    return messageId;
  }

  /**
   * 唤醒离席的手工会话：凭续聊凭证（Codex threadId / Claude sessionId）
   * 把它转成托管工位，之后 @它 就能由办公室直接拉起执行；
   * 离席期间积压的未读消息会立即作为第一轮任务处理。
   */
  promoteAgent(agentId: string): { ok: boolean; error?: string; agent?: AgentCard } {
    const agent = this.store.getAgentById(agentId);
    if (!agent) return { ok: false, error: "成员不存在" };
    const meta = agent.meta as { threadId?: string; sessionId?: string };
    let newKind: "codex-managed" | "claude-managed";
    if (agent.kind === "codex-cli" && meta.threadId) {
      newKind = "codex-managed";
    } else if (agent.kind === "claude-cli" && meta.sessionId) {
      newKind = "claude-managed";
    } else if (agent.kind === "cursor-ide") {
      return { ok: false, error: "Cursor 会话无法从办公室唤醒，请回到 Cursor 里继续那个对话" };
    } else {
      return { ok: false, error: "该成员没有可续聊的会话凭证（threadId/sessionId），无法转托管" };
    }
    this.store.updateAgentKind(agentId, newKind);
    this.store.setAgentStatus(agentId, "online");
    this.event({
      type: "join",
      agentId,
      text: `「${agent.name}」被唤醒并转为托管工位（沿用原会话续聊）`,
    });

    // 离席期间的未读立即作为第一轮任务派下去
    const pending = this.store.pendingMessagesFor(agentId);
    const fresh = this.store.getAgentById(agentId)!;
    if (pending.length > 0 && this.managedDispatcher) {
      this.store.markDeliveriesRead(agentId);
      const backlog = pending.map((m) => `- ${m.fromName}：${m.text}`).join("\n");
      this.managedDispatcher(fresh, {
        fromName: this.bossName(),
        text: `你离席期间收到以下消息，请逐条处理并汇报结果：\n${backlog}`,
        channel: pending[pending.length - 1].channel,
        images: pending.flatMap((m) => m.images),
      });
    }
    this.emit("agent", { agentId });
    return { ok: true, agent: fresh };
  }

  /**
   * 启动恢复：hub 重启会丢内存执行队列，但未读投递全在库里。
   * 把每个托管员工的积压未读重新派发出去，保证"重启不丢活"（消息表即持久队列）。
   */
  recoverPendingDispatches(): number {
    if (!this.managedDispatcher) return 0;
    let recovered = 0;
    for (const agent of this.store.listAgents()) {
      if (!MANAGED_KINDS.has(agent.kind)) continue;
      const pending = this.store.pendingMessagesFor(agent.id);
      if (pending.length === 0) continue;
      this.store.markDeliveriesRead(agent.id);
      this.event({
        type: "run",
        agentId: agent.id,
        text: `重启恢复：补派 ${pending.length} 条积压消息`,
      });
      if (pending.length === 1) {
        const only = pending[0];
        this.managedDispatcher(agent, {
          fromName: only.fromName,
          text: only.text,
          taskId: only.taskId,
          channel: only.channel,
          images: only.images,
        });
      } else {
        const backlog = pending.map((m) => `- ${m.fromName}：${m.text}`).join("\n");
        this.managedDispatcher(agent, {
          fromName: this.bossName(),
          text: `办公室重启前你有以下未处理消息，请逐条处理并汇报结果：\n${backlog}`,
          channel: pending[pending.length - 1].channel,
          images: pending.flatMap((m) => m.images),
        });
      }
      recovered += 1;
    }
    return recovered;
  }

  /**
   * 终端直连输入：把老板敲的内容**原样**发进该成员的底层会话（不套办公室提示词模板），
   * 用于精细化调整某个终端；对有续聊凭证的手工会话（codex-cli/claude-cli）输入即激活续聊。
   * 结果只回显在终端/历史里，不进群、不发简报。
   */
  directInput(
    agentId: string,
    text: string,
    images?: string[],
  ): { ok: boolean; error?: string } {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "输入内容为空" };
    const agent = this.store.getAgentById(agentId);
    if (!agent) return { ok: false, error: "成员不存在" };
    const meta = agent.meta as { threadId?: string; sessionId?: string };
    const eligible =
      MANAGED_KINDS.has(agent.kind) ||
      (agent.kind === "codex-cli" && !!meta.threadId) ||
      (agent.kind === "claude-cli" && !!meta.sessionId);
    if (!eligible) {
      return {
        ok: false,
        error: "该成员不支持终端直连输入（需要托管工位或带续聊凭证的 codex/claude 会话）",
      };
    }
    if (!this.managedDispatcher) return { ok: false, error: "托管调度器未就绪" };
    this.managedDispatcher(agent, {
      fromName: this.bossName(),
      text: trimmed,
      raw: true,
      images,
    });
    return { ok: true };
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

  /**
   * 记录一条员工对话历史（提问 prompt / 回复 final 等），持久化并经 SSE 推送。
   * 手工会话（Cursor/Codex/Claude）经 hooks 同步进来，托管会话走终端流自动落库。
   */
  recordHistory(agentId: string, kind: "prompt" | "final" | "info", text: string): void {
    if (!text.trim()) return;
    this.store.appendHistory(agentId, kind, text);
    this.emit("history", { agentId });
  }

  /**
   * 闲置清扫：手工会话（Cursor/Codex/Claude）超过 idleMs 没有任何动静就标记离席，
   * 避免早已关闭的会话一直显示"在席"，让人误以为 @它 会有响应。
   */
  sweepIdleSessions(idleMs = 30 * 60_000): number {
    const cutoff = Date.now() - idleMs;
    const sessionKinds = new Set(["cursor-ide", "codex-cli", "claude-cli"]);
    let swept = 0;
    for (const agent of this.store.listAgents()) {
      if (!sessionKinds.has(agent.kind)) continue;
      if (agent.status === "offline") continue;
      if ((agent.lastSeenAt ?? 0) >= cutoff) continue;
      this.store.setAgentStatusQuiet(agent.id, "offline");
      this.emit("agent", { agentId: agent.id });
      swept += 1;
    }
    return swept;
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
      groups: this.store.listGroups(),
      roles: this.store.listRoles(),
      roster: this.store.listAgents().map((a) => ({
        name: a.name,
        kind: a.kind,
        status: a.status,
        workspace: a.workspace,
        model: (a.meta as { model?: string }).model ?? null,
        title: (a.meta as { title?: string }).title ?? null,
        groups: a.groupNames ?? [],
      })),
      openTasks: this.store.listTasks().filter((t) => t.status !== "done" && t.status !== "cancelled"),
      briefs: this.store.listBriefs(limitBriefs),
      kbCatalog: this.store.kbCatalog(),
    };
  }
}
