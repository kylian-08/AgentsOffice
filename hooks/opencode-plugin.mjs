// OpenCode 插件：把会话事件上报给 Agent Office Hub（/ingest/opencode-hook）。
// OpenCode 没有传统 JSON hooks，改用官方插件机制：本文件是纯 ESM 模块，
// 安装时被拷贝到 ~/.config/opencode/plugins/agent-office.mjs，由 opencode 加载。
// 会话自动入驻（session.created）、活动上报（tool.execute.*）、兜底回帧简报（session.idle）。
// Hub 不在线时静默失败，绝不阻塞 opencode。插件失效时退化为手动 register_agent。

const base = process.env.AGENT_OFFICE_URL || "http://127.0.0.1:4517";

/**
 * 把一条事件上报给 Hub（纯函数，便于测试）。Hub 不在线时静默失败。
 */
export async function reportEvent(event, payload) {
  try {
    await fetch(`${base}/ingest/opencode-hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, ...payload }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* 静默 */
  }
}

/** opencode 插件入口：named export `plugin`，返回事件钩子 */
export const plugin = async () => {
  const map = {
    "session.created": (event) =>
      reportEvent("session.created", {
        session_id: event.properties?.info?.id,
        cwd: event.properties?.info?.directory,
        title: event.properties?.info?.title,
      }),
    "session.idle": (event) =>
      reportEvent("session.idle", {
        session_id: event.properties?.sessionID,
        summary: event.properties?.summary ?? null,
      }),
    "session.compacted": (event) =>
      reportEvent("session.idle", {
        session_id: event.properties?.sessionID,
        summary: event.properties?.summary ?? null,
      }),
    "tool.execute.before": (event) =>
      reportEvent("tool.execute.before", {
        session_id: event.properties?.sessionID,
        tool: event.properties?.tool,
      }),
    "tool.execute.after": (event) =>
      reportEvent("tool.execute.after", {
        session_id: event.properties?.sessionID,
        tool: event.properties?.tool,
        output: event.properties?.output ?? null,
      }),
  };
  return {
    event: async ({ event }) => {
      const handler = map[event.type];
      if (handler) await handler(event);
    },
  };
};
