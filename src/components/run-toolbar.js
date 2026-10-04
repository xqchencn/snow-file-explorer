/**
 * 工具栏运行控件组件 (src/components/run-toolbar.js)
 *
 * 对标 IDEA 主工具栏右上角的 Run 控件
 * （https://www.jetbrains.com/help/idea/run-tool-window.html ：运行配置选择器 + Run 按钮）：
 *   - 主按钮：按当前选中配置运行；若已有运行中的 run，则变为 ■ Stop，点击停止全部（防重复运行）。
 *   - 命令下拉：列出**可运行的配置**（npm scripts 等），点击即运行该命令。
 *   - 运行计数徽标：存在多个运行中的 run 时显示数量，如实反映「现在有多个在跑」。
 *   - 未识别到命令时整个控件隐藏（IDEA 没有 run configuration 就不显示 Run）。
 *
 * 组件只读状态、不持有状态：状态由调用方（index.js 的 state.runs / activeRunId）持有。
 */

import { el } from "../utils/dom.js";
import { createActionIcon } from "../icons/action-icons.js";

/** 解析命令对象上的本地化标签。 */
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
 * @param {Function} options.getState 读取 { commands, ready, runningCount, allRunning }
 *   - commands：扁平命令列表（flattenCommands 结果）
 *   - ready：识别是否已完成（未完成时按钮进入 loading 态）
 *   - runningCount：进行中的 run 数量（含启动中）
 *   - allRunning：是否全部进行中的 run 都属于同一条命令（决定主按钮是否可停止）
 * @param {Function} options.onRun 点击运行：(command) => void
 * @param {Function} options.onStopAll 点击停止：() => void
 * @returns {{sync: () => void, dispose: () => void}}
 */
export function renderRunToolbar(container, options) {
  const { t, getState, onRun, onStopAll } = options;

  container.replaceChildren();
  container.classList.add("sfe-run-toolbar");

  // 主按钮：Run / Stop 二态复用同一个按钮（IDEA 同款交互）。
  const mainBtn = el("button", "sfe-run-main");
  mainBtn.type = "button";
  const mainIcon = el("span", "sfe-run-main-icon");
  const mainLabel = el("span", "sfe-run-main-label");
  const countBadge = el("span", "sfe-run-count");
  countBadge.hidden = true;
  mainBtn.appendChild(mainIcon);
  mainBtn.appendChild(mainLabel);
  mainBtn.appendChild(countBadge);

  // 下拉触发器 + 菜单：仅多条命令时显示。
  const dropdownBtn = el("button", "sfe-run-dropdown-btn");
  dropdownBtn.type = "button";
  dropdownBtn.appendChild(createActionIcon("chevronDown", 12));
  const dropdownMenu = el("div", "sfe-run-dropdown");
  dropdownMenu.hidden = true;

  container.appendChild(mainBtn);
  container.appendChild(dropdownBtn);
  container.appendChild(dropdownMenu);

  let dropdownOpen = false;
  let currentCommands = [];
  // 用户在下拉里选中的命令；默认第一条。
  let selected = null;

  /** 主按钮点击：有运行中的 run → 停止全部；否则运行当前选中命令。 */
  mainBtn.addEventListener("click", () => {
    const state = getState();
    if (state.runningCount > 0) {
      if (typeof onStopAll === "function") onStopAll();
      return;
    }
    const command = selected || currentCommands[0];
    if (command && typeof onRun === "function") onRun(command);
  });

  dropdownBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    dropdownOpen = !dropdownOpen;
    dropdownMenu.hidden = !dropdownOpen;
    dropdownBtn.classList.toggle("active", dropdownOpen);
  });

  // 点击外部关闭下拉
  const closeOnOutside = (event) => {
    if (!dropdownOpen) return;
    if (container.contains(event.target)) return;
    dropdownOpen = false;
    dropdownMenu.hidden = true;
    dropdownBtn.classList.remove("active");
  };
  document.addEventListener("click", closeOnOutside, true);

  /** 重建下拉菜单内容（命令集合变化时才需要）。 */
  function renderDropdown(commands) {
    dropdownMenu.replaceChildren();
    for (const command of commands) {
      const label = commandLabel(t, command);
      const item = el("button", "sfe-run-dropdown-item");
      item.type = "button";
      item.title = command.cmd;
      item.appendChild(el("span", "sfe-run-dropdown-label", label));
      item.appendChild(el("code", "sfe-run-dropdown-cmd", command.cmd));
      item.addEventListener("click", () => {
        selected = command;
        dropdownOpen = false;
        dropdownMenu.hidden = true;
        dropdownBtn.classList.remove("active");
        if (typeof onRun === "function") onRun(command);
      });
      dropdownMenu.appendChild(item);
    }
  }

  /** 同步按钮外观与显隐。 */
  function sync() {
    const state = getState();
    const commands = Array.isArray(state.commands) ? state.commands : [];
    const ready = state.ready === true;
    const runningCount = Number(state.runningCount) || 0;

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
      dropdownBtn.hidden = commands.length <= 1;
    }

    const running = runningCount > 0;
    mainBtn.classList.toggle("running", running);
    mainIcon.replaceChildren(createActionIcon(running ? "square" : "play", 12));
    mainLabel.textContent = running ? t("run.toolbar.stop", "Stop") : t("run.toolbar.run", "Run");
    mainBtn.title = running
      ? t("run.toolbar.stopTip", "停止当前运行的进程")
      : `${t("run.toolbar.runTip", "运行")}: ${(selected || commands[0]).cmd}`;
    mainBtn.setAttribute("aria-label", mainLabel.textContent);

    // 多个运行中时显示计数，如实反映「有多个在跑」。
    countBadge.hidden = runningCount <= 1;
    countBadge.textContent = String(runningCount);

    dropdownBtn.title = t("run.toolbar.selectCommand", "选择运行命令");
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
