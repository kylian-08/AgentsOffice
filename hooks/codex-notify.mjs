// Codex notify 转发器：argv JSON → Hub /ingest/codex-notify
// Hub 不在线时静默失败，不影响 Codex 本身。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const configuredBase = /^https?:\/\//.test(process.argv[2] ?? "") ? process.argv[2] : null;
const configuredChain = configuredBase && process.argv[3]?.endsWith("codex-notify-chain.json")
  ? process.argv[3]
  : null;
const arg = configuredChain ? process.argv[4] : configuredBase ? process.argv[3] : process.argv[2];
if (!arg) process.exit(0);

let payload = {};
try {
  payload = JSON.parse(arg);
} catch {
  process.exit(0);
}

const base = configuredBase || process.env.AGENT_OFFICE_URL || "http://127.0.0.1:4517";

if (configuredChain) {
  try {
    const command = JSON.parse(readFileSync(configuredChain, "utf8")).command;
    if (
      Array.isArray(command) &&
      command.length > 0 &&
      command.every((item) => typeof item === "string") &&
      !command.some((item) => item.includes("codex-notify.mjs"))
    ) {
      const child = spawn(command[0], [...command.slice(1), arg], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", () => {});
      child.unref();
    }
  } catch {
    /* 保留 Agent Office 转发，不让原 Notify 失败阻塞 Codex */
  }
}

try {
  await fetch(`${base}/ingest/codex-notify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(2000),
  });
} catch {
  /* 静默 */
}
