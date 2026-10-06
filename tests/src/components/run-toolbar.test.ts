import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { RunToolbarHandle, RunToolbarOptions, RunToolbarSnapshot } from "../../../src/components/run-toolbar.ts";
import type { FlatRunCommand } from "../../../src/services/project-commands.ts";
import type { TranslateFn } from "../../../src/types/panel-state.ts";

// 建立最小 DOM 环境后再导入渲染模块
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderRunToolbar } = await import("../../../src/components/run-toolbar.ts");

// t 桩：支持 {{name}} / {{count}} 占位替换（与宿主 api.t 的 values 语义一致）
const t: TranslateFn = (_key, fallback, values) => {
  let out = fallback || _key;
  if (values) {
    for (const [k, v] of Object.entries(values)) out = out.split(`{{${k}}}`).join(String(v));
  }
  return out;
};

/**
 * 运行配置桩（FlatRunCommand 的真实形状：id / labelKey / labelFallback / cmd / icon / ecosystem / dir / group 均必填）。
 * @description `icon` 控件用于画配置图标（缺省时组件也回退 package），`ecosystem` / `dir` / `group` 来自
 *   flattenCommands 的生态与分包归属；本组用例都是根包单命令，故 dir 取 ""、group 取 null（与宿主根包一致）。
 */
const DEV: FlatRunCommand = { id: "npm:dev", labelKey: null, labelFallback: "dev", cmd: "npm run dev", icon: "package", ecosystem: "npm", dir: "", group: null };
const BUILD: FlatRunCommand = { id: "npm:build", labelKey: null, labelFallback: "build", cmd: "npm run build", icon: "package", ecosystem: "npm", dir: "", group: null };

/**
 * 本文件控件读取的状态切片（RunToolbarSnapshot 只声明 commands / ready / isCommandRunning 三项，
 * 与 index.ts 的 renderRunToolbarView 里真实 getState 返回一致）。
 * @param overrides 覆盖默认切片的字段。
 */
function snapshot(overrides: Partial<RunToolbarSnapshot> = {}): RunToolbarSnapshot {
  return { commands: [], ready: true, isCommandRunning: () => false, ...overrides };
}

function makeOpts(overrides: Partial<RunToolbarOptions> = {}): RunToolbarOptions {
  return {
    t,
    getState: () => snapshot(),
    onRun: () => {},
    onRerun: () => {},
    onStop: () => {},
    ...overrides,
  };
}

/** mount 的返回：控件容器与刷新 / 卸载句柄。 */
type MountedToolbar = {
  /** 控件容器（组件在其内部渲染配置选择器、主按钮、Stop 与下拉）。 */
  wrap: HTMLDivElement;
  /** renderRunToolbar 的句柄。 */
  controller: RunToolbarHandle;
};

function mount(opts: RunToolbarOptions): MountedToolbar {
  const wrap = document.createElement("div");
  const controller = renderRunToolbar(wrap, opts);
  return { wrap, controller };
}

/**
 * 取容器内必然存在的元素。
 * !: 元素缺失即组件没渲染该控件（用例随后直接解引用，运行时同样会抛 TypeError），
 *   故在唯一的查询出口收窄一次非空，不改变运行时行为。
 */
const q = <T extends Element>(parent: ParentNode, selector: string): T => parent.querySelector<T>(selector)!;

test("运行控件: 未识别到命令时隐藏整个控件（IDEA 无 run configuration 即不显示）", () => {
  const { wrap } = mount(makeOpts());
  assert.equal(wrap.hidden, true);
});

test("运行控件: 识别未完成（ready=false）时隐藏", () => {
  const { wrap } = mount(
    makeOpts({ getState: () => snapshot({ commands: [DEV], ready: false }) })
  );
  assert.equal(wrap.hidden, true);
});

test("运行控件: 常显当前配置名；未运行时主按钮为空心态（无 Stop / 无 ⋮）", () => {
  const { wrap } = mount(
    makeOpts({ getState: () => snapshot({ commands: [DEV] }) })
  );

  assert.equal(wrap.hidden, false);
  assert.equal(q<HTMLElement>(wrap, ".sfe-run-config-name").textContent, "dev");
  // 主按钮为纯图标：未运行 = 空心（无 running 类），title 提示「运行 dev」
  const main = q<HTMLButtonElement>(wrap, ".sfe-run-main");
  assert.equal(main.classList.contains("running"), false);
  assert.equal(main.title, "运行 dev");
  assert.equal(q<HTMLButtonElement>(wrap, ".sfe-run-stop").hidden, true);
  assert.equal(wrap.querySelector(".sfe-run-more"), null, "⋮ 更多停止选项已移除");
});

