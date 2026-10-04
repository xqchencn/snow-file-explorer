import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// 建立最小 DOM 环境后再导入渲染模块（node 环境无 DOM）。
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderToolWindow } = await import("../../../src/components/tool-window.js");

/** 翻译桩：支持 {{name}} 占位替换（与宿主 api.t 的 values 语义一致）。 */
const t = (_key, fallback, values) => {
  let out = fallback || _key;
  if (values) {
    for (const [name, value] of Object.entries(values)) {
      out = out.split(`{{${name}}}`).join(String(value));
    }
  }
  return out;
};

/**
 * 假终端工厂：记录每次创建，便于断言 write/fit/focus/dispose/clear/scrollToBottom 与输入回调。
 * @returns {{createTerminal: Function, created: Array}}
 */
function makeFactory() {
  const created = [];
  const createTerminal = (host, opts) => {
    const record = {
      host,
      opts,
      writes: [],
      fit: 0,
      focus: 0,
      cleared: 0,
      scrolled: 0,
      disposed: 0,
      cols: 80,
      rows: 24,
    };
    record.view = {
      write: (data) => record.writes.push(data),
      fit: () => {
        record.fit += 1;
      },
      focus: () => {
        record.focus += 1;
      },
      clear: () => {
        record.cleared += 1;
      },
      scrollToBottom: () => {
        record.scrolled += 1;
      },
      get cols() {
        return record.cols;
      },
      get rows() {
        return record.rows;
      },
      dispose: () => {
        record.disposed += 1;
      },
    };
    created.push(record);
    return record.view;
  };
  return { createTerminal, created };
}

/** 构造一条终端记录（与 index.js 的 state.terminals 元素同构）。 */
function term(id, title, extra = {}) {
  return {
    id,
    title: title || id,
    mode: "terminal",
    session: null,
    exited: false,
    exitCode: null,
    onInput: null,
    onResize: null,
    pendingCommand: "",
    ...extra,
  };
}

function makeOpts(overrides = {}) {
  const factory = overrides.factory || makeFactory();
  return {
    t,
    kind: "terminal",
    getTerminals: () => [],
    getActiveId: () => null,
    createTerminal: factory.createTerminal,
    onSelectTab: () => {},
    onNewTerminal: () => {},
    onCloseTerminal: () => {},
    onMinimize: () => {},
    factory,
    ...overrides,
  };
}

function mount(opts) {
  const pane = document.createElement("div");
  const controller = renderToolWindow(pane, opts);
  return { pane, controller };
}

// ───────────────────────── 终端窗口（kind=terminal）─────────────────────────

test("工具窗口: 终端窗口空集合渲染 ＋新建(末尾) + ⊖收起，无 tab 与终端宿主", () => {
  const { pane } = mount(makeOpts());
  assert.equal(pane.querySelectorAll(".sfe-run-tab").length, 0);
  assert.ok(pane.querySelector(".sfe-run-collapse.new"), "终端窗口必须有新建按钮");
  assert.ok(pane.querySelector(".sfe-run-collapse.minimize"), "必须有收起按钮");
  assert.equal(pane.querySelectorAll(".sfe-run-terminal-host").length, 0);
  // 终端窗口没有运行工具栏。
  assert.equal(pane.querySelector(".sfe-run-toolbar-bar"), null);
});

test("工具窗口: 终端窗口的「＋新建」排在 tab 列表【末尾】（最后一个 tab 右侧）", () => {
  // 空集合：tab 列表里只有「＋新建」一个节点。
  const empty = mount(makeOpts());
  const emptyList = empty.pane.querySelector(".sfe-run-tab-list");
  assert.equal(emptyList.children.length, 1);
  assert.ok(emptyList.children[0].classList.contains("new"), "空集合时新建按钮位于 tab 列表内");

  // 有 tab：新建按钮排在所有 tab 之后。
  const terms = [term("t1"), term("t2")];
  const { pane } = mount(makeOpts({ getTerminals: () => terms, getActiveId: () => "t1" }));
  const list = pane.querySelector(".sfe-run-tab-list");
  assert.equal(list.querySelectorAll(".sfe-run-tab").length, 2);
  assert.ok(
    list.children[list.children.length - 1].classList.contains("new"),
    "新建按钮必须是 tab 列表最后一个节点"
  );

  // 收起按钮在两窗共用的 tabsBar 最右端。
  const tabsBar = pane.querySelector(".sfe-run-tabs");
  assert.ok(tabsBar.children[tabsBar.children.length - 1].classList.contains("minimize"));
});

