import type { AgentCard, OfficeTask } from "@agent-office/protocol";

const ACTIVE_TASKS = new Set(["open", "claimed", "in_progress", "review", "blocked"]);
const DEFAULT_RECENT_MS = 24 * 60 * 60_000;

export interface WorkerSelection {
  visible: AgentCard[];
  archivedCount: number;
  totalCount: number;
}

export interface TerminalLike {
  id: string;
  name: string;
  status: string;
  lastSeenAt?: number | null;
  lines: unknown[];
}

export interface MessageRouteResult {
  routed: Array<{ name: string; mode: string }>;
  unmatched: boolean;
}

export interface MessageFeedback {
  text: string;
  kind: "ok" | "err";
}

export function isActiveTask(task: OfficeTask): boolean {
  return ACTIVE_TASKS.has(task.status);
}

function hasActiveTask(agent: AgentCard, tasks: OfficeTask[]): boolean {
  return tasks.some((task) => task.assigneeAgentId === agent.id && isActiveTask(task));
}

function actionRank(agent: AgentCard, tasks: OfficeTask[], now: number): number {
  if (agent.status === "archived") return 6;
  if (agent.status === "busy") return 0;
  if (agent.status === "online") return 1;
  if ((agent.pendingCount ?? 0) > 0) return 2;
  if (hasActiveTask(agent, tasks)) return 3;
  if (now - (agent.lastSeenAt ?? 0) <= DEFAULT_RECENT_MS) return 4;
  return 5;
}

export function sortWorkersForAction(
  agents: AgentCard[],
  tasks: OfficeTask[],
  now = Date.now(),
): AgentCard[] {
  return [...agents].sort((left, right) => {
    const rank = actionRank(left, tasks, now) - actionRank(right, tasks, now);
    if (rank !== 0) return rank;
    const activity = (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0);
    if (activity !== 0) return activity;
    return left.name.localeCompare(right.name, "zh-CN");
  });
}

function matchesWorker(agent: AgentCard, query: string): boolean {
  if (!query) return true;
  const meta = agent.meta as { model?: string; title?: string };
  const text = [
    agent.name,
    meta.model,
    meta.title,
    agent.workspace,
    ...(agent.groupNames ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return text.includes(query);
}

export function selectWorkers(input: {
  agents: AgentCard[];
  tasks: OfficeTask[];
  query?: string;
  showArchived?: boolean;
  now?: number;
}): WorkerSelection {
  const now = input.now ?? Date.now();
  const workers = input.agents.filter(
    (agent) => agent.kind !== "user" && agent.kind !== "supervisor",
  );
  const archived = workers.filter((agent) => actionRank(agent, input.tasks, now) >= 5);
  const query = input.query?.trim().toLowerCase() ?? "";
  const candidates = input.showArchived
    ? workers
    : workers.filter((agent) => actionRank(agent, input.tasks, now) < 5);
  return {
    visible: sortWorkersForAction(candidates, input.tasks, now).filter((agent) =>
      matchesWorker(agent, query),
    ),
    archivedCount: archived.length,
    totalCount: workers.length,
  };
}

function terminalRank(terminal: TerminalLike): number {
  if (terminal.status === "busy") return 0;
  if (terminal.status === "online") return 1;
  if (terminal.lines.length > 0) return 2;
  return 3;
}

export function sortTerminalsForAction<T extends TerminalLike>(terminals: T[]): T[] {
  return [...terminals].sort((left, right) => {
    const rank = terminalRank(left) - terminalRank(right);
    if (rank !== 0) return rank;
    const activity = (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0);
    if (activity !== 0) return activity;
    return left.name.localeCompare(right.name, "zh-CN");
  });
}

export function visibleTerminals<T extends TerminalLike>(
  terminals: T[],
  showOffline: boolean,
  query = "",
): T[] {
  const normalized = query.trim().toLowerCase();
  return sortTerminalsForAction(terminals).filter(
    (terminal) =>
      (showOffline || terminal.status !== "offline") &&
      (!normalized || terminal.name.toLowerCase().includes(normalized)),
  );
}

export function buildMessageFeedback(result: MessageRouteResult): MessageFeedback {
  if (result.unmatched) {
    return {
      text: "消息已发到频道，但 @ 未匹配到成员；请从候选列表选择有效工号。",
      kind: "err",
    };
  }
  const managed = result.routed.filter((route) => route.mode === "managed").map((route) => route.name);
  const inbox = result.routed.filter((route) => route.mode === "inbox").map((route) => route.name);
  const supervisor = result.routed.some((route) => route.mode === "supervisor");
  const parts: string[] = [];
  if (supervisor) parts.push("主管已接单并自动分派");
  if (managed.length > 0) parts.push(`已唤醒 ${managed.join("、")}`);
  if (inbox.length > 0) parts.push(`已入 ${inbox.join("、")} 的收件箱（下轮读取）`);
  return { text: parts.join("；") || "已发送", kind: "ok" };
}
