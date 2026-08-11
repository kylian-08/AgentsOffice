import { readFileSync } from "node:fs";
import type { OfficeService } from "../domain/office.js";
import { sha1, shortId, truncate } from "../util.js";

/**
 * Cursor hooks 摄入。
 * 手工 IDE 会话由 sessionStart 自动登记为 cursor-xxxxxx，
 * afterAgentResponse 落为兜底简报，stop/sessionEnd 维护状态。
 * 返回值会原样作为 hook 脚本的 stdout（Cursor 的 hook 响应）。
 */
export function handleCursorHook(
  office: OfficeService,
  payload: Record<string, any>,
): Record<string, unknown> {
  const eventName = payload.hook_event_name as string | undefined;
  const conversationId = payload.conversation_id as string | undefined;
  if (!eventName) return {};
  if (!conversationId) return {};

  // 托管 Cursor 工位自身的运行也会触发 hooks，识别后跳过，避免登记出重复员工
  const managedTwin = office.store
    .listAgents()
    .find(
      (a) =>
        a.kind === "cursor-managed" &&
        (a.meta as { cursorAgentId?: string }).cursorAgentId === conversationId,
    );
  if (managedTwin) return {};

  const workspace: string | null = Array.isArray(payload.workspace_roots)
    ? (payload.workspace_roots[0] ?? null)
    : null;
  const externalKey = `cursor:conv:${conversationId}`;
  const name = `cursor-${shortId(conversationId)}`;

  const model =
    (typeof payload.model_id === "string" && payload.model_id) ||
    (typeof payload.model === "string" && payload.model) ||
    undefined;
  const agent = office.store.upsertAgentBySession(externalKey, {
    name,
    kind: "cursor-ide",
    workspace,
    meta: model ? { model } : undefined,
  });

  switch (eventName) {
    case "sessionStart": {
      office.event({ type: "join", agentId: agent.id, text: "Cursor 会话上线" });
      const pending = office.store.pendingCount(agent.id);
      const lines = [
        `[Agent Office] 本机运行着多 Agent 协作办公室（MCP 服务名 agent-office）。`,
        `你的工号是「${agent.name}」。协作约定：`,
        `1. 先调用 register_agent 刷新登记：name="${agent.name}"、kind="cursor-ide"、model 填你当前实际使用的 AI 模型名；注册后会自动分配职位，同岗成员共享职位上下文与知识库；`,
        `2. 开始处理任务前调用 read_inbox(agent="${agent.name}") 查看 @你的消息（中途换了模型就在 read_inbox 时带 model 参数更新）；`,
        `3. 完成阶段性工作后调用 publish_brief 发布简报；`,
        `4. 需要其他成员协助时用 send_message 并 @对方工号；`,
        `5. 阶段任务需要接力时调用 handoff_task 保存交接材料并自动唤醒接班员工，不要只在最终回复里写 @工号；`,
        `6. get_context 可随时获取办公室全景（花名册/任务/简报/知识库目录），read_logs 可看实时日志；`,
        `7. 遇到疑难问题先 kb_search / kb_list 查公共知识库，解决了值得沉淀的问题就 kb_write 记录（分类/标题/根因/解决步骤）。`,
      ];
      if (pending > 0) lines.push(`注意：你有 ${pending} 条未读消息，请先 read_inbox。`);
      return { additional_context: lines.join("\n") };
    }
    case "beforeSubmitPrompt": {
      office.store.setAgentStatus(agent.id, "busy");
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
      const excerpt = truncate(prompt.replaceAll(/\s+/g, " "), 120);
      office.setActivity(agent.id, `处理指令：${excerpt}`);
      office.event({ type: "prompt", agentId: agent.id, text: `收到新指令：${excerpt}` });
      // 会话内部的提问全文同步进办公室（对话历史 + 日志流）
      office.recordHistory(agent.id, "prompt", prompt);
      return {};
    }
    case "beforeShellExecution": {
      const command = typeof payload.command === "string" ? payload.command : "";
      if (command) {
        office.setActivity(agent.id, `执行命令：${truncate(command.replaceAll(/\s+/g, " "), 100)}`);
      }
      // 只观察不表态，避免替用户放行命令（权限仍由 Cursor 自身策略决定）
      return {};
    }
    case "afterFileEdit": {
      const filePath = typeof payload.file_path === "string" ? payload.file_path : "";
      if (filePath) {
        office.setActivity(agent.id, `编辑文件：${filePath.split(/[\\/]/).slice(-2).join("/")}`);
      }
      return {};
    }
    case "afterAgentResponse": {
      const textContent = typeof payload.text === "string" ? payload.text : "";
      if (textContent.trim()) {
        office.recordHistory(agent.id, "final", textContent);
        office.publishBrief({
          agentName: agent.name,
          kind: "auto",
          source: "cursor-hook",
          brief: {
            title: `工作回帧：${truncate(textContent.replaceAll(/\s+/g, " "), 48)}`,
            result: textContent,
          },
          idempotencyKey: `cursor:${conversationId}:${sha1(textContent)}`,
        });
      }
      office.store.setAgentStatus(agent.id, "online");
      return {};
    }
    case "stop": {
      office.store.setAgentStatus(agent.id, "online");
      office.setActivity(agent.id, null);
      const status = payload.status as string | undefined;
      office.event({
        type: "stop",
        agentId: agent.id,
        text: `一轮工作结束（${status ?? "completed"}）`,
      });
      return {};
    }
    case "sessionEnd": {
      office.store.setAgentStatus(agent.id, "offline");
      office.setActivity(agent.id, null);
      office.event({ type: "leave", agentId: agent.id, text: "Cursor 会话下线" });
      return {};
    }
    default:
      return {};
  }
}

