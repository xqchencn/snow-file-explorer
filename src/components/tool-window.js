/**
 * 通用工具窗口组件 (src/components/tool-window.js)
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

import { el, copyToClipboard } from "../utils/dom.js";
import { createActionIcon } from "../icons/action-icons.js";

/**
 * 读取系统剪贴板文本。
 * @description 优先宿主 IPC（window.snow.readClipboardText，走主进程、无渲染进程权限限制，
 *   宿主终端自身粘贴即用此 API）；否则退回标准 Clipboard API；都不可用返回空串。
 * @returns {Promise<string>}
 */
function readClipboardText() {
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
async function hasClipboardText() {
  const text = await readClipboardText();
  return !!text;
}

/** 创建工具窗口内的图标按钮（统一 type / title / aria-label）。 */
function iconButton(className, iconName, title, size = 14) {
  const btn = el("button", className);
  btn.type = "button";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.appendChild(createActionIcon(iconName, size));
  return btn;
}

/**
 * 渲染一个工具窗口（终端 / 运行）。
 * @param {HTMLElement} container 窗口容器（常驻 layout）
 * @param {Object} options
 * @param {Function} options.t 翻译函数
 * @param {"terminal"|"run"} [options.kind="terminal"] 窗口种类
 * @param {Function} options.getTerminals 读取本窗口终端集合（调用方已按 mode 过滤）
 * @param {Function} options.getActiveId 读取本窗口当前激活终端 id
 * @param {Function} options.createTerminal 终端视图工厂 (host, {onData,onResize,readOnly}) => view
 * @param {Function} [options.onSelectTab] 点击 tab：(id) => void
 * @param {Function} [options.onNewTerminal] 仅 kind=terminal：点击左侧「＋新建」：() => void
 * @param {Function} [options.onCloseTerminal] 关闭某 tab：(id) => void
 * @param {Function} [options.onMinimize] 收起窗口（不终止进程）
 * @param {Function} [options.onRerun] 仅 kind=run：重跑该 tab：(id) => void
 * @param {Function} [options.onStop] 仅 kind=run：停止该 tab：(id) => void
 * @param {Function} [options.onClear] 清空该 tab 输出：(id) => void
 * @param {Function} [options.onScrollToBottom] 滚动到底：(id) => void
 * @param {Function} [options.onStopAll] 仅 kind=run：停止全部运行：() => void
 * @param {Function} [options.onCloseOthers] 关闭其它 tab：(id) => void
 * @param {Function} [options.onCloseAll] 关闭全部 tab：() => void
 * @param {Function} [options.onCopyTab] 复制该 tab 的标识（命令 / 标题）：(id) => void
 * @param {Function} [options.onCopySelection] 仅 kind=run：复制当前 tab 的选中文本：(id, text) => void
 * @param {Function} [options.onPasteText] 终端右键「粘贴」的剪贴板文本来源：() => Promise<string>
 * @returns {{rebuild: Function, syncActive: Function, write: Function, getSizes: Function, fit: Function, focus: Function, clear: Function, scrollToBottom: Function, dispose: Function}}
 */
export function renderToolWindow(container, options) {
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
  let newTabBtn = null;
  if (!isRun && typeof onNewTerminal === "function") {
    newTabBtn = iconButton("sfe-run-collapse new", "plus", t("run.newTerminal", "新建终端"), 13);
    newTabBtn.addEventListener("click", () => onNewTerminal());
  }

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
  container.appendChild(tabsBar);

  // ── 工具栏：仅运行窗口有（重跑 / 停止 / 复制选中文本 / 滚动到底 / 清空 / ⋮）──
  let toolbarRefs = null;
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
  let tabNodes = new Map();
  // 终端视图：id → { view, host }
  let views = new Map();
  // 当前右键 / 菜单锚定的 tab id
  let menuTabId = null;

  /** 当前终端集合（防御调用方返回非数组）。 */
  function list() {
    const arr = typeof getTerminals === "function" ? getTerminals() : null;
    return Array.isArray(arr) ? arr : [];
  }

  /** 当前激活终端：优先 activeId，否则退化为第一条。 */
  function activeTerminal() {
    const arr = list();
    const id = typeof getActiveId === "function" ? getActiveId() : null;
    return arr.find((x) => x && x.id === id) || arr[0] || null;
  }

  /** 对当前激活终端执行动作（无激活 tab 则忽略）。 */
  function withActive(fn) {
    const active = activeTerminal();
    if (active) fn(active.id, active);
  }

  /** 当前激活终端的 xterm 视图（无则 null）。 */
  function activeView() {
    const active = activeTerminal();
    const entry = active ? views.get(active.id) : null;
    return entry ? entry.view : null;
  }

  /** 当前激活终端是否有选中文本（决定「复制选中文本」按钮可用态）。 */
  function activeHasSelection() {
    const view = activeView();
    return !!(view && typeof view.hasSelection === "function" && view.hasSelection());
  }

  /** 复制当前激活终端的选中文本（无选区则忽略）。 */
  function copySelection() {
    const active = activeTerminal();
    const view = activeView();
    if (!active || !view) return;
    const text = typeof view.getSelection === "function" ? view.getSelection() : "";
    if (text && typeof onCopySelection === "function") onCopySelection(active.id, text);
  }

  // ───────────────────────── 浮动菜单 ─────────────────────────

  /** 关闭浮动菜单。 */
  function closeMenu() {
    menu.hidden = true;
    menuTabId = null;
  }

  /**
   * 在 (x, y) 打开浮动菜单。
   * @param {Array<{label?: string, icon?: string, onClick?: Function, separator?: boolean}>} items
   */
  function openMenu(items, x, y) {
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
    const containerRect =
      typeof container.getBoundingClientRect === "function"
        ? container.getBoundingClientRect()
        : { left: 0, top: 0 };
    const vw = (typeof window !== "undefined" && window.innerWidth) || 0;
    const vh = (typeof window !== "undefined" && window.innerHeight) || 0;
    const rect =
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

  /** 某 tab 的右键菜单项（终端 / 运行共用，运行窗口另加「停止」）。 */
  function tabMenuItems(id) {
    const term = list().find((x) => x && x.id === id);
    const items = [];
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
    return items;
  }

  /** 打开某 tab 的右键菜单（tab 本身 / 内容区空白均复用）。 */
  function openTabMenu(id, x, y) {
    menuTabId = id;
    openMenu(tabMenuItems(id), x, y);
  }

  /** 内容区右键：对当前激活 tab 打开菜单。 */
  function openActiveTabMenu(x, y) {
    const active = activeTerminal();
    if (active) openTabMenu(active.id, x, y);
  }

  /**
   * 某 tab 的「关闭类」菜单项（去掉复制命令 / 运行窗口的停止·重新运行），供内容区菜单复用。
   * @param {string} id tab id
   * @returns {Array} 菜单项
   */
  function closeMenuItems(id) {
    const out = [];
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
   * @param {Array} items 菜单项（粘贴项需带 paste:true 标记）
   */
  function openClipboardMenu(items, x, y) {
    (async () => {
      const hasText = await hasClipboardText();
      openMenu(
        hasText ? items : items.map((it) => (it.paste ? { ...it, disabled: true } : it)),
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
  function openTerminalMenu(id, x, y) {
    const term = list().find((x) => x && x.id === id);
    const entry = views.get(id);
    const view = entry && entry.view;
    const readOnly = term ? term.mode === "run" : false;
    const hasSel = !!(view && typeof view.hasSelection === "function" && view.hasSelection());
    const items = [];
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
  function pasteInto(id) {
    if (typeof onPasteText !== "function") return;
    Promise.resolve(onPasteText())
      .then((text) => {
        const entry = views.get(id);
        if (text && entry && entry.view && typeof entry.view.paste === "function") entry.view.paste(text);
      })
      .catch(() => {});
  }

  /** ⋮ 更多菜单（运行窗口工具栏）：停止全部 / 关闭其它 / 关闭全部。 */
  function toggleMoreMenu(anchor) {
    if (!menu.hidden && menuTabId === "__more__") {
      closeMenu();
      return;
    }
    menuTabId = "__more__";
    const active = activeTerminal();
    const items = [
      { label: t("run.window.stopAll", "停止全部运行"), icon: "square", onClick: () => onStopAll && onStopAll() },
      { separator: true },
      {
        label: t("run.closeOthers", "关闭其它"),
        onClick: () => active && onCloseOthers && onCloseOthers(active.id),
      },
      { label: t("run.closeAll", "关闭全部"), onClick: () => onCloseAll && onCloseAll() },
    ];
    const rect =
      typeof anchor.getBoundingClientRect === "function"
        ? anchor.getBoundingClientRect()
        : { left: 0, bottom: 0 };
    openMenu(items, rect.left || 0, rect.bottom || 0);
  }

  // ───────────────────────── tab 栏渲染 ─────────────────────────

  /** 重建 tab 栏（终端集合变化时才需要）。 */
  function renderTabs() {
    tabList.replaceChildren();
    tabNodes = new Map();
    for (const term of list()) {
      const tab = el("button", "sfe-run-tab");
      tab.type = "button";
      const labelText = term.title || t("run.terminal", "终端");
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
  function syncTabs() {
    const active = activeTerminal();
    const currentId = active ? active.id : null;
    for (const [id, node] of tabNodes) {
      node.tab.classList.toggle("active", id === currentId);
      node.tab.setAttribute("aria-selected", id === currentId ? "true" : "false");
    }
  }

  /** 同步运行窗口工具栏按钮的可用态：停止仅在该 tab 运行中可用；复制选中文本仅有选区时可用；其余需有激活 tab。 */
  function syncToolbar() {
    if (!toolbarRefs) return;
    const active = activeTerminal();
    const running = !!active && active.exited !== true;
    toolbarRefs.rerun.disabled = !active;
    toolbarRefs.stop.disabled = !running;
    if (toolbarRefs.copy) toolbarRefs.copy.disabled = !activeHasSelection();
    toolbarRefs.scroll.disabled = !active;
    toolbarRefs.clear.disabled = !active;
  }

  /** 为集合中尚未创建视图的终端创建 xterm 并绑定输入/尺寸回调。 */
  function ensureViews() {
    for (const term of list()) {
      if (views.has(term.id)) continue;
      const host = el("div", "sfe-run-terminal-host");
      host.hidden = true;
      body.appendChild(host);
      const view = createTerminal(host, {
        // 模式 A（一次性运行）只读：执行期间禁止键盘输入（视图内部用 disableStdin 实现）。
        readOnly: term.mode === "run",
        onData: (data) => {
          if (typeof term.onInput === "function") term.onInput(data);
        },
        onResize: (cols, rows) => {
          if (typeof term.onResize === "function") term.onResize(cols, rows);
        },
        // 终端内容区右键：复制 / 粘贴 / 全选 + 关闭项（由组件弹菜单）。
        onContextMenu: (x, y) => openTerminalMenu(term.id, x, y),
        // 选区变化：刷新「复制选中文本」按钮的可用态（仅运行窗口有该按钮）。
        onSelectionChange: () => syncToolbar(),
      });
      views.set(term.id, { view, host });
    }
  }

  /** 销毁已从集合移除的终端视图。 */
  function pruneViews() {
    const ids = new Set(list().map((x) => x.id));
    for (const [id, entry] of views) {
      if (ids.has(id)) continue;
      entry.view.dispose();
      entry.host.remove();
      views.delete(id);
    }
  }

  /** 显示激活终端：其余隐藏，当前 fit + focus（切 tab 后终端尺寸正确、可立即输入）。 */
  function syncActiveView() {
    const active = activeTerminal();
    if (!active) return;
    const entry = views.get(active.id);
    if (!entry) return;
    for (const [id, item] of views) {
      item.host.hidden = id !== active.id;
    }
    entry.view.fit();
    entry.view.focus();
  }

  /** 全量同步：tab 栏 + 视图集合 + 激活态 + 工具栏态。 */
  function rebuild() {
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
  const onDocKey = (event) => {
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
    /** 向指定终端写入原始输出（含 ANSI，交给 xterm）。 */
    write(id, data) {
      const entry = views.get(id);
      if (entry) entry.view.write(data);
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
      for (const [, entry] of views) entry.view.dispose();
      views = new Map();
    },
  };
}
