/**
 * Snow App 文件浏览器插件 (renderMode: "esm")
 * 模块化顶层入口：协调文件服务、Git 状态、目录树视图与代码预览器
 */

import type { PluginRuntimeApi, SystemWriteActionName } from "./types/plugin-runtime.ts";
import type { GitSyncIndicatorHandle } from "./components/git-sync-indicator.ts";
import type { TranslateFn } from "./types/panel-state.ts";
import type { Unsubscribe } from "./types/snow-api.ts";
import type { GitFileStatus } from "./types/host/host-git.ts";
import type { FileTreeEntry, ErrorLike, FileWriteResult } from "./services/file-service.ts";
import type { GitTreeNode } from "./services/git-service.ts";
import type { FlatRunCommand } from "./services/project-commands.ts";
import type { RunToolbarHandle } from "./components/run-toolbar.ts";
import type { GitSection, GitViewOptions } from "./components/git-view.ts";
import type { GitViewerMode } from "./components/code-viewer.ts";
import type {
  PanelState,
  LayoutEls,
  ConfirmDialogState,
} from "./state/panel-state.ts";

import { el, copyToClipboard } from "./utils/dom.ts";
import { createActionIcon } from "./icons/action-icons.ts";
import {
  basename,
  relativePath,
  resolveActiveDirectoryPath,
} from "./services/file-service.ts";
import { subscribeGitStatus, partitionGitFiles } from "./services/git-service.ts";
import { loadChunk, releaseChunkStyles } from "./services/lazy-chunk.ts";
import { installFileIcons, refreshInstalledIcons, createFileIconNode } from "./icons/file-icons.ts";
import { renderTreeView, destroyTreeView } from "./components/tree-view.ts";
import { renderCodeViewer, disposeViewerViewport } from "./components/code-viewer.ts";
import { renderGitCommitBar, renderGitList, closeGitContextMenu } from "./components/git-view.ts";
import { renderGitSyncIndicator } from "./components/git-sync-indicator.ts";
import { loadViewSettings, loadDiffViewMode } from "./services/settings.ts";
import { ensureProjectCommands, flattenCommands } from "./services/project-commands.ts";
import { renderRunToolbar } from "./components/run-toolbar.ts";
import { isRightPanelFullscreen } from "./utils/panel-fullscreen.ts";
import { createPanelState, pathKey } from "./state/panel-state.ts";
import { createGitController } from "./controllers/git-controller.ts";
import { createTreeController } from "./controllers/tree-controller.ts";
import { createPreviewController } from "./controllers/preview-controller.ts";
import { createTerminalController } from "./controllers/terminal-controller.ts";

// ---------------------------------------------------------------------------
// 面板内部类型（src/index.ts 私有，不导出）
// 这些形状的真源就是本文件的 state 对象与终端记录；组件层只消费其中切片。
// 跨层已有的形状一律 import 复用（见上方 import type），此处只声明确实新增的部分。
// ---------------------------------------------------------------------------

/**
 * 插件主挂载入口
 * @param container 挂载目标容器
 * @param api Snow App 注入的插件运行时 API
 * @param [_options] 额外宿主挂载参数（保留签名兼容，插件不自建多项目会话）
 * @returns 清理卸载函数
 */
