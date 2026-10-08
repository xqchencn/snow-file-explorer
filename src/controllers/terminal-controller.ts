/**
 * 终端 / 运行控制器 (src/controllers/terminal-controller.ts)
 * @description IDEA 式双模式终端 tab 集合：交互终端（模式 B）与一次性运行（模式 A），
 *   pty 会话生命周期、底部工具窗口与停靠管理、顶栏 Run/Stop 的命令二态。
 *   从 index.ts mount 闭包原样迁出；原闭包变量 disposed / layoutEls / 渲染回调
 *   改由 deps 注入，函数体保持逐字不变（仅标识符替换）。
 */

import type { PluginRuntimeApi } from "../types/plugin-runtime.ts";
import type { TranslateFn } from "../types/panel-state.ts";
import type { PanelState, LayoutEls, NewTerminalOptions, TerminalTab } from "../state/panel-state.ts";
import { pathKey } from "../state/panel-state.ts";
import {
  createPtySession,
  isTerminalAvailable,
  resolveRunShell,
  resolveScriptShell,
  DEFAULT_COLS,
  DEFAULT_ROWS,
} from "../services/terminal-runner.ts";
import type { PtySessionResult, ResolvedRunShell } from "../services/terminal-runner.ts";
import { loadChunk } from "../services/lazy-chunk.ts";
import { copyToClipboard } from "../utils/dom.ts";
import { basename } from "../services/file-service.ts";
import { joinPath } from "../services/file-filter.ts";
import { flattenCommands } from "../services/project-commands.ts";
import type { FlatRunCommand } from "../services/project-commands.ts";
import type { RunCommand } from "../services/ecosystems.ts";
import { renderToolWindow } from "../components/tool-window.ts";
import type { ToolWindowOptions, ToolWindowHandle, ToolWindowMode } from "../components/tool-window.ts";
import type { XtermView, XtermViewOptions } from "../components/terminal-view.ts";
import {
  isRightPanelFullscreen,
  ensureRightPanelFullscreen,
} from "../utils/panel-fullscreen.ts";

/** 终端控制器的注入依赖：渲染回调与跨控制器回调由 mount 装配阶段回填。 */
export type TerminalControllerDeps = {
  state: PanelState;
  t: TranslateFn;
  api: PluginRuntimeApi;
  isDisposed(): boolean;
  getLayout(): LayoutEls | null;
  /** 左侧入口栏 / 侧栏同步（index 渲染分区）。 */
  syncSidebar(): void;
  /** 顶栏运行控件同步（index 渲染分区，runToolbar 句柄在那里）。 */
  syncRunToolbar(): void;
  /** 状态条提示（启动失败 / 脚本不支持等）。 */
  setOperationStatus(ok: boolean, error?: string): void;
  /** applyToolDock 后同步工具栏「差异 / 内容」切换的显隐（右侧停靠时让位）。 */
  renderGitViewSwitchInToolbar(): void;
  /** 手动登记脚本命令后重绘顶栏运行控件（index 渲染分区）。 */
  renderRunToolbarView(): void;
  /** 把一段文本确认后作为用户消息发送到宿主当前会话（index 装配的确认弹窗 + chatInput.sendMessage）。 */
  sendToChat(text: string): void;
};

