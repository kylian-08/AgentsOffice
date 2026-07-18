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
        `1. 先调用 register_agent 刷新登记：name="${agent.name}"、kind="cursor-ide"、model 填你当前实际使用的 AI 模型名；`,
        `2. 开始处理任务前调用 read_inbox(agent="${agent.name}") 查看 @你的消息（中途换了模型就在 read_inbox 时带 model 参数更新）；`,
        `3. 完成阶段性工作后调用 publish_brief 发布简报；`,
        `4. 需要其他成员协助时用 send_message 并 @对方工号；`,
        `5. get_context 可随时获取办公室全景（花名册/任务/简报/知识库目录），read_logs 可看实时日志；`,
        `6. 遇到疑难问题先 kb_search / kb_list 查公共知识库，解决了值得沉淀的问题就 kb_write 记录（分类/标题/根因/解决步骤）。`,
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

  const model =
    (typeof payload.model === "string" && payload.model) || undefined;
  const agent = office.store.upsertAgentBySession(`claude:session:${sessionId}`, {
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
        `1. 先调用 register_agent 刷新登记：name="${agent.name}"、kind="claude-cli"、model 填你当前实际使用的 AI 模型名；`,
        `2. 开始处理任务前调用 read_inbox(agent="${agent.name}") 查看 @你的消息；`,
        `3. 完成阶段性工作后调用 publish_brief 发布简报；`,
        `4. 需要其他成员协助时用 send_message 并 @对方工号；`,
        `5. get_context 可获取办公室全景（花名册/任务/简报/知识库目录），read_logs 可看实时日志；`,
        `6. 遇到疑难问题先 kb_search 查公共知识库，解决后用 kb_write 沉淀方案。`,
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

  const agent = office.store.upsertAgentBySession(`codex:thread:${threadId}`, {
    name: `codex-${shortId(threadId)}`,
    kind: "codex-cli",
    workspace: cwd,
    meta: { threadId },
  });
  office.store.setAgentStatus(agent.id, "online");

  if (lastMessage.trim()) {
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