test("工具窗口: 每个终端渲染一个 tab，label = 标题，激活 tab 有 active 标记", () => {
  const terms = [term("t1", "终端 1"), term("t2", "终端 2")];
  const { pane } = mount(makeOpts({ getTerminals: () => terms, getActiveId: () => "t1" }));

  const tabs = pane.querySelectorAll(".sfe-run-tab");
  assert.equal(tabs.length, 2);
  assert.match(tabs[0].textContent, /终端 1/);
  assert.match(tabs[1].textContent, /终端 2/);
  assert.ok(tabs[0].classList.contains("active"));
  assert.ok(!tabs[1].classList.contains("active"));
});

test("工具窗口: 点击 tab 回调对应 id", () => {
  const terms = [term("t1"), term("t2")];
  let selected = null;
  const { pane } = mount(
    makeOpts({ getTerminals: () => terms, getActiveId: () => "t1", onSelectTab: (id) => (selected = id) })
  );
  pane.querySelectorAll(".sfe-run-tab")[1].click();
  assert.equal(selected, "t2");
});

test("工具窗口: tab 关闭按钮回调 onCloseTerminal 且不触发 onSelectTab", () => {
  let closed = null;
  let selected = null;
  const { pane } = mount(
    makeOpts({
      getTerminals: () => [term("t1")],
      getActiveId: () => "t1",
      onCloseTerminal: (id) => (closed = id),
      onSelectTab: (id) => (selected = id),
    })
  );
  pane.querySelector(".sfe-run-tab-close").click();
  assert.equal(closed, "t1");
  assert.equal(selected, null, "关闭按钮不得冒泡触发切换 tab");
});

test("工具窗口: ＋ 回调 onNewTerminal，⊖ 回调 onMinimize", () => {
  let newCalls = 0;
  let minCalls = 0;
  const { pane } = mount(makeOpts({ onNewTerminal: () => (newCalls += 1), onMinimize: () => (minCalls += 1) }));
  pane.querySelector(".sfe-run-collapse.new").click();
  pane.querySelector(".sfe-run-collapse.minimize").click();
  assert.equal(newCalls, 1);
  assert.equal(minCalls, 1);
});

test("工具窗口: write/clear/scrollToBottom 只作用于对应终端，未知 id 静默忽略", () => {
  const terms = [term("t1"), term("t2")];
  const opts = makeOpts({ getTerminals: () => terms, getActiveId: () => "t1" });
  const { controller } = mount(opts);
  const [r1, r2] = opts.factory.created;

  controller.write("t1", "a");
  controller.write("t2", "b");
  controller.write("missing", "c");
  controller.clear("t1");
  controller.scrollToBottom("t2");
  controller.clear("missing");
  assert.deepEqual(r1.writes, ["a"]);
  assert.deepEqual(r2.writes, ["b"]);
  assert.equal(r1.cleared, 1);
  assert.equal(r2.scrolled, 1);
});

test("工具窗口: 视图的输入/尺寸回调转发到对应终端记录的 onInput/onResize", () => {
  const terms = [term("t1")];
  const opts = makeOpts({ getTerminals: () => terms, getActiveId: () => "t1" });
  mount(opts);
  const record = opts.factory.created[0];

  const inputCalls = [];
  terms[0].onInput = (d) => inputCalls.push(d);
  record.opts.onData("ls\r");
  assert.deepEqual(inputCalls, ["ls\r"]);

  const resizeCalls = [];
  terms[0].onResize = (c, r) => resizeCalls.push([c, r]);
  record.opts.onResize(100, 30);
  assert.deepEqual(resizeCalls, [[100, 30]]);
});

test("工具窗口: 仅激活终端的宿主可见，切 tab 后 fit + focus 新激活视图", () => {
  let activeId = "t1";
  const terms = [term("t1"), term("t2")];
  const opts = makeOpts({ getTerminals: () => terms, getActiveId: () => activeId });
  const { pane, controller } = mount(opts);
  const hosts = pane.querySelectorAll(".sfe-run-terminal-host");
  const [r1, r2] = opts.factory.created;

  assert.equal(hosts[0].hidden, false);
  assert.equal(hosts[1].hidden, true);
  assert.ok(r1.fit >= 1, "初始激活视图应 fit");
  assert.ok(r1.focus >= 1, "初始激活视图应 focus");

  activeId = "t2";
  controller.syncActive();
  assert.equal(hosts[0].hidden, true);
  assert.equal(hosts[1].hidden, false);
  assert.ok(r2.fit >= 1);
  assert.ok(r2.focus >= 1);
});

