/**
 * 工具栏运行控件组件 (src/components/run-toolbar.ts)
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

import { el } from "../utils/dom.ts";
import { createActionIcon } from "../icons/action-icons.ts";
import type { FlatRunCommand } from "../services/project-commands.ts";
import type { TranslateFn } from "../types/panel-state.ts";

/**
 * 工具栏运行控件从调用方读取的状态切片（`getState()` 的返回）。
 * @description 真源是 src/index.ts 里由 flattenCommands + 手动登记的脚本命令合并出的命令集合。
 */
export type RunToolbarSnapshot = {
  /** 扁平命令列表（flattenCommands 结果，另含手动点过行内 ▶ 的脚本命令）；非数组时组件按空列表处理。 */
  commands: FlatRunCommand[];
  /** 项目识别是否已完成；false 时整个控件隐藏（未扫完不能显示可点按钮）。 */
  ready: boolean;
  /** 判断某条命令当前是否有运行中的终端；缺省时组件一律视为未运行。 */
  isCommandRunning?: (command: FlatRunCommand) => boolean;
};

/** renderRunToolbar 的入参：翻译函数 + 状态读取 + 三类运行动作回调。 */
export type RunToolbarOptions = {
  /** 插件内部翻译函数（宿主 api.t 的一层包装），用于配置名与按钮提示文案。 */
  t: TranslateFn;
  /** 读取当前命令集合与运行态；每次 sync 与每次点击判定都会重新调用。 */
  getState: () => RunToolbarSnapshot;
  /** 运行给定配置；缺省时主按钮不做任何动作（调用方可只渲染不接线）。 */
  onRun?: (command: FlatRunCommand) => void;
  /** 重新运行给定配置（先停该配置再重跑，IDEA 的 Rerun 语义）；缺省时运行中点击无动作。 */
  onRerun?: (command: FlatRunCommand) => void;
  /** 停止给定配置（只停该配置，不波及其它）；缺省时 Stop 按钮无动作。 */
  onStop?: (command: FlatRunCommand) => void;
};

/** renderRunToolbar 的返回句柄：外部刷新与卸载入口。 */
export type RunToolbarHandle = {
  /** 按最新 getState() 同步按钮外观与显隐（命令集合变化时重建下拉）。 */
  sync: () => void;
  /** 组件卸载：解绑 document 上的「点击外部关闭下拉」监听，避免泄漏。 */
  dispose: () => void;
};

/** 解析命令对象上的本地化标签（npm script 名原样，不做汉化）。 */
function commandLabel(t: TranslateFn, command: FlatRunCommand): string {
  return command.labelKey ? t(command.labelKey, command.labelFallback) : command.labelFallback;
}

/**
 * 比较两组命令是否等价（id + 命令文本 + 显示标签 + 所属分组）。
 * @description 调用方每次都传入 flattenCommands() 生成的新数组，引用永不相等；
 *   若直接比引用会导致每次 sync 都重建下拉，破坏展开态与选中项。此处按内容比较。
 *   分组名 / 显示标签也要比：多 package.json 分组切换后（如切项目）标题与条目必须重绘。
 */
function sameCommands(a: FlatRunCommand[], b: FlatRunCommand[]): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].id !== b[i].id ||
      a[i].cmd !== b[i].cmd ||
      a[i].label !== b[i].label ||
      a[i].group !== b[i].group
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 渲染工具栏运行控件。
 * @param container 容器（常驻工具栏）
 * @param options
 * @param options.t 翻译函数
 * @param options.getState 读取 { commands, ready, isCommandRunning }
 *   - commands：扁平命令列表（flattenCommands 结果）
 *   - ready：识别是否已完成（未完成时按钮进入 loading 态）
 *   - isCommandRunning：(command) => boolean，判断某条命令当前是否有运行中的终端
 * @param options.onRun 运行当前选中配置：(command) => void
 * @param options.onRerun 重新运行当前选中配置（停+跑）：(command) => void
 * @param options.onStop 停止当前选中配置：(command) => void
 * @returns 手动刷新与卸载句柄（sync / dispose）
 */
