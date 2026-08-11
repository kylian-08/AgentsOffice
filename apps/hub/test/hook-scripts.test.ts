import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { OfficeBus } from "../src/domain/bus.js";
import { OfficeService } from "../src/domain/office.js";
import { OfficeStore } from "../src/domain/store.js";
import { createServer as createHubServer } from "../src/http/server.js";

const HOOKS_DIR = resolve(import.meta.dirname, "../../../hooks");
// SDK stdio 代理入口（TypeScript 源，Node 22+ 的 type stripping 可直接运行）
const STDIO_PROXY = resolve(import.meta.dirname, "../src/mcp/stdio.ts");
let server: Server | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolveClose, reject) => {
      server?.close((error) => (error ? reject(error) : resolveClose()));
    });
    server = null;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startReceiver(): Promise<{
  baseUrl: string;
  received: Promise<{ path: string; body: unknown }>;
}> {
  let receive!: (value: { path: string; body: unknown }) => void;
  const received = new Promise<{ path: string; body: unknown }>((resolveReceive) => {
    receive = resolveReceive;
  });
  server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      receive({
        path: request.url ?? "",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, received };
}

async function runHook(filename: string, args: string[], stdin?: string): Promise<string> {
  const child = spawn(process.execPath, [resolve(HOOKS_DIR, filename), ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdin.end(stdin);
  const exitCode = await new Promise<number | null>((resolveExit) => {
    child.on("exit", resolveExit);
  });
  if (exitCode !== 0) throw new Error(stderr || `Hook 退出码 ${exitCode}`);
  return stdout;
}

describe("协作 Hook 转发器", () => {
  it.each([
    ["cursor-hook.mjs", "/ingest/cursor-hook"],
    ["claude-hook.mjs", "/ingest/claude-hook"],
    ["zcode-hook.mjs", "/ingest/zcode-hook"],
    ["kimi-hook.mjs", "/ingest/kimi-hook"],
    ["qoder-hook.mjs", "/ingest/qoder-hook"],
  ])("%s 使用命令行传入的 Hub 地址", async (filename, expectedPath) => {
    const receiver = await startReceiver();
    const payload = { session_id: "session-1" };

    const stdout = await runHook(filename, [receiver.baseUrl], JSON.stringify(payload));

    await expect(receiver.received).resolves.toEqual({ path: expectedPath, body: payload });
    expect(stdout).toBe("{}");
  });

  it("Codex notify 在 Hub 地址后读取通知 JSON", async () => {
    const receiver = await startReceiver();
    const payload = { type: "agent-turn-complete", thread_id: "thread-1" };

    await runHook("codex-notify.mjs", [receiver.baseUrl, JSON.stringify(payload)]);

    await expect(receiver.received).resolves.toEqual({
      path: "/ingest/codex-notify",
      body: payload,
    });
  });

  it("Codex notify 把同一通知继续转发给原命令", async () => {
    const receiver = await startReceiver();
    const tempDir = mkdtempSync(resolve(tmpdir(), "agent-office-notify-"));
    tempDirs.push(tempDir);
    const outputPath = resolve(tempDir, "previous-notify.json");
    const chainPath = resolve(tempDir, "codex-notify-chain.json");
    const capture = "require('node:fs').writeFileSync(process.argv[1], process.argv[2])";
    writeFileSync(
      chainPath,
      JSON.stringify({ command: [process.execPath, "-e", capture, outputPath] }),
      "utf8",
    );
    const payload = { type: "agent-turn-complete", thread_id: "thread-chain" };

    await runHook("codex-notify.mjs", [receiver.baseUrl, chainPath, JSON.stringify(payload)]);
    const deadline = Date.now() + 2000;
    while (!existsSync(outputPath) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }

    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(payload);
    await expect(receiver.received).resolves.toEqual({
      path: "/ingest/codex-notify",
      body: payload,
    });
  });

  describe("stdio MCP 标准代理（SDK）", () => {
    let hubApp: Awaited<ReturnType<typeof createHubServer>> | null = null;
    let hubPort = 0;

    async function startOfficeHub(): Promise<string> {
      const dataDir = mkdtempSync(join(tmpdir(), "agent-office-proxy-"));
      tempDirs.push(dataDir);
      const office = new OfficeService(new OfficeStore(":memory:"), new OfficeBus());
      hubApp = await createHubServer(office, {
        port: 0,
        dataDir,
        cursorModel: "test",
        codexTurnTimeoutMs: 60_000,
        maxConcurrentRuns: 3,
      });
      await hubApp.listen({ port: 0, host: "127.0.0.1" });
      hubPort = (hubApp.server.address() as AddressInfo).port;
      return `http://127.0.0.1:${hubPort}`;
    }

    async function stopOfficeHub(): Promise<void> {
      if (hubApp) {
        await hubApp.close();
        hubApp = null;
      }
    }

    function spawnProxy(baseUrl: string): StdioClientTransport {
      return new StdioClientTransport({
        command: process.execPath,
        args: ["--experimental-strip-types", STDIO_PROXY, baseUrl],
      });
    }

    it("上游客户端经代理完成握手并透传 tools/list", async () => {
      const baseUrl = await startOfficeHub();
      const client = new Client({ name: "test-stdio", version: "0.0.1" });
      await client.connect(spawnProxy(baseUrl));
      try {
        const tools = await client.listTools();
        expect(tools.tools.some((t) => t.name === "register_agent")).toBe(true);
      } finally {
        await client.close();
        await stopOfficeHub();
      }
    });

    it("tools/call 经代理登记 WorkBuddy 员工（kind=workbuddy-cli）", async () => {
      const baseUrl = await startOfficeHub();
      const client = new Client({ name: "test-stdio", version: "0.0.1" });
      await client.connect(spawnProxy(baseUrl));
      try {
        const result = await client.callTool({
          name: "register_agent",
          arguments: { name: "wb-冒烟", kind: "workbuddy-cli" },
        });
        expect(JSON.stringify(result.content)).toContain("wb-冒烟");
      } finally {
        await client.close();
        await stopOfficeHub();
      }
    });

    it("Hub 离线时工具调用以可读错误拒绝而非挂起", async () => {
      const client = new Client({ name: "test-stdio", version: "0.0.1" });
      // initialize 由代理进程自身应答，连接不失败；工具转发时才需要 Hub
      await client.connect(spawnProxy("http://127.0.0.1:1"));
      try {
        await expect(client.listTools()).rejects.toThrow();
      } finally {
        await client.close();
      }
    });
  });

  describe("OpenCode 本地插件上报", () => {
    it("reportEvent 把会话事件转发到 /ingest/opencode-hook", async () => {
      const receiver = await startReceiver();
      const previous = process.env.AGENT_OFFICE_URL;
      process.env.AGENT_OFFICE_URL = receiver.baseUrl;
      try {
        // ESM 模块按 URL 缓存，用查询串强制重新加载以读新 env
        const pluginUrl = `${pathToFileURL(resolve(HOOKS_DIR, "opencode-plugin.mjs")).href}?t=${Date.now()}`;
        const { reportEvent } = await import(pluginUrl);
        await reportEvent("session.created", {
          session_id: "oc-1",
          cwd: "D:\\proj",
        });
      } finally {
        if (previous === undefined) delete process.env.AGENT_OFFICE_URL;
        else process.env.AGENT_OFFICE_URL = previous;
      }

      await expect(receiver.received).resolves.toEqual({
        path: "/ingest/opencode-hook",
        body: { event: "session.created", session_id: "oc-1", cwd: "D:\\proj" },
      });
    });
  });
});