test("工具窗口: getSizes 返回视图当前 cols/rows，未知 id 返回 null", () => {
  const opts = makeOpts({ getTerminals: () => [term("t1")], getActiveId: () => "t1" });
  const { controller } = mount(opts);
  opts.factory.created[0].cols = 123;
  opts.factory.created[0].rows = 45;
  assert.deepEqual(controller.getSizes("t1"), { cols: 123, rows: 45 });
  assert.equal(controller.getSizes("missing"), null);
});

test("工具窗口: rebuild 为新增终端建视图，并释放已移除终端的视图", () => {
  let terms = [term("t1")];
  const opts = makeOpts({ getTerminals: () => terms, getActiveId: () => "t1" });
  const { pane, controller } = mount(opts);
  assert.equal(opts.factory.created.length, 1);

  terms = [term("t1"), term("t2")];
  controller.rebuild();
  assert.equal(opts.factory.created.length, 2);
  assert.equal(pane.querySelectorAll(".sfe-run-tab").length, 2);

  terms = [term("t2")];
  controller.rebuild();
  assert.equal(pane.querySelectorAll(".sfe-run-tab").length, 1);
  assert.equal(opts.factory.created[0].disposed, 1, "被移除终端的视图必须释放");
  assert.equal(pane.querySelectorAll(".sfe-run-terminal-host").length, 1);
});

test("工具窗口: dispose 释放全部终端视图", () => {
  const opts = makeOpts({ getTerminals: () => [term("t1"), term("t2")], getActiveId: () => "t1" });
  const { controller } = mount(opts);
  controller.dispose();
  assert.ok(opts.factory.created.every((r) => r.disposed === 1));
});

// ───────────────────────── 双模式（模式 A / 模式 B）─────────────────────────

test("工具窗口: 模式 A 未退出时不显示 ✓/✗，视图只读（readOnly）", () => {
  const terms = [term("t1", "npm run dev", { mode: "run" })];
  const opts = makeOpts({ getTerminals: () => terms, getActiveId: () => "t1" });
  const { pane } = mount(opts);

  const label = pane.querySelector(".sfe-run-tab-label");
  assert.equal(label.textContent, "npm run dev");
  const tab = pane.querySelector(".sfe-run-tab");
  assert.ok(!tab.classList.contains("sfe-run-tab--ok"));
  assert.ok(!tab.classList.contains("sfe-run-tab--fail"));
  assert.equal(opts.factory.created[0].opts.readOnly, true, "模式 A 视图必须只读");
});

test("工具窗口: 模式 A 退出成功显示 ✓ 并标记成功状态点", () => {
  const terms = [term("t1", "npm run build", { mode: "run", exited: true, exitCode: 0 })];
  const { pane } = mount(makeOpts({ getTerminals: () => terms, getActiveId: () => "t1" }));

  const tab = pane.querySelector(".sfe-run-tab");
  assert.equal(pane.querySelector(".sfe-run-tab-label").textContent, "npm run build ✓");
  assert.ok(tab.classList.contains("sfe-run-tab--ok"));
  assert.ok(!tab.classList.contains("sfe-run-tab--fail"));
  assert.match(tab.title, /0/);
});

test("工具窗口: 模式 A 退出失败显示 ✗ + 退出码并标记失败状态点", () => {
  const terms = [term("t1", "npm run test", { mode: "run", exited: true, exitCode: 1 })];
  const { pane } = mount(makeOpts({ getTerminals: () => terms, getActiveId: () => "t1" }));

  const tab = pane.querySelector(".sfe-run-tab");
  assert.equal(pane.querySelector(".sfe-run-tab-label").textContent, "npm run test ✗ (1)");
  assert.ok(tab.classList.contains("sfe-run-tab--fail"));
  assert.ok(!tab.classList.contains("sfe-run-tab--ok"));
});