/**
 * Claude Code hooks 摄入（事件名为大驼峰：SessionStart / UserPromptSubmit /
 * PreToolUse / Stop / SessionEnd）。会话按 session_id 登记为 claude-xxxxxx。
 * Stop 时从 transcript JSONL 中防御性提取最后一条助手消息作为兜底简报。
 */
export function handleClaudeHook(
  office: OfficeService,
  payload: Record<string, any>,
  readTranscript: (path: string) => string | null = defaultReadTranscript,
): Record<string, unknown> {
  const eventName = payload.hook_event_name as string | undefined;
  const sessionId = payload.session_id as string | undefined;
  if (!eventName || !sessionId) return {};

  // 托管 Claude 工位跑 claude -p 时也会触发这些 hooks，识别后跳过，
  // 否则注入词会引导它再 register_agent 一个 claude-xxxxxx 重复员工
  const managedTwin = office.store
    .listAgents()
    .find(
      (a) =>
        a.kind === "claude-managed" &&
        (a.meta as { sessionId?: string }).sessionId === sessionId,
    );
  if (managedTwin) return {};

  const model =
    (typeof payload.model === "string" && payload.model) || undefined;
  // 终端工位占位收养：开「Claude 工位」时已先入驻，这里把会话绑到那个工位
  const claudeKey = `claude:session:${sessionId}`;
  if (!office.store.sessionAgent(claudeKey)) {
    office.adoptTerminalAgent("claude", claudeKey, (payload.cwd as string) ?? null, {
      sessionId,
    });
  }
  const agent = office.store.upsertAgentBySession(claudeKey, {
    name: `claude-${shortId(sessionId)}`,
    kind: "claude-cli",
    workspace: (payload.cwd as string) ?? null,
    meta: { sessionId, ...(model ? { model } : {}) },
  });

  switch (eventName) {
    case "SessionStart": {
      office.event({ type: "join", agentId: agent.id, text: "Claude 会话上线" });
      const pending = office.store.pendingCount(agent.id);
      const lines = [
        `[Agent Office] 本机运行着多 Agent 协作办公室（MCP 服务名 agent-office）。`,
        `你的工号是「${agent.name}」。协作约定：`,
        `1. 先调用 register_agent 刷新登记：name="${agent.name}"、kind="claude-cli"、model 填你当前实际使用的 AI 模型名；注册后会自动分配职位，同岗成员共享职位上下文与知识库；`,
        `2. 开始处理任务前调用 read_inbox(agent="${agent.name}") 查看 @你的消息；`,
        `3. 完成阶段性工作后调用 publish_brief 发布简报；`,
        `4. 需要其他成员协助时用 send_message 并 @对方工号；`,
        `5. 阶段任务需要接力时调用 handoff_task 保存交接材料并自动唤醒接班员工，不要只在最终回复里写 @工号；`,
        `6. get_context 可获取办公室全景（花名册/任务/简报/知识库目录），read_logs 可看实时日志；`,
        `7. 遇到疑难问题先 kb_search 查公共知识库，解决后用 kb_write 沉淀方案。`,
      ];
      if (pending > 0) lines.push(`注意：你有 ${pending} 条未读消息，请先 read_inbox。`);
      return {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: lines.join("\n"),
        },
      };
    }
    case "UserPromptSubmit": {
      office.store.setAgentStatus(agent.id, "busy");
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
      const excerpt = truncate(prompt.replaceAll(/\s+/g, " "), 120);
      office.setActivity(agent.id, `处理指令：${excerpt}`);
      office.event({ type: "prompt", agentId: agent.id, text: `收到新指令：${excerpt}` });
      office.recordHistory(agent.id, "prompt", prompt);
      return {};
    }
    case "PreToolUse": {
      const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
      if (tool) office.setActivity(agent.id, `使用工具：${tool}`);
      return {};
    }
    case "Stop": {
      office.store.setAgentStatus(agent.id, "online");
      office.setActivity(agent.id, null);
      const transcriptPath = payload.transcript_path as string | undefined;
      const lastText = transcriptPath ? readTranscript(transcriptPath) : null;
      if (lastText?.trim()) {
        office.recordHistory(agent.id, "final", lastText);
        office.publishBrief({
          agentName: agent.name,
          kind: "auto",
          source: "claude-hook",
          brief: {
            title: `工作回帧：${truncate(lastText.replaceAll(/\s+/g, " "), 48)}`,
            result: lastText,
          },
          idempotencyKey: `claude:${sessionId}:${sha1(lastText)}`,
        });
      }
      office.event({ type: "stop", agentId: agent.id, text: "一轮工作结束" });
      return {};
    }
    case "SessionEnd": {
      office.store.setAgentStatus(agent.id, "offline");
      office.setActivity(agent.id, null);
      office.event({ type: "leave", agentId: agent.id, text: "Claude 会话下线" });
      return {};
    }
    default:
      return {};
  }
}

