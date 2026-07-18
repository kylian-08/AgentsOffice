import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

export const uuid = (): string => randomUUID();
export const now = (): number => Date.now();

export function sha1(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

export function shortId(source: string, len = 6): string {
  return sha1(source).slice(0, len);
}

/** cmd.exe 下的参数引用：仅在包含空白或特殊字符时加引号 */
export function quoteForShell(arg: string): string {
  if (/^[\w.:\\/=@,-]+$/u.test(arg) && !/\s/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '\\"')}"`;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 运行 CLI 命令（Windows 下 npm shim 是 .cmd，需 shell:true）。
 * 提示词等复杂内容一律通过 stdin 传入，argv 只放受控 token。
 */
export function runCli(
  command: string,
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs?: number;
    stdinData?: string;
    onLine?: (line: string) => void;
    /** 注册终止函数，调用方可随时杀掉整个进程树 */
    registerKill?: (kill: () => void) => void;
  } = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const child = isWindows
      ? spawn([command, ...args.map(quoteForShell)].join(" "), {
          cwd: opts.cwd,
          shell: true,
          windowsHide: true,
        })
      : spawn(command, args, { cwd: opts.cwd });

    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let timedOut = false;
    let settled = false;

    // Windows 下 shell:true 只杀 cmd 壳，须 taskkill /T 连根拔进程树
    const killTree = () => {
      if (settled) return;
      if (isWindows && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
    };
    opts.registerKill?.(killTree);

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree();
        }, opts.timeoutMs)
      : null;

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (opts.onLine) {
        lineBuffer += text;
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) opts.onLine(line);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (opts.onLine && lineBuffer.trim()) opts.onLine(lineBuffer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));

    if (opts.stdinData !== undefined) {
      child.stdin?.write(opts.stdinData, "utf8");
    }
    child.stdin?.end();
  });
}

/** 检查某个 CLI 是否可用（Windows: where / 其他: which） */
export async function cliExists(name: string): Promise<boolean> {
  const probe = process.platform === "win32" ? "where.exe" : "which";
  const result = await runCli(probe, [name], { timeoutMs: 5_000 });
  return result.code === 0 && result.stdout.trim().length > 0;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
