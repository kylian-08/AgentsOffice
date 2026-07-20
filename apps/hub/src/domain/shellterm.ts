// 应用内 Windows 终端：ConPTY 伪终端会话管理（@lydell/node-pty 预编译，免构建）
import { homedir } from "node:os";
import { uuid } from "../util.js";

export interface ShellTermInfo {
  id: string;
  title: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  /** 进程是否还活着；退出后保留一会儿供前端看到退出码 */
  alive: boolean;
  exitCode: number | null;
}

interface PtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pid: number;
}

interface Session {
  info: ShellTermInfo;
  pty: PtyLike;
  /** 输出回放缓冲（新客户端接入时重放） */
  buffer: string;
  listeners: Set<(chunk: string) => void>;
  exitListeners: Set<(code: number) => void>;
}

const MAX_BUFFER = 200_000; // 每个会话保留约 200KB 回放
const MAX_SESSIONS = 12;

export class ShellTerminalManager {
  private sessions = new Map<string, Session>();

  /** node-pty 加载失败时的原因（诊断用） */
  loadError: string | null = null;

  private async loadPty(): Promise<typeof import("@lydell/node-pty") | null> {
    try {
      return await import("@lydell/node-pty");
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  async create(opts: {
    shell?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
    title?: string;
    /** 直接在终端里启动的 Agent CLI（codex / claude），会话经 hooks/notify 自动入驻办公室 */
    command?: "codex" | "claude";
  }): Promise<{ ok: true; info: ShellTermInfo } | { ok: false; error: string }> {
    const aliveCount = [...this.sessions.values()].filter((s) => s.info.alive).length;
    if (aliveCount >= MAX_SESSIONS) {
      return { ok: false, error: `终端数量已达上限（${MAX_SESSIONS} 个），请先关闭一些` };
    }
    const nodePty = await this.loadPty();
    if (!nodePty) {
      return { ok: false, error: `伪终端组件加载失败：${this.loadError ?? "未知原因"}` };
    }
    const shell =
      opts.shell === "cmd"
        ? "cmd.exe"
        : opts.shell === "pwsh"
          ? "pwsh.exe"
          : process.platform === "win32"
            ? "powershell.exe"
            : (process.env.SHELL ?? "bash");
    // Agent CLI 在 shell 里启动：CLI 退出后终端还在，能看到报错
    const args: string[] = [];
    if (opts.command === "codex" || opts.command === "claude") {
      if (shell === "cmd.exe") args.push("/k", opts.command);
      else args.push("-NoLogo", "-NoExit", "-Command", opts.command);
    }
    const cwd = opts.cwd && opts.cwd.trim().length > 0 ? opts.cwd.trim() : homedir();
    const cols = opts.cols ?? 100;
    const rows = opts.rows ?? 30;
    // hub 可能是从自动化 shell 启动的（TERM=dumb），会话必须拿到真终端的环境；
    // 本机回环流量绕开系统代理，否则 codex/claude 访问 hub 的 MCP 会被代理吃掉（502）
    const noProxy = [process.env.NO_PROXY, "127.0.0.1,localhost,::1"]
      .filter(Boolean)
      .join(",");
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    };
    let pty: PtyLike;
    try {
      pty = nodePty.spawn(shell, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env,
      }) as unknown as PtyLike;
    } catch (error) {
      return {
        ok: false,
        error: `终端启动失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const info: ShellTermInfo = {
      id: uuid(),
      title:
        opts.title?.trim() ||
        `${opts.command ?? shell.replace(".exe", "")} · ${this.sessions.size + 1}`,
      shell,
      cwd,
      cols,
      rows,
      createdAt: Date.now(),
      alive: true,
      exitCode: null,
    };
    const session: Session = { info, pty, buffer: "", listeners: new Set(), exitListeners: new Set() };
    pty.onData((chunk) => {
      session.buffer = (session.buffer + chunk).slice(-MAX_BUFFER);
      for (const cb of session.listeners) cb(chunk);
    });
    pty.onExit(({ exitCode }) => {
      info.alive = false;
      info.exitCode = exitCode;
      for (const cb of session.exitListeners) cb(exitCode);
    });
    this.sessions.set(info.id, session);
    return { ok: true, info };
  }

  list(): ShellTermInfo[] {
    return [...this.sessions.values()]
      .map((s) => s.info)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  write(id: string, data: string): boolean {
    const s = this.sessions.get(id);
    if (!s?.info.alive) return false;
    s.pty.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const s = this.sessions.get(id);
    if (!s?.info.alive) return false;
    if (cols < 2 || rows < 2 || cols > 500 || rows > 300) return false;
    try {
      s.pty.resize(Math.floor(cols), Math.floor(rows));
      s.info.cols = Math.floor(cols);
      s.info.rows = Math.floor(rows);
      return true;
    } catch {
      return false;
    }
  }

  /** 杀进程并移除会话 */
  close(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.info.alive) {
      try {
        s.pty.kill();
      } catch {
        /* 已退出 */
      }
    }
    this.sessions.delete(id);
    return true;
  }

  /** 订阅输出；返回取消函数。attach 时先把缓冲回放给调用方 */
  attach(
    id: string,
    onData: (chunk: string) => void,
    onExit: (code: number) => void,
  ): (() => void) | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.buffer.length > 0) onData(s.buffer);
    if (!s.info.alive) {
      onExit(s.info.exitCode ?? 0);
      return () => {};
    }
    s.listeners.add(onData);
    s.exitListeners.add(onExit);
    return () => {
      s.listeners.delete(onData);
      s.exitListeners.delete(onExit);
    };
  }

  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
