import type { DatabaseSync } from "node:sqlite";
import { now } from "../util.js";

interface Migration {
  version: number;
  name: string;
  /** 该迁移是否已对当前库生效——老库可能已手工具备该结构，只打标不再重复执行 */
  detect: (db: DatabaseSync) => boolean;
  up: (db: DatabaseSync) => void;
}

/** 演进列是否已存在（PRAGMA table_info） */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function hasIndex(db: DatabaseSync, index: string): boolean {
  const row = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(index) as { found: number } | undefined;
  return Boolean(row);
}

function hasTable(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { found: number } | undefined;
  return Boolean(row);
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "messages.from_name 消息发送者名字快照",
    detect: (db) => hasColumn(db, "messages", "from_name"),
    up: (db) => {
      db.exec("ALTER TABLE messages ADD COLUMN from_name TEXT");
    },
  },
  {
    version: 2,
    name: "messages.channel 消息频道",
    detect: (db) => hasColumn(db, "messages", "channel"),
    up: (db) => {
      db.exec("ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'hall'");
    },
  },
  {
    version: 3,
    name: "messages.images 消息附图",
    detect: (db) => hasColumn(db, "messages", "images"),
    up: (db) => {
      db.exec("ALTER TABLE messages ADD COLUMN images TEXT NOT NULL DEFAULT '[]'");
    },
  },
  {
    version: 4,
    name: "agents.group_id 单组 → group_members 多对多",
    detect: (db) => {
      if (!hasColumn(db, "agents", "group_id")) return true;
      const row = db
        .prepare("SELECT COUNT(*) AS cnt FROM agents WHERE group_id IS NOT NULL")
        .get() as { cnt: number };
      return row.cnt === 0;
    },
    up: (db) => {
      db.exec(
        `INSERT OR IGNORE INTO group_members(group_id, agent_id)
         SELECT group_id, id FROM agents WHERE group_id IS NOT NULL`,
      );
      db.exec("UPDATE agents SET group_id = NULL WHERE group_id IS NOT NULL");
    },
  },
  {
    version: 5,
    name: "briefs.role_id 简报职位标",
    detect: (db) => hasColumn(db, "briefs", "role_id"),
    up: (db) => {
      db.exec("ALTER TABLE briefs ADD COLUMN role_id TEXT");
    },
  },
  {
    version: 6,
    name: "kb_docs.role_id 职位共享知识",
    detect: (db) => hasColumn(db, "kb_docs", "role_id") && hasIndex(db, "idx_kb_role"),
    up: (db) => {
      if (!hasColumn(db, "kb_docs", "role_id")) {
        db.exec("ALTER TABLE kb_docs ADD COLUMN role_id TEXT");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_kb_role ON kb_docs(role_id, updated_at DESC)");
    },
  },
  {
    version: 7,
    name: "task_handoffs 自动唤醒交接",
    detect: (db) =>
      hasTable(db, "task_handoffs") &&
      hasIndex(db, "idx_task_handoffs_status") &&
      hasIndex(db, "idx_task_handoffs_task"),
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS task_handoffs(
        id TEXT PRIMARY KEY,
        task_id TEXT,
        from_agent_id TEXT NOT NULL,
        from_agent_name TEXT NOT NULL,
        to_agent_id TEXT NOT NULL,
        to_agent_name TEXT NOT NULL,
        requested_agent_id TEXT,
        role_id TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        summary TEXT NOT NULL,
        artifacts TEXT NOT NULL DEFAULT '[]',
        decisions TEXT NOT NULL DEFAULT '[]',
        blockers TEXT NOT NULL DEFAULT '[]',
        next_steps TEXT NOT NULL DEFAULT '[]',
        acceptance_criteria TEXT NOT NULL DEFAULT '[]',
        idempotency_key TEXT NOT NULL UNIQUE,
        message_id TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );`);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_task_handoffs_status ON task_handoffs(status, updated_at)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_task_handoffs_task ON task_handoffs(task_id, created_at DESC)",
      );
    },
  },
];

function recordApplied(db: DatabaseSync, migration: Migration): void {
  db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(
    migration.version,
    migration.name,
    now(),
  );
}

/**
 * 版本化数据库迁移：把老库"捕获 ALTER 异常判断列存在"的隐式迁移
 * 换成显式的版本表——缺哪个迁移跑哪个，老库已具备的结构只打标不重复执行。
 * 每个迁移在事务内执行，失败即回滚并抛错（错误信息带版本与名称，可诊断）。
 * 依赖基础表已存在（store 构造函数先 exec SCHEMA 再调用本函数）。
 * 返回本次实际应用（含打标）的迁移数；重复调用对已应用版本是空操作。
 */
export function applyMigrations(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );`);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );
  let count = 0;
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    // 老库已具备该结构：只打标，避免重复 ALTER 报错
    if (migration.detect(db)) {
      recordApplied(db, migration);
      count += 1;
      continue;
    }
    db.exec("BEGIN");
    try {
      migration.up(db);
      recordApplied(db, migration);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `数据库迁移 v${migration.version}（${migration.name}）失败：${(error as Error).message}`,
      );
    }
    count += 1;
  }
  return count;
}
