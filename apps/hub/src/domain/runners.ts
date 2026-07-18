import { buildManagedPrompt, type AgentCard } from "@agent-office/protocol";
import type { OfficeConfig } from "../config.js";
import { runCli, sha1, truncate } from "../util.js";
import type { OfficeService } from "./office.js";
import type { TermLineKind } from "./terminal.js";

export interface TurnResult {
  text: string;
  meta?: Record<string, unknown>;
  /** 本轮消耗的 token 总量（输入+输出），拿不到时缺省 */
  usage?: number;
}

/** 托管执行的旁路通道：实时终端行 + 可终止句柄 */
export interface TurnIO {
  term: (text: string, kind?: TermLineKind) => void;
  registerKill?: (kill: () => void) => void;
}

const NOOP_IO: TurnIO = { term: () => {} };

export type TurnRunner = (
  agent: AgentCard,
  prompt: string,
  io?: TurnIO,
) => Promise<TurnResult>;

/** 每个 Agent 一条串行链，避免同一托管会话并发跑两轮 */
export class RunQueue {
  private chains = new Map<string, Promise<void>>();

  enqueue(key: string, job: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(job, job);
    this.chains.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }
}

/**
 * 拼装 codex exec 参数。
 * 注意：`codex exec resume` 子命令不接受 --sandbox / -C（会退出码 2），
 * 沙箱改用 -c sandbox_mode=... 传入；工作目录沿用会话记录。
 */
export function buildCodexExecArgs(meta: { threadId?: string; sandbox?: string }, workspace: string | null): string[] {
  const sandbox = meta.sandbox === "workspace-write" ? "workspace-write" : "read-only";
  const args = ["exec"];
  if (meta.threadId) {
    args.push("resume", meta.threadId);
    args.push("--json", "--skip-git-repo-check");
    args.push("-c", `sandbox_mode=${sandbox}`);
  } else {
    args.push("--json", "--skip-git-repo-check");
    args.push("--sandbox", sandbox);
    if (workspace) args.push("-C", workspace);
  }
  args.push("-");
  return args;
}

/** 把 codex --json 事件翻译成终端可读行 */
function codexEventToTerm(event: any, io: TurnIO): void {
  const item = event?.item;
  if (event?.type === "item.started" && item?.item_type === "command_execution") {
    io.term(`$ ${item.command ?? "(命令)"}`, "cmd");
    return;
  }
  if (event?.type === "item.completed" && item) {
    switch (item.item_type) {
      case "command_execution": {
        const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
        const tail = output.split(/\r?\n/).filter(Boolean).slice(-8).join("\n");
        if (tail) io.term(tail, "out");
        if (item.exit_code !== undefined && item.exit_code !== 0) {
          io.term(`↳ 退出码 ${item.exit_code}`, "error");
        }
        return;
      }
      case "reasoning":
        if (typeof item.text === "string" && item.text.trim()) {
          io.term(`… ${truncate(item.text.replaceAll(/\s+/g, " "), 120)}`, "info");
        }
        return;
      case "file_change": {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const files = changes.map((c: any) => c?.path).filter(Boolean).slice(0, 5).join("、");
        io.term(`✎ 文件改动${files ? `：${files}` : ""}`, "info");
        return;
      }
      case "mcp_tool_call":
        io.term(`⚒ 调用工具 ${item.server ?? ""}.${item.tool ?? ""}`, "info");
        return;
      case "agent_message":
        if (typeof item.text === "string") io.term(item.text, "final");
        return;
      default:
        return;
    }
  }
  if (event?.type === "error" && typeof event.message === "string") {
    io.term(event.message, "error");
  }
}

/** 托管 Codex：codex exec --json，提示词经 stdin，线程 ID 存 meta 以便续聊 */
export async function runCodexTurn(
  agent: AgentCard,
  prompt: string,
  config: OfficeConfig,
  io: TurnIO = NOOP_IO,
): Promise<TurnResult> {
  const meta = agent.meta as { threadId?: string; sandbox?: string };
  const args = buildCodexExecArgs(meta, agent.workspace);

  let threadId: string | undefined;
  let lastAgentMessage = "";
  let usage: number | undefined;
  const result = await runCli("codex", args, {
    timeoutMs: config.codexTurnTimeoutMs,
    stdinData: prompt,
    registerKill: io.registerKill,
    onLine: (line) => {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event?.type === "thread.started" && typeof event.thread_id === "string") {
        threadId = event.thread_id;
      }
      if (event?.type === "turn.completed" && event.usage) {
        const u = event.usage;
        usage = (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0);
      }
      const item = event?.item ?? event;
      if (
        (event?.type === "item.completed" || event?.type === "item.updated") &&
        item?.item_type !== undefined
      ) {
        if (item.item_type === "agent_message" && typeof item.text === "string") {
          lastAgentMessage = item.text;
        }
      } else if (item?.type === "agent_message" && typeof item.text === "string") {
        lastAgentMessage = item.text;
      }
      codexEventToTerm(event, io);
    },
  });

  if (result.timedOut) {
    throw new Error(`Codex 运行超时（${Math.round(config.codexTurnTimeoutMs / 60000)} 分钟）`);
  }
  if (result.code !== 0 && !lastAgentMessage) {
    throw new Error(
      `codex exec 退出码 ${result.code}：${truncate(result.stderr || result.stdout, 400)}`,
    );
  }
  return {
    text: lastAgentMessage || truncate(result.stdout, 2000) || "(无输出)",
    meta: threadId ? { threadId } : undefined,
    usage,
  };
}