test("工具窗口: 模式 B 交互终端不显示退出状态，视图可输入", () => {
  const terms = [term("t1", "终端", { mode: "terminal", exited: true, exitCode: 0 })];
  const opts = makeOpts({ getTerminals: () => terms, getActiveId: () => "t1" });
  const { pane } = mount(opts);

  assert.equal(pane.querySelector(".sfe-run-tab-label").textContent, "终端");
  const tab = pane.querySelector(".sfe-run-tab");
  assert.ok(!tab.classList.contains("sfe-run-tab--ok"));
  assert.ok(!tab.classList.contains("sfe-run-tab--fail"));
  assert.notEqual(opts.factory.created[0].opts.readOnly, true, "模式 B 视图必须可输入");
});

// ───────────────────────── 运行窗口（kind=run）─────────────────────────

test("工具窗口: 运行窗口无「＋新建」，但有工具栏（重跑/停止/滚动到底/清空/⋮）", () => {
  const seen = [];
  const terms = [term("r1", "dev", { mode: "run" })];
  const { pane } = mount(
    makeOpts({ kind: "run", getTerminals: () => terms, getActiveId: () => "r1", onSelectTab: (id) => seen.push(id) })
  );
  assert.equal(pane.querySelector(".sfe-run-collapse.new"), null, "运行窗口不得有新建按钮");
  assert.ok(pane.querySelector(".sfe-run-collapse.minimize"), "运行窗口仍有收起按钮");
  const bar = pane.querySelector(".sfe-run-toolbar-bar");
  assert.ok(bar, "运行窗口必须有工具栏");
  assert.ok(bar.querySelector(".sfe-run-tb-btn.rerun"), "必须有重跑按钮");
  assert.ok(bar.querySelector(".sfe-run-tb-btn.stop"), "必须有停止按钮");
  assert.ok(bar.querySelector(".sfe-run-tb-btn.copy"), "必须有复制选中文本按钮");
  assert.equal(bar.querySelectorAll(".sfe-run-tb-btn").length, 6, "复制选中文本/滚动到底/清空/更多共 6 个按钮");
});

test("工具窗口: 运行窗口工具栏按钮按激活 tab 的运行态启用/置灰", () => {
  let terms = [term("r1", "dev", { mode: "run" })];
  const opts = makeOpts({ kind: "run", getTerminals: () => terms, getActiveId: () => "r1" });
  const { pane, controller } = mount(opts);
  const stop = pane.querySelector(".sfe-run-tb-btn.stop");
  const rerun = pane.querySelector(".sfe-run-tb-btn.rerun");
  assert.equal(rerun.disabled, false, "有激活 tab，重跑可用");
  assert.equal(stop.disabled, false, "运行中，停止可用");

  terms = [term("r1", "dev", { mode: "run", exited: true, exitCode: 0 })];
  controller.rebuild();
  assert.equal(rerun.disabled, false, "已结束仍可重跑");
  assert.equal(stop.disabled, true, "已结束，停止置灰");
});

test("工具窗口: 运行窗口无 tab 时工具栏按钮全部置灰", () => {
  const { pane } = mount(makeOpts({ kind: "run" }));
  assert.equal(pane.querySelector(".sfe-run-tb-btn.rerun").disabled, true);
  assert.equal(pane.querySelector(".sfe-run-tb-btn.stop").disabled, true);
});

test("工具窗口: 运行窗口工具栏重跑/停止/清空/滚动到底回调当前激活 tab id", () => {
  const calls = [];
  const terms = [term("r1", "dev", { mode: "run" })];
  const { pane } = mount(
    makeOpts({
      kind: "run",
      getTerminals: () => terms,
      getActiveId: () => "r1",
      onRerun: (id) => calls.push(["rerun", id]),
      onStop: (id) => calls.push(["stop", id]),
      onClear: (id) => calls.push(["clear", id]),
      onScrollToBottom: (id) => calls.push(["scroll", id]),
    })
  );
  pane.querySelector(".sfe-run-tb-btn.rerun").click();
  pane.querySelector(".sfe-run-tb-btn.stop").click();
  pane.querySelector(".sfe-run-tb-btn:not(.rerun):not(.stop):not(.copy):not(.more)").click();
  assert.ok(calls.some((c) => c[0] === "rerun" && c[1] === "r1"));
  assert.ok(calls.some((c) => c[0] === "stop" && c[1] === "r1"));
});

