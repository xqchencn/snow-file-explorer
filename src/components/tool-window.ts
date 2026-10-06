/**
 * 通用工具窗口组件 (src/components/tool-window.ts)
 *
 * 对标 IDEA 的 tool window（Terminal / Run）：停靠在底部的工具窗口，多 tab，
 *   每个 tab 一个 xterm 终端实例。同一个组件渲染两种窗口，靠 kind 区分：
 *   - kind="terminal"：交互式终端窗口。tab 栏**左端**有「＋新建」。
 *   - kind="run"：运行窗口。无新建按钮；tab 栏下方有工具栏
 *     （重跑 ⟳ / 停止 ■ / 滚动到底 ⬇ / 清空 🗑 / ⋮ 更多），对齐 IDAE Run 工具窗口。
 *
 * 组件不持有业务状态：终端集合与激活项由调用方（index.js 的 state）持有，
 *   通过 getTerminals() / getActiveId() 读取（调用方已按 mode 过滤好本窗口的终端）。
 * xterm 实例通过 createTerminal 工厂注入：生产环境传 createXtermView，
 *   单测注入假实现（node 环境无 DOM，无法真跑 xterm），保证组件逻辑可单测。
 */

import { el, copyToClipboard } from "../utils/dom.ts";
import { createActionIcon } from "../icons/action-icons.ts";
import type { TranslateFn } from "../types/panel-state.ts";
import type { XtermViewOptions } from "./terminal-view.ts";

/**
 * 工具窗口 / 终端记录的双模式取值。
 * @description 两个字段共用这一份取值：`options.kind` 标窗口种类（terminal 窗口可新建、
 *   run 窗口带工具栏），终端记录的 `mode` 标该 tab 的模式（index.ts 按 mode 把 tab 分给对应窗口）。
 *   出处：src/index.ts 的 handleNewTerminal（`opts.mode === "run" ? "run" : "terminal"`）。
 */
export type ToolWindowMode = "terminal" | "run";

/**
 * 工具窗口停靠位置。
 * @description 出处：src/index.ts 的 `state.toolDock`（"bottom" 底栏 / "right" 右侧），
 *   经 `options.getDock` 读入；两窗口共用，与代码预览同侧。
 */
export type ToolWindowDock = "bottom" | "right";

/**
 * 工具窗口消费到的终端记录切片。
 * @description 真源是 src/index.ts 的 `state.terminals` 元素（pty 会话、阶段令牌等字段组件不用，
 *   故不在这里声明）。组件只读下列字段，写操作一律回调调用方。
 */
export type ToolWindowTerminal = {
  /** 终端 id（运行 tab 为命令 id，交互终端为 `term-*` id）；必填，tab 与视图都以它为键。 */
  id: string;
  /** 该 tab 的模式（见 ToolWindowMode）；必填，决定只读渲染与所属窗口。 */
  mode: ToolWindowMode;
  /** tab 展示标题；可缺，缺失时组件回退 `t("run.terminal", "终端")`。 */
  title?: string;
  /** 是否已退出；可缺，缺省按未退出渲染（仅 mode="run" 参与 ✓/✗ 展示）。 */
  exited?: boolean;
  /** 退出码；可缺或为 null（未退出 / 未知），未知时 tab 上显示 `?`。 */
  exitCode?: number | null;
  /** 是否为「其他项目」的后台任务 tab；可缺，true 时不画 tab 且工具栏重跑/停止一起藏。 */
  hiddenRun?: boolean;
  /** 所属项目展示名；可缺，存在时 tab 标签拼成 `标题 · 项目名`。 */
  projectLabel?: string;
  /** 键盘输入回调；可缺或为 null（index.ts 起 PTY 后才挂上，故组件调用前判 typeof）。 */
  onInput?: ((data: string) => void) | null;
  /** 尺寸变化回调；可缺或为 null，同上（组件调用前判 typeof）。 */
  onResize?: ((cols: number, rows: number) => void) | null;
};

/**
 * 注入视图的终端尺寸（列/行）。
 * @description `handle.getSizes` 的返回形状；调用方（index.ts）建 PTY 时用它取真实尺寸。
 */
export type ToolTerminalSize = {
  /** 终端列数；来自 xterm 视图当前 cols（无视图时整个返回值为 null）。 */
  cols: number;
  /** 终端行数；来自 xterm 视图当前 rows。 */
  rows: number;
};

/**
 * `createTerminal` 工厂产出的终端视图（组件实际调用到的切片）。
 * @description 只有组件里不判空就调的成员声明为必需；其余成员组件都用
 *   `typeof view.xxx === "function"` 判过才调，故声明为可缺——真实现是
 *   src/components/terminal-view.ts 的 createXtermView 返回值，单测注入的假视图只需实现必需项。
 */
