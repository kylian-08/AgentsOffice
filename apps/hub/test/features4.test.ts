import { describe, expect, it } from "vitest";
import { OfficeBus } from "../src/domain/bus.js";
import { LogBook } from "../src/domain/logbook.js";
import { OfficeService } from "../src/domain/office.js";
import { OfficeStore } from "../src/domain/store.js";

function makeOffice() {
  const store = new OfficeStore(":memory:");
  return new OfficeService(store, new OfficeBus());
}

describe("统一日志流", () => {
  it("消息、事件、简报、终端全部汇入，且经 SSE 总线广播", () => {
    const bus = new OfficeBus();
    const seen: unknown[] = [];
    bus.subscribe((e) => {
      if ((e as { type: string }).type === "log") seen.push(e);
    });
    const office = new OfficeService(new OfficeStore(":memory:"), bus);
    const agent = office.store.registerAgent({ name: "codex-a", kind: "codex-managed" });

    office.sendMessage({ fromName: "老板", text: "@codex-a 开工" });
    office.terminals.push(agent.id, "$ npm test", "cmd");
    office.publishBrief({
      agentName: "codex-a",
      kind: "manual",
      source: "mcp",
      brief: { title: "完工", result: "测试通过" },
    });

    const sources = office.logs.list().map((l) => l.source);
    expect(sources).toContain("message");
    expect(sources).toContain("event"); // route 事件
    expect(sources).toContain("terminal");
    expect(sources).toContain("brief");
    expect(seen.length).toBeGreaterThanOrEqual(4);
  });

  it("支持 since 增量与 source 过滤，容量有上限", () => {
    const bus = new OfficeBus();
    const logs = new LogBook(bus, 10);
    for (let i = 0; i < 15; i += 1) {
      logs.append({ source: i % 2 === 0 ? "message" : "event", text: `第${i}条` });
    }
    expect(logs.list({ limit: 100 })).toHaveLength(10);
    expect(logs.list({ source: "message" }).every((l) => l.source === "message")).toBe(true);
    const mid = logs.list({ limit: 100 })[4].at;
    const after = logs.list({ since: mid, limit: 100 });
    expect(after.every((l) => l.at > mid)).toBe(true);
    // 错误级别标记
    logs.append({ source: "event", level: "error", text: "执行失败" });
    expect(logs.list({ limit: 1 })[0].level).toBe("error");
  });
});

describe("公共知识库", () => {
  it("新增、目录索引、读取、更新、删除全链路", () => {
    const office = makeOffice();
    const created = office.kbWrite({
      category: "网络代理",
      title: "git push 连接被重置",
      content: "【问题现象】push GitHub 报 Connection was reset\n【解决步骤】走本地 7890 代理",
      tags: ["git", "proxy"],
      author: "codex-a",
    });
    expect(created?.created).toBe(true);

    office.kbWrite({
      category: "构建打包",
      title: "pnpm 忽略构建脚本",
      content: "allowBuilds 配置 esbuild",
      author: "老板",
    });

    const catalog = office.store.kbCatalog();
    expect(catalog).toHaveLength(2);
    expect(catalog.map((c) => c.category).sort()).toEqual(["构建打包", "网络代理"]);
    expect(catalog.find((c) => c.category === "网络代理")!.docs[0].tags).toEqual(["git", "proxy"]);

    const doc = office.store.getKbDoc(created!.doc.id)!;
    expect(doc.content).toContain("7890");
    expect(doc.author).toBe("codex-a");

    const updated = office.kbWrite({
      id: doc.id,
      category: "网络代理",
      title: doc.title,
      content: `${doc.content}\n【验证方式】git push 成功`,
      author: "老板",
    });
    expect(updated?.created).toBe(false);
    expect(office.store.getKbDoc(doc.id)!.content).toContain("验证方式");

    expect(office.kbDelete(doc.id)).toBe(true);
    expect(office.store.getKbDoc(doc.id)).toBeNull();
    expect(office.kbDelete(doc.id)).toBe(false);
  });

  it("关键词搜索命中标题/正文/标签/分类", () => {
    const office = makeOffice();
    office.kbWrite({
      category: "Windows 环境",
      title: "taskkill 杀不掉进程树",
      content: "shell:true 只杀 cmd 壳，需要 /T /F",
      tags: ["进程"],
      author: "codex-a",
    });
    expect(office.store.searchKbDocs("taskkill")).toHaveLength(1);
    expect(office.store.searchKbDocs("cmd 壳")).toHaveLength(1);
    expect(office.store.searchKbDocs("进程")).toHaveLength(1);
    expect(office.store.searchKbDocs("Windows")).toHaveLength(1);
    expect(office.store.searchKbDocs("不存在的词")).toHaveLength(0);
  });

  it("更新不存在的文档返回 null", () => {
    const office = makeOffice();
    expect(
      office.kbWrite({ id: "no-such", category: "x", title: "y", content: "z" }),
    ).toBeNull();
  });
});

describe("办公室上下文对所有 Agent 开放", () => {
  it("get_context 返回花名册（含职位/模型）、任务、简报、知识库目录、老板称呼", () => {
    const office = makeOffice();
    const agent = office.store.registerAgent({
      name: "codex-a",
      kind: "codex-managed",
      meta: { model: "gpt-5.6", title: "测试" },
    });
    void agent;
    office.createTask({ title: "修 bug" });
    office.publishBrief({
      agentName: "codex-a",
      kind: "manual",
      source: "mcp",
      brief: { title: "阶段成果", result: "完成一半" },
    });
    office.kbWrite({ category: "杂症", title: "某问题", content: "某方案" });

    const context = office.getContext();
    expect(context.bossName).toBe("老板");
    const me = context.roster.find((r) => r.name === "codex-a")!;
    expect(me.model).toBe("gpt-5.6");
    expect(me.title).toBe("测试");
    expect(context.openTasks).toHaveLength(1);
    expect(context.briefs).toHaveLength(1);
    expect(context.kbCatalog).toHaveLength(1);
    expect(context.kbCatalog[0].docs[0].title).toBe("某问题");
  });
});
