import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// 建立最小 DOM 环境后再导入渲染模块
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderRunToolbar } = await import("../../../src/components/run-toolbar.js");

const t = (_key, fallback) => fallback || _key;

function makeOpts(overrides = {}) {
  return {
    t,
    getState: () => ({ commands: [], ready: true, runningCount: 0 }),
    onRun: () => {},
    onStopAll: () => {},
    ...overrides,
  };
}

function mount(opts) {
  const wrap = document.createElement("div");
  const controller = renderRunToolbar(wrap, opts);
  return { wrap, controller };
}

const DEV = { id: "npm:dev", labelKey: "run.script.dev", labelFallback: "Dev", cmd: "npm run dev" };
const TEST = { id: "npm:test", labelKey: "run.script.test", labelFallback: "Test", cmd: "npm run test" };

test("运行控件: 未识别到命令时隐藏整个控件（IDEA 无 run configuration 即不显示）", () => {
  const { wrap } = mount(makeOpts({ getState: () => ({ commands: [], ready: true, runningCount: 0 }) }));
  assert.equal(wrap.hidden, true);
});

test("运行控件: 识别未完成（ready=false）时隐藏", () => {
  const { wrap } = mount(makeOpts({ getState: () => ({ commands: [DEV], ready: false, runningCount: 0 }) }));
  assert.equal(wrap.hidden, true);
});

test("运行控件: 识别到命令后显示，主按钮为 Run，单条命令隐藏下拉", () => {
  const { wrap } = mount(makeOpts({ getState: () => ({ commands: [DEV], ready: true, runningCount: 0 }) }));

  assert.equal(wrap.hidden, false);
  const main = wrap.querySelector(".sfe-run-main");
  assert.equal(main.querySelector(".sfe-run-main-label").textContent, "Run");
  assert.equal(main.classList.contains("running"), false);
  assert.equal(wrap.querySelector(".sfe-run-dropdown-btn").hidden, true);
});

test("运行控件: 多条命令时显示下拉，列出全部命令", () => {
  const { wrap } = mount(makeOpts({ getState: () => ({ commands: [DEV, TEST], ready: true, runningCount: 0 }) }));

  assert.equal(wrap.querySelector(".sfe-run-dropdown-btn").hidden, false);
  const items = wrap.querySelectorAll(".sfe-run-dropdown-item");
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /Dev/);
  assert.match(items[1].textContent, /npm run test/);
});

test("运行控件: 点击主按钮运行当前选中命令（默认第一条）", () => {
  let received = null;
  const { wrap } = mount(
    makeOpts({
      getState: () => ({ commands: [DEV, TEST], ready: true, runningCount: 0 }),
      onRun: (cmd) => (received = cmd),
    })
  );
  wrap.querySelector(".sfe-run-main").click();
  assert.equal(received.cmd, "npm run dev");
});

test("运行控件: 有运行中的 run 时主按钮变 Stop（防重复运行），点击即停止全部", () => {
  let stopped = 0;
  let ran = 0;
  const { wrap } = mount(
    makeOpts({
      getState: () => ({ commands: [DEV], ready: true, runningCount: 1 }),
      onRun: () => (ran += 1),
      onStopAll: () => (stopped += 1),
    })
  );

  const main = wrap.querySelector(".sfe-run-main");
  assert.equal(main.querySelector(".sfe-run-main-label").textContent, "Stop");
  assert.equal(main.classList.contains("running"), true);

  main.click();
  assert.equal(stopped, 1);
  assert.equal(ran, 0);
});

test("运行控件: 多个运行中时显示运行计数徽标", () => {
  const { wrap } = mount(makeOpts({ getState: () => ({ commands: [DEV], ready: true, runningCount: 3 }) }));
  const count = wrap.querySelector(".sfe-run-count");
  assert.equal(count.hidden, false);
  assert.equal(count.textContent, "3");

  // 只有一个运行中：不显示计数
  const single = mount(makeOpts({ getState: () => ({ commands: [DEV], ready: true, runningCount: 1 }) }));
  assert.equal(single.wrap.querySelector(".sfe-run-count").hidden, true);
});

test("运行控件: 下拉中选择某条命令触发对应运行并收起下拉", () => {
  let received = null;
  const { wrap } = mount(
    makeOpts({
      getState: () => ({ commands: [DEV, TEST], ready: true, runningCount: 0 }),
      onRun: (cmd) => (received = cmd),
    })
  );

  wrap.querySelector(".sfe-run-dropdown-btn").click();
  assert.equal(wrap.querySelector(".sfe-run-dropdown").hidden, false);

  wrap.querySelectorAll(".sfe-run-dropdown-item")[1].click();
  assert.equal(received.cmd, "npm run test");
  assert.equal(wrap.querySelector(".sfe-run-dropdown").hidden, true);
});

test("运行控件: sync 随状态切换 Run / Stop，命令变化时重建下拉", () => {
  let state = { commands: [DEV], ready: true, runningCount: 0 };
  const { wrap, controller } = mount(makeOpts({ getState: () => state }));

  assert.equal(wrap.querySelector(".sfe-run-main-label").textContent, "Run");

  state = { commands: [DEV], ready: true, runningCount: 1 };
  controller.sync();
  assert.equal(wrap.querySelector(".sfe-run-main-label").textContent, "Stop");

  // 命令集合变化：下拉重建并出现
  state = { commands: [DEV, TEST], ready: true, runningCount: 0 };
  controller.sync();
  assert.equal(wrap.querySelector(".sfe-run-main-label").textContent, "Run");
  assert.equal(wrap.querySelector(".sfe-run-dropdown-btn").hidden, false);
  assert.equal(wrap.querySelectorAll(".sfe-run-dropdown-item").length, 2);
});

test("运行控件: dispose 解绑 document 监听（不抛异常）", () => {
  const { controller } = mount(makeOpts({ getState: () => ({ commands: [DEV], ready: true, runningCount: 0 }) }));
  assert.doesNotThrow(() => controller.dispose());
});