export function createTerminalController(deps: TerminalControllerDeps) {
  const { state, t, api } = deps;
  const isDisposed = deps.isDisposed;
  const getLayout = deps.getLayout;

  // 终端创建令牌：终端在 pty 建好前被关闭时，用它作废「迟到」的创建结果，避免泄漏孤儿进程。
  let terminalToken = 0;
  // 底部工具窗口控制器（renderToolWindow 的返回值）。两个窗口各自常驻、互斥显示：
  //   terminalWindow = 交互终端窗口；runWindow = 运行窗口。各自持有自己的 xterm 实例，切换不丢输出。
  let terminalWindow: ToolWindowHandle | null = null;
  let runWindow: ToolWindowHandle | null = null;
  // 同一项目内复用 shell 解析结果，运行命令不再每次 detectTerminals。
  let runShellPromise: Promise<ResolvedRunShell> | null = null;

  /** xterm 在终端块里。工具窗口允许工厂返回 Promise，输出会先暂存。 */
  function createLazyTerminalView(
    host: HTMLElement,
    opts: XtermViewOptions,
  ): Promise<XtermView> {
    return loadChunk("terminal").then((mod) => {
      if (!mod || typeof mod.createXtermView !== "function") {
        throw new Error("终端组件加载失败");
      }
      return mod.createXtermView(host, opts);
    });
  }

  /** 同一项目内复用 shell 解析结果，运行命令不再每次 detectTerminals。 */
  function cachedRunShell() {
    if (!runShellPromise) runShellPromise = resolveRunShell();
    return runShellPromise;
  }

  /**
   * 仍在运行的一次性任务数量（模式 A 且未结束）。
   * @description 只统计模式 A：模式 B 是常驻交互终端，永远不会「退出」，若计入会把
   *   工具栏按钮永久钉在 Stop。模式 B 的会话状态由 tab 自身表达（存在即开着），
   *   不参与 Run/Stop 判定。仅用于底栏小圆点（提示后台仍在跑）。
   */
  function runningCount() {
    return state.terminals.filter((term) => term && term.mode === "run" && term.exited !== true).length;
  }

  /** 交互终端窗口（mode B）的终端集合。 */
  function terminalModeTerminals() {
    return state.terminals.filter((term) => term && term.mode === "terminal");
  }

  /** 运行窗口（mode A）的终端集合。 */
  function runModeTerminals() {
    return state.terminals.filter((term) => term && term.mode === "run");
  }

  /** 按 id 查终端（两个窗口共用）。 */
  function findTerminal(id: string | null) {
    return state.terminals.find((term) => term && term.id === id) || null;
  }

  /**
   * 关闭终端后修正两个窗口的激活项：被移除的是激活项（或激活项已不存在）时回退到
   *   同窗口首条；否则保持不动（不误改另一窗口的激活项）。
   * @param {Iterable<string>} removedIds 被移除的终端 id
   */
  function reconcileActiveTerminals(removedIds: Iterable<string | null>) {
    const removed = new Set(removedIds);
    if (removed.has(state.activeTerminalId) || !findTerminal(state.activeTerminalId)) {
      const list = terminalModeTerminals();
      state.activeTerminalId = list.length ? list[0].id : null;
    }
    if (removed.has(state.activeRunTerminalId) || !findTerminal(state.activeRunTerminalId)) {
      const list = runModeTerminals();
      state.activeRunTerminalId = list.length ? list[0].id : null;
    }
  }

  /**
   * 切换项目时留下未结束的启动任务，其余终端关掉。
   * @param {string} previousRoot 切换前的项目根目录
   */
  function retainUnfinishedRuns(previousRoot: string) {
    const kept: TerminalTab[] = [];
    for (const term of state.terminals) {
      const keep = term && term.mode === "run" && term.exited !== true;
      if (!keep) {
        try {
          if (term && term.session && typeof term.session.kill === "function") term.session.kill();
        } catch {
          // 忽略：进程可能已自然退出
        }
        continue;
      }
      if (!term.projectPath) term.projectPath = previousRoot;
      kept.push(term);
    }
    state.terminals = kept;
  }

  /**
   * 标记哪些启动任务属于其他项目，并按开关决定是否出现在 tab 上。
   * 进程和 xterm 都留着，只是默认不画 tab。
   */
  function syncRetainedRuns() {
    const root = pathKey(state.rootPath);
    for (const term of state.terminals) {
      if (!term || term.mode !== "run") continue;
      const other = !!(term.projectPath && pathKey(term.projectPath) !== root);
      term.projectLabel = other ? basename(term.projectPath) : "";
      term.hiddenRun = other && !state.showOtherProjectRuns;
    }
    const active = findTerminal(state.activeRunTerminalId);
    if (!active || active.hiddenRun || active.mode !== "run") {
      const visible = state.terminals.find((term) => term && term.mode === "run" && !term.hiddenRun);
      state.activeRunTerminalId = visible ? visible.id : null;
    }
  }

  /** 右键开关：显示或藏起其他项目里尚未结束的启动任务。 */
  function toggleShowOtherProjectRuns() {
    if (isDisposed()) return;
    state.showOtherProjectRuns = !state.showOtherProjectRuns;
    rebuildTerminalWindows();
    deps.syncSidebar();
    const fit = () => fitTerminalPanel();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fit);
    else fit();
  }

  /** 终端集合变化后重建两个窗口的 tab 列表（xterm 实例由组件内部增量维护，不丢失）。 */
  function rebuildTerminalWindows() {
    syncRetainedRuns();
    if (terminalWindow && typeof terminalWindow.rebuild === "function") terminalWindow.rebuild();
    if (runWindow && typeof runWindow.rebuild === "function") runWindow.rebuild();
  }

  /**
   * 只重建运行窗口那一侧。
   * @description 模式 A（运行）记录的增删不影响交互终端窗口的 tab 集合，
   *   进程每退出一次就把两个窗口都重画一遍是白付一轮 DOM 与 fit。
   */
  function rebuildRunWindow() {
    syncRetainedRuns();
    if (runWindow && typeof runWindow.rebuild === "function") runWindow.rebuild();
  }

  /**
   * 某条命令仍在运行的终端集合（模式 A 且未结束，按 commandId 归属）。
   * @description 工具栏 Run/Stop 二态与「同一命令要么运行要么停止」的判定依据；
   *   commandId 是终端记录上稳定的命令标识（不是命令文本，避免同 cmd 不同配置误判）。
   * @param {{id?: string}|null} command 命令对象
   * @returns {Array<Object>}
   */
  function runningTerminalsForCommand(command: RunCommand | { id?: string } | null): TerminalTab[] {
    const commandId = command && command.id ? command.id : null;
    if (!commandId) return [];
    return state.terminals.filter(
      (term) => term && term.mode === "run" && term.exited !== true && term.commandId === commandId,
    );
  }

  /** 某条命令当前是否运行中（驱动工具栏主按钮的 Run/Stop 二态）。 */
  function runCountForCommand(command: RunCommand | { id?: string } | null) {
    return runningTerminalsForCommand(command).length;
  }

  /**
   * 关闭一个终端会话（终止 pty + 从集合移除）。切换项目 / 卸载 / 关闭 tab 共用。
   * @param {string} id 终端 id
   * @returns {boolean} 是否确实移除了会话
   */
  function killTerminalById(id: string) {
    const index = state.terminals.findIndex((term) => term && term.id === id);
    if (index < 0) return false;
    const term = state.terminals[index];
    state.terminals.splice(index, 1);
    try {
      if (term.session && typeof term.session.kill === "function") term.session.kill();
    } catch {
      // 忽略：进程可能已自然退出
    }
    reconcileActiveTerminals([id]);
    return true;
  }

  /** 终止并移除全部终端（切换项目 / 卸载）。 */
  function killAllTerminals() {
    for (const term of state.terminals) {
      try {
        if (term && term.session && typeof term.session.kill === "function") term.session.kill();
      } catch {
        // 忽略：进程可能已自然退出
      }
    }
    state.terminals = [];
    state.activeTerminalId = null;
    state.activeRunTerminalId = null;
  }

  /**
   * 终止并移除某条命令的运行终端（模式 A）——工具栏 Stop 按钮的语义。
   * @description 只停「当前这条命令」的终端（用户诉求：点一个 Stop 不能把别的也停了）；
   *   只处理模式 A：模式 B 是常驻交互终端，Stop 不应误杀用户正在交互的会话，
   *   关闭模式 B 只能通过它自己的 tab ×（用户明确操作）。
   * @param {{id?: string}|null} command 命令对象
   */
  function killRunTerminalsForCommand(command: RunCommand | { id?: string } | null) {
    const commandId = command && command.id ? command.id : null;
    if (!commandId) return;
    const victims = runningTerminalsForCommand(command);
    if (!victims.length) return;
    for (const term of victims) {
      try {
        if (term.session && typeof term.session.kill === "function") term.session.kill();
      } catch {
        // 忽略：进程可能已自然退出
      }
    }
    const removed = new Set(victims.map((term) => term.id));
    state.terminals = state.terminals.filter((term) => !removed.has(term.id));
    reconcileActiveTerminals(removed);
  }

  /**
   * 停止某条命令的运行终端，并同步面板 / 底栏 / 工具栏。
   * @description killRunTerminalsForCommand 只改状态、不重绘：这里补 UI 同步，界面才会立即清空。
   *   工具栏 Stop、⋮ 菜单的逐条停止、Rerun 的「先停」都复用它（DRY）。
   * @param {{id?: string}|null} command 命令对象
   */
  function stopCommandAndSync(command: RunCommand | { id?: string }) {
    killRunTerminalsForCommand(command);
    rebuildTerminalWindows();
    // 基准里 syncSidebar 连写两次（历史重复）；去重保留一次，行为不变。
    deps.syncSidebar();
    deps.syncRunToolbar();
  }

  /**
   * 停止全部运行中的命令（模式 A）——工具栏 ⋮ 菜单「停止全部 N 个」的语义。
   * @description 只有用户**显式**选择「全部停止」时才走这里（不是 Stop 的默认行为，这正是本轮修复点）；
   *   模式 B 常驻交互终端不参与，只能由各自的 tab × 关闭。
   */
  function stopAllRunTerminals() {
    for (const term of state.terminals) {
      if (!term || term.mode !== "run" || term.hiddenRun) continue;
      try {
        if (term.session && typeof term.session.kill === "function") term.session.kill();
      } catch {
        // 忽略：进程可能已自然退出
      }
    }
    state.terminals = state.terminals.filter((term) => term && (term.mode !== "run" || term.hiddenRun));
    reconcileActiveTerminals([state.activeRunTerminalId]);
    rebuildTerminalWindows();
    deps.syncSidebar();
    deps.syncRunToolbar();
  }

  /** 底部工具窗口可见性：按 bottomView 互斥显示「终端」/「运行」窗口，null 时全部收起。 */
  function refreshBottomVisibility() {
    const layout = getLayout();
    if (!layout) return;
    if (layout.terminalWindowEl) layout.terminalWindowEl.hidden = state.bottomView !== "terminal";
    if (layout.runWindowEl) layout.runWindowEl.hidden = state.bottomView !== "run";
    applyToolDock();
  }

  /** 工具窗口是否正打开（终端或运行，二者互斥）。 */
  function toolWindowOpen() {
    return state.bottomView === "terminal" || state.bottomView === "run";
  }

  function saveToolDock() {
    if (api && api.storage && typeof api.storage.setJson === "function") {
      // 偏离（已登记）：同步 try/catch 挡不住 setJson 的拒绝，失败原本会逃逸成 unhandled rejection；
      // 改挂 .catch，沿用原 catch「偏好写失败不影响这次切换」的静默语义。
      api.storage.setJson("toolDock", state.toolDock).catch(() => {
        // 忽略：偏好写失败不影响这次切换
      });
    }
  }

  /**
   * 把停靠写到主体上。窗口收起时仍按底栏布局，避免主视图被右侧空列挤窄。
   * 偏好本身留在 state.toolDock，下次打开继续用。
   */
  function applyToolDock() {
    const layout = getLayout();
    if (!layout || !layout.body) return;
    layout.body.dataset.toolDock = toolWindowOpen() && state.toolDock === "right" ? "right" : "bottom";
    if (terminalWindow && typeof terminalWindow.syncDock === "function") terminalWindow.syncDock();
    if (runWindow && typeof runWindow.syncDock === "function") runWindow.syncDock();
    deps.renderGitViewSwitchInToolbar();
  }

  /**
   * 右侧停靠跟代码预览一样：必须先进入宿主全屏，左侧才是侧栏宽度、右侧才铺满。
   * 代码预览由样式让出，不会和终端并排。
   */
  async function ensureRightDock() {
    if (isDisposed() || state.toolDock !== "right" || !toolWindowOpen()) return;
    applyToolDock();
    if (!isRightPanelFullscreen()) {
      const ok = await ensureRightPanelFullscreen();
      if (isDisposed()) return;
      if (!ok) deps.setOperationStatus(false, "无法进入右侧面板全屏");
    }
    fitTerminalPanel();
  }

  /**
   * 代码要占右侧时，把正在右侧的终端/运行窗口放回底栏。
   * 窗口没开着时不动偏好，下次打开仍停在右侧。
   */
  function yieldRightDockToCode() {
    if (state.toolDock !== "right" || !toolWindowOpen()) return;
    state.toolDock = "bottom";
    saveToolDock();
    applyToolDock();
    const fit = () => fitTerminalPanel();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fit);
    else fit();
  }

  /** 在底栏与右侧之间切换，终端和运行窗口一起换位置。 */
  function toggleToolDock() {
    if (isDisposed()) return;
    state.toolDock = state.toolDock === "right" ? "bottom" : "right";
    saveToolDock();
    applyToolDock();
    if (state.toolDock === "right") {
      void ensureRightDock();
      return;
    }
    const fit = () => fitTerminalPanel();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fit);
    else fit();
  }

  /** 按需首次渲染两个工具窗口（渲染后各自常驻，靠 hidden 切换，xterm 实例不销毁）。 */
  function ensureBottomWindows() {
    const layout = getLayout();
    if (!layout || !layout.terminalWindowEl || !layout.runWindowEl) return;
    if (!terminalWindow) terminalWindow = renderToolWindow(layout.terminalWindowEl, terminalWindowOptions());
    if (!runWindow) runWindow = renderToolWindow(layout.runWindowEl, runWindowOptions());
  }

  /**
   * 让底部工具窗口里的激活终端重新适配容器尺寸。
   * @description 窗口从隐藏变为可见、或尺寸变化时，xterm 的 fit 需要重算；
   *   不可见时 fit 会算出极小尺寸并触发 ConPTY 破坏性重绘，因此只在可见时调用。
   */
  function fitTerminalPanel() {
    const win = state.bottomView === "run" ? runWindow : state.bottomView === "terminal" ? terminalWindow : null;
    if (win && typeof win.fit === "function") win.fit();
  }

  /**
   * 收起底部工具窗口（IDEA：关闭工具窗口不终止进程，仅隐藏；会话与输出保留，侧栏入口可随时拉回）。
   */
  function handleMinimizeRunPanel() {
    state.bottomView = null;
    refreshBottomVisibility();
    deps.syncSidebar();
  }

  /** 左侧竖排入口栏点击：切到指定工具窗口；再次点击同一入口则收起回文件视图。 */
  function selectBottomView(view: ToolWindowMode) {
    const next = state.bottomView === view ? null : view;
    state.bottomView = next;
    if (next) ensureBottomWindows();
    refreshBottomVisibility();
    deps.syncSidebar();
    if (!next) return;
    if (state.toolDock === "right") {
      void ensureRightDock();
      const win = next === "run" ? runWindow : terminalWindow;
      if (win && typeof win.focus === "function") win.focus();
      return;
    }
    // 窗口可见后让终端适配尺寸并聚焦，打开即可直接输入。
    const win = next === "run" ? runWindow : terminalWindow;
    if (win && typeof win.fit === "function") win.fit();
    if (win && typeof win.focus === "function") win.focus();
  }

  /** 切换终端窗口激活 tab（点 tab）。 */
  function handleSelectTerminal(id: string) {
    if (isDisposed() || state.activeTerminalId === id) return;
    if (!findTerminal(id)) return;
    state.activeTerminalId = id;
    if (terminalWindow && typeof terminalWindow.syncActive === "function") terminalWindow.syncActive();
  }

  /** 切换运行窗口激活 tab（点 tab）。 */
  function handleSelectRunTerminal(id: string) {
    if (isDisposed() || state.activeRunTerminalId === id) return;
    if (!findTerminal(id)) return;
    state.activeRunTerminalId = id;
    if (runWindow && typeof runWindow.syncActive === "function") runWindow.syncActive();
  }

  /** 关闭某个终端 tab（终止会话 + 移除），并同步两个工具窗口与底栏/工具栏。 */
  function handleCloseTerminal(id: string) {
    if (!killTerminalById(id)) return;
    rebuildTerminalWindows();
    deps.syncSidebar();
    deps.syncRunToolbar();
  }

  /** 关闭某窗口内除指定 tab 之外的其它 tab（同 mode）。 */
  function closeOtherTerminals(id: string) {
    const target = findTerminal(id);
    if (!target) return;
    const victims = state.terminals.filter((term) => term.mode === target.mode && term.id !== id && !term.hiddenRun);
    for (const term of victims) {
      try {
        if (term.session && typeof term.session.kill === "function") term.session.kill();
      } catch {
        // 忽略：进程可能已自然退出
      }
    }
    const removed = new Set(victims.map((term) => term.id));
    state.terminals = state.terminals.filter((term) => !removed.has(term.id));
    reconcileActiveTerminals(removed);
    rebuildTerminalWindows();
    deps.syncSidebar();
    deps.syncRunToolbar();
  }

  /** 关闭某窗口内的全部 tab（按 mode 区分，不动另一窗口）。 */
  function closeAllTerminalsOfMode(mode: ToolWindowMode) {
    const victims = state.terminals.filter((term) => term && term.mode === mode && !term.hiddenRun);
    for (const term of victims) {
      try {
        if (term.session && typeof term.session.kill === "function") term.session.kill();
      } catch {
        // 忽略：进程可能已自然退出
      }
    }
    const removed = new Set(victims.map((term) => term.id));
    state.terminals = state.terminals.filter((term) => !removed.has(term.id));
    reconcileActiveTerminals(removed);
    rebuildTerminalWindows();
    deps.syncSidebar();
    deps.syncRunToolbar();
  }

  /** 停止某个运行 tab（运行窗口工具栏 ■ / tab 右键）——停该 tab 所属命令。 */
  function handleStopTerminal(id: string) {
    const term = findTerminal(id);
    if (term && term.commandId) stopCommandAndSync({ id: term.commandId });
    else handleCloseTerminal(id);
  }

  /**
   * 重新运行某个运行 tab（运行窗口工具栏 ⟳ / tab 右键）——**复用原 tab / 原 xterm 面板**重跑，
   * 无论该进程当前是运行中还是已结束，都绝不新建 tab（用户诉求：重启在当前面板重启）。
   * @description 若仍在运行：先终止旧进程（保留 tab 记录，仅 session 置空）；
   *   随后清空该 tab 的旧输出，再用同一条 term 记录重新拉起 pty。
   */
  function handleRerunTerminal(id: string) {
    const term = findTerminal(id);
    if (!term || !term.commandId) return;
    // 含隐藏命令：脚本命令不在顶栏下拉里，但 rerun 仍要能找到它。
    const command = flattenCommands(state.projectCommands, { includeHidden: true }).find((c) => c.id === term.commandId);
    if (!command) return;
    // 运行中才需要杀旧进程；已结束的会话 session 已为 null，不动。
    if (term.exited !== true && term.session && typeof term.session.kill === "function") {
      try {
        term.session.kill();
      } catch {
        // 忽略：进程可能已自然退出
      }
    }
    term.session = null;
    // 复用原 tab：重置退出态（tab 上 ✓/✗ 消失、状态点复位、工具栏停止恢复可用）。
    term.exited = false;
    term.exitCode = null;
    term.pendingCommand = command.cmd;
    state.activeRunTerminalId = term.id;
    state.bottomView = "run";
    ensureBottomWindows();
    // 清掉上一轮的输出，重跑从干净屏幕开始（清的是显示，不销毁 xterm 实例）。
    if (runWindow && typeof runWindow.clear === "function") runWindow.clear(id);
    rebuildTerminalWindows();
    deps.syncRunToolbar();
    deps.syncSidebar();
    void createTerminalForId(term);
  }

  /** 复制某 tab 的标识（运行=命令原文，终端=标题）到系统剪贴板。 */
  function copyTerminalTab(id: string) {
    const term = findTerminal(id);
    if (!term) return;
    void copyToClipboard(term.title || "");
  }

  /** 复制某 tab 终端的选中文本到系统剪贴板（运行窗口工具栏「复制选中文本」用）。 */
  function copyTerminalSelection(id: string, text: string) {
    if (!findTerminal(id)) return;
    void copyToClipboard(text || "");
  }

  /** 把某 tab 的标识（运行=命令原文，终端=标题）作为用户消息发送到当前会话。 */
  function sendTabTextToChat(id: string) {
    const term = findTerminal(id);
    if (!term || !term.title) return;
    deps.sendToChat(term.title);
  }

  /** 把某 tab 终端的选中文本作为用户消息发送到当前会话（内容区菜单 / 工具栏「发送到当前会话」用）。 */
  function sendTerminalSelectionToChat(id: string, text: string) {
    if (!findTerminal(id)) return;
    deps.sendToChat(text || "");
  }

  /**
   * 读取系统剪贴板文本（终端右键「粘贴」用）。
   * @description 优先宿主 IPC `window.snow.readClipboardText`（走主进程，渲染进程无权限限制；
   *   宿主终端自身的粘贴即用此 API），否则退回标准 Clipboard API。之前只用 navigator.clipboard，
   *   在插件沙箱中常不可用，导致「粘贴」拿不到内容——这是右键粘贴失效的根因。
   */
  async function readClipboardText() {
    const snow = typeof window !== "undefined" ? window.snow : null;
    if (snow && typeof snow.readClipboardText === "function") {
      try {
        return String((await snow.readClipboardText()) || "");
      } catch {
        return "";
      }
    }
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.readText === "function") {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return "";
      }
    }
    return "";
  }

  /** 终端窗口（mode B）组件配置。 */
  function terminalWindowOptions(): ToolWindowOptions {
    return {
      t,
      kind: "terminal",
      getTerminals: terminalModeTerminals,
      getActiveId: () => state.activeTerminalId,
      createTerminal: createLazyTerminalView,
      onSelectTab: handleSelectTerminal,
      onNewTerminal: () => handleNewTerminal({ mode: "terminal" }),
      onCloseTerminal: handleCloseTerminal,
      onMinimize: handleMinimizeRunPanel,
      getDock: () => state.toolDock,
      onToggleDock: toggleToolDock,
      onClear: (id) => terminalWindow && typeof terminalWindow.clear === "function" && terminalWindow.clear(id),
      onScrollToBottom: (id) =>
        terminalWindow && typeof terminalWindow.scrollToBottom === "function" && terminalWindow.scrollToBottom(id),
      onCloseOthers: closeOtherTerminals,
      onCloseAll: () => closeAllTerminalsOfMode("terminal"),
      onCopyTab: copyTerminalTab,
      onSendTab: sendTabTextToChat,
      onSendSelection: sendTerminalSelectionToChat,
      onPasteText: readClipboardText,
    };
  }

  /** 运行窗口（mode A）组件配置。 */
  function runWindowOptions(): ToolWindowOptions {
    return {
      t,
      kind: "run",
      getTerminals: runModeTerminals,
      getActiveId: () => state.activeRunTerminalId,
      createTerminal: createLazyTerminalView,
      onSelectTab: handleSelectRunTerminal,
      onCloseTerminal: handleCloseTerminal,
      onMinimize: handleMinimizeRunPanel,
      getDock: () => state.toolDock,
      onToggleDock: toggleToolDock,
      onRerun: handleRerunTerminal,
      onStop: handleStopTerminal,
      onClear: (id) => runWindow && typeof runWindow.clear === "function" && runWindow.clear(id),
      onScrollToBottom: (id) =>
        runWindow && typeof runWindow.scrollToBottom === "function" && runWindow.scrollToBottom(id),
      onStopAll: stopAllRunTerminals,
      onCloseOthers: closeOtherTerminals,
      onCloseAll: () => closeAllTerminalsOfMode("run"),
      onCopyTab: copyTerminalTab,
      onSendTab: sendTabTextToChat,
      onCopySelection: copyTerminalSelection,
      onSendSelection: sendTerminalSelectionToChat,
      onPasteText: readClipboardText,
      getShowOtherRuns: () => state.showOtherProjectRuns,
      onToggleShowOtherRuns: toggleShowOtherProjectRuns,
    };
  }

  /**
   * 新建一个终端。
   * @description 两种模式（用户已确认的双模式设计）：
   *   - mode="run"（模式 A）：一次性运行，跑完 shell 退出并回传退出码，tab 显示 ✓/✗；只读。
   *   - mode="terminal"（模式 B）：常驻交互终端，可连续敲命令，不要求状态回传。
   *   入口约定：工具栏 Run / 右键「运行」/ 代码行 ▶ → 模式 A；面板 ＋ → 模式 B。
   * @param {{command?: string, commandId?: string|null, cwd?: string, mode?: "run"|"terminal", title?: string}|string} [options] 命令、工作目录与模式
   */
  function handleNewTerminal(options?: NewTerminalOptions | string) {
    if (isDisposed()) return;
    if (!isTerminalAvailable()) {
      deps.setOperationStatus(false, t("run.terminalUnavailable", "当前宿主未提供终端能力"));
      return;
    }
    const opts: NewTerminalOptions = typeof options === "string" ? { command: options } : options || {};
    const command = typeof opts.command === "string" ? opts.command : "";
    const mode = opts.mode === "run" ? "run" : "terminal";
    const id = `term-${Date.now().toString(36)}-${(terminalToken += 1)}`;
    const term: TerminalTab = {
      id,
      // 命令归属 id（模式 A 用于 Run/Stop 按命令二态判定）；模式 B 为 null。
      commandId: mode === "run" && typeof opts.commandId === "string" ? opts.commandId : null,
      // 模式 A 用命令原文作标题（退出后追加 ✓/✗ + 退出码）；模式 B 统一叫「终端」。
      title: opts.title || (mode === "run" ? command : t("run.terminal", "终端")),
      mode,
      session: null,
      exited: false,
      exitCode: null,
      onInput: null,
      onResize: null,
      pendingCommand: command,
      // 脚本文件路径：非空时本 tab 用「脚本对应解释器」跑（见 createTerminalForId）。
      scriptPath: typeof opts.scriptPath === "string" ? opts.scriptPath : "",
      // 运行命令使用所属 package.json 目录；交互式终端默认使用项目根目录。
      cwd: typeof opts.cwd === "string" && opts.cwd ? opts.cwd : state.rootPath,
      // 任务所属项目。切走之后用来判断它是不是「其他项目」的后台任务。
      projectPath: state.rootPath,
      // pty 启动阶段令牌：重跑复用同一 tab 时用于作废旧 pty 的迟到 onData/onExit。
      phase: 0,
    };
    state.terminals.push(term);
    // 按 mode 打开对应工具窗口并激活新 tab：
    //   模式 A（一次性运行）→ 运行窗口；模式 B（交互终端）→ 终端窗口。
    if (mode === "run") {
      state.activeRunTerminalId = id;
      state.bottomView = "run";
    } else {
      state.activeTerminalId = id;
      state.bottomView = "terminal";
    }
    // 确保两个工具窗口已渲染（各自常驻、靠 hidden 切换），再让 tab 列表与新终端对齐。
    ensureBottomWindows();
    rebuildTerminalWindows();
    refreshBottomVisibility();
    // 窗口由隐藏（收起）变为可见后，xterm 需按真实尺寸重算（隐藏期 fit 会得到 0 尺寸）。
    // 右侧停靠先等宿主全屏，再按代码预览那一列的宽度适配。
    if (state.toolDock === "right") void ensureRightDock();
    else fitTerminalPanel();
    deps.syncSidebar();
    deps.syncRunToolbar();
    void createTerminalForId(term);
  }

  /** 为一条终端记录创建 pty 会话，并接好输入 / 尺寸 / 输出 / 退出。 */
  async function createTerminalForId(term: TerminalTab) {
    if (!term || isDisposed()) return;
    // 本终端所属工具窗口的控制器（模式 A→运行窗口；模式 B→终端窗口），用其读写 xterm。
    const win = term.mode === "run" ? runWindow : terminalWindow;
    const sizes = win && typeof win.getSizes === "function" ? win.getSizes(term.id) : null;
    const cols = sizes && sizes.cols > 0 ? sizes.cols : DEFAULT_COLS;
    const rows = sizes && sizes.rows > 0 ? sizes.rows : DEFAULT_ROWS;

    // 阶段令牌：每次（重新）启动本 tab 的 pty 时 +1 并捕获；旧 pty 迟到的 onData/onExit
    //   令牌不匹配 → 丢弃。保证「重跑复用同一 tab」时上一轮的迟到输出不会污染新一轮。
    term.phase = (term.phase || 0) + 1;
    const phase = term.phase;

    // 终端视图 → shell：键盘输入与尺寸变化
    term.onInput = (data: string) => {
      // PtySessionResult 把 ok 与 write/resize/kill 平铺成可选字段（未做成可辨联合），
      // 而 term.session 只在 result.ok 为真时写入（见下方 `if (!result.ok) return`），方法必在。
      if (term.session) term.session.write!(data);
    };
    term.onResize = (nextCols: number, nextRows: number) => {
      if (term.resizeTimer) clearTimeout(term.resizeTimer);
      // 尺寸先记账：pty 还没建好时这次 fit 不能丢，否则会话会一直按 80×24 排版，
      // 构建日志的换行全是错的（原实现在 !term.session 时直接 return，这一尺寸就永久消失了）。
      term.pendingResize = { cols: nextCols, rows: nextRows };
      // 面板刚展开时 fit 会连着触发几次。尾沿防抖，避免 ConPTY 每次都整屏重绘。
      term.resizeTimer = setTimeout(() => {
        term.resizeTimer = null;
        const pending = term.pendingResize;
        if (!pending || term.phase !== phase || !term.session) return;
        term.pendingResize = null;
        term.session.resize!(pending.cols, pending.rows);
      }, 120);
    };

    if (term.mode === "run" && term.pendingCommand && win && typeof win.write === "function") {
      win.write(term.id, `\r\n\x1b[90m$ ${term.pendingCommand}\x1b[0m\r\n`);
    }

    // 模式 A：shell 走宿主同源解析链（终端设置 shellPath > detectTerminals()[0]），
    // 不写死 shell——跨 Windows / macOS / Linux 跟随宿主配置；退出写法按 shell 家族选择
    // （powershell 需 `exit $LASTEXITCODE`，cmd / posix / wsl 用裸 `exit` 继承退出码）。
    // 模式 B 不指定 shellPath，走宿主默认检测，保持交互能力。
    // 脚本命令（term.scriptPath）：改用**脚本对应类型的解释器**（bat→cmd / ps1→powershell /
    // sh→POSIX），系统里找不到该类型 shell 时提示「不支持」，不再用默认 shell 硬跑。
    let runShell: ResolvedRunShell | null = null;
    let runCommand = "";
    let exitCommand = "";
    if (term.mode === "run") {
      if (term.scriptPath) {
        const scriptShell = await resolveScriptShell(term.scriptPath);
        if (!scriptShell.supported) {
          const ext = scriptShell.extension ? `.${scriptShell.extension}` : "";
          const need = scriptShell.requiredLabel ? `（需要 ${scriptShell.requiredLabel}）` : "";
          deps.setOperationStatus(false, t("run.scriptUnsupported", "当前终端不支持运行 {{ext}} 脚本{{need}}", { ext, need }));
          return;
        }
        // ScriptShellResolution 声明 supported 为 false 时这些字段缺失；上面已按 !supported 提前 return，
        // 但类型没把 supported 做成可辨别的标记，故此处只能断言。
        runShell = { shellPath: scriptShell.shellPath, exitCommand: scriptShell.exitCommand! };
        runCommand = scriptShell.runCommand!;
      } else {
        runShell = await cachedRunShell();
      }
      exitCommand = runShell.exitCommand;
    }

    const commandText = term.pendingCommand
      ? (term.scriptPath && runCommand ? runCommand : term.pendingCommand)
      : "";
    // 进程刚 spawn 就写入会堵住 PowerShell 的第一屏输出。等它先吐出内容再敲命令。
    let shellSpoke = false;
    let commandSent = false;
    let session: PtySessionResult | null = null;
    const sendCommand = () => {
      if (commandSent || !session || !commandText) return;
      if (isDisposed() || term.phase !== phase || !state.terminals.includes(term)) return;
      commandSent = true;
      if (term.commandTimer) {
        clearTimeout(term.commandTimer);
        term.commandTimer = null;
      }
      term.pendingCommand = "";
      // 同 term.session：session 只在 result.ok 为真时被赋值，write 必在（PtySessionResult 未做成可辨联合）。
      session.write!(`${commandText}\r`);
      if (term.mode === "run" && exitCommand) session.write!(`${exitCommand}\r`);
    };

    const result = await createPtySession({
      cwd: term.cwd || state.rootPath,
      cols,
      rows,
      // 仅模式 A 指定 shellPath；模式 B 传 undefined，走宿主默认检测。
      shellPath: runShell ? runShell.shellPath : undefined,
      onData: (data) => {
        if (isDisposed() || term.phase !== phase) return;
        shellSpoke = true;
        if (win && typeof win.write === "function") win.write(term.id, data);
        sendCommand();
      },
      onExit: (exitCode) => {
        // 重跑已启动新一轮（phase 变化）：旧 pty 的退出事件作废，避免清掉新一轮的运行态。
        if (term.phase !== phase) return;
        term.exited = true;
        term.exitCode = typeof exitCode === "number" ? exitCode : null;
        term.session = null;
        // 其他项目的后台任务结束且当前没打开开关：直接拿走，不留一个看不见的已结束 tab。
        if (term.mode === "run" && term.projectPath && pathKey(term.projectPath) !== pathKey(state.rootPath) && !state.showOtherProjectRuns) {
          state.terminals = state.terminals.filter((item) => item !== term);
          rebuildRunWindow();
          deps.syncRunToolbar();
          deps.syncSidebar();
          return;
        }
        // 模式 A 退出后刷新运行窗口 tab（✓/✗ + 退出码 + 状态点/工具栏态）。
        if (term.mode === "run") rebuildRunWindow();
        deps.syncRunToolbar();
        deps.syncSidebar();
      },
    });

    // 终端在创建期间被关闭 / 项目已切换：回收本次会话，避免孤儿进程。
    if (isDisposed() || !state.terminals.includes(term)) {
      if (result.ok && typeof result.kill === "function") result.kill();
      return;
    }
    if (!result.ok) {
      deps.setOperationStatus(false, result.error || t("run.startFailed", "启动失败"));
      return;
    }
    term.session = result;
    session = result;
    // 补发 session 建立前攒下的尺寸（见 onResize）；不补就停留在宿主默认的 80×24。
    if (term.pendingResize && typeof result.resize === "function") {
      const pending = term.pendingResize;
      term.pendingResize = null;
      result.resize(pending.cols, pending.rows);
    }
    if (commandText) {
      if (shellSpoke) sendCommand();
      else {
        term.commandTimer = setTimeout(() => {
          term.commandTimer = null;
          if (term.phase !== phase) return;
          sendCommand();
        }, 800);
      }
    }
    deps.syncRunToolbar();
    deps.syncSidebar();
  }

  /**
   * 运行一条命令（模式 A）：新建一个终端 tab 并把命令敲进去执行。
   * @description 「同一命令要么运行要么停止」：该命令已有运行中的终端时**不再新建**
   *   （按钮此时应为 Stop，正常不会走到这里；此守卫兜底右键「运行」与代码行 ▶ 的并发触发，
   *   替代原先的 300ms 时间窗口去重——按真实运行状态判定更准，且不误伤快速重跑）。
   * @param {{id?: string, cmd: string, labelFallback?: string, labelKey?: string|null}} command 命令对象
   */
  function handleRunCommand(command: FlatRunCommand) {
    if (isDisposed() || !command || !command.cmd) return;
    // 脚本命令（bat/sh/ps1）默认不进顶栏 Run 下拉：手动点过文件行内 ▶ 后才登记进下拉。
    rememberManualScriptCommand(command);
    // 运行中拦截：同一命令已有未结束的运行终端 → 忽略（要么运行，要么停止）。
    if (runCountForCommand(command) > 0) return;
    // 模式 A：一次性运行，跑完 shell 退出 → onPtyExit 回传退出码 → 工具栏回到 Run。
    // `command.dir` 是显示/源码归属目录；Gradle 根项目任务可显式提供 `runDir` 覆盖实际工作目录。
    // 没有 `runDir` 的 Node、Go、Maven 等命令继续在所属包目录执行。
    const commandDir = typeof command.runDir === "string" ? command.runDir : command.dir;
    const cwd = commandDir ? joinPath(state.rootPath, commandDir) : state.rootPath;
    handleNewTerminal({
      command: command.cmd,
      commandId: command.id || null,
      cwd,
      mode: "run",
      title: command.cmd,
      // 脚本命令：带上源文件路径，createTerminalForId 会按扩展名选对应解释器。
      scriptPath: command.runKind === "script" ? command.sourcePath : "",
    });
  }

  /**
   * 手动登记脚本命令：脚本命令（bat/sh/ps1）默认只出现在文件行内 ▶，不进顶栏 Run 下拉；
   *   用户点过一次 ▶ 后，把它临时并入下拉（本会话有效，切换项目时清空）。
   * @param {{runKind?: string, id?: string}} command 命令对象
   */
  function rememberManualScriptCommand(command: FlatRunCommand | null) {
    if (!command || command.runKind !== "script" || !command.id) return;
    if (state.manualScriptCommands.some((item) => item.id === command.id)) return;
    state.manualScriptCommands.push(command);
    deps.renderRunToolbarView();
  }

  /**
   * 切换项目：留下未结束的运行任务（转后台），关闭交互终端窗口，
   * 并作废本项目的 shell 解析缓存（新项目可能解析出不同 shell）。
   * @description 原 applyActiveProject 中终端相关的第一段；其余状态清理由 index 负责，
   *   syncRetainedRuns / rebuildTerminalWindows 在状态清完后再调（保持原顺序）。
   * @param previousRoot 切换前的项目根目录
   */
  function retainAndReleaseForProject(previousRoot: string): void {
    retainUnfinishedRuns(previousRoot);
    if (terminalWindow && typeof terminalWindow.dispose === "function") terminalWindow.dispose();
    terminalWindow = null;
    runShellPromise = null;
  }

  /** 卸载：销毁两个工具窗口控制器（含各自的 xterm 实例与监听）。 */
  function releaseWindows(): void {
    if (terminalWindow && typeof terminalWindow.dispose === "function") terminalWindow.dispose();
    terminalWindow = null;
    if (runWindow && typeof runWindow.dispose === "function") runWindow.dispose();
    runWindow = null;
  }

  return {
    cachedRunShell,
    runningCount,
    runningTerminalsForCommand,
    runCountForCommand,
    retainUnfinishedRuns,
    syncRetainedRuns,
    rebuildTerminalWindows,
    rebuildRunWindow,
    killAllTerminals,
    stopCommandAndSync,
    handleNewTerminal,
    handleRunCommand,
    selectBottomView,
    refreshBottomVisibility,
    toolWindowOpen,
    applyToolDock,
    toggleToolDock,
    ensureRightDock,
    yieldRightDockToCode,
    saveToolDock,
    ensureBottomWindows,
    fitTerminalPanel,
    retainAndReleaseForProject,
    releaseWindows,
  };
}
