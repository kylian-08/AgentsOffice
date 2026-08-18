import {
  lazy,
  Suspense,
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
  OfficeGroup,
  OfficeRole,
  OfficeTask,
  RoleDossier,
} from "@agent-office/protocol";
import { api, type Health, type OfficeState, type TerminalPane } from "./api";
import {
  buildMessageFeedback,
  selectWorkers,
  sortTerminalsForAction,
  sortWorkersForAction,
  visibleTerminals,
} from "./operability";

const ShellBoard = lazy(() =>
  import("./ShellBoard").then((module) => ({ default: module.ShellBoard })),
);
const PixelOffice = lazy(() =>
  import("./PixelOffice").then((module) => ({ default: module.PixelOffice })),
);

const STATUS_LABELS: Record<string, string> = {
  online: "在席",
  busy: "忙碌",
  offline: "离席",
  archived: "已离职",
};

const TASK_STATUS_LABELS: Record<string, string> = {
  open: "待认领",
  claimed: "已认领",
  in_progress: "进行中",
  review: "待验收",
  blocked: "已阻塞",
  done: "已完成",
  cancelled: "已取消",
};

/** 工位按部门分组；无部门的人归入「未入部门」 */
function groupRosterByDepartment(
  agents: AgentCard[],
  groups: OfficeGroup[],
): Array<{ id: string; name: string; agents: AgentCard[] }> {
  const buckets = new Map<string, AgentCard[]>();
  const unassigned: AgentCard[] = [];
  for (const agent of agents) {
    const deptId = agent.groupIds?.[0];
    if (!deptId) {
      unassigned.push(agent);
      continue;
    }
    const list = buckets.get(deptId) ?? [];
    list.push(agent);
    buckets.set(deptId, list);
  }
  const sections: Array<{ id: string; name: string; agents: AgentCard[] }> = [];
  for (const group of groups) {
    const members = buckets.get(group.id);
    if (members && members.length > 0) {
      sections.push({ id: group.id, name: group.name, agents: members });
      buckets.delete(group.id);
    }
  }
  // 孤儿 groupId（部门已删）
  for (const [id, members] of buckets) {
    sections.push({ id, name: "未知部门", agents: members });
  }
  if (unassigned.length > 0) {
    sections.push({ id: "_none", name: "未入部门", agents: unassigned });
  }
  return sections;
}

const SOURCE_LABELS: Record<string, string> = {
  mcp: "主动发布",
  "cursor-hook": "Cursor 回帧",
  "codex-notify": "Codex 回帧",
  "claude-hook": "Claude 回帧",
  "zcode-hook": "ZCode 回帧",
  "opencode-hook": "OpenCode 回帧",
  "kimi-hook": "Kimi 回帧",
  "qoder-hook": "Qoder 回帧",
  "codex-managed": "托管执行",
  "cursor-managed": "托管执行",
  "claude-managed": "托管执行",
  handoff: "任务交接",
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
  handoff: "接",
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
  const m = agent.meta as AgentMeta;
  return (
    <span className={`avatar kind-${agent.kind} ${status ? `st-${status}` : ""}`} aria-hidden>
      {m.spriteUrl ? (
        <img className="avatar-img" src={m.spriteUrl} alt={agent.name} />
      ) : m.avatarSvg ? (
        <span className="avatar-art" dangerouslySetInnerHTML={{ __html: m.avatarSvg }} />
      ) : (
        avatarText(agent.name)
      )}
    </span>
  );
}

// ---------- 老板称呼 ----------

function BossNameControl({ boss, onChanged }: { boss: AgentCard | undefined; onChanged: () => void }) {
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (!boss) return null;
  const rename = async () => {
    const name = draft.trim();
    setEditing(false);
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
      {editing ? (
        <input
          className="boss-edit"
          value={draft}
          autoFocus
          placeholder="老板的称呼"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void rename();
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={() => void rename()}
        />
      ) : (
        <button
          className="ghost-btn"
          title="修改老板称呼"
          onClick={() => {
            setDraft(boss.name);
            setEditing(true);
          }}
        >
          老板：{boss.name} · 修改称呼
        </button>
      )}
      {error && <span className="boss-error">{error}</span>}
    </div>
  );
}

type SystemChip = {
  label: string;
  ok: boolean;
  detail: string;
  target?: OnboardTabId;
};

