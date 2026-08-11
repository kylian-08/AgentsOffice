// 把 hub 打成单文件 ESM、编译 Electron 主进程、拷贝 web 静态资源到 dist/
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, "..");
const HUB = join(DESKTOP, "../hub");
const WEB_DIST = join(DESKTOP, "../web/dist");
const HOOKS = join(DESKTOP, "../../hooks");
const OUT = join(DESKTOP, "dist");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "resources"), { recursive: true });

if (!existsSync(WEB_DIST)) {
  console.error("[desktop] 缺少 apps/web/dist，请先执行 pnpm --filter @agent-office/web build");
  process.exit(1);
}

// hub：单文件 ESM；@cursor/sdk 是 webpack 产物没法二次打包，保持 external、随后装成真实 node_modules
await build({
  entryPoints: [join(HUB, "src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(OUT, "resources/hub/index.mjs"),
  external: ["@cursor/sdk", "@lydell/node-pty"],
  banner: {
    js: "import { createRequire as __cr } from 'node:module';const require = __cr(import.meta.url);",
  },
  logLevel: "warning",
});

// 给 hub bundle 配一份真实依赖（托管 Cursor 用的 SDK），让 import("@cursor/sdk") 能在运行时解析
writeFileSync(
  join(OUT, "resources/hub/package.json"),
  JSON.stringify(
    {
      name: "agent-office-hub",
      private: true,
      dependencies: { "@cursor/sdk": "^1.0.23", "@lydell/node-pty": "1.2.0-beta.12" },
    },
    null,
    2,
  ),
);
const npmInstall = spawnSync(
  "npm install --omit=dev --no-audit --no-fund --loglevel=error",
  { cwd: join(OUT, "resources/hub"), stdio: "inherit", shell: true },
);
console.log("[desktop] npm install 退出码:", npmInstall.status);
if (npmInstall.status !== 0) {
  console.error("[desktop] @cursor/sdk 安装失败（托管 Cursor 需要它）");
  process.exit(1);
}
console.log("[desktop] hub bundle 完成");

// stdio MCP 代理：单独打成自包含 ESM（SDK 打进产物），供 WorkBuddy 等 stdio 客户端调用。
// 主进程通过 AGENT_OFFICE_STDIO_ENTRY 把它注入安装命令。
await build({
  entryPoints: [join(HUB, "src/mcp/stdio.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(OUT, "resources/stdio.js"),
  external: [],
  logLevel: "warning",
});
console.log("[desktop] stdio MCP 代理编译完成");

// Electron 主进程：CJS
await build({
  entryPoints: [join(DESKTOP, "src/main.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: join(OUT, "main.cjs"),
  external: ["electron"],
  logLevel: "warning",
});

console.log("[desktop] 主进程编译完成");

// Node 24 的 cpSync 在 Windows 上会触发 0xC0000409 崩溃，手写递归拷贝绕开
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else copyFileSync(from, to);
  }
}
copyDir(WEB_DIST, join(OUT, "resources/web"));
copyDir(HOOKS, join(OUT, "resources/hooks"));
console.log("[desktop] bundle 完成 → apps/desktop/dist");
