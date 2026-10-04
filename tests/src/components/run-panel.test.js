import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// 建立最小 DOM 环境后再导入渲染模块
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderRunPanel, MAX_OUTPUT_CHARS, TRIM_THRESHOLD_CHARS } = await import("../../../src/components/run-panel.js");

const t = (_key, fallback, values) => {
  let out = fallback || _key;
  if (values) {
    for (const [k, v] of Object.entries(values)) out = out.replace(`{{${k}}}`, String(v));
  }
  return out;
};

/** 构造一个运行记录 */
function run(id, status, extra = {}) {
  return {
    id,
    cmd: `npm run ${id}`,
    labelKey: null,
    labelFallback: id,
    status,
    exitCode: null,
    output: "",
    stop: null,
    ptyId: null,
    startTime: Date.now(),
    endTime: null,
    ...extra,
  };
}

/** 构造最小选项对象（运行集合 / 激活项由外部闭包提供，便于用例内改状态）。 */
function makeOpts(overrides = {}) {
  return {
    t,
    getRuns: () => [],
    getActiveId: () => null,
    onSelectTab: () => {},
    onRerun: () => {},
    onStop: () => {},
    onClear: () => {},
    onClose: () => {},
    onMinimize: () => {},
    onCloseAll: () => {},
    ...overrides,
  };
}

function mount(opts) {
  const pane = document.createElement("div");
  const controller = renderRunPanel(pane, opts);
  return { pane, controller };
}

test("运行面板: 每个运行渲染一个 tab，tab 名 = 运行配置名", () => {
  const runs = [run("dev", "running"), run("test", "exited", { exitCode: 0 })];
  const { pane } = mount(makeOpts({ getRuns: () => runs, getActiveId: () => "dev" }));

  const tabs = pane.querySelectorAll(".sfe-run-tab");
  assert.equal(tabs.length, 2);
  assert.match(tabs[0].textContent, /dev/);
  assert.match(tabs[1].textContent, /test/);
  // 激活 tab 有 active 标记
  assert.ok(tabs[0].classList.contains("active"));
  assert.ok(!tabs[1].classList.contains("active"));
});

test("运行面板: tab 状态点反映运行状态（running 与 exited 的类名不同）", () => {
  const runs = [run("dev", "running"), run("test", "exited", { exitCode: 0 })];
  const { pane } = mount(makeOpts({ getRuns: () => runs, getActiveId: () => "dev" }));
  const tabs = pane.querySelectorAll(".sfe-run-tab");
  assert.ok(tabs[0].classList.contains("status-running"));
  assert.ok(tabs[1].classList.contains("status-exited"));
});

test("运行面板: 点击 tab 回调对应 id", () => {
  const runs = [run("dev", "running"), run("test", "exited")];
  let selected = null;
  const { pane } = mount(
    makeOpts({ getRuns: () => runs, getActiveId: () => "dev", onSelectTab: (id) => (selected = id) })
  );
  pane.querySelectorAll(".sfe-run-tab")[1].click();
  assert.equal(selected, "test");
});

test("运行面板: tab 关闭按钮回调 onClose 且不触发 onSelectTab", () => {
  const runs = [run("dev", "running")];
  let closed = null;
  let selected = null;
  const { pane } = mount(
    makeOpts({ getRuns: () => runs, getActiveId: () => "dev", onClose: (id) => (closed = id), onSelectTab: (id) => (selected = id) })
  );
  pane.querySelector(".sfe-run-tab-close").click();
  assert.equal(closed, "dev");
  assert.equal(selected, null);
});

test("运行面板: 不再渲染冗余的命令列表（命令入口归右上角控件与右键菜单）", () => {
  const runs = [run("dev", "running")];
  const { pane } = mount(makeOpts({ getRuns: () => runs, getActiveId: () => "dev" }));
  assert.equal(pane.querySelectorAll(".sfe-run-cmd").length, 0);
});

test("运行面板: toolbar 显示激活 tab 的状态徽章与命令", () => {
  const runs = [run("dev", "running")];
  const { pane } = mount(makeOpts({ getRuns: () => runs, getActiveId: () => "dev" }));

  const badge = pane.querySelector(".sfe-run-badge");
  assert.equal(badge.textContent, "运行中");
  assert.ok(badge.classList.contains("status-running"));
  assert.equal(pane.querySelector(".sfe-run-current").textContent, "npm run dev");
});

