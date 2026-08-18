import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS } from "../src/domain/migrations.js";
import { SCHEMA } from "../src/domain/store.js";

function appliedVersions(db: DatabaseSync): number[] {
  const rows = db
    .prepare("SELECT version FROM schema_migrations")
    .all() as Array<{ version: number }>;
  return rows.map((r) => r.version).sort((a, b) => a - b);
}

function columns(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe("版本化数据库迁移", () => {
  it("全新库：走完整迁移，全部演进列就位", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    const count = applyMigrations(db);
    expect(count).toBe(MIGRATIONS.length);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(columns(db, "messages")).toEqual(
      expect.arrayContaining(["from_name", "channel", "images"]),
    );
    expect(columns(db, "briefs")).toContain("role_id");
    expect(columns(db, "kb_docs")).toEqual(
      expect.arrayContaining(["role_id", "source_type", "origin"]),
    );
    expect(columns(db, "roles")).toContain("group_id");
    expect(columns(db, "task_handoffs")).toEqual(
      expect.arrayContaining(["from_agent_id", "to_agent_id", "status", "idempotency_key"]),
    );
    expect(columns(db, "tasks")).toContain("acceptance_criteria");
    expect(columns(db, "kb_docs")).toContain("status");
    db.close();
  });

  it("老库部分迁移：只补缺失列，已有结构只打标不重复执行", () => {
    const db = new DatabaseSync(":memory:");
    // 模拟老库：messages 已具备 from_name/channel（历史已迁移），但缺 images；briefs 缺 role_id；agents 无 group_id
    db.exec(`CREATE TABLE messages(
      id TEXT PRIMARY KEY, from_agent_id TEXT, text TEXT, mentions TEXT NOT NULL DEFAULT '[]',
      task_id TEXT, created_at INTEGER NOT NULL, from_name TEXT, channel TEXT NOT NULL DEFAULT 'hall'
    );`);
    db.exec(`CREATE TABLE agents(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL
    );`);
    db.exec(
      "CREATE TABLE group_members(group_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY(group_id, agent_id));",
    );
    db.exec(`CREATE TABLE briefs(
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL, source TEXT NOT NULL,
      title TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL
    );`);
    db.exec(`CREATE TABLE kb_docs(
      id TEXT PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]', author TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`);
    db.exec(`CREATE TABLE groups(
      id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at INTEGER NOT NULL
    );`);
    db.exec(`CREATE TABLE roles(
      id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, description TEXT, created_at INTEGER NOT NULL
    );`);
    db.exec(`CREATE TABLE tasks(
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'open',
      assignee_agent_id TEXT, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`);
    db.exec(
      "INSERT INTO agents(id, name, kind, status) VALUES ('a1', '老员工', 'codex-cli', 'online');",
    );

    const count = applyMigrations(db);
    expect(count).toBe(MIGRATIONS.length);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // 缺失列补上
    expect(columns(db, "messages")).toContain("images");
    expect(columns(db, "briefs")).toContain("role_id");
    expect(columns(db, "kb_docs")).toEqual(
      expect.arrayContaining(["role_id", "source_type", "origin"]),
    );
    expect(columns(db, "roles")).toContain("group_id");
    expect(columns(db, "task_handoffs")).toContain("status");
    expect(columns(db, "tasks")).toContain("acceptance_criteria");
    expect(columns(db, "kb_docs")).toContain("status");
    // 已有列未被重复添加
    expect(columns(db, "messages").filter((c) => c === "from_name")).toHaveLength(1);
    expect(columns(db, "messages").filter((c) => c === "channel")).toHaveLength(1);
    // 老数据保留
    expect(db.prepare("SELECT name FROM agents").get()).toEqual({ name: "老员工" });
    db.close();
  });

  it("v4 数据迁移：agents.group_id 存量搬到 group_members 并清空", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    // 模拟老库的单组时代列：agents 额外带 group_id 且有存量
    db.exec("ALTER TABLE agents ADD COLUMN group_id TEXT");
    db.exec(
      `INSERT INTO agents(id, name, kind, status, group_id, created_at)
       VALUES ('a1','张三','codex-cli','online','g1', 1), ('a2','李四','codex-cli','online',NULL, 2);`,
    );

    applyMigrations(db);
    const members = db
      .prepare("SELECT group_id AS groupId, agent_id AS agentId FROM group_members")
      .all() as Array<{ groupId: string; agentId: string }>;
    expect(members).toEqual([{ groupId: "g1", agentId: "a1" }]);
    const leftover = db
      .prepare("SELECT COUNT(*) AS cnt FROM agents WHERE group_id IS NOT NULL")
      .get() as { cnt: number };
    expect(leftover.cnt).toBe(0);
    db.close();
  });

  it("幂等：二次运行不再执行任何迁移", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    expect(applyMigrations(db)).toBe(MIGRATIONS.length);
    expect(applyMigrations(db)).toBe(0);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    db.close();
  });

  it("迁移失败回滚：出错版本不入表，可重入且不重复执行已成功迁移", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    const failing = [
      ...MIGRATIONS,
      {
        version: 999,
        name: "故意失败",
        detect: () => false,
        up: () => {
          throw new Error("boom");
        },
      },
    ];
    expect(() => applyMigrations(db, failing)).toThrow(/v999（故意失败）失败：boom/);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // 失败迁移不入库，再次尝试仍抛错、不污染已成功迁移
    expect(() => applyMigrations(db, failing)).toThrow(/v999/);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    db.close();
  });
});
