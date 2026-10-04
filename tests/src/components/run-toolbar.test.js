import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// 建立最小 DOM 环境后再导入渲染模块
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderRunToolbar } = await import("../../../src/components/run-toolbar.js");

// t 桩：支持 {{name}} / {{count}} 占位替换（与宿主 api.t 的 values 语义一致）
const t = (_key, fallback, values) => {
  let out = fallback || _key;
  if (values) {
    for (const [k, v] of Object.entries(values)) out = out.split(`{{${k}}}`).join(String(v));
  }
  return out;
};

const DEV = { id: "npm:dev", labelKey: null, labelFallback: "dev", cmd: "npm run dev" };
const BUILD = { id: "npm:build", labelKey: null, labelFallback: "build", cmd: "npm run build" };

function makeOpts(overrides = {}) {
  return {
    t,
    getState: () => ({ commands: [], ready: true, isCommandRunning: () => false, runningCommands: [] }),
    onRun: () => {},
    onRerun: () => {},
    onStop: () => {},
    ...overrides,
  };
}

function mount(opts) {
  const wrap = document.createElement("div");
  const controller = renderRunToolbar(wrap, opts);
  return { wrap, controller };
}

test("运行控件: 未识别到命令时隐藏整个控件（IDEA 无 run configuration 即不显示）", () => {
  const { wrap } = mount(makeOpts());
  assert.equal(wrap.hidden, true);
});

test("运行控件: 识别未完成（ready=false）时隐藏", () => {
  const { wrap } = mount(
    makeOpts({ getState: () => ({ commands: [DEV], ready: false, isCommandRunning: () => false, runningCommands: [] }) })
  );
  assert.equal(wrap.hidden, true);
});

test("运行控件: 常显当前配置名；未运行时主按钮为空心态（无 Stop / 无 ⋮）", () => {
  const { wrap } = mount(
    makeOpts({ getState: () => ({ commands: [DEV], ready: true, isCommandRunning: () => false, runningCommands: [] }) })
  );

  assert.equal(wrap.hidden, false);
  assert.equal(wrap.querySelector(".sfe-run-config-name").textContent, "dev");
  // 主按钮为纯图标：未运行 = 空心（无 running 类），title 提示「运行 dev」
  const main = wrap.querySelector(".sfe-run-main");
  assert.equal(main.classList.contains("running"), false);
  assert.equal(main.title, "运行 dev");
  assert.equal(wrap.querySelector(".sfe-run-stop").hidden, true);
  assert.equal(wrap.querySelector(".sfe-run-more"), null, "⋮ 更多停止选项已移除");
});

test("运行控件: 多条命令时配置下拉列出全部配置（只显示名字，不显示命令原文）", () => {
  const { wrap } = mount(
    makeOpts({ getState: () => ({ commands: [DEV, BUILD], ready: true, isCommandRunning: () => false, runningCommands: [] }) })
  );

  wrap.querySelector(".sfe-run-config").click();
  assert.equal(wrap.querySelector(".sfe-run-dropdown").hidden, false);
  const items = wrap.querySelectorAll(".sfe-run-dropdown-item");
  assert.equal(items.length, 2);
  assert.equal(items[0].querySelector(".sfe-run-dropdown-label").textContent, "dev");
  assert.equal(items[1].querySelector(".sfe-run-dropdown-label").textContent, "build");
  // 命令原文不再展示（只在 title 里）
  assert.doesNotMatch(items[0].textContent, /npm run/);
  assert.equal(items[0].title, "npm run dev");
});

test("运行控件: 点击主按钮运行当前选中配置（默认第一条）", () => {
  let received = null;
  const { wrap } = mount(
    makeOpts({
      getState: () => ({ commands: [DEV, BUILD], ready: true, isCommandRunning: () => false, runningCommands: [] }),
      onRun: (cmd) => (received = cmd),
    })
  );
  wrap.querySelector(".sfe-run-main").click();
  assert.equal(received.id, "npm:dev");
});

test("运行控件: 选中配置运行中 → 主按钮变实心 Rerun，Stop 出现且只停该配置", () => {
  let reran = null;
  let stopped = null;
  let ran = 0;
  const { wrap } = mount(
    makeOpts({
      getState: () => ({ commands: [DEV], ready: true, isCommandRunning: (c) => c.id === "npm:dev", runningCommands: [DEV] }),
      onRun: () => (ran += 1),
      onRerun: (c) => (reran = c),
      onStop: (c) => (stopped = c),
    })
  );

  const main = wrap.querySelector(".sfe-run-main");
  assert.equal(main.classList.contains("running"), true);
  assert.equal(main.title, "重新运行 dev");
  assert.equal(wrap.querySelector(".sfe-run-config-icon").classList.contains("running"), true);

  main.click();
  assert.equal(reran.id, "npm:dev");
  assert.equal(ran, 0);

  const stop = wrap.querySelector(".sfe-run-stop");
  assert.equal(stop.hidden, false);
  assert.equal(stop.title, "停止 dev");
  stop.click();
  assert.equal(stopped.id, "npm:dev");
});