test("运行面板: syncStatus 依据状态更新徽章与按钮显隐", () => {
  const dev = run("dev", "running");
  const runs = [dev];
  const { pane, controller } = mount(makeOpts({ getRuns: () => runs, getActiveId: () => "dev" }));

  const badge = pane.querySelector(".sfe-run-badge");
  const stop = pane.querySelector(".sfe-run-action[title='停止']");
  const rerun = pane.querySelector(".sfe-run-action[title='重新运行']");
  assert.equal(stop.hidden, false);
  assert.equal(rerun.hidden, true);

  dev.status = "exited";
  dev.exitCode = 0;
  controller.syncStatus();
  assert.equal(badge.textContent, "已退出（代码 0）");
  assert.equal(stop.hidden, true);
  assert.equal(rerun.hidden, false);

  dev.status = "stopped";
  controller.syncStatus();
  assert.equal(badge.textContent, "已停止");
});

test("运行面板: 动作按钮回调对应激活 tab 的 id", () => {
  const runs = [run("dev", "running"), run("test", "exited")];
  const calls = { rerun: null, stop: null, clear: null };
  const { pane } = mount(
    makeOpts({
      getRuns: () => runs,
      getActiveId: () => "test",
      onRerun: (id) => (calls.rerun = id),
      onStop: (id) => (calls.stop = id),
      onClear: (id) => (calls.clear = id),
    })
  );
  pane.querySelector(".sfe-run-action[title='重新运行']").click();
  pane.querySelector(".sfe-run-action[title='清空输出']").click();
  assert.equal(calls.rerun, "test");
  assert.equal(calls.clear, "test");
  // test 已退出：停止按钮隐藏，但回调仍绑定在激活 tab 上
  pane.querySelector(".sfe-run-action[title='停止']").click();
  assert.equal(calls.stop, "test");
});

test("运行面板: 顶部同时保留最小化与关闭按钮，各自触发对应回调", () => {
  const runs = [run("dev", "running")];
  let minimized = 0;
  let closed = 0;
  const { pane } = mount(
    makeOpts({
      getRuns: () => runs,
      getActiveId: () => "dev",
      onMinimize: () => (minimized += 1),
      onCloseAll: () => (closed += 1),
    })
  );
  // 用户诉求：即使任务全部结束，关闭按钮旁也要有最小化按钮——两者始终并存。
  const minimizeBtn = pane.querySelector(".sfe-run-collapse.minimize");
  const closeBtn = pane.querySelector(".sfe-run-collapse.close");
  assert.ok(minimizeBtn, "应始终存在最小化按钮");
  assert.ok(closeBtn, "应始终存在关闭按钮");
  // 用户诉求：最小化按钮排在关闭按钮之后。
  const collapseBtns = pane.querySelectorAll(".sfe-run-tabs .sfe-run-collapse");
  assert.equal(collapseBtns.length, 2);
  assert.ok(collapseBtns[0].classList.contains("close"), "关闭按钮在前");
  assert.ok(collapseBtns[1].classList.contains("minimize"), "最小化按钮在后");

  minimizeBtn.click();
  assert.equal(minimized, 1);
  assert.equal(closed, 0);

  closeBtn.click();
  assert.equal(closed, 1);
  assert.equal(minimized, 1);
});

test("运行面板: 全部任务结束后最小化按钮仍保留（不再切换为单一关闭按钮）", () => {
  const dev = run("dev", "running");
  const runs = [dev];
  const { pane, controller } = mount(makeOpts({ getRuns: () => runs, getActiveId: () => "dev" }));

  dev.status = "stopped";
  controller.syncStatus();

  assert.ok(pane.querySelector(".sfe-run-collapse.minimize"), "任务结束后最小化按钮必须保留");
  assert.ok(pane.querySelector(".sfe-run-collapse.close"), "关闭按钮必须同时存在");
});

test("运行面板: 输出区展示激活 tab 的输出，appendOutput 只更新激活 tab", () => {
  const runs = [run("dev", "running", { output: "dev line\n" }), run("test", "running", { output: "test line\n" })];
  const { pane, controller } = mount(makeOpts({ getRuns: () => runs, getActiveId: () => "dev" }));

  const output = pane.querySelector(".sfe-run-output");
  assert.equal(output.textContent, "dev line\n");

  // 非激活 tab 的输出到达：不显示在输出区（等切过去再看）
  controller.appendOutput("test", "ignored\n");
  assert.equal(output.textContent, "dev line\n");

  // 激活 tab 的输出到达：增量追加
  controller.appendOutput("dev", "more\n");
  assert.equal(output.textContent, "dev line\nmore\n");
});

