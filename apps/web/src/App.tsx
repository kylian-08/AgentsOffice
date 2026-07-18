import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AGENT_KIND_LABELS, SUPERVISOR_NAME } from "@agent-office/protocol";
import type {
  AgentCard,
  AgentMeta,
  KbDoc,
  LogEntry,
  OfficeBrief,
  OfficeTask,
} from "@agent-office/protocol";
import { api, type Health, type OfficeState, type TerminalPane } from "./api";

const STATUS_LABELS: Record<string, string> = {
  online: "在席",
  busy: "忙碌",
  offline: "离席",
};

const TASK_STATUS_LABELS: Record<string, string> = {
  open: "待认领",
  claimed: "已认领",
  in_progress: "进行中",
  done: "已完成",
  cancelled: "已取消",
};

const SOURCE_LABELS: Record<string, string> = {
  mcp: "主动发布",
  "cursor-hook": "Cursor 回帧",
  "codex-notify": "Codex 回帧",
  "claude-hook": "Claude 回帧",
  "codex-managed": "托管执行",
  "cursor-managed": "托管执行",
  "claude-managed": "托管执行",
};

/** 事件类型 → 时间线图标符号 */
const EVENT_ICONS: Record<string, string> = {
  join: "→",
  leave: "←",
  prompt: "▸",
  route: "@",
  brief: "报",
  task: "件",
  dispatch: "派",
  run: "⚙",
  "run-error": "!",
  stop: "·",
  turn: "·",
  rename: "✎",
  "inbox-read": "✓",
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function highlightMentions(text: string): React.ReactNode[] {
  const parts = text.split(/(@[\p{L}\p{N}_./-]+)/gu);
  return parts.map((part, i) =>
    part.startsWith("@") ? (
      <span key={i} className="mention">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

const meta = (agent: AgentCard): AgentMeta => agent.meta as AgentMeta;

/** 头像：取名字最有辨识度的一段，配合 kind 色环 */
function avatarText(name: string): string {
  const seg = name.split(/[-_.\s]/).filter(Boolean);
  const last = seg[seg.length - 1] ?? name;
  // 中文取首字，英文取前两个字母
  return /[\u4e00-\u9fff]/.test(last) ? last.slice(0, 1) : last.slice(0, 2).toUpperCase();
}

function Avatar({ agent, status }: { agent: Pick<AgentCard, "name" | "kind" | "meta">; status?: string }) {
  const svg = (agent.meta as AgentMeta).avatarSvg;
  return (
    <span className={`avatar kind-${agent.kind} ${status ? `st-${status}` : ""}`} aria-hidden>
      {svg ? <span className="avatar-art" dangerouslySetInnerHTML={{ __html: svg }} /> : avatarText(agent.name)}
    </span>
  );
}

// ---------- 老板称呼 ----------

function BossNameControl({ boss, onChanged }: { boss: AgentCard | undefined; onChanged: () => void }) {
  const [error, setError] = useState("");
  if (!boss) return null;
  const rename = async () => {
    const name = window.prompt("设置老板在办公室中的称呼", boss.name)?.trim();
    if (!name || name === boss.name) return;
    try {
      await api.updateAgent(boss.id, { name });
      setError("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="boss-control">
      <button className="ghost-btn" title="修改老板称呼" onClick={() => void rename()}>
        老板：{boss.name} · 修改称呼
      </button>
      {error && <span className="boss-error">{error}</span>}
    </div>
  );
}

// ---------- 工位卡片 ----------

function AgentBadge({
  agent,
  onMention,
  onChanged,
}: {
  agent: AgentCard;
  onMention: (name: string) => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.name);
  const [model, setModel] = useState(meta(agent).model ?? "");
  const [title, setTitle] = useState(meta(agent).title ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    try {
      await api.updateAgent(agent.id, { name: name.trim(), model, title });
      setEditing(false);
      setError("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const makeAvatar = async () => {
    setBusy(true);
    try {
      await api.generateAvatar(agent.id, title || undefined);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`确定移出员工「${agent.name}」吗？历史消息会保留，但该员工的会话、收件箱和终端记录将清除。`)) return;
    setBusy(true);
    try {
      await api.deleteAgent(agent.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const m = meta(agent);
  const inboxOnly = agent.kind === "cursor-ide" || agent.kind === "codex-cli" || agent.kind === "claude-cli";
  return (
    <div className={`badge status-${agent.status}`}>
      <div className="badge-top">
        <Avatar agent={agent} status={agent.status} />
        <div className="badge-id">
          {editing ? (
            <input
              className="badge-edit-name"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          ) : (
            <span className="badge-name" title={agent.name}>
              {agent.name}
            </span>
          )}
          <span className="badge-kind">
            {AGENT_KIND_LABELS[agent.kind] ?? agent.kind}
            {inboxOnly && (
              <span className="inbox-tag" title="收件箱模式：消息等对方下一轮主动读取">
                收件箱
              </span>
            )}
          </span>
        </div>
        {(agent.pendingCount ?? 0) > 0 && (
          <span className="pending-pill" title={`${agent.pendingCount} 条未读消息`}>
            {agent.pendingCount}
          </span>
        )}
      </div>

      {m.model && !editing && (
        <div className="badge-model" title={m.model}>
          {m.model}
        </div>
      )}

      {!editing && m.title && <div className="badge-title">职位：{m.title}</div>}

      {editing && (
        <div className="badge-edit">
          <input
            placeholder="模型备注（如 gpt-5.6-sol / opus-4.8）"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void save()}
          />
          {agent.kind !== "user" && (
            <input
              placeholder="职位（如 测试 / git 库管理）"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void save()}
            />
          )}
          {error && <div className="form-error">{error}</div>}
          <div className="form-actions">
            <button className="primary-btn sm" onClick={() => void save()}>
              保存
            </button>
            <button className="ghost-btn" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {agent.status !== "offline" && m.lastActivity && (
        <div className="badge-activity" title={m.lastActivity}>
          <span className="activity-dot" aria-hidden />
          {m.lastActivity}
        </div>
      )}
      {agent.workspace && (
        <div className="badge-workspace" title={agent.workspace}>
          {agent.workspace.split(/[\\/]/).slice(-2).join("/")}
        </div>
      )}

      {agent.kind !== "user" && agent.kind !== "supervisor" && (
        <div className="badge-stats">
          <span title="今日已用 token（仅托管执行可统计）">
            今日 {formatTokens(agent.todayTokens ?? 0)} tok
          </span>
          <span title="已完成任务数">完成 {agent.doneTasks ?? 0} 单</span>
        </div>
      )}

      <div className="badge-footer">
        <span className="badge-seen">
          {STATUS_LABELS[agent.status]} · {agent.lastSeenAt ? timeAgo(agent.lastSeenAt) : "—"}
        </span>
        <span className="badge-actions">
          <button
            className="icon-btn"
            title={agent.kind === "user" ? "设置老板称呼" : "调整员工资料"}
            onClick={() => {
              setEditing((v) => !v);
              setName(agent.name);
              setModel(m.model ?? "");
              setTitle(m.title ?? "");
            }}
          >
            ✎
          </button>
          {agent.kind !== "user" && agent.kind !== "supervisor" && (
            <button className="icon-btn" title="生成员工头像" disabled={busy} onClick={() => void makeAvatar()}>
              ◉
            </button>
          )}
          {agent.kind !== "user" && agent.kind !== "supervisor" && (
            <button className="icon-btn danger" title="移出员工" disabled={busy} onClick={() => void remove()}>
              ×
            </button>
          )}
          {agent.kind !== "user" && (
            <button className="ghost-btn" onClick={() => onMention(agent.name)}>
              @呼叫
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

// ---------- 新建托管工位 ----------

function NewAgentForm({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"codex" | "cursor" | "claude">("codex");
  const [workspace, setWorkspace] = useState("");
  const [model, setModel] = useState("");
  const [sandbox, setSandbox] = useState<"read-only" | "workspace-write">("read-only");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button className="add-desk" onClick={() => setOpen(true)}>
        ＋ 新建托管工位
      </button>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await api.createManagedAgent({
        name: name.trim(),
        kind,
        workspace: workspace.trim(),
        sandbox,
        model: model.trim() || undefined,
      });
      setOpen(false);
      setName("");
      setWorkspace("");
      setModel("");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="new-agent-form">
      <h4>新建托管工位</h4>
      <input
        placeholder="工号（如 codex-研发）"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
      />
      <select value={kind} onChange={(e) => setKind(e.target.value as any)}>
        <option value="codex">Codex 托管</option>
        <option value="claude">Claude 托管</option>
        <option value="cursor">Cursor 托管（需 API Key）</option>
      </select>
      <input
        placeholder="工作目录（可选）"
        value={workspace}
        onChange={(e) => setWorkspace(e.target.value)}
      />
      <input
        placeholder="模型备注（可选）"
        value={model}
        onChange={(e) => setModel(e.target.value)}
      />
      {kind !== "cursor" && (
        <select value={sandbox} onChange={(e) => setSandbox(e.target.value as any)}>
          <option value="read-only">只读沙箱（更安全）</option>
          <option value="workspace-write">可写工作区</option>
        </select>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button className="primary-btn sm" disabled={busy || !name.trim()} onClick={submit}>
          {busy ? "创建中…" : "创建"}
        </button>
        <button className="ghost-btn" onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
    </div>
  );
}

// ---------- 接入向导 ----------

const ONBOARD_TABS = [
  {
    id: "cursor",
    label: "Cursor",
    intro: "已有会话：把下面这句话直接发给那个 Cursor Agent（MCP 即时生效）：",
    prompt:
      "本机有 Agent Office 协作中枢（MCP 服务 agent-office）。请调用 register_agent 登记，工号自拟（如 cursor-前端），kind 填 cursor-ide；之后每轮开始先 read_inbox，完成工作后 publish_brief。",
    note: "新开的 Cursor 会话（任意项目）会自动登记，无需此步骤。",
  },
  {
    id: "codex",
    label: "Codex",
    intro: "已有终端：在那个 Codex 终端里直接输入（MCP 未加载时需先重启 Codex）：",
    prompt:
      "本机有 Agent Office 协作中枢（MCP 服务 agent_office）。请调用 register_agent 登记，工号自拟（如 codex-主力），kind 填 codex-cli；之后每轮开始先 read_inbox，完成工作后 publish_brief。",
    note: "新启动的 Codex 会话每轮结束会自动回帧简报，并从 ~/.codex/AGENTS.md 读到协作协议。",
  },
  {
    id: "claude",
    label: "Claude Code",
    intro: "已有会话：把下面这句话发给那个 Claude Code 会话：",
    prompt:
      "本机有 Agent Office 协作中枢（MCP 服务 agent-office）。请调用 register_agent 登记，工号自拟（如 claude-架构），kind 填 claude-cli；之后每轮开始先 read_inbox，完成工作后 publish_brief。",
    note: "新启动的 Claude Code 会话（任意目录）会自动登记。",
  },
] as const;

function OnboardModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<string>("cursor");
  const [copied, setCopied] = useState(false);
  const current = ONBOARD_TABS.find((t) => t.id === tab)!;

  const copy = async () => {
    await navigator.clipboard.writeText(current.prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="接入已有 Agent" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>把已有 Agent 加入办公室</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <nav className="tabs">
          {ONBOARD_TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "active" : ""}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="modal-body">
          <p>{current.intro}</p>
          <blockquote className="copy-block">{current.prompt}</blockquote>
          <button className="primary-btn" onClick={() => void copy()}>
            {copied ? "已复制 ✓" : "复制这句话"}
          </button>
          <p className="modal-note">{current.note}</p>
        </div>
      </div>
    </div>
  );
}

// ---------- 消息输入 ----------

function Composer({
  agents,
  prefill,
  onSent,
}: {
  agents: AgentCard[];
  prefill: string;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [hint, setHint] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (prefill) {
      setText((prev) => (prev.includes(prefill) ? prev : `${prefill} ${prev}`));
      inputRef.current?.focus();
    }
  }, [prefill]);

  const names = useMemo(
    () => agents.filter((a) => a.kind !== "user").map((a) => a.name),
    [agents],
  );

  const updateSuggestions = (value: string) => {
    const caretWord = value.slice(0, inputRef.current?.selectionStart ?? value.length);
    const match = caretWord.match(/@([\p{L}\p{N}_./-]*)$/u);
    if (!match) {
      setSuggestions([]);
      return;
    }
    const query = match[1].toLowerCase();
    const list = ["all", ...names].filter((n) => n.toLowerCase().startsWith(query)).slice(0, 6);
    setSuggestions(list);
    setSelected(0);
  };

  const applySuggestion = (name: string) => {
    const caret = inputRef.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([\p{L}\p{N}_./-]*)$/u, `@${name} `);
    setText(before + text.slice(caret));
    setSuggestions([]);
    inputRef.current?.focus();
  };

  const send = async () => {
    if (!text.trim()) return;
    try {
      const result = await api.sendMessage(text.trim());
      const managed = result.routed.filter((r) => r.mode === "managed").map((r) => r.name);
      const inbox = result.routed.filter((r) => r.mode === "inbox").map((r) => r.name);
      const supervisor = result.routed.some((r) => r.mode === "supervisor");
      const parts: string[] = [];
      if (supervisor) parts.push("主管已接单并自动分派");
      if (managed.length > 0) parts.push(`已唤醒 ${managed.join("、")}`);
      if (inbox.length > 0) parts.push(`已入 ${inbox.join("、")} 的收件箱（下轮读取）`);
      setHint({ text: parts.join("；") || "已发送", kind: "ok" });
      setText("");
      onSent();
      setTimeout(() => setHint(null), 5000);
    } catch (e) {
      setHint({ text: `发送失败：${e instanceof Error ? e.message : String(e)}`, kind: "err" });
    }
  };

  return (
    <div className="composer">
      {suggestions.length > 0 && (
        <ul className="suggestions" role="listbox">
          {suggestions.map((name, i) => (
            <li
              key={name}
              role="option"
              aria-selected={i === selected}
              className={i === selected ? "active" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                applySuggestion(name);
              }}
            >
              @{name}
            </li>
          ))}
        </ul>
      )}
      {hint && <div className={`composer-toast ${hint.kind}`}>{hint.text}</div>}
      <div className="composer-box">
        <textarea
          ref={inputRef}
          value={text}
          rows={2}
          placeholder="给办公室发消息：@工号 呼叫成员，@主管 自动分派，@all 全员……"
          onChange={(e) => {
            setText(e.target.value);
            updateSuggestions(e.target.value);
          }}
          onKeyDown={(e) => {
            if (suggestions.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((s) => (s + 1) % suggestions.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((s) => (s - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if (e.key === "Tab" || e.key === "Enter") {
                e.preventDefault();
                applySuggestion(suggestions[selected]);
                return;
              }
              if (e.key === "Escape") {
                setSuggestions([]);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          className="send-btn"
          onClick={() => void send()}
          disabled={!text.trim()}
          title="发送（Enter）"
        >
          发送
        </button>
      </div>
      <div className="composer-hint">Enter 发送 · Shift+Enter 换行 · @ 呼叫成员</div>
    </div>
  );
}

// ---------- 简报卡片 ----------

function BriefCard({ brief }: { brief: OfficeBrief }) {
  const [expanded, setExpanded] = useState(false);
  const long = brief.result.length > 200;
  const fields: Array<[string, string | null]> = [
    ["进展", brief.progress],
    ["决策", brief.decisions],
    ["产物", brief.artifacts],
    ["阻塞", brief.blockers],
    ["下一步", brief.nextSteps],
  ];
  return (
    <article className={`brief-card ${brief.kind}`}>
      <div className="brief-stamp" aria-hidden>
        报
      </div>
      <header>
        <strong>{brief.agentName}</strong>
        <span className="brief-source">{SOURCE_LABELS[brief.source] ?? brief.source}</span>
        <time>{timeAgo(brief.createdAt)}</time>
      </header>
      <h4>{brief.title}</h4>
      <p className="brief-result">
        {long && !expanded ? `${brief.result.slice(0, 200)}…` : brief.result}
      </p>
      {long && (
        <button className="link-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "收起" : "展开全文"}
        </button>
      )}
      {fields.some(([, v]) => v) && (
        <dl className="brief-fields">
          {fields.map(
            ([label, value]) =>
              value && (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ),
          )}
        </dl>
      )}
    </article>
  );
}

function BriefWall({ briefs }: { briefs: OfficeBrief[] }) {
  const [filter, setFilter] = useState("");
  const shown = filter ? briefs.filter((b) => b.agentName === filter) : briefs;
  const authors = useMemo(
    () => [...new Set(briefs.map((b) => b.agentName))],
    [briefs],
  );
  return (
    <section className="panel panel-briefs">
      <div className="panel-head">
        <h3>简报墙</h3>
        <select
          className="brief-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="按成员筛选简报"
        >
          <option value="">全部成员（{briefs.length}）</option>
          {authors.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div className="brief-wall">
        {shown.length === 0 && (
          <p className="empty">还没有简报。成员完成工作后会自动出现在这里。</p>
        )}
        {shown.map((brief) => (
          <BriefCard key={brief.id} brief={brief} />
        ))}
      </div>
    </section>
  );
}

// ---------- 分派工作（渐进披露） ----------

function DispatchForm({
  agents,
  onDone,
  onClose,
}: {
  agents: AgentCard[];
  onDone: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [hint, setHint] = useState("");
  const workers = agents.filter((a) => a.kind !== "user" && a.kind !== "supervisor");

  const toggle = (name: string) => {
    setChosen((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  };

  const submit = async () => {
    if (!title.trim()) return;
    try {
      const result = await api.dispatch({
        title: title.trim(),
        description: description.trim() || undefined,
        agents: chosen.length > 0 ? chosen : undefined,
      });
      setHint(`已分派给 ${result.assignedTo.join("、")}（${result.reason}）`);
      setTitle("");
      setDescription("");
      setChosen([]);
      onDone();
      setTimeout(() => {
        setHint("");
        onClose();
      }, 2500);
    } catch (e) {
      setHint(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="dispatch-form">
      <input
        placeholder="要做什么？一句话说清工作内容"
        value={title}
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        rows={2}
        placeholder="补充说明（可选）"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="dispatch-agents">
        <span className="dispatch-label">
          {chosen.length === 0 ? "不选成员 = 主管自动挑人" : `指定 ${chosen.length} 位成员：`}
        </span>
        <div className="dispatch-chips">
          {workers.map((a) => (
            <button
              key={a.id}
              className={`chip-toggle ${chosen.includes(a.name) ? "on" : ""} ${a.status === "offline" ? "off-agent" : ""}`}
              onClick={() => toggle(a.name)}
              title={`${AGENT_KIND_LABELS[a.kind]} · ${STATUS_LABELS[a.status]}`}
            >
              {a.name}
            </button>
          ))}
        </div>
      </div>
      {hint && <div className="dispatch-hint">{hint}</div>}
      <div className="form-actions">
        <button className="primary-btn sm" disabled={!title.trim()} onClick={() => void submit()}>
          {chosen.length > 0 ? `分派给 ${chosen.length} 位成员` : "交给主管分派"}
        </button>
        <button className="ghost-btn" onClick={onClose}>
          收起
        </button>
      </div>
    </div>
  );
}

// ---------- 任务面板 ----------

function TaskPanel({
  tasks,
  agents,
  onChanged,
}: {
  tasks: OfficeTask[];
  agents: AgentCard[];
  onChanged: () => void;
}) {
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const assignable = agents.filter((a) => a.kind !== "user" && a.kind !== "supervisor");
  const active = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const closed = tasks.filter((t) => t.status === "done" || t.status === "cancelled");

  const renderTask = (task: OfficeTask) => (
    <li key={task.id} className={`task task-${task.status}`}>
      <div className="task-main">
        <span className="task-title">{task.title}</span>
        <span className={`task-status s-${task.status}`}>
          {TASK_STATUS_LABELS[task.status]}
        </span>
      </div>
      <div className="task-meta">
        <select
          value={task.assigneeName ?? ""}
          onChange={(e) =>
            api.updateTask(task.id, { assignee: e.target.value || null }).then(onChanged)
          }
        >
          <option value="">未分派</option>
          {assignable.map((a) => (
            <option key={a.id} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          value={task.status}
          onChange={(e) => api.updateTask(task.id, { status: e.target.value }).then(onChanged)}
        >
          {Object.entries(TASK_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
    </li>
  );

  return (
    <section className="panel panel-tasks">
      <div className="panel-head">
        <h3>任务看板</h3>
        {!dispatchOpen && (
          <button className="dispatch-btn" onClick={() => setDispatchOpen(true)}>
            <span className="supervisor-mark" aria-hidden>
              主管
            </span>
            分派工作
          </button>
        )}
      </div>
      {dispatchOpen && (
        <DispatchForm agents={agents} onDone={onChanged} onClose={() => setDispatchOpen(false)} />
      )}
      <ul className="task-list">
        {tasks.length === 0 && <li className="empty">暂无任务。点「分派工作」交给主管拆解。</li>}
        {active.map(renderTask)}
        {closed.length > 0 && <li className="task-divider">已结束（{closed.length}）</li>}
        {closed.slice(0, 10).map(renderTask)}
      </ul>
    </section>
  );
}

// ---------- 实时工作台 ----------

function LiveBoard({ state }: { state: OfficeState }) {
  const workers = state.agents.filter((a) => a.kind !== "user" && a.kind !== "supervisor");
  const activeTasks = state.tasks.filter(
    (t) => t.status === "claimed" || t.status === "in_progress",
  );
  const busyCount = workers.filter((a) => a.status === "busy").length;
  return (
    <div className="live-wrap">
      <div className="live-summary">
        <span>
          {workers.length} 位成员 · <em className="busy-count">{busyCount}</em> 位工作中
        </span>
      </div>
      <div className="live-board">
        {workers.length === 0 && (
          <p className="empty">还没有成员入驻，先从右上角「接入 Agent」开始。</p>
        )}
        {workers.map((agent) => {
          const m = meta(agent);
          const task = activeTasks.find((t) => t.assigneeAgentId === agent.id);
          const latestBrief = state.briefs.find((b) => b.agentId === agent.id);
          const activityStale =
            m.lastActivityAt && Date.now() - m.lastActivityAt > 10 * 60_000;
          return (
            <article key={agent.id} className={`live-card status-${agent.status}`}>
              <header>
                <Avatar agent={agent} status={agent.status} />
                <div className="live-id">
                  <strong>{agent.name}</strong>
                  <span className="live-kind">
                    {AGENT_KIND_LABELS[agent.kind]}
                    {m.model ? ` · ${m.model}` : ""}
                  </span>
                </div>
                <span className={`live-status st-${agent.status}`}>
                  {STATUS_LABELS[agent.status]}
                </span>
              </header>
              <div className="live-now">
                {agent.status === "offline" ? (
                  <span className="live-idle">离席</span>
                ) : m.lastActivity ? (
                  <span className={`live-doing ${activityStale ? "live-stale" : ""}`}>
                    {agent.status === "busy" && <span className="activity-dot" aria-hidden />}
                    {m.lastActivity}
                    {m.lastActivityAt && <time> · {timeAgo(m.lastActivityAt)}</time>}
                  </span>
                ) : (
                  <span className="live-idle">空闲，等待分派</span>
                )}
              </div>
              <dl className="live-facts">
                {task && (
                  <div>
                    <dt>任务</dt>
                    <dd>
                      {task.title}（{TASK_STATUS_LABELS[task.status]}）
                    </dd>
                  </div>
                )}
                <div>
                  <dt>简报</dt>
                  <dd>
                    {latestBrief ? (
                      <span title={latestBrief.result}>
                        {latestBrief.title} <time>· {timeAgo(latestBrief.createdAt)}</time>
                      </span>
                    ) : (
                      <span className="live-idle">尚无</span>
                    )}
                  </dd>
                </div>
              </dl>
              {(agent.pendingCount ?? 0) > 0 && (
                <div className="live-pending">{agent.pendingCount} 条未读待处理</div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

// ---------- 终端管理 ----------

function TerminalBoard({ refreshKey }: { refreshKey: number }) {
  const [agents, setAgents] = useState<TerminalPane[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api.terminals().then(({ agents: panes }) => {
      setAgents(panes);
      setSelected((current) => (panes.some((pane) => pane.id === current) ? current : (panes[0]?.id ?? "")));
      setError("");
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 1500);
    return () => window.clearInterval(timer);
  }, [load, refreshKey]);

  const current = agents.find((pane) => pane.id === selected);
  return (
    <div className="terminal-wrap">
      <aside className="terminal-list">
        <div className="terminal-list-head">
          <strong>托管终端</strong>
          <button className="icon-btn" title="刷新终端" onClick={load}>↻</button>
        </div>
        {agents.length === 0 && <p className="empty">暂无托管工位。创建托管 Agent 后，终端输出会实时出现在这里。</p>}
        {agents.map((pane) => (
          <button key={pane.id} className={`terminal-agent ${pane.id === selected ? "active" : ""}`} onClick={() => setSelected(pane.id)}>
            <span><b>{pane.name}</b><small>{AGENT_KIND_LABELS[pane.kind as keyof typeof AGENT_KIND_LABELS] ?? pane.kind}</small></span>
            <em className={`term-status ${pane.status}`}>{STATUS_LABELS[pane.status] ?? pane.status}</em>
          </button>
        ))}
      </aside>
      <section className="terminal-screen">
        <header>
          <div>
            <strong>{current?.name ?? "选择一个托管工位"}</strong>
            {current && <span>{current.lines.length} 条实时输出</span>}
          </div>
          {current?.status === "busy" && <button className="danger-btn" onClick={() => api.stopAgent(current.id).then(load).catch((e) => setError(e.message))}>终止执行</button>}
        </header>
        {error && <p className="form-error">{error}</p>}
        <div className="terminal-output" role="log" aria-live="polite">
          {!current && <p>从左侧选择员工查看终端。</p>}
          {current && current.lines.length === 0 && <p>等待终端输出…</p>}
          {current?.lines.map((line, index) => <div key={`${line.at}-${index}`} className={`term-line term-${line.kind}`}><time>{clockTime(line.at)}</time><code>{line.text}</code></div>)}
        </div>
      </section>
    </div>
  );
}

// ---------- 动态流 ----------

function Feed({ state }: { state: OfficeState }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [hasNew, setHasNew] = useState(false);

  const bossName = useMemo(
    () => state.agents.find((a) => a.kind === "user")?.name ?? "老板",
    [state.agents],
  );

  const items = useMemo(() => {
    const list: Array<{ key: string; at: number; node: React.ReactNode }> = [];
    for (const m of state.messages) {
      const own = m.fromName === bossName;
      const fromAgent = state.agents.find((a) => a.name === m.fromName);
      list.push({
        key: `m-${m.id}`,
        at: m.createdAt,
        node: (
          <div className={`msg ${own ? "own" : ""} ${m.fromName === SUPERVISOR_NAME ? "from-supervisor" : ""}`}>
            {!own && (
              <Avatar agent={fromAgent ?? { name: m.fromName, kind: "user", meta: {} }} />
            )}
            <div className="msg-body">
              <div className="msg-head">
                <strong>{m.fromName}</strong>
                <time>{clockTime(m.createdAt)}</time>
              </div>
              <div className="msg-bubble">{highlightMentions(m.text)}</div>
              {m.deliveries.length > 0 && (
                <div className="msg-deliveries">
                  {m.deliveries.map((d) => (
                    <span key={d.toName} className={`delivery ${d.status}`}>
                      {d.toName}
                      {d.status === "read" ? " ✓" : " …"}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ),
      });
    }
    for (const e of state.events) {
      list.push({
        key: `e-${e.id}`,
        at: e.createdAt,
        node: (
          <div className={`evt evt-${e.type}`}>
            <span className="evt-icon" aria-hidden>
              {EVENT_ICONS[e.type] ?? "·"}
            </span>
            <span className="evt-text">
              {e.agentName ? <strong>{e.agentName}</strong> : null}
              {e.agentName ? " " : ""}
              {e.text ?? e.type}
            </span>
            <time>{clockTime(e.createdAt)}</time>
          </div>
        ),
      });
    }
    return list.sort((a, b) => a.at - b.at).slice(-150);
  }, [state, bossName]);

  // 智能滚动：贴底时跟随新消息；用户上翻时不打扰，改为「回到最新」提示
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setHasNew(false);
    } else {
      setHasNew(true);
    }
  }, [items.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    atBottomRef.current = atBottom;
    if (atBottom) setHasNew(false);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setHasNew(false);
  };

  return (
    <div className="feed-wrap">
      <div className="feed" role="log" ref={scrollRef} onScroll={onScroll}>
        {items.length === 0 && (
          <p className="empty">还没有动态。在下方发一条消息，@成员 开始协作。</p>
        )}
        {items.map((item) => (
          <div key={item.key}>{item.node}</div>
        ))}
      </div>
      {hasNew && (
        <button className="jump-latest" onClick={jumpToLatest}>
          ↓ 有新动态
        </button>
      )}
    </div>
  );
}

// ---------- 日志页 ----------

const LOG_SOURCES: Array<{ id: string; label: string }> = [
  { id: "", label: "全部" },
  { id: "message", label: "消息" },
  { id: "event", label: "事件" },
  { id: "brief", label: "简报" },
  { id: "terminal", label: "终端" },
  { id: "kb", label: "知识库" },
];

function LogsBoard() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [source, setSource] = useState("");
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    api.logs({ limit: 500 }).then(({ logs: initial }) => setLogs(initial)).catch(() => {});
    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      if (pausedRef.current) return;
      try {
        const event = JSON.parse(e.data);
        if (event?.type === "log" && event.payload) {
          setLogs((prev) => [...prev.slice(-1999), event.payload as LogEntry]);
        }
      } catch {
        /* 忽略坏帧 */
      }
    };
    return () => es.close();
  }, []);

  const filtered = source ? logs.filter((l) => l.source === source) : logs;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && !paused) el.scrollTop = el.scrollHeight;
  }, [filtered.length, paused]);

  return (
    <div className="logs-wrap">
      <header className="logs-toolbar">
        <div className="logs-filters" role="tablist">
          {LOG_SOURCES.map((s) => (
            <button
              key={s.id}
              className={source === s.id ? "active" : ""}
              onClick={() => setSource(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="logs-actions">
          <span className="logs-count">{filtered.length} 条</span>
          <button className="ghost-btn" onClick={() => setPaused((v) => !v)}>
            {paused ? "▶ 继续滚动" : "⏸ 暂停滚动"}
          </button>
        </div>
      </header>
      <div className="logs-screen" role="log" aria-live="polite" ref={scrollRef}>
        {filtered.length === 0 && <p className="empty">暂无日志。办公室里的消息、事件、简报、终端输出都会实时出现在这里。</p>}
        {filtered.map((log, index) => (
          <div key={`${log.at}-${index}`} className={`log-line level-${log.level}`}>
            <time>{clockTime(log.at)}</time>
            <em className={`log-source src-${log.source}`}>{LOG_SOURCES.find((s) => s.id === log.source)?.label ?? log.source}</em>
            {log.agentName && <strong>{log.agentName}</strong>}
            <span>{log.text}</span>
          </div>
        ))}
      </div>
      <p className="logs-hint">
        本页数据同样开放给所有 Agent：MCP 工具 <code>read_logs</code> 或 <code>GET /api/logs</code>（支持 limit / since / source 参数）。
      </p>
    </div>
  );
}

// ---------- 知识库页 ----------

type KbCatalog = Array<{
  category: string;
  docs: Array<{ id: string; title: string; tags: string[]; updatedAt: number }>;
}>;

function KbBoard({ refreshKey }: { refreshKey: number }) {
  const [catalog, setCatalog] = useState<KbCatalog>([]);
  const [selectedId, setSelectedId] = useState("");
  const [doc, setDoc] = useState<KbDoc | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KbDoc[] | null>(null);
  const [editing, setEditing] = useState<null | { id?: string; category: string; title: string; content: string; tags: string }>(null);
  const [error, setError] = useState("");

  const loadCatalog = useCallback(() => {
    api.kbCatalog().then(({ catalog: c }) => setCatalog(c)).catch((e) => setError(e.message));
  }, []);

  useEffect(loadCatalog, [loadCatalog, refreshKey]);

  useEffect(() => {
    if (!selectedId) {
      setDoc(null);
      return;
    }
    api.kbDoc(selectedId).then(setDoc).catch(() => setDoc(null));
  }, [selectedId]);

  const search = async () => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    try {
      const { docs } = await api.kbSearch(query.trim());
      setResults(docs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    if (!editing) return;
    const tags = editing.tags.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean);
    try {
      if (editing.id) {
        const updated = await api.kbUpdate(editing.id, {
          category: editing.category,
          title: editing.title,
          content: editing.content,
          tags,
        });
        setSelectedId(updated.id);
        setDoc(updated);
      } else {
        const created = await api.kbCreate({
          category: editing.category,
          title: editing.title,
          content: editing.content,
          tags,
        });
        setSelectedId(created.id);
      }
      setEditing(null);
      setError("");
      loadCatalog();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("确定删除这篇知识库文档吗？")) return;
    try {
      await api.kbDelete(id);
      if (selectedId === id) setSelectedId("");
      loadCatalog();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const totalDocs = catalog.reduce((sum, c) => sum + c.docs.length, 0);

  return (
    <div className="kb-wrap">
      <aside className="kb-sidebar">
        <div className="kb-search">
          <input
            placeholder="搜索疑难杂症 / 解决方案…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void search()}
          />
          {results !== null && (
            <button className="ghost-btn sm" onClick={() => { setResults(null); setQuery(""); }}>
              清除
            </button>
          )}
        </div>
        <button
          className="primary-btn kb-new"
          onClick={() => setEditing({ category: "", title: "", content: "", tags: "" })}
        >
          ＋ 新建文档
        </button>
        {results !== null ? (
          <div className="kb-tree">
            <div className="kb-cat-head">搜索结果（{results.length}）</div>
            {results.map((d) => (
              <button
                key={d.id}
                className={`kb-doc ${d.id === selectedId ? "active" : ""}`}
                onClick={() => setSelectedId(d.id)}
              >
                <span>{d.title}</span>
                <small>{d.category}</small>
              </button>
            ))}
            {results.length === 0 && <p className="empty">没有匹配的文档。</p>}
          </div>
        ) : (
          <div className="kb-tree">
            {catalog.length === 0 && (
              <p className="empty">
                知识库还是空的。把遇到的疑难杂症和解决方案沉淀进来，全办公室共享；Agent 也能通过 kb_write 自动写入。
              </p>
            )}
            {catalog.map((cat) => (
              <div key={cat.category} className="kb-cat">
                <div className="kb-cat-head">
                  {cat.category}
                  <small>{cat.docs.length}</small>
                </div>
                {cat.docs.map((d) => (
                  <button
                    key={d.id}
                    className={`kb-doc ${d.id === selectedId ? "active" : ""}`}
                    onClick={() => setSelectedId(d.id)}
                  >
                    <span>{d.title}</span>
                    {d.tags.length > 0 && <small>{d.tags.join(" · ")}</small>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        <p className="kb-stat">{totalDocs} 篇文档 · {catalog.length} 个目录</p>
      </aside>

      <section className="kb-main">
        {error && <p className="form-error">{error}</p>}
        {editing ? (
          <div className="kb-editor">
            <h3>{editing.id ? "编辑文档" : "新建知识库文档"}</h3>
            <div className="kb-editor-row">
              <input
                placeholder="目录分类（如 构建打包 / 网络代理 / Windows 环境）"
                value={editing.category}
                list="kb-categories"
                onChange={(e) => setEditing({ ...editing, category: e.target.value })}
              />
              <datalist id="kb-categories">
                {catalog.map((c) => (
                  <option key={c.category} value={c.category} />
                ))}
              </datalist>
              <input
                placeholder="标签（逗号分隔，可选）"
                value={editing.tags}
                onChange={(e) => setEditing({ ...editing, tags: e.target.value })}
              />
            </div>
            <input
              placeholder="标题：一句话概括问题"
              value={editing.title}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
            />
            <textarea
              placeholder={"建议结构：\n【问题现象】\n【根因】\n【解决步骤】\n【验证方式】"}
              rows={16}
              value={editing.content}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
            />
            <div className="form-actions">
              <button
                className="primary-btn"
                disabled={!editing.category.trim() || !editing.title.trim() || !editing.content.trim()}
                onClick={() => void save()}
              >
                保存
              </button>
              <button className="ghost-btn" onClick={() => setEditing(null)}>
                取消
              </button>
            </div>
          </div>
        ) : doc ? (
          <article className="kb-article">
            <header>
              <div>
                <span className="kb-crumb">{doc.category}</span>
                <h2>{doc.title}</h2>
                <p className="kb-meta">
                  {doc.author ? `${doc.author} · ` : ""}更新于 {timeAgo(doc.updatedAt)}
                  {doc.tags.length > 0 && <> · {doc.tags.map((t) => <span key={t} className="kb-tag">{t}</span>)}</>}
                </p>
              </div>
              <div className="kb-article-actions">
                <button
                  className="ghost-btn sm"
                  onClick={() =>
                    setEditing({
                      id: doc.id,
                      category: doc.category,
                      title: doc.title,
                      content: doc.content,
                      tags: doc.tags.join(", "),
                    })
                  }
                >
                  编辑
                </button>
                <button className="ghost-btn sm danger" onClick={() => void remove(doc.id)}>
                  删除
                </button>
              </div>
            </header>
            <pre className="kb-content">{doc.content}</pre>
          </article>
        ) : (
          <div className="kb-placeholder">
            <p>从左侧目录选择文档，或新建一篇。</p>
            <p className="kb-placeholder-sub">
              所有 Agent 都能读写这里：MCP 工具 <code>kb_list</code> / <code>kb_search</code> / <code>kb_read</code> / <code>kb_write</code>。
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------- 主应用 ----------

export function App() {
  const [state, setState] = useState<OfficeState | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [mentionPrefill, setMentionPrefill] = useState("");
  const [view, setView] = useState<"office" | "live" | "terminal" | "logs" | "kb">("office");
  const [onboardOpen, setOnboardOpen] = useState(false);
  const refreshTimer = useRef<number | null>(null);

  const refresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      api.state().then(setState).catch(() => {});
    }, 300);
  }, []);

  useEffect(() => {
    api.state().then(setState).catch(() => {});
    api.health().then(setHealth).catch(() => {});
    const source = new EventSource("/api/events");
    source.onmessage = () => refresh();
    const healthTimer = window.setInterval(() => {
      api.health().then(setHealth).catch(() => setHealth(null));
    }, 30_000);
    const stateTimer = window.setInterval(refresh, 15_000);
    return () => {
      source.close();
      window.clearInterval(healthTimer);
      window.clearInterval(stateTimer);
    };
  }, [refresh]);

  if (!state) {
    return (
      <div className="loading">
        <div className="brand-mark big" aria-hidden>
          办
        </div>
        <p>正在连接办公室中枢……</p>
        <p className="loading-sub">
          如果一直停在这里，请先启动中枢：<code>agent-office\启动办公室.bat</code>
        </p>
      </div>
    );
  }

  const boss = state.agents.find((a) => a.kind === "user");
  const agents = state.agents.filter((a) => a.kind !== "user");
  const deskAgents = agents.filter((a) => a.kind !== "supervisor");
  const onlineCount = deskAgents.filter((a) => a.status !== "offline").length;

  const systemChips = [
    { label: "中枢", ok: Boolean(health), detail: health ? "在线" : "离线" },
    { label: "Codex", ok: Boolean(health?.codexCli), detail: health?.codexCli ? "可用" : "未检测到" },
    { label: "Claude", ok: Boolean(health?.claudeCli), detail: health?.claudeCli ? "可用" : "未检测到" },
    { label: "Cursor Key", ok: Boolean(health?.cursorKey), detail: health?.cursorKey ? "已配置" : "未配置" },
  ];

  return (
    <div className="office">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            办
          </span>
          <div>
            <h1>Agent 办公室</h1>
            <p>
              {deskAgents.length} 位成员 · {onlineCount} 在席
            </p>
          </div>
        </div>
        <nav className="view-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={view === "office"}
            className={view === "office" ? "active" : ""}
            onClick={() => setView("office")}
          >
            办公室
          </button>
          <button
            role="tab"
            aria-selected={view === "live"}
            className={view === "live" ? "active" : ""}
            onClick={() => setView("live")}
          >
            实时工作台
          </button>
          <button
            role="tab"
            aria-selected={view === "terminal"}
            className={view === "terminal" ? "active" : ""}
            onClick={() => setView("terminal")}
          >
            终端管理
          </button>
          <button
            role="tab"
            aria-selected={view === "logs"}
            className={view === "logs" ? "active" : ""}
            onClick={() => setView("logs")}
          >
            日志
          </button>
          <button
            role="tab"
            aria-selected={view === "kb"}
            className={view === "kb" ? "active" : ""}
            onClick={() => setView("kb")}
          >
            知识库
          </button>
        </nav>
        <div className="topbar-right">
          <div className="health" aria-label="系统状态">
            {systemChips.map((c) => (
              <span
                key={c.label}
                className={`sys-dot ${c.ok ? "ok" : "bad"}`}
                title={`${c.label}：${c.detail}`}
              >
                {c.label}
              </span>
            ))}
          </div>
          <BossNameControl boss={boss} onChanged={refresh} />
          <button className="primary-btn onboard-btn" onClick={() => setOnboardOpen(true)}>
            ＋ 接入 Agent
          </button>
        </div>
      </header>

      {view === "live" ? (
        <main className="live-main">
          <LiveBoard state={state} />
        </main>
      ) : view === "terminal" ? (
        <main className="terminal-main">
          <TerminalBoard refreshKey={state.events.length} />
        </main>
      ) : view === "logs" ? (
        <main className="logs-main">
          <LogsBoard />
        </main>
      ) : view === "kb" ? (
        <main className="kb-page">
          <KbBoard refreshKey={state.events.length} />
        </main>
      ) : (
        <main className="layout">
          <aside className="col col-roster">
            <section className="panel">
              <div className="panel-head">
                <h3>工位</h3>
                <span className="panel-count">
                  {onlineCount}/{deskAgents.length}
                </span>
              </div>
              <div className="badges">
                {deskAgents.length === 0 && (
                  <p className="empty">
                    还没有成员入驻。点右上角「接入 Agent」，或在下方新建托管工位。
                  </p>
                )}
                {deskAgents.map((agent) => (
                  <AgentBadge
                    key={agent.id}
                    agent={agent}
                    onMention={(name) => setMentionPrefill(`@${name}`)}
                    onChanged={refresh}
                  />
                ))}
              </div>
              <NewAgentForm onDone={refresh} />
            </section>
          </aside>

          <section className="col col-center">
            <Feed state={state} />
            <Composer agents={state.agents} prefill={mentionPrefill} onSent={refresh} />
          </section>

          <aside className="col col-right">
            <BriefWall briefs={state.briefs} />
            <TaskPanel tasks={state.tasks} agents={state.agents} onChanged={refresh} />
          </aside>
        </main>
      )}

      {onboardOpen && <OnboardModal onClose={() => setOnboardOpen(false)} />}
    </div>
  );
}