test("运行控件: 多条命令时配置下拉列出全部配置（只显示名字，不显示命令原文）", () => {
  const { wrap } = mount(
    makeOpts({ getState: () => snapshot({ commands: [DEV, BUILD] }) })
  );

  q<HTMLButtonElement>(wrap, ".sfe-run-config").click();
  assert.equal(q<HTMLElement>(wrap, ".sfe-run-dropdown").hidden, false);
  const items = [...wrap.querySelectorAll<HTMLElement>(".sfe-run-dropdown-item")];
  assert.equal(items.length, 2);
  assert.equal(q<HTMLElement>(items[0], ".sfe-run-dropdown-label").textContent, "dev");
  assert.equal(q<HTMLElement>(items[1], ".sfe-run-dropdown-label").textContent, "build");
  // 命令原文不再展示（只在 title 里）
  assert.doesNotMatch(items[0].textContent, /npm run/);
  assert.equal(items[0].title, "npm run dev");
});

test("运行控件: 点击主按钮运行当前选中配置（默认第一条）", () => {
  // 回调在 click() 内同步触发，TS 不跨闭包追踪赋值，故读取处用 `!` 收窄一次：
  // 命令未回传时原写法同样会抛 TypeError，断言语义不变。
  let received: FlatRunCommand | null = null;
  const { wrap } = mount(
    makeOpts({
      getState: () => snapshot({ commands: [DEV, BUILD] }),
      onRun: (cmd) => (received = cmd),
    })
  );
  q<HTMLButtonElement>(wrap, ".sfe-run-main").click();
  assert.equal(received!.id, "npm:dev");
});

test("运行控件: 选中配置运行中 → 主按钮变实心 Rerun，Stop 出现且只停该配置", () => {
  let reran: FlatRunCommand | null = null;
  let stopped: FlatRunCommand | null = null;
  let ran = 0;
  const { wrap } = mount(
    makeOpts({
      getState: () => snapshot({ commands: [DEV], isCommandRunning: (c) => c.id === "npm:dev" }),
      onRun: () => (ran += 1),
      onRerun: (c) => (reran = c),
      onStop: (c) => (stopped = c),
    })
  );

  const main = q<HTMLButtonElement>(wrap, ".sfe-run-main");
  assert.equal(main.classList.contains("running"), true);
  assert.equal(main.title, "重新运行 dev");
  assert.equal(q<HTMLElement>(wrap, ".sfe-run-config-icon").classList.contains("running"), true);

  main.click();
  assert.equal(reran!.id, "npm:dev");
  assert.equal(ran, 0);

  const stop = q<HTMLButtonElement>(wrap, ".sfe-run-stop");
  assert.equal(stop.hidden, false);
  assert.equal(stop.title, "停止 dev");
  stop.click();
  assert.equal(stopped!.id, "npm:dev");
});

test("运行控件: 别的配置在跑但当前选中未跑 → 主按钮仍为空心、无 Stop（不被全局状态带动）", () => {
  let received: FlatRunCommand | null = null;
  const { wrap } = mount(
    makeOpts({
      getState: () => snapshot({ commands: [DEV, BUILD], isCommandRunning: (c) => c.id === "npm:build" }),
      onRun: (c) => (received = c),
    })
  );

  assert.equal(q<HTMLButtonElement>(wrap, ".sfe-run-main").classList.contains("running"), false);
  assert.equal(q<HTMLButtonElement>(wrap, ".sfe-run-stop").hidden, true);

  q<HTMLButtonElement>(wrap, ".sfe-run-main").click();
  assert.equal(received!.id, "npm:dev");
});

test("运行控件: 顶栏不再有 ⋮ 更多停止选项（逐条/全部停止已移到运行窗口工具栏）", () => {
  const { wrap } = mount(
    makeOpts({ getState: () => snapshot({ commands: [DEV, BUILD], isCommandRunning: () => true }) })
  );
  assert.equal(wrap.querySelector(".sfe-run-more"), null);
  assert.equal(wrap.querySelector(".sfe-run-more-menu"), null);
});

test("运行控件: 下拉点行体仅选择（不运行）并高亮；点行内 ▶ 运行该配置", () => {
  let ran = 0;
  let received: FlatRunCommand | null = null;
  const { wrap } = mount(
    makeOpts({
      getState: () => snapshot({ commands: [DEV, BUILD] }),
      onRun: (c) => {
        ran += 1;
        received = c;
      },
    })
  );

  q<HTMLButtonElement>(wrap, ".sfe-run-config").click();
  const items = [...wrap.querySelectorAll<HTMLElement>(".sfe-run-dropdown-item")];

  // 点行体：仅选择
  items[1].click();
  assert.equal(ran, 0);
  assert.equal(q<HTMLElement>(wrap, ".sfe-run-dropdown").hidden, true);
  assert.equal(items[1].classList.contains("active"), true);
  assert.equal(items[0].classList.contains("active"), false);
  assert.equal(q<HTMLElement>(wrap, ".sfe-run-config-name").textContent, "build");

  // 主按钮运行被选中的 build
  q<HTMLButtonElement>(wrap, ".sfe-run-main").click();
  assert.equal(received!.id, "npm:build");
  assert.equal(ran, 1);

  // 重新打开下拉，点行内 ▶：选择并立即运行
  q<HTMLButtonElement>(wrap, ".sfe-run-config").click();
  const items2 = [...wrap.querySelectorAll<HTMLElement>(".sfe-run-dropdown-item")];
  q<HTMLButtonElement>(items2[0], ".sfe-run-dropdown-run").click();
  assert.equal(ran, 2);
  assert.equal(received!.id, "npm:dev");
  assert.equal(q<HTMLElement>(wrap, ".sfe-run-dropdown").hidden, true);
});

