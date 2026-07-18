import type { AgentCard } from "@agent-office/protocol";
import { cliExists, runCli, sha1 } from "../util.js";

const PALETTES: Array<[string, string, string]> = [
  ["#2f6f6a", "#e8f3f1", "#c14b3a"],
  ["#4a5d8f", "#eef1f8", "#d9903f"],
  ["#8f4a6b", "#f8eef3", "#3f7bd9"],
  ["#5d7a3c", "#f2f6ea", "#b3543f"],
  ["#7a5d3c", "#f6f1ea", "#3f8fb3"],
  ["#3c5d7a", "#eaf1f6", "#c4783a"],
];

/** 本地确定性几何头像：名字哈希 → 对称格点图案（无需外部依赖的兜底方案） */
export function identiconSvg(name: string): string {
  const hash = sha1(`avatar:${name}`);
  const palette = PALETTES[parseInt(hash.slice(0, 2), 16) % PALETTES.length];
  const [fg, bg, accent] = palette;
  const cells: string[] = [];
  const size = 5;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < Math.ceil(size / 2); col += 1) {
      const bit = parseInt(hash[(row * 3 + col + 2) % hash.length], 16) % 2 === 0;
      if (!bit) continue;
      const useAccent = parseInt(hash[(row + col + 7) % hash.length], 16) % 5 === 0;
      const fill = useAccent ? accent : fg;
      const x = 8 + col * 10;
      const y = 8 + row * 10;
      cells.push(`<rect x="${x}" y="${y}" width="9" height="9" rx="2" fill="${fill}"/>`);
      const mirror = size - 1 - col;
      if (mirror !== col) {
        cells.push(`<rect x="${8 + mirror * 10}" y="${y}" width="9" height="9" rx="2" fill="${fill}"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img"><rect width="64" height="64" rx="14" fill="${bg}"/>${cells.join("")}</svg>`;
}

/** 只接受纯图形 SVG，拒绝脚本 / 事件 / 外链，防止把可执行内容渲染进页面 */
export function sanitizeSvg(raw: string): string | null {
  const match = raw.match(/<svg[\s\S]*?<\/svg>/i);
  if (!match) return null;
  const svg = match[0];
  if (svg.length > 30_000) return null;
  if (/<script|<foreignObject|<iframe|javascript:|\son\w+\s*=|href\s*=|xlink:/i.test(svg)) {
    return null;
  }
  return svg;
}

/**
 * 生成员工头像：优先交给本机 codex 出一张扁平几何 SVG，
 * codex 不可用或输出不合规时回退到本地几何头像。
 */
export async function generateAvatar(
  agent: AgentCard,
  stylePrompt?: string,
): Promise<{ svg: string; source: "codex" | "identicon" }> {
  if (await cliExists("codex")) {
    const title = (agent.meta as { title?: string }).title;
    const prompt = [
      `请为一位 AI 办公室成员设计一个 64x64 的扁平几何风格 SVG 头像。`,
      `成员花名：${agent.name}；类型：${agent.kind}${title ? `；职位：${title}` : ""}。`,
      stylePrompt ? `风格要求：${stylePrompt}` : "配色沉稳雅致，形状简洁有辨识度，可以有一点角色感。",
      `硬性要求：只输出一个 <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">…</svg> 标签本身，`,
      `不要 markdown 代码块、不要解释文字；只允许纯图形元素（rect/circle/path/polygon/g/defs/linearGradient），`,
      `禁止 script、事件属性、image、href、foreignObject。`,
    ].join("\n");
    const result = await runCli(
      "codex",
      ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-"],
      { timeoutMs: 120_000, stdinData: prompt },
    );
    const svg = sanitizeSvg(result.stdout);
    if (svg) return { svg, source: "codex" };
  }
  return { svg: identiconSvg(agent.name), source: "identicon" };
}
