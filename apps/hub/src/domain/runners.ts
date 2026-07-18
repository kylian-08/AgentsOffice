import { buildManagedPrompt, type AgentCard } from "@agent-office/protocol";
import type { OfficeConfig } from "../config.js";
import { runCli, sha1, truncate } from "../util.js";
import type { OfficeService } from "./office.js";

export interface TurnResult {
  text: string;
  meta?: Record<string, unknown>;
}

export type TurnRunner = (
  agent: AgentCard,
  prompt: string,
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

/** 托管 Codex：codex exec --json，提示词经 stdin，线程 ID 存 meta 以便续聊 */
export async function runCodexTurn(
  agent: AgentCard,
  prompt: string,
  config: OfficeConfig,
): Promise<TurnResult> {
  const meta = agent.meta as { threadId?: string; sandbox?: string };
  const args = buildCodexExecArgs(meta, agent.workspace);

  let threadId: string | undefined;
  let lastAgentMessage = "";
  const result = await runCli("codex", args, {
    timeoutMs: config.codexTurnTimeoutMs,
    stdinData: prompt,
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
  };
}

/** 托管 Claude：claude -p --output-format json，提示词经 stdin，session_id 存 meta 续聊 */
export async function runClaudeTurn(
  agent: AgentCard,
  prompt: string,
  config: OfficeConfig,
): Promise<TurnResult> {
  const meta = agent.meta as { sessionId?: string; sandbox?: string };
  const args = ["-p", "--output-format", "json"];
  if (meta.sessionId) args.push("--resume", meta.sessionId);
  if (meta.sandbox === "workspace-write") args.push("--permission-mode", "acceptEdits");

  const result = await runCli("claude", args, {
    cwd: agent.workspace ?? undefined,
    timeoutMs: config.codexTurnTimeoutMs,
    stdinData: prompt,
  });
  if (result.timedOut) {
    throw new Error(`Claude 运行超时（${Math.round(config.codexTurnTimeoutMs / 60000)} 分钟）`);
  }
  let parsed: any = null;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    /* 非 JSON 输出走兜底 */
  }
  if (result.code !== 0 && !parsed?.result) {
    throw new Error(
      `claude -p 退出码 ${result.code}：${truncate(result.stderr || result.stdout, 400)}`,
    );
  }
  return {
    text:
      (typeof parsed?.result === "string" && parsed.result) ||
      truncate(result.stdout, 2000) ||
      "(无输出)",
    meta: typeof parsed?.session_id === "string" ? { sessionId: parsed.session_id } : undefined,
  };
}

/** 托管 Cursor：@cursor/sdk 本地运行；SDK 缺失或无 API Key 时报明确错误 */
export async function runCursorTurn(
  agent: AgentCard,
  prompt: string,
  config: OfficeConfig,
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
 * 组装托管调度器：@托管 Agent → 排队执行 → 自动发布简报。
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
      return runners?.["codex-managed"] ?? ((a, p) => runCodexTurn(a, p, config));
    }
    if (kind === "claude-managed") {
      return runners?.["claude-managed"] ?? ((a, p) => runClaudeTurn(a, p, config));
    }
    return runners?.["cursor-managed"] ?? ((a, p) => runCursorTurn(a, p, config));
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
      try {
        const runner = resolveRunner(agent.kind);
        const result = await runner(agent, prompt);
        if (result.meta) store.updateAgentMeta(agent.id, result.meta);
        store.markDeliveriesRead(agent.id);
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
        office.event({ type: "run", agentId: agent.id, text: "执行完成，简报已发布" });
      } catch (error) {
        // 失败也要清收件箱，否则未读数只增不减
        store.markDeliveriesRead(agent.id);
        store.setAgentStatus(agent.id, "online");
        office.setActivity(agent.id, null);
        const raw = error instanceof Error ? error.message : String(error);
        const brief = truncate(raw.replaceAll(/\s+/g, " ").trim(), 160);
        const repeated = lastErrors.get(agent.id) === brief;
        lastErrors.set(agent.id, brief);
        office.event({
          type: "run-error",
          agentId: agent.id,
          text: repeated ? "执行失败（与上次相同的错误，详情见前文）" : `执行失败：${brief}`,
        });
      }
    });
  };
}
