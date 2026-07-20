// 一键出包：全量构建 → electron-builder 打 exe → 拷贝到仓库根目录。
// 用法：pnpm dist（每次更新代码后跑一遍，根目录的 exe 永远是最新版）
import { spawnSync } from "node:child_process";
import { copyFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DESKTOP = join(ROOT, "apps/desktop");
const RELEASE = join(DESKTOP, "release");

function run(cmd, cwd) {
  console.log(`\n[dist] ${cmd}`);
  const r = spawnSync(cmd, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`[dist] 失败（退出码 ${r.status}）：${cmd}`);
    process.exit(r.status ?? 1);
  }
}

// 正在运行的桌面客户端会锁住 release/win-unpacked，先请它退出（hub 单独跑的不受影响）
spawnSync("taskkill /im AgentOffice.exe /f /t", { shell: true, stdio: "ignore" });

// 清掉历史输出目录，避免锁残留导致 EBUSY
for (const dir of ["release", "release2"]) {
  try {
    rmSync(join(DESKTOP, dir), { recursive: true, force: true });
  } catch {
    console.warn(`[dist] ${dir} 目录清理失败（可能被占用），electron-builder 会自行处理`);
  }
}

run("pnpm -r build", ROOT);
run("npx electron-builder --win", DESKTOP);

const files = readdirSync(RELEASE);
const portable = files.find((f) => /portable\.exe$/i.test(f));
const setup = files.find((f) => /^AgentOffice Setup .*\.exe$/i.test(f));
if (!portable && !setup) {
  console.error("[dist] release/ 里没找到 exe 产物");
  process.exit(1);
}
if (portable) {
  copyFileSync(join(RELEASE, portable), join(ROOT, "AgentOffice.exe"));
  console.log("[dist] 根目录已更新：AgentOffice.exe（免安装版，双击即用）");
}
if (setup) {
  copyFileSync(join(RELEASE, setup), join(ROOT, "AgentOffice-Setup.exe"));
  console.log("[dist] 根目录已更新：AgentOffice-Setup.exe（安装包）");
}
