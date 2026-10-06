import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { XtermViewOptions } from "../../../src/components/terminal-view.ts";
import type {
  ToolTerminalView,
  ToolWindowDock,
  ToolWindowHandle,
  ToolWindowOptions,
  ToolWindowTerminal,
} from "../../../src/components/tool-window.ts";
import type { TranslateFn } from "../../../src/types/panel-state.ts";
import type { SnowApi, Unsubscribe } from "../../../src/types/snow-api.ts";

// 建立最小 DOM 环境后再导入渲染模块（node 环境无 DOM）。
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderToolWindow } = await import("../../../src/components/tool-window.ts");

/** 翻译桩：支持 {{name}} 占位替换（与宿主 api.t 的 values 语义一致）。 */
const t: TranslateFn = (_key, fallback, values) => {
  let out = fallback || _key;
  if (values) {
    for (const [name, value] of Object.entries(values)) {
      out = out.split(`{{${name}}}`).join(String(value));
    }
  }
  return out;
};

/**
 * 假终端工厂收到的视图选项。
 * @description 组件的 ensureViews（tool-window.ts 内）每次都把 onData / onResize / onContextMenu
 *   三个回调传全，桩按这份真实到达的形状记录，用例才能不经判空直接触发它们。
 */
type FakeTerminalOptions = XtermViewOptions &
  Required<Pick<XtermViewOptions, "onData" | "onResize" | "onContextMenu">>;

/**
 * 假终端记录：工厂为每个 tab 建一份，记录组件对视图的调用次数与内容，供用例断言。
 * @description 一份类型同时服务「计数工厂」与「剪贴板工厂」，各家不用的字段填中性默认值（不参与断言）。
 */
type FakeTerminalRecord = {
  /** 工厂收到的宿主元素（组件为每个 tab 建的 `.sfe-run-terminal-host`）。 */
  host: HTMLElement;
  /** 工厂收到的视图选项：只读标记与三个交互回调。 */
  opts: FakeTerminalOptions;
  /** `write` 收到的原始输出，按调用顺序排列。 */
  writes: string[];
  /** `fit` 被调用次数。 */
  fit: number;
  /** `focus` 被调用次数。 */
  focus: number;
  /** `clear` 被调用次数。 */
  cleared: number;
  /** `scrollToBottom` 被调用次数。 */
  scrolled: number;
  /** `dispose` 被调用次数（pruneViews / dispose 都要计数）。 */
  disposed: number;
  /** 当前列数：用例可改写，`getSizes` 经视图 getter 读它。 */
  cols: number;
  /** 当前行数：同上。 */
  rows: number;
  /** 选区文本：非空串即视为「有选区」，驱动 hasSelection / getSelection。 */
  selection: string;
  /** `paste` 收到的文本清单，按调用顺序排列。 */
  pasted: string[];
  /** 工厂为该记录造的假视图（返回给组件的本体）；赋值后恒存在，用例只读上面这些计数。 */
  view?: ToolTerminalView;
};

/** 假终端工厂：记录每次创建，便于断言 write/fit/focus/dispose/clear/scrollToBottom 与输入回调。 */
type FakeTerminalFactory = {
  /** 注入给组件 `createTerminal` 的实现，签名与 ToolWindowOptions 要求一致。 */
  createTerminal: (host: HTMLElement, options: XtermViewOptions) => ToolTerminalView;
  /** 已创建的终端记录，顺序即创建顺序。 */
  created: FakeTerminalRecord[];
};

/** 假视图里与选区/粘贴相关的成员（剪贴板用例的两个工厂共用）。 */
type ClipboardViewParts = Pick<ToolTerminalView, "hasSelection" | "getSelection" | "paste" | "selectAll">;

/** 给假记录补齐计数类字段的默认值（剪贴板工厂不关心它们）。 */
function fakeRecordBase(host: HTMLElement, options: XtermViewOptions): Omit<FakeTerminalRecord, "view"> {
  return {
    host,
    // as: 组件恒传 onData / onResize / onContextMenu（见 FakeTerminalOptions 说明），桩按真实形状存。
    opts: options as FakeTerminalOptions,
    writes: [],
    fit: 0,
    focus: 0,
    cleared: 0,
    scrolled: 0,
    disposed: 0,
    cols: 80,
    rows: 24,
    selection: "",
    pasted: [],
  };
}