test("工具窗口: 运行窗口「复制选中文本」有选区时可用并回调选中文本", () => {
  const calls = [];
  const created = [];
  const createTerminal = (host, opts) => {
    const record = { host, opts, selection: "line1\nline2" };
    record.view = {
      write() {},
      fit() {},
      focus() {},
      clear() {},
      scrollToBottom() {},
      dispose() {},
      hasSelection: () => record.selection !== "",
      getSelection: () => record.selection,
      paste() {},
      selectAll() {},
      cols: 80,
      rows: 24,
    };
    created.push(record);
    return record.view;
  };
  const terms = [term("r1", "dev", { mode: "run" })];
  const { pane } = mount(
    makeOpts({
      kind: "run",
      getTerminals: () => terms,
      getActiveId: () => "r1",
      factory: { createTerminal, created },
      onCopySelection: (id, text) => calls.push([id, text]),
    })
  );
  const copy = pane.querySelector(".sfe-run-tb-btn.copy");
  assert.equal(copy.disabled, false, "有选区时「复制选中文本」可用");
  copy.click();
  assert.deepEqual(calls, [["r1", "line1\nline2"]], "应回调当前 tab id 与选中文本");
});

test("工具窗口: 运行窗口无选区时「复制选中文本」置灰", () => {
  const terms = [term("r1", "dev", { mode: "run" })];
  const factory = makeClipboardFactory(); // 其视图 hasSelection 恒为 false
  const { pane } = mount(
    makeOpts({ kind: "run", getTerminals: () => terms, getActiveId: () => "r1", factory })
  );
  assert.equal(pane.querySelector(".sfe-run-tb-btn.copy").disabled, true, "无选区时置灰");
});

// ───────────────────────── tab 右键菜单（两个窗口都有）─────────────────────────

test("工具窗口: 终端 tab 右键打开浮动菜单（含关闭/关闭其它/关闭全部）", () => {
  const terms = [term("t1", "终端 1")];
  const { pane } = mount(makeOpts({ getTerminals: () => terms, getActiveId: () => "t1" }));
  const menu = pane.querySelector(".sfe-popup-menu");
  assert.equal(menu.hidden, true, "初始隐藏");
  const tab = pane.querySelector(".sfe-run-tab");
  tab.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
  assert.equal(menu.hidden, false, "右键后显示");
  assert.match(menu.textContent, /关闭全部/);
  assert.match(menu.textContent, /关闭其它/);
});

test("工具窗口: 运行 tab 右键菜单额外含「停止」（运行中）与「重新运行」", () => {
  const terms = [term("r1", "dev", { mode: "run" })];
  const { pane } = mount(makeOpts({ kind: "run", getTerminals: () => terms, getActiveId: () => "r1" }));
  const tab = pane.querySelector(".sfe-run-tab");
  tab.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
  const menu = pane.querySelector(".sfe-popup-menu");
  assert.match(menu.textContent, /停止/);
  assert.match(menu.textContent, /重新运行/);
});

test("工具窗口: 右键菜单项点击后回调并关闭菜单", () => {
  const terms = [term("t1", "终端 1")];
  let closedAll = 0;
  const { pane } = mount(
    makeOpts({ getTerminals: () => terms, getActiveId: () => "t1", onCloseAll: () => (closedAll += 1) })
  );
  const tab = pane.querySelector(".sfe-run-tab");
  tab.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
  const menu = pane.querySelector(".sfe-popup-menu");
  const items = [...menu.querySelectorAll(".sfe-popup-menu-item")];
  const closeAll = items.find((it) => /关闭全部/.test(it.textContent));
  closeAll.click();
  assert.equal(closedAll, 1);
  assert.equal(menu.hidden, true, "点击后菜单关闭");
});

// ───────────────────────── 内容区右键：粘贴按剪贴板启用 + 菜单定位 clamp ─────────────────────────

/** 记录粘贴 / 全选调用的假终端工厂（内容区右键菜单用）。 */
function makeClipboardFactory() {
  const created = [];
  const createTerminal = (host, opts) => {
    const record = { host, opts, pasted: [] };
    record.view = {
      write() {},
      fit() {},
      focus() {},
      clear() {},
      scrollToBottom() {},
      dispose() {},
      hasSelection: () => false,
      getSelection: () => "",
      paste: (text) => record.pasted.push(text),
      selectAll() {},
      cols: 80,
      rows: 24,
    };
    created.push(record);
    return record.view;
  };
  return { createTerminal, created };
}

