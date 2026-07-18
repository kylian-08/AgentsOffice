import type { OfficeBus } from "./bus.js";
import { now } from "../util.js";

export type TermLineKind = "cmd" | "out" | "info" | "error" | "final";

export interface TermLine {
  at: number;
  kind: TermLineKind;
  text: string;
}

/**
 * 托管工位的实时终端缓冲：每个 Agent 一条环形日志，
 * 经 SSE 通知前端增量拉取，不落库（重启即清空）。
 */
export class TerminalLog {
  private buffers = new Map<string, TermLine[]>();
  /** 每写入一行同时回调（用于汇入统一日志流） */
  onLine: ((agentId: string, line: TermLine) => void) | null = null;

  constructor(
    private readonly bus: OfficeBus,
    private readonly limit = 500,
  ) {}

  push(agentId: string, text: string, kind: TermLineKind = "out"): void {
    const buffer = this.buffers.get(agentId) ?? [];
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const line: TermLine = {
        at: now(),
        kind,
        text: raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw,
      };
      buffer.push(line);
      this.onLine?.(agentId, line);
    }
    if (buffer.length > this.limit) buffer.splice(0, buffer.length - this.limit);
    this.buffers.set(agentId, buffer);
    this.bus.publish({ type: "terminal", payload: { agentId } });
  }

  get(agentId: string): TermLine[] {
    return this.buffers.get(agentId) ?? [];
  }

  snapshot(): Record<string, TermLine[]> {
    return Object.fromEntries(this.buffers);
  }

  clear(agentId: string): void {
    this.buffers.delete(agentId);
  }
}
