import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OfficeConfig } from "../config.js";
import { generateAvatar } from "../domain/avatar.js";
import type { OfficeService } from "../domain/office.js";
import {
  handleClaudeHook,
  handleCodexNotify,
  handleCursorHook,
} from "../integrations/ingest.js";
import { createMcpServer } from "../mcp/tools.js";
import { cliExists } from "../util.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export async function createServer(
  office: OfficeService,
  config: OfficeConfig,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

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
    messages: office.store.listMessages(80),
    tasks: office.store.listTasks(),
    briefs: office.store.listBriefs(40),
    events: office.store.listEvents(80),
  }));

  app.post("/api/messages", async (request, reply) => {
    const body = (request.body ?? {}) as { text?: string; from?: string };
    if (!body.text?.trim()) return reply.code(400).send({ error: "text 不能为空" });
    const result = office.sendMessage({
      fromName: body.from?.trim() || office.bossName(),
      text: body.text.trim(),
    });
    return result;
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
    const body = (request.body ?? {}) as { name?: string; model?: string; title?: string };
    const agent = office.renameAgent(id, body);
    if (!agent) return reply.code(409).send({ error: "改名失败：Agent 不存在或工号已被占用" });
    return agent;
  });

  app.delete("/api/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = office.deleteAgent(id);
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

  app.get("/api/terminals", async () => {
    const agents = office.store
      .listAgents()
      .filter((a) => a.kind.endsWith("-managed"));
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

  // ---------- 网页静态资源 ----------
  const webDist = join(HERE, "../../../web/dist");
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
