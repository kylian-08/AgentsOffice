// ZCode hook 转发器：stdin JSON → Hub /ingest/zcode-hook → stdout JSON
// Hub 不在线时 fail-open，输出 {} 不阻塞 ZCode。
import { readFileSync } from "node:fs";

const base = process.argv[2] || process.env.AGENT_OFFICE_URL || "http://127.0.0.1:4517";

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  /* 保持空对象 */
}

try {
  const res = await fetch(`${base}/ingest/zcode-hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(2000),
  });
  const out = res.ok ? await res.json() : {};
  process.stdout.write(JSON.stringify(out ?? {}));
} catch {
  process.stdout.write("{}");
}