/**
 * 假视图的公共骨架：write/fit/focus/clear/scrollToBottom/get cols/rows/dispose 全部记数。
 * @param record 待记录的假终端记录（闭包在组件调用时才读它）。
 * @param clipboard 选区/粘贴相关成员，剪贴板用例才传。
 */
function fakeView(record: FakeTerminalRecord, clipboard?: ClipboardViewParts): ToolTerminalView {
  return {
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
    ...clipboard,
  };
}

/**
 * 基础假终端工厂：按调用次数计数，并允许用例改写 cols/rows。
 * @returns 工厂与其创建记录列表
 */
function makeFactory(): FakeTerminalFactory {
  const created: FakeTerminalRecord[] = [];
  const createTerminal: FakeTerminalFactory["createTerminal"] = (host, options) => {
    const record: FakeTerminalRecord = fakeRecordBase(host, options);
    const view = fakeView(record);
    record.view = view;
    created.push(record);
    return view;
  };
  return { createTerminal, created };
}

/**
 * 带选区 / 粘贴记录的假终端工厂（内容区右键菜单用例用）。
 * @param selection 视图初始选区文本；非空即 hasSelection 为 true。
 */
function makeClipboardFactory(selection = ""): FakeTerminalFactory {
  const created: FakeTerminalRecord[] = [];
  const createTerminal: FakeTerminalFactory["createTerminal"] = (host, options) => {
    const record: FakeTerminalRecord = { ...fakeRecordBase(host, options), selection };
    const view = fakeView(record, {
      hasSelection: () => record.selection !== "",
      getSelection: () => record.selection,
      paste: (text) => record.pasted.push(text),
      selectAll: () => {},
    });
    record.view = view;
    created.push(record);
    return view;
  };
  return { createTerminal, created };
}

/** 终端记录桩补上的宿主真实字段（组件不读，保持与 index.ts 的 state.terminals 元素同构）。 */
type TermStub = ToolWindowTerminal & {
  /** PTY 会话（index.ts 建 pty 后写入；未建时为 null），组件不消费。 */
  session: string | null;
  /** 尚未发送的启动命令（pty 就绪后补发），组件不消费。 */
  pendingCommand: string;
};

/** 构造一条终端记录（与 index.js 的 state.terminals 元素同构）。 */
function term(id: string, title?: string, extra: Partial<TermStub> = {}): TermStub {
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

/** makeOpts 的覆盖项：组件选项 + 只在测试里传递的假终端工厂。 */
type ToolWindowOverrides = Partial<ToolWindowOptions> & {
  /** 覆盖默认假终端工厂（剪贴板用例注入带选区的实现）。 */
  factory?: FakeTerminalFactory;
};

/** makeOpts 的返回：可直接喂给 renderToolWindow 的选项，并带回工厂便于断言创建记录。 */
type MountedToolWindowOptions = ToolWindowOptions & {
  /** 本次挂载使用的假终端工厂。 */
  factory: FakeTerminalFactory;
};

function makeOpts(overrides: ToolWindowOverrides = {}): MountedToolWindowOptions {
  const factory: FakeTerminalFactory = overrides.factory || makeFactory();
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

/** mount 的返回：窗口容器与组件句柄。 */
type MountedToolWindow = {
  /** 承载窗口的容器（组件在其内渲染 tab 栏、工具栏、终端宿主与浮动菜单）。 */
  pane: HTMLDivElement;
  /** renderToolWindow 的驱动句柄。 */
  controller: ToolWindowHandle;
};

function mount(opts: MountedToolWindowOptions): MountedToolWindow {
  const pane = document.createElement("div");
  const controller = renderToolWindow(pane, opts);
  return { pane, controller };
}

/**
 * 取容器内必然存在的元素。
 * !: 元素缺失即组件没渲染该控件（用例随后直接解引用，运行时同样会抛 TypeError），
 *   故在唯一的查询出口收窄一次非空，不改变运行时行为。
 */
const q = <T extends Element>(parent: ParentNode, selector: string): T => parent.querySelector<T>(selector)!;

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
  const emptyList = q<HTMLElement>(empty.pane, ".sfe-run-tab-list");
  assert.equal(emptyList.children.length, 1);
  assert.ok(emptyList.children[0].classList.contains("new"), "空集合时新建按钮位于 tab 列表内");

  // 有 tab：新建按钮排在所有 tab 之后。
  const terms = [term("t1"), term("t2")];
  const { pane } = mount(makeOpts({ getTerminals: () => terms, getActiveId: () => "t1" }));
  const list = q<HTMLElement>(pane, ".sfe-run-tab-list");
  assert.equal(list.querySelectorAll(".sfe-run-tab").length, 2);
  assert.ok(
    list.children[list.children.length - 1].classList.contains("new"),
    "新建按钮必须是 tab 列表最后一个节点"
  );

  // 收起按钮在两窗共用的 tabsBar 最右端，停靠切换紧挨其左侧。
  const tabsBar = q<HTMLElement>(pane, ".sfe-run-tabs");
  const barChildren = [...tabsBar.children];
  assert.ok(barChildren[barChildren.length - 1].classList.contains("minimize"));
  assert.ok(barChildren[barChildren.length - 2].classList.contains("dock"), "停靠按钮必须在最小化左边");
});

