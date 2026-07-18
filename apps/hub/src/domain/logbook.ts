import type { LogEntry } from "@agent-office/protocol";
import type { OfficeBus } from "./bus.js";
import { now } from "../util.js";

/**
 * 全办公室统一日志：内存环形缓冲 + SSE 流式推送。
 * 汇聚事件、消息、简报、托管终端、运行错误等所有来源，
 * 供日志页面与 read_logs 工具消费（重启即清空，持久数据仍在各自的表里）。
 */
export class LogBook {
  private entries: LogEntry[] = [];
  private seq = 0;

  constructor(
    private readonly bus: OfficeBus,
    private readonly limit = 2000,
  ) {}

  append(input: {
    level?: LogEntry["level"];
    source: string;
    agentName?: string | null;
    text: string;
  }): void {
    const entry: LogEntry = {
      at: now(),
      level: input.level ?? "info",
      source: input.source,
      agentName: input.agentName ?? null,
      text: input.text.length > 4000 ? `${input.text.slice(0, 4000)}…` : input.text,
    };
    this.entries.push(entry);
    this.seq += 1;
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
    this.bus.publish({ type: "log", payload: entry });
  }

  /** since：只取时间戳严格大于该值的条目（增量拉取用） */
  list(opts: { limit?: number; since?: number; source?: string } = {}): LogEntry[] {
    let list = this.entries;
    if (opts.since) list = list.filter((e) => e.at > opts.since!);
    if (opts.source) list = list.filter((e) => e.source === opts.source);
    const limit = Math.min(opts.limit ?? 200, this.limit);
    return list.slice(-limit);
  }

  get total(): number {
    return this.seq;
  }
}