test("运行面板: appendOutput 增量追加（不整体重写 textContent，节点数与 chunk 数同步增长）", () => {
  const runs = [run("dev", "starting", { output: "" })];
  const { pane, controller } = mount(makeOpts({ getRuns: () => runs, getActiveId: () => "dev" }));
  const output = pane.querySelector(".sfe-run-output");
  // 启动期：输出区只有占位提示节点，无文本节点。
  assert.equal(output.childNodes.length, 1);
  assert.ok(output.querySelector(".sfe-run-output-hint"), "初始只有占位提示");

  controller.appendOutput("dev", "a");
  controller.appendOutput("dev", "b");
  controller.appendOutput("dev", "c");

  // 增量语义：占位被移除，每个 chunk 追加一个文本节点，既有节点不被重写（O(chunk) 而非 O(n²)）。
  assert.equal(output.childNodes.length, 3);
  assert.ok([...output.childNodes].every((n) => n.nodeType === 3), "全部应为文本节点");
  assert.equal(output.textContent, "abc");
});

test("运行面板: 启动期无输出时显示占位提示，有输出后消失", () => {
  const dev = run("dev", "starting", { output: "" });
  const runs = [dev];
  const { pane, controller } = mount(makeOpts({ getRuns: () => runs, getActiveId: () => "dev" }));

  const output = pane.querySelector(".sfe-run-output");
  const hint = pane.querySelector(".sfe-run-output-hint");
  assert.ok(hint, "启动中且无输出时应显示占位提示");
  assert.equal(hint.textContent, "启动中…");

  // 有真实输出：占位立即移除。
  controller.appendOutput("dev", "hello\n");
  assert.equal(pane.querySelector(".sfe-run-output-hint"), null);
  assert.equal(output.textContent, "hello\n");
});

test("运行面板: 启动失败且无输出时占位移除（syncStatus 同步占位显隐）", () => {
  const dev = run("dev", "starting", { output: "" });
  const runs = [dev];
  const { pane, controller } = mount(makeOpts({ getRuns: () => runs, getActiveId: () => "dev" }));
  assert.ok(pane.querySelector(".sfe-run-output-hint"), "初始应有占位");

  dev.status = "failed";
  controller.syncStatus();
  assert.equal(pane.querySelector(".sfe-run-output-hint"), null, "失败且无输出时占位必须移除");
});

test("运行面板: rebuild 切换激活 tab 后展示其输出", () => {
  const runs = [run("dev", "running", { output: "dev line\n" }), run("test", "running", { output: "test line\n" })];
  let activeId = "dev";
  const { pane, controller } = mount(makeOpts({ getRuns: () => runs, getActiveId: () => activeId }));

  const output = pane.querySelector(".sfe-run-output");
  assert.equal(output.textContent, "dev line\n");

  activeId = "test";
  controller.rebuild();
  assert.equal(output.textContent, "test line\n");
  // 激活 tab 已切换
  const tabs = pane.querySelectorAll(".sfe-run-tab");
  assert.ok(tabs[1].classList.contains("active"));
});

test("运行面板: 输出达到裁剪阈值时裁剪早期内容并提示（保留尾部）", () => {
  const runs = [run("dev", "running")];
  const { pane, controller } = mount(makeOpts({ getRuns: () => runs, getActiveId: () => "dev" }));
  const output = pane.querySelector(".sfe-run-output");

  // 未达阈值：纯增量追加，不触发整体重写。
  controller.appendOutput("dev", "a".repeat(TRIM_THRESHOLD_CHARS));
  assert.equal(output.textContent.length, TRIM_THRESHOLD_CHARS);

  // 越过阈值：整体重写为尾部片段 + 裁剪提示。
  controller.appendOutput("dev", "b".repeat(1000));
  assert.match(output.textContent, /已裁剪早期内容/);
  assert.ok(output.textContent.length <= MAX_OUTPUT_CHARS + 40);
  assert.ok(output.textContent.endsWith("b".repeat(1000)));
});

test("运行面板: captureScroll 把输出区滚动位置写回激活 tab", () => {
  const dev = run("dev", "running");
  const runs = [dev];
  const { pane, controller } = mount(makeOpts({ getRuns: () => runs, getActiveId: () => "dev" }));
  const output = pane.querySelector(".sfe-run-output");
  output.scrollTop = 123;
  controller.captureScroll();
  assert.equal(dev.scrollTop, 123);
});