test("工具窗口: 停靠按钮在最小化左侧，点击切换，图标随 getDock 变化", () => {
  let dock: ToolWindowDock = "bottom";
  let toggles = 0;
  const { pane, controller } = mount(makeOpts({
    getDock: () => dock,
    onToggleDock: () => {
      toggles += 1;
    },
  }));
  const dockBtn = q<HTMLButtonElement>(pane, ".sfe-run-collapse.dock");
  const minimize = q<HTMLButtonElement>(pane, ".sfe-run-collapse.minimize");
  assert.ok(dockBtn);
  assert.equal(dockBtn.nextElementSibling, minimize);
  assert.equal(dockBtn.getAttribute("aria-pressed"), "false");
  assert.equal(dockBtn.title, "放到右侧");
  dockBtn.click();
  assert.equal(toggles, 1);
  dock = "right";
  controller.syncDock();
  assert.equal(dockBtn.getAttribute("aria-pressed"), "true");
  assert.equal(dockBtn.title, "放到底栏");
  assert.ok(dockBtn.classList.contains("active"));
});

test("工具窗口: 每个终端渲染一个 tab，label = 标题，激活 tab 有 active 标记", () => {
  const terms = [term("t1", "终端 1"), term("t2", "终端 2")];
  const { pane } = mount(makeOpts({ getTerminals: () => terms, getActiveId: () => "t1" }));

  const tabs = pane.querySelectorAll<HTMLButtonElement>(".sfe-run-tab");
  assert.equal(tabs.length, 2);
  assert.match(tabs[0].textContent, /终端 1/);
  assert.match(tabs[1].textContent, /终端 2/);
  assert.ok(tabs[0].classList.contains("active"));
  assert.ok(!tabs[1].classList.contains("active"));
});

test("工具窗口: 点击 tab 回调对应 id", () => {
  const terms = [term("t1"), term("t2")];
  let selected: string | null = null;
  const { pane } = mount(
    makeOpts({ getTerminals: () => terms, getActiveId: () => "t1", onSelectTab: (id) => (selected = id) })
  );
  pane.querySelectorAll<HTMLButtonElement>(".sfe-run-tab")[1].click();
  assert.equal(selected, "t2");
});

test("工具窗口: tab 关闭按钮回调 onCloseTerminal 且不触发 onSelectTab", () => {
  let closed: string | null = null;
  let selected: string | null = null;
  const { pane } = mount(
    makeOpts({
      getTerminals: () => [term("t1")],
      getActiveId: () => "t1",
      onCloseTerminal: (id) => (closed = id),
      onSelectTab: (id) => (selected = id),
    })
  );
  q<HTMLElement>(pane, ".sfe-run-tab-close").click();
  assert.equal(closed, "t1");
  assert.equal(selected, null, "关闭按钮不得冒泡触发切换 tab");
});

test("工具窗口: ＋ 回调 onNewTerminal，⊖ 回调 onMinimize", () => {
  let newCalls = 0;
  let minCalls = 0;
  const { pane } = mount(makeOpts({ onNewTerminal: () => (newCalls += 1), onMinimize: () => (minCalls += 1) }));
  q<HTMLButtonElement>(pane, ".sfe-run-collapse.new").click();
  q<HTMLButtonElement>(pane, ".sfe-run-collapse.minimize").click();
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

  const inputCalls: string[] = [];
  terms[0].onInput = (d) => inputCalls.push(d);
  record.opts.onData("ls\r");
  assert.deepEqual(inputCalls, ["ls\r"]);

  const resizeCalls: Array<[number, number]> = [];
  terms[0].onResize = (c, r) => resizeCalls.push([c, r]);
  record.opts.onResize(100, 30);
  assert.deepEqual(resizeCalls, [[100, 30]]);
});

