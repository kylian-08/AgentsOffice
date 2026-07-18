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

  constructor(
    private readonly bus: OfficeBus,
    private readonly limit = 500,
  ) {}

  push(agentId: string, text: string, kind: TermLineKind = "out"): void {
    const buffer = this.buffers.get(agentId) ?? [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      buffer.push({ at: now(), kind, text: line.length > 2000 ? `${line.slice(0, 2000)}…` : line });
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
