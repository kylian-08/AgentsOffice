// 应用内 Windows 终端：xterm.js 前端 + hub 的 ConPTY 会话（WebSocket 双向流）
import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api, shellTermSocket, type ShellTermInfo } from "./api";

const XTERM_THEME = {
  background: "#0d1017",
  foreground: "#d8dee9",
  cursor: "#7aa2f7",
  selectionBackground: "#33415e",
};

/** 文件夹选择弹窗：走 hub 的目录浏览接口，网页版与桌面版通用 */
export function FolderPicker({
  initial,
  onPick,
  onClose,
}: {
  initial?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [dirs, setDirs] = useState<Array<{ name: string; path: string }>>([]);
  const [home, setHome] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (target?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.fsDirs(target);
      setPath(res.path);
      setParent(res.parent);
      setDirs(res.dirs);
      setHome(res.home);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(initial?.trim() || undefined);
  }, [load, initial]);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal folder-picker" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>选择启动目录</h3>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="picker-path" title={path ?? "选择磁盘"}>
          {path ?? "选择磁盘"}
        </div>
        <div className="picker-quick">
          <button onClick={() => void load()}>💾 磁盘</button>
          <button onClick={() => void load(home)} disabled={!home}>
            🏠 主目录
          </button>
          {parent && <button onClick={() => void load(parent)}>↑ 上一级</button>}
        </div>
        {error && <div className="shell-error picker-error">{error}</div>}
        <div className="picker-list">
          {loading ? (
            <div className="picker-hint">读取中…</div>
          ) : dirs.length === 0 ? (
            <div className="picker-hint">（没有子文件夹）</div>
          ) : (
            dirs.map((d) => (
              <button key={d.path} className="picker-dir" onClick={() => void load(d.path)}>
                📁 {d.name}
              </button>
            ))
          )}
        </div>
        <div className="picker-foot">
          <button className="ghost-btn" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-btn"
            disabled={!path}
            onClick={() => {
              if (path) {
                onPick(path);
                onClose();
              }
            }}
          >
            就选这里
          </button>
        </div>
      </div>
    </div>
  );
}

function XtermPane({ term }: { term: ShellTermInfo }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const xterm = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
      theme: XTERM_THEME,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(host);
    fit.fit();

    const ws = shellTermSocket(term.id);
    let closed = false;

    // 剪贴板体验对齐外部终端：
    // Ctrl+V / 右键空白处 = 粘贴；Ctrl+C 有选中 = 复制（无选中仍是中断信号）；右键选中 = 复制
    const pasteFromClipboard = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          xterm.paste(text); // 走括号粘贴，codex/claude 会当作整段文本
        } else if (ws.readyState === WebSocket.OPEN) {
          // 剪贴板里不是文本（可能是截图）：把 Ctrl+V 原样交给 CLI，
          // codex 等程序会自己读系统剪贴板取图
          ws.send(JSON.stringify({ type: "in", data: "\x16" }));
        }
      } catch {
        xterm.write("\r\n\x1b[33m[无法读取剪贴板，请检查浏览器剪贴板权限]\x1b[0m\r\n");
      }
    };
    xterm.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const mod = ev.ctrlKey && !ev.altKey;
      if (mod && ev.key.toLowerCase() === "v") {
        void pasteFromClipboard();
        return false;
      }
      if (mod && ev.key.toLowerCase() === "c" && xterm.hasSelection()) {
        void navigator.clipboard.writeText(xterm.getSelection());
        xterm.clearSelection();
        return false;
      }
      return true;
    });
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (xterm.hasSelection()) {
        void navigator.clipboard.writeText(xterm.getSelection());
        xterm.clearSelection();
      } else {
        void pasteFromClipboard();
      }
    };
    host.addEventListener("contextmenu", onContextMenu);

    ws.onopen = () => {
      fit.fit();
      ws.send(JSON.stringify({ type: "resize", cols: xterm.cols, rows: xterm.rows }));
      xterm.focus();
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          type: string;
          data?: string;
          code?: number;
          message?: string;
        };
        if (msg.type === "out" && msg.data) xterm.write(msg.data);
        else if (msg.type === "exit") {
          xterm.write(`\r\n\x1b[90m[进程已退出，退出码 ${msg.code ?? 0}]\x1b[0m\r\n`);
        } else if (msg.type === "error") {
          xterm.write(`\r\n\x1b[31m[${msg.message ?? "连接错误"}]\x1b[0m\r\n`);
        }
      } catch {
        /* 忽略坏帧 */
      }
    };
    ws.onclose = () => {
      if (!closed) xterm.write("\r\n\x1b[90m[连接已断开]\x1b[0m\r\n");
    };
    const dataSub = xterm.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "in", data }));
    });

    const observer = new ResizeObserver(() => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: xterm.cols, rows: xterm.rows }));
      }
    });
    observer.observe(host);

    return () => {
      closed = true;
      observer.disconnect();
      host.removeEventListener("contextmenu", onContextMenu);
      dataSub.dispose();
      ws.close();
      xterm.dispose();
    };
  }, [term.id]);

  return <div className="shell-xterm" ref={hostRef} />;
}

