import type {
  AgentCard,
  KbDoc,
  LogEntry,
  OfficeBrief,
  OfficeEvent,
  OfficeGroup,
  OfficeMessage,
  OfficeRole,
  OfficeTask,
  RoleDossier,
} from "@agent-office/protocol";

export interface OfficeState {
  agents: AgentCard[];
  groups: OfficeGroup[];
  roles: OfficeRole[];
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

export interface ShellTermInfo {
  id: string;
  title: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  alive: boolean;
  exitCode: number | null;
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
  sendMessage: (text: string, channel?: string, images?: string[]) =>
    fetch("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, channel, images }),
    }).then((r) => json<{ routed: Array<{ name: string; mode: string }> }>(r)),
  /** 上传图片（base64），返回 /files/xxx 的 URL */
  uploadImage: async (file: File) => {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.onerror = () => reject(new Error("读取图片失败"));
      reader.readAsDataURL(file);
    });
    return fetch("/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mime: file.type, data }),
    }).then((r) => json<{ ok: boolean; url: string }>(r));
  },
  createGroup: (name: string) =>
    fetch("/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((r) => json<OfficeGroup>(r)),
  deleteGroup: (id: string) =>
    fetch(`/api/groups/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),
  createRole: (name: string, description?: string) =>
    fetch("/api/roles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description }),
    }).then((r) => json<OfficeRole>(r)),
  deleteRole: (id: string) =>
    fetch(`/api/roles/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),
  roleDossier: (id: string) =>
    fetch(`/api/roles/${id}/dossier`).then((r) => json<RoleDossier>(r)),
  roleNoteCreate: (roleId: string, input: { title: string; content: string }) =>
    fetch(`/api/roles/${roleId}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<{ ok: boolean; noteId: string }>(r)),
  roleNoteDelete: (roleId: string, noteId: string) =>
    fetch(`/api/roles/${roleId}/notes/${noteId}`, { method: "DELETE" }).then((r) =>
      json<{ ok: boolean }>(r),
    ),
  clearChannel: (channel: string, includeEvents = false) =>
    fetch(`/api/channels/${channel}/messages${includeEvents ? "?events=1" : ""}`, {
      method: "DELETE",
    }).then((r) => json<{ ok: boolean; cleared: number; clearedEvents?: number }>(r)),
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
  updateAgent: (
    id: string,
    patch: {
      name?: string;
      model?: string;
      title?: string;
      groupIds?: string[];
      roleId?: string | null;
      spriteUrl?: string;
    },
  ) =>
    fetch(`/api/agents/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<AgentCard>(r)),
  deleteAgent: (id: string) =>
    fetch(`/api/agents/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),
  stopAgent: (id: string) =>
    fetch(`/api/agents/${id}/stop`, { method: "POST" }).then((r) => json<{ ok: boolean }>(r)),
  promoteAgent: (id: string) =>
    fetch(`/api/agents/${id}/promote`, { method: "POST" }).then((r) => json<{ ok: boolean }>(r)),
  terminalInput: (id: string, text: string, images?: string[]) =>
    fetch(`/api/agents/${id}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, images }),
    }).then((r) => json<{ ok: boolean }>(r)),
  generateAvatar: (id: string, style?: string) =>
    fetch(`/api/agents/${id}/avatar`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ style }),
    }).then((r) => json<{ ok: boolean; source: "codex" | "identicon" }>(r)),
  terminals: () =>
    fetch("/api/terminals").then((r) => json<{ agents: TerminalPane[] }>(r)),
  history: (id: string, opts: { limit?: number; since?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.since) params.set("since", String(opts.since));
    return fetch(`/api/agents/${id}/history?${params}`).then((r) =>
      json<{
        agent: { id: string; name: string; kind: string; status: string };
        lines: Array<{ at: number; kind: string; text: string }>;
      }>(r),
    );
  },
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
  shellTerms: () =>
    fetch("/api/shellterms").then((r) => json<{ terminals: ShellTermInfo[] }>(r)),
  fsDirs: (path?: string) =>
    fetch(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`).then((r) =>
      json<{
        path: string | null;
        parent: string | null;
        dirs: Array<{ name: string; path: string }>;
        home: string;
      }>(r),
    ),
  shellTermCreate: (input: {
    shell?: string;
    cwd?: string;
    title?: string;
    command?: "codex" | "claude";
  }) =>
    fetch("/api/shellterms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<ShellTermInfo>(r)),
  shellTermClose: (id: string) =>
    fetch(`/api/shellterms/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),
};

/** 打开某个内嵌终端的双向 WebSocket（同源；开发模式经 vite 代理） */
export function shellTermSocket(id: string): WebSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return new WebSocket(`${proto}://${location.host}/api/shellterms/${id}/ws`);
}