export type ToolTerminalView = {
  /** 写入原始输出（含 ANSI）；必需，`handle.write` 直接调用不判空。 */
  write: (data: string) => void;
  /** 让 xterm 按容器尺寸重算；必需，切 tab 与窗口可见时直接调用。 */
  fit: () => void;
  /** 聚焦终端；必需，切 tab 后直接调用。 */
  focus: () => void;
  /** 释放 xterm 实例；必需，pruneViews / dispose 直接调用。 */
  dispose: () => void;
  /** 当前列数；必需，getSizes 直接读（真实现是 getter）。 */
  cols: number;
  /** 当前行数；必需，getSizes 直接读。 */
  rows: number;
  /** 清空视口与回滚缓冲；可缺（工具栏 🗑），组件判 typeof 后才调。 */
  clear?: () => void;
  /** 滚动到底；可缺（工具栏 ⬇），组件判 typeof 后才调。 */
  scrollToBottom?: () => void;
  /** 是否有选区；可缺（决定「复制选中文本」可用态），组件判 typeof 后才调。 */
  hasSelection?: () => boolean;
  /** 读取选区文本；可缺，组件判 typeof 后才调，缺失时按空串处理。 */
  getSelection?: () => string;
  /** 粘贴文本进终端；可缺（只读运行窗口不调），组件判 typeof 后才调。 */
  paste?: (text: string) => void;
  /** 全选缓冲；可缺，组件判 typeof 后才调。 */
  selectAll?: () => void;
  /**
   * Promise 的判别位。
   * @description 视图本体永远没有这个字段（声明为只能缺省的 undefined），
   *   用它把「同步返回的视图」与「异步解析出的视图」区分开（见 ensureViews 里的
   *   `typeof created.then === "function"`）。
   */
  then?: undefined;
};

/**
 * `createTerminal` 工厂的返回：视图本体，或解析出视图的 Promise。
 * @description 生产环境 index.ts 注入的是懒加载工厂（xterm 在按需加载的终端块里），
 *   返回 Promise；单测注入的实现同步返回视图。
 */
export type CreatedToolTerminalView = ToolTerminalView | Promise<ToolTerminalView>;

/**
 * 浮动菜单的一行（tab 右键菜单 / 内容区菜单 / 工具栏 ⋮ 菜单共用同一形状）。
 * @description 分隔线与可点项用同一个数组表达，故除 onClick 外全部可缺。
 */
export type ToolPopupMenuItem = {
  /** 行文案；分隔行（separator）可缺，普通行缺失时标签为空串。 */
  label?: string;
  /** lucide 图标名（经 createActionIcon 渲染）；可缺表示不画图标。 */
  icon?: string;
  /** 点击行为；可缺（分隔行、置灰行没有）。 */
  onClick?: () => void;
  /** 是否为分隔线；可缺，true 时只渲染一条分割线。 */
  separator?: boolean;
  /** 是否置灰不可点；可缺（如剪贴板为空时的「粘贴」）。 */
  disabled?: boolean;
  /** 是否显示勾选态；可缺（如「显示其他项目的任务」开关）。 */
  checked?: boolean;
  /** 是否为「读取剪贴板后决定可用态」的粘贴项；可缺，仅内容区菜单打标（见 openClipboardMenu）。 */
  paste?: boolean;
};

/**
 * 运行窗口工具栏按钮引用（终端窗口没有工具栏，故整体可缺）。
 */
type RunToolbarRefs = {
  /** 「重新运行」按钮。 */
  rerun: HTMLButtonElement;
  /** 「停止」按钮。 */
  stop: HTMLButtonElement;
  /** 「复制选中文本」按钮（仅有选区时可用）。 */
  copy: HTMLButtonElement;
  /** 「滚动到底」按钮。 */
  scroll: HTMLButtonElement;
  /** 「清空输出」按钮。 */
  clear: HTMLButtonElement;
};

/**
 * renderToolWindow 的入参。
 * @description 组件不持有业务状态：集合与激活项都靠 getter 现读，动作一律回调给调用方
 *   （src/index.ts 的 state）。除 t / getTerminals / getActiveId / createTerminal 外全部可缺，
 *   缺失即对应交互不可用（组件调用前都判 typeof）。
 */
export type ToolWindowOptions = {
  /** 插件内部翻译函数（带中文兜底与 `{{name}}` 插值）。 */
  t: TranslateFn;
  /** 窗口种类（见 ToolWindowMode）；可缺，默认 "terminal"。 */
  kind?: ToolWindowMode;
  /** 读取本窗口终端集合（调用方已按 mode 过滤好）。 */
  getTerminals: () => ToolWindowTerminal[];
  /** 读取本窗口当前激活终端 id；可缺或返回 null（无激活项）。 */
  getActiveId: () => string | null;
  /** 终端视图工厂：第二参数形状见 XtermViewOptions；返回值见 CreatedToolTerminalView。 */
  createTerminal: (host: HTMLElement, options: XtermViewOptions) => CreatedToolTerminalView;
  /** 点击 tab 切换激活项；可缺。 */
  onSelectTab?: (id: string) => void;
  /** 仅 kind=terminal：点击左侧「＋新建」；可缺（缺失时不渲染新建按钮）。 */
  onNewTerminal?: () => void;
  /** 关闭某 tab；可缺。 */
  onCloseTerminal?: (id: string) => void;
  /** 收起窗口（不终止进程）；可缺。 */
  onMinimize?: () => void;
  /** 当前停靠位置（见 ToolWindowDock）；可缺，缺失按 "bottom" 渲染。 */
  getDock?: () => ToolWindowDock;
  /** 在底栏与右侧之间切换停靠；可缺。 */
  onToggleDock?: () => void;
  /** 仅 kind=run：重跑该 tab；可缺。 */
  onRerun?: (id: string) => void;
  /** 仅 kind=run：停止该 tab；可缺。 */
  onStop?: (id: string) => void;
  /** 清空该 tab 输出；可缺。 */
  onClear?: (id: string) => void;
  /** 滚动该 tab 到底；可缺。 */
  onScrollToBottom?: (id: string) => void;
  /** 仅 kind=run：停止全部运行；可缺。 */
  onStopAll?: () => void;
  /** 关闭其它 tab；可缺。 */
  onCloseOthers?: (id: string) => void;
  /** 关闭全部 tab；可缺。 */
  onCloseAll?: () => void;
  /** 复制该 tab 的标识（命令 / 标题）；可缺。 */
  onCopyTab?: (id: string) => void;
  /** 仅 kind=run：复制当前 tab 的选中文本；可缺。 */
  onCopySelection?: (id: string, text: string) => void;
  /** 终端右键「粘贴」的剪贴板文本来源；可缺（缺失时不提供粘贴）。 */
  onPasteText?: () => Promise<string>;
  /** 仅 kind=run：是否正在显示其他项目的后台任务；可缺（缺失时右键菜单不给开关）。 */
  getShowOtherRuns?: () => boolean;
  /** 仅 kind=run：切换上述显示；可缺。 */
  onToggleShowOtherRuns?: () => void;
};