function ClientHealthMenu({ chips, onOpenTab }: { chips: SystemChip[]; onOpenTab: (tab: OnboardTabId) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const okCount = chips.filter((c) => c.ok).length;
  return (
    <div className="client-health" ref={rootRef}>
      <button
        className={`sys-dot ${okCount === chips.length ? "ok" : "bad"}`}
        title={`客户端接入 ${okCount}/${chips.length}，点击查看明细`}
        onClick={() => setOpen((v) => !v)}
      >
        客户端 {okCount}/{chips.length}
      </button>
      {open && (
        <div className="client-health-menu" role="menu">
          {chips.map((chip) => (
            <button
              key={chip.label}
              className="client-health-item"
              role="menuitem"
              title={chip.detail}
              onClick={() => {
                if (!chip.target) return;
                onOpenTab(chip.target);
                setOpen(false);
              }}
            >
              <span className={`sys-dot ${chip.ok ? "ok" : "bad"}`}>{chip.label}</span>
              <span className="client-health-detail">{chip.detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- 对话历史 ----------

const HISTORY_KIND_LABELS: Record<string, string> = {
  prompt: "问",
  final: "答",
  cmd: "▸",
  out: "·",
  info: "ⓘ",
  error: "!",
};

function HistoryModal({ agent, onClose }: { agent: AgentCard; onClose: () => void }) {
  const [lines, setLines] = useState<Array<{ at: number; kind: string; text: string }>>([]);
  const [loaded, setLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickBottomRef = useRef(true);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api
        .history(agent.id, { limit: 1000 })
        .then(({ lines: fresh }) => {
          if (!alive) return;
          setLines(fresh);
          setLoaded(true);
        })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 2000);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [agent.id, onClose]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal history-modal"
        role="dialog"
        aria-label={`${agent.name} 的对话历史`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h3>
            {agent.name} · 对话历史
            <small className="history-sub">
              {AGENT_KIND_LABELS[agent.kind] ?? agent.kind} · {lines.length} 条 · 实时更新
            </small>
          </h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="history-screen" role="log" aria-live="polite" ref={scrollRef} onScroll={onScroll}>
          {loaded && lines.length === 0 && (
            <p>
              还没有对话记录。托管员工被 @ 后、或手工会话（Cursor/Codex/Claude/ZCode）重启加载新 hooks 后，
              提问与回复会自动同步到这里。
            </p>
          )}
          {lines.map((line, index) => (
            <div key={`${line.at}-${index}`} className={`term-line term-${line.kind} hist-${line.kind}`}>
              <time>{clockTime(line.at)}</time>
              <em className="hist-kind">{HISTORY_KIND_LABELS[line.kind] ?? "·"}</em>
              <code>{line.text}</code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- 职位档案弹窗 ----------

function RoleDossierModal({
  role,
  onClose,
  onChanged,
}: {
  role: OfficeRole;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [dossier, setDossier] = useState<RoleDossier | null>(null);
  const [error, setError] = useState("");
  const [noteTitle, setNoteTitle] = useState("");
  const [noteContent, setNoteContent] = useState("");

  const load = useCallback(async () => {
    try {
      setDossier(await api.roleDossier(role.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [role.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const addNote = async () => {
    if (!noteTitle.trim() || !noteContent.trim()) return;
    try {
      await api.roleNoteCreate(role.id, { title: noteTitle.trim(), content: noteContent });
      setNoteTitle("");
      setNoteContent("");
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const delNote = async (noteId: string) => {
    try {
      await api.roleNoteDelete(role.id, noteId);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal dossier-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>
            职位档案 · {role.name}
            {(role.holderNames?.length ?? 0) > 0 && (
              <span className="dossier-holder">在岗：{role.holderNames!.join("、")}</span>
            )}
          </h3>
          <button className="icon-btn" title="关闭" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        {error && <div className="form-error dossier-error">{error}</div>}
        <div className="modal-body dossier-body">
          <p className="dossier-hint">
            同岗成员共享职位档案与知识库：笔记、解决方案、历任简报和岗位消息会自动交接（不限 Cursor /
            Codex / Claude）。
          </p>
          <h4>档案笔记（{dossier?.notes.length ?? 0}）</h4>
          {(dossier?.notes ?? []).map((n) => (
            <div key={n.id} className="dossier-note">
              <div className="dossier-note-head">
                <strong>{n.title}</strong>
                <span>
                  {n.author ?? "匿名"} · {new Date(n.updatedAt).toLocaleString()}
                  <button className="icon-btn danger" title="删除笔记" onClick={() => void delNote(n.id)}>
                    ×
                  </button>
                </span>
              </div>
              <pre>{n.content}</pre>
            </div>
          ))}
          <div className="dossier-new-note">
            <input
              placeholder="笔记标题（如 测试环境账号）"
              value={noteTitle}
              onChange={(e) => setNoteTitle(e.target.value)}
            />
            <textarea
              placeholder="内容：账号密码、仓库路径、架构结论、重要决策……写进来就跟着职位走"
              value={noteContent}
              rows={3}
              onChange={(e) => setNoteContent(e.target.value)}
            />
            <button className="primary-btn sm" onClick={() => void addNote()}>
              ＋ 写入档案
            </button>
          </div>
          {(dossier?.knowledge ?? []).length > 0 && (
            <>
              <h4>同岗知识库（{(dossier?.knowledge ?? []).length}）</h4>
              {(dossier?.knowledge ?? []).map((k) => (
                <div key={k.id} className="dossier-note">
                  <div className="dossier-note-head">
                    <strong>{k.category} / {k.title}</strong>
                    <span>{k.author ?? "匿名"} · {timeAgo(k.updatedAt)}</span>
                  </div>
                  <pre>{k.content.slice(0, 500)}</pre>
                </div>
              ))}
            </>
          )}
          {(dossier?.briefs.length ?? 0) > 0 && (
            <>
              <h4>历任简报（近 {dossier!.briefs.length} 份）</h4>
              {dossier!.briefs.map((b, i) => (
                <div key={i} className="dossier-brief">
                  <strong>{b.agentName}</strong>：{b.title} — {b.result.slice(0, 160)}
                </div>
              ))}
            </>
          )}
          {(dossier?.messages.length ?? 0) > 0 && (
            <>
              <h4>岗位收到过的指示（近 {dossier!.messages.length} 条）</h4>
              {dossier!.messages.map((m, i) => (
                <div key={i} className="dossier-msg">
                  <strong>{m.fromName}</strong>：{m.text.slice(0, 200)}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- 工位卡片 ----------

function AgentBadge({
  agent,
  groups,
  roles,
  onMention,
  onChanged,
}: {
  agent: AgentCard;
  roles: OfficeRole[];
  groups: OfficeGroup[];
  onMention: (name: string) => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.name);
  const [model, setModel] = useState(meta(agent).model ?? "");
  const [roleId, setRoleId] = useState(meta(agent).roleId ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dossierOpen, setDossierOpen] = useState(false);
  const [newRoleOpen, setNewRoleOpen] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleDesc, setNewRoleDesc] = useState("");
  const [newRoleGroupId, setNewRoleGroupId] = useState(groups[0]?.id ?? "");

  const createRoleInline = async () => {
    if (!newRoleName.trim()) return;
    try {
      const role = await api.createRole(
        newRoleName.trim(),
        newRoleDesc.trim() || undefined,
        newRoleGroupId || undefined,
      );
      setRoleId(role.id);
      setNewRoleOpen(false);
      setNewRoleName("");
      setNewRoleDesc("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    try {
      await api.updateAgent(agent.id, {
        name: name.trim(),
        model,
        ...(agent.kind !== "user" ? { roleId: roleId || null } : {}),
      });
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
      await api.generateAvatar(agent.id, meta(agent).title || undefined);
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

  const promote = async () => {
    if (
      !window.confirm(
        `唤醒「${agent.name}」？将转为托管工位（沿用原会话续聊），之后 @它 即可直接执行；离席期间的未读消息会立即处理。`,
      )
    )
      return;
    setBusy(true);
    try {
      await api.promoteAgent(agent.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const m = meta(agent);
  const promotable =
    (agent.kind === "codex-cli" && Boolean(m.threadId)) ||
    (agent.kind === "claude-cli" && Boolean(m.sessionId));
  const inboxOnly =
    agent.kind === "cursor-ide" ||
    agent.kind === "codex-cli" ||
    agent.kind === "claude-cli" ||
    agent.kind === "zcode-cli" ||
    agent.kind === "workbuddy-cli" ||
    agent.kind === "opencode-cli" ||
    agent.kind === "kimi-cli" ||
    agent.kind === "qoder-cli" ||
    agent.kind === "kilo-cli" ||
    agent.kind === "trae-ide";
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

      {!editing && m.title && (
        <div className="badge-title">
          {agent.groupNames?.[0] ? `${agent.groupNames[0]} · ` : ""}
          {m.title}
          {m.roleId && (
            <button
              className="icon-btn dossier-btn"
              title="查看职位档案（笔记 / 历任简报 / 岗位消息，交接时自动继承）"
              aria-label="查看职位档案"
              onClick={() => setDossierOpen(true)}
            >
              📋
            </button>
          )}
        </div>
      )}
      {!editing && !m.title && (agent.groupNames?.length ?? 0) > 0 && (
        <div className="badge-groups">
          {agent.groupNames!.map((gn) => (
            <span key={gn} className="badge-group" title={`部门：${gn}`}>
              # {gn}
            </span>
          ))}
        </div>
      )}

      {editing && (
        <div className="badge-edit">
          <input
            placeholder="模型备注（如 gpt-5.6-sol / opus-4.8）"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void save()}
          />
          {agent.kind !== "user" && (
            <div className="role-picker">
              <select value={roleId} onChange={(e) => setRoleId(e.target.value)} title="选择职位">
                <option value="">（无职位）</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {(r.holderNames?.length ?? 0) > 0 ? `（在岗：${r.holderNames!.join("、")}）` : ""}
                  </option>
                ))}
              </select>
              <button
                className="ghost-btn sm"
                title="新建职位"
                onClick={() => setNewRoleOpen((v) => !v)}
              >
                ＋职位
              </button>
            </div>
          )}
          {agent.kind !== "user" && newRoleOpen && (
            <div className="role-new">
              <input
                placeholder="新职位名（如 测试 / git 库管理）"
                value={newRoleName}
                autoFocus
                onChange={(e) => setNewRoleName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void createRoleInline()}
              />
              <input
                placeholder="职位说明（可选）"
                value={newRoleDesc}
                onChange={(e) => setNewRoleDesc(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void createRoleInline()}
              />
              {groups.length > 0 && (
                <select
                  value={newRoleGroupId}
                  onChange={(e) => setNewRoleGroupId(e.target.value)}
                  aria-label="职位所属部门"
                >
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                className="primary-btn sm"
                disabled={!newRoleName.trim()}
                onClick={() => void createRoleInline()}
              >
                建职位
              </button>
            </div>
          )}
          {agent.kind !== "user" && agent.kind !== "supervisor" && (
            <div className="group-picker">
              <span className="group-picker-label">归属（随职位）</span>
              <span className="dept-role-readonly">
                {(agent.groupNames?.[0] ?? "未入部门") +
                  " · " +
                  (roles.find((r) => r.id === (roleId || meta(agent).roleId))?.name ??
                    meta(agent).title ??
                    "未任职")}
              </span>
            </div>
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
            aria-label={agent.kind === "user" ? "设置老板称呼" : `调整 ${agent.name} 的员工资料`}
            onClick={() => {
              setEditing((v) => !v);
              setName(agent.name);
              setModel(m.model ?? "");
              setRoleId(m.roleId ?? "");
              setNewRoleGroupId(agent.groupIds?.[0] ?? groups[0]?.id ?? "");
            }}
          >
            ✎
          </button>
          {promotable && (
            <button
              className="icon-btn promote"
              title="唤醒：转为托管工位（沿用原会话续聊），离席积压的消息立即处理"
              aria-label={`唤醒 ${agent.name} 并转为托管工位`}
              disabled={busy}
              onClick={() => void promote()}
            >
              ⚡
            </button>
          )}
          {agent.kind !== "user" && agent.kind !== "supervisor" && (
            <button className="icon-btn" title="对话历史（终端视图）" aria-label={`查看 ${agent.name} 的对话历史`} onClick={() => setHistoryOpen(true)}>
              ≣
            </button>
          )}
          {agent.kind !== "user" && agent.kind !== "supervisor" && (
            <button className="icon-btn" title="生成员工头像" aria-label={`生成 ${agent.name} 的头像`} disabled={busy} onClick={() => void makeAvatar()}>
              ◉
            </button>
          )}
          {agent.kind !== "user" && agent.kind !== "supervisor" && (
            <button className="icon-btn danger" title="移出员工" aria-label={`移出员工 ${agent.name}`} disabled={busy} onClick={() => void remove()}>
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

      {historyOpen && <HistoryModal agent={agent} onClose={() => setHistoryOpen(false)} />}
      {dossierOpen && m.roleId && (
        <RoleDossierModal
          role={roles.find((r) => r.id === m.roleId) ?? { id: m.roleId, name: m.title ?? "职位", description: null, groupId: null, createdAt: 0 }}
          onClose={() => setDossierOpen(false)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

// ---------- 新建托管工位 ----------

function NewAgentForm({ onDone, onOpenShell }: { onDone: () => void; onOpenShell: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"codex" | "cursor" | "claude">("codex");
  const [form, setForm] = useState<"managed" | "terminal">("managed");
  const [workspace, setWorkspace] = useState("");
  const [model, setModel] = useState("");
  const [sandbox, setSandbox] = useState<"read-only" | "workspace-write">("read-only");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button className="add-desk" onClick={() => setOpen(true)}>
        ＋ 新建工位
      </button>
    );
  }

  const terminalForm = form === "terminal" && kind !== "cursor";

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (terminalForm) {
        // 终端形态：在「本机终端」开一个交互式 CLI，会话经 hooks/notify 自动入驻办公室
        const cli: "codex" | "claude" = kind === "claude" ? "claude" : "codex";
        await api.shellTermCreate({
          shell: "powershell",
          command: cli,
          cwd: workspace.trim() || undefined,
          title: name.trim() || undefined,
        });
        setOpen(false);
        setName("");
        setWorkspace("");
        onOpenShell();
        return;
      }
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
      <h4>新建工位</h4>
      <input
        placeholder={terminalForm ? "终端标题（可选）" : "工号（如 codex-研发）"}
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
      />
      <select value={kind} onChange={(e) => setKind(e.target.value as any)}>
        <option value="codex">Codex</option>
        <option value="claude">Claude</option>
        <option value="cursor">Cursor（需 API Key）</option>
        <option value="kimi">Kimi</option>
        <option value="qoder">Qoder</option>
        <option value="kilo">Kilo</option>
      </select>
      {kind !== "cursor" && (
        <select value={form} onChange={(e) => setForm(e.target.value as any)} title="工位形态">
          <option value="managed">托管形态：后台自动执行，@消息即干活</option>
          <option value="terminal">终端形态：在「本机终端」开交互 CLI，可随时手动干预</option>
        </select>
      )}
      <input
        placeholder="工作目录（可选）"
        value={workspace}
        onChange={(e) => setWorkspace(e.target.value)}
      />
      {!terminalForm && (
        <input
          placeholder="模型备注（可选）"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      )}
      {kind !== "cursor" && !terminalForm && (
        <select value={sandbox} onChange={(e) => setSandbox(e.target.value as any)}>
          <option value="read-only">只读沙箱（更安全）</option>
          <option value="workspace-write">可写工作区</option>
        </select>
      )}
      {terminalForm && (
        <p className="form-hint">
          开终端即入驻花名册（在线状态）；第一轮对话后自动绑定会话，获得 @续聊 能力。
        </p>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button
          className="primary-btn sm"
          disabled={busy || (!terminalForm && !name.trim())}
          onClick={submit}
        >
          {busy ? "创建中…" : terminalForm ? "开终端" : "创建"}
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
      "本机有 Agent Office 协作中枢（MCP 服务 agent-office）。请调用 register_agent 登记，工号自拟（如 cursor-前端），kind 填 cursor-ide；每轮开始先 read_inbox，完成工作后 publish_brief；阶段任务需要同事接手时调用 handoff_task 自动交接并唤醒。",
    note: "新开的 Cursor 会话（任意项目）会自动登记，无需此步骤。",
  },
  {
    id: "codex",
    label: "Codex",
    intro: "已有终端：在那个 Codex 终端里直接输入（MCP 未加载时需先重启 Codex）：",
    prompt:
      "本机有 Agent Office 协作中枢（MCP 服务 agent_office）。请调用 register_agent 登记，工号自拟（如 codex-主力），kind 填 codex-cli；每轮开始先 read_inbox，完成工作后 publish_brief；阶段任务需要同事接手时调用 handoff_task 自动交接并唤醒。",
    note: "新启动的 Codex 会话每轮结束会自动回帧简报，并从 ~/.codex/AGENTS.md 读到协作协议。",
  },
  {
    id: "claude",
    label: "Claude Code",
    intro: "已有会话：把下面这句话发给那个 Claude Code 会话：",
    prompt:
      "本机有 Agent Office 协作中枢（MCP 服务 agent-office）。请调用 register_agent 登记，工号自拟（如 claude-架构），kind 填 claude-cli；每轮开始先 read_inbox，完成工作后 publish_brief；阶段任务需要同事接手时调用 handoff_task 自动交接并唤醒。",
    note: "新启动的 Claude Code 会话（任意目录）会自动登记。",
  },
  {
    id: "zcode",
    label: "ZCode",
    intro: "已有会话：把下面这句话发给那个 ZCode 会话：",
    prompt:
      "本机有 Agent Office 协作中枢（MCP 服务 agent-office）。请调用 register_agent 登记，工号自拟（如 zcode-主力），kind 填 zcode-cli；每轮开始先 read_inbox，完成工作后 publish_brief；阶段任务需要同事接手时调用 handoff_task 自动交接并唤醒。",
    note: "新启动的 ZCode 会话会自动登记，并从 ~/.zcode/AGENTS.md 读到协作协议。",
  },
  {
    id: "workbuddy",
    label: "WorkBuddy",
    intro: "打开 WorkBuddy，把下面这句话发给它（MCP 未加载时先在设置里接入 agent-office）：",
    prompt:
      "本机有 Agent Office 协作中枢（MCP 服务 agent-office）。请调用 register_agent 登记，工号自拟（如 workbuddy-主力），kind 填 workbuddy-cli；每轮开始先 read_inbox，完成工作后 publish_brief；阶段任务需要同事接手时调用 handoff_task 自动交接并唤醒。",
    note: "WorkBuddy 无 hooks 机制，不会自动登记；新对话需先调用 register_agent。协作协议已通过 SKILL.md 注入。",
  },
  {
    id: "opencode",
    label: "OpenCode",
    intro: "已有会话：把下面这句话发给那个 OpenCode 会话：",
    prompt:
      "本机有 Agent Office 协作中枢（MCP 服务 agent-office）。请调用 register_agent 登记，工号自拟（如 opencode-主力），kind 填 opencode-cli；每轮开始先 read_inbox，完成工作后 publish_brief；阶段任务需要同事接手时调用 handoff_task 自动交接并唤醒。",
    note: "OpenCode 会话由本地插件自动登记并回帧简报；插件未生效时请手动 register_agent（kind=opencode-cli）。",
  },
  {
    id: "kimi",
    label: "Kimi",
    intro: "已有会话：把下面这句话发给那个 Kimi CLI 会话：",
    prompt:
      "本机有 Agent Office 协作中枢（MCP 服务 agent-office）。请调用 register_agent 登记，工号自拟（如 kimi-主力），kind 填 kimi-cli；每轮开始先 read_inbox，完成工作后 publish_brief；阶段任务需要同事接手时调用 handoff_task 自动交接并唤醒。",
    note: "新启动的 Kimi Code CLI 会话会自动登记，并从 ~/.kimi-code/SYSTEM.md 读到协作协议。",
  },
  {
    id: "qoder",
    label: "Qoder",
    intro: "已有会话：把下面这句话发给那个 Qoder 会话：",
    prompt:
      "本机有 Agent Office 协作中枢（MCP 服务 agent-office）。请调用 register_agent 登记，工号自拟（如 qoder-主力），kind 填 qoder-cli；每轮开始先 read_inbox，完成工作后 publish_brief；阶段任务需要同事接手时调用 handoff_task 自动交接并唤醒。",
    note: "新启动的 Qoder 会话会自动登记，并从 ~/.qoder/AGENTS.md 读到协作协议。",
  },
  {
    id: "kilo",
    label: "Kilo",
    intro: "已有会话：把下面这句话发给那个 Kilo CLI 会话：",
    prompt:
      "本机有 Agent Office 协作中枢（MCP 服务 agent-office）。请调用 register_agent 登记，工号自拟（如 kilo-主力），kind 填 kilo-cli；每轮开始先 read_inbox，完成工作后 publish_brief；阶段任务需要同事接手时调用 handoff_task 自动交接并唤醒。",
    note: "Kilo 需手动 register_agent（kind=kilo-cli）；协议块已写入 ~/.config/kilocode/AGENTS.md。",
  },
  {
    id: "trae",
    label: "Trae",
    intro: "已有会话：把下面这句话发给那个 Trae 会话：",
    prompt:
      "本机有 Agent Office 协作中枢（MCP 服务 agent-office）。请调用 register_agent 登记，工号自拟（如 trae-主力），kind 填 trae-ide；每轮开始先 read_inbox，完成工作后 publish_brief；阶段任务需要同事接手时调用 handoff_task 自动交接并唤醒。",
    note: "Trae 无 hooks 机制，不会自动登记；新会话需先调用 register_agent。",
  },
] as const;

type OnboardTabId = (typeof ONBOARD_TABS)[number]["id"];

const INTEGRATION_CHECK_LABELS: Record<
  OnboardTabId,
  { runtime: string; hook: string; instructions: string }
> = {
  cursor: { runtime: "Cursor", hook: "Hooks", instructions: "会话规则" },
  codex: { runtime: "Codex CLI", hook: "Notify", instructions: "协作协议" },
  claude: { runtime: "Claude CLI", hook: "Hooks", instructions: "会话规则" },
  zcode: { runtime: "ZCode", hook: "Hooks", instructions: "协作协议" },
  workbuddy: { runtime: "WorkBuddy", hook: "桥接", instructions: "SKILL 协议" },
  opencode: { runtime: "OpenCode", hook: "插件", instructions: "协作协议" },
  kimi: { runtime: "Kimi CLI", hook: "Hooks", instructions: "协作协议" },
  qoder: { runtime: "Qoder", hook: "Hooks", instructions: "协作协议" },
  kilo: { runtime: "Kilo CLI", hook: "—", instructions: "协作协议" },
  trae: { runtime: "Trae", hook: "—", instructions: "会话规则" },
};

function OnboardModal({
  health,
  initialTab,
  onHealthChanged,
  onClose,
}: {
  health: Health | null;
  initialTab: OnboardTabId;
  onHealthChanged: (health: Health) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<OnboardTabId>(initialTab);
  const [copied, setCopied] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState("");
  const current = ONBOARD_TABS.find((t) => t.id === tab)!;
  const integration = health?.integrations?.[tab];
  const labels = INTEGRATION_CHECK_LABELS[tab];

  const copy = async () => {
    await navigator.clipboard.writeText(current.prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const repair = async () => {
    if (
      !window.confirm(
        `修复 ${current.label} 接入会更新其用户级 MCP/Hook 配置，并为变更的原文件创建备份。确认继续？`,
      )
    ) {
      return;
    }
    setRepairing(true);
    setRepairError("");
    try {
      onHealthChanged(await api.repairIntegration(tab));
    } catch (error) {
      setRepairError(error instanceof Error ? error.message : String(error));
    } finally {
      setRepairing(false);
    }
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
              onClick={() => {
                setTab(t.id);
                setCopied(false);
                setRepairError("");
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="modal-body">
          <section
            className={`integration-status ${integration ? (integration.ready ? "ready" : "needs-action") : "pending"}`}
          >
            <div className="integration-status-head">
              <strong>
                {!integration
                  ? "接入状态尚未加载"
                  : integration.ready
                    ? "接入完整，可正常协作"
                    : "接入未完成"}
              </strong>
              <span>{!integration ? "未加载" : integration.ready ? "可用" : "需修复"}</span>
            </div>
            {integration ? (
              <ul className="integration-checks">
                {integration.runtimeAvailable !== null && (
                  <li className={integration.runtimeAvailable ? "ok" : "bad"}>
                    {labels.runtime}
                  </li>
                )}
                <li className={integration.mcpConfigured ? "ok" : "bad"}>MCP</li>
                <li className={integration.hookConfigured ? "ok" : "bad"}>{labels.hook}</li>
                {integration.instructionsConfigured !== null && (
                  <li className={integration.instructionsConfigured ? "ok" : "bad"}>
                    {labels.instructions}
                  </li>
                )}
              </ul>
            ) : (
              <p className="modal-note">正在读取接入状态。</p>
            )}
            {integration && !integration.ready && (
              <button
                className="repair-btn"
                disabled={repairing}
                onClick={() => void repair()}
              >
                {repairing ? "修复中…" : `修复 ${current.label} 接入`}
              </button>
            )}
            {repairError && <p className="form-error">修复失败：{repairError}</p>}
          </section>
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
  channel,
  channelName,
  onSent,
}: {
  agents: AgentCard[];
  prefill: string;
  channel: string;
  channelName: string;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [hint, setHint] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [images, setImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const addImages = async (files: Iterable<File>) => {
    const list = [...files].filter((f) => f.type.startsWith("image/"));
    if (list.length === 0) return;
    setUploading(true);
    try {
      for (const file of list) {
        const { url } = await api.uploadImage(file);
        setImages((prev) => [...prev, url]);
      }
    } catch (e) {
      setHint({ text: `图片上传失败：${e instanceof Error ? e.message : String(e)}`, kind: "err" });
    } finally {
      setUploading(false);
    }
  };

  useEffect(() => {
    if (prefill) {
      setText((prev) => (prev.includes(prefill) ? prev : `${prefill} ${prev}`));
      inputRef.current?.focus();
    }
  }, [prefill]);

  const names = useMemo(
    () => [
      SUPERVISOR_NAME,
      ...sortWorkersForAction(
        agents.filter((a) => a.kind !== "user" && a.kind !== "supervisor"),
        [],
      ).map((a) => a.name),
    ],
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
    if ((!text.trim() && images.length === 0) || uploading) return;
    try {
      const result = await api.sendMessage(text.trim(), channel, images);
      setHint(buildMessageFeedback(result));
      setText("");
      setImages([]);
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
      {hint && (
        <div
          className={`composer-toast ${hint.kind}`}
          role={hint.kind === "err" ? "alert" : "status"}
        >
          {hint.text}
        </div>
      )}
      {images.length > 0 && (
        <div className="composer-images">
          {images.map((url) => (
            <span key={url} className="composer-image">
              <img src={url} alt="附图" />
              <button
                title="移除该图"
                onClick={() => setImages((prev) => prev.filter((x) => x !== url))}
              >
                ×
              </button>
            </span>
          ))}
          {uploading && <span className="composer-uploading">上传中…</span>}
        </div>
      )}
      <div className="composer-box">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void addImages(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          className="attach-btn"
          title="添加图片（也可以直接粘贴/拖入）"
          aria-label="添加图片"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          🖼
        </button>
        <textarea
          ref={inputRef}
          value={text}
          rows={2}
          onPaste={(e) => {
            const files = [...e.clipboardData.items]
              .filter((item) => item.kind === "file")
              .map((item) => item.getAsFile())
              .filter((f): f is File => Boolean(f));
            if (files.length > 0) {
              e.preventDefault();
              void addImages(files);
            }
          }}
          onDrop={(e) => {
            if (e.dataTransfer.files.length > 0) {
              e.preventDefault();
              void addImages(e.dataTransfer.files);
            }
          }}
          onDragOver={(e) => e.preventDefault()}
          placeholder={
            channel === "hall"
              ? "给大群发消息：@工号 呼叫成员，@主管 自动分派，@all 全员……"
              : `发到「${channelName}」频道：@工号 呼叫成员，@all 只喊本组人……`
          }
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
          disabled={(!text.trim() && images.length === 0) || uploading}
          title="发送（Enter）"
        >
          发送
        </button>
      </div>
      <div className="composer-hint">Enter 发送 · Shift+Enter 换行 · @ 呼叫成员 · 粘贴/拖入图片</div>
    </div>
  );
}

// ---------- 简报卡片 ----------

function BriefCard({
  brief,
  tasks,
  onOpenTask,
}: {
  brief: OfficeBrief;
  tasks?: OfficeTask[];
  onOpenTask?: (taskId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = brief.result.length > 200;
  const task = brief.taskId ? tasks?.find((t) => t.id === brief.taskId) : undefined;
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
      {brief.taskId && (
        <button
          type="button"
          className="brief-task-tag"
          onClick={() => onOpenTask?.(brief.taskId!)}
          title={task?.title ?? brief.taskId}
        >
          任务 · {task?.title ?? brief.taskId.slice(0, 8)}
        </button>
      )}
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

function BriefWall({
  briefs,
  tasks,
  onOpenTask,
}: {
  briefs: OfficeBrief[];
  tasks: OfficeTask[];
  onOpenTask: (taskId: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [taskOnly, setTaskOnly] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const matching = briefs.filter((b) => {
    if (filter && b.agentName !== filter) return false;
    if (taskOnly && !b.taskId) return false;
    return true;
  });
  const shown = expanded ? matching : matching.slice(0, 5);
  const authors = useMemo(
    () => [...new Set(briefs.map((b) => b.agentName))],
    [briefs],
  );
  return (
    <section className="panel panel-briefs">
      <div className="panel-head">
        <h3>简报墙</h3>
        <div className="brief-toolbar">
          <select
            className="brief-filter"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setExpanded(false);
            }}
            aria-label="按成员筛选简报"
          >
            <option value="">全部成员（{briefs.length}）</option>
            {authors.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`ghost-btn sm ${taskOnly ? "active" : ""}`}
            onClick={() => {
              setTaskOnly((v) => !v);
              setExpanded(false);
            }}
            title="只看关联了任务的简报"
          >
            {taskOnly ? "任务简报" : "全部简报"}
          </button>
        </div>
      </div>
      <div className="brief-wall">
        {shown.length === 0 && (
          <p className="empty">
            {taskOnly
              ? "还没有关联任务的简报。发布简报时带上 task_id，或到任务中心查看时间线。"
              : "还没有简报。成员完成工作后会自动出现在这里。"}
          </p>
        )}
        {shown.map((brief) => (
          <BriefCard
            key={brief.id}
            brief={brief}
            tasks={tasks}
            onOpenTask={onOpenTask}
          />
        ))}
        {matching.length > 5 && (
          <button className="brief-more" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "收起历史简报" : `查看其余 ${matching.length - 5} 条`}
          </button>
        )}
      </div>
    </section>
  );
}

// ---------- 分派工作（渐进披露） ----------

function DispatchForm({
  agents,
  tasks,
  onDone,
  onClose,
}: {
  agents: AgentCard[];
  tasks: OfficeTask[];
  onDone: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [hint, setHint] = useState("");
  const [showOffline, setShowOffline] = useState(false);
  const workers = sortWorkersForAction(
    agents.filter((a) => a.kind !== "user" && a.kind !== "supervisor"),
    tasks,
  );
  const offlineCount = workers.filter((agent) => agent.status === "offline").length;
  const shownWorkers = showOffline
    ? workers
    : workers.filter((agent) => agent.status !== "offline");

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
          {shownWorkers.map((a) => (
            <button
              key={a.id}
              className={`chip-toggle ${chosen.includes(a.name) ? "on" : ""} ${a.status === "offline" ? "off-agent" : ""}`}
              onClick={() => toggle(a.name)}
              title={`${AGENT_KIND_LABELS[a.kind]} · ${STATUS_LABELS[a.status]}`}
            >
              {a.name}
            </button>
          ))}
          {offlineCount > 0 && (
            <button className="chip-toggle history" onClick={() => setShowOffline((value) => !value)}>
              {showOffline ? "隐藏离线成员" : `显示离线成员 ${offlineCount}`}
            </button>
          )}
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

// ---------- 任务面板（首页摘要） ----------

function TaskPanel({
  tasks,
  onOpenTasks,
  onOpenTask,
}: {
  tasks: OfficeTask[];
  onOpenTasks: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const claimable = tasks.filter((t) => t.status === "open" && !t.assigneeAgentId);
  const active = tasks.filter(
    (t) => t.status === "claimed" || t.status === "in_progress" || t.status === "review",
  );
  return (
    <section className="panel panel-tasks">
      <div className="panel-head">
        <h3>任务摘要</h3>
        <button className="dispatch-btn" onClick={onOpenTasks}>
          打开任务中心
        </button>
      </div>
      <div className="task-summary-stats">
        <span>待认领 {claimable.length}</span>
        <span>进行中 {active.length}</span>
      </div>
      <ul className="task-list">
        {active.slice(0, 5).map((task) => (
          <li key={task.id} className={"task task-" + task.status}>
            <button type="button" className="task-link" onClick={() => onOpenTask(task.id)}>
              <span className="task-title">{task.title}</span>
              <span className={"task-status s-" + task.status}>
                {TASK_STATUS_LABELS[task.status]}
              </span>
            </button>
            <div className="task-meta">
              <span>{task.assigneeName ?? "未分派"}</span>
            </div>
          </li>
        ))}
        {active.length === 0 && (
          <p className="empty">暂无进行中任务。去任务中心新建或分派。</p>
        )}
      </ul>
    </section>
  );
}

// ---------- 任务中心页 ----------

function TasksBoard({
  tasks,
  agents,
  briefs,
  focusTaskId,
  onChanged,
  onFocusConsumed,
}: {
  tasks: OfficeTask[];
  agents: AgentCard[];
  briefs: OfficeBrief[];
  focusTaskId?: string | null;
  onChanged: () => void;
  onFocusConsumed?: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(focusTaskId ?? null);
  const [timeline, setTimeline] = useState<Awaited<ReturnType<typeof api.taskTimeline>> | null>(
    null,
  );
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [error, setError] = useState("");
  const assignable = sortWorkersForAction(
    agents.filter((a) => a.kind !== "user" && a.kind !== "supervisor"),
    tasks,
  );

  useEffect(() => {
    if (focusTaskId) {
      setSelectedId(focusTaskId);
      onFocusConsumed?.();
    }
  }, [focusTaskId, onFocusConsumed]);

  useEffect(() => {
    if (!selectedId) {
      setTimeline(null);
      return;
    }
    api
      .taskTimeline(selectedId)
      .then(setTimeline)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [selectedId, tasks, briefs]);

  const claimable = tasks.filter((t) => t.status === "open");
  const active = tasks.filter((t) => t.status === "claimed" || t.status === "in_progress");
  const reviewing = tasks.filter((t) => t.status === "review" || t.status === "blocked");
  const closed = tasks.filter((t) => t.status === "done" || t.status === "cancelled");

  const create = async () => {
    if (!title.trim()) return;
    try {
      const task = await api.createTask(
        title.trim(),
        description.trim(),
        assignee || null,
        acceptanceCriteria.trim() || undefined,
      );
      setTitle("");
      setDescription("");
      setAssignee("");
      setAcceptanceCriteria("");
      setCreating(false);
      setError("");
      onChanged();
      setSelectedId(task.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const update = async (taskId: string, patch: { status?: string; assignee?: string | null }) => {
    try {
      await api.updateTask(taskId, patch);
      setError("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const review = async (action: "accept" | "reject") => {
    if (!selectedId) return;
    try {
      await api.reviewTask(selectedId, action, reviewNote.trim() || undefined);
      setReviewNote("");
      setError("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const renderColumn = (label: string, list: OfficeTask[]) => (
    <div className="tasks-col">
      <h3>
        {label}
        <small>{list.length}</small>
      </h3>
      <ul className="task-list">
        {list.map((task) => (
          <li
            key={task.id}
            className={
              "task task-" + task.status + (selectedId === task.id ? " selected" : "")
            }
          >
            <button type="button" className="task-link" onClick={() => setSelectedId(task.id)}>
              <span className="task-title">{task.title}</span>
              <span className={"task-status s-" + task.status}>
                {TASK_STATUS_LABELS[task.status]}
              </span>
            </button>
            <div className="task-meta">
              <select
                aria-label={"设置任务“" + task.title + "”的负责人"}
                value={task.assigneeName ?? ""}
                onChange={(e) => void update(task.id, { assignee: e.target.value || null })}
              >
                <option value="">未分派</option>
                {assignable.map((a) => (
                  <option key={a.id} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
              <select
                aria-label={"设置任务“" + task.title + "”的状态"}
                value={task.status}
                onChange={(e) => void update(task.id, { status: e.target.value })}
              >
                {Object.entries(TASK_STATUS_LABELS).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </div>
          </li>
        ))}
        {list.length === 0 && <p className="empty">空</p>}
      </ul>
    </div>
  );

  return (
    <div className="tasks-page">
      <header className="tasks-toolbar">
        <div>
          <h2>任务中心</h2>
          <p>待认领池、进行中与按任务聚合的执行时间线</p>
        </div>
        {!creating ? (
          <button className="primary-btn" onClick={() => setCreating(true)}>
            ＋ 新任务
          </button>
        ) : (
          <div className="tasks-create">
            <input
              placeholder="任务标题"
              value={title}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              placeholder="描述（可选）"
              value={description}
              rows={2}
              onChange={(e) => setDescription(e.target.value)}
            />
            <input
              placeholder="验收标准（可选，验收方据此核对产出）"
              value={acceptanceCriteria}
              onChange={(e) => setAcceptanceCriteria(e.target.value)}
            />
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">进待认领池</option>
              {assignable.map((a) => (
                <option key={a.id} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
            <div className="form-actions">
              <button className="primary-btn sm" disabled={!title.trim()} onClick={() => void create()}>
                创建
              </button>
              <button className="ghost-btn" onClick={() => setCreating(false)}>
                取消
              </button>
            </div>
          </div>
        )}
      </header>
      {error && <p className="form-error">{error}</p>}
      <div className="tasks-layout">
        <div className="tasks-board">
          {renderColumn("待认领", claimable)}
          {renderColumn("进行中", active)}
          {renderColumn("待验收", reviewing)}
          {renderColumn("已完成", closed)}
        </div>
        <aside className="tasks-detail">
          {!selectedId && <p className="empty">选择左侧任务查看时间线</p>}
          {timeline && (
            <>
              <h3>{timeline.task.title}</h3>
              <p className="tasks-detail-meta">
                {TASK_STATUS_LABELS[timeline.task.status]} ·{" "}
                {timeline.task.assigneeName ?? "未分派"}
              </p>
              {timeline.task.description && (
                <p className="tasks-detail-desc">{timeline.task.description}</p>
              )}
              {timeline.task.acceptanceCriteria && (
                <p className="tasks-detail-criteria">
                  <strong>验收标准：</strong>
                  {timeline.task.acceptanceCriteria}
                </p>
              )}
              {timeline.task.status === "review" && (
                <div className="tasks-review">
                  <input
                    placeholder="打回意见（验收通过可留空）"
                    value={reviewNote}
                    onChange={(e) => setReviewNote(e.target.value)}
                  />
                  <button className="primary-btn sm" onClick={() => void review("accept")}>
                    验收通过
                  </button>
                  <button className="ghost-btn" onClick={() => void review("reject")}>
                    打回
                  </button>
                </div>
              )}
              <ol className="task-timeline">
                {timeline.items.length === 0 && (
                  <li className="empty">还没有与此任务关联的消息、简报或交接。</li>
                )}
                {timeline.items.map((item, index) => {
                  if (item.kind === "message") {
                    return (
                      <li key={"m-" + item.message.id + "-" + index} className="tl-message">
                        <time>{timeAgo(item.at)}</time>
                        <strong>{item.message.fromName}</strong>
                        <p>{item.message.text}</p>
                      </li>
                    );
                  }
                  if (item.kind === "brief") {
                    return (
                      <li key={"b-" + item.brief.id + "-" + index} className="tl-brief">
                        <time>{timeAgo(item.at)}</time>
                        <strong>简报 · {item.brief.agentName}</strong>
                        <p>
                          {item.brief.title} — {item.brief.result.slice(0, 200)}
                        </p>
                      </li>
                    );
                  }
                  return (
                    <li key={"h-" + item.handoff.id + "-" + index} className="tl-handoff">
                      <time>{timeAgo(item.at)}</time>
                      <strong>
                        交接 · {item.handoff.fromAgentName} → {item.handoff.toAgentName}
                      </strong>
                      <p>{item.handoff.summary}</p>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------- 实时工作台 ----------

/** 员工卡详情：点工作台卡片放大查看 */
function EmployeeCardModal({
  agent,
  state,
  onClose,
}: {
  agent: AgentCard;
  state: OfficeState;
  onClose: () => void;
}) {
  const m = meta(agent);
  const role = state.roles.find((r) => r.id === m.roleId);
  const myTasks = state.tasks.filter((t) => t.assigneeAgentId === agent.id);
  const activeTask = myTasks.find((t) => t.status === "claimed" || t.status === "in_progress");
  const myBriefs = state.briefs.filter((b) => b.agentId === agent.id).slice(0, 5);
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="emp-card" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn emp-close" title="关闭" onClick={onClose}>
          ×
        </button>
        {/* 工牌头部 */}
        <div className={`emp-head st-${agent.status}`}>
          <span className="emp-avatar">
            <Avatar agent={agent} status={agent.status} />
          </span>
          <div className="emp-id">
            <strong>{agent.name}</strong>
            <span className="emp-role">{m.title || role?.name || "暂无职位"}</span>
            <span className="emp-kind">
              {AGENT_KIND_LABELS[agent.kind]}
              {m.model ? ` · ${m.model}` : ""}
            </span>
          </div>
          <span className={`live-status st-${agent.status}`}>{STATUS_LABELS[agent.status]}</span>
        </div>

        {/* 当前动态 */}
        <div className="emp-section">
          <h4>当前动态</h4>
          <p className="emp-activity">
            {agent.status === "offline"
              ? "离席"
              : m.lastActivity
                ? m.lastActivity
                : "空闲，等待分派"}
            {m.lastActivityAt && <time> · {timeAgo(m.lastActivityAt)}</time>}
          </p>
          {activeTask && (
            <p className="emp-task">
              进行中任务：{activeTask.title}（{TASK_STATUS_LABELS[activeTask.status]}）
            </p>
          )}
        </div>

        {/* 数据栏 */}
        <div className="emp-stats">
          <div>
            <em>{agent.todayTokens ?? 0}</em>
            <span>今日 token</span>
          </div>
          <div>
            <em>{agent.doneTasks ?? 0}</em>
            <span>完成任务</span>
          </div>
          <div>
            <em>{agent.pendingCount ?? 0}</em>
            <span>未读消息</span>
          </div>
          <div>
            <em>{myBriefs.length}</em>
            <span>近期简报</span>
          </div>
        </div>

        {/* 档案信息 */}
        <dl className="emp-facts">
          {(agent.groupNames?.length ?? 0) > 0 && (
            <div>
              <dt>部门</dt>
              <dd>{agent.groupNames!.map((g) => `# ${g}`).join("　")}</dd>
            </div>
          )}
          {agent.workspace && (
            <div>
              <dt>工作目录</dt>
              <dd className="mono">{agent.workspace}</dd>
            </div>
          )}
          <div>
            <dt>入驻时间</dt>
            <dd>{new Date(agent.createdAt).toLocaleString()}</dd>
          </div>
          {agent.lastSeenAt && (
            <div>
              <dt>最后在线</dt>
              <dd>{timeAgo(agent.lastSeenAt)}</dd>
            </div>
          )}
        </dl>

        {/* 最近简报 */}
        <div className="emp-section">
          <h4>最近简报</h4>
          {myBriefs.length === 0 && <p className="live-idle">尚无简报。</p>}
          <ul className="emp-briefs">
            {myBriefs.map((b) => (
              <li key={b.id}>
                <strong>{b.title}</strong>
                <time>{timeAgo(b.createdAt)}</time>
                <p>{b.result}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function LiveBoard({ state }: { state: OfficeState }) {
  const [detailId, setDetailId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const selection = useMemo(
    () =>
      selectWorkers({
        agents: state.agents,
        tasks: state.tasks,
        query,
        showArchived,
      }),
    [state.agents, state.tasks, query, showArchived],
  );
  const workers = selection.visible;
  const allWorkers = state.agents.filter(
    (agent) => agent.kind !== "user" && agent.kind !== "supervisor",
  );
  const activeTasks = state.tasks.filter(
    (t) => t.status === "claimed" || t.status === "in_progress",
  );
  const busyCount = allWorkers.filter((a) => a.status === "busy").length;
  const detailAgent = allWorkers.find((a) => a.id === detailId) ?? null;
  return (
    <div className="live-wrap">
      <div className="live-summary">
        <span>
          当前显示 {workers.length}/{selection.totalCount} · <em className="busy-count">{busyCount}</em> 位工作中
        </span>
        <div className="operability-toolbar compact">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索成员"
            aria-label="搜索实时工作台成员"
          />
          {selection.archivedCount > 0 && (
            <button
              className={showArchived ? "active" : ""}
              onClick={() => setShowArchived((value) => !value)}
            >
              {showArchived ? "只看当前" : `历史 ${selection.archivedCount}`}
            </button>
          )}
        </div>
      </div>
      <div className="live-board">
        {workers.length === 0 && (
          <p className="empty">没有匹配的当前成员，可清除搜索或查看历史工位。</p>
        )}
        {workers.map((agent) => {
          const m = meta(agent);
          const task = activeTasks.find((t) => t.assigneeAgentId === agent.id);
          const latestBrief = state.briefs.find((b) => b.agentId === agent.id);
          const activityStale =
            m.lastActivityAt && Date.now() - m.lastActivityAt > 10 * 60_000;
          return (
            <article
              key={agent.id}
              className={`live-card status-${agent.status} clickable`}
              title="点击查看员工卡"
              role="button"
              tabIndex={0}
              aria-label={`查看 ${agent.name} 的员工卡`}
              onClick={() => setDetailId(agent.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setDetailId(agent.id);
                }
              }}
            >
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
      {detailAgent && (
        <EmployeeCardModal
          agent={detailAgent}
          state={state}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  );
}

// ---------- 终端管理 ----------

function TerminalBoard({ refreshKey }: { refreshKey: number }) {
  const [agents, setAgents] = useState<TerminalPane[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [error, setError] = useState("");
  const [cmd, setCmd] = useState("");
  const [sending, setSending] = useState(false);
  const [query, setQuery] = useState("");
  const [showOffline, setShowOffline] = useState(false);

  const load = useCallback(() => {
    api.terminals().then(({ agents: panes }) => {
      const sorted = sortTerminalsForAction(panes);
      setAgents(sorted);
      setSelected((current) =>
        sorted.some((pane) => pane.id === current) ? current : (sorted[0]?.id ?? ""),
      );
      setError("");
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 1500);
    return () => window.clearInterval(timer);
  }, [load, refreshKey]);

  const panes = useMemo(
    () => visibleTerminals(agents, showOffline, query),
    [agents, showOffline, query],
  );
  const offlineCount = agents.filter((pane) => pane.status === "offline").length;

  useEffect(() => {
    if (panes.some((pane) => pane.id === selected)) return;
    setSelected(panes[0]?.id ?? "");
  }, [panes, selected]);

  const current = agents.find((pane) => pane.id === selected);
  return (
    <div className="terminal-wrap">
      <aside className="terminal-list">
        <div className="terminal-list-head">
          <strong>终端工位</strong>
          <button className="icon-btn" title="刷新终端" aria-label="刷新终端" onClick={load}>↻</button>
        </div>
        <div className="terminal-filters">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索终端"
            aria-label="搜索终端工位"
          />
          {offlineCount > 0 && (
            <button
              className={showOffline ? "active" : ""}
              onClick={() => setShowOffline((value) => !value)}
            >
              {showOffline ? "隐藏历史" : `历史 ${offlineCount}`}
            </button>
          )}
        </div>
        {panes.length === 0 && <p className="empty">没有匹配的可用终端，可查看历史或清除搜索。</p>}
        {panes.map((pane) => (
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
        {current && (
          <form
            className="terminal-input"
            onSubmit={(event) => {
              event.preventDefault();
              const text = cmd.trim();
              if (!text || sending) return;
              setSending(true);
              api
                .terminalInput(current.id, text)
                .then(() => {
                  setCmd("");
                  setError("");
                  load();
                })
                .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setSending(false));
            }}
          >
            <span className="terminal-prompt">❯</span>
            <input
              value={cmd}
              onChange={(event) => setCmd(event.target.value)}
              placeholder={`直接输入发给 ${current.name} 的底层会话（原样透传，Enter 发送）`}
              spellCheck={false}
              autoComplete="off"
              disabled={sending}
            />
            <button type="submit" disabled={sending || !cmd.trim()}>
              {sending ? "发送中…" : "发送"}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

// ---------- 动态流 ----------

/** 频道栏：大群 + 各部门频道，支持建部门/解散 */
function ChannelBar({
  groups,
  channel,
  onSelect,
  onChanged,
}: {
  groups: OfficeGroup[];
  channel: string;
  onSelect: (channel: string) => void;
  onChanged: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const create = async () => {
    if (!name.trim()) return;
    try {
      const group = await api.createGroup(name.trim());
      setName("");
      setCreating(false);
      setError("");
      onChanged();
      onSelect(group.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const disband = async (group: OfficeGroup) => {
    if (group.name === "综合部") {
      setError("默认部门「综合部」不可解散");
      return;
    }
    if (
      !window.confirm(
        `解散部门「${group.name}」？其下职位回落综合部，部门频道历史消息保留。`,
      )
    )
      return;
    try {
      await api.deleteGroup(group.id);
      if (channel === group.id) onSelect("hall");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const clear = async () => {
    const label =
      channel === "hall" ? "大群" : `#${groups.find((g) => g.id === channel)?.name ?? "频道"}`;
    if (!window.confirm(`清空${label}的全部消息？此操作不可恢复（简报、职位档案笔记不受影响）。`)) {
      return;
    }
    const includeEvents = window.confirm("是否连操作记录（事件时间线）一起清空？\n确定 = 一起清，取消 = 只清消息");
    try {
      const { cleared, clearedEvents } = await api.clearChannel(channel, includeEvents);
      window.alert(
        `已清空 ${cleared} 条消息${includeEvents ? `、${clearedEvents ?? 0} 条操作记录` : ""}`,
      );
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="channel-bar" role="tablist" aria-label="频道">
      <button
        role="tab"
        aria-selected={channel === "hall"}
        className={`channel-tab ${channel === "hall" ? "active" : ""}`}
        onClick={() => onSelect("hall")}
      >
        ⌂ 大群
      </button>
      {groups.map((g) => (
        <span key={g.id} className={`channel-tab-wrap ${channel === g.id ? "active" : ""}`}>
          <button
            role="tab"
            aria-selected={channel === g.id}
            className={`channel-tab ${channel === g.id ? "active" : ""}`}
            onClick={() => onSelect(g.id)}
            title={`部门「${g.name}」（${g.memberCount ?? 0} 人）`}
          >
            # {g.name}
            <em>{g.memberCount ?? 0}</em>
          </button>
          {g.name !== "综合部" && (
            <button
              className="channel-del"
              title={`解散「${g.name}」`}
              onClick={() => void disband(g)}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {creating ? (
        <span className="channel-new">
          <input
            value={name}
            autoFocus
            placeholder="部门名（如 前端 / 平台）"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
              if (e.key === "Escape") setCreating(false);
            }}
          />
          <button className="primary-btn sm" onClick={() => void create()}>
            建部门
          </button>
          <button className="ghost-btn" onClick={() => setCreating(false)}>
            取消
          </button>
        </span>
      ) : (
        <button className="channel-tab channel-add" title="新建部门" onClick={() => setCreating(true)}>
          ＋ 建部门
        </button>
      )}
      <button
        className="channel-tab channel-clear"
        title={`清空当前频道（${channel === "hall" ? "大群" : "部门频道"}）的全部消息`}
        onClick={() => void clear()}
      >
        🧹 清空
      </button>
      {error && <span className="form-error">{error}</span>}
    </div>
  );
}

function Feed({ state, channel }: { state: OfficeState; channel: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [hasNew, setHasNew] = useState(false);
  const [showEvents, setShowEvents] = useState(
    () => localStorage.getItem("office.showEvents") !== "0",
  );

  const toggleEvents = () => {
    setShowEvents((v) => {
      localStorage.setItem("office.showEvents", v ? "0" : "1");
      return !v;
    });
  };

  const bossName = useMemo(
    () => state.agents.find((a) => a.kind === "user")?.name ?? "老板",
    [state.agents],
  );

  const items = useMemo(() => {
    const list: Array<{ key: string; at: number; node: React.ReactNode }> = [];
    // 组频道只看本组成员的事件；大群看全部事件
    const groupMemberIds =
      channel === "hall"
        ? null
        : new Set(
            state.agents.filter((a) => a.groupIds?.includes(channel)).map((a) => a.id),
          );
    const messages = state.messages.filter((m) => (m.channel ?? "hall") === channel);
    for (const m of messages) {
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
              {(m.images?.length ?? 0) > 0 && (
                <div className="msg-images">
                  {m.images!.map((url) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer" title="点击看原图">
                      <img src={url} alt="附图" loading="lazy" />
                    </a>
                  ))}
                </div>
              )}
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
    for (const e of showEvents ? state.events : []) {
      if (groupMemberIds && (!e.agentId || !groupMemberIds.has(e.agentId))) continue;
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
  }, [state, bossName, channel, showEvents]);

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
  }, [items.length, channel]);

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
      <button
        className={`feed-events-toggle ${showEvents ? "" : "off"}`}
        title={showEvents ? "隐藏操作记录（事件时间线）" : "显示操作记录（事件时间线）"}
        onClick={toggleEvents}
      >
        {showEvents ? "👁 操作记录" : "🚫 操作记录"}
      </button>
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
  docs: Array<{
    id: string;
    roleId: string | null;
    title: string;
    tags: string[];
    sourceType?: string;
    origin?: string | null;
    updatedAt: number;
  }>;
}>;

function KbBoard({
  refreshKey,
  onOpenTask,
}: {
  refreshKey: number;
  /** 证据链跳转：点击「task:xxx」来源跳到对应任务时间线 */
  onOpenTask?: (taskId: string) => void;
}) {
  const [catalog, setCatalog] = useState<KbCatalog>([]);
  const [selectedId, setSelectedId] = useState("");
  const [doc, setDoc] = useState<KbDoc | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KbDoc[] | null>(null);
  const [editing, setEditing] = useState<null | { id?: string; category: string; title: string; content: string; tags: string }>(null);
  const [importing, setImporting] = useState<null | "paste" | "url" | "file">(null);
  const [importCategory, setImportCategory] = useState("收录");
  const [importTitle, setImportTitle] = useState("");
  const [importContent, setImportContent] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [error, setError] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [pendingDocs, setPendingDocs] = useState<KbDoc[]>([]);

  const loadCatalog = useCallback(() => {
    api.kbCatalog().then(({ catalog: c }) => setCatalog(c)).catch((e) => setError(e.message));
  }, []);

  const loadPending = useCallback(() => {
    api.kbPending().then(({ docs }) => setPendingDocs(docs)).catch(() => setPendingDocs([]));
  }, []);

  useEffect(loadCatalog, [loadCatalog, refreshKey]);
  useEffect(loadPending, [loadPending, refreshKey]);

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
      loadPending();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const approveDoc = async (id: string) => {
    try {
      await api.kbSetStatus(id, "active");
      loadCatalog();
      loadPending();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setDocStatus = async (id: string, status: "active" | "retired") => {
    try {
      const updated = await api.kbSetStatus(id, status);
      setSelectedId(updated.id);
      setDoc(updated);
      loadCatalog();
      loadPending();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runImport = async () => {
    try {
      let created: KbDoc;
      if (importing === "paste") {
        created = await api.kbImport({
          mode: "paste",
          category: importCategory,
          title: importTitle || undefined,
          content: importContent,
        });
      } else if (importing === "url") {
        created = await api.kbImport({
          mode: "url",
          category: importCategory,
          title: importTitle || undefined,
          url: importUrl,
        });
      } else {
        return;
      }
      setImporting(null);
      setImportContent("");
      setImportUrl("");
      setImportTitle("");
      setSelectedId(created.id);
      setDoc(created);
      loadCatalog();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const importFile = async (file: File) => {
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.slice(result.indexOf(",") + 1));
        };
        reader.onerror = () => reject(new Error("读取文件失败"));
        reader.readAsDataURL(file);
      });
      const created = await api.kbImport({
        mode: "file",
        category: importCategory || "收录",
        title: importTitle || undefined,
        filename: file.name,
        mime: file.type,
        data,
      });
      setImporting(null);
      setSelectedId(created.id);
      setDoc(created);
      loadCatalog();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const SOURCE_LABELS_KB: Record<string, string> = {
    manual: "手写",
    upload: "上传",
    url: "网页",
    pdf: "PDF",
    ai: "AI",
  };

  const totalDocs = catalog.reduce((sum, c) => sum + c.docs.length, 0);
  const filteredCatalog = catalog
    .map((cat) => ({
      ...cat,
      docs: sourceFilter
        ? cat.docs.filter((d) => (d.sourceType ?? "manual") === sourceFilter)
        : cat.docs,
    }))
    .filter((cat) => cat.docs.length > 0);

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
        <div className="kb-import-actions">
          <button className="ghost-btn sm" onClick={() => setImporting("paste")}>
            粘贴收录
          </button>
          <button className="ghost-btn sm" onClick={() => setImporting("url")}>
            URL 收录
          </button>
          <button className="ghost-btn sm" onClick={() => setImporting("file")}>
            文件/PDF
          </button>
        </div>
        {pendingDocs.length > 0 && (
          <div className="kb-pending">
            <h4>
              <span className="tag p1">待审</span> {pendingDocs.length} 篇 AI 沉淀等待批准
            </h4>
            <ul>
              {pendingDocs.map((doc) => (
                <li key={doc.id}>
                  <button type="button" className="task-link" onClick={() => setSelectedId(doc.id)}>
                    <span className="task-title">{doc.title}</span>
                    <span className="task-meta">{doc.category}</span>
                  </button>
                  <button className="ghost-btn sm" onClick={() => void approveDoc(doc.id)}>
                    批准
                  </button>
                  <button
                    className="ghost-btn sm"
                    title="驳回（删除）"
                    onClick={() => void remove(doc.id)}
                  >
                    驳回
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <select
          className="kb-source-filter"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          aria-label="按来源筛选"
        >
          <option value="">全部来源</option>
          <option value="manual">手写</option>
          <option value="upload">上传</option>
          <option value="url">网页</option>
          <option value="pdf">PDF</option>
          <option value="ai">AI</option>
        </select>
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
                <small>
                  {d.category}
                  {d.sourceType ? ` · ${SOURCE_LABELS_KB[d.sourceType] ?? d.sourceType}` : ""}
                </small>
              </button>
            ))}
            {results.length === 0 && <p className="empty">没有匹配的文档。</p>}
          </div>
        ) : (
          <div className="kb-tree">
            {filteredCatalog.length === 0 && (
              <p className="empty">
                知识库还是空的。可新建、粘贴、贴 URL、上传 md/txt/pdf，或由 Agent 用 kb_write 写入。
              </p>
            )}
            {filteredCatalog.map((cat) => (
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
                    <small>
                      {[SOURCE_LABELS_KB[d.sourceType ?? "manual"], ...(d.tags ?? [])]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
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
        {importing && (
          <div className="kb-editor kb-import">
            <h3>
              {importing === "paste"
                ? "粘贴收录"
                : importing === "url"
                  ? "URL 收录"
                  : "文件 / PDF 收录"}
            </h3>
            <input
              placeholder="目录分类"
              value={importCategory}
              onChange={(e) => setImportCategory(e.target.value)}
            />
            <input
              placeholder="标题（可选）"
              value={importTitle}
              onChange={(e) => setImportTitle(e.target.value)}
            />
            {importing === "paste" && (
              <textarea
                rows={12}
                placeholder="粘贴正文…"
                value={importContent}
                onChange={(e) => setImportContent(e.target.value)}
              />
            )}
            {importing === "url" && (
              <input
                placeholder="https://…"
                value={importUrl}
                onChange={(e) => setImportUrl(e.target.value)}
              />
            )}
            {importing === "file" && (
              <input
                type="file"
                accept=".md,.txt,.markdown,.pdf,text/plain,text/markdown,application/pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void importFile(file);
                }}
              />
            )}
            <div className="form-actions">
              {importing !== "file" && (
                <button className="primary-btn sm" onClick={() => void runImport()}>
                  收录
                </button>
              )}
              <button className="ghost-btn" onClick={() => setImporting(null)}>
                取消
              </button>
            </div>
          </div>
        )}
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
                  {doc.status === "pending" && <span className="tag p1">待审</span>}
                  {doc.status === "retired" && <span className="tag">已退役</span>}
                  {doc.sourceType ? `${SOURCE_LABELS_KB[doc.sourceType] ?? doc.sourceType} · ` : ""}
                  {doc.origin ? (
                    doc.origin.startsWith("task:") && onOpenTask ? (
                      <button
                        type="button"
                        className="kb-origin-link"
                        title="跳转到关联任务时间线"
                        onClick={() => onOpenTask(doc.origin.slice("task:".length))}
                      >
                        关联任务 ↗ ·{" "}
                      </button>
                    ) : (
                      `${doc.origin} · `
                    )
                  ) : (
                    ""
                  )}
                  {doc.author ? `${doc.author} · ` : ""}更新于 {timeAgo(doc.updatedAt)}
                  {doc.tags.length > 0 && <> · {doc.tags.map((t) => <span key={t} className="kb-tag">{t}</span>)}</>}
                </p>
              </div>
              <div className="kb-article-actions">
                {doc.status === "pending" && (
                  <button className="primary-btn sm" onClick={() => void approveDoc(doc.id)}>
                    批准
                  </button>
                )}
                {doc.status === "active" && (
                  <button className="ghost-btn sm" onClick={() => void setDocStatus(doc.id, "retired")}>
                    退役
                  </button>
                )}
                {doc.status === "retired" && (
                  <button className="ghost-btn sm" onClick={() => void setDocStatus(doc.id, "active")}>
                    恢复
                  </button>
                )}
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
  const [view, setView] = useState<
    "office" | "pixel" | "live" | "terminal" | "shell" | "logs" | "kb" | "tasks"
  >("office");
  const [channel, setChannel] = useState("hall");
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [onboardTab, setOnboardTab] = useState<OnboardTabId>("cursor");
  const [agentQuery, setAgentQuery] = useState("");
  const [showArchivedAgents, setShowArchivedAgents] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [collapsedDepts, setCollapsedDepts] = useState<Record<string, boolean>>({});
  const refreshTimer = useRef<number | null>(null);

  // 当前频道对应的部门被解散时回到大群
  useEffect(() => {
    if (channel !== "hall" && state && !(state.groups ?? []).some((g) => g.id === channel)) {
      setChannel("hall");
    }
  }, [state, channel]);

  const refresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      api.state()
        .then((nextState) => {
          setState(nextState);
          setSyncError("");
        })
        .catch(() => setSyncError("办公室数据同步中断，正在自动重试。"));
    }, 300);
  }, []);

  useEffect(() => {
    api.state()
      .then((nextState) => {
        setState(nextState);
        setSyncError("");
      })
      .catch(() => setSyncError("无法连接办公室中枢。"));
    api.health().then(setHealth).catch(() => {});
    const source = new EventSource("/api/events");
    source.onmessage = () => refresh();
    source.onerror = () => setSyncError("实时连接中断，正在自动重连。上次数据仍可查看。");
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

  const rosterSelection = useMemo(
    () =>
      state
        ? selectWorkers({
            agents: state.agents,
            tasks: state.tasks,
            query: agentQuery,
            showArchived: showArchivedAgents,
          })
        : { visible: [] as AgentCard[], archivedCount: 0, totalCount: 0 },
    [state, agentQuery, showArchivedAgents],
  );
  const rosterSections = useMemo(
    () => groupRosterByDepartment(rosterSelection.visible, state?.groups ?? []),
    [rosterSelection.visible, state?.groups],
  );
  const toggleDept = (id: string) =>
    setCollapsedDepts((prev) => ({ ...prev, [id]: !prev[id] }));

  const archiveAll = async () => {
    if (
      !window.confirm(
        "确定一键归档全部超期离线员工吗？历史消息、简报与档案都会完整保留，同名工号重新注册会自动复活。",
      )
    ) {
      return;
    }
    try {
      const { archived } = await api.archiveAllStale();
      setSyncError("");
      refresh();
      if (archived > 0) setAgentQuery(""); // 归档后刷新名单
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!state) {
    return (
      <div className="loading">
        <div className="brand-mark big" aria-hidden>
          办
        </div>
        <p>正在连接办公室中枢……</p>
        <p className="loading-sub">
          {syncError || "如果一直停在这里，请先启动中枢："}
          {!syncError && <code>agent-office\启动办公室.bat</code>}
        </p>
        {syncError && <button className="primary-btn" onClick={() => window.location.reload()}>重新连接</button>}
      </div>
    );
  }

  const boss = state.agents.find((a) => a.kind === "user");
  const agents = state.agents.filter((a) => a.kind !== "user");
  const deskAgents = agents.filter((a) => a.kind !== "supervisor");
  const onlineCount = deskAgents.filter((a) => a.status !== "offline").length;

  const systemChips: SystemChip[] = [
    { label: "中枢", ok: Boolean(health), detail: health ? "在线" : "离线" },
    {
      label: "Cursor",
      ok: Boolean(health?.integrations?.cursor.ready),
      detail: health?.integrations?.cursor.ready
        ? "接入完整"
        : health?.integrations?.cursor.issues.join("、") || "状态未加载",
      target: "cursor",
    },
    {
      label: "Codex",
      ok: Boolean(health?.integrations?.codex.ready),
      detail: health?.integrations?.codex.ready
        ? "接入完整"
        : health?.integrations?.codex.issues.join("、") || "状态未加载",
      target: "codex",
    },
    {
      label: "Claude",
      ok: Boolean(health?.integrations?.claude.ready),
      detail: health?.integrations?.claude.ready
        ? "接入完整"
        : health?.integrations?.claude.issues.join("、") || "状态未加载",
      target: "claude",
    },
    {
      label: "ZCode",
      ok: Boolean(health?.integrations?.zcode.ready),
      detail: health?.integrations?.zcode.ready
        ? "接入完整"
        : health?.integrations?.zcode.issues.join("、") || "状态未加载",
      target: "zcode",
    },
    {
      label: "WorkBuddy",
      ok: Boolean(health?.integrations?.workbuddy.ready),
      detail: health?.integrations?.workbuddy.ready
        ? "接入完整"
        : health?.integrations?.workbuddy.issues.join("、") || "状态未加载",
      target: "workbuddy",
    },
    {
      label: "OpenCode",
      ok: Boolean(health?.integrations?.opencode.ready),
      detail: health?.integrations?.opencode.ready
        ? "接入完整"
        : health?.integrations?.opencode.issues.join("、") || "状态未加载",
      target: "opencode",
    },
    {
      label: "Kimi",
      ok: Boolean(health?.integrations?.kimi.ready),
      detail: health?.integrations?.kimi.ready
        ? "接入完整"
        : health?.integrations?.kimi.issues.join("、") || "状态未加载",
      target: "kimi",
    },
    {
      label: "Qoder",
      ok: Boolean(health?.integrations?.qoder.ready),
      detail: health?.integrations?.qoder.ready
        ? "接入完整"
        : health?.integrations?.qoder.issues.join("、") || "状态未加载",
      target: "qoder",
    },
    {
      label: "Kilo",
      ok: Boolean(health?.integrations?.kilo.ready),
      detail: health?.integrations?.kilo.ready
        ? "接入完整"
        : health?.integrations?.kilo.issues.join("、") || "状态未加载",
      target: "kilo",
    },
    {
      label: "Trae",
      ok: Boolean(health?.integrations?.trae.ready),
      detail: health?.integrations?.trae.ready
        ? "接入完整"
        : health?.integrations?.trae.issues.join("、") || "状态未加载",
      target: "trae",
    },
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
            aria-selected={view === "pixel"}
            className={view === "pixel" ? "active" : ""}
            onClick={() => setView("pixel")}
          >
            像素办公室
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
            aria-selected={view === "tasks"}
            className={view === "tasks" ? "active" : ""}
            onClick={() => setView("tasks")}
          >
            任务
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
            aria-selected={view === "shell"}
            className={view === "shell" ? "active" : ""}
            onClick={() => setView("shell")}
          >
            本机终端
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
            {systemChips
              .filter((chip) => !chip.target)
              .map((chip) => (
                <span
                  key={chip.label}
                  className={`sys-dot ${chip.ok ? "ok" : "bad"}`}
                  title={`${chip.label}：${chip.detail}`}
                >
                  {chip.label}
                </span>
              ))}
            <ClientHealthMenu
              chips={systemChips.filter((chip) => Boolean(chip.target))}
              onOpenTab={(tab) => {
                setOnboardTab(tab);
                setOnboardOpen(true);
              }}
            />
          </div>
          <BossNameControl boss={boss} onChanged={refresh} />
          <button className="primary-btn onboard-btn" onClick={() => {
            setOnboardTab("cursor");
            setOnboardOpen(true);
          }}>
            ＋ 接入 Agent
          </button>
        </div>
      </header>

      {syncError && <div className="connection-banner" role="status">{syncError}</div>}

      {view === "pixel" ? (
        <main className="pixel-main">
          <Suspense fallback={<div className="view-loading">正在打开像素办公室…</div>}>
            <PixelOffice state={state} onChanged={refresh} />
          </Suspense>
        </main>
      ) : view === "live" ? (
        <main className="live-main">
          <LiveBoard state={state} />
        </main>
      ) : view === "tasks" ? (
        <main className="tasks-main">
          <TasksBoard
            tasks={state.tasks}
            agents={state.agents}
            briefs={state.briefs}
            focusTaskId={focusTaskId}
            onChanged={refresh}
            onFocusConsumed={() => setFocusTaskId(null)}
          />
        </main>
      ) : view === "terminal" ? (
        <main className="terminal-main">
          <TerminalBoard refreshKey={state.events.length} />
        </main>
      ) : view === "shell" ? (
        <main className="shell-main">
          <Suspense fallback={<div className="view-loading">正在打开本机终端…</div>}>
            <ShellBoard />
          </Suspense>
        </main>
      ) : view === "logs" ? (
        <main className="logs-main">
          <LogsBoard />
        </main>
      ) : view === "kb" ? (
        <main className="kb-page">
          <KbBoard
            refreshKey={state.events.length}
            onOpenTask={(taskId) => {
              setFocusTaskId(taskId);
              setView("tasks");
            }}
          />
        </main>
      ) : (
        <main className="layout">
          <aside className="col col-roster">
            <section className="panel">
              <div className="panel-head">
                <h3>工位</h3>
                <span className="panel-count">
                  {rosterSelection.visible.length}/{rosterSelection.totalCount}
                </span>
              </div>
              <div className="operability-toolbar roster-tools">
                <input
                  type="search"
                  value={agentQuery}
                  onChange={(event) => setAgentQuery(event.target.value)}
                  placeholder="搜索工号、职位、模型"
                  aria-label="搜索工位"
                />
                {rosterSelection.archivedCount > 0 && (
                  <button
                    className={showArchivedAgents ? "active" : ""}
                    onClick={() => setShowArchivedAgents((value) => !value)}
                  >
                    {showArchivedAgents ? "只看当前" : `历史 ${rosterSelection.archivedCount}`}
                  </button>
                )}
                <button
                  className="ghost-btn sm"
                  title="把超期离线（默认 72 小时）且名下无未完成任务的手工会话归档为已离职"
                  onClick={() => void archiveAll()}
                >
                  一键归档
                </button>
              </div>
              <div className="badges">
                {rosterSelection.visible.length === 0 && (
                  <p className="empty">
                    没有匹配的当前工位，可清除搜索、查看历史或新建托管工位。
                  </p>
                )}
                {rosterSections.map((section) => {
                  const collapsed = Boolean(collapsedDepts[section.id]);
                  const onlineInDept = section.agents.filter((a) => a.status !== "offline").length;
                  return (
                    <div key={section.id} className="roster-dept">
                      <button
                        type="button"
                        className="roster-dept-head"
                        onClick={() => toggleDept(section.id)}
                        aria-expanded={!collapsed}
                      >
                        <span className="roster-dept-toggle" aria-hidden>
                          {collapsed ? "▸" : "▾"}
                        </span>
                        <strong>#{section.name}</strong>
                        <em>
                          {onlineInDept}/{section.agents.length}
                        </em>
                      </button>
                      {!collapsed &&
                        section.agents.map((agent) => (
                          <AgentBadge
                            key={agent.id}
                            agent={agent}
                            groups={state.groups ?? []}
                            roles={state.roles ?? []}
                            onMention={(name) => setMentionPrefill(`@${name}`)}
                            onChanged={refresh}
                          />
                        ))}
                    </div>
                  );
                })}
              </div>
              <NewAgentForm onDone={refresh} onOpenShell={() => setView("shell")} />
            </section>
          </aside>

          <section className="col col-center">
            <ChannelBar
              groups={state.groups ?? []}
              channel={channel}
              onSelect={setChannel}
              onChanged={refresh}
            />
            <Feed state={state} channel={channel} />
            <Composer
              agents={state.agents}
              prefill={mentionPrefill}
              channel={channel}
              channelName={
                (state.groups ?? []).find((g) => g.id === channel)?.name ?? "大群"
              }
              onSent={refresh}
            />
          </section>

          <aside className="col col-right">
            <BriefWall
              briefs={state.briefs}
              tasks={state.tasks}
              onOpenTask={(taskId) => {
                setFocusTaskId(taskId);
                setView("tasks");
              }}
            />
            <TaskPanel
              tasks={state.tasks}
              onOpenTasks={() => setView("tasks")}
              onOpenTask={(taskId) => {
                setFocusTaskId(taskId);
                setView("tasks");
              }}
            />
          </aside>
        </main>
      )}

      {onboardOpen && (
        <OnboardModal
          health={health}
          initialTab={onboardTab}
          onHealthChanged={setHealth}
          onClose={() => setOnboardOpen(false)}
        />
      )}
    </div>
  );
}