test("工具窗口: 仅激活终端的宿主可见，切 tab 后 fit + focus 新激活视图", () => {
  let activeId = "t1";
  const terms = [term("t1"), term("t2")];
  const opts = makeOpts({ getTerminals: () => terms, getActiveId: () => activeId });
  const { pane, controller } = mount(opts);
  const hosts = pane.querySelectorAll<HTMLElement>(".sfe-run-terminal-host");
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

  const label = q<HTMLElement>(pane, ".sfe-run-tab-label");
  assert.equal(label.textContent, "npm run dev");
  const tab = q<HTMLButtonElement>(pane, ".sfe-run-tab");
  assert.ok(!tab.classList.contains("sfe-run-tab--ok"));
  assert.ok(!tab.classList.contains("sfe-run-tab--fail"));
  assert.equal(opts.factory.created[0].opts.readOnly, true, "模式 A 视图必须只读");
});

test("工具窗口: 模式 A 退出成功显示 ✓ 并标记成功状态点", () => {
  const terms = [term("t1", "npm run build", { mode: "run", exited: true, exitCode: 0 })];
  const { pane } = mount(makeOpts({ getTerminals: () => terms, getActiveId: () => "t1" }));

  const tab = q<HTMLButtonElement>(pane, ".sfe-run-tab");
  assert.equal(q<HTMLElement>(pane, ".sfe-run-tab-label").textContent, "npm run build ✓");
  assert.ok(tab.classList.contains("sfe-run-tab--ok"));
  assert.ok(!tab.classList.contains("sfe-run-tab--fail"));
  assert.match(tab.title, /0/);
});

test("工具窗口: 模式 A 退出失败显示 ✗ + 退出码并标记失败状态点", () => {
  const terms = [term("t1", "npm run test", { mode: "run", exited: true, exitCode: 1 })];
  const { pane } = mount(makeOpts({ getTerminals: () => terms, getActiveId: () => "t1" }));

  const tab = q<HTMLButtonElement>(pane, ".sfe-run-tab");
  assert.equal(q<HTMLElement>(pane, ".sfe-run-tab-label").textContent, "npm run test ✗ (1)");
  assert.ok(tab.classList.contains("sfe-run-tab--fail"));
  assert.ok(!tab.classList.contains("sfe-run-tab--ok"));
});

test("工具窗口: 模式 B 交互终端不显示退出状态，视图可输入", () => {
  const terms = [term("t1", "终端", { mode: "terminal", exited: true, exitCode: 0 })];
  const opts = makeOpts({ getTerminals: () => terms, getActiveId: () => "t1" });
  const { pane } = mount(opts);

  assert.equal(q<HTMLElement>(pane, ".sfe-run-tab-label").textContent, "终端");
  const tab = q<HTMLButtonElement>(pane, ".sfe-run-tab");
  assert.ok(!tab.classList.contains("sfe-run-tab--ok"));
  assert.ok(!tab.classList.contains("sfe-run-tab--fail"));
  assert.notEqual(opts.factory.created[0].opts.readOnly, true, "模式 B 视图必须可输入");
});

// ───────────────────────── 运行窗口（kind=run）─────────────────────────

test("工具窗口: 运行窗口无「＋新建」，但有工具栏（重跑/停止/滚动到底/清空/⋮）", () => {
  const seen: string[] = [];
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
  const stop = q<HTMLButtonElement>(pane, ".sfe-run-tb-btn.stop");
  const rerun = q<HTMLButtonElement>(pane, ".sfe-run-tb-btn.rerun");
  assert.equal(rerun.disabled, false, "有激活 tab，重跑可用");
  assert.equal(stop.disabled, false, "运行中，停止可用");

  terms = [term("r1", "dev", { mode: "run", exited: true, exitCode: 0 })];
  controller.rebuild();
  assert.equal(rerun.disabled, false, "已结束仍可重跑");
  assert.equal(stop.disabled, true, "已结束，停止置灰");
});

