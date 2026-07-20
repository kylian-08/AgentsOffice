import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { uuid } from "../util.js";
import type { OfficeConfig } from "../config.js";
import { generateAvatar } from "../domain/avatar.js";
import type { OfficeService } from "../domain/office.js";
import {
  handleClaudeHook,
  handleCodexNotify,
  handleCursorHook,
} from "../integrations/ingest.js";
import { createMcpServer } from "../mcp/tools.js";
import { ShellTerminalManager } from "../domain/shellterm.js";
import { cliExists } from "../util.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export async function createServer(
  office: OfficeService,
  config: OfficeConfig,
): Promise<FastifyInstance> {
  // bodyLimit 放宽以支持 base64 图片上传（约 20MB 原图）
  const app = Fastify({ logger: false, bodyLimit: 30 * 1024 * 1024 });
  await app.register(fastifyWebsocket);

  // 上传目录：附图落盘在数据目录下，经 /files/ 对外提供
  const uploadsDir = join(config.dataDir, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  office.uploadsDir = uploadsDir;

  // ---------- MCP（无状态 Streamable HTTP） ----------
  app.post("/mcp", async (request, reply) => {
    const server = createMcpServer(office);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  const methodNotAllowed = (_req: unknown, reply: any) =>
    reply.code(405).send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed（无状态模式）" },
      id: null,
    });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // ---------- Hooks / notify 摄入 ----------
  app.post("/ingest/cursor-hook", async (request) => {
    return handleCursorHook(office, (request.body ?? {}) as Record<string, any>);
  });
  app.post("/ingest/codex-notify", async (request) => {
    return handleCodexNotify(office, (request.body ?? {}) as Record<string, any>);
  });
  app.post("/ingest/claude-hook", async (request) => {
    return handleClaudeHook(office, (request.body ?? {}) as Record<string, any>);
  });

  // ---------- REST API ----------
  app.get("/api/health", async () => ({
    ok: true,
    port: config.port,
    dataDir: config.dataDir,
    codexCli: await cliExists("codex"),
    claudeCli: await cliExists("claude"),
    cursorKey: Boolean(process.env.CURSOR_API_KEY),
  }));

  app.get("/api/state", async () => ({
    agents: office.store.listAgents(),
    groups: office.store.listGroups(),
    roles: office.store.listRoles(),
    messages: office.store.listMessages(200),
    tasks: office.store.listTasks(),
    briefs: office.store.listBriefs(40),
    events: office.store.listEvents(80),
  }));

  app.post("/api/messages", async (request, reply) => {
    const body = (request.body ?? {}) as {
      text?: string;
      from?: string;
      channel?: string;
      images?: string[];
    };
    const images = Array.isArray(body.images)
      ? body.images.filter((u) => typeof u === "string" && u.startsWith("/files/"))
      : [];
    if (!body.text?.trim() && images.length === 0) {
      return reply.code(400).send({ error: "text 不能为空" });
    }
    const result = office.sendMessage({
      fromName: body.from?.trim() || office.bossName(),
      text: body.text?.trim() || "（图片）",
      channel: body.channel,
      images,
    });
    return result;
  });

  // ---------- 附图上传（JSON base64，落盘到数据目录 uploads/） ----------
  const IMAGE_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  app.post("/api/uploads", async (request, reply) => {
    const body = (request.body ?? {}) as { mime?: string; data?: string };
    const ext = body.mime ? IMAGE_EXT[body.mime] : undefined;
    if (!ext) return reply.code(400).send({ error: "只支持 png / jpeg / gif / webp 图片" });
    if (typeof body.data !== "string" || body.data.length === 0) {
      return reply.code(400).send({ error: "data（base64）不能为空" });
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(body.data, "base64");
    } catch {
      return reply.code(400).send({ error: "base64 解码失败" });
    }
    if (buffer.length === 0) return reply.code(400).send({ error: "图片内容为空" });
    if (buffer.length > 20 * 1024 * 1024) {
      return reply.code(400).send({ error: "图片超过 20MB 上限" });
    }
    const name = `${uuid()}.${ext}`;
    writeFileSync(join(uploadsDir, name), buffer);
    return { ok: true, url: `/files/${name}` };
  });

  // ---------- 应用内 Windows 终端（ConPTY 伪终端 + WebSocket 双向流） ----------
  const shellTerms = new ShellTerminalManager();
  app.addHook("onClose", async () => shellTerms.shutdown());

  app.get("/api/shellterms", async () => ({ terminals: shellTerms.list() }));

  app.post("/api/shellterms", async (request, reply) => {
    const body = (request.body ?? {}) as {
      shell?: string;
      cwd?: string;
      cols?: number;
      rows?: number;
      title?: string;
    };
    if (body.cwd && !existsSync(body.cwd.trim())) {
      return reply.code(400).send({ error: `启动目录不存在：${body.cwd.trim()}` });
    }
    const result = await shellTerms.create(body);
    if (!result.ok) return reply.code(500).send({ error: result.error });
    return result.info;
  });

  app.delete("/api/shellterms/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!shellTerms.close(id)) return reply.code(404).send({ error: "终端不存在" });
    return { ok: true };
  });

  app.post("/api/shellterms/:id/resize", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { cols?: number; rows?: number };
    if (!shellTerms.resize(id, Number(body.cols), Number(body.rows))) {
      return reply.code(400).send({ error: "resize 失败" });
    }
    return { ok: true };
  });

  app.get("/api/shellterms/:id/ws", { websocket: true }, (socket, request) => {
    const { id } = request.params as { id: string };
    const detach = shellTerms.attach(
      id,
      (chunk) => socket.send(JSON.stringify({ type: "out", data: chunk })),
      (code) => {
        socket.send(JSON.stringify({ type: "exit", code }));
        socket.close();
      },
    );
    if (!detach) {
      socket.send(JSON.stringify({ type: "error", message: "终端不存在" }));
      socket.close();
      return;
    }
    socket.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          data?: string;
          cols?: number;
          rows?: number;
        };
        if (msg.type === "in" && typeof msg.data === "string") {
          shellTerms.write(id, msg.data);
        } else if (msg.type === "resize") {
          shellTerms.resize(id, Number(msg.cols), Number(msg.rows));
        }
      } catch {
        /* 忽略坏帧 */
      }
    });
    socket.on("close", () => detach());
  });

  // ---------- 目录浏览（本机文件夹选择器用；仅列目录不列文件） ----------
  app.get("/api/fs/dirs", async (request, reply) => {
    const q = (request.query ?? {}) as { path?: string };
    if (!q.path?.trim()) {
      // 根级：Windows 列所有盘符，其他平台给根目录
      const roots: Array<{ name: string; path: string }> = [];
      if (process.platform === "win32") {
        for (let i = 65; i <= 90; i++) {
          const root = `${String.fromCharCode(i)}:\\`;
          if (existsSync(root)) roots.push({ name: root, path: root });
        }
      } else {
        roots.push({ name: "/", path: "/" });
      }
      return { path: null, parent: null, dirs: roots, home: homedir() };
    }
    const target = resolve(q.path.trim());
    if (!existsSync(target)) {
      return reply.code(400).send({ error: `目录不存在：${target}` });
    }
    let dirs: Array<{ name: string; path: string }>;
    try {
      dirs = readdirSync(target, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, path: join(target, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    } catch (error) {
      return reply
        .code(400)
        .send({ error: `无法读取目录：${error instanceof Error ? error.message : String(error)}` });
    }
    const parent = dirname(target);
    return {
      path: target,
      parent: parent === target ? null : parent,
      dirs,
      home: homedir(),
    };
  });

  // ---------- 职位（岗位上下文交接） ----------
  app.get("/api/roles", async () => ({ roles: office.store.listRoles() }));

  app.post("/api/roles", async (request, reply) => {
    const body = (request.body ?? {}) as { name?: string; description?: string };
    if (!body.name?.trim()) return reply.code(400).send({ error: "name 不能为空" });
    const result = office.createRole(body.name, body.description);
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return result.role;
  });

  app.delete("/api/roles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = office.deleteRole(id);
    if (!result.ok) return reply.code(404).send({ error: result.error });
    return { ok: true };
  });

  app.get("/api/roles/:id/dossier", async (request, reply) => {
    const { id } = request.params as { id: string };
    const dossier = office.roleDossier(id);
    if (!dossier) return reply.code(404).send({ error: "职位不存在" });
    return dossier;
  });

  app.post("/api/roles/:id/notes", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { title?: string; content?: string; author?: string };
    if (!body.title?.trim() || !body.content?.trim()) {
      return reply.code(400).send({ error: "title 与 content 不能为空" });
    }
    const result = office.writeRoleNote({
      roleId: id,
      title: body.title,
      content: body.content,
      author: body.author ?? office.bossName(),
    });
    if (!result.ok) return reply.code(404).send({ error: result.error });
    return { ok: true, noteId: result.noteId };
  });

  app.delete("/api/roles/:roleId/notes/:noteId", async (request, reply) => {
    const { noteId } = request.params as { roleId: string; noteId: string };
    if (!office.store.deleteRoleNote(noteId)) {
      return reply.code(404).send({ error: "笔记不存在" });
    }
    return { ok: true };
  });

  // ---------- 清空频道消息 ----------
  app.delete("/api/channels/:channel/messages", async (request, reply) => {
    const { channel } = request.params as { channel: string };
    const result = office.clearChannel(channel);
    if (!result.ok) return reply.code(404).send({ error: result.error });
    return { ok: true, cleared: result.cleared };
  });

  // ---------- 项目组 ----------
  app.get("/api/groups", async () => ({ groups: office.store.listGroups() }));

  app.post("/api/groups", async (request, reply) => {
    const body = (request.body ?? {}) as { name?: string };
    if (!body.name?.trim()) return reply.code(400).send({ error: "name 不能为空" });
    const result = office.createGroup(body.name);
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return result.group;
  });

  app.delete("/api/groups/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = office.deleteGroup(id);
    if (!result.ok) return reply.code(404).send({ error: result.error });
    return { ok: true };
  });

  app.post("/api/tasks", async (request, reply) => {
    const body = (request.body ?? {}) as {
      title?: string;
      description?: string;
      assignee?: string;
    };
    if (!body.title?.trim()) return reply.code(400).send({ error: "title 不能为空" });
    return office.createTask({
      title: body.title.trim(),
      description: body.description ?? null,
      createdBy: office.bossName(),
      assigneeName: body.assignee ?? null,
    });
  });

  app.patch("/api/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { status?: any; assignee?: string | null };
    const task = office.updateTask({
      taskId: id,
      status: body.status,
      assigneeName: body.assignee,
      byAgentName: office.bossName(),
    });
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    return task;
  });

  app.post("/api/agents/managed", async (request, reply) => {
    const body = (request.body ?? {}) as {
      name?: string;
      kind?: "codex" | "cursor" | "claude";
      workspace?: string;
      sandbox?: "read-only" | "workspace-write";
      model?: string;
    };
    if (!body.name?.trim()) return reply.code(400).send({ error: "name 不能为空" });
    if (/^\d+$/.test(body.name.trim())) {
      return reply.code(400).send({ error: "工号不能是纯数字（容易误 @），请带上业务前缀，如 codex-画布" });
    }
    const kindMap = {
      codex: "codex-managed",
      cursor: "cursor-managed",
      claude: "claude-managed",
    } as const;
    const kind = body.kind ? kindMap[body.kind] : undefined;
    if (!kind) return reply.code(400).send({ error: "kind 必须是 codex、cursor 或 claude" });
    if (office.store.getAgentByName(body.name.trim())) {
      return reply.code(409).send({ error: "该工号已存在" });
    }
    const agent = office.store.registerAgent({
      name: body.name.trim(),
      kind,
      workspace: body.workspace?.trim() || null,
      meta: {
        ...(kind !== "cursor-managed" ? { sandbox: body.sandbox ?? "read-only" } : {}),
        ...(body.model?.trim() ? { model: body.model.trim() } : {}),
      },
      status: "online",
    });
    office.event({ type: "join", agentId: agent.id, text: "托管工位创建" });
    return agent;
  });

  app.patch("/api/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      name?: string;
      model?: string;
      title?: string;
      /** 组归属整体覆盖；空数组 = 退出所有组 */
      groupIds?: string[];
      /** 任职职位 ID；null = 卸任 */
      roleId?: string | null;
    };
    const agent = office.renameAgent(id, body);
    if (!agent) return reply.code(409).send({ error: "改名失败：Agent 不存在或工号已被占用" });
    if (body.groupIds !== undefined) {
      if (!Array.isArray(body.groupIds) || body.groupIds.some((g) => typeof g !== "string")) {
        return reply.code(400).send({ error: "groupIds 必须是字符串数组" });
      }
      const result = office.assignGroups(id, body.groupIds);
      if (!result.ok) return reply.code(400).send({ error: result.error });
    }
    if (body.roleId !== undefined) {
      const result = office.assignRole(id, body.roleId);
      if (!result.ok) return reply.code(400).send({ error: result.error });
    }
    return office.store.listAgents().find((a) => a.id === id) ?? agent;
  });

  app.delete("/api/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = office.deleteAgent(id);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return { ok: true };
  });

  app.post("/api/agents/:id/promote", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = office.promoteAgent(id);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return { ok: true, agent: result.agent };
  });

  // 终端直连输入：原样透传到底层会话（不套办公室提示词）
  app.post("/api/agents/:id/input", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { text?: string; images?: string[] };
    if (typeof body.text !== "string" || !body.text.trim()) {
      return reply.code(400).send({ error: "text 不能为空" });
    }
    const images = Array.isArray(body.images)
      ? body.images.filter((u) => typeof u === "string" && u.startsWith("/files/"))
      : undefined;
    const result = office.directInput(id, body.text, images);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return { ok: true };
  });

  app.post("/api/agents/:id/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = office.store.getAgentById(id);
    if (!agent) return reply.code(404).send({ error: "成员不存在" });
    const stopped = office.stopRun(id);
    if (!stopped) return reply.code(409).send({ error: "该成员当前没有可终止的执行" });
    return { ok: true };
  });

  app.post("/api/agents/:id/avatar", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = office.store.getAgentById(id);
    if (!agent) return reply.code(404).send({ error: "成员不存在" });
    const body = (request.body ?? {}) as { style?: string };
    const { svg, source } = await generateAvatar(agent, body.style?.trim() || undefined);
    office.store.updateAgentMeta(id, { avatarSvg: svg });
    office.event({
      type: "rename",
      agentId: id,
      text: source === "codex" ? "codex 为其生成了新头像" : "生成了本地几何头像",
    });
    office.bus.publish({ type: "agent", payload: { agentId: id } });
    return { ok: true, source, agent: office.store.getAgentById(id) };
  });

  app.get("/api/agents/:id/history", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = office.store.getAgentById(id);
    if (!agent) return reply.code(404).send({ error: "成员不存在" });
    const query = request.query as { limit?: string; since?: string };
    return {
      agent: { id: agent.id, name: agent.name, kind: agent.kind, status: agent.status },
      lines: office.store.listHistory(id, {
        limit: query.limit ? Number(query.limit) : 500,
        since: query.since ? Number(query.since) : undefined,
      }),
    };
  });

  app.get("/api/terminals", async () => {
    // 托管工位 + 带续聊凭证的手工会话（后者可通过直连输入激活）
    const agents = office.store.listAgents().filter((a) => {
      if (a.kind.endsWith("-managed")) return true;
      const meta = a.meta as { threadId?: string; sessionId?: string };
      if (a.kind === "codex-cli" && meta.threadId) return true;
      if (a.kind === "claude-cli" && meta.sessionId) return true;
      return false;
    });
    return {
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        status: a.status,
        lines: office.terminals.get(a.id),
      })),
    };
  });

  // ---------- 日志（对网页与所有 Agent 开放） ----------
  app.get("/api/logs", async (request) => {
    const query = request.query as { limit?: string; since?: string; source?: string };
    return {
      logs: office.logs.list({
        limit: query.limit ? Number(query.limit) : 200,
        since: query.since ? Number(query.since) : undefined,
        source: query.source || undefined,
      }),
    };
  });

  // ---------- 公共知识库 ----------
  app.get("/api/kb/catalog", async () => ({ catalog: office.store.kbCatalog() }));

  app.get("/api/kb/docs", async (request) => {
    const query = request.query as { category?: string; q?: string };
    if (query.q?.trim()) return { docs: office.store.searchKbDocs(query.q.trim()) };
    return { docs: office.store.listKbDocs(query.category?.trim() || undefined) };
  });

  app.get("/api/kb/docs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const doc = office.store.getKbDoc(id);
    if (!doc) return reply.code(404).send({ error: "文档不存在" });
    return doc;
  });

  app.post("/api/kb/docs", async (request, reply) => {
    const body = (request.body ?? {}) as {
      category?: string;
      title?: string;
      content?: string;
      tags?: string[];
      author?: string;
    };
    if (!body.category?.trim() || !body.title?.trim() || !body.content?.trim()) {
      return reply.code(400).send({ error: "category、title、content 均不能为空" });
    }
    const result = office.kbWrite({
      category: body.category,
      title: body.title,
      content: body.content,
      tags: body.tags,
      author: body.author?.trim() || office.bossName(),
    });
    return result!.doc;
  });

  app.patch("/api/kb/docs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      category?: string;
      title?: string;
      content?: string;
      tags?: string[];
    };
    const existing = office.store.getKbDoc(id);
    if (!existing) return reply.code(404).send({ error: "文档不存在" });
    const result = office.kbWrite({
      id,
      category: body.category ?? existing.category,
      title: body.title ?? existing.title,
      content: body.content ?? existing.content,
      tags: body.tags,
      author: office.bossName(),
    });
    return result!.doc;
  });

  app.delete("/api/kb/docs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!office.kbDelete(id)) return reply.code(404).send({ error: "文档不存在" });
    return { ok: true };
  });

  app.post("/api/dispatch", async (request, reply) => {
    const body = (request.body ?? {}) as {
      title?: string;
      description?: string;
      agents?: string[];
    };
    if (!body.title?.trim()) return reply.code(400).send({ error: "title 不能为空" });
    const result = office.dispatchWork({
      title: body.title.trim(),
      description: body.description?.trim() || null,
      agentNames: body.agents?.filter((a) => a?.trim()),
      auto: !body.agents || body.agents.length === 0,
      requestedBy: office.bossName(),
    });
    if (!result) return reply.code(409).send({ error: "没有可分派的在线成员" });
    return result;
  });

  // ---------- SSE ----------
  app.get("/api/events", (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`event: hello\ndata: {}\n\n`);
    const unsubscribe = office.bus.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(`: ping\n\n`), 25_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // ---------- 附图静态服务 ----------
  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: "/files/",
    decorateReply: false,
  });

  // ---------- 网页静态资源 ----------
  // 桌面客户端打包后 hub 与 web 不在源码目录里，用环境变量指过去
  const webDist = process.env.AGENT_OFFICE_WEB_DIST ?? join(HERE, "../../../web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api") || request.url.startsWith("/mcp")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
