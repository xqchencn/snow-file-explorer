/**
 * 工具栏运行控件组件 (src/components/run-toolbar.js)
 *
 * 对标 IDEA 主工具栏右上角的 Run widget：
 *   [配置图标] dev ⌄ │ ▶ Run / ⟳ Rerun │ ■ Stop
 *
 *   - 配置选择器：常显**当前选中的运行配置名**（一眼知道 Run/Stop 的是哪条）；点击展开下拉切换配置。
 *   - 主按钮：未运行显示 ▶ Run；运行中显示 ⟳ Rerun（点击 = 停掉当前配置再重跑，IDEA 的 Rerun 语义）。
 *   - Stop 按钮：仅当前配置运行中时出现，点击**只停当前配置**，不波及其它配置。
 *     （逐条 / 全部停止已移到「运行」工具窗口的工具栏，顶栏只保留当前配置的 Run/Stop。）
 *   - 未识别到命令时整个控件隐藏（IDEA 没有 run configuration 就不显示 Run）。
 *
 * 组件只读状态、不持有业务状态：状态由调用方（index.js 的 state.terminals）持有，通过 getState() 读取。
 */

import { el } from "../utils/dom.js";
import { createActionIcon } from "../icons/action-icons.js";

/** 解析命令对象上的本地化标签（npm script 名原样，不做汉化）。 */
function commandLabel(t, command) {
  return command.labelKey ? t(command.labelKey, command.labelFallback) : command.labelFallback;
}

/**
 * 比较两组命令是否等价（id + 命令文本）。
 * @description 调用方每次都传入 flattenCommands() 生成的新数组，引用永不相等；
 *   若直接比引用会导致每次 sync 都重建下拉，破坏展开态与选中项。此处按内容比较。
 */
function sameCommands(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id || a[i].cmd !== b[i].cmd) return false;
  }
  return true;
}

/**
 * 渲染工具栏运行控件。
 * @param {HTMLElement} container 容器（常驻工具栏）
 * @param {Object} options
 * @param {Function} options.t 翻译函数
 * @param {Function} options.getState 读取 { commands, ready, isCommandRunning }
 *   - commands：扁平命令列表（flattenCommands 结果）
 *   - ready：识别是否已完成（未完成时按钮进入 loading 态）
 *   - isCommandRunning：(command) => boolean，判断某条命令当前是否有运行中的终端
 * @param {Function} options.onRun 运行当前选中配置：(command) => void
 * @param {Function} options.onRerun 重新运行当前选中配置（停+跑）：(command) => void
 * @param {Function} options.onStop 停止当前选中配置：(command) => void
 * @returns {{sync: () => void, dispose: () => void}}
 */
