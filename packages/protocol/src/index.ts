import { z } from "zod";

/** Agent 种类：手工会话（Cursor/Codex/Claude）、托管 Agent、主管、人类用户 */
export type AgentKind =
  | "cursor-ide"
  | "codex-cli"
  | "claude-cli"
  | "cursor-managed"
  | "codex-managed"
  | "claude-managed"
  | "supervisor"
  | "user";

export type AgentStatus = "online" | "busy" | "offline";

export type TaskStatus = "open" | "claimed" | "in_progress" | "done" | "cancelled";

export interface AgentCard {
  id: string;
  name: string;
  kind: AgentKind;
  status: AgentStatus;
  workspace: string | null;
  meta: Record<string, unknown>;
  lastSeenAt: number | null;
  createdAt: number;
  pendingCount?: number;
  /** 今日已用 token（仅托管执行可统计） */
  todayTokens?: number;
  /** 已完成任务数 */
  doneTasks?: number;
  /** 所属项目组（可同时在多个组；空数组表示只在大群） */
  groupIds?: string[];
  groupNames?: string[];
}

/** 频道标识：大群固定为 "hall"，项目组频道即组 ID */
export const HALL_CHANNEL = "hall";

/** 项目组：一组员工 + 一个专属频道 */
export interface OfficeGroup {
  id: string;
  name: string;
  createdAt: number;
  memberCount?: number;
}

/**
 * 职位：绑定「岗位上下文」的第一公民。谁坐这个职位谁继承全部档案——
 * 职位笔记（账号/路径/决策等硬信息）、历任简报、发给历任在岗者的定向消息。
 */
export interface OfficeRole {
  id: string;
  name: string;
  description: string | null;
  createdAt: number;
  /** 当前在岗成员名（可多人同岗） */
  holderNames?: string[];
  noteCount?: number;
}

