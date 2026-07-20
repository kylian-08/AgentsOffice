// 像素办公室：Pixel Agents 风格的可视化楼层。
// 每位成员一个小人：busy 坐工位敲键盘、online 在楼层里溜达、offline 在休息区打盹；
// 说话冒气泡；点小人可上传/生成/清除人物形象（库洛米、皮卡丘随便换）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentCard, AgentMeta } from "@agent-office/protocol";
import { api, type OfficeState } from "./api";

/** 楼层逻辑坐标系：0-100 × 0-100（渲染时按容器等比缩放） */
interface Actor {
  x: number;
  y: number;
  tx: number;
  ty: number;
  /** 下次换目标的时间戳（休闲漫步节奏） */
  nextWanderAt: number;
  facing: 1 | -1;
}

interface Bubble {
  agentName: string;
  text: string;
  until: number;
}

const REST_Y = 88; // 休息区（楼层底部沙发）
const SPEED = 6; // 每秒移动的逻辑单位

/** 工位坐标：两列桌子，错落排布 */
function deskSlot(index: number): { x: number; y: number } {
  const col = index % 3;
  const row = Math.floor(index / 3);
  return { x: 16 + col * 30, y: 20 + row * 24 };
}

function hashHue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** 默认像素小人（没上传形象时）：按名字配色的 CSS 像素人 */
function DefaultSprite({ name }: { name: string }) {
  const hue = hashHue(name);
  return (
    <div className="px-default" style={{ ["--hue" as string]: hue }}>
      <div className="px-hair" />
      <div className="px-face" />
      <div className="px-body" />
      <div className="px-legs" />
    </div>
  );
}

function statusOf(agent: AgentCard): "busy" | "online" | "offline" {
  return agent.status === "busy" ? "busy" : agent.status === "offline" ? "offline" : "online";
}