test("运行控件: sync 随状态切换空心 / 实心 与 Stop 显隐", () => {
  let state: RunToolbarSnapshot = snapshot({ commands: [DEV] });
  const { wrap, controller } = mount(makeOpts({ getState: () => state }));

  assert.equal(q<HTMLButtonElement>(wrap, ".sfe-run-main").classList.contains("running"), false);

  state = snapshot({ commands: [DEV], isCommandRunning: (c) => c.id === "npm:dev" });
  controller.sync();
  assert.equal(q<HTMLButtonElement>(wrap, ".sfe-run-main").classList.contains("running"), true);
  assert.equal(q<HTMLButtonElement>(wrap, ".sfe-run-stop").hidden, false);

  state = snapshot({ commands: [DEV] });
  controller.sync();
  assert.equal(q<HTMLButtonElement>(wrap, ".sfe-run-main").classList.contains("running"), false);
  assert.equal(q<HTMLButtonElement>(wrap, ".sfe-run-stop").hidden, true);
});

test("运行控件: dispose 解绑 document 监听（不抛异常）", () => {
  const { controller } = mount(
    makeOpts({ getState: () => snapshot({ commands: [DEV] }) })
  );
  assert.doesNotThrow(() => controller.dispose());
});

test("运行控件: 多包命令按文件夹分组，组名变化处显示分组标题（父包在前）", () => {
  const ROOT: FlatRunCommand = { id: "npm:dev", labelKey: null, label: "dev", labelFallback: "dev", cmd: "npm run dev", icon: "package", ecosystem: "npm", dir: "", group: null };
  const API: FlatRunCommand = {
    id: "npm:api:start",
    labelKey: null,
    label: "start",
    labelFallback: "api/start",
    cmd: "npm --prefix api run start",
    icon: "package",
    ecosystem: "npm",
    dir: "api",
    group: "api",
  };
  const { wrap } = mount(
    makeOpts({ getState: () => snapshot({ commands: [ROOT, API] }) })
  );
  q<HTMLButtonElement>(wrap, ".sfe-run-config").click();
  // 根包用本地化「根目录」文案；子包显示目录路径
  assert.deepEqual(
    [...wrap.querySelectorAll<HTMLElement>(".sfe-run-dropdown-group")].map((n) => n.textContent),
    ["根目录", "api"]
  );
  // 条目只显示纯 script 名（包由分组标题表达，条目里不重复路径）
  assert.deepEqual(
    [...wrap.querySelectorAll<HTMLElement>(".sfe-run-dropdown-label")].map((n) => n.textContent),
    ["dev", "start"]
  );
  // 分组标题不是可点命令项
  assert.equal(wrap.querySelectorAll(".sfe-run-dropdown-item").length, 2);
});


test("运行控件: Maven 多模块只显示根 test/package 和真实模块 main，不显示模块重复构建命令", () => {
  const commands: FlatRunCommand[] = [
    { id: "maven:test", labelKey: null, label: "test", labelFallback: "test", cmd: "mvn test", icon: "package", ecosystem: "maven", dir: "", group: null },
    { id: "maven:package", labelKey: null, label: "package", labelFallback: "package", cmd: "mvn package", icon: "package", ecosystem: "maven", dir: "", group: null },
    {
      id: "maven:admin:main:com-nzygyt-GytApplication",
      labelKey: null,
      label: "GytApplication",
      labelFallback: "admin/GytApplication",
      cmd: "mvn spring-boot:run -Dspring-boot.run.main-class=com.nzygyt.GytApplication",
      icon: "java",
      ecosystem: "maven",
      dir: "nzygyt-admin",
      group: "nzygyt-admin",
      mainClass: "com.nzygyt.GytApplication",
    },
  ];
  const { wrap } = mount(
    makeOpts({ getState: () => snapshot({ commands }) })
  );
  q<HTMLButtonElement>(wrap, ".sfe-run-config").click();
  assert.deepEqual(
    [...wrap.querySelectorAll<HTMLElement>(".sfe-run-dropdown-group")].map((node) => node.textContent),
    ["根目录", "nzygyt-admin"]
  );
  assert.deepEqual(
    [...wrap.querySelectorAll<HTMLElement>(".sfe-run-dropdown-label")].map((node) => node.textContent),
    ["test", "package", "GytApplication"]
  );
});