/** 职位档案笔记：跟职位走、不跟人走的持久信息 */
export interface RoleNote {
  id: string;
  roleId: string;
  title: string;
  content: string;
  author: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 职位交接档案（喂给接任者的打包上下文） */
export interface RoleDossier {
  role: OfficeRole;
  notes: RoleNote[];
  briefs: Array<{ agentName: string; title: string; result: string; createdAt: number }>;
  messages: Array<{ fromName: string; text: string; createdAt: number }>;
}

export interface OfficeMessage {
  id: string;
  fromAgentId: string | null;
  fromName: string;
  text: string;
  mentions: string[];
  taskId: string | null;
  createdAt: number;
  /** 所属频道：hall（大群）或项目组 ID */
  channel: string;
  /** 附图 URL（hub 的 /files/xxx，文件存在数据目录 uploads/ 下） */
  images: string[];
  deliveries: Array<{ toName: string; status: "pending" | "read" }>;
}

export interface OfficeTask {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assigneeAgentId: string | null;
  assigneeName: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OfficeBrief {
  id: string;
  agentId: string;
  agentName: string;
  taskId: string | null;
  kind: "manual" | "auto";
  source: string;
  title: string;
  result: string;
  progress: string | null;
  decisions: string | null;
  artifacts: string | null;
  blockers: string | null;
  nextSteps: string | null;
  createdAt: number;
}

export interface OfficeEvent {
  id: string;
  type: string;
  agentId: string | null;
  agentName: string | null;
  text: string | null;
  createdAt: number;
}

export const BriefInputSchema = z.object({
  title: z.string().min(1).max(200).describe("简报标题，一句话概括"),
  result: z.string().min(1).describe("结果：完成了什么/结论是什么"),
  progress: z.string().optional().describe("进展：当前进行到哪一步"),
  decisions: z.string().optional().describe("决策：做了哪些关键取舍"),
  artifacts: z.string().optional().describe("产物：改动的文件、链接、命令等"),
  blockers: z.string().optional().describe("阻塞：卡在哪里、需要谁协助"),
  next_steps: z.string().optional().describe("下一步：接下来的计划"),
  task_id: z.string().optional().describe("关联的任务 ID，可选"),
});
export type BriefInput = z.infer<typeof BriefInputSchema>;

export const AGENT_KIND_LABELS: Record<AgentKind, string> = {
  "cursor-ide": "Cursor 会话",
  "codex-cli": "Codex 会话",
  "claude-cli": "Claude 会话",
  "cursor-managed": "Cursor 托管",
  "codex-managed": "Codex 托管",
  "claude-managed": "Claude 托管",
  supervisor: "办公室主管",
  user: "人类成员",
};

/** Agent meta 中约定的公共字段 */
export interface AgentMeta {
  /** 模型标识（来自 hooks 自动采集或人工备注） */
  model?: string;
  /** 当前正在做的事（实时工作台展示） */
  lastActivity?: string;
  lastActivityAt?: number;
  /** 职位显示名（选定职位后同步为职位名；老数据的自由文本保留展示） */
  title?: string;
  /** 所任职位 ID（职位档案交接的锚点） */
  roleId?: string;
  /** 头像 SVG（codex 生成或本地几何头像） */
  avatarSvg?: string;
  threadId?: string;
  sessionId?: string;
  cursorAgentId?: string;
  sandbox?: string;
}

/** 公共知识库文档：沉淀疑难杂症与解决方案，按目录（category）索引 */
export interface KbDoc {
  id: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  author: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 统一日志条目（内存环形缓冲，经 SSE 流式推送） */
export interface LogEntry {
  at: number;
  level: "info" | "warn" | "error";
  /** 来源：event / message / brief / terminal / run / kb / hub */
  source: string;
  agentName: string | null;
  text: string;
}

export const SUPERVISOR_NAME = "主管";

const ALL_ALIASES = new Set(["all", "所有人", "全员", "everyone"]);

/**
 * 从消息文本解析 @提及。
 * 名字可能与中文正文连写（如 "@小明请看"），因此对每个候选 token
 * 逐字符从尾部收缩，直到命中花名册。
 */
export function parseMentions(
  text: string,
  roster: string[],
): { targets: string[]; all: boolean } {
  const byLower = new Map(roster.map((n) => [n.toLowerCase(), n]));
  const found = new Set<string>();
  let all = false;
  const re = /@([\p{L}\p{N}_./-]+)/gu;
  for (const match of text.matchAll(re)) {
    let token = match[1];
    while (token.length > 0) {
      const lower = token.toLowerCase();
      if (ALL_ALIASES.has(lower)) {
        all = true;
        break;
      }
      const hit = byLower.get(lower);
      if (hit) {
        found.add(hit);
        break;
      }
      token = token.slice(0, -1);
    }
  }
  return { targets: [...found], all };
}

/** 托管 Agent 收到 @消息时使用的提示词模板 */
export function buildManagedPrompt(opts: {
  agentName: string;
  senderName: string;
  text: string;
  contextBriefs?: Array<{ agentName: string; title: string; result: string }>;
  /** 附图的本地文件绝对路径（提示 Agent 用图片查看工具打开） */
  imagePaths?: string[];
  /** 职位交接档案：在岗者自动继承的岗位上下文 */
  roleDossier?: RoleDossier;
}): string {
  const lines = [
    `[Agent Office] 你是协作办公室的成员「${opts.agentName}」。`,
  ];
  if (opts.roleDossier) {
    const d = opts.roleDossier;
    lines.push(
      `你现任职位「${d.role.name}」${d.role.description ? `（${d.role.description}）` : ""}。以下是职位档案——这个岗位积累的全部有效上下文（可能出自前任，直接当作你自己的记忆使用）：`,
    );
    for (const n of d.notes.slice(0, 8)) {
      lines.push(`- [笔记] ${n.title}：${n.content.slice(0, 400)}`);
    }
    for (const b of d.briefs.slice(0, 3)) {
      lines.push(`- [历任简报] ${b.agentName}：${b.title} — ${b.result.slice(0, 200)}`);
    }
    for (const m of d.messages.slice(-6)) {
      lines.push(`- [岗位收到过的指示] ${m.fromName}：${m.text.slice(0, 200)}`);
    }
    lines.push(
      "完整档案可用 MCP 工具 get_role_context 获取；工作中得到的岗位关键信息（账号、路径、架构结论、决策）请及时用 role_note_write 写进职位档案，方便任何接任者无缝接手。",
      "",
    );
  }
  lines.push(`来自「${opts.senderName}」的新消息：`, opts.text);
  if (opts.imagePaths && opts.imagePaths.length > 0) {
    lines.push(
      "",
      `对方附了 ${opts.imagePaths.length} 张图片（本地文件，请先用你的图片查看工具——Cursor/Claude 用 Read、Codex 用 view_image——打开看完再处理）：`,
    );
    for (const p of opts.imagePaths) lines.push(p);
  }
  if (opts.contextBriefs && opts.contextBriefs.length > 0) {
    lines.push("", "办公室最近的简报（供参考）：");
    for (const b of opts.contextBriefs) {
      lines.push(`- ${b.agentName}：${b.title} — ${b.result.slice(0, 200)}`);
    }
  }
  lines.push(
    "",
    "如果本机 MCP 里有 agent-office / agent_office 服务，你还可以：get_context 获取花名册、任务与最近简报；kb_list / kb_read 查公共知识库（疑难杂症与解决方案）；遇到值得沉淀的问题用 kb_write 记录。",
    "请完成消息中的请求。回答的最后用一段话总结你的结果，这段总结会作为简报共享给办公室全员。",
  );
  return lines.join("\n");
}