export function ShellBoard() {
  const [terms, setTerms] = useState<ShellTermInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [shell, setShell] = useState("powershell");
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const refresh = useCallback(async () => {
    const { terminals } = await api.shellTerms();
    setTerms(terminals);
    setActiveId((cur) => {
      if (cur && terminals.some((t) => t.id === cur)) return cur;
      return terminals.at(-1)?.id ?? null;
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const isAgent = shell === "codex" || shell === "claude";
      const info = await api.shellTermCreate({
        shell: isAgent ? "powershell" : shell,
        command: isAgent ? (shell as "codex" | "claude") : undefined,
        cwd: cwd.trim() || undefined,
      });
      setTerms((prev) => [...prev, info]);
      setActiveId(info.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const close = async (id: string) => {
    try {
      await api.shellTermClose(id);
    } catch {
      /* 已经没了也无妨 */
    }
    setTerms((prev) => prev.filter((t) => t.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
    void refresh();
  };

  const active = terms.find((t) => t.id === activeId) ?? null;

  return (
    <div className="shell-board">
      <div className="shell-toolbar">
        <div className="shell-tabs" role="tablist">
          {terms.map((t) => (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === activeId}
              className={`shell-tab ${t.id === activeId ? "active" : ""} ${t.alive ? "" : "dead"}`}
              onClick={() => setActiveId(t.id)}
              title={`${t.shell} · ${t.cwd}`}
            >
              <span className={`shell-dot ${t.alive ? "on" : "off"}`} aria-hidden />
              {t.title}
              <button
                className="shell-tab-close"
                title="关闭终端"
                onClick={(e) => {
                  e.stopPropagation();
                  void close(t.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="shell-new">
          <select value={shell} onChange={(e) => setShell(e.target.value)} title="选择终端类型">
            <option value="powershell">PowerShell</option>
            <option value="cmd">CMD</option>
            <option value="pwsh">pwsh 7</option>
            <option value="codex">Codex 工位（自动入驻办公室）</option>
            <option value="claude">Claude 工位（自动入驻办公室）</option>
          </select>
          <input
            placeholder="启动目录（留空 = 用户主目录）"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
          />
          <button className="ghost-btn" title="浏览文件夹" onClick={() => setPickerOpen(true)}>
            📁 浏览
          </button>
          <button className="primary-btn" onClick={() => void create()} disabled={creating}>
            {creating ? "启动中…" : "＋ 新终端"}
          </button>
        </div>
      </div>
      {error && <div className="shell-error">{error}</div>}
      {pickerOpen && (
        <FolderPicker initial={cwd} onPick={setCwd} onClose={() => setPickerOpen(false)} />
      )}
      {active ? (
        <XtermPane key={active.id} term={active} />
      ) : (
        <div className="shell-empty">
          <p>还没有打开的终端</p>
          <p className="muted">点右上角「＋ 新终端」开一个 PowerShell / CMD，直接在应用里干活。</p>
        </div>
      )}
    </div>
  );
}