/** 托管 Claude：claude -p --output-format stream-json，流式行喂终端，session_id 存 meta 续聊 */
export async function runClaudeTurn(
  agent: AgentCard,
  prompt: string,
  config: OfficeConfig,
  io: TurnIO = NOOP_IO,
): Promise<TurnResult> {
  const meta = agent.meta as { sessionId?: string; sandbox?: string };
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (meta.sessionId) args.push("--resume", meta.sessionId);
  if (meta.sandbox === "workspace-write") args.push("--permission-mode", "acceptEdits");

  let finalText = "";
  let sessionId: string | undefined;
  let model: string | undefined;
  let usage: number | undefined;
  const result = await runCli("claude", args, {
    cwd: agent.workspace ?? undefined,
    timeoutMs: config.codexTurnTimeoutMs,
    stdinData: prompt,
    registerKill: io.registerKill,
    onLine: (line) => {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event?.type === "system" && event.subtype === "init") {
        if (typeof event.session_id === "string") sessionId = event.session_id;
        if (typeof event.model === "string") model = event.model;
        io.term(`会话就绪${model ? `（${model}）` : ""}`, "info");
        return;
      }
      if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
            io.term(block.text, "out");
          } else if (block?.type === "tool_use") {
            io.term(`⚒ 调用工具 ${block.name ?? ""}`, "info");
          }
        }
        return;
      }
      if (event?.type === "result") {
        if (typeof event.result === "string") finalText = event.result;
        if (typeof event.session_id === "string") sessionId = event.session_id;
        if (event.usage) {
          usage =
            (Number(event.usage.input_tokens) || 0) + (Number(event.usage.output_tokens) || 0);
        }
        if (event.is_error) io.term(String(event.result ?? "执行出错"), "error");
      }
    },
  });
  if (result.timedOut) {
    throw new Error(`Claude 运行超时（${Math.round(config.codexTurnTimeoutMs / 60000)} 分钟）`);
  }
  if (result.code !== 0 && !finalText) {
    throw new Error(
      `claude -p 退出码 ${result.code}：${truncate(result.stderr || result.stdout, 400)}`,
    );
  }
  return {
    text: finalText || truncate(result.stdout, 2000) || "(无输出)",
    meta: {
      ...(sessionId ? { sessionId } : {}),
      ...(model ? { model } : {}),
    },
    usage,
  };
}

/** 托管 Cursor：@cursor/sdk 本地运行；SDK 缺失或无 API Key 时报明确错误 */
export async function runCursorTurn(
  agent: AgentCard,
  prompt: string,
  config: OfficeConfig,
  io: TurnIO = NOOP_IO,
): Promise<TurnResult> {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    throw new Error("未配置 CURSOR_API_KEY，无法运行托管 Cursor Agent");
  }
  let sdk: any;
  try {
    sdk = await import("@cursor/sdk");
  } catch {
    throw new Error("@cursor/sdk 未安装，无法运行托管 Cursor Agent");
  }
  const { Agent } = sdk;
  const meta = agent.meta as { cursorAgentId?: string };
  const options = {
    apiKey,
    model: { id: config.cursorModel },
    local: { cwd: agent.workspace ?? process.cwd() },
  };
  io.term("启动 Cursor 托管运行…", "info");
  const sdkAgent = meta.cursorAgentId
    ? await Agent.resume(meta.cursorAgentId, { apiKey })
    : await Agent.create(options);
  try {
    const run = await sdkAgent.send(prompt);
    const result = await run.wait();
    if (result.status === "error") {
      throw new Error(`Cursor 托管运行失败（run ${result.id ?? "?"}）`);
    }
    const text =
      typeof result.result === "string" && result.result.length > 0
        ? result.result
        : "(无输出)";
    io.term(text, "final");
    return { text, meta: { cursorAgentId: sdkAgent.agentId } };
  } finally {
    try {
      await sdkAgent[Symbol.asyncDispose]?.();
    } catch {
      /* 忽略清理错误 */
    }
  }
}