export function renderRunToolbar(container: HTMLElement, options: RunToolbarOptions): RunToolbarHandle {
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
  let currentCommands: FlatRunCommand[] = [];
  // 用户选中的配置；默认第一条。
  let selected: FlatRunCommand | null = null;

  /** 判断某条命令当前是否有运行中的终端（调用方未提供判定时一律视为未运行）。 */
  function isRunning(command: FlatRunCommand | null): boolean {
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
  // as: DOM 把 Event.target 声明为 EventTarget | null，而 Node.contains 只收 Node；
  //   click 的 target 在浏览器里恒为节点（或 null），断言只为通过 contains 的形参检查。
  const closeOnOutside = (event: MouseEvent): void => {
    if (!dropdownOpen) return;
    if (container.contains(event.target as Node | null)) return;
    closeDropdown();
  };
  document.addEventListener("click", closeOnOutside, true);

  /**
   * 重建配置下拉（命令集合变化时才需要）。
   * @description 每项：图标 + 配置名 + 行内 ▶ 运行按钮（IDEA 同款）。
   *   点行体 = 仅「选择配置」；点 ▶ = 选择并立即运行该配置。不显示命令原文（配置名已足够），
   *   命令原文放 title 供悬停查看。
   */
  function renderDropdown(commands: FlatRunCommand[]): void {
    dropdownMenu.replaceChildren();
    // 多 package.json：命令按包（文件夹）分组，组名变化处插入分组标题（父包已由数据层排在前）。
    let lastGroup: string | null | undefined;
    for (const command of commands) {
      // 分组标题：根包（group=null）显示「根目录」，子包显示其目录路径（原样，不做大小写转换）。
      const group = command.group || null;
      if (group !== lastGroup) {
        dropdownMenu.appendChild(el("div", "sfe-run-dropdown-group", group || t("run.groupRoot", "根目录")));
        lastGroup = group;
      }
      // 条目显示纯 script 名（所属包已由分组标题表达，条目里不再重复路径）。
      const label = commandLabel(t, command);
      const itemLabel = command.label || label;
      // 用 div 而非 button：行内要再放一个 ▶ 按钮，button 不能嵌套 button。
      const item = el("div", "sfe-run-dropdown-item");
      item.setAttribute("role", "button");
      item.setAttribute("tabindex", "0");
      item.title = command.cmd;
      // dataset 标记命令 id：供 syncSelection() 高亮当前选中配置（不重建 DOM）。
      item.dataset.commandId = command.id;
      const icon = el("span", "sfe-run-dropdown-icon");
      icon.appendChild(createActionIcon(command.icon || "package", 12));
      item.appendChild(icon);
      item.appendChild(el("span", "sfe-run-dropdown-label", itemLabel));
      // 行内运行按钮：常驻占位（默认不可见，hover / 选中行时显现），保证下拉宽度不随 hover 变化。
      const runBtn = el("button", "sfe-run-dropdown-run");
      runBtn.type = "button";
      runBtn.title = t("run.toolbar.runTip", "运行 {{label}}", { label: itemLabel });
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
  function syncSelection(): void {
    const selectedId = selected ? selected.id : null;
    for (const item of dropdownMenu.children) {
      // as: HTMLCollection 迭代出的是 Element，dataset 只在 HTMLElement 上声明；
      //   下拉子节点全部由本函数用 el("div"/"button") 生成，恒为 HTMLElement。
      item.classList.toggle("active", (item as HTMLElement).dataset.commandId === selectedId);
    }
  }

  /** 同步按钮外观与显隐。 */
  function sync(): void {
    const state = getState();
    const commands: FlatRunCommand[] = Array.isArray(state.commands) ? state.commands : [];
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
      // !: `selected` 在外层已被 `!selected` 排除空值，但它是本作用域内会被重新赋值的 let，
      //   TS 不把该收窄带进 some 的回调；断言只为跨过可空检查，运行时判空仍在左边那个 `!selected`。
      if (!selected || !commands.some((c) => c.id === selected!.id)) selected = commands[0];
      renderDropdown(commands);
    }

    const activeCommand = selected || commands[0];
    const activeRunning = isRunning(activeCommand);
    const label = commandLabel(t, activeCommand);

    // 配置选择器：常显当前配置名；图标按命令来源生态（node / go / wails）区分；运行中叠绿点（IDEA 同款）。
    configIcon.replaceChildren(createActionIcon(activeCommand.icon || "package", 13));
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