export function PixelOffice({
  state,
  onChanged,
}: {
  state: OfficeState;
  onChanged: () => void;
}) {
  const floorRef = useRef<HTMLDivElement>(null);
  const actorsRef = useRef(new Map<string, Actor>());
  const nodesRef = useRef(new Map<string, HTMLDivElement>());
  const [selected, setSelected] = useState<string | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [busyAction, setBusyAction] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const crew = useMemo(
    () => state.agents.filter((a) => a.kind !== "user"),
    [state.agents],
  );
  const deskAgents = useMemo(() => crew.filter((a) => a.kind !== "supervisor"), [crew]);

  // 新消息/简报 → 冒 8 秒气泡
  const lastSeenRef = useRef<number>(Date.now());
  useEffect(() => {
    const fresh: Bubble[] = [];
    for (const m of state.messages) {
      if (m.createdAt > lastSeenRef.current && crew.some((a) => a.name === m.fromName)) {
        fresh.push({ agentName: m.fromName, text: m.text, until: Date.now() + 8000 });
      }
    }
    for (const b of state.briefs) {
      if (b.createdAt > lastSeenRef.current && crew.some((a) => a.name === b.agentName)) {
        fresh.push({ agentName: b.agentName, text: b.title, until: Date.now() + 8000 });
      }
    }
    if (fresh.length > 0) {
      lastSeenRef.current = Date.now();
      setBubbles((prev) => [...prev.filter((x) => x.until > Date.now()), ...fresh].slice(-12));
    }
  }, [state.messages, state.briefs, crew]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setBubbles((prev) => (prev.some((b) => b.until <= Date.now()) ? prev.filter((b) => b.until > Date.now()) : prev));
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  // 游戏循环：目标点驱动的走路 + 直接改 DOM（不经 React 渲染）
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      deskAgents.forEach((agent, i) => {
        const desk = deskSlot(i);
        let actor = actorsRef.current.get(agent.id);
        if (!actor) {
          actor = { x: desk.x, y: desk.y, tx: desk.x, ty: desk.y, nextWanderAt: 0, facing: 1 };
          actorsRef.current.set(agent.id, actor);
        }
        const st = statusOf(agent);
        if (st === "busy") {
          // 回工位干活
          actor.tx = desk.x;
          actor.ty = desk.y;
        } else if (st === "offline") {
          // 去休息区打盹（按 index 排开）
          actor.tx = 12 + (i % 6) * 15;
          actor.ty = REST_Y;
        } else if (now >= actor.nextWanderAt) {
          // 在楼层里随便走走（避开休息区）
          actor.tx = 10 + Math.random() * 80;
          actor.ty = 15 + Math.random() * 55;
          actor.nextWanderAt = now + 3000 + Math.random() * 6000;
        }
        const dx = actor.tx - actor.x;
        const dy = actor.ty - actor.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.5) {
          const step = Math.min(SPEED * dt, dist);
          actor.x += (dx / dist) * step;
          actor.y += (dy / dist) * step;
          if (Math.abs(dx) > 0.3) actor.facing = dx > 0 ? 1 : -1;
        }
        const node = nodesRef.current.get(agent.id);
        if (node) {
          node.style.left = `${actor.x}%`;
          node.style.top = `${actor.y}%`;
          const walking = dist > 0.5 && st !== "busy";
          node.dataset.state = st === "busy" ? "typing" : walking ? "walking" : st === "offline" ? "sleeping" : "idle";
          node.dataset.facing = String(actor.facing);
        }
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [deskAgents]);

  const selectedAgent = crew.find((a) => a.id === selected) ?? null;

  const uploadSprite = useCallback(
    async (file: File) => {
      if (!selectedAgent) return;
      setBusyAction(true);
      setError("");
      try {
        const { url } = await api.uploadImage(file);
        await api.updateAgent(selectedAgent.id, { spriteUrl: url });
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyAction(false);
      }
    },
    [selectedAgent, onChanged],
  );

  const generateSprite = useCallback(async () => {
    if (!selectedAgent) return;
    const desc = window.prompt(
      "描述想要的人物形象（交给本机 codex 画一张像素风 SVG）",
      "可爱的像素风小人",
    );
    if (!desc?.trim()) return;
    setBusyAction(true);
    setError("");
    try {
      await api.generateAvatar(selectedAgent.id, `像素画风格（pixel art），${desc.trim()}`);
      // 生成的是 avatarSvg；若之前有上传形象则清掉，让新生成的生效
      if ((selectedAgent.meta as AgentMeta).spriteUrl) {
        await api.updateAgent(selectedAgent.id, { spriteUrl: "" });
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(false);
    }
  }, [selectedAgent, onChanged]);

  const clearSprite = useCallback(async () => {
    if (!selectedAgent) return;
    setBusyAction(true);
    setError("");
    try {
      await api.updateAgent(selectedAgent.id, { spriteUrl: "" });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(false);
    }
  }, [selectedAgent, onChanged]);

  return (
    <div className="pixel-office">
      <div className="pixel-floor" ref={floorRef} onClick={() => setSelected(null)}>
        {/* 工位桌椅 */}
        {deskAgents.map((agent, i) => {
          const desk = deskSlot(i);
          return (
            <div
              key={`desk-${agent.id}`}
              className="px-desk"
              style={{ left: `${desk.x}%`, top: `${desk.y + 4}%` }}
              title={`${agent.name} 的工位`}
            >
              <div className="px-monitor" />
              <div className="px-table" />
            </div>
          );
        })}
        {/* 休息区沙发 */}
        <div className="px-couch" style={{ left: "8%", top: `${REST_Y + 3}%` }} title="休息区">
          🛋️
        </div>
        <div className="px-plant" style={{ left: "94%", top: "12%" }}>🪴</div>
        <div className="px-plant" style={{ left: "4%", top: "12%" }}>🪴</div>

        {/* 成员小人 */}
        {deskAgents.map((agent) => {
          const m = agent.meta as AgentMeta;
          const bubble = bubbles.filter((b) => b.agentName === agent.name).at(-1);
          return (
            <div
              key={agent.id}
              ref={(el) => {
                if (el) nodesRef.current.set(agent.id, el);
                else nodesRef.current.delete(agent.id);
              }}
              className={`px-actor st-${statusOf(agent)} ${selected === agent.id ? "selected" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setSelected(agent.id);
                setError("");
              }}
              title={`${agent.name} · ${agent.status}${m.title ? ` · ${m.title}` : ""}`}
            >
              {bubble && <div className="px-bubble">{bubble.text.slice(0, 60)}</div>}
              <div className="px-sprite">
                {m.spriteUrl ? (
                  <img src={m.spriteUrl} alt={agent.name} draggable={false} />
                ) : m.avatarSvg ? (
                  <span
                    className="px-svg"
                    dangerouslySetInnerHTML={{ __html: m.avatarSvg }}
                  />
                ) : (
                  <DefaultSprite name={agent.name} />
                )}
                <span className="px-status-dot" />
                <span className="px-emote" aria-hidden />
              </div>
              <div className="px-name">
                {agent.name}
                {m.title && <em>{m.title}</em>}
              </div>
            </div>
          );
        })}

        {deskAgents.length === 0 && (
          <div className="px-empty">还没有员工入驻，先在「办公室」页接入或新建工位。</div>
        )}
      </div>

      {/* 选中成员的形象面板 */}
      {selectedAgent && (
        <div className="px-panel" onClick={(e) => e.stopPropagation()}>
          <div className="px-panel-head">
            <strong>{selectedAgent.name}</strong>
            <span className="muted">
              {(selectedAgent.meta as AgentMeta).title ?? ""} · {selectedAgent.status}
            </span>
            <button className="icon-btn" title="关闭" onClick={() => setSelected(null)}>
              ×
            </button>
          </div>
          {(selectedAgent.meta as AgentMeta).lastActivity && (
            <p className="px-panel-activity">{(selectedAgent.meta as AgentMeta).lastActivity}</p>
          )}
          <div className="px-panel-actions">
            <button
              className="primary-btn sm"
              disabled={busyAction}
              onClick={() => fileRef.current?.click()}
            >
              上传形象图
            </button>
            <button className="ghost-btn" disabled={busyAction} onClick={() => void generateSprite()}>
              AI 生成形象
            </button>
            {(selectedAgent.meta as AgentMeta).spriteUrl && (
              <button className="ghost-btn" disabled={busyAction} onClick={() => void clearSprite()}>
                清除形象
              </button>
            )}
          </div>
          <p className="px-panel-hint">
            支持 PNG / GIF / WebP（透明底最佳）。想要库洛米、皮卡丘、吉伊卡哇？
            找一张透明底立绘传上来就行。
          </p>
          {error && <div className="form-error">{error}</div>}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadSprite(f);
              e.target.value = "";
            }}
          />
        </div>
      )}
    </div>
  );
}