test("运行控件: 别的配置在跑但当前选中未跑 → 主按钮仍为空心、无 Stop（不被全局状态带动）", () => {
  let received = null;
  const { wrap } = mount(
    makeOpts({
      getState: () => ({ commands: [DEV, BUILD], ready: true, isCommandRunning: (c) => c.id === "npm:build", runningCommands: [BUILD] }),
      onRun: (c) => (received = c),
    })
  );

  assert.equal(wrap.querySelector(".sfe-run-main").classList.contains("running"), false);
  assert.equal(wrap.querySelector(".sfe-run-stop").hidden, true);

  wrap.querySelector(".sfe-run-main").click();
  assert.equal(received.id, "npm:dev");
});

test("运行控件: 顶栏不再有 ⋮ 更多停止选项（逐条/全部停止已移到运行窗口工具栏）", () => {
  const { wrap } = mount(
    makeOpts({ getState: () => ({ commands: [DEV, BUILD], ready: true, isCommandRunning: () => true, runningCommands: [DEV, BUILD] }) })
  );
  assert.equal(wrap.querySelector(".sfe-run-more"), null);
  assert.equal(wrap.querySelector(".sfe-run-more-menu"), null);
});

test("运行控件: 下拉点行体仅选择（不运行）并高亮；点行内 ▶ 运行该配置", () => {
  let ran = 0;
  let received = null;
  const { wrap } = mount(
    makeOpts({
      getState: () => ({ commands: [DEV, BUILD], ready: true, isCommandRunning: () => false, runningCommands: [] }),
      onRun: (c) => {
        ran += 1;
        received = c;
      },
    })
  );

  wrap.querySelector(".sfe-run-config").click();
  const items = wrap.querySelectorAll(".sfe-run-dropdown-item");

  // 点行体：仅选择
  items[1].click();
  assert.equal(ran, 0);
  assert.equal(wrap.querySelector(".sfe-run-dropdown").hidden, true);
  assert.equal(items[1].classList.contains("active"), true);
  assert.equal(items[0].classList.contains("active"), false);
  assert.equal(wrap.querySelector(".sfe-run-config-name").textContent, "build");

  // 主按钮运行被选中的 build
  wrap.querySelector(".sfe-run-main").click();
  assert.equal(received.id, "npm:build");
  assert.equal(ran, 1);

  // 重新打开下拉，点行内 ▶：选择并立即运行
  wrap.querySelector(".sfe-run-config").click();
  const items2 = wrap.querySelectorAll(".sfe-run-dropdown-item");
  items2[0].querySelector(".sfe-run-dropdown-run").click();
  assert.equal(ran, 2);
  assert.equal(received.id, "npm:dev");
  assert.equal(wrap.querySelector(".sfe-run-dropdown").hidden, true);
});

test("运行控件: sync 随状态切换空心 / 实心 与 Stop 显隐", () => {
  let state = { commands: [DEV], ready: true, isCommandRunning: () => false, runningCommands: [] };
  const { wrap, controller } = mount(makeOpts({ getState: () => state }));

  assert.equal(wrap.querySelector(".sfe-run-main").classList.contains("running"), false);

  state = { commands: [DEV], ready: true, isCommandRunning: (c) => c.id === "npm:dev", runningCommands: [DEV] };
  controller.sync();
  assert.equal(wrap.querySelector(".sfe-run-main").classList.contains("running"), true);
  assert.equal(wrap.querySelector(".sfe-run-stop").hidden, false);

  state = { commands: [DEV], ready: true, isCommandRunning: () => false, runningCommands: [] };
  controller.sync();
  assert.equal(wrap.querySelector(".sfe-run-main").classList.contains("running"), false);
  assert.equal(wrap.querySelector(".sfe-run-stop").hidden, true);
});

test("运行控件: dispose 解绑 document 监听（不抛异常）", () => {
  const { controller } = mount(
    makeOpts({ getState: () => ({ commands: [DEV], ready: true, isCommandRunning: () => false, runningCommands: [] }) })
  );
  assert.doesNotThrow(() => controller.dispose());
});

test("运行控件: 多包命令按文件夹分组，组名变化处显示分组标题（父包在前）", () => {
  const ROOT = { id: "npm:dev", labelKey: null, labelFallback: "dev", cmd: "npm run dev", dir: "", group: null };
  const API = {
    id: "npm:api:start",
    labelKey: null,
    labelFallback: "api/start",
    cmd: "npm --prefix api run start",
    dir: "api",
    group: "api",
  };
  const { wrap } = mount(
    makeOpts({ getState: () => ({ commands: [ROOT, API], ready: true, isCommandRunning: () => false, runningCommands: [] }) })
  );
  wrap.querySelector(".sfe-run-config").click();
  // 根包用本地化「根目录」文案；子包显示目录路径
  assert.deepEqual(
    [...wrap.querySelectorAll(".sfe-run-dropdown-group")].map((n) => n.textContent),
    ["根目录", "api"]
  );
  // 分组标题不是可点命令项
  assert.equal(wrap.querySelectorAll(".sfe-run-dropdown-item").length, 2);
});
