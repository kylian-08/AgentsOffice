import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BriefInputSchema } from "@agent-office/protocol";
import type { OfficeService } from "../domain/office.js";

const text = (payload: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
    },
  ],
});

/**
 * 每个 MCP 请求创建一个无状态 server 实例，共享同一个 OfficeService。
 * 工具以 agent 名字（工号）标识身份——工号由 sessionStart hook 或 register_agent 下发。
 */
export function createMcpServer(office: OfficeService): McpServer {
  const server = new McpServer({
    name: "agent-office",
    version: "0.1.0",
  });

  server.registerTool(
    "register_agent",
    {
      title: "登记入驻办公室",
      description:
        "在 Agent 办公室登记自己（幂等）。首次调用返回分配的工号；已有工号时会刷新在线状态并返回待读消息数。",
      inputSchema: {
        name: z.string().min(1).max(64).describe("你的工号/名字，例如 cursor-ab12cd"),
        kind: z
          .enum(["cursor-ide", "codex-cli", "claude-cli"])
          .describe(
            "你的类型：Cursor IDE 会话填 cursor-ide，Codex 终端填 codex-cli，Claude Code 填 claude-cli",
          ),
        workspace: z.string().optional().describe("你当前的工作目录"),
        model: z
          .string()
          .optional()
          .describe("你当前使用的 AI 模型名（如 gpt-5.6、claude-sonnet-5），会显示在工位卡片上"),
      },
    },
    async (args) => {
      const agent = office.store.registerAgent({
        name: args.name,
        kind: args.kind,
        workspace: args.workspace ?? null,
        meta: args.model?.trim() ? { model: args.model.trim() } : undefined,
      });
      office.event({ type: "join", agentId: agent.id, text: "登记入驻" });
      return text({
        ok: true,
        agent: { name: agent.name, kind: agent.kind, status: agent.status },
        pendingMessages: office.store.pendingCount(agent.id),
        hint: "有待读消息时请调用 read_inbox；完成工作后调用 publish_brief。",
      });
    },
  );

  server.registerTool(
    "read_inbox",
    {
      title: "读取收件箱",
      description: "读取 @你 的未读消息并标记为已读。开始新一轮工作前建议先调用。",
      inputSchema: {
        agent: z.string().describe("你的工号"),
        model: z
          .string()
          .optional()
          .describe("你当前使用的 AI 模型名，换了模型时带上以更新工位信息"),
      },
    },
    async (args) => {
      const result = office.readInbox(args.agent);
      if (!result) return text({ ok: false, error: `工号 ${args.agent} 未登记，请先 register_agent` });
      if (args.model?.trim()) {
        office.store.updateAgentMeta(result.agent.id, { model: args.model.trim() });
      }
      return text({
        ok: true,
        count: result.messages.length,
        messages: result.messages.map((m) => ({
          from: m.fromName,
          text: m.text,
          taskId: m.taskId,
          at: new Date(m.createdAt).toISOString(),
        })),
      });
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "发送消息",
      description:
        "向办公室发送消息。用 @工号 提及其他成员（@all 为全员）。托管成员会被自动唤醒执行，手工会话会在下一轮读到。可选 channel 指定项目组频道（组 ID 见 get_context 的 groups），组频道里 @all 只喊本组人。",
      inputSchema: {
        from_agent: z.string().describe("你的工号"),
        text: z.string().min(1).describe("消息内容，可包含 @工号"),
        task_id: z.string().optional().describe("关联任务 ID"),
        channel: z.string().optional().describe("频道：项目组 ID，缺省为大群"),
      },
    },
    async (args) => {
      const result = office.sendMessage({
        fromName: args.from_agent,
        text: args.text,
        taskId: args.task_id ?? null,
        channel: args.channel,
      });
      return text({
        ok: true,
        routed: result.routed,
        note: result.unmatched
          ? "有 @ 未匹配到任何成员，请用 get_context 查看花名册后重发"
          : undefined,
      });
    },
  );

  server.registerTool(
    "get_context",
    {
      title: "获取办公室上下文",
      description:
        "获取办公室全景上下文：花名册（成员/模型/职位/工作区/项目组）、项目组列表、进行中的任务、最近简报、知识库目录。开始工作前调用一次可快速了解全局。",
      inputSchema: {
        brief_limit: z.number().int().min(1).max(50).optional().describe("返回简报数量，默认 10"),
      },
    },
    async (args) => text(office.getContext(args.brief_limit ?? 10)),
  );

  server.registerTool(
    "read_logs",
    {
      title: "读取办公室日志",
      description:
        "读取办公室统一日志流（消息、事件、简报、托管终端输出）。可按来源过滤、按时间增量拉取，用于了解办公室里正在发生什么。",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe("返回条数，默认 100"),
        since: z
          .number()
          .int()
          .optional()
          .describe("只取该毫秒时间戳之后的日志（增量拉取）"),
        source: z
          .enum(["event", "message", "brief", "terminal", "kb"])
          .optional()
          .describe("按来源过滤"),
      },
    },
    async (args) =>
      text({
        ok: true,
        logs: office.logs.list({
          limit: args.limit ?? 100,
          since: args.since,
          source: args.source,
        }),
      }),
  );

  server.registerTool(
    "kb_list",
    {
      title: "知识库目录",
      description:
        "列出公共知识库的目录索引（分类 → 文档标题/标签），或某一分类下的文档摘要。遇到疑难问题先来这里找现成解法。",
      inputSchema: {
        category: z.string().optional().describe("只看某个分类，可选"),
      },
    },
    async (args) => {
      if (args.category?.trim()) {
        const docs = office.store.listKbDocs(args.category.trim());
        return text({
          ok: true,
          category: args.category.trim(),
          docs: docs.map((d) => ({
            id: d.id,
            title: d.title,
            tags: d.tags,
            excerpt: d.content.slice(0, 120),
            updatedAt: new Date(d.updatedAt).toISOString(),
          })),
        });
      }
      return text({ ok: true, catalog: office.store.kbCatalog() });
    },
  );

  server.registerTool(
    "kb_read",
    {
      title: "读取知识库文档",
      description: "按 ID 读取一篇知识库文档的完整内容（疑难杂症与解决方案）。",
      inputSchema: {
        id: z.string().describe("文档 ID（可用 kb_list / kb_search 找到）"),
      },
    },
    async (args) => {
      const doc = office.store.getKbDoc(args.id);
      if (!doc) return text({ ok: false, error: "文档不存在" });
      return text({ ok: true, doc });
    },
  );

  server.registerTool(
    "kb_search",
    {
      title: "搜索知识库",
      description: "按关键词搜索知识库（标题/正文/标签/分类），返回匹配的文档。",
      inputSchema: {
        query: z.string().min(1).describe("关键词"),
        limit: z.number().int().min(1).max(50).optional().describe("返回条数，默认 10"),
      },
    },
    async (args) => {
      const docs = office.store.searchKbDocs(args.query, args.limit ?? 10);
      return text({
        ok: true,
        count: docs.length,
        docs: docs.map((d) => ({
          id: d.id,
          category: d.category,
          title: d.title,
          tags: d.tags,
          excerpt: d.content.slice(0, 200),
        })),
      });
    },
  );

  server.registerTool(
    "kb_write",
    {
      title: "写入知识库",
      description:
        "把遇到的疑难杂症及解决方案沉淀到公共知识库。带 id 为更新既有文档，不带 id 为新增。建议格式：问题现象 / 根因 / 解决步骤 / 验证方式。",
      inputSchema: {
        agent: z.string().describe("你的工号（作为文档作者）"),
        id: z.string().optional().describe("要更新的文档 ID，新增时不填"),
        category: z
          .string()
          .min(1)
          .max(60)
          .describe("目录分类，如「构建打包」「网络代理」「Windows 环境」"),
        title: z.string().min(1).max(200).describe("文档标题，一句话概括问题"),
        content: z.string().min(1).describe("正文：问题现象、根因、解决步骤、验证方式"),
        tags: z.array(z.string()).optional().describe("标签，便于检索"),
      },
    },
    async (args) => {
      const result = office.kbWrite({
        id: args.id,
        category: args.category,
        title: args.title,
        content: args.content,
        tags: args.tags,
        author: args.agent,
      });
      if (!result) return text({ ok: false, error: "要更新的文档不存在" });
      return text({ ok: true, created: result.created, id: result.doc.id });
    },
  );

  server.registerTool(
    "create_task",
    {
      title: "创建任务",
      description: "创建一个新任务，可指定负责成员（assignee 填工号），用于拆解和分派工作。",
      inputSchema: {
        agent: z.string().describe("你的工号"),
        title: z.string().min(1).max(200).describe("任务标题"),
        description: z.string().optional().describe("任务说明"),
        assignee: z.string().optional().describe("负责成员的工号，可选"),
      },
    },
    async (args) => {
      const task = office.createTask({
        title: args.title,
        description: args.description ?? null,
        createdBy: args.agent,
        assigneeName: args.assignee ?? null,
      });
      return text({ ok: true, task });
    },
  );

  server.registerTool(
    "claim_task",
    {
      title: "认领任务",
      description: "认领一个开放任务，避免与其他成员重复工作。",
      inputSchema: {
        agent: z.string().describe("你的工号"),
        task_id: z.string().describe("任务 ID"),
      },
    },
    async (args) => {
      const result = office.claimTask(args.agent, args.task_id);
      if (!result) return text({ ok: false, error: "任务或工号不存在" });
      if (result.conflict) {
        return text({ ok: false, error: "任务已被认领", task: result.task });
      }
      return text({ ok: true, task: result.task });
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "更新任务状态",
      description: "更新任务状态（in_progress / done / cancelled 等），可附一句说明。",
      inputSchema: {
        agent: z.string().describe("你的工号"),
        task_id: z.string().describe("任务 ID"),
        status: z.enum(["open", "claimed", "in_progress", "done", "cancelled"]),
        note: z.string().optional().describe("一句话说明"),
      },
    },
    async (args) => {
      const task = office.updateTask({
        taskId: args.task_id,
        status: args.status,
        byAgentName: args.agent,
        note: args.note,
      });
      if (!task) return text({ ok: false, error: "任务不存在" });
      return text({ ok: true, task });
    },
  );

  server.registerTool(
    "publish_brief",
    {
      title: "发布工作简报",
      description:
        "把你的阶段性成果发布为结构化简报，共享给办公室全员。完成一段工作后务必调用。",
      inputSchema: {
        agent: z.string().describe("你的工号"),
        ...BriefInputSchema.shape,
      },
    },
    async (args) => {
      const { agent, ...brief } = args;
      const result = office.publishBrief({
        agentName: agent,
        kind: "manual",
        source: "mcp",
        brief,
      });
      if (!result.ok) return text({ ok: false, error: `工号 ${agent} 未登记，请先 register_agent` });
      return text({ ok: true, duplicated: result.duplicated });
    },
  );

  return server;
}
