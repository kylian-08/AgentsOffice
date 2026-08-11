import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * stdio MCP 标准代理：把只支持 stdio 的客户端（如 WorkBuddy）接入 Hub 的 HTTP /mcp。
 *
 * 架构：上游客户端 ──stdio──> 本进程（Server + StdioServerTransport）
 *       ──转发──> Hub /mcp（Client + StreamableHTTPClientTransport）
 *
 * Hub 是常驻 HTTP 服务，stdio 客户端天然要求「每个会话一个进程」，
 * 因此用官方 SDK 做薄代理：tools/list、tools/call 透传，其余协议消息（initialize、
 * ping、notifications）由 Server 与 Client 各自自动应答。
 *
 * 用法：node dist/mcp/stdio.js [hubBaseUrl]（缺省读 AGENT_OFFICE_URL / 4517）
 */

const base = (process.argv[2] ?? process.env.AGENT_OFFICE_URL ?? "http://127.0.0.1:4517").replace(
  /\/+$/,
  "",
);
const hubMcpUrl = `${base}/mcp`;
// 长任务（托管回合默认 10 分钟）需大于 HTTP 直连的默认请求窗口
const REQUEST_TIMEOUT_MS = 10 * 60_000;

const server = new Server(
  { name: "agent-office-stdio", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

let hub: Client | null = null;
async function hubClient(): Promise<Client> {
  if (hub) return hub;
  const client = new Client({ name: "agent-office-stdio", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(hubMcpUrl)));
  hub = client;
  return client;
}

server.setRequestHandler(ListToolsRequestSchema, async () =>
  (await hubClient()).listTools(undefined, { timeout: REQUEST_TIMEOUT_MS }),
);

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  (await hubClient()).callTool(
    { name: request.params.name, arguments: request.params.arguments ?? undefined },
    undefined,
    { timeout: REQUEST_TIMEOUT_MS },
  ),
);

// 上游关闭 stdin 即结束进程，避免 HTTP 客户端句柄挂住不退出
process.stdin.on("end", () => process.exit(0));

const transport = new StdioServerTransport();
await server.connect(transport);