/**
 * ZCode hooks 摄入（事件名与 Claude Code 一致，大驼峰）。
 * 会话按 session_id 登记为 zcode-xxxxxx。ZCode 与 Claude 同源，
 * SessionStart 返回 additionalContext 注入协作约定；
 * Stop 时从 transcript JSONL 中防御性提取最后一条助手消息作为兜底简报。
 */
export function handleZcodeHook(
  office: OfficeService,
  payload: Record<string, any>,
  readTranscript: (path: string) => string | null = defaultReadTranscript,
): Record<string, unknown> {
  const eventName = payload.hook_event_name as string | undefined;
  const sessionId = payload.session_id as string | undefined;
  if (!eventName || !sessionId) return {};

  const model =
    (typeof payload.model === "string" && payload.model) || undefined;
  const agent = office.store.upsertAgentBySession(`zcode:session:${sessionId}`, {
    name: `zcode-${shortId(sessionId)}`,
    kind: "zcode-cli",
    workspace: (payload.cwd as string) ?? null,
    meta: { sessionId, ...(model ? { model } : {}) },
  });

  switch (eventName) {
    case "SessionStart": {
      office.event({ type: "join", agentId: agent.id, text: "ZCode 会话上线" });
      const pending = office.store.pendingCount(agent.id);
      const lines = [
        `[Agent Office] 本机运行着多 Agent 协作办公室（MCP 服务名 agent-office）。`,
        `你的工号是「${agent.name}」。协作约定：`,
        `1. 先调用 register_agent 刷新登记：name="${agent.name}"、kind="zcode-cli"、model 填你当前实际使用的 AI 模型名；注册后会自动分配职位，同岗成员共享职位上下文与知识库；`,
        `2. 开始处理任务前调用 read_inbox(agent="${agent.name}") 查看 @你的消息；`,
        `3. 完成阶段性工作后调用 publish_brief 发布简报；`,
        `4. 需要其他成员协助时用 send_message 并 @对方工号；`,
        `5. 阶段任务需要接力时调用 handoff_task 保存交接材料并自动唤醒接班员工，不要只在最终回复里写 @工号；`,
        `6. get_context 可获取办公室全景（花名册/任务/简报/知识库目录），read_logs 可看实时日志；`,
        `7. 遇到疑难问题先 kb_search 查公共知识库，解决后用 kb_write 沉淀方案。`,
      ];
      if (pending > 0) lines.push(`注意：你有 ${pending} 条未读消息，请先 read_inbox。`);
      return { additionalContext: lines.join("\n") };
    }
    case "UserPromptSubmit": {
      office.store.setAgentStatus(agent.id, "busy");
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
      const excerpt = truncate(prompt.replaceAll(/\s+/g, " "), 120);
      office.setActivity(agent.id, `处理指令：${excerpt}`);
      office.event({ type: "prompt", agentId: agent.id, text: `收到新指令：${excerpt}` });
      office.recordHistory(agent.id, "prompt", prompt);
      return {};
    }
    case "PreToolUse": {
      const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
      if (tool) office.setActivity(agent.id, `使用工具：${tool}`);
      return {};
    }
    case "Stop": {
      office.store.setAgentStatus(agent.id, "online");
      office.setActivity(agent.id, null);
      const transcriptPath = payload.transcript_path as string | undefined;
      const lastText = transcriptPath ? readTranscript(transcriptPath) : null;
      if (lastText?.trim()) {
        office.recordHistory(agent.id, "final", lastText);
        office.publishBrief({
          agentName: agent.name,
          kind: "auto",
          source: "zcode-hook",
          brief: {
            title: `工作回帧：${truncate(lastText.replaceAll(/\s+/g, " "), 48)}`,
            result: lastText,
          },
          idempotencyKey: `zcode:${sessionId}:${sha1(lastText)}`,
        });
      }
      office.event({ type: "stop", agentId: agent.id, text: "一轮工作结束" });
      return {};
    }
    case "SessionEnd": {
      office.store.setAgentStatus(agent.id, "offline");
      office.setActivity(agent.id, null);
      office.event({ type: "leave", agentId: agent.id, text: "ZCode 会话下线" });
      return {};
    }
    default:
      return {};
  }
}