export function mount(
  container: HTMLElement,
  api: PluginRuntimeApi,
  _options: Record<string, unknown> = {},
): () => void {
  let disposed = false;
  // 状态条提示的 3.2s 复位定时器（setOperationStatus 专用；其余定时器归各控制器所有）。
  let operationTimer: ReturnType<typeof setTimeout> | null = null;
  // 工具栏运行控件控制器（renderRunToolbar 的返回值）。
  let runToolbar: RunToolbarHandle | null = null;
  // 顶栏同步指示器控制器（renderGitSyncIndicator 的返回值）。
  let gitSyncIndicator: GitSyncIndicatorHandle | null = null;
  // 图标块在一次面板生命周期内复用，避免重复解析和重复请求。
  let iconsPromise: Promise<void> | null = null;

  /** 加载全部文件图标。与列目录并行，树的第一帧就使用完整图标集。 */
  function ensureIcons() {
    if (!iconsPromise) {
      iconsPromise = loadChunk("icons")
        .then((mod) => {
          if (mod) installFileIcons(mod);
          if (!disposed && runToolbar) renderRunToolbarView();
        })
        .catch((err) => {
          console.warn("[FileExplorer] 图标加载失败", err);
        });
    }
    return iconsPromise;
  }

  let startupToken = 0;

  /**
   * 树出现之后再做图标回填、终端块与运行 shell 预取、JVM 识别和 Git 状态。
   * @param {Array} rootEntries 刚刚列到的根目录条目
   */
  function scheduleStartupFollowups(rootEntries: FileTreeEntry[]) {
    const token = ++startupToken;
    const root = state.rootPath;
    const rootToken = pathKey(root);
    void (async () => {
      try {
        await Promise.all([
          ensureIcons().then(() => {
            if (disposed || token !== startupToken) return;
            refreshInstalledIcons(container);
          }),
          // 终端块（480KB）与 shell 探测都排在全仓识别之后，首屏后马上点「终端 / 运行」的人
          // 就得在点击链路上等它们。两件事都与识别互不依赖，提到同一批并发预取。
          loadChunk("terminal").catch((err) => {
            console.warn("[FileExplorer] 终端组件预载失败", err);
          }),
          terminal.cachedRunShell().catch(() => undefined),
          tree.refreshJavaProject(root, rootEntries),
          git.refreshGitAll(),
        ]);
      } catch (err) {
        console.warn("[FileExplorer] 启动后续任务失败", err);
      }
      if (disposed || token !== startupToken || pathKey(state.rootPath) !== rootToken) return;
      try {
        await ensureCommands(rootEntries);
      } catch (err) {
        console.warn("[FileExplorer] 项目命令识别失败", err);
      }
    })();
  }

  // 翻译：api.t 不可用时回退到 defaultValue
  // 迁移期偏离（有意，已登记）：防御分支由 `return fallback` 改为 `return fallback ?? key`。
  //   原写法在「宿主没注入 api.t」时返回 undefined，与声明的 string 返回不符，调用点全靠下游兜底；
  //   改后与宿主 api.t 自身的回退链一致（词条缺失 → defaultValue → 插件名 → key）。
  //   该分支在 Snow App 内不会命中，只影响无宿主环境（如构建校验、单测直接调用）。
  const t: TranslateFn = (key, fallback, values) => {
    if (api && typeof api.t === "function") {
      return api.t(key, { defaultValue: fallback, values });
    }
    return fallback ?? key;
  };

  const state = createPanelState();

  // ------------------------------------------------------------------
  // 控制器装配：Git / 文件树 / 预览 / 终端各管一块。渲染回调是函数声明（提升可用）；
  // 跨控制器引用一律 () => x.y() 晚绑定，创建顺序不构成依赖。
  // ------------------------------------------------------------------
  const git = createGitController({
    state, t, api,
    isDisposed: () => disposed,
    getLayout: () => layoutEls,
    getContainer: () => container,
    renderGitPane,
    renderGitPaneCommit,
    renderGitPreview,
    syncGitIndicator,
    openConfirmDialog,
    loadRoot: (options) => tree.loadRoot(options),
    buildFilePreview: (entry, result) => preview.buildFilePreview(entry, result),
    inlineMarkdownImages: (docPath) => preview.inlineMarkdownImages(docPath),
    yieldRightDockToCode: () => terminal.yieldRightDockToCode(),
    copyPathText,
    handleRevealInExplorer,
  });

  const tree = createTreeController({
    state, t, api,
    isDisposed: () => disposed,
    getLayout: () => layoutEls,
    snowApi,
    renderTree,
    renderContextMenu,
    renderToolbar,
    applyTreeSelectionHighlight,
    closeContextMenu,
    openConfirmDialog,
    setOperationStatus,
    previewFile: (entry) => preview.previewFile(entry),
    refreshGitAll: () => git.refreshGitAll(),
    resetPreviewForDeletedPaths: (paths) => preview.resetPreviewForDeletedPaths(paths),
    pruneSelectionForDeletedPaths: (paths) => preview.pruneSelectionForDeletedPaths(paths),
    ensureIcons,
    onRootLoaded: (entries) => scheduleStartupFollowups(entries),
  });

  const preview = createPreviewController({
    state, t, api,
    isDisposed: () => disposed,
    getLayout: () => layoutEls,
    container,
    snowApi,
    renderPreview,
    renderActiveViewer,
    renderTree,
    applyTreeSelectionHighlight,
    setOperationStatus,
    refreshGitAll: () => git.refreshGitAll(),
    copyPathText,
    handleRevealInExplorer,
    expandTreeToPath: (targetPath) => tree.expandTreeToPath(targetPath),
    scrollTreeToSelected: () => tree.scrollTreeToSelected(),
    yieldRightDockToCode: () => terminal.yieldRightDockToCode(),
    viewFilterOpts: () => tree.viewFilterOpts(),
    invalidateGitDiffCache: () => git.invalidateDiffCache(),
  });

  const terminal = createTerminalController({
    state, t, api,
    isDisposed: () => disposed,
    getLayout: () => layoutEls,
    syncSidebar,
    syncRunToolbar,
    setOperationStatus,
    renderGitViewSwitchInToolbar,
    renderRunToolbarView,
  });

    // 1. 获取当前工作区目录（宿主当前激活项目）
  // 面板槽位固定为 plugin:<pluginId>:<panelId>，由宿主保证「同一面板唯一」；
  // 插件不自建多项目会话、不提供目录选择入口，只跟随宿主项目。
  async function resolveRoot() {
    try {
      if (api && api.metadata && typeof api.metadata.get === "function") {
        const response = await api.metadata.get(["projects", "runtime"]);
        return resolveActiveDirectoryPath(response);
      }
    } catch (err) {
      console.warn("[FileExplorer] 读取激活项目目录失败", err);
    }
    return "";
  }

  // 应用宿主当前激活项目为面板根目录：目录未变则短路，变化则清理旧状态并全量刷新
  async function applyActiveProject(nextPath: string, { force = false }: { force?: boolean } = {}) {
    if (disposed) return;
    const next = nextPath || "";
    if (!force && pathKey(next) === pathKey(state.rootPath)) return;
    const previousRoot = state.rootPath;
    state.rootPath = next;
    state.rootNodes = null;
    state.javaProject = null;
    // 切换项目：交互终端和已经结束的启动任务关掉。
    // 还在跑的启动任务留在原项目目录里，默认不出现在新项目的启动列表中。
    terminal.retainAndReleaseForProject(previousRoot);
    state.projectCommands = null;
    state.manualScriptCommands = [];
    state.activeTerminalId = null;
    if (state.bottomView === "terminal") state.bottomView = null;
    terminal.syncRetainedRuns();
    terminal.rebuildTerminalWindows();
    // 运行控件随新项目重建（命令集合必然变化）。
    if (runToolbar && typeof runToolbar.dispose === "function") runToolbar.dispose();
    runToolbar = null;
    // 同步指示器状态随新项目刷新（getState 读 state，控制器可复用，无需销毁）。
    state.expanded = Object.create(null);
    state.selected = new Set();
    state.selectionAnchor = null;
    state.searchQuery = "";
    state.searchResults = [];
    state.searching = false;
    state.pendingRevealLine = null;
    state.contextMenu = null;
    state.confirmDialog = null;
    state.operationBusy = false;
    state.gitStatus = null;
    state.collapsedStaged = null;
    state.collapsedUnstaged = new Set();
    state.gitStatusMap = Object.create(null);
    state.gitignoreRules = [];
    state.gitignoreFullyLoaded = false;
    state.gitignoreLoadedDirs = new Set();
    state.gitPreview = null;
    state.gitSelected = null;
    preview.bumpRequestIds();
    state.preview = {
      kind: "empty",
      name: "",
      path: "",
      text: "",
      highlightedHtml: "",
      isMarkdown: false,
      mode: "preview",
      html: "",
      editable: false,
      saveState: "idle",
      saveMessage: "",
    };
    render();
    if (!state.rootPath) {
      tree.stopDirectoryWatch();
      state.status = "";
      renderToolbar();
      return;
    }
    // 先列出根目录。图标、JVM 和 Git 在树出现之后补；运行识别再等它们结束。
    await tree.loadRoot({ followups: true });
    tree.startDirectoryWatch();
  }

  // 刷新当前面板：显式刷新会重扫忽略规则；打开面板和窗口聚焦不走这里。
  async function refreshAll() {
    if (disposed || !state.rootPath) return;
    await tree.reloadGitignore();
    if (disposed) return;
    await Promise.all([tree.loadRoot(), tree.refreshJavaProject(), git.refreshGitAll()]);
  }

  function setOperationStatus(ok: boolean, error = "") {
    state.status = ok
      ? t("action.operationSuccess", "操作成功")
      : `${t("action.operationFailed", "操作失败")}: ${error || t("action.operationFailed", "操作失败")}`;
    renderToolbar();
    if (operationTimer) clearTimeout(operationTimer);
    operationTimer = setTimeout(() => {
      if (disposed) return;
      state.status = "";
      operationTimer = null;
      renderToolbar();
    }, 3200);
  }

  async function runSystemWriteAction(
    actionId: SystemWriteActionName,
    params?: Record<string, unknown>,
  ): Promise<FileWriteResult> {
    const run = api && api.write && api.write.run;
    if (typeof run !== "function") {
      return { ok: false, error: "当前宿主未提供系统操作能力" };
    }
    try {
      const result = await run(`system.${actionId}`, params);
      if (result && result.ok === true) return result;
      return { ok: false, error: result && result.error ? String(result.error) : "系统操作失败" };
    } catch (err) {
      return { ok: false, error: err && (err as ErrorLike).message ? (err as ErrorLike).message : String(err) };
    }
  }

  async function copyPathText(text: string) {
    closeContextMenu();
    const result = await runSystemWriteAction("writeClipboardText", { text });
    if (result.ok === true) return true;
    const fallbackOk = await copyToClipboard(text);
    if (fallbackOk) return true;
    setOperationStatus(false, result.error);
    return false;
  }

  async function handleRevealInExplorer(entry: Pick<FileTreeEntry, "path"> | null) {
    if (!entry || state.operationBusy) return;
    closeContextMenu();
    const result = await runSystemWriteAction("showItemInFolder", { path: entry.path });
    if (result.ok !== true) setOperationStatus(false, result.error);
  }

  /** 读取宿主 preload API（window.snow）；插件沙箱内完整可用。 */
  function snowApi() {
    return typeof window !== "undefined" ? window.snow : null;
  }

  /** 在终端中打开：目录→该目录；文件→其所在目录（与系统「在此处打开终端」一致）。 */
  function handleOpenInTerminal(entry: FileTreeEntry | null) {
    if (!entry || state.operationBusy) return;
    closeContextMenu();
    const target = entry.isDirectory ? entry.path : tree.parentDirectoryPath(entry.path);
    terminal.handleNewTerminal({ cwd: target || state.rootPath, mode: "terminal" });
  }

  function openConfirmDialog({ title, message, confirmLabel, danger = true, onConfirm }: ConfirmDialogState) {
    if (state.confirmDialog) return false;
    state.confirmDialog = { title, message, confirmLabel, danger, onConfirm };
    renderConfirmDialog();
    return true;
  }

  function closeConfirmDialog() {
    if (!state.confirmDialog) return;
    state.confirmDialog = null;
    renderConfirmDialog();
  }

  async function confirmDialogAction() {
    const dialog = state.confirmDialog;
    if (!dialog) return;

    state.confirmDialog = null;
    renderConfirmDialog();
    try {
      await dialog.onConfirm();
    } catch (err) {
      if (!disposed) setOperationStatus(false, err && (err as ErrorLike).message ? (err as ErrorLike).message : String(err));
    }
  }

  function renderConfirmDialog() {
    const root = layoutEls && layoutEls.root;
    if (!root) return;

    const oldOverlay = root.querySelector(".sfe-confirm-overlay");
    if (oldOverlay) oldOverlay.remove();

    const confirmState = state.confirmDialog;
    if (!confirmState) return;

    const overlay = el("div", "sfe-confirm-overlay");
    overlay.setAttribute("role", "presentation");
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeConfirmDialog();
    });

    const dialog = el("div", "sfe-confirm-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", confirmState.title);
    dialog.tabIndex = -1;
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeConfirmDialog();
      } else if (event.key === "Enter" && event.target === dialog) {
        event.preventDefault();
        void confirmDialogAction();
      }
    });

    const title = el("h2", "sfe-confirm-title", confirmState.title);
    const message = el("p", "sfe-confirm-message", confirmState.message);
    const actions = el("div", "sfe-confirm-actions");
    const cancelButton = el("button", "sfe-confirm-button", t("action.cancel", "取消"));
    cancelButton.type = "button";
    cancelButton.addEventListener("click", closeConfirmDialog);
    const confirmButtonClass = confirmState.danger ? "sfe-confirm-button danger" : "sfe-confirm-button";
    const confirmButton = el(
      "button",
      confirmButtonClass,
      confirmState.confirmLabel || t("action.confirm", "确认")
    );
    confirmButton.type = "button";
    confirmButton.addEventListener("click", () => void confirmDialogAction());

    // 统一保持“取消 → 确认动作”的顺序，危险动作通过 danger 样式强调。
    actions.appendChild(cancelButton);
    actions.appendChild(confirmButton);
    dialog.appendChild(title);
    dialog.appendChild(message);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    root.appendChild(overlay);

    setTimeout(() => {
      if (!disposed && dialog.isConnected) {
        dialog.focus();
      }
    }, 0);
  }

  function closeContextMenu() {
    if (!state.contextMenu) return;
    state.contextMenu = null;
    renderContextMenu();
  }

  function beginRename(entry: FileTreeEntry | null) {
    if (!entry || state.operationBusy) return;
    // beginRename 只由已打开的右键菜单项调用，state.contextMenu 此刻必非空（x/y 由展开带出）。
    state.contextMenu = { ...state.contextMenu!, entry, renaming: true };
    renderContextMenu();
  }

  function renderContextMenu() {
    const root = layoutEls && layoutEls.root;
    if (!root) return;
    const oldMenu = root.querySelector(".sfe-context-menu");
    if (oldMenu) oldMenu.remove();
    const context = state.contextMenu;
    if (!context) return;

    const menu = el("div", "sfe-context-menu");
    menu.setAttribute("role", "menu");
    menu.style.left = `${Math.max(4, context.x)}px`;
    menu.style.top = `${Math.max(4, context.y)}px`;
    menu.addEventListener("click", (event) => event.stopPropagation());
    const entry = context.entry;
    const disabled = state.operationBusy;

    const addItem = (label: string, action: () => void, isDisabled = false) => {
      const item = el("button", "sfe-context-menu-item" + (isDisabled ? " disabled" : ""), label);
      item.type = "button";
      item.disabled = isDisabled;
      item.setAttribute("role", "menuitem");
      item.addEventListener("click", () => {
        if (!isDisabled && !state.operationBusy) action();
      });
      menu.appendChild(item);
    };
    const separator = () => menu.appendChild(el("div", "sfe-context-menu-separator"));

    // 勾选型菜单项（视图开关）：右侧用 ✓ 标记勾选态（与常见菜单一致），未勾选留空位保持对齐。
    const addToggleItem = (label: string, checked: boolean, action: () => void, isDisabled = false) => {
      const item = el("button", "sfe-context-menu-item sfe-context-toggle" + (isDisabled ? " disabled" : ""));
      item.type = "button";
      item.disabled = isDisabled;
      item.setAttribute("role", "menuitemcheckbox");
      item.setAttribute("aria-checked", checked ? "true" : "false");
      item.appendChild(el("span", "sfe-context-toggle-label", label));
      const mark = el("span", "sfe-context-toggle-check");
      if (checked) mark.appendChild(createActionIcon("check", 13));
      item.appendChild(mark);
      item.addEventListener("click", () => {
        if (!isDisabled && !state.operationBusy) action();
      });
      menu.appendChild(item);
    };
    // 视图开关分组（工作区级，原三点菜单设置项）：按 .gitignore 过滤（默认勾选，再点取消）；
    // JVM 包结构视图仅 JVM 项目显示。切换后关闭菜单并重载文件树。
    const appendViewToggles = (isDisabled: boolean) => {
      addToggleItem(
        t("settings.respectGitignore", "按 .gitignore 过滤"),
        state.viewSettings.respectGitignore !== false,
        () => {
          closeContextMenu();
          void tree.toggleViewSetting("respectGitignore");
        },
        isDisabled,
      );
      if (
        state.javaProject &&
        Array.isArray(state.javaProject.sourceRoots) &&
        state.javaProject.sourceRoots.length
      ) {
        addToggleItem(
          t("settings.javaPackageView", "JVM 包结构视图"),
          state.viewSettings.javaPackageView !== false,
          () => {
            closeContextMenu();
            void tree.toggleViewSetting("javaPackageView");
          },
          isDisabled,
        );
      }
    };

    if (context.renaming) {
      const input = el("input", "sfe-context-menu-input");
      input.type = "text";
      // renaming 为真只可能来自 beginRename，该分支下 entry 必非空（见 beginRename）。
      input.value = entry!.name || "";
      input.setAttribute("aria-label", t("action.renamePrompt", "请输入新名称"));
      input.disabled = disabled;
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void tree.submitRename(input.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          closeContextMenu();
        }
      });
      menu.appendChild(input);
      setTimeout(() => {
        if (!disposed && input.isConnected) {
          input.focus();
          input.select();
        }
      }, 0);
    } else if (entry && state.selected.size > 1 && state.selected.has(entry.path)) {
      // 多选批量操作模式：复制 N 条路径（换行分隔）/ 删除 N 项（单次 IPC 批量删除）。
      const count = state.selected.size;
      addItem(
        t("action.copySelectedPaths", "复制 {{count}} 条路径", { count }),
        () => {
          closeContextMenu();
          void copyPathText(Array.from(state.selected).join("\n"));
        },
        disabled,
      );
      separator();
      addItem(
        t("action.deleteSelected", "删除 {{count}} 项", { count }),
        () => tree.handleDelete(entry),
        disabled,
      );
    } else if (!entry) {
      // 空白区右键：无具体条目，仅提供工作区级操作（刷新 / 打开工作区 / 复制工作区路径）
      addItem(t("action.refresh", "刷新"), () => handleRefresh(), disabled);
      separator();
      addItem(
        t("action.revealInExplorer", "在资源管理器中打开"),
        () => handleRevealInExplorer({ path: state.rootPath }),
        disabled || !state.rootPath,
      );
      addItem(
        t("action.copyPath", "复制路径"),
        () => copyPathText(state.rootPath),
        disabled || !state.rootPath,
      );
      separator();
      appendViewToggles(disabled);
    } else {
      addItem(
        entry.isDirectory
          ? t("action.openFolder", "展开文件夹")
          : t("action.openFile", "打开文件"),
        () => tree.handleContextOpen(entry),
        disabled,
      );
      separator();
      addItem(t("action.openInTerminal", "在终端中打开"), () => handleOpenInTerminal(entry), disabled);
      addItem(t("action.revealInExplorer", "在资源管理器中打开"), () => handleRevealInExplorer(entry), disabled);
      separator();
      addItem(t("action.copyPath", "复制路径"), () => copyPathText(entry.path), disabled);
      addItem(
        t("action.copyRelativePath", "复制相对路径"),
        () => {
          const value = relativePath(state.rootPath, entry.path);
          if (value == null) setOperationStatus(false, "目标路径不在当前工作区内");
          else void copyPathText(value);
        },
        disabled,
      );
      separator();
      addItem(t("action.rename", "重命名"), () => beginRename(entry), disabled);
      addItem(t("action.delete", "删除"), () => tree.handleDelete(entry), disabled);
      separator();
      addItem(t("action.refresh", "刷新"), () => handleRefresh(), disabled);
      separator();
      appendViewToggles(disabled);
    }

    root.appendChild(menu);
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(4, Math.min(context.x, viewportWidth ? viewportWidth - rect.width - 4 : context.x));
    const top = Math.max(4, Math.min(context.y, viewportHeight ? viewportHeight - rect.height - 4 : context.y));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function handleContextMenu(entry: FileTreeEntry | null, x: number, y: number) {
    if (state.operationBusy || state.confirmDialog) return;
    // 右键多选区域中的条目时保留整个选中集合；右键未选中条目则单选它。
    if (entry) {
      const next = state.selected.has(entry.path) ? state.selected : new Set([entry.path]);
      state.selected = next;
      state.selectionAnchor = entry.path;
      applyTreeSelectionHighlight();
    }
    state.contextMenu = { entry, x, y };
    renderContextMenu();
  }

  /** 刷新文件树与 Git 状态（工具栏刷新按钮与右键菜单「刷新」共用同一入口）。 */
  function handleRefresh() {
    closeContextMenu();
    void refreshAll();
  }

  /**
   * 懒加载项目识别：结果缓存进 state.projectCommands。
   * @description 首次在项目加载时触发（与 IDEA 一致：项目一打开就能 Run）。
   *   扫描完成后同步运行控件；识别结果不影响运行面板（面板只展示运行，不展示命令）。
   * @returns {Promise<Object|null>}
   */
  async function ensureCommands(rootEntries?: FileTreeEntry[]) {
    if (disposed || !state.rootPath) return null;
    const rootPath = state.rootPath;
    const before = state.projectCommands;
    const result = await ensureProjectCommands(state, rootPath, {
      // 首屏已经列过一次根目录，把那份条目交给扫描，别再发一趟重复的列目录 IPC。
      rootEntries: rootEntries ?? null,
      // 切项目 / 卸载后这次扫描就没有意义了：让它在层与层之间自己退出。
      shouldAbort: () => disposed || pathKey(rootPath) !== pathKey(state.rootPath),
    });
    if (disposed || pathKey(rootPath) !== pathKey(state.rootPath)) return result;
    // 命中缓存（引用未变）：不重渲染，避免打断右键菜单重命名等交互。
    if (result === before) return result;
    renderRunToolbarView();
    // package.json 预览：命令就绪后重渲染，补上 gutter ▶（首次打开时命令可能尚未扫完）。
    if (state.preview && state.preview.name === "package.json") renderPreview();
    // 菜单仍打开且未处于重命名输入态时才重渲染（重命名中重建会清空输入框）。
    if (state.contextMenu && state.contextMenu.entry && !state.contextMenu.renaming) renderContextMenu();
    return result;
  }

  /** 同步工具栏运行控件（Run/Stop 按钮、命令下拉与运行计数）。 */
  function syncRunToolbar() {
    if (runToolbar && typeof runToolbar.sync === "function") runToolbar.sync();
  }

    /**
   * 合并顶栏命令与「手动登记」的脚本命令（同 id 去重，顶栏命令在前）。
   * @param {Array} commands flattenCommands 结果
   * @param {Array} extra 手动登记的脚本命令
   * @returns {Array}
   */
  function mergeRunCommands(commands: FlatRunCommand[], extra: FlatRunCommand[]): FlatRunCommand[] {
    const base = Array.isArray(commands) ? commands : [];
    const list = Array.isArray(extra) ? extra : [];
    if (!list.length) return base;
    const ids = new Set(base.map((command) => command && command.id));
    return [...base, ...list.filter((command) => command && !ids.has(command.id))];
  }

  /**
   * 渲染 / 同步工具栏运行控件。
   * @description 控制器只创建一次并复用（避免重复注册 document 监听）；骨架重建后自动重建。
   */
  function renderRunToolbarView() {
    if (disposed || !layoutEls || !layoutEls.runToolbarWrap) return;
    const wrap = layoutEls.runToolbarWrap;
    // 骨架被重建（wrap 变空）时，旧控制器绑定的 DOM 已脱离文档，需重建。
    if (runToolbar && wrap.childElementCount > 0) {
      runToolbar.sync();
      return;
    }
    if (runToolbar && typeof runToolbar.dispose === "function") runToolbar.dispose();
    runToolbar = renderRunToolbar(wrap, {
      t,
      getState: () => {
        const commands = mergeRunCommands(flattenCommands(state.projectCommands), state.manualScriptCommands);
        return {
          commands,
          // 识别完成（无论是否命中生态）才算 ready，避免未扫描时误显示按钮。
          ready: state.projectCommands !== null,
          isCommandRunning: (command) => terminal.runCountForCommand(command) > 0,
        };
      },
      onRun: (command) => terminal.handleRunCommand(command),
      // Rerun：先停该命令的运行终端，再重新运行（IDEA 的 Rerun 语义）。
      onRerun: (command) => {
        terminal.stopCommandAndSync(command);
        terminal.handleRunCommand(command);
      },
      // Stop：只停「当前选中命令」，不波及其它命令（修复「点一个 Stop 全停」）。
      // 逐条 / 全部停止已移到「运行」工具窗口工具栏，顶栏不再提供 ⋮。
      onStop: (command) => terminal.stopCommandAndSync(command),
    });
  }

  // 文件树空白区右键：命中具体条目时由行自身处理并 stopPropagation（见 tree-view.js），
  // 只有落在空白处才冒泡到这里，弹出工作区级菜单（刷新 / 打开工作区 / 复制工作区路径）。
  function handleTreePaneContextMenu(event: MouseEvent) {
    // DOM 把 MouseEvent.target 声明为 EventTarget，而 closest 属于 Element；
    // 冒泡到容器的事件目标必然是节点本身，故只在类型层补回这一事实（原有可选调用不变）。
    if ((event.target as Element | null)?.closest?.(".sfe-file-item")) return;
    event.preventDefault();
    handleContextMenu(null, event.clientX, event.clientY);
  }

  // 5.1.1 右键菜单动作实现结束：所有实体变更都经过宿主 filesystem 写动作。

  // 视图开关菜单已拆除：视图选项（按 .gitignore 过滤 / Java 包结构视图）迁移到文件树右键菜单，
  // 主视图切换（文件 / Git）迁移到左侧入口栏，故工具栏不再有三点菜单。

  // ------------------------------------------------------------------
  // 7. 渲染：骨架只构建一次，之后按分区局部更新
  // ------------------------------------------------------------------
  // 关键设计：早期实现每次 render() 都 container.replaceChildren() 整体重建，
  // 宿主 git watcher 高频刷新时会反复重建 DOM —— 表现为提交输入框被反复抢焦点、
  // 右键菜单与键盘操作被打断、文本选区被销毁而无法选中。现改为：
  //   - 骨架（工具栏 + 主视图容器）只在首次构建；
  //   - 视图切换（文件树 / Git 变更）才重建主视图；
  //   - 数据刷新只更新对应分区（文件树 / Git 列表 / 提交框 / 查看器），
  //     提交输入框与列表滚动容器永不因数据刷新而销毁。

  let layoutEls: LayoutEls | null = null;

  // 构建骨架（幂等：仅在缺失或已脱离文档时重建）
  function ensureLayout() {
    if (layoutEls && layoutEls.root.isConnected) return layoutEls;

    container.replaceChildren();
    const root = el("div", "sfe-root");
    // layout 为横排：最左「竖排入口栏」+ 右侧主体（工具栏 / 主视图 / 底部工具窗口 / 底栏）。
    const layout = el("div", "sfe-container");

    // ── 最左侧竖排入口栏（IDEA tool window 语义）：文件在【顶部】，运行 / 终端【贴底】 ──
    const sidebar = el("div", "sfe-sidebar");
    /** 侧栏按钮：图标 + title（选中态由 syncSidebar 就地切换 .active），追加到指定父节点。 */
    const sidebarBtn = (
      parent: HTMLElement,
      iconName: string,
      label: string,
      onClick: () => void,
    ): HTMLButtonElement => {
      const btn = el("button", "sfe-sidebar-btn");
      btn.type = "button";
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.appendChild(createActionIcon(iconName, 16));
      btn.addEventListener("click", onClick);
      parent.appendChild(btn);
      return btn;
    };
    // 顶部主视图二选一：文件 / Git 变更（必有其一激活，不可都关）。
    const sidebarTop = el("div", "sfe-sidebar-top");
    sidebar.appendChild(sidebarTop);
    const fileViewBtn = sidebarBtn(sidebarTop, "folderOpen", t("sidebar.files", "文件"), () => switchMainView("files"));
    const gitViewBtn = sidebarBtn(sidebarTop, "folderGit2", t("sidebar.git", "Git 变更"), () => switchMainView("git"));
    // 底部按钮组（运行 / 终端）：靠 margin-top:auto 推到底部，与顶部主视图入口分开。
    const sidebarBottom = el("div", "sfe-sidebar-bottom");
    sidebar.appendChild(sidebarBottom);
    // 运行：切到「运行」工具窗口；运行中叠加小圆点（与底栏一致）。
    const runSideBtn = sidebarBtn(sidebarBottom, "play", t("sidebar.run", "运行"), () => terminal.selectBottomView("run"));
    const runSideDot = el("span", "sfe-sidebar-dot");
    runSideDot.hidden = true;
    runSideBtn.appendChild(runSideDot);
    // 终端：切到「终端」工具窗口。
    const terminalSideBtn = sidebarBtn(
      sidebarBottom,
      "terminal",
      t("sidebar.terminal", "终端"),
      () => terminal.selectBottomView("terminal"),
    );
    layout.appendChild(sidebar);

    // ── 主体：工具栏 / 主视图 / 底部工具窗口 / 底栏（纵排）──
    const body = el("div", "sfe-body");

    const toolbar = el("div", "sfe-toolbar");
    const pathText = el("div", "sfe-toolbar-path");
    // 同步指示器：紧跟文件夹名（pathText）之后的上下箭头，无数字，有未同步则着色、同步中动画。
    const syncIndicatorWrap = el("div", "sfe-toolbar-sync");
    const actions = el("div", "sfe-toolbar-actions");
    const statusEl = el("span", "sfe-toolbar-status");
    statusEl.hidden = true;
    actions.appendChild(statusEl);

    // 运行控件：对标 IDEA 右上角 Run（▶ Run / ■ Stop 二态 + 命令下拉）。
    // 容器固定常驻，内容由 renderRunToolbar 按识别结果与运行状态同步，避免重建工具栏。
    const runToolbarWrap = el("div", "sfe-run-toolbar-wrap");
    runToolbarWrap.hidden = true;
    actions.appendChild(runToolbarWrap);

    // 「差异 / 内容」切换容器：紧邻刷新按钮，仅在 Git 变更视图且已打开文件时显示
    // （容器固定，内容由 renderGitViewSwitchInToolbar 按需同步，避免重建工具栏）
    const gitViewSwitchWrap = el("div", "sfe-toolbar-git-view");
    gitViewSwitchWrap.hidden = true;
    actions.appendChild(gitViewSwitchWrap);

    toolbar.appendChild(pathText);
    toolbar.appendChild(syncIndicatorWrap);
    toolbar.appendChild(actions);
    body.appendChild(toolbar);
    // 工具栏以下单独成行：底栏时纵排，右侧停靠时主视图与工具窗口横排。
    const bodyMain = el("div", "sfe-body-main");
    const mainView = el("div", "sfe-main-view");
    bodyMain.appendChild(mainView);
    // 工具窗口：两个独立窗口（终端 / 运行），随主视图重建而不消失；
    // 默认隐藏，由 refreshBottomVisibility 按 state.bottomView 互斥显隐（内容在首次打开时按需渲染）。
    const runWindowEl = el("div", "sfe-tool-window sfe-run-window");
    runWindowEl.hidden = true;
    bodyMain.appendChild(runWindowEl);
    const terminalWindowEl = el("div", "sfe-tool-window sfe-terminal-window");
    terminalWindowEl.hidden = true;
    bodyMain.appendChild(terminalWindowEl);
    body.appendChild(bodyMain);
    layout.appendChild(body);
    root.appendChild(layout);
    container.appendChild(root);

    layoutEls = {
      root,
      layout,
      sidebar,
      sidebarTop,
      sidebarBottom,
      fileViewBtn,
      gitViewBtn,
      runSideBtn,
      runSideDot,
      terminalSideBtn,
      body,
      bodyMain,
      mainView,
      runWindowEl,
      terminalWindowEl,
      pathText,
      syncIndicatorWrap,
      statusEl,
      gitViewSwitchWrap,
      runToolbarWrap,
      treePane: null,
      previewPane: null,
      gitPane: null,
      gitPreviewPane: null,
    };
    return layoutEls;
  }

  /**
   * 切换主视图（文件 / Git 变更）——二选一，必有其一激活，不可都关。
   * @description 手动切换后仅改 state.mainView 并重建主视图；mainView 不持久化，
   *   每次重新打开面板从「文件」开始。
   * @param {"files"|"git"} view 目标主视图
   */
  async function switchMainView(view: PanelState["mainView"]) {
    if (disposed || (view !== "files" && view !== "git")) return;
    if (state.mainView === view) return;
    state.mainView = view;
    if (view === "files") {
      // 离开 Git 变更视图：清空查看器状态，否则再切回时会残留上次打开的比对。
      state.gitPreview = null;
      state.gitSelected = null;
    }
    render();
    // 首次进入 Git 变更视图且尚未拉取过状态时补齐数据。
    if (view === "git" && !state.gitStatus) await git.refreshGitViewStatus();
  }

  /** 同步左侧入口栏选中态与运行中圆点。 */
  function syncSidebar() {
    if (!layoutEls) return;
    if (layoutEls.fileViewBtn) layoutEls.fileViewBtn.classList.toggle("active", state.mainView === "files");
    if (layoutEls.gitViewBtn) layoutEls.gitViewBtn.classList.toggle("active", state.mainView === "git");
    if (layoutEls.runSideBtn) layoutEls.runSideBtn.classList.toggle("active", state.bottomView === "run");
    if (layoutEls.terminalSideBtn) layoutEls.terminalSideBtn.classList.toggle("active", state.bottomView === "terminal");
    if (layoutEls.runSideDot) layoutEls.runSideDot.hidden = terminal.runningCount() <= 0;
  }

  // 同步工具栏（路径、状态）
  function renderToolbar() {
    if (!layoutEls) return;
    const { pathText, statusEl } = layoutEls;
    const name = state.rootPath ? basename(state.rootPath) : "-";
    if (pathText.textContent !== name) pathText.textContent = name;
    if (pathText.title !== (state.rootPath || "")) pathText.title = state.rootPath || "";
    if (state.status) {
      if (statusEl.textContent !== state.status) statusEl.textContent = state.status;
      statusEl.hidden = false;
    } else {
      statusEl.hidden = true;
    }
  }

  // 构建「差异 / 内容」分段控件（工具栏用，复用查看器分段控件的样式类）
  function buildGitViewSwitch(current: GitViewerMode) {
    const switcher = el("div", "sfe-md-mode-switch-inline");
    switcher.setAttribute("role", "group");
    // as const 只把 key 的字面量类型留给 setGitPreviewMode（GitViewerMode），数组本身不变。
    const segments = [
      { key: "diff", icon: "diff", label: t("action.diff", "差异") },
      { key: "content", icon: "code", label: t("action.content", "内容") },
    ] as const;
    for (const seg of segments) {
      const isActive = seg.key === current;
      const btn = el("button", "sfe-md-mode-btn" + (isActive ? " active" : ""));
      btn.type = "button";
      btn.title = seg.label;
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      btn.appendChild(createActionIcon(seg.icon, 13));
      btn.appendChild(el("span", "sfe-md-mode-label", seg.label));
      if (!isActive) btn.addEventListener("click", () => git.setGitPreviewMode(seg.key));
      switcher.appendChild(btn);
    }
    return switcher;
  }

  // 同步工具栏中的「差异 / 内容」切换：仅全屏 + Git 变更视图 + 已打开文件时显示
  function renderGitViewSwitchInToolbar() {
    if (!layoutEls || !layoutEls.gitViewSwitchWrap) return;
    const wrap = layoutEls.gitViewSwitchWrap;
    const gp = state.gitPreview;
    const terminalOwnsRight = state.toolDock === "right" && (state.bottomView === "run" || state.bottomView === "terminal");
    if (state.mainView !== "git" || !gp || !isRightPanelFullscreen() || terminalOwnsRight) {
      if (wrap.firstChild) wrap.replaceChildren();
      wrap.hidden = true;
      return;
    }
    const current = gp.mode === "content" ? "content" : "diff";
    wrap.replaceChildren(buildGitViewSwitch(current));
    wrap.hidden = false;
  }

  // 全量渲染：重建主视图（用于初始化与文件树 / Git 变更视图切换）
  // 局部：骨架与常驻控件（不重建主视图内容）。挂载期先铺这层，数据到位再 render。
  function renderChrome() {
    ensureLayout();
    renderToolbar();
    renderConfirmDialog();
    // 运行控件（常驻工具栏，按识别结果与运行状态同步）。
    renderRunToolbarView();
    // 底部工具窗口 / 左侧入口栏挂在主体上（不随 mainView 重建），此处同步显隐与选中态。
    terminal.refreshBottomVisibility();
    syncSidebar();
    // 窗口可见时让终端适配尺寸（视图切换可能改变容器宽度）。
    terminal.fitTerminalPanel();
  }

  function render() {
    if (disposed) return;
    renderChrome();
    // 上面 ensureLayout() 已建好骨架并写回 layoutEls；ensureLayout 只在
    // 「已存在且仍挂在文档上」时提前返回，故此后 layoutEls 必非空（断言只补回这条不变量）。
    const { mainView } = layoutEls!;
    mainView.replaceChildren();
    renderGitViewSwitchInToolbar();
    layoutEls!.treePane = null;
    layoutEls!.previewPane = null;
    layoutEls!.gitPane = null;
    layoutEls!.gitPreviewPane = null;

    if (state.mainView === "git") {
      buildGitView(mainView);
      renderGitPane();
      renderGitPreview();
      syncGitIndicator();
      return;
    }
    buildFileView(mainView);
    renderTree();
    renderPreview();
    syncGitIndicator();
  }

  // 构建文件树视图骨架（左树 + 右预览）
  function buildFileView(mainView: HTMLElement) {
    const treePane = el("div", "sfe-tree-pane");
    // 空白区右键：行内条目自行处理并阻止冒泡，其余区域在此兜底弹出工作区级菜单
    treePane.addEventListener("contextmenu", handleTreePaneContextMenu);

    // 文件搜索栏（仅工作区已就绪时显示）：同时搜索文件名与文件内容。
    const searchBar = el("div", "sfe-search-bar");
    searchBar.hidden = !state.rootPath;
    const searchIcon = el("span", "sfe-search-icon");
    searchIcon.appendChild(createActionIcon("search", 13));
    const searchInput = el("input", "sfe-search-input");
    searchInput.type = "text";
    searchInput.spellcheck = false;
    searchInput.value = state.searchQuery;
    searchInput.placeholder = t("search.placeholder", "搜索文件名或内容");
    searchInput.setAttribute("aria-label", t("search.placeholder", "搜索文件名或内容"));
    searchInput.addEventListener("input", () => preview.handleSearchInput(searchInput.value));
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        preview.clearSearch();
      }
    });
    const searchClear = el("button", "sfe-search-clear");
    searchClear.type = "button";
    searchClear.title = t("search.clear", "清除搜索");
    searchClear.setAttribute("aria-label", t("search.clear", "清除搜索"));
    searchClear.appendChild(createActionIcon("close", 13));
    searchClear.hidden = !state.searchQuery;
    searchClear.addEventListener("click", () => preview.clearSearch());
    searchBar.appendChild(searchIcon);
    searchBar.appendChild(searchInput);
    searchBar.appendChild(searchClear);
    treePane.appendChild(searchBar);

    const treeBody = el("div", "sfe-tree-body");
    treePane.appendChild(treeBody);
    // buildFileView 只在 render() 里 ensureLayout() 之后调用，layoutEls 必非空（同 render 的说明）。
    layoutEls!.treeBody = treeBody;
    layoutEls!.searchInput = searchInput;
    layoutEls!.searchClear = searchClear;

    mainView.appendChild(treePane);
    layoutEls!.treePane = treePane;

    const previewPane = el("div", "sfe-preview-pane");
    mainView.appendChild(previewPane);
    layoutEls!.previewPane = previewPane;
  }

  // 构建 Git 变更视图骨架（左列表 + 右查看器）
  function buildGitView(mainView: HTMLElement) {
    const gitPane = el("div", "sfe-git-pane");
    mainView.appendChild(gitPane);
    layoutEls!.gitPane = gitPane;

    const gitPreviewPane = el("div", "sfe-git-preview-pane");
    mainView.appendChild(gitPreviewPane);
    // 同 buildFileView：这两个函数只在 render() 的 ensureLayout() 之后被调用。
    layoutEls!.gitPreviewPane = gitPreviewPane;
  }

  // 局部：仅切换文件树的选中行高亮，不重建 DOM
  // @description previewFile / 多选点击只改 state.selected（Set），不重建整棵树：大目录下整树重建是卡顿根因。
  //   选中态对行只是 .selected class（纯背景色），就地切换与重建后的渲染结果完全等价，
  //   同时天然保住滚动位置、展开态与行内事件。
  function applyTreeSelectionHighlight() {
    if (disposed || !layoutEls || !layoutEls.treePane) return;
    const pane = layoutEls.treePane;
    const selectedKeys = new Set(Array.from(state.selected, pathKey));
    for (const node of pane.querySelectorAll<HTMLElement>(".sfe-file-item")) {
      node.classList.toggle("selected", selectedKeys.has(pathKey(node.dataset.path)));
    }
  }

  // 局部：文件树 / 搜索结果（保留滚动位置）
  function renderTree() {
    if (disposed || !layoutEls || !layoutEls.treePane) return;
    const body = layoutEls.treeBody || layoutEls.treePane;
    if (layoutEls.searchClear) layoutEls.searchClear.hidden = !state.searchQuery;
    const scroll = body.scrollTop;
    if (state.searchQuery.trim()) {
      // 搜索结果接管树容器：先销毁树的虚拟列表（scroll 监听挂在 body 上，仅替换子节点清不掉）。
      destroyTreeView(body);
      renderSearchResults(body);
    } else {
      renderTreeView(body, {
        rootPath: state.rootPath,
        rootNodes: state.rootNodes,
        expanded: state.expanded,
        getSelected: () => state.selected,
        getGitStatusMap: () => state.gitStatusMap,
        canList: true,
        canRead: true,
        onToggleDir: (entry) => tree.toggleDir(entry),
        onSelectFile: (entry) => preview.previewFile(entry),
        onContextMenu: handleContextMenu,
        onOpenFileEdit: (entry) => preview.handleOpenFileEdit(entry),
        onSelectionChange: (change) => tree.handleTreeSelectionChange(change),
        onTreeKeyDown: (event, visiblePaths) => tree.handleTreeKeyDown(event, visiblePaths),
        t,
      });
    }
    body.scrollTop = scroll;
  }

  // 局部：搜索结果列表（文件名 + 内容行匹配；点击打开并跳行）
  function renderSearchResults(parent: HTMLElement) {
    parent.replaceChildren();
    if (state.searching && !state.searchResults.length) {
      parent.appendChild(el("div", "sfe-empty", t("search.searching", "搜索中…")));
      return;
    }
    if (!state.searchResults.length) {
      parent.appendChild(el("div", "sfe-empty", t("search.noResults", "没有匹配结果")));
      return;
    }
    const count = el(
      "div",
      "sfe-search-count",
      t("search.resultCount", "{{count}} 个文件", { count: state.searchResults.length })
    );
    parent.appendChild(count);
    const list = el("div", "sfe-search-results");
    for (const result of state.searchResults) {
      const row = el("div", "sfe-search-result");
      row.title = result.path;
      row.dataset.path = result.path;
      const head = el("div", "sfe-search-result-head");
      const iconEl = createFileIconNode(result.name, !!result.isDirectory, false);
      head.appendChild(iconEl);
      const info = el("div", "sfe-search-result-info");
      info.appendChild(el("span", "sfe-search-result-name", result.name));
      info.appendChild(el("span", "sfe-search-result-path", result.relativePath || ""));
      head.appendChild(info);
      head.addEventListener("click", () => preview.handleSearchResultOpen(result));
      row.appendChild(head);
      // 内容匹配行：点击直接跳转到对应行号。
      for (const match of result.lineMatches || []) {
        const lineEl = el("div", "sfe-search-result-line");
        lineEl.title = `${result.path}:${match.line}`;
        lineEl.appendChild(el("span", "sfe-search-line-no", String(match.line)));
        lineEl.appendChild(el("span", "sfe-search-line-text", match.text || ""));
        lineEl.addEventListener("click", () => preview.handleSearchResultOpen(result, match.line));
        row.appendChild(lineEl);
      }
      list.appendChild(row);
    }
    parent.appendChild(list);
  }

  // 局部：普通文件预览
  function renderPreview() {
    if (disposed || !layoutEls || !layoutEls.previewPane) return;
    renderCodeViewer(layoutEls.previewPane, {
      preview: state.preview,
      rootPath: state.rootPath,
      copied: state.copied,
      onCopy: () => preview.handleCopyCode(),
      onSetMode: (mode) => preview.setPreviewMode(mode),
      onToggleEdit: (next) => preview.setPreviewEditable(next),
      onEditInput: (value) => preview.handlePreviewInput(value),
      onSave: () => preview.handleSavePreview(),
      onRevealFile: () => preview.handlePreviewRevealFile(),
      onCopyPath: () => preview.handlePreviewCopyPath(),
      onCopyRelativePath: () => preview.handlePreviewCopyRelativePath(),
      onRefresh: () => preview.handlePreviewRefresh(),
      // 运行入口：代码查看器需要完整源码 main 列表，顶栏仍使用过滤后的可见命令列表。
      runCommands: () => flattenCommands(state.projectCommands, { includeHidden: true }),
      // 右键「运行」分组的上限：与顶栏下拉同一份列表，菜单不得多出顶栏没有的命令。
      runMenuCommands: () => mergeRunCommands(flattenCommands(state.projectCommands), state.manualScriptCommands),
      onRunCommand: (command) => terminal.handleRunCommand(command),
      editable: state.preview.editable === true,
      saving: state.preview.saveState === "saving",
      t,
    });
  }

  // Git 变更视图选项（提交框与列表共用）
  function gitViewOptions(): GitViewOptions {
    // 已暂存文件数：AI 生成与提交按钮的可用性依赖它
    const stagedCount = partitionGitFiles(state.gitStatus && state.gitStatus.files).staged.length;
    return {
      rootPath: state.rootPath,
      gitStatus: state.gitStatus,
      stagedCount,
      selected: state.gitSelected,
      commitMessage: state.gitCommitMessage,
      busy: state.gitBusy,
      generating: state.gitGenerating,
      commitMode: state.gitCommitMode,
      commitMenuOpen: state.gitCommitMenuOpen,
      // collapsedStaged 的初值是 null（表示「还没按首次仓库状态建默认折叠」），
      // 而 applyGitStatus 在有仓库状态时必先建表，renderGitPane 又只在有文件时才走折叠查询，
      // 故组件侧（flattenGitTree 直接 .has）拿到的必是 Set；null 这一态在类型上无法表达其时序保证。
      collapsedStaged: state.collapsedStaged!,
      collapsedUnstaged: state.collapsedUnstaged,
      // 单击仅更新选中态（就地改样式，不重建 DOM）
      onSelectFile: (file: GitFileStatus, section: GitSection) => {
        state.gitSelected = `${section}:${file.path}`;
      },
      // 单击文件夹行：同样记录选中态（与文件选中共用 gitSelected，天然互斥），
      // 使目录行的行内加号/减号常显，而非仅 hover 时可见。
      onSelectFolder: (node: GitTreeNode, section: GitSection) => {
        state.gitSelected = `${section}:${node.path}`;
      },
      onStageToggle: (files, section) => git.handleStageToggle(files, section),
      onStageAll: () => git.handleStageAll(),
      onUnstageAll: () => git.handleUnstageAll(),
      onDiscard: (files) => git.handleDiscard(files),
      onCommit: () => git.handleCommit(),
      onCommitAndPush: () => git.handleCommitAndPush(),
      onSetCommitMode: (mode) => git.handleSetCommitMode(mode),
      onToggleCommitMenu: () => {
        state.gitCommitMenuOpen = !state.gitCommitMenuOpen;
        renderGitPaneCommit();
      },
      onToggleCollapse: (section, path) => git.handleToggleGitCollapse(section, path),
      onGenerate: () => git.handleGenerateCommitMessage(),
      // 输入只写回 state，不触发重建（重建会销毁节点、打断输入与光标）
      onCommitMessageInput: (value: string) => {
        state.gitCommitMessage = value;
      },
       // 单击文件行：右侧加载该文件的 Git 差异
       onOpenFile: (file, section) => git.openGitDiff(file, section),
       // 右键菜单复用普通文件树已有系统能力，不新增复制/移动等文件 API。
       onRevealFile: (file) => git.handleGitRevealFile(file),
       onCopyRelativePath: (file) => git.handleGitCopyRelativePath(file),
       onCopyAbsolutePath: (file) => git.handleGitCopyAbsolutePath(file),
       // 右键菜单「刷新」：只刷 Git 自己的东西（变更状态 + 当前差异），不触发全仓忽略规则重扫
       onRefresh: () => git.handleGitRefresh(),
       t,
     };
   }

  // 局部：Git 提交框 + 变更列表
  function renderGitPane() {
    if (disposed || !layoutEls || !layoutEls.gitPane) return;
    const opts = gitViewOptions();
    renderGitCommitBar(layoutEls.gitPane, opts);
    renderGitList(layoutEls.gitPane, opts);
  }

  // 局部：仅 Git 提交框（busy / 生成态变化，列表不变）
  function renderGitPaneCommit() {
    if (disposed || !layoutEls || !layoutEls.gitPane) return;
    renderGitCommitBar(layoutEls.gitPane, gitViewOptions());
  }

  // 同步顶栏的 Git 同步指示器（文件夹名右侧的上下箭头，无数字）。
  // 控制器只创建一次并复用；骨架重建（wrap 变空）后自动重建。
  function syncGitIndicator() {
    if (disposed || !layoutEls || !layoutEls.syncIndicatorWrap) return;
    const wrap = layoutEls.syncIndicatorWrap;
    if (gitSyncIndicator && wrap.childElementCount > 0) {
      gitSyncIndicator.sync();
      return;
    }
    if (gitSyncIndicator && typeof gitSyncIndicator.dispose === "function") gitSyncIndicator.dispose();
    gitSyncIndicator = renderGitSyncIndicator(wrap, {
      t,
      getState: () => ({ gitStatus: state.gitStatus, gitBusy: state.gitBusy, gitSyncBusy: state.gitSyncBusy }),
      onSync: () => git.handleSync(),
    });
  }

  // 局部：Git 右侧文件查看器（差异 / 内容）
  function renderGitPreview() {
    if (disposed || !layoutEls || !layoutEls.gitPreviewPane) return;
    const previewState = git.gitPreviewView();
    // 有文件时提供文件操作（资源管理器 / 复制路径）；无文件（空态）时不注入，
    // 但保留 onRefresh —— 空态右键也能弹出「刷新」，刷新左侧变更列表与当前差异。
    const hasFile = previewState && state.gitPreview;
    renderCodeViewer(layoutEls.gitPreviewPane, {
      preview: previewState,
      emptyHint: t("git.previewHint", "在左侧选择变更文件以查看差异。"),
      copied: state.copied,
      onCopy: () => preview.handleCopyCode(),
      onSetMode: (mode) => preview.setPreviewMode(mode),
      onSetDiffMode: (mode) => git.setDiffMode(mode),
      onRefresh: () => git.handleGitPreviewRefresh(),
      // 右侧差异查看器的右键菜单：与文件管理器预览区一致的文件操作（仅打开文件时注入）
      onRevealFile: hasFile ? () => git.handleGitPreviewRevealFile() : undefined,
      onCopyPath: hasFile ? () => git.handleGitPreviewCopyPath() : undefined,
      onCopyRelativePath: hasFile ? () => git.handleGitPreviewCopyRelativePath() : undefined,
      t,
    });
    // 「差异 / 内容」切换位于工具栏，需随查看器同步（打开/切换文件、切换子视图）
    renderGitViewSwitchInToolbar();
  }

  // 局部：按当前视图刷新「正在使用的」查看器（复制按钮反馈用）
  function renderActiveViewer() {
    if (state.mainView === "git") renderGitPreview();
    else renderPreview();
  }


  // 8. 启动与初始化生命周期（先只铺骨架，数据到位后再 render 主视图，避免空态闪一屏再全量重建）
  renderChrome();

  // 拖宿主分栏 / 改窗口大小此前没有任何监听会经过 fitTerminalPanel，cols/rows 于是陈旧，
  // 输出按旧列数换行。只对当前可见的那个工具窗口重算（fitTerminalPanel 自己按 bottomView 选窗）。
  let terminalSizeObserver: ResizeObserver | null = null;
  let terminalSizeScheduled = false;
  // renderChrome 里的 ensureLayout 已把骨架写回 layoutEls（与 render() 里同一条例）。
  const dockEls = layoutEls!;
  if (typeof ResizeObserver === "function") {
    terminalSizeObserver = new ResizeObserver(() => {
      if (disposed || terminalSizeScheduled) return;
      terminalSizeScheduled = true;
      const run = () => {
        terminalSizeScheduled = false;
        if (!disposed) terminal.fitTerminalPanel();
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
      else setTimeout(run, 16);
    });
    if (dockEls.terminalWindowEl) terminalSizeObserver.observe(dockEls.terminalWindowEl);
    if (dockEls.runWindowEl) terminalSizeObserver.observe(dockEls.runWindowEl);
  }

  // 点击插件外部区域关闭三点菜单（capture 阶段，避免被内部 stopPropagation 拦截）
  // MouseEvent.target 在 DOM 类型里是 EventTarget，而 Node.contains 只收 Node；
  // click 事件的目标必是节点，故两处入参各做一次类型层断言。
  const closeMenuOnOutside = (e: MouseEvent) => {
    // 提交模式下拉：点击 split 区域外时关闭
    if (state.gitCommitMenuOpen) {
      const split = container.querySelector(".sfe-git-commit-split");
      if (split && !split.contains(e.target as Node | null)) {
        state.gitCommitMenuOpen = false;
        renderGitPaneCommit();
        return;
      }
    }
    if (state.contextMenu) {
      const contextMenu = container.querySelector(".sfe-context-menu");
      if (contextMenu && !contextMenu.contains(e.target as Node | null)) {
        closeContextMenu();
      }
    }
  };
  document.addEventListener("click", closeMenuOnOutside, true);

  const closeContextMenuOnEscape = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !state.contextMenu) return;
    e.preventDefault();
    closeContextMenu();
  };
  document.addEventListener("keydown", closeContextMenuOnEscape, true);

  // 宿主全屏态变化（用户点全屏按钮）时同步工具栏「差异 / 内容」切换的显隐。
  // MutationObserver / document.body 在真实宿主必然存在；此处做防御以兼容极简测试环境。
  let fullscreenObserver: MutationObserver | null = null;
  if (typeof MutationObserver === "function" && document.body) {
    let lastFullscreen = isRightPanelFullscreen();
    fullscreenObserver = new MutationObserver(() => {
      const now = isRightPanelFullscreen();
      if (now === lastFullscreen) return;
      lastFullscreen = now;
      // 右侧布局依赖全屏。用户退出全屏时终端回到底栏，避免和代码预览抢同一列。
      if (!now && state.toolDock === "right" && (state.bottomView === "run" || state.bottomView === "terminal")) {
        state.toolDock = "bottom";
        terminal.saveToolDock();
        terminal.applyToolDock();
        terminal.fitTerminalPanel();
      }
      renderGitViewSwitchInToolbar();
    });
    // 全屏类只可能落在这两个宿主元素自己身上，观察它们即可；观察 document.body+subtree
    // 会让宿主每一次 class 抖动（AI 流式渲染尤甚）都排一批回调给本插件。
    const fullscreenTargets = [
      document.querySelector(".right-panel"),
      document.querySelector(".app-shell"),
    ].filter((node): node is Element => !!node);
    if (fullscreenTargets.length) {
      for (const target of fullscreenTargets) {
        fullscreenObserver.observe(target, { attributes: true, attributeFilter: ["class"] });
      }
    } else {
      // 宿主标记结构变了（两个元素都不存在）：退回整文档观察，宁慢不误。
      fullscreenObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ["class"],
        subtree: true,
      });
    }
  }

  // 宿主 Tab 切换感知：当从宿主其他面板（如 Git、终端、代码库）切回当前文件浏览器时，
  // 宿主 .right-panel-tab-pane 获得 .active 类，此时必须执行刷新（重新拉取目录树与 Git 状态）
  let tabPaneObserver: MutationObserver | null = null;
  const tabPaneEl = typeof container.closest === "function" ? container.closest(".right-panel-tab-pane") : null;
  if (tabPaneEl && typeof MutationObserver === "function") {
    let wasActive = tabPaneEl.classList.contains("active");
    tabPaneObserver = new MutationObserver(() => {
      if (disposed) return;
      const isActiveNow = tabPaneEl.classList.contains("active");
      if (isActiveNow && !wasActive) {
        // 从其他面板切回文件浏览器：自动触发全量刷新
        void git.refreshGitAll();
      }
      wasActive = isActiveNow;
    });
    tabPaneObserver.observe(tabPaneEl, { attributes: true, attributeFilter: ["class"] });
  }

  // 宿主窗口切回感知（用户从外部应用切回 Snow App 时刷新）
  const handleWindowFocus = () => {
    if (disposed) return;
    if (!tabPaneEl || tabPaneEl.classList.contains("active")) {
      git.scheduleGitRefresh();
    }
  };
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("focus", handleWindowFocus);
  }

  let unsubGit: Unsubscribe | null = null;
  let unsubProjects: Unsubscribe | null = null;
  // 图标块挂载即并行发起：与首屏元数据 / 列目录并发，占位图标闪现窗口压缩到最小。
  // 首帧绘树前另有 120ms 的限时到账窗口（见 loadRoot）；到不齐时由 followups 就地回填，
  // 首屏不被 585KB 的块拖死。
  void ensureIcons();
  void (async () => {
    const [initialRoot, viewSettings, diffMode, commitMode, toolDock] = await Promise.all([
      resolveRoot(),
      loadViewSettings(api),
      loadDiffViewMode(api),
      (async () => {
        try {
          if (api.storage && typeof api.storage.getJson === "function") {
            return await api.storage.getJson<unknown>("gitCommitMode", null);
          }
        } catch {
          // 忽略读取失败，使用默认模式
        }
        return null;
      })(),
      (async () => {
        try {
          if (api.storage && typeof api.storage.getJson === "function") {
            return await api.storage.getJson<unknown>("toolDock", null);
          }
        } catch {
          // 忽略读取失败，默认底栏
        }
        return null;
      })(),
    ]);
    if (disposed) return;
    state.rootPath = initialRoot || "";
    state.viewSettings = viewSettings;
    if (commitMode === "commitAndPush") state.gitCommitMode = "commitAndPush";
    if (toolDock === "right") state.toolDock = "right";
    state.diffMode = diffMode;
    render();
    if (state.rootPath) {
      await tree.loadRoot({ followups: true });
      if (disposed) return;
    }
    // 跟随宿主项目切换：订阅 projects 域（live），activeDirectory 变化时全量切换到新项目。
    // 与宿主「打开文件夹」按钮天然一致，插件不自建多开与目录选择。
    if (api && api.metadata && typeof api.metadata.subscribe === "function") {
      try {
        // 偏离（已登记）：宿主 subscribe 委派给 async 的 subscribeMetadata（snow-app
        // src/renderer/plugins/pluginApi.ts:199、src/renderer/plugins/metadata/index.ts:176），返回 Promise<MetadataSubscription>。
        // 原写法同步读 sub.unsubscribe 只会拿到 undefined，unsubProjects 恒为 null、
        // 卸载时这条订阅从不取消。subscribeMetadata 建好定时器后即返回（首次采集是 void emit()，
        // 不在返回链上），所以这里 await 只让出一个微任务，不会推迟后面的 git 订阅。
        const sub = await api.metadata.subscribe("projects", (response) => {
          if (disposed) return;
          const nextPath = resolveActiveDirectoryPath(response);
          if (pathKey(nextPath) === pathKey(state.rootPath)) return;
          void applyActiveProject(nextPath);
        });
        unsubProjects = sub && typeof sub.unsubscribe === "function" ? sub.unsubscribe : null;
      } catch (err) {
        console.warn("[FileExplorer] 订阅宿主项目变化失败", err);
      }
    }
    // 宿主 Git watcher 在文件变化时会高频触发（一次 checkout/写盘可能连续触发多次），
    // 因此必须做「路径过滤 + 防抖」，与宿主官方 useGitStatus 的处理保持一致，
    // 否则会不断重建整棵树，导致滚动位置与文本选区被反复打断。
    unsubGit = subscribeGitStatus((changedPath) => {
      if (
        changedPath &&
        state.rootPath &&
        changedPath !== state.rootPath &&
        !state.rootPath.startsWith(changedPath)
      ) {
        return;
      }
      git.scheduleGitRefresh(300);
    });
  })();

  return () => {
    disposed = true;
    // 各控制器自持定时器与在途流：预览（复制反馈/搜索防抖）、Git（刷新防抖/AI 提交信息流）。
    preview.release();
    git.release();
    if (operationTimer) clearTimeout(operationTimer);
    if (typeof unsubGit === "function") unsubGit();
    if (typeof unsubProjects === "function") unsubProjects();
    tree.stopDirectoryWatch();
    if (runToolbar && typeof runToolbar.dispose === "function") runToolbar.dispose();
    runToolbar = null;
    if (gitSyncIndicator && typeof gitSyncIndicator.dispose === "function") gitSyncIndicator.dispose();
    gitSyncIndicator = null;
    if (fullscreenObserver) fullscreenObserver.disconnect();
    if (terminalSizeObserver) {
      terminalSizeObserver.disconnect();
      terminalSizeObserver = null;
    }
    if (tabPaneObserver) tabPaneObserver.disconnect();
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("focus", handleWindowFocus);
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("click", closeMenuOnOutside, true);
      document.removeEventListener("keydown", closeContextMenuOnEscape, true);
    }
    state.contextMenu = null;
    state.operationBusy = false;
    // 卸载：终止仍在运行的全部终端进程，避免留下孤儿进程。
    terminal.killAllTerminals();
    closeGitContextMenu(layoutEls && layoutEls.gitPane);
    // 查看器的虚拟列表与视口观察器挂在面板上：面板即将随容器一起摘掉，
    // 不断开就会拖住整块可视行与闭包里的全文（宿主多次重载插件时线性累积）。
    disposeViewerViewport(layoutEls && layoutEls.previewPane);
    disposeViewerViewport(layoutEls && layoutEls.gitPreviewPane);
    // 两个工具窗口控制器随面板销毁（xterm 实例与监听一起释放）。
    terminal.releaseWindows();
    // 随懒块注入的样式随插件一起摘除，不在宿主 head 里留残留（重挂载时 loadChunk 会重新注入）。
    releaseChunkStyles();
    container.replaceChildren();
  };
}

// 默认导出与命名导出双重兼容
export default { mount };