/**
 * 组装托管调度器：@托管 Agent → 排队执行 → 回复入群 + 自动发布简报。
 * runner 可注入，测试时用假实现。
 */
export function createManagedDispatcher(
  office: OfficeService,
  config: OfficeConfig,
  runners?: Partial<
    Record<"codex-managed" | "cursor-managed" | "claude-managed", TurnRunner>
  >,
) {
  const queue = new RunQueue();
  const lastErrors = new Map<string, string>();
  const resolveRunner = (kind: string): TurnRunner => {
    if (kind === "codex-managed") {
      return runners?.["codex-managed"] ?? ((a, p, io) => runCodexTurn(a, p, config, io));
    }
    if (kind === "claude-managed") {
      return runners?.["claude-managed"] ?? ((a, p, io) => runClaudeTurn(a, p, config, io));
    }
    return runners?.["cursor-managed"] ?? ((a, p, io) => runCursorTurn(a, p, config, io));
  };

  return (agent: AgentCard, message: { fromName: string; text: string; taskId?: string | null }) => {
    void queue.enqueue(agent.id, async () => {
      const { store } = office;
      store.setAgentStatus(agent.id, "busy");
      office.setActivity(
        agent.id,
        `执行 ${message.fromName} 的请求：${truncate(message.text.replaceAll(/\s+/g, " "), 80)}`,
      );
      office.event({ type: "run", agentId: agent.id, text: "收到 @消息，开始执行" });
      office.terminals.push(
        agent.id,
        `→ ${message.fromName}：${truncate(message.text.replaceAll(/\s+/g, " "), 200)}`,
        "cmd",
      );
      const context = store.listBriefs(5).map((b) => ({
        agentName: b.agentName,
        title: b.title,
        result: b.result,
      }));
      const prompt = buildManagedPrompt({
        agentName: agent.name,
        senderName: message.fromName,
        text: message.text,
        contextBriefs: context,
      });
      const io: TurnIO = {
        term: (text, kind) => office.terminals.push(agent.id, text, kind),
        registerKill: (kill) => office.registerRunKill(agent.id, kill),
      };
      try {
        const runner = resolveRunner(agent.kind);
        const result = await runner(agent, prompt, io);
        if (result.meta && Object.keys(result.meta).length > 0) {
          store.updateAgentMeta(agent.id, result.meta);
        }
        if (result.usage) store.addTokens(agent.id, result.usage);
        store.markDeliveriesRead(agent.id);
        // 回复以群消息形式进入动态流（不再触发 @ 路由），同时留档简报墙
        office.postReply(agent.id, result.text, message.taskId ?? null);
        office.publishBrief({
          agentName: agent.name,
          kind: "auto",
          source: agent.kind,
          brief: {
            title: `回复 ${message.fromName}：${truncate(message.text.replaceAll(/\s+/g, " "), 40)}`,
            result: result.text,
            task_id: message.taskId ?? undefined,
          },
          idempotencyKey: `run:${agent.id}:${sha1(message.text + message.fromName)}:${Date.now()}`,
        });
        store.setAgentStatus(agent.id, "online");
        office.setActivity(agent.id, null);
        lastErrors.delete(agent.id);
        office.terminals.push(
          agent.id,
          `✓ 执行完成${result.usage ? `（${result.usage.toLocaleString()} tokens）` : ""}`,
          "info",
        );
        office.event({ type: "run", agentId: agent.id, text: "执行完成，已回复并发布简报" });
      } catch (error) {
        // 失败也要清收件箱，否则未读数只增不减
        store.markDeliveriesRead(agent.id);
        store.setAgentStatus(agent.id, "online");
        office.setActivity(agent.id, null);
        const raw = error instanceof Error ? error.message : String(error);
        const brief = truncate(raw.replaceAll(/\s+/g, " ").trim(), 160);
        const repeated = lastErrors.get(agent.id) === brief;
        lastErrors.set(agent.id, brief);
        office.terminals.push(agent.id, `✗ ${brief}`, "error");
        office.event({
          type: "run-error",
          agentId: agent.id,
          text: repeated ? "执行失败（与上次相同的错误，详情见前文）" : `执行失败：${brief}`,
        });
      } finally {
        office.clearRunKill(agent.id);
      }
    });
  };
}