/**
 * renderToolWindow 的返回句柄：调用方用它驱动已渲染的窗口（不重建 DOM）。
 */
export type ToolWindowHandle = {
  /** 全量同步：tab 栏 + 视图集合 + 激活态 + 工具栏态。 */
  rebuild: () => void;
  /** 切换激活 tab 后调用（不重建 DOM，保住终端实例与滚动位置）。 */
  syncActive: () => void;
  /** 停靠变化后刷新右上角切换按钮（不重建终端）。 */
  syncDock: () => void;
  /** 向指定终端写入原始输出（含 ANSI）；视图仍在加载时先暂存。 */
  write: (id: string, data: unknown) => void;
  /** 读取某终端当前 cols/rows（供调用方建 pty 时使用真实尺寸）；无视图时返回 null。 */
  getSizes: (id: string) => ToolTerminalSize | null;
  /** 让激活终端重新适配尺寸（窗口可见/尺寸变化后）。 */
  fit: () => void;
  /** 窗口可见时聚焦激活终端（打开即可直接输入）。 */
  focus: () => void;
  /** 清空某终端输出（运行窗口工具栏 🗑）。 */
  clear: (id: string) => void;
  /** 滚动某终端到底（运行窗口工具栏 ⬇）。 */
  scrollToBottom: (id: string) => void;
  /** 卸载：释放全部 xterm 实例与文档监听。 */
  dispose: () => void;
};

/**
 * 读取系统剪贴板文本。
 * @description 优先宿主 IPC（window.snow.readClipboardText，走主进程、无渲染进程权限限制，
 *   宿主终端自身粘贴即用此 API）；否则退回标准 Clipboard API；都不可用返回空串。
 */
function readClipboardText(): Promise<string> {
  const snow = typeof window !== "undefined" ? window.snow : null;
  if (snow && typeof snow.readClipboardText === "function") {
    return Promise.resolve(snow.readClipboardText())
      .then((text) => String(text || ""))
      .catch(() => "");
  }
  if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.readText === "function") {
    return navigator.clipboard.readText()
      .then((text) => String(text || ""))
      .catch(() => "");
  }
  return Promise.resolve("");
}

/** 剪贴板是否有可粘贴文本。 */
async function hasClipboardText(): Promise<boolean> {
  const text = await readClipboardText();
  return !!text;
}

/** 创建工具窗口内的图标按钮（统一 type / title / aria-label）。 */
function iconButton(className: string, iconName: string, title: string, size = 14): HTMLButtonElement {
  const btn = el("button", className);
  btn.type = "button";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.appendChild(createActionIcon(iconName, size));
  return btn;
}

/**
 * 渲染一个工具窗口（终端 / 运行）。
 * @param container 窗口容器（常驻 layout）
 * @param options 入参对象，逐字段含义见 ToolWindowOptions
 * @param options.t 翻译函数
 * @param [options.kind="terminal"] 窗口种类
 * @param options.getTerminals 读取本窗口终端集合（调用方已按 mode 过滤）
 * @param options.getActiveId 读取本窗口当前激活终端 id
 * @param options.createTerminal 终端视图工厂 (host, {onData,onResize,readOnly}) => view
 * @param [options.onSelectTab] 点击 tab：(id) => void
 * @param [options.onNewTerminal] 仅 kind=terminal：点击左侧「＋新建」：() => void
 * @param [options.onCloseTerminal] 关闭某 tab：(id) => void
 * @param [options.onMinimize] 收起窗口（不终止进程）
 * @param [options.getDock] 当前停靠："bottom" 底栏 | "right" 右侧
 * @param [options.onToggleDock] 在底栏与右侧之间切换：() => void
 * @param [options.onRerun] 仅 kind=run：重跑该 tab：(id) => void
 * @param [options.onStop] 仅 kind=run：停止该 tab：(id) => void
 * @param [options.onClear] 清空该 tab 输出：(id) => void
 * @param [options.onScrollToBottom] 滚动到底：(id) => void
 * @param [options.onStopAll] 仅 kind=run：停止全部运行：() => void
 * @param [options.onCloseOthers] 关闭其它 tab：(id) => void
 * @param [options.onCloseAll] 关闭全部 tab：() => void
 * @param [options.onCopyTab] 复制该 tab 的标识（命令 / 标题）：(id) => void
 * @param [options.onCopySelection] 仅 kind=run：复制当前 tab 的选中文本：(id, text) => void
 * @param [options.onPasteText] 终端右键「粘贴」的剪贴板文本来源：() => Promise<string>
 * @param [options.getShowOtherRuns] 仅 kind=run：是否正在显示其他项目的后台任务
 * @param [options.onToggleShowOtherRuns] 仅 kind=run：切换上述显示：() => void
 * @returns 重建 / 同步 / 写入 / 释放 等窗口驱动句柄，形状见 ToolWindowHandle
 */