/**
 * OpenCode 插件上报摄入。opencode 没有传统 hooks，改由本地插件把事件
 * POST 到 /ingest/opencode-hook（见 hooks/opencode-plugin.mjs）。
 * - session.created → 登记 opencode-xxxxxx（kind opencode-cli，workspace=directory）
 * - session.idle / compacted → 兜底回帧简报
 * - tool.execute.* → 实时活动
 * 插件失效时会话需手动 register_agent 登记。
 */
export function handleOpenCodeHook(
  office: OfficeService,
  payload: Record<string, any>,
): Record<string, unknown> {
  const eventName = payload.event as string | undefined;
  const sessionId = payload.session_id as string | undefined;
  if (!eventName || !sessionId) return { ok: true };

  const agent = office.store.upsertAgentBySession(`opencode:session:${sessionId}`, {
    name: `opencode-${shortId(sessionId)}`,
    kind: "opencode-cli",
    workspace: (payload.cwd as string) ?? null,
    meta: { sessionId, ...(typeof payload.title === "string" && payload.title ? { title: payload.title } : {}) },
  });

  switch (eventName) {
    case "session.created": {
      office.store.setAgentStatus(agent.id, "online");
      office.event({ type: "join", agentId: agent.id, text: "OpenCode 会话上线" });
      const pending = office.store.pendingCount(agent.id);
      const lines = [
        `[Agent Office] 本机运行着多 Agent 协作办公室（MCP 服务名 agent-office）。`,
        `你的工号是「${agent.name}」。协作约定：`,
        `1. 先调用 register_agent 刷新登记：name="${agent.name}"、kind="opencode-cli"、model 填你当前实际使用的 AI 模型名；注册后会自动分配职位，同岗成员共享职位上下文与知识库；`,
        `2. 开始处理任务前调用 read_inbox(agent="${agent.name}") 查看 @你的消息；`,
        `3. 完成阶段性工作后调用 publish_brief 发布简报；`,
        `4. 需要其他成员协助时用 send_message 并 @对方工号；`,
        `5. 阶段任务需要接力时调用 handoff_task 保存交接材料并自动唤醒接班员工，不要只在最终回复里写 @工号；`,
        `6. get_context 可获取办公室全景（花名册/任务/简报/知识库目录），read_logs 可看实时日志；`,
        `7. 遇到疑难问题先 kb_search 查公共知识库，解决后用 kb_write 沉淀方案。`,
      ];
      if (pending > 0) lines.push(`注意：你有 ${pending} 条未读消息，请先 read_inbox。`);
      return { ok: true, additionalContext: lines.join("\n") };
    }
    case "tool.execute.before": {
      const tool = typeof payload.tool === "string" ? payload.tool : "";
      if (tool) office.setActivity(agent.id, `使用工具：${tool}`);
      return { ok: true };
    }
    case "tool.execute.after": {
      const tool = typeof payload.tool === "string" ? payload.tool : "";
      if (tool) office.setActivity(agent.id, `使用工具：${tool}`);
      return { ok: true };
    }
    case "session.idle": {
      office.store.setAgentStatus(agent.id, "online");
      office.setActivity(agent.id, null);
      const summary = typeof payload.summary === "string" ? payload.summary : "";
      if (summary.trim()) {
        office.recordHistory(agent.id, "final", summary);
        office.publishBrief({
          agentName: agent.name,
          kind: "auto",
          source: "opencode-hook",
          brief: {
            title: `工作回帧：${truncate(summary.replaceAll(/\s+/g, " "), 48)}`,
            result: summary,
          },
          idempotencyKey: `opencode:${sessionId}:${sha1(summary)}`,
        });
      }
      office.event({ type: "turn", agentId: agent.id, text: "OpenCode 完成一轮工作" });
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}

/**
 * 通用 PascalCase 事件钩子摄入（Kimi / Qoder 与 Claude Code 同构）：
 * SessionStart（注入协作约定）/ UserPromptSubmit / PreToolUse / Stop（transcript 兜底简报）/ SessionEnd。
 * 会话按 session_id 登记为 <prefix>-xxxxxx。
 */
function handlePascalEventHook(
  office: OfficeService,
  payload: Record<string, any>,
  opts: {
    prefix: string; // kimi | qoder
    kind: "kimi-cli" | "qoder-cli";
    source: string;
    label: string;
  },
  readTranscript: (path: string) => string | null = defaultReadTranscript,
): Record<string, unknown> {
  const eventName = payload.hook_event_name as string | undefined;
  const sessionId = payload.session_id as string | undefined;
  if (!eventName || !sessionId) return {};

  const model =
    (typeof payload.model === "string" && payload.model) || undefined;
  const agent = office.store.upsertAgentBySession(`${opts.prefix}:session:${sessionId}`, {
    name: `${opts.prefix}-${shortId(sessionId)}`,
    kind: opts.kind,
    workspace: (payload.cwd as string) ?? null,
    meta: { sessionId, ...(model ? { model } : {}) },
  });

  switch (eventName) {
    case "SessionStart": {
      office.event({ type: "join", agentId: agent.id, text: `${opts.label} 会话上线` });
      const pending = office.store.pendingCount(agent.id);
      const lines = [
        `[Agent Office] 本机运行着多 Agent 协作办公室（MCP 服务名 agent-office）。`,
        `你的工号是「${agent.name}」。协作约定：`,
        `1. 先调用 register_agent 刷新登记：name="${agent.name}"、kind="${opts.kind}"、model 填你当前实际使用的 AI 模型名；注册后会自动分配职位，同岗成员共享职位上下文与知识库；`,
        `2. 开始处理任务前调用 read_inbox(agent="${agent.name}") 查看 @你的消息；`,
        `3. 完成阶段性工作后调用 publish_brief 发布简报；`,
        `4. 需要其他成员协助时用 send_message 并 @对方工号；`,
        `5. 阶段任务需要接力时调用 handoff_task 保存交接材料并自动唤醒接班员工，不要只在最终回复里写 @工号；`,
        `6. get_context 可获取办公室全景（花名册/任务/简报/知识库目录），read_logs 可看实时日志；`,
        `7. 遇到疑难问题先 kb_search 查公共知识库，解决后用 kb_write 沉淀方案。`,
      ];
      if (pending > 0) lines.push(`注意：你有 ${pending} 条未读消息，请先 read_inbox。`);
      return { additionalContext: lines.join("\n") };
    }
    case "UserPromptSubmit": {
      office.store.setAgentStatus(agent.id, "busy");
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
      const excerpt = truncate(prompt.replaceAll(/\s+/g, " "), 120);
      office.setActivity(agent.id, `处理指令：${excerpt}`);
      office.event({ type: "prompt", agentId: agent.id, text: `收到新指令：${excerpt}` });
      office.recordHistory(agent.id, "prompt", prompt);
      return {};
    }
    case "PreToolUse": {
      const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
      if (tool) office.setActivity(agent.id, `使用工具：${tool}`);
      return {};
    }
    case "Stop": {
      office.store.setAgentStatus(agent.id, "online");
      office.setActivity(agent.id, null);
      const transcriptPath = payload.transcript_path as string | undefined;
      const lastText = transcriptPath ? readTranscript(transcriptPath) : null;
      if (lastText?.trim()) {
        office.recordHistory(agent.id, "final", lastText);
        office.publishBrief({
          agentName: agent.name,
          kind: "auto",
          source: opts.source,
          brief: {
            title: `工作回帧：${truncate(lastText.replaceAll(/\s+/g, " "), 48)}`,
            result: lastText,
          },
          idempotencyKey: `${opts.prefix}:${sessionId}:${sha1(lastText)}`,
        });
      }
      office.event({ type: "stop", agentId: agent.id, text: "一轮工作结束" });
      return {};
    }
    case "SessionEnd": {
      office.store.setAgentStatus(agent.id, "offline");
      office.setActivity(agent.id, null);
      office.event({ type: "leave", agentId: agent.id, text: `${opts.label} 会话下线` });
      return {};
    }
    default:
      return {};
  }
}

/** Kimi Code CLI hooks 摄入（事件名大驼峰，与 Claude 同构；支持终端工位收养） */
export function handleKimiHook(
  office: OfficeService,
  payload: Record<string, any>,
  readTranscript: (path: string) => string | null = defaultReadTranscript,
): Record<string, unknown> {
  const sessionId = payload.session_id as string | undefined;
  if (sessionId) {
    // 终端工位占位收养：开「Kimi 工位」时已先入驻，这里把会话绑到那个工位
    const kimiKey = `kimi:session:${sessionId}`;
    if (!office.store.sessionAgent(kimiKey)) {
      office.adoptTerminalAgent("kimi", kimiKey, (payload.cwd as string) ?? null, {
        sessionId,
      });
    }
  }
  return handlePascalEventHook(
    office,
    payload,
    { prefix: "kimi", kind: "kimi-cli", source: "kimi-hook", label: "Kimi" },
    readTranscript,
  );
}

/** Qoder hooks 摄入（事件名大驼峰，Cursor 同构） */
export function handleQoderHook(
  office: OfficeService,
  payload: Record<string, any>,
  readTranscript: (path: string) => string | null = defaultReadTranscript,
): Record<string, unknown> {
  return handlePascalEventHook(
    office,
    payload,
    { prefix: "qoder", kind: "qoder-cli", source: "qoder-hook", label: "Qoder" },
    readTranscript,
  );
}

/** 从 Claude Code transcript JSONL 提取最后一条助手文本（格式不稳定，防御性解析） */
function defaultReadTranscript(path: string): string | null {
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const message = entry?.message ?? entry;
        if ((entry?.type === "assistant" || message?.role === "assistant") && message?.content) {
          const content = message.content;
          if (typeof content === "string") return content;
          if (Array.isArray(content)) {
            const texts = content
              .filter((b: any) => b?.type === "text" && typeof b.text === "string")
              .map((b: any) => b.text);
            if (texts.length > 0) return texts.join("\n");
          }
        }
      } catch {
        /* 跳过坏行 */
      }
    }
  } catch {
    /* transcript 不可读 */
  }
  return null;
}

