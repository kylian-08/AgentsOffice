import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const HOOKS_DIR = resolve(import.meta.dirname, "../../../hooks");
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
  server = createServer((request, response) => {
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
});
