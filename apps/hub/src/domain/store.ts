import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AgentCard,
  AgentKind,
  AgentStatus,
  BriefInput,
  KbDoc,
  OfficeBrief,
  OfficeEvent,
  OfficeMessage,
  OfficeTask,
  TaskStatus,
} from "@agent-office/protocol";
import { now, uuid } from "../util.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline',
  workspace TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  external_key TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY,
  from_agent_id TEXT,
  text TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  task_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries(
  message_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  read_at INTEGER,
  PRIMARY KEY(message_id, to_agent_id)
);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  assignee_agent_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS briefs(
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  title TEXT NOT NULL,
  result TEXT NOT NULL,
  progress TEXT,
  decisions TEXT,
  artifacts TEXT,
  blockers TEXT,
  next_steps TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  agent_id TEXT,
  text TEXT,
  payload TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS token_usage(
  agent_id TEXT NOT NULL,
  day TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(agent_id, day)
);
CREATE TABLE IF NOT EXISTS kb_docs(
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  author TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_category ON kb_docs(category, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_to ON deliveries(to_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_briefs_created ON briefs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
`;

interface AgentRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  workspace: string | null;
  meta: string;
  last_seen_at: number | null;
  created_at: number;
}

/** 本地时区的 YYYY-MM-DD，作为 token 日结键 */
function dayKey(): string {
  return new Date().toLocaleDateString("sv");
}

function rowToAgent(row: AgentRow): AgentCard {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as AgentKind,
    status: row.status as AgentStatus,
    workspace: row.workspace,
    meta: JSON.parse(row.meta ?? "{}"),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

export class OfficeStore {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    // 旧库迁移：消息记录发件人名字快照，员工删除后历史仍可读
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN from_name TEXT");
    } catch {
      /* 列已存在 */
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------- Agents ----------

  registerAgent(input: {
    name: string;
    kind: AgentKind;
    workspace?: string | null;
    meta?: Record<string, unknown>;
    status?: AgentStatus;
  }): AgentCard {
    const existing = this.getAgentByName(input.name);
    if (existing) {
      this.db
        .prepare(
          `UPDATE agents SET status = ?, workspace = COALESCE(?, workspace),
           meta = ?, last_seen_at = ? WHERE id = ?`,
        )
        .run(
          input.status ?? "online",
          input.workspace ?? null,
          JSON.stringify({ ...existing.meta, ...(input.meta ?? {}) }),
          now(),
          existing.id,
        );
      return this.getAgentById(existing.id)!;
    }
    const id = uuid();
    this.db
      .prepare(
        `INSERT INTO agents(id, name, kind, status, workspace, meta, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.kind,
        input.status ?? "online",
        input.workspace ?? null,
        JSON.stringify(input.meta ?? {}),
        now(),
        now(),
      );
    return this.getAgentById(id)!;
  }

  getAgentById(id: string): AgentCard | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as
      | AgentRow
      | undefined;
    return row ? rowToAgent(row) : null;
  }

  getAgentByName(name: string): AgentCard | null {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE name = ? COLLATE NOCASE")
      .get(name) as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  listAgents(): AgentCard[] {
    const rows = this.db
      .prepare("SELECT * FROM agents ORDER BY created_at ASC")
      .all() as unknown as AgentRow[];
    const agents = rows.map(rowToAgent);
    const pending = this.db
      .prepare(
        `SELECT to_agent_id AS agentId, COUNT(*) AS cnt FROM deliveries
         WHERE status = 'pending' GROUP BY to_agent_id`,
      )
      .all() as unknown as Array<{ agentId: string; cnt: number }>;
    const map = new Map(pending.map((p) => [p.agentId, p.cnt]));
    const tokens = this.db
      .prepare("SELECT agent_id AS agentId, tokens FROM token_usage WHERE day = ?")
      .all(dayKey()) as unknown as Array<{ agentId: string; tokens: number }>;
    const tokenMap = new Map(tokens.map((t) => [t.agentId, t.tokens]));
    const done = this.db
      .prepare(
        `SELECT assignee_agent_id AS agentId, COUNT(*) AS cnt FROM tasks
         WHERE status = 'done' AND assignee_agent_id IS NOT NULL GROUP BY assignee_agent_id`,
      )
      .all() as unknown as Array<{ agentId: string; cnt: number }>;
    const doneMap = new Map(done.map((d) => [d.agentId, d.cnt]));
    for (const agent of agents) {
      agent.pendingCount = map.get(agent.id) ?? 0;
      agent.todayTokens = tokenMap.get(agent.id) ?? 0;
      agent.doneTasks = doneMap.get(agent.id) ?? 0;
    }
    return agents;
  }

  /** 累计今日 token 用量（托管执行结束时调用） */
  addTokens(agentId: string, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.db
      .prepare(
        `INSERT INTO token_usage(agent_id, day, tokens) VALUES (?, ?, ?)
         ON CONFLICT(agent_id, day) DO UPDATE SET tokens = tokens + excluded.tokens`,
      )
      .run(agentId, dayKey(), Math.round(tokens));
  }

  todayTokens(agentId: string): number {
    const row = this.db
      .prepare("SELECT tokens FROM token_usage WHERE agent_id = ? AND day = ?")
      .get(agentId, dayKey()) as { tokens: number } | undefined;
    return row?.tokens ?? 0;
  }

  /** 删除员工：清收件箱/会话/用量；历史消息与简报保留（靠名字快照） */
  deleteAgent(agentId: string): boolean {
    const agent = this.getAgentById(agentId);
    if (!agent) return false;
    this.db.prepare("DELETE FROM deliveries WHERE to_agent_id = ?").run(agentId);
    this.db.prepare("DELETE FROM sessions WHERE agent_id = ?").run(agentId);
    this.db.prepare("DELETE FROM token_usage WHERE agent_id = ?").run(agentId);
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    return true;
  }

  setAgentStatus(agentId: string, status: AgentStatus): void {
    this.db
      .prepare("UPDATE agents SET status = ?, last_seen_at = ? WHERE id = ?")
      .run(status, now(), agentId);
  }

  /** 改名（工号唯一）；冲突时返回 null */
  renameAgent(agentId: string, newName: string): AgentCard | null {
    const existing = this.getAgentByName(newName);
    if (existing && existing.id !== agentId) return null;
    this.db.prepare("UPDATE agents SET name = ? WHERE id = ?").run(newName, agentId);
    return this.getAgentById(agentId);
  }

  /** 记录 Agent 当前正在做的事（实时工作台展示） */
  setAgentActivity(agentId: string, activity: string | null): void {
    this.updateAgentMeta(agentId, {
      lastActivity: activity,
      lastActivityAt: activity ? now() : undefined,
    });
    this.db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(now(), agentId);
  }

  updateAgentMeta(agentId: string, patch: Record<string, unknown>): void {
    const agent = this.getAgentById(agentId);
    if (!agent) return;
    this.db
      .prepare("UPDATE agents SET meta = ? WHERE id = ?")
      .run(JSON.stringify({ ...agent.meta, ...patch }), agentId);
  }

  /** 通过外部会话键（cursor:conv:x / codex:thread:x）找到或创建 Agent */
  upsertAgentBySession(
    externalKey: string,
    defaults: {
      name: string;
      kind: AgentKind;
      workspace?: string | null;
      meta?: Record<string, unknown>;
    },
  ): AgentCard {
    const row = this.db
      .prepare("SELECT agent_id FROM sessions WHERE external_key = ?")
      .get(externalKey) as { agent_id: string } | undefined;
    if (row) {
      const agent = this.getAgentById(row.agent_id);
      if (agent) {
        this.db
          .prepare("UPDATE agents SET last_seen_at = ?, status = ? WHERE id = ?")
          .run(now(), "online", agent.id);
        if (defaults.meta) this.updateAgentMeta(agent.id, defaults.meta);
        return this.getAgentById(agent.id)!;
      }
    }
    const agent = this.registerAgent(defaults);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO sessions(external_key, agent_id, created_at) VALUES (?, ?, ?)",
      )
      .run(externalKey, agent.id, now());
    return agent;
  }

  // ---------- Messages / deliveries ----------

  createMessage(input: {
    fromAgentId: string | null;
    text: string;
    mentionAgentIds: string[];
    taskId?: string | null;
  }): string {
    const id = uuid();
    const fromName = input.fromAgentId
      ? (this.getAgentById(input.fromAgentId)?.name ?? null)
      : null;
    this.db
      .prepare(
        `INSERT INTO messages(id, from_agent_id, from_name, text, mentions, task_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.fromAgentId,
        fromName,
        input.text,
        JSON.stringify(input.mentionAgentIds),
        input.taskId ?? null,
        now(),
      );
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO deliveries(message_id, to_agent_id, status) VALUES (?, ?, 'pending')",
    );
    for (const toId of input.mentionAgentIds) stmt.run(id, toId);
    return id;
  }

  listMessages(limit = 100): OfficeMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.from_agent_id, m.text, m.mentions, m.task_id, m.created_at,
                COALESCE(a.name, m.from_name) AS from_name FROM messages m
         LEFT JOIN agents a ON a.id = m.from_agent_id
         ORDER BY m.created_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as Array<{
      id: string;
      from_agent_id: string | null;
      from_name: string | null;
      text: string;
      mentions: string;
      task_id: string | null;
      created_at: number;
    }>;
    const deliveryStmt = this.db.prepare(
      `SELECT d.status, a.name AS to_name FROM deliveries d
       JOIN agents a ON a.id = d.to_agent_id WHERE d.message_id = ?`,
    );
    return rows.reverse().map((row) => ({
      id: row.id,
      fromAgentId: row.from_agent_id,
      fromName: row.from_name ?? "系统",
      text: row.text,
      mentions: JSON.parse(row.mentions) as string[],
      taskId: row.task_id,
      createdAt: row.created_at,
      deliveries: (deliveryStmt.all(row.id) as unknown as Array<{
        status: "pending" | "read";
        to_name: string;
      }>).map((d) => ({ toName: d.to_name, status: d.status })),
    }));
  }

  pendingMessagesFor(agentId: string): Array<{
    messageId: string;
    fromName: string;
    text: string;
    taskId: string | null;
    createdAt: number;
  }> {
    return (
      this.db
        .prepare(
          `SELECT m.id AS messageId, COALESCE(a.name, m.from_name, '系统') AS fromName,
                  m.text, m.task_id AS taskId, m.created_at AS createdAt
           FROM deliveries d
           JOIN messages m ON m.id = d.message_id
           LEFT JOIN agents a ON a.id = m.from_agent_id
           WHERE d.to_agent_id = ? AND d.status = 'pending'
           ORDER BY m.created_at ASC`,
        )
        .all(agentId) as unknown as Array<{
        messageId: string;
        fromName: string;
        text: string;
        taskId: string | null;
        createdAt: number;
      }>
    );
  }

  markDeliveriesRead(agentId: string, messageIds?: string[]): number {
    if (messageIds && messageIds.length > 0) {
      const stmt = this.db.prepare(
        `UPDATE deliveries SET status = 'read', read_at = ?
         WHERE to_agent_id = ? AND message_id = ? AND status = 'pending'`,
      );
      let count = 0;
      for (const id of messageIds) count += Number(stmt.run(now(), agentId, id).changes);
      return count;
    }
    const result = this.db
      .prepare(
        `UPDATE deliveries SET status = 'read', read_at = ?
         WHERE to_agent_id = ? AND status = 'pending'`,
      )
      .run(now(), agentId);
    return Number(result.changes);
  }

  pendingCount(agentId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM deliveries WHERE to_agent_id = ? AND status = 'pending'",
      )
      .get(agentId) as { cnt: number };
    return row.cnt;
  }

  // ---------- Tasks ----------

  createTask(input: {
    title: string;
    description?: string | null;
    createdBy?: string | null;
    assigneeAgentId?: string | null;
  }): OfficeTask {
    const id = uuid();
    const t = now();
    this.db
      .prepare(
        `INSERT INTO tasks(id, title, description, status, assignee_agent_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.description ?? null,
        input.assigneeAgentId ? "claimed" : "open",
        input.assigneeAgentId ?? null,
        input.createdBy ?? null,
        t,
        t,
      );
    return this.getTask(id)!;
  }

  getTask(id: string): OfficeTask | null {
    const row = this.db
      .prepare(
        `SELECT t.*, a.name AS assignee_name FROM tasks t
         LEFT JOIN agents a ON a.id = t.assignee_agent_id WHERE t.id = ?`,
      )
      .get(id) as
      | {
          id: string;
          title: string;
          description: string | null;
          status: string;
          assignee_agent_id: string | null;
          assignee_name: string | null;
          created_by: string | null;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status as TaskStatus,
      assigneeAgentId: row.assignee_agent_id,
      assigneeName: row.assignee_name,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listTasks(): OfficeTask[] {
    const rows = this.db
      .prepare("SELECT id FROM tasks ORDER BY created_at DESC LIMIT 200")
      .all() as unknown as Array<{ id: string }>;
    return rows.map((r) => this.getTask(r.id)!).filter(Boolean);
  }

  updateTask(
    id: string,
    patch: { status?: TaskStatus; assigneeAgentId?: string | null },
  ): OfficeTask | null {
    const task = this.getTask(id);
    if (!task) return null;
    this.db
      .prepare(
        "UPDATE tasks SET status = ?, assignee_agent_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.status ?? task.status,
        patch.assigneeAgentId === undefined ? task.assigneeAgentId : patch.assigneeAgentId,
        now(),
        id,
      );
    return this.getTask(id);
  }

  // ---------- Briefs ----------

  /** 幂等写入简报；idempotencyKey 冲突时返回 null（表示已存在） */
  insertBrief(input: {
    agentId: string;
    kind: "manual" | "auto";
    source: string;
    brief: BriefInput;
    idempotencyKey?: string;
  }): OfficeBrief | null {
    const id = uuid();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO briefs(
           id, agent_id, task_id, kind, source, idempotency_key,
           title, result, progress, decisions, artifacts, blockers, next_steps, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.agentId,
        input.brief.task_id ?? null,
        input.kind,
        input.source,
        input.idempotencyKey ?? id,
        input.brief.title,
        input.brief.result,
        input.brief.progress ?? null,
        input.brief.decisions ?? null,
        input.brief.artifacts ?? null,
        input.brief.blockers ?? null,
        input.brief.next_steps ?? null,
        now(),
      );
    if (Number(result.changes) === 0) return null;
    return this.getBrief(id);
  }

  getBrief(id: string): OfficeBrief | null {
    const row = this.db
      .prepare(
        `SELECT b.*, COALESCE(a.name, '已离职成员') AS agent_name FROM briefs b
         LEFT JOIN agents a ON a.id = b.agent_id WHERE b.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.briefFromRow(row) : null;
  }

  listBriefs(limit = 50): OfficeBrief[] {
    const rows = this.db
      .prepare(
        `SELECT b.*, COALESCE(a.name, '已离职成员') AS agent_name FROM briefs b
         LEFT JOIN agents a ON a.id = b.agent_id
         ORDER BY b.created_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => this.briefFromRow(r));
  }

  private briefFromRow(row: Record<string, unknown>): OfficeBrief {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      agentName: row.agent_name as string,
      taskId: (row.task_id as string) ?? null,
      kind: row.kind as "manual" | "auto",
      source: row.source as string,
      title: row.title as string,
      result: row.result as string,
      progress: (row.progress as string) ?? null,
      decisions: (row.decisions as string) ?? null,
      artifacts: (row.artifacts as string) ?? null,
      blockers: (row.blockers as string) ?? null,
      nextSteps: (row.next_steps as string) ?? null,
      createdAt: row.created_at as number,
    };
  }

  // ---------- Events ----------

  insertEvent(input: {
    type: string;
    agentId?: string | null;
    text?: string | null;
    payload?: unknown;
  }): OfficeEvent {
    const id = uuid();
    this.db
      .prepare(
        "INSERT INTO events(id, type, agent_id, text, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.type,
        input.agentId ?? null,
        input.text ?? null,
        input.payload === undefined ? null : JSON.stringify(input.payload),
        now(),
      );
    const agent = input.agentId ? this.getAgentById(input.agentId) : null;
    return {
      id,
      type: input.type,
      agentId: input.agentId ?? null,
      agentName: agent?.name ?? null,
      text: input.text ?? null,
      createdAt: now(),
    };
  }

  listEvents(limit = 100): OfficeEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.type, e.agent_id, e.text, e.created_at, a.name AS agent_name
         FROM events e LEFT JOIN agents a ON a.id = e.agent_id
         ORDER BY e.created_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as Array<{
      id: string;
      type: string;
      agent_id: string | null;
      text: string | null;
      created_at: number;
      agent_name: string | null;
    }>;
    return rows.reverse().map((r) => ({
      id: r.id,
      type: r.type,
      agentId: r.agent_id,
      agentName: r.agent_name,
      text: r.text,
      createdAt: r.created_at,
    }));
  }

  // ---------- 公共知识库 ----------

  createKbDoc(input: {
    category: string;
    title: string;
    content: string;
    tags?: string[];
    author?: string | null;
  }): KbDoc {
    const id = uuid();
    this.db
      .prepare(
        `INSERT INTO kb_docs(id, category, title, content, tags, author, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.category.trim(),
        input.title.trim(),
        input.content,
        JSON.stringify(input.tags ?? []),
        input.author ?? null,
        now(),
        now(),
      );
    return this.getKbDoc(id)!;
  }

  updateKbDoc(
    id: string,
    patch: { category?: string; title?: string; content?: string; tags?: string[] },
  ): KbDoc | null {
    const existing = this.getKbDoc(id);
    if (!existing) return null;
    this.db
      .prepare(
        `UPDATE kb_docs SET category = ?, title = ?, content = ?, tags = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.category?.trim() || existing.category,
        patch.title?.trim() || existing.title,
        patch.content ?? existing.content,
        JSON.stringify(patch.tags ?? existing.tags),
        now(),
        id,
      );
    return this.getKbDoc(id);
  }

  deleteKbDoc(id: string): boolean {
    if (!this.getKbDoc(id)) return false;
    this.db.prepare("DELETE FROM kb_docs WHERE id = ?").run(id);
    return true;
  }

  getKbDoc(id: string): KbDoc | null {
    const row = this.db.prepare("SELECT * FROM kb_docs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? kbFromRow(row) : null;
  }

  /** 目录索引：分类 → 文档标题清单（不含正文，供快速索引） */
  kbCatalog(): Array<{
    category: string;
    docs: Array<{ id: string; title: string; tags: string[]; updatedAt: number }>;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, category, title, tags, updated_at FROM kb_docs
         ORDER BY category ASC, updated_at DESC`,
      )
      .all() as unknown as Array<Record<string, unknown>>;
    const byCategory = new Map<
      string,
      Array<{ id: string; title: string; tags: string[]; updatedAt: number }>
    >();
    for (const row of rows) {
      const category = row.category as string;
      const list = byCategory.get(category) ?? [];
      list.push({
        id: row.id as string,
        title: row.title as string,
        tags: JSON.parse((row.tags as string) ?? "[]"),
        updatedAt: row.updated_at as number,
      });
      byCategory.set(category, list);
    }
    return [...byCategory.entries()].map(([category, docs]) => ({ category, docs }));
  }

  /** 关键词检索：标题/正文/标签/分类 LIKE 匹配 */
  searchKbDocs(query: string, limit = 20): KbDoc[] {
    const like = `%${query.trim()}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM kb_docs
         WHERE title LIKE ? OR content LIKE ? OR tags LIKE ? OR category LIKE ?
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(like, like, like, like, limit) as unknown as Array<Record<string, unknown>>;
    return rows.map(kbFromRow);
  }

  listKbDocs(category?: string, limit = 100): KbDoc[] {
    const rows = category
      ? (this.db
          .prepare("SELECT * FROM kb_docs WHERE category = ? ORDER BY updated_at DESC LIMIT ?")
          .all(category, limit) as unknown as Array<Record<string, unknown>>)
      : (this.db
          .prepare("SELECT * FROM kb_docs ORDER BY updated_at DESC LIMIT ?")
          .all(limit) as unknown as Array<Record<string, unknown>>);
    return rows.map(kbFromRow);
  }
}

function kbFromRow(row: Record<string, unknown>): KbDoc {
  return {
    id: row.id as string,
    category: row.category as string,
    title: row.title as string,
    content: row.content as string,
    tags: JSON.parse((row.tags as string) ?? "[]"),
    author: (row.author as string) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
