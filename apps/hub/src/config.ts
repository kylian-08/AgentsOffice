import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OfficeConfig {
  port: number;
  dataDir: string;
  cursorModel: string;
  /** 托管 Codex 运行单轮的超时（毫秒） */
  codexTurnTimeoutMs: number;
  /** 同时运行的托管回合上限（全局并发闸门），默认 3 */
  maxConcurrentRuns?: number;
}

export const OFFICE_HOME = join(homedir(), ".agent-office");
const CONFIG_PATH = join(OFFICE_HOME, "config.json");

export const DEFAULT_PORT = 4517;

export function loadConfig(): OfficeConfig {
  mkdirSync(OFFICE_HOME, { recursive: true });
  let raw: Partial<OfficeConfig> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch {
      raw = {};
    }
  }
  const config: OfficeConfig = {
    port: Number(process.env.AGENT_OFFICE_PORT ?? raw.port ?? DEFAULT_PORT),
    dataDir: raw.dataDir ?? OFFICE_HOME,
    cursorModel: raw.cursorModel ?? "composer-2.5",
    codexTurnTimeoutMs: raw.codexTurnTimeoutMs ?? 10 * 60_000,
    maxConcurrentRuns: Number(process.env.AGENT_OFFICE_MAX_RUNS ?? raw.maxConcurrentRuns ?? 3),
  };
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  }
  return config;
}