/** 在 window.snow.readClipboardText 返回 text 的环境下执行 fn，结束后还原。 */
async function withClipboard(text, fn) {
  const prev = globalThis.window.snow;
  globalThis.window.snow = { readClipboardText: async () => text };
  try {
    await fn();
  } finally {
    if (prev === undefined) delete globalThis.window.snow;
    else globalThis.window.snow = prev;
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("工具窗口: 内容区右键「粘贴」在剪贴板有内容时启用并写入终端", async () => {
  await withClipboard("hello-clip", async () => {
    const terms = [term("t1")];
    const factory = makeClipboardFactory();
    const { pane } = mount(
      makeOpts({ getTerminals: () => terms, getActiveId: () => "t1", factory, onPasteText: async () => "hello-clip" })
    );
    // xterm 视图中右键 → 调用注入的 onContextMenu 弹出内容区菜单
    factory.created[0].opts.onContextMenu(20, 20);
    await flush();
    const menu = pane.querySelector(".sfe-popup-menu");
    assert.equal(menu.hidden, false, "右键后菜单显示");
    const paste = [...menu.querySelectorAll(".sfe-popup-menu-item")].find((n) => /粘贴/.test(n.textContent));
    assert.ok(paste, "内容区菜单应含「粘贴」");
    assert.equal(paste.disabled, false, "剪贴板有内容时「粘贴」可用");
    paste.click();
    await flush();
    assert.deepEqual(factory.created[0].pasted, ["hello-clip"]);
  });
});

test("工具窗口: 剪贴板为空时内容区右键「粘贴」置灰不可点", async () => {
  await withClipboard("", async () => {
    const terms = [term("t1")];
    const factory = makeClipboardFactory();
    const { pane } = mount(
      makeOpts({ getTerminals: () => terms, getActiveId: () => "t1", factory, onPasteText: async () => "" })
    );
    factory.created[0].opts.onContextMenu(20, 20);
    await flush();
    const menu = pane.querySelector(".sfe-popup-menu");
    const paste = [...menu.querySelectorAll(".sfe-popup-menu-item")].find((n) => /粘贴/.test(n.textContent));
    assert.equal(paste.disabled, true, "剪贴板为空时「粘贴」置灰");
  });
});

test("工具窗口: 运行窗口（只读）内容区右键不提供「粘贴」", () => {
  const terms = [term("r1", "dev", { mode: "run" })];
  const factory = makeClipboardFactory();
  const { pane } = mount(
    makeOpts({ kind: "run", getTerminals: () => terms, getActiveId: () => "r1", factory, onPasteText: async () => "x" })
  );
  factory.created[0].opts.onContextMenu(20, 20);
  const menu = pane.querySelector(".sfe-popup-menu");
  assert.equal(menu.hidden, false);
  assert.equal(
    [...menu.querySelectorAll(".sfe-popup-menu-item")].some((n) => /粘贴/.test(n.textContent)),
    false,
    "只读运行窗口不得出现「粘贴」"
  );
});

test("工具窗口: 右键菜单靠近视口右下边缘时被 clamp（向左/上翻转，不被遮挡）", async () => {
  const win = dom.window;
  const proto = win.Element.prototype;
  const orig = proto.getBoundingClientRect;
  // jsdom 无布局：给菜单一个固定尺寸，才能验证 clamp 数学。
  proto.getBoundingClientRect = function () {
    if (this.classList && this.classList.contains("sfe-popup-menu")) {
      return { width: 200, height: 120, left: 0, top: 0, right: 200, bottom: 120 };
    }
    return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  };
  try {
    const terms = [term("t1")];
    const factory = makeClipboardFactory();
    const { pane } = mount(makeOpts({ getTerminals: () => terms, getActiveId: () => "t1", factory }));
    const vw = win.innerWidth || 1024;
    const vh = win.innerHeight || 768;
    factory.created[0].opts.onContextMenu(vw - 2, vh - 2);
    // 内容区菜单异步读取剪贴板后再打开，需等待一拍。
    await flush();
    const menu = pane.querySelector(".sfe-popup-menu");
    assert.equal(menu.style.left, `${vw - 2 - 200}px`, "向右越界时左移到菜单完整可见");
    assert.equal(menu.style.top, `${vh - 2 - 120}px`, "向下越界时上移到菜单完整可见");
  } finally {
    proto.getBoundingClientRect = orig;
  }
});
