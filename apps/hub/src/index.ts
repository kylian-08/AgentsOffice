import { join } from "node:path";
import { loadConfig } from "./config.js";
import { OfficeBus } from "./domain/bus.js";
import { OfficeService } from "./domain/office.js";
import { createManagedDispatcher } from "./domain/runners.js";
import { OfficeStore } from "./domain/store.js";
import { createServer } from "./http/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new OfficeStore(join(config.dataDir, "office.db"));
  const bus = new OfficeBus();
  const office = new OfficeService(store, bus);
  office.setManagedDispatcher(createManagedDispatcher(office, config));

  const app = await createServer(office, config);
  await app.listen({ port: config.port, host: "127.0.0.1" });

  console.log(`[agent-office] 办公室已开门：http://127.0.0.1:${config.port}`);
  console.log(`[agent-office] MCP 端点：http://127.0.0.1:${config.port}/mcp`);
  console.log(`[agent-office] 数据目录：${config.dataDir}`);

  // 手工会话闲置 30 分钟自动标记离席
  office.sweepIdleSessions();
  const sweeper = setInterval(() => office.sweepIdleSessions(), 60_000);

  // 重启不丢活：把上次进程退出时没来得及执行的积压未读重新派发
  const recovered = office.recoverPendingDispatches();
  if (recovered > 0) {
    console.log(`[agent-office] 重启恢复：为 ${recovered} 位托管员工补派了积压消息`);
  }

  const shutdown = async () => {
    clearInterval(sweeper);
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[agent-office] 启动失败：", error);
  process.exit(1);
});