export function renderRunToolbar(container, options) {
  const { t, getState, onRun, onRerun, onStop } = options;

  container.replaceChildren();
  container.classList.add("sfe-run-toolbar");

  // ── 配置选择器：[图标] 配置名 ⌄ ──
  const configBtn = el("button", "sfe-run-config");
  configBtn.type = "button";
  const configIcon = el("span", "sfe-run-config-icon");
  const configName = el("span", "sfe-run-config-name");
  const configChevron = el("span", "sfe-run-config-chevron");
  configChevron.appendChild(createActionIcon("chevronDown", 12));
  configBtn.appendChild(configIcon);
  configBtn.appendChild(configName);
  configBtn.appendChild(configChevron);

  // ── 主按钮：未运行 ▶ / 运行中 ⟳ Rerun（纯图标，汉字放 title 悬停显示） ──
  const mainBtn = el("button", "sfe-run-main");
  mainBtn.type = "button";
  const mainIcon = el("span", "sfe-run-main-icon");
  mainBtn.appendChild(mainIcon);

  // ── Stop 按钮：仅当前配置运行中显示，只停当前配置 ──
  const stopBtn = el("button", "sfe-run-stop");
  stopBtn.type = "button";
  stopBtn.hidden = true;
  stopBtn.appendChild(createActionIcon("square", 12));

  // 配置下拉菜单（绝对定位，右对齐向左展开，避免溢出面板右侧）
  const dropdownMenu = el("div", "sfe-run-dropdown");
  dropdownMenu.hidden = true;

  container.appendChild(configBtn);
  container.appendChild(mainBtn);
  container.appendChild(stopBtn);
  container.appendChild(dropdownMenu);

  let dropdownOpen = false;
  let currentCommands = [];
  // 用户选中的配置；默认第一条。
  let selected = null;

  /** 判断某条命令当前是否有运行中的终端（调用方未提供判定时一律视为未运行）。 */
  function isRunning(command) {
    if (!command) return false;
    const state = getState();
    return typeof state.isCommandRunning === "function" ? state.isCommandRunning(command) === true : false;
  }

  /** 关闭配置下拉。 */
  function closeDropdown() {
    dropdownOpen = false;
    dropdownMenu.hidden = true;
    configBtn.classList.remove("active");
  }

  // 配置选择器：展开 / 收起配置下拉
  configBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const wasOpen = dropdownOpen;
    closeDropdown();
    dropdownOpen = !wasOpen;
    dropdownMenu.hidden = !dropdownOpen;
    configBtn.classList.toggle("active", dropdownOpen);
  });

  /**
   * 主按钮：只作用于「当前选中配置」——
   * 未运行 → 运行它；运行中 → Rerun（停掉再重跑，IDEA 语义）。不波及其它配置。
   */
  mainBtn.addEventListener("click", () => {
    const command = selected || currentCommands[0];
    if (!command) return;
    if (isRunning(command)) {
      if (typeof onRerun === "function") onRerun(command);
      return;
    }
    if (typeof onRun === "function") onRun(command);
  });

  // Stop：只停「当前选中配置」，不波及其它（这正是「点一个 Stop 全停」的修复点）。
  stopBtn.addEventListener("click", () => {
    const command = selected || currentCommands[0];
    if (command && typeof onStop === "function") onStop(command);
  });

  // 点击外部关闭下拉
  const closeOnOutside = (event) => {
    if (!dropdownOpen) return;
    if (container.contains(event.target)) return;
    closeDropdown();
  };
  document.addEventListener("click", closeOnOutside, true);

  /**
   * 重建配置下拉（命令集合变化时才需要）。
   * @description 每项：图标 + 配置名 + 行内 ▶ 运行按钮（IDEA 同款）。
   *   点行体 = 仅「选择配置」；点 ▶ = 选择并立即运行该配置。不显示命令原文（配置名已足够），
   *   命令原文放 title 供悬停查看。
   */
  function renderDropdown(commands) {
    dropdownMenu.replaceChildren();
    for (const command of commands) {
      const label = commandLabel(t, command);
      // 用 div 而非 button：行内要再放一个 ▶ 按钮，button 不能嵌套 button。
      const item = el("div", "sfe-run-dropdown-item");
      item.setAttribute("role", "button");
      item.setAttribute("tabindex", "0");
      item.title = command.cmd;
      // dataset 标记命令 id：供 syncSelection() 高亮当前选中配置（不重建 DOM）。
      item.dataset.commandId = command.id;
      const icon = el("span", "sfe-run-dropdown-icon");
      icon.appendChild(createActionIcon("package", 12));
      item.appendChild(icon);
      item.appendChild(el("span", "sfe-run-dropdown-label", label));
      // 行内运行按钮：点击即运行该配置（不改变「行体点击 = 选择」的语义）。
      const runBtn = el("button", "sfe-run-dropdown-run");
      runBtn.type = "button";
      runBtn.title = t("run.toolbar.runTip", "运行 {{label}}", { label });
      runBtn.setAttribute("aria-label", runBtn.title);
      runBtn.appendChild(createActionIcon("play", 11));
      runBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        selected = command;
        closeDropdown();
        sync();
        if (typeof onRun === "function") onRun(command);
      });
      item.appendChild(runBtn);
      item.addEventListener("click", () => {
        selected = command;
        closeDropdown();
        sync();
      });
      dropdownMenu.appendChild(item);
    }
    syncSelection();
  }

  /** 同步下拉里「当前选中配置」的高亮（不重建 DOM）。 */
  function syncSelection() {
    const selectedId = selected ? selected.id : null;
    for (const item of dropdownMenu.children) {
      item.classList.toggle("active", item.dataset.commandId === selectedId);
    }
  }

  /** 同步按钮外观与显隐。 */
  function sync() {
    const state = getState();
    const commands = Array.isArray(state.commands) ? state.commands : [];
    const ready = state.ready === true;

    // 未识别到任何命令：隐藏整个控件（IDEA 无 run configuration 即不显示）。
    if (!ready || commands.length === 0) {
      container.hidden = true;
      return;
    }
    container.hidden = false;

    // 命令集合变化时重建下拉（按内容比较，避免每次 sync 重建而丢掉展开态）。
    if (!sameCommands(commands, currentCommands)) {
      currentCommands = commands;
      // 选中项若已不在命令集合中，重置为第一条。
      if (!selected || !commands.some((c) => c.id === selected.id)) selected = commands[0];
      renderDropdown(commands);
    }

    const activeCommand = selected || commands[0];
    const activeRunning = isRunning(activeCommand);
    const label = commandLabel(t, activeCommand);

    // 配置选择器：常显当前配置名；运行中在图标上叠一个绿点（IDEA 同款）。
    configIcon.replaceChildren(createActionIcon("package", 13));
    configIcon.classList.toggle("running", activeRunning);
    configName.textContent = label;
    configBtn.title = t("run.toolbar.selectCommand", "选择运行配置");
    configBtn.setAttribute("aria-label", configBtn.title);
    // 配置下拉里高亮当前选中项（IDEA 同款）。
    syncSelection();

    // 主按钮：未运行 ▶；运行中 ⟳ Rerun。纯图标，汉字放 title（hover 显示）。
    mainIcon.replaceChildren(createActionIcon(activeRunning ? "rerun" : "play", 14));
    mainBtn.classList.toggle("running", activeRunning);
    mainBtn.title = activeRunning
      ? t("run.toolbar.rerunTip", "重新运行 {{label}}", { label })
      : t("run.toolbar.runTip", "运行 {{label}}", { label });
    mainBtn.setAttribute("aria-label", mainBtn.title);

    // Stop：仅当前配置运行中显示，只停当前配置。
    stopBtn.hidden = !activeRunning;
    stopBtn.title = t("run.toolbar.stopTip", "停止 {{label}}", { label });
    stopBtn.setAttribute("aria-label", stopBtn.title);
  }

  sync();
  return {
    sync,
    /** 组件卸载：解绑 document 监听，避免泄漏。 */
    dispose() {
      document.removeEventListener("click", closeOnOutside, true);
    },
  };
}