export function renderToolWindow(container: HTMLElement, options: ToolWindowOptions): ToolWindowHandle {
  const {
    t,
    kind = "terminal",
    getTerminals,
    getActiveId,
    createTerminal,
    onSelectTab,
    onNewTerminal,
    onCloseTerminal,
    onMinimize,
    getDock,
    onToggleDock,
    onRerun,
    onStop,
    onClear,
    onScrollToBottom,
    onStopAll,
    onCloseOthers,
    onCloseAll,
    onCopyTab,
    onCopySelection,
    onPasteText,
    getShowOtherRuns,
    onToggleShowOtherRuns,
  } = options;
  const isRun = kind === "run";

  container.replaceChildren();

  // ── tab 栏：tab 列表（每个终端一个 tab + 末尾「＋新建」[仅终端]）+ 右端 ⊖收起 ──
  const tabsBar = el("div", "sfe-run-tabs");
  const tabList = el("div", "sfe-run-tab-list");
  tabList.setAttribute("role", "tablist");
  tabsBar.appendChild(tabList);

  // 终端窗口的「＋新建」：放在 tab 列表【末尾】（紧跟最后一个 tab 之后）。
  // 注意：renderTabs 会 replaceChildren 清空 tabList，故此处只创建、不挂载，
  //   每次重建 tab 后由 renderTabs 末尾重新 append（节点复用，事件不丢）。
  let newTabBtn: HTMLButtonElement | null = null;
  if (!isRun && typeof onNewTerminal === "function") {
    newTabBtn = iconButton("sfe-run-collapse new", "plus", t("run.newTerminal", "新建终端"), 13);
    newTabBtn.addEventListener("click", () => onNewTerminal());
  }

  // 停靠切换紧挨最小化左侧：底栏 ↔ 右侧（与代码预览同一侧）。
  const dockBtn = iconButton(
    "sfe-run-collapse dock",
    "panelRight",
    t("run.dockRight", "放到右侧"),
    13,
  );
  dockBtn.addEventListener("click", () => {
    if (typeof onToggleDock === "function") onToggleDock();
  });
  tabsBar.appendChild(dockBtn);

  const minimizeBtn = iconButton(
    "sfe-run-collapse minimize",
    "minus",
    t("run.minimize", "收起工具窗口"),
    13,
  );
  minimizeBtn.addEventListener("click", () => {
    if (typeof onMinimize === "function") onMinimize();
  });
  tabsBar.appendChild(minimizeBtn);

  /** 按当前停靠刷新按钮图标与提示（底栏时指向右侧，右侧时指向底栏）。 */
  function syncDock() {
    const right = (typeof getDock === "function" ? getDock() : "bottom") === "right";
    const title = right ? t("run.dockBottom", "放到底栏") : t("run.dockRight", "放到右侧");
    dockBtn.title = title;
    dockBtn.setAttribute("aria-label", title);
    dockBtn.setAttribute("aria-pressed", right ? "true" : "false");
    dockBtn.classList.toggle("active", right);
    dockBtn.replaceChildren(createActionIcon(right ? "panelBottom" : "panelRight", 13));
  }
  syncDock();
  container.appendChild(tabsBar);

  // ── 工具栏：仅运行窗口有（重跑 / 停止 / 复制选中文本 / 滚动到底 / 清空 / ⋮）──
  let toolbarRefs: RunToolbarRefs | null = null;
  if (isRun) {
    const bar = el("div", "sfe-run-toolbar-bar");
    const rerunBtn = iconButton("sfe-run-tb-btn rerun", "rerun", t("run.window.rerun", "重新运行"), 14);
    const stopBtn = iconButton("sfe-run-tb-btn stop", "square", t("run.window.stop", "停止"), 13);
    // 复制选中文本：只在当前 tab 有选区时可用（选区变化经 onSelectionChange 实时刷新）。
    const copyBtn = iconButton("sfe-run-tb-btn copy", "copy", t("run.copySelection", "复制选中文本"), 13);
    const scrollBtn = iconButton("sfe-run-tb-btn", "arrowDown", t("run.scrollToEnd", "滚动到底"), 14);
    const clearBtn = iconButton("sfe-run-tb-btn", "eraser", t("run.clear", "清空输出"), 13);
    const moreBtn = iconButton("sfe-run-tb-btn more", "more", t("run.toolbar.more", "更多"), 14);
    rerunBtn.addEventListener("click", () => withActive((id) => onRerun && onRerun(id)));
    stopBtn.addEventListener("click", () => withActive((id) => onStop && onStop(id)));
    copyBtn.addEventListener("click", () => copySelection());
    scrollBtn.addEventListener("click", () => withActive((id) => onScrollToBottom && onScrollToBottom(id)));
    clearBtn.addEventListener("click", () => withActive((id) => onClear && onClear(id)));
    moreBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMoreMenu(moreBtn);
    });
    bar.appendChild(rerunBtn);
    bar.appendChild(stopBtn);
    bar.appendChild(copyBtn);
    bar.appendChild(scrollBtn);
    bar.appendChild(clearBtn);
    bar.appendChild(moreBtn);
    container.appendChild(bar);
    toolbarRefs = { rerun: rerunBtn, stop: stopBtn, copy: copyBtn, scroll: scrollBtn, clear: clearBtn };
  }

  // ── 终端容器：每个终端一个 host（激活者显示，其余隐藏；xterm 实例常驻不销毁）──
  const body = el("div", "sfe-run-body");
  // 内容区（xterm 之外的空白）右键：退回当前 tab 的右键菜单。
  body.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openActiveTabMenu(event.clientX, event.clientY);
  });
  container.appendChild(body);

  // ── tab 右键菜单（两个窗口都有）+ 运行工具栏 ⋮ 菜单（复用同一浮动层）──
  const menu = el("div", "sfe-popup-menu");
  menu.hidden = true;
  container.appendChild(menu);

  // tab 节点：id → { tab }
  let tabNodes = new Map<string, { tab: HTMLButtonElement }>();
  // 终端视图：id → { view, host }
  let views = new Map<string, { view: ToolTerminalView; host: HTMLElement }>();
  // xterm 仍在加载时的占位：id → { host, cancelled }
  let pending = new Map<string, { host: HTMLElement; cancelled: boolean }>();
  // 视图尚未就绪时暂存的输出，创建完成后一次性写入。
  let buffers = new Map<string, string>();
  // 当前右键 / 菜单锚定的 tab id
  let menuTabId: string | null = null;

  /** 当前终端集合（防御调用方返回非数组）。 */
  function list(): ToolWindowTerminal[] {
    const arr = typeof getTerminals === "function" ? getTerminals() : null;
    return Array.isArray(arr) ? arr : [];
  }

  /** 当前激活终端：只认还显示在 tab 上的任务，藏起的后台任务不占按钮。 */
  function activeTerminal(): ToolWindowTerminal | null {
    const arr = list().filter((term) => term && !term.hiddenRun);
    const id = typeof getActiveId === "function" ? getActiveId() : null;
    return arr.find((x) => x && x.id === id) || arr[0] || null;
  }

  /** 对当前激活终端执行动作（无激活 tab 则忽略）。 */
  function withActive(fn: (id: string, term: ToolWindowTerminal) => void): void {
    const active = activeTerminal();
    if (active) fn(active.id, active);
  }

  /** 当前激活终端的 xterm 视图（无则 null）。 */
  function activeView(): ToolTerminalView | null {
    const active = activeTerminal();
    const entry = active ? views.get(active.id) : null;
    return entry ? entry.view : null;
  }

  /** 当前激活终端是否有选中文本（决定「复制选中文本」按钮可用态）。 */
  function activeHasSelection(): boolean {
    const view = activeView();
    return !!(view && typeof view.hasSelection === "function" && view.hasSelection());
  }

  /** 复制当前激活终端的选中文本（无选区则忽略）。 */
  function copySelection(): void {
    const active = activeTerminal();
    const view = activeView();
    if (!active || !view) return;
    const text = typeof view.getSelection === "function" ? view.getSelection() : "";
    if (text && typeof onCopySelection === "function") onCopySelection(active.id, text);
  }

  // ───────────────────────── 浮动菜单 ─────────────────────────

  /** 关闭浮动菜单。 */
  function closeMenu(): void {
    menu.hidden = true;
    menuTabId = null;
  }

  /**
   * 在 (x, y) 打开浮动菜单。
   * @param items 菜单项（分隔行用 separator 表达），形状见 ToolPopupMenuItem
   * @param x 菜单左上角的视口 x 坐标（clientX）
   * @param y 菜单左上角的视口 y 坐标（clientY）
   */
  function openMenu(items: ToolPopupMenuItem[], x: number, y: number): void {
    menu.replaceChildren();
    for (const item of items) {
      if (item.separator) {
        menu.appendChild(el("div", "sfe-popup-menu-sep"));
        continue;
      }
      const row = el("button", "sfe-popup-menu-item");
      row.type = "button";
      // 禁用项（如剪贴板为空的「粘贴」）：置灰且点击无效。
      if (item.disabled) row.disabled = true;
      if (item.checked) row.classList.add("checked");
      if (item.icon) row.appendChild(createActionIcon(item.icon, 12));
      row.appendChild(el("span", "sfe-popup-menu-label", item.label));
      row.addEventListener("click", (event) => {
        event.stopPropagation();
        if (item.disabled) return;
        closeMenu();
        if (typeof item.onClick === "function") item.onClick();
      });
      menu.appendChild(row);
    }
    // 先脱离 hidden 才能测量真实尺寸用于定位。
    menu.hidden = false;
    // 视口坐标 → 容器内坐标（容器 position:relative）。
    const containerRect: { left: number; top: number } =
      typeof container.getBoundingClientRect === "function"
        ? container.getBoundingClientRect()
        : { left: 0, top: 0 };
    const vw = (typeof window !== "undefined" && window.innerWidth) || 0;
    const vh = (typeof window !== "undefined" && window.innerHeight) || 0;
    const rect: { width: number; height: number } =
      typeof menu.getBoundingClientRect === "function"
        ? menu.getBoundingClientRect()
        : { width: menu.offsetWidth || 0, height: menu.offsetHeight || 0 };
    // 用视口坐标 clamp，保证菜单不被面板上/下/右边缘遮挡；空间不足时向左/上翻转。
    let left = x;
    if (vw && left + rect.width + 4 > vw) left = Math.max(4, x - rect.width);
    let top = y;
    if (vh && top + rect.height + 4 > vh) top = Math.max(4, y - rect.height);
    menu.style.left = `${Math.max(0, left - (containerRect.left || 0))}px`;
    menu.style.top = `${Math.max(0, top - (containerRect.top || 0))}px`;
  }

  /** 启动窗口右键里的开关：显示或藏起其他项目尚未结束的任务。 */
  function otherRunsToggleItem(): ToolPopupMenuItem | null {
    if (!isRun || typeof onToggleShowOtherRuns !== "function") return null;
    const on = typeof getShowOtherRuns === "function" && getShowOtherRuns();
    return {
      label: t("run.showOtherProjects", "显示其他项目的任务"),
      icon: on ? "check" : "",
      checked: !!on,
      onClick: () => onToggleShowOtherRuns(),
    };
  }

  /** 某 tab 的右键菜单项（终端 / 运行共用，运行窗口另加「停止」）。 */
  function tabMenuItems(id: string): ToolPopupMenuItem[] {
    const term = list().find((x) => x && x.id === id);
    const items: ToolPopupMenuItem[] = [];
    if (isRun && term && term.exited !== true) {
      items.push({ label: t("run.stop", "停止"), icon: "square", onClick: () => onStop && onStop(id) });
    }
    if (isRun) {
      items.push({ label: t("run.restart", "重新运行"), icon: "rerun", onClick: () => onRerun && onRerun(id) });
      items.push({ separator: true });
    }
    items.push({ label: t("run.copyTab", "复制命令"), icon: "copy", onClick: () => onCopyTab && onCopyTab(id) });
    items.push({ separator: true });
    items.push({ label: t("run.closeTab", "关闭"), icon: "close", onClick: () => onCloseTerminal && onCloseTerminal(id) });
    items.push({ label: t("run.closeOthers", "关闭其它"), onClick: () => onCloseOthers && onCloseOthers(id) });
    items.push({ label: t("run.closeAll", "关闭全部"), onClick: () => onCloseAll && onCloseAll() });
    const toggle = otherRunsToggleItem();
    if (toggle) {
      items.push({ separator: true });
      items.push(toggle);
    }
    return items;
  }

  /** 打开某 tab 的右键菜单（tab 本身 / 内容区空白均复用）。 */
  function openTabMenu(id: string, x: number, y: number): void {
    menuTabId = id;
    openMenu(tabMenuItems(id), x, y);
  }

  /** 内容区右键：对当前可见 tab 打开菜单。没有可见 tab 时，启动窗口仍给出后台任务开关。 */
  function openActiveTabMenu(x: number, y: number): void {
    const active = activeTerminal();
    if (active && !active.hiddenRun) {
      openTabMenu(active.id, x, y);
      return;
    }
    const toggle = otherRunsToggleItem();
    if (toggle) openMenu([toggle], x, y);
  }

  /**
   * 某 tab 的「关闭类」菜单项（去掉复制命令 / 运行窗口的停止·重新运行），供内容区菜单复用。
   * @param id tab id
   * @returns 菜单项
   */
  function closeMenuItems(id: string): ToolPopupMenuItem[] {
    const out: ToolPopupMenuItem[] = [];
    for (const item of tabMenuItems(id)) {
      if (item.separator) continue;
      if (item.label === t("run.copyTab", "复制命令")) continue;
      if (isRun && (item.label === t("run.stop", "停止") || item.label === t("run.restart", "重新运行"))) continue;
      out.push(item);
    }
    return out;
  }

  /**
   * 打开「含剪贴板」菜单：剪贴板有文本时才把「粘贴」项启用（否则置灰不可点）。
   * @param items 菜单项（粘贴项需带 paste:true 标记）
   * @param x 菜单左上角的视口 x 坐标（clientX）
   * @param y 菜单左上角的视口 y 坐标（clientY）
   */
  function openClipboardMenu(items: ToolPopupMenuItem[], x: number, y: number): void {
    // 菜单要先知道剪贴板有没有文本才能定「粘贴」项的可用态，这一步是异步的；
    // 不阻塞 openMenu 的调用方（事件回调必须同步返回），故显式 void 标记刻意不等待。
    void (async () => {
      const hasText = await hasClipboardText();
      openMenu(
        hasText ? items : items.map((it: ToolPopupMenuItem) => (it.paste ? { ...it, disabled: true } : it)),
        x,
        y,
      );
    })();
  }

  /**
   * xterm 右键菜单：复制 / 粘贴 / 全选（内容区动作）+ 该 tab 的关闭项（复用 tabMenuItems）。
   * @description 只读（模式 A 运行）终端不提供「粘贴」——xterm 已禁用 stdin；
   *   可交互终端仅在剪贴板有文本时启用「粘贴」（异步读取后再决定 enabled）。
   */
  function openTerminalMenu(id: string, x: number, y: number): void {
    const term = list().find((x) => x && x.id === id);
    const entry = views.get(id);
    const view = entry && entry.view;
    const readOnly = term ? term.mode === "run" : false;
    const hasSel = !!(view && typeof view.hasSelection === "function" && view.hasSelection());
    const items: ToolPopupMenuItem[] = [];
    if (hasSel) {
      items.push({
        label: t("action.copySelection", "复制"),
        icon: "copy",
        onClick: () => {
          if (view && typeof view.getSelection === "function") void copyToClipboard(view.getSelection());
        },
      });
    }
    let needClipboard = false;
    if (!readOnly) {
      items.push({ label: t("action.paste", "粘贴"), icon: "clipboardPaste", paste: true, onClick: () => void pasteInto(id) });
      needClipboard = true;
    }
    items.push({ label: t("run.selectAll", "全选"), icon: "code", onClick: () => view && view.selectAll && view.selectAll() });
    items.push({ separator: true });
    for (const item of closeMenuItems(id)) items.push(item);
    if (needClipboard) openClipboardMenu(items, x, y);
    else openMenu(items, x, y);
  }

  /** 读取剪贴板文本并写入某终端（异步）。 */
  function pasteInto(id: string): void {
    if (typeof onPasteText !== "function") return;
    Promise.resolve(onPasteText())
      .then((text) => {
        const entry = views.get(id);
        if (text && entry && entry.view && typeof entry.view.paste === "function") entry.view.paste(text);
      })
      .catch(() => {});
  }

  /** ⋮ 更多菜单（运行窗口工具栏）：停止全部 / 关闭其它 / 关闭全部。 */
  function toggleMoreMenu(anchor: HTMLElement): void {
    if (!menu.hidden && menuTabId === "__more__") {
      closeMenu();
      return;
    }
    menuTabId = "__more__";
    const active = activeTerminal();
    const items: ToolPopupMenuItem[] = [
      { label: t("run.window.stopAll", "停止全部运行"), icon: "square", onClick: () => onStopAll && onStopAll() },
      { separator: true },
      {
        label: t("run.closeOthers", "关闭其它"),
        onClick: () => active && onCloseOthers && onCloseOthers(active.id),
      },
      { label: t("run.closeAll", "关闭全部"), onClick: () => onCloseAll && onCloseAll() },
    ];
    const rect: { left: number; bottom: number } =
      typeof anchor.getBoundingClientRect === "function"
        ? anchor.getBoundingClientRect()
        : { left: 0, bottom: 0 };
    openMenu(items, rect.left || 0, rect.bottom || 0);
  }

  // ───────────────────────── tab 栏渲染 ─────────────────────────

  /** 重建 tab 栏（终端集合变化时才需要）。 */
  function renderTabs(): void {
    tabList.replaceChildren();
    tabNodes = new Map<string, { tab: HTMLButtonElement }>();
    for (const term of list()) {
      if (term.hiddenRun) continue;
      const tab = el("button", "sfe-run-tab");
      tab.type = "button";
      const labelText = term.projectLabel
        ? `${term.title || t("run.terminal", "终端")} · ${term.projectLabel}`
        : (term.title || t("run.terminal", "终端"));
      // 模式 A（一次性运行）退出后显示 ✓/✗ + 退出码；模式 B（交互终端）不显示。
      const isTermRun = term.mode === "run";
      const exited = isTermRun && term.exited === true;
      const ok = exited && term.exitCode === 0;
      const code = term.exitCode == null ? "?" : term.exitCode;
      tab.title = exited
        ? t("run.status.exited", "已退出（代码 {{code}}）", { code })
        : labelText;
      if (isTermRun) tab.classList.add("sfe-run-tab--run");
      if (exited) tab.classList.add(ok ? "sfe-run-tab--ok" : "sfe-run-tab--fail");
      const dot = el("span", "sfe-run-tab-dot");
      const label = el("span", "sfe-run-tab-label", exited ? `${labelText} ${ok ? "✓" : `✗ (${code})`}` : labelText);
      const close = el("span", "sfe-run-tab-close");
      close.title = t("run.closeTab", "关闭");
      close.appendChild(createActionIcon("close", 10));
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        if (typeof onCloseTerminal === "function") onCloseTerminal(term.id);
      });
      tab.appendChild(dot);
      tab.appendChild(label);
      tab.appendChild(close);
      tab.addEventListener("click", () => {
        if (typeof onSelectTab === "function") onSelectTab(term.id);
      });
      // tab 右键菜单（两个窗口都有）。
      tab.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        menuTabId = term.id;
        openMenu(tabMenuItems(term.id), event.clientX, event.clientY);
      });
      tabNodes.set(term.id, { tab });
      tabList.appendChild(tab);
    }
    // 「＋新建」排在所有 tab 之后（紧跟最后一个 tab 右侧）。
    if (newTabBtn) tabList.appendChild(newTabBtn);
  }

  /** 同步 tab 激活态（不重建 tab 栏）。 */
  function syncTabs(): void {
    const active = activeTerminal();
    const currentId = active ? active.id : null;
    for (const [id, node] of tabNodes) {
      node.tab.classList.toggle("active", id === currentId);
      node.tab.setAttribute("aria-selected", id === currentId ? "true" : "false");
    }
  }

  /** 同步运行窗口工具栏按钮的可用态：停止仅在该 tab 运行中可用；复制选中文本仅有选区时可用；其余需有激活 tab。 */
  function syncToolbar(): void {
    if (!toolbarRefs) return;
    const active = activeTerminal();
    const running = !!active && active.exited !== true;
    // 任务 tab 被藏起时，重跑和停止跟着藏，避免还对着看不见的任务操作。
    const onlyHidden = !active && list().some((term) => term && term.hiddenRun);
    toolbarRefs.rerun.hidden = onlyHidden;
    toolbarRefs.stop.hidden = onlyHidden;
    toolbarRefs.rerun.disabled = !active;
    toolbarRefs.stop.disabled = !running;
    if (toolbarRefs.copy) toolbarRefs.copy.disabled = !activeHasSelection();
    toolbarRefs.scroll.disabled = !active;
    toolbarRefs.clear.disabled = !active;
  }

  /** 为集合中尚未创建视图的终端创建 xterm 并绑定输入/尺寸回调。 */
  function ensureViews(): void {
    for (const term of list()) {
      if (views.has(term.id) || pending.has(term.id)) continue;
      const host = el("div", "sfe-run-terminal-host");
      host.hidden = true;
      body.appendChild(host);
      const created: CreatedToolTerminalView = createTerminal(host, {
        // 模式 A（一次性运行）只读：执行期间禁止键盘输入（视图内部用 disableStdin 实现）。
        readOnly: term.mode === "run",
        onData: (data: string) => {
          if (typeof term.onInput === "function") term.onInput(data);
        },
        onResize: (cols: number, rows: number) => {
          if (typeof term.onResize === "function") term.onResize(cols, rows);
        },
        // 终端内容区右键：复制 / 粘贴 / 全选 + 关闭项（由组件弹菜单）。
        onContextMenu: (x: number, y: number) => openTerminalMenu(term.id, x, y),
        // 选区变化：刷新「复制选中文本」按钮的可用态（仅运行窗口有该按钮）。
        onSelectionChange: () => syncToolbar(),
      });
      if (created && typeof created.then === "function") {
        const slot = { host, cancelled: false };
        pending.set(term.id, slot);
        created.then(
          (view: ToolTerminalView) => {
            pending.delete(term.id);
            if (slot.cancelled || !host.isConnected) {
              if (view && typeof view.dispose === "function") view.dispose();
              if (host.parentNode) host.remove();
              return;
            }
            views.set(term.id, { view, host });
            const buffered = buffers.get(term.id);
            if (buffered && view && typeof view.write === "function") {
              buffers.delete(term.id);
              view.write(buffered);
            }
            syncActiveView();
            syncToolbar();
          },
          () => {
            pending.delete(term.id);
            if (host.parentNode) host.remove();
          }
        );
      } else {
        views.set(term.id, { view: created, host });
      }
    }
  }

  /** 销毁已从集合移除的终端视图。 */
  function pruneViews(): void {
    const ids = new Set(list().map((x) => x.id));
    for (const [id, slot] of pending) {
      if (ids.has(id)) continue;
      slot.cancelled = true;
      if (slot.host.parentNode) slot.host.remove();
      pending.delete(id);
      buffers.delete(id);
    }
    for (const [id, entry] of views) {
      if (ids.has(id)) continue;
      entry.view.dispose();
      entry.host.remove();
      views.delete(id);
      buffers.delete(id);
    }
  }

  /** 显示激活终端：其余隐藏，当前 fit + focus（切 tab 后终端尺寸正确、可立即输入）。 */
  function syncActiveView(): void {
    const active = activeTerminal();
    const currentId = active && !active.hiddenRun ? active.id : null;
    for (const [id, item] of views) {
      item.host.hidden = id !== currentId;
    }
    if (!currentId) return;
    const entry = views.get(currentId);
    if (!entry) return;
    entry.view.fit();
    entry.view.focus();
  }

  /** 全量同步：tab 栏 + 视图集合 + 激活态 + 工具栏态。 */
  function rebuild(): void {
    renderTabs();
    ensureViews();
    pruneViews();
    syncTabs();
    syncToolbar();
    syncActiveView();
  }

  // 点击窗口外 / Escape 关闭浮动菜单（capture 阶段，避免被 stopPropagation 拦截）。
  const onDocClick = () => {
    if (!menu.hidden) closeMenu();
  };
  const onDocKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !menu.hidden) closeMenu();
  };
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onDocKey, true);
  }

  // 首次渲染
  rebuild();

  return {
    rebuild,
    /** 切换激活 tab 后调用（不重建 DOM，保住终端实例与滚动位置）。 */
    syncActive() {
      syncTabs();
      syncToolbar();
      syncActiveView();
    },
    /** 向指定终端写入原始输出（含 ANSI，交给 xterm）。视图还在加载时先暂存。 */
    write(id, data) {
      const text = String(data == null ? "" : data);
      const entry = views.get(id);
      if (entry) {
        entry.view.write(text);
        return;
      }
      if (pending.has(id)) buffers.set(id, (buffers.get(id) || "") + text);
    },
    /** 读取某终端当前 cols/rows（供调用方建 pty 时使用真实尺寸）。 */
    getSizes(id) {
      const entry = views.get(id);
      if (!entry) return null;
      return { cols: entry.view.cols, rows: entry.view.rows };
    },
    /** 清空某终端输出（运行窗口工具栏 🗑）。 */
    clear(id) {
      const entry = views.get(id);
      if (entry && typeof entry.view.clear === "function") entry.view.clear();
    },
    /** 滚动某终端到底（运行窗口工具栏 ⬇）。 */
    scrollToBottom(id) {
      const entry = views.get(id);
      if (entry && typeof entry.view.scrollToBottom === "function") entry.view.scrollToBottom();
    },
    /** 窗口可见/尺寸变化后让激活终端重新适配尺寸。 */
    fit() {
      const active = activeTerminal();
      const entry = active ? views.get(active.id) : null;
      if (entry) entry.view.fit();
    },
    /** 停靠变化后刷新右上角切换按钮（不重建终端）。 */
    syncDock,
    /** 窗口可见时聚焦激活终端（打开即可直接输入）。 */
    focus() {
      const active = activeTerminal();
      const entry = active ? views.get(active.id) : null;
      if (entry) entry.view.focus();
    },
    /** 卸载：释放全部 xterm 实例与文档监听。 */
    dispose() {
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("click", onDocClick, true);
        document.removeEventListener("keydown", onDocKey, true);
      }
      for (const [, slot] of pending) slot.cancelled = true;
      pending = new Map();
      buffers = new Map();
      for (const [, entry] of views) entry.view.dispose();
      views = new Map();
    },
  };
}