/**
 * Codex notify 摄入（agent-turn-complete）。
 * 手工 Codex 会话按 thread-id 登记为 codex-xxxxxx，最终回答落为兜底简报。
 * threadId 记入 meta，便于将来 @ 它时用 codex exec resume 续聊。
 */
export function handleCodexNotify(
  office: OfficeService,
  payload: Record<string, any>,
): { ok: boolean } {
  if (payload?.type !== "agent-turn-complete") return { ok: true };
  const threadId = (payload["thread-id"] ?? payload.thread_id) as string | undefined;
  if (!threadId) return { ok: true };
  const turnId = (payload["turn-id"] ?? payload.turn_id ?? "") as string;
  const cwd = (payload.cwd ?? null) as string | null;
  const lastMessage = (payload["last-assistant-message"] ??
    payload.last_assistant_message ??
    "") as string;

  // 托管 Codex 工位跑 codex exec 时同样会触发 notify，识别后跳过：
  // 托管调度器自己会回帖简报，这里再登记就成了重复员工
  const managedTwin = office.store
    .listAgents()
    .find(
      (a) =>
        a.kind === "codex-managed" &&
        (a.meta as { threadId?: string }).threadId === threadId,
    );
  if (managedTwin) {
    office.store.setAgentStatus(managedTwin.id, "online");
    return { ok: true };
  }

  // 终端工位占位收养：开「Codex 工位」时已先入驻，这里把线程绑到那个工位而不是新建员工
  const externalKey = `codex:thread:${threadId}`;
  if (!office.store.sessionAgent(externalKey)) {
    office.adoptTerminalAgent("codex", externalKey, cwd, { threadId });
  }
  const agent = office.store.upsertAgentBySession(externalKey, {
    name: `codex-${shortId(threadId)}`,
    kind: "codex-cli",
    workspace: cwd,
    meta: { threadId },
  });
  office.store.setAgentStatus(agent.id, "online");

  if (lastMessage.trim()) {
    office.recordHistory(agent.id, "final", lastMessage);
    office.publishBrief({
      agentName: agent.name,
      kind: "auto",
      source: "codex-notify",
      brief: {
        title: `工作回帧：${truncate(lastMessage.replaceAll(/\s+/g, " "), 48)}`,
        result: lastMessage,
      },
      idempotencyKey: `codex:${threadId}:${turnId || sha1(lastMessage)}`,
    });
  }
  office.event({ type: "turn", agentId: agent.id, text: "Codex 完成一轮工作" });
  return { ok: true };
}