test("工具窗口: 运行窗口无 tab 时工具栏按钮全部置灰", () => {
  const { pane } = mount(makeOpts({ kind: "run" }));
  assert.equal(q<HTMLButtonElement>(pane, ".sfe-run-tb-btn.rerun").disabled, true);
  assert.equal(q<HTMLButtonElement>(pane, ".sfe-run-tb-btn.stop").disabled, true);
});

test("工具窗口: 运行窗口工具栏重跑/停止/清空/滚动到底回调当前激活 tab id", () => {
  const calls: Array<[string, string]> = [];
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
  q<HTMLButtonElement>(pane, ".sfe-run-tb-btn.rerun").click();
  q<HTMLButtonElement>(pane, ".sfe-run-tb-btn.stop").click();
  q<HTMLButtonElement>(pane, ".sfe-run-tb-btn:not(.rerun):not(.stop):not(.copy):not(.more)").click();
  assert.ok(calls.some((c) => c[0] === "rerun" && c[1] === "r1"));
  assert.ok(calls.some((c) => c[0] === "stop" && c[1] === "r1"));
});

test("工具窗口: 运行窗口「复制选中文本」有选区时可用并回调选中文本", () => {
  const calls: Array<[string, string]> = [];
  const created: FakeTerminalRecord[] = [];
  const createTerminal: FakeTerminalFactory["createTerminal"] = (host, opts) => {
    const record: FakeTerminalRecord = { ...fakeRecordBase(host, opts), selection: "line1\nline2" };
    const view = fakeView(record, {
      hasSelection: () => record.selection !== "",
      getSelection: () => record.selection,
      paste: () => {},
      selectAll: () => {},
    });
    record.view = view;
    created.push(record);
    return view;
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
  const copy = q<HTMLButtonElement>(pane, ".sfe-run-tb-btn.copy");
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
  assert.equal(q<HTMLButtonElement>(pane, ".sfe-run-tb-btn.copy").disabled, true, "无选区时置灰");
});

// ───────────────────────── tab 右键菜单（两个窗口都有）─────────────────────────

test("工具窗口: 终端 tab 右键打开浮动菜单（含关闭/关闭其它/关闭全部）", () => {
  const terms = [term("t1", "终端 1")];
  const { pane } = mount(makeOpts({ getTerminals: () => terms, getActiveId: () => "t1" }));
  const menu = q<HTMLElement>(pane, ".sfe-popup-menu");
  assert.equal(menu.hidden, true, "初始隐藏");
  const tab = q<HTMLButtonElement>(pane, ".sfe-run-tab");
  tab.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
  assert.equal(menu.hidden, false, "右键后显示");
  assert.match(menu.textContent, /关闭全部/);
  assert.match(menu.textContent, /关闭其它/);
});

test("工具窗口: 运行窗口右键菜单有「显示其他项目的任务」，点击切换", () => {
  const terms = [term("r1", "dev", { mode: "run" })];
  let shown = false;
  let toggles = 0;
  const { pane } = mount(makeOpts({
    kind: "run",
    getTerminals: () => terms,
    getActiveId: () => "r1",
    getShowOtherRuns: () => shown,
    onToggleShowOtherRuns: () => {
      toggles += 1;
      shown = !shown;
    },
  }));
  const tab = q<HTMLButtonElement>(pane, ".sfe-run-tab");
  tab.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
  const menu = q<HTMLElement>(pane, ".sfe-popup-menu");
  const item = [...menu.querySelectorAll<HTMLButtonElement>(".sfe-popup-menu-item")].find((node) => /显示其他项目的任务/.test(node.textContent));
  assert.ok(item, "右键菜单必须有后台任务开关");
  assert.equal(item.classList.contains("checked"), false);
  item.click();
  assert.equal(toggles, 1);
  tab.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
  const again = [...q<HTMLElement>(pane, ".sfe-popup-menu").querySelectorAll<HTMLButtonElement>(".sfe-popup-menu-item")]
    .find((node) => /显示其他项目的任务/.test(node.textContent));
  // !: 同一菜单项在两次右键后都必须仍在（开关只改勾选态），缺失时原写法同样抛 TypeError。
  assert.ok(again!.classList.contains("checked"));
});

test("工具窗口: hiddenRun 的启动任务不画 tab，重跑和停止也跟着藏", () => {
  const terms = [
    term("r1", "当前", { mode: "run" }),
    term("r2", "后台", { mode: "run", hiddenRun: true, projectLabel: "other" }),
  ];
  const { pane, controller } = mount(makeOpts({ kind: "run", getTerminals: () => terms, getActiveId: () => "r1" }));
  const tabs = [...pane.querySelectorAll(".sfe-run-tab")];
  assert.equal(tabs.length, 1);
  assert.match(tabs[0].textContent, /当前/);
  assert.equal(pane.querySelectorAll(".sfe-run-terminal-host").length, 2);
  assert.equal(q<HTMLButtonElement>(pane, ".sfe-run-tb-btn.rerun").hidden, false);
  assert.equal(q<HTMLButtonElement>(pane, ".sfe-run-tb-btn.stop").hidden, false);

  terms.splice(0, 1);
  controller.rebuild();
  assert.equal(pane.querySelectorAll(".sfe-run-tab").length, 0);
  assert.equal(q<HTMLButtonElement>(pane, ".sfe-run-tb-btn.rerun").hidden, true);
  assert.equal(q<HTMLButtonElement>(pane, ".sfe-run-tb-btn.stop").hidden, true);
});

test("工具窗口: 运行 tab 右键菜单额外含「停止」（运行中）与「重新运行」", () => {
  const terms = [term("r1", "dev", { mode: "run" })];
  const { pane } = mount(makeOpts({ kind: "run", getTerminals: () => terms, getActiveId: () => "r1" }));
  const tab = q<HTMLButtonElement>(pane, ".sfe-run-tab");
  tab.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
  const menu = q<HTMLElement>(pane, ".sfe-popup-menu");
  assert.match(menu.textContent, /停止/);
  assert.match(menu.textContent, /重新运行/);
});

test("工具窗口: 右键菜单项点击后回调并关闭菜单", () => {
  const terms = [term("t1", "终端 1")];
  let closedAll = 0;
  const { pane } = mount(
    makeOpts({ getTerminals: () => terms, getActiveId: () => "t1", onCloseAll: () => (closedAll += 1) })
  );
  const tab = q<HTMLButtonElement>(pane, ".sfe-run-tab");
  tab.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
  const menu = q<HTMLElement>(pane, ".sfe-popup-menu");
  const items = [...menu.querySelectorAll<HTMLButtonElement>(".sfe-popup-menu-item")];
  const closeAll = items.find((it) => /关闭全部/.test(it.textContent));
  // !: 「关闭全部」项由组件固定产出，缺失时原写法同样抛 TypeError。
  closeAll!.click();
  assert.equal(closedAll, 1);
  assert.equal(menu.hidden, true, "点击后菜单关闭");
});

// ───────────────────────── 内容区右键：粘贴按剪贴板启用 + 菜单定位 clamp ─────────────────────────
// 记录粘贴 / 全选调用的假终端工厂是文件头部的 makeClipboardFactory()（其视图 hasSelection 恒为 false）。

/**
 * 宿主 `window.snow` 桩：33 个方法逐个按 src/types/snow-api.ts 的真实签名给出。
 * @description 本文件只测「内容区右键 → 读剪贴板」这一条链路，其余方法一律「被调用即抛」，
 *   这样组件一旦用到桩里没有的能力，用例会直接失败而不是静默通过（不留假桩）。
 */
const unstubbedAsync = async (): Promise<never> => {
  throw new Error("window.snow 宿主桩未实现该方法");
};

/** 同上，用于同步返回「取消订阅函数」的订阅类方法。 */
const unstubbedSubscribe = (): Unsubscribe => {
  throw new Error("window.snow 宿主桩未实现该方法");
};

const SNOW_STUB: SnowApi = {
  readDirectoryEntries: unstubbedAsync,
  readFileContent: unstubbedAsync,
  searchFiles: unstubbedAsync,
  startDirectoryWatch: unstubbedAsync,
  stopDirectoryWatch: unstubbedAsync,
  onDirectoryChanged: unstubbedSubscribe,
  gitStatus: unstubbedAsync,
  onGitStatusChanged: unstubbedSubscribe,
  gitBranches: unstubbedAsync,
  gitStage: unstubbedAsync,
  gitUnstage: unstubbedAsync,
  gitStageAll: unstubbedAsync,
  gitUnstageAll: unstubbedAsync,
  gitCommit: unstubbedAsync,
  gitPush: unstubbedAsync,
  gitPull: unstubbedAsync,
  gitCheckout: unstubbedAsync,
  gitFileDiff: unstubbedAsync,
  gitFileContent: unstubbedAsync,
  gitDiscardChanges: unstubbedAsync,
  generateCommitMessage: unstubbedAsync,
  abortCommitMessage: unstubbedAsync,
  ptyCreate: unstubbedAsync,
  ptyWrite: unstubbedAsync,
  ptyResize: unstubbedAsync,
  ptyKill: unstubbedAsync,
  onPtyOutput: unstubbedSubscribe,
  onPtyExit: unstubbedSubscribe,
  readClipboardText: unstubbedAsync,
  writeClipboardText: unstubbedAsync,
  getSystemSettingValue: unstubbedAsync,
  detectTerminals: unstubbedAsync,
  readPluginFile: unstubbedAsync,
};

/** 在 window.snow.readClipboardText 返回 text 的环境下执行 fn，结束后还原。 */
async function withClipboard(text: string, fn: () => Promise<void> | void): Promise<void> {
  const prev: SnowApi | undefined = globalThis.window.snow;
  globalThis.window.snow = { ...SNOW_STUB, readClipboardText: async () => text };
  try {
    await fn();
  } finally {
    // 宿主类型把 snow 声明为必然存在，`delete` 只允许作用在可选属性上；
    // Reflect.deleteProperty 与原写法同义（都是移除 window 上的该属性）。
    if (prev === undefined) Reflect.deleteProperty(globalThis.window, "snow");
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
    const menu = q<HTMLElement>(pane, ".sfe-popup-menu");
    assert.equal(menu.hidden, false, "右键后菜单显示");
    const paste = [...menu.querySelectorAll<HTMLButtonElement>(".sfe-popup-menu-item")].find((n) => /粘贴/.test(n.textContent));
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
    const menu = q<HTMLElement>(pane, ".sfe-popup-menu");
    const paste = [...menu.querySelectorAll<HTMLButtonElement>(".sfe-popup-menu-item")].find((n) => /粘贴/.test(n.textContent));
    // !: 「粘贴」项必须存在（缺失时原写法同样抛 TypeError），置灰正是本用例的断言点。
    assert.equal(paste!.disabled, true, "剪贴板为空时「粘贴」置灰");
  });
});

