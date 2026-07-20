import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, app, session, shell } from "electron";

const OFFICE_HOME = join(homedir(), ".agent-office");

function readPort(): number {
  if (process.env.AGENT_OFFICE_PORT) return Number(process.env.AGENT_OFFICE_PORT);
  try {
    const cfg = JSON.parse(readFileSync(join(OFFICE_HOME, "config.json"), "utf8")) as {
      port?: number;
    };
    if (cfg.port) return Number(cfg.port);
  } catch {
    /* 首次启动还没有配置文件 */
  }
  return 4517;
}

/** 打包后资源在 resources/app 下；开发模式直接用 dist/resources */
function resourcesDir(): string {
  return app.isPackaged ? join(process.resourcesPath, "app") : join(__dirname, "resources");
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

let hubChild: ChildProcess | null = null;
let hubLog: string[] = [];

/** 探测内置 Node 是否需要 --experimental-sqlite 才能用 node:sqlite */
function sqliteFlag(): string[] {
  const probe = spawnSync(process.execPath, ["-e", "require('node:sqlite')"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
    timeout: 10_000,
  });
  return probe.status === 0 ? [] : ["--experimental-sqlite"];
}

function startHub(port: number): void {
  const res = resourcesDir();
  hubChild = spawn(
    process.execPath,
    [...sqliteFlag(), join(res, "hub", "index.mjs")],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        AGENT_OFFICE_PORT: String(port),
        AGENT_OFFICE_WEB_DIST: join(res, "web"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const capture = (chunk: Buffer) => {
    hubLog.push(chunk.toString());
    if (hubLog.length > 200) hubLog = hubLog.slice(-100);
  };
  hubChild.stdout?.on("data", capture);
  hubChild.stderr?.on("data", capture);
  hubChild.on("exit", () => {
    hubChild = null;
  });
}

function stopHub(): void {
  if (!hubChild?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(hubChild.pid), "/T", "/F"], { windowsHide: true });
  } else {
    hubChild.kill("SIGTERM");
  }
  hubChild = null;
}

async function waitForHub(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy(port)) return true;
    if (hubChild === null) return false; // 子进程已崩溃，别干等
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function createWindow(port: number): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "Agent Office",
    autoHideMenuBar: true,
    backgroundColor: "#0f1115",
  });
  // 外链交给系统浏览器，办公室页面留在窗口里
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${port}`)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  void win.loadURL(`http://127.0.0.1:${port}/`);
}

function showError(message: string): void {
  const win = new BrowserWindow({ width: 760, height: 480, title: "Agent Office - 启动失败" });
  const html = `<html><body style="background:#0f1115;color:#e8e8ec;font-family:system-ui;padding:24px">
    <h2>办公室没能开门</h2><pre style="white-space:pre-wrap;color:#f88">${message
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")}</pre></body></html>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    // 内嵌终端要像外部终端一样能复制粘贴：放开剪贴板读写权限
    const clipboardPerms = new Set(["clipboard-read", "clipboard-sanitized-write"]);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(clipboardPerms.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
      clipboardPerms.has(permission),
    );
    const port = readPort();
    // 已有 hub 在跑（比如命令行启动的）就直接连，退出时也不去杀它
    if (!(await healthy(port))) {
      startHub(port);
      const ok = await waitForHub(port, 30_000);
      if (!ok) {
        showError(`hub 启动失败（端口 ${port}）\n\n${hubLog.join("").slice(-3000)}`);
        return;
      }
    }
    createWindow(port);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("quit", () => {
    stopHub();
  });
}
