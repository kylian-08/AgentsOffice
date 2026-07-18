import type {
  AgentCard,
  KbDoc,
  LogEntry,
  OfficeBrief,
  OfficeEvent,
  OfficeMessage,
  OfficeTask,
} from "@agent-office/protocol";

export interface OfficeState {
  agents: AgentCard[];
  messages: OfficeMessage[];
  tasks: OfficeTask[];
  briefs: OfficeBrief[];
  events: OfficeEvent[];
}

export interface TermLine {
  at: number;
  kind: "cmd" | "out" | "info" | "error" | "final";
  text: string;
}

export interface TerminalPane {
  id: string;
  name: string;
  kind: string;
  status: string;
  lines: TermLine[];
}

export interface Health {
  ok: boolean;
  port: number;
  dataDir: string;
  codexCli: boolean;
  claudeCli: boolean;
  cursorKey: boolean;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  state: () => fetch("/api/state").then((r) => json<OfficeState>(r)),
  health: () => fetch("/api/health").then((r) => json<Health>(r)),
  sendMessage: (text: string) =>
    fetch("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).then((r) => json<{ routed: Array<{ name: string; mode: string }> }>(r)),
  createTask: (title: string, description: string, assignee: string | null) =>
    fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, description, assignee }),
    }).then((r) => json<OfficeTask>(r)),
  updateTask: (id: string, patch: { status?: string; assignee?: string | null }) =>
    fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<OfficeTask>(r)),
  createManagedAgent: (input: {
    name: string;
    kind: "codex" | "cursor" | "claude";
    workspace: string;
    sandbox: "read-only" | "workspace-write";
    model?: string;
  }) =>
    fetch("/api/agents/managed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<AgentCard>(r)),
  updateAgent: (id: string, patch: { name?: string; model?: string; title?: string }) =>
    fetch(`/api/agents/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<AgentCard>(r)),
  deleteAgent: (id: string) =>
    fetch(`/api/agents/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),
  stopAgent: (id: string) =>
    fetch(`/api/agents/${id}/stop`, { method: "POST" }).then((r) => json<{ ok: boolean }>(r)),
  generateAvatar: (id: string, style?: string) =>
    fetch(`/api/agents/${id}/avatar`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ style }),
    }).then((r) => json<{ ok: boolean; source: "codex" | "identicon" }>(r)),
  terminals: () =>
    fetch("/api/terminals").then((r) => json<{ agents: TerminalPane[] }>(r)),
  dispatch: (input: { title: string; description?: string; agents?: string[] }) =>
    fetch("/api/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) =>
      json<{ assignedTo: string[]; reason: string; task: OfficeTask }>(r),
    ),
  logs: (opts: { limit?: number; since?: number; source?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.since) params.set("since", String(opts.since));
    if (opts.source) params.set("source", opts.source);
    return fetch(`/api/logs?${params}`).then((r) => json<{ logs: LogEntry[] }>(r));
  },
  kbCatalog: () =>
    fetch("/api/kb/catalog").then((r) =>
      json<{
        catalog: Array<{
          category: string;
          docs: Array<{ id: string; title: string; tags: string[]; updatedAt: number }>;
        }>;
      }>(r),
    ),
  kbSearch: (q: string) =>
    fetch(`/api/kb/docs?q=${encodeURIComponent(q)}`).then((r) => json<{ docs: KbDoc[] }>(r)),
  kbDoc: (id: string) => fetch(`/api/kb/docs/${id}`).then((r) => json<KbDoc>(r)),
  kbCreate: (input: { category: string; title: string; content: string; tags?: string[] }) =>
    fetch("/api/kb/docs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<KbDoc>(r)),
  kbUpdate: (
    id: string,
    patch: { category?: string; title?: string; content?: string; tags?: string[] },
  ) =>
    fetch(`/api/kb/docs/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<KbDoc>(r)),
  kbDelete: (id: string) =>
    fetch(`/api/kb/docs/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),
};