test("工具窗口: 运行窗口（只读）内容区右键不提供「粘贴」", () => {
  const terms = [term("r1", "dev", { mode: "run" })];
  const factory = makeClipboardFactory();
  const { pane } = mount(
    makeOpts({ kind: "run", getTerminals: () => terms, getActiveId: () => "r1", factory, onPasteText: async () => "x" })
  );
  factory.created[0].opts.onContextMenu(20, 20);
  const menu = q<HTMLElement>(pane, ".sfe-popup-menu");
  assert.equal(menu.hidden, false);
  assert.equal(
    [...menu.querySelectorAll<HTMLButtonElement>(".sfe-popup-menu-item")].some((n) => /粘贴/.test(n.textContent)),
    false,
    "只读运行窗口不得出现「粘贴」"
  );
});

test("工具窗口: 右键菜单靠近视口右下边缘时被 clamp（向左/上翻转，不被遮挡）", async () => {
  const win = dom.window;
  const proto = win.Element.prototype;
  const orig = proto.getBoundingClientRect;
  // jsdom 无布局：给菜单一个固定尺寸，才能验证 clamp 数学。
  // as: 只伪造组件读取的 width/height（及 left/top），DOMRect 的 x/y/toJSON 在本用例永不接触。
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    if (this.classList && this.classList.contains("sfe-popup-menu")) {
      return { width: 200, height: 120, left: 0, top: 0, right: 200, bottom: 120 } as DOMRect;
    }
    return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 } as DOMRect;
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
    const menu = q<HTMLElement>(pane, ".sfe-popup-menu");
    assert.equal(menu.style.left, `${vw - 2 - 200}px`, "向右越界时左移到菜单完整可见");
    assert.equal(menu.style.top, `${vh - 2 - 120}px`, "向下越界时上移到菜单完整可见");
  } finally {
    proto.getBoundingClientRect = orig;
  }
});
