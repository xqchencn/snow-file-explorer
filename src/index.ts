/**
 * Snow App 文件浏览器插件 (renderMode: "esm")
 * 模块化顶层入口：协调文件服务、Git 状态、目录树视图与代码预览器
 */

import type { PluginRuntimeApi, SystemWriteActionName } from "./types/plugin-runtime.ts";
import type { GitSyncIndicatorHandle } from "./components/git-sync-indicator.ts";
import type { TranslateFn, HttpViewerMode } from "./types/panel-state.ts";
import type { Unsubscribe } from "./types/snow-api.ts";
import type { GitFileStatus } from "./types/host/host-git.ts";
import type { FileTreeEntry, ErrorLike, FileWriteResult } from "./services/file-service.ts";
import type { GitTreeNode } from "./services/git-service.ts";
import type { HttpEnvironmentDraft } from "./services/http-env.ts";
import type { FlatRunCommand } from "./services/project-commands.ts";
import type { RunToolbarHandle } from "./components/run-toolbar.ts";
import type { GitSection, GitViewOptions } from "./components/git-view.ts";
import type { GitViewerMode } from "./components/code-viewer.ts";
import type {
  PanelState,
  LayoutEls,
  ConfirmDialogState,
  ContextMenuState,
} from "./state/panel-state.ts";

import { el, copyToClipboard } from "./utils/dom.ts";
import { createActionIcon } from "./icons/action-icons.ts";
import {
  basename,
  relativePath,
  readFileContent,
  workspaceRelativePath,
  buildFileChatReference,
  resolveActiveDirectoryPath,
} from "./services/file-service.ts";
import { joinPath } from "./services/file-filter.ts";
import { isHttpRestFileName, REQUEST_FILE_EXTENSIONS, REQUEST_FILE_EXTENSION_HINT } from "./services/http-file-scan.ts";
import { directoryOf, newFileNameProblem } from "./services/file-create.ts";
import { SHARED_ENVIRONMENT_NAME } from "./services/http-env.ts";
import { subscribeGitStatus, partitionGitFiles } from "./services/git-service.ts";
import { loadChunk, releaseChunkStyles } from "./services/lazy-chunk.ts";
import { installFileIcons, refreshInstalledIcons, createFileIconNode } from "./icons/file-icons.ts";
import { renderTreeView, destroyTreeView } from "./components/tree-view.ts";
import { renderCodeViewer, disposeViewerViewport } from "./components/code-viewer.ts";
import { renderGitCommitBar, renderGitList, closeGitContextMenu } from "./components/git-view.ts";
import { renderHttpList } from "./components/http-view.ts";
import { renderHttpRequestPanel } from "./components/http-request-panel.ts";
import { createEnvironmentForm } from "./components/environment-form.ts";
import { renderHttpResult } from "./components/http-result-view.ts";
import { formValuesOfRequest } from "./services/http-serialize.ts";
import { renderGitSyncIndicator } from "./components/git-sync-indicator.ts";
import { loadViewSettings, loadDiffViewMode, loadHttpViewerMode, loadHttpEnvironment } from "./services/settings.ts";
import { ensureProjectCommands, flattenCommands } from "./services/project-commands.ts";
import { renderRunToolbar } from "./components/run-toolbar.ts";
import {
  insertChatTextWithRetry,
  normalizeEmptyChatInput,
  type ChatInputInsertStatus,
} from "./services/chat-input-service.ts";
import {
  isRightPanelFullscreen,
  exitRightPanelFullscreen,
  waitForNextFrame,
} from "./utils/panel-fullscreen.ts";
import { createPanelState, pathKey } from "./state/panel-state.ts";
import { createGitController } from "./controllers/git-controller.ts";
import { createHttpController } from "./controllers/http-controller.ts";
import { createTreeController } from "./controllers/tree-controller.ts";
import { createPreviewController } from "./controllers/preview-controller.ts";
import { createTerminalController } from "./controllers/terminal-controller.ts";

// ---------------------------------------------------------------------------
// 面板内部类型（src/index.ts 私有，不导出）
// 这些形状的真源就是本文件的 state 对象与终端记录；组件层只消费其中切片。
// 跨层已有的形状一律 import 复用（见上方 import type），此处只声明确实新增的部分。
// ---------------------------------------------------------------------------

/**
 * 一次弹窗挂进正文位置的那一块（`formBody` 槽位的元素）。
 * @description state.confirmDialog 那份形状只带标题 / 正文 / 按钮，装不下输入框，也装不下整块表单，
 *   故单独记一份；它与弹窗本体同生同灭（弹窗状态清成 null 的那几处一并清它）。
 *   同时只可能有一个弹窗开着，所以一个槽位就够。
 */
type ConfirmDialogBody = {
  /** 取消按钮文案；由调用方给，没有正文替换的确认框用渲染处的「取消」兜底。 */
  cancelLabel: string;
  /**
   * 取代正文那一块的节点。
   * @description 建一次就留着复用：面板全量重绘会连弹窗 DOM 一起重建，每次挂回同一个节点，
   *   用户刚打进去的字才不会被抹掉。
   */
  node: HTMLElement;
  /** 弹窗打开时聚焦的元素：文本弹窗是那个输入框，表单弹窗是第一个该填的框。 */
  focusTarget: HTMLElement;
  /**
   * 就地显示校验失败的那一行；只有当场要校验的弹窗才给（见 askEnvironment）。
   * @description 没给就一行都不渲染；给的时候初始必须是 hidden——错误出现之前不该占着一行空位。
   */
  errorNode?: HTMLElement;
  /**
   * 每次把弹窗画出来之后要叫一次的动作（带即时校验的弹窗用它把禁用态刷到当前那颗确认钮上）。
   * @description 输入框建一次就留着复用，所以「打字→重新判一遍」的监听只挂在输入框上；
   *   而确认钮每轮重绘都是新的一颗——两头对不上，就得由渲染处每画一次问一次调用方。
   */
  onRendered?: () => void;
};

/**
 * 弹窗在本文件里实际记的那份状态形状。
 * @description 跨层那份 ConfirmDialogState（各控制器看到的）只有标题 / 正文 / 按钮与两个回调；
 *   带表单的弹窗还要多一条「关弹窗之前先验一遍」的钩子，就在这儿加宽一层。
 *   state 上声明的仍是跨层那份，取回来用时按这一份读（见 confirmDialogAction）。
 */
type ConfirmDialogWithForm = ConfirmDialogState & {
  /**
   * 点确认 / 按 Enter 之后、关弹窗之前的校验；缺省视为通过（确认框与文本弹窗都没有它）。
   * @returns 可以关弹窗并把答复交给等待方时 true；校验没过时 false——弹窗原样留着、
   *   等待方收不到任何答复，错误由 body 的 errorNode 就地显示。
   */
  onBeforeConfirm?: () => boolean;
};

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

  // 弹窗的正文替换；只可能有一个弹窗开着，故单个槽位，见 askText / askEnvironment 与 renderConfirmDialog。
  let formBody: ConfirmDialogBody | null = null;
  // 当前那次渲染画出来的那颗「确认」钮；带即时校验的正文要靠它把禁用态刷上去（见 askText）。
  // 每次渲染先清空再按新画的那颗赋值，所以留下的不会是上一轮弹窗的按钮。
  let dialogConfirmButton: HTMLButtonElement | null = null;

  /**
   * HTTP 列表目录行右键的目标目录（相对项目根，正斜杠）与它所属的那一次菜单。
   * @description 菜单状态那份形状只认「文件」目标，目录没有可放的字段，就把目标和打开它的那个
   *   菜单对象绑在一起记：每次开菜单都是新对象，对不上号即当作没有，
   *   不会出现「右键文件树条目却弹出目录那一项」。
   */
  let httpFolderMenu: { owner: ContextMenuState; relPath: string } | null = null;

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
    previewFile: (entry) => openFileFromExplorer(entry),
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
    // 终端 / 运行的「发送到当前会话」：控制器只递文本，确认弹窗与写动作在这里。
    sendToChat: (text: string) => {
      void sendTextToChat(text);
    },
  });

  const http = createHttpController({
    state, t, api,
    isDisposed: () => disposed,
    renderHttpPane,
    renderHttpPreview,
    // 文本态刷新结果只走这条窄通道：只重建右分栏，左边的编辑区与光标原样不动。
    renderHttpResultPane: () => renderHttpResultPane(),
    previewFile: (entry) => preview.previewFile(entry),
    savePreview: async () => {
      await preview.handleSavePreview();
    },
    // 文本态没有卡片可挂进行态与结果，发送的回音与「未保存」状态走面板状态条这条既有通道。
    setStatus: (text, persistent) => setStatusText(text, persistent),
    // 换请求文件会丢掉没写盘的改动，先问一句（切项目不问：那时项目已经切过去了）。
    confirmDiscard: () =>
      askConfirm({
        title: t("http.discardTitle", "有未保存的改动"),
        message: t("http.discardMessage", "当前请求文件里还有没写盘的内容，继续就会丢掉这些改动。"),
        confirmLabel: t("http.discardConfirm", "丢弃并继续"),
      }),
    // `# @note` 是作者写给发送这一步的话，不是卡片上的装饰文字，所以发之前问一句、确认了才发。
    confirmNote: (note) =>
      askConfirm({
        title: t("http.noteTitle", "这条请求留了一句话"),
        message: note,
        confirmLabel: t("http.noteConfirm", "仍然发送"),
      }),
  });

  /**
   * 文件树统一打开入口：HTTP 请求文件复用独立 HTTP 视图的解析、表单、保存与发送链路。
   * 普通文件仍走原来的代码查看器；切走 HTTP 文件前先提交缓冲，避免文件视图覆盖未保存正文。
   */
  async function openFileFromExplorer(entry: FileTreeEntry): Promise<void> {
    if (!entry || entry.isDirectory) return;
    if (isHttpRestFileName(entry.name)) {
      const relPath = relativePath(state.rootPath, entry.path) || entry.name;
      await http.openFile({
        name: entry.name,
        path: entry.path,
        relPath,
        size: typeof entry.size === "number" ? entry.size : 0,
      });
      return;
    }
    if (isActiveHttpDocument() && http.isDirty()) await http.commit();
    await preview.previewFile(entry);
  }

  /** 当前右侧正文是否就是文件树直接打开的 HTTP 请求文件。 */
  function isActiveHttpDocument(): boolean {
    return Boolean(state.httpSelected && pathKey(state.preview.path) === pathKey(state.httpSelected));
  }

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
    // 换项目会把弹窗直接作废：等待确认的流程（如换请求文件）也要收到答复，别把 await 悬在那里。
    if (state.confirmDialog && typeof state.confirmDialog.onCancel === "function") state.confirmDialog.onCancel();
    state.confirmDialog = null;
    formBody = null;
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
    http.resetForProject();
    preview.bumpRequestIds();
    state.preview = {
      kind: "empty",
      name: "",
      path: "",
      text: "",
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
    // 切项目时 resetForProject 清空了请求文件清单，而 render 只重绘、不扫描：
    // 正停在「HTTP 请求」视图的用户会看到列表一直空着，直到手动点刷新。
    // 新根尚未扫过（scannedRootKey 已被 resetForProject 作废），这里补一次。
    if (state.mainView === "http") void http.rescan();
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

  /**
   * 面板状态条：写一行任意文案，空串即清除。
   * @description HTTP 发送这类「有过程也有结果」的动作按原样显示（发送中 / 200 OK · 12 毫秒 / 失败原因），
   *   与 setOperationStatus 的「操作成功／操作失败」措辞不同，故单开一条通道，共用同一个定时器。
   */
  function setStatusText(text: string, persistent = false) {
    state.status = text;
    renderToolbar();
    if (operationTimer) clearTimeout(operationTimer);
    operationTimer = null;
    // persistent 用于「有未保存的改动」这类必须一直挂着的状态：由后续动作显式清掉。
    if (!text || persistent) return;
    // 结果留得比「操作成功」久一点，但不常驻：用户随时可能回去改文件。
    operationTimer = setTimeout(() => {
      if (disposed) return;
      state.status = "";
      operationTimer = null;
      renderToolbar();
    }, 6000);
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

  /** 宿主运行时快照里与会话投递相关的字段（真源 snow-app `plugins/runtimeSnapshot.ts`）。 */
  type ChatRuntimeSnapshot = {
    /**
     * 输入区实时数据：仅在输入框组件挂载期间持续发布。
     * @description `conversationId` 为 null 只代表「新会话输入区尚未绑定会话」，
     *   **不能**据此判「窗口没开」（小窗口新会话就是 null）；输入框是否在位要用探针实测。
     */
    chatInput?: { conversationId?: string | null; inputText?: string | null } | null;
  };

  /** 读取宿主运行时快照；宿主不可用或异常时为 null（按「无目标」处理）。 */
  async function readChatRuntime(): Promise<ChatRuntimeSnapshot | null> {
    try {
      if (api && api.metadata && typeof api.metadata.get === "function") {
        const response = await api.metadata.get("runtime");
        const domains = ((response && (response as { domains?: Record<string, unknown> }).domains) || {});
        return (domains.runtime as ChatRuntimeSnapshot | undefined) || null;
      }
    } catch (err) {
      console.warn("[FileExplorer] 读取宿主会话运行时失败", err);
    }
    return null;
  }

  /**
   * 单按钮提示弹窗：复用确认框的遮罩 / 焦点 / 关闭机制，只给一个「知道了」。
   * 发送失败与无目标的场景都必须显式可见，不能静默（此前状态条提示太弱，用户以为功能无效）。
   */
  function askSendToChatAlert(message: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const opened = openConfirmDialog({
        title: t("action.sendToChatTitle", "发送到当前会话"),
        message,
        confirmLabel: t("action.sendToChatOk", "知道了"),
        danger: false,
        onConfirm: () => resolve(),
        onCancel: () => resolve(),
      });
      if (!opened) {
        // 已有别的弹窗在用：说明原因后放行，不悬挂等待。
        setStatusText(t("http.confirmBusy", "请先处理当前对话框"));
        resolve();
      }
    });
  }

  /**
   * 一次真实追加：服务层会在每次尝试前重新读 runtime，并按本次内容计算 appendedText。
   * @description 这里只把宿主 API 接到事务边界；不要在这里缓存输入内容或直接重试写动作。
   */
  async function insertIntoChatInput(text: string): Promise<ChatInputInsertStatus> {
    const run = api && api.write && api.write.run;
    if (typeof run !== "function") return "failed";

    return insertChatTextWithRetry(text, {
      readRuntime: readChatRuntime,
      // runtime 快照在输入区卸载后仍保留旧值；只有当前聊天输入 DOM 在位时才允许发写动作。
      isInputMounted: () => {
        return document.querySelector(
          '[data-snow-anchor="chat.input"] .input-field-editable[contenteditable="true"]',
        ) !== null;
      },
      // 宿主输入区切回聊天后，runtime 可能还留着切换前的草稿；data-empty 是宿主
      // 根据真实 contenteditable 内容发布的即时标记。空输入必须按空串追加，不能凭旧草稿补首行换行。
      readCurrentText: () => {
        const input = document.querySelector<HTMLElement>(
          '[data-snow-anchor="chat.input"] .input-field-editable[contenteditable="true"]',
        );
        if (!input) return null;
        if (input.dataset.empty === "true" || (!input.textContent && !input.innerHTML)) return "";
        return undefined;
      },
      insertText: (appendedText) => run("chatInput.insertText", { text: appendedText }),
    });
  }

  /**
   * 把一段文本填入宿主会话的输入框（**只填入，不代发**：内容由用户确认后自己发送）。
   * 流程（用户方案，统一所有场景）：
   *   ① 右面板处于全屏 → 先退出全屏，并确认 DOM 状态已经消失；
   *   ② 每次尝试先重新读取输入框，再按本次内容计算 appendedText；
   *   ③ 只有输入框未挂载/写动作失败才允许重试；已发出但 snapshot 延迟时禁止重复写入。
   * @param text 消息原文（代码选区只带正文：md 原文 / 代码围栏；终端 / 运行为原文）
   * @returns 是否成功填入
   */
  async function sendTextToChat(text: string): Promise<boolean> {
    if (!text) return false;

    // 不能先用 isRightPanelFullscreen() 决定是否调用退出：宿主 React 切换时，
    // “退出全屏”按钮的 aria-label 可能已更新，而 .fullscreen class 还没提交。
    // 退出函数本身是幂等的，必须每次都调用，让它同时覆盖两种时序。
    const exited = await exitRightPanelFullscreen();
    if (!exited || isRightPanelFullscreen()) {
      await askSendToChatAlert(
        t("action.sendToChatFullscreenFailed", "无法退出右侧全屏，内容未填入；请先退出全屏后重试。"),
      );
      return false;
    }

    const input = document.querySelector<HTMLElement>(
      '[data-snow-anchor="chat.input"] .input-field-editable[contenteditable="true"]',
    );
    if (input && normalizeEmptyChatInput(input)) {
      // 宿主的 latestValueRef 在 input 事件后下一帧才反映空串；等这一帧再发追加事件。
      await waitForNextFrame();
    }

    const status = await insertIntoChatInput(text);
    if (status === "confirmed") {
      setOperationStatus(true, t("action.sendToChatDone", "已填入会话输入框，请确认后发送"));
      return true;
    }

    if (status === "unconfirmed") {
      // 写动作可能已同步修改真实输入框，只有 runtime effect 延迟；此处绝不能再写一次。
      await askSendToChatAlert(
        t("action.sendToChatUnconfirmed", "已尝试填入，但宿主状态尚未确认；为避免重复追加，未再次写入，请检查输入框后重试。"),
      );
      return false;
    }

    await askSendToChatAlert(
      t("action.sendToChatNotOpen", "没能确认会话输入框已打开，内容未填入；请手动打开会话窗口后重试。"),
    );
    return false;
  }

  /**
   * 文件树右键「发送到对话框」只发送文件引用，不发送文件正文。
   * @description 先读取文件判定文本类型并计算行数，再把「工作区名\\相对路径 1-N」填入现有聊天输入框。
   */
  async function handleSendFileToChat(entry: FileTreeEntry): Promise<void> {
    const result = await readFileContent(entry.path);
    if (
      !result ||
      result.isBinary ||
      result.isImage ||
      typeof result.content !== "string"
    ) {
      setOperationStatus(false, "只能发送文本文件");
      return;
    }

    const reference = buildFileChatReference(state.rootPath, entry.path, result.content);
    if (!reference) {
      setOperationStatus(false, "目标路径不在当前工作区内");
      return;
    }
    await sendTextToChat(reference);
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

  function openConfirmDialog(
    dialog: ConfirmDialogWithForm,
    body: ConfirmDialogBody | null = null,
  ): boolean {
    if (state.confirmDialog) return false;
    // onCancel 也得存进状态：取消按钮、点遮罩、Escape、切项目这四条关闭路径都只认这一份状态，
    // 漏掉它等待方（askConfirm / askText / askEnvironment 的 await）就永远收不到答复。
    // 递进来的那一份整份抄下来：onBeforeConfirm 跟着状态一起走，逐个字段挑着抄就会把校验钩子抄丢。
    // danger 在这里把默认值定死（省略即危险动作）：读的人就只管看布尔值，不必各自再补一遍。
    state.confirmDialog = { ...dialog, danger: dialog.danger !== false };
    // 正文替换与弹窗本体同批写：确认框没有正文替换就是 null，占着弹窗的第二次询问
    // 也不会踩掉正在用着的那一份。
    formBody = body;
    renderConfirmDialog();
    return true;
  }

  function closeConfirmDialog() {
    if (!state.confirmDialog) return;
    const cancelled = state.confirmDialog.onCancel;
    state.confirmDialog = null;
    formBody = null;
    renderConfirmDialog();
    // 取消也要给等待方一个答复（见 askConfirm）。
    if (typeof cancelled === "function") cancelled();
  }

  /**
   * 把回调式确认框包成可 await 的一次询问。
   * @param options 标题 / 正文 / 确认按钮文案
   * @returns 用户确认时 true；取消、关闭或已有别的弹窗在用时 false
   * @description 用于「改动没保存，继续就丢」这类必须等答复才能往下走的流程。
   */
  function askConfirm(options: { title: string; message: string; confirmLabel: string }): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const opened = openConfirmDialog({
        ...options,
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
      });
      if (!opened) {
        // 已有别的弹窗在用：明确告诉用户为什么点了没反应，而不是静默什么都不做。
        setStatusText(t("http.confirmBusy", "请先处理当前对话框"));
        resolve(false);
      }
    });
  }

  /**
   * 一次文本输入弹窗：把确认框那套遮罩 / 焦点 / 关闭机制换成「标题 + 一个输入框」。
   * @param options 标题 / 输入框标签 / 占位 / 预填文本 / 两个按钮文案，外加一条可选的当场判定
   * @param options.validate 按输入框现值判这一屏能不能交出去；回一句理由就是不能交的理由。
   *   给了它，「确认」那颗钮就跟着打字禁用或放开，理由显示在输入框下面，Enter 那条路也一并堵住——
   *   先给一颗点了没用的按钮、等人敲完再报红字，等于让人白敲一遍。
   * @returns 输入框里的原文（不 trim、不代填默认值）；取消、关闭、切项目或已有别的弹窗在用时为 null
   * @description 「填了个空格」与「什么都没填」的处置并不一样，判空交给调用方，
   *   原语这里只把用户给的字符原样带回去。
   */
  function askText(options: {
    title: string;
    label: string;
    placeholder?: string;
    defaultValue?: string;
    confirmLabel: string;
    cancelLabel: string;
    validate?: (raw: string) => string | null;
  }): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      // 输入行在开弹窗之前就建好，之后只挪不换（见 ConfirmDialogBody.node）。
      const input = el("input", "sfe-confirm-field-input");
      input.type = "text";
      input.value = options.defaultValue || "";
      if (options.placeholder) input.placeholder = options.placeholder;
      const row = el("label", "sfe-confirm-field");
      row.appendChild(el("span", "sfe-confirm-field-label", options.label));
      row.appendChild(input);
      // 那一行说明只有要当场校验时才建：没话可说的弹窗不该多占一行空位。
      const errorLine = options.validate ? el("div", "sfe-confirm-error") : null;
      if (errorLine) errorLine.hidden = true;
      const problem = (): string | null => (options.validate ? options.validate(input.value) : null);
      const sync = (): void => {
        const text = problem();
        if (errorLine) {
          // 一个字都还没打的时候不把这句话喊出来：那是「还没填」，不是「填错了」，
          // 弹窗一开就先红一格骂人，等于把刚要开始填的人挡回去。「创建」按不动已经说清了这件事。
          const shown = input.value.trim() ? text : null;
          errorLine.textContent = shown || "";
          errorLine.hidden = !shown;
        }
        // 确认钮每轮重绘都是新的一颗，所以现问现取当前那一个。
        if (dialogConfirmButton) dialogConfirmButton.disabled = Boolean(text);
      };
      // 输入框建一次就留着复用，这条监听因而只挂一次；换按钮那一头由 body.onRendered 补上。
      input.addEventListener("input", sync);
      // 输入行跟着这次弹窗一起交给 openConfirmDialog：它开成才写进槽位，开不成什么都不动。
      const opened = openConfirmDialog(
        {
          title: options.title,
          message: "",
          confirmLabel: options.confirmLabel,
          danger: false,
          onBeforeConfirm: () => {
            // 按钮已经跟着打字禁用/放开了，这一条堵的是 Enter 那条不走按钮的路。
            if (!problem()) return true;
            sync();
            return false;
          },
          onConfirm: () => {
            resolve(input.value);
          },
          onCancel: () => resolve(null),
        },
        {
          cancelLabel: options.cancelLabel,
          node: row,
          focusTarget: input,
          errorNode: errorLine || undefined,
          onRendered: options.validate ? sync : undefined,
        },
      );
      if (!opened) {
        // 已有别的弹窗在用：明确告诉用户为什么点了没反应，而不是静默什么都不做。
        setStatusText(t("http.confirmBusy", "请先处理当前对话框"));
        resolve(null);
      }
    });
  }

  /**
   * 一次「修改环境」弹窗：整张表（每一段的名字与变量行）挂进确认框那套遮罩 / 焦点 / Esc / 关闭机制里，
   * 底下是「保存」「取消」两颗钮。
   * @description 这篇文件带着文件变量时，弹窗里多一个只读的「文件变量」页，环境表还是第一页：
   *   两件事都在「这个 `{{host}}` 究竟从哪儿来的」这条线上，分两个入口反而要说清谁盖谁。
   *   交回来的只有环境表那一页——文件变量这一页没有输入框，压根没有可交的东西。
   * @returns 点了保存的整张表；取消、Esc、点遮罩、切项目或已有别的弹窗在用时为 null
   * @description 打开之前先现读一遍盘：环境表是工作区里的普通文件，随时可能在外面被改过——
   *   摊开一份过期的表再整张写回，等于把别处刚加的那几段抹掉，而且这一步不留任何痕迹。
   * @description 摊开的行只取**写得回去的那一份**：只住在私密表里的项改了不顶用，摊开来等于骗人改一遍。
   * @description 取消这条路什么都不写：草稿只在保存时交出去，写哪儿去、怎么写归拿到草稿的调用方。
   * @description 校验不过就不关弹窗：新加的那一段名字撞了或没填，要能就地改了再点一次保存，
   *   而不是弹窗一关、什么也没发生。
   */
  async function askEnvironmentTables(): Promise<HttpEnvironmentDraft[] | null> {
    await http.reloadEnvironment();
    const summary = http.environmentSummary();
    // `$shared` 提到最前：它是所有环境的公共底，摆在第一段才看得清谁覆盖了谁。
    // 比较器只认这一条先后，其余返回 0——排序是稳定的，别的段保持读到的原顺序。
    const sections = [...summary.publicTables.entries()]
      .sort((a, b) => {
        if (a[0] === SHARED_ENVIRONMENT_NAME) return -1;
        if (b[0] === SHARED_ENVIRONMENT_NAME) return 1;
        return 0;
      })
      .map(([name, table]) => ({
        name,
        variables: [...table.entries()].map(([key, value]) => ({ key, value })),
      }));
    const form = createEnvironmentForm({
      t,
      sections,
      takenNames: [...summary.names, SHARED_ENVIRONMENT_NAME],
      privateKeys: summary.privateKeys,
      // 这篇文件的文件变量摊到第二页只念：它们住在正文里，改了不生效的原因一句话在这儿说不清，
      // 但「为什么这个值不来自环境」必须在同一个弹窗里答得上来。
      fileVariables: (state.httpFile?.variables || []).map((variable) => ({ name: variable.name, value: variable.value })),
    });
    // 错误那一行也建一次就留着：重绘只把它挪回弹窗，刚说的那句原因不会跟着重绘一起消失。
    const errorLine = el("div", "sfe-confirm-error");
    errorLine.hidden = true;
    // 校验先过一遍，草稿留在这个变量里；等弹窗真关掉了才由 onConfirm 交出去，
    // 「关弹窗」与「答复等待方」这两件事就不挤在同一个回调里抢先后。
    let saved: HttpEnvironmentDraft[] | null = null;
    return new Promise<HttpEnvironmentDraft[] | null>((resolve) => {
      const opened = openConfirmDialog(
        {
          title: t("http.envDialogTitle", "修改环境"),
          message: "",
          confirmLabel: t("action.save", "保存"),
          danger: false,
          onBeforeConfirm: () => {
            const result = form.collect();
            if (result.error !== undefined) {
              errorLine.textContent = result.error;
              errorLine.hidden = false;
              // 出错的那段已被组件切到眼前：焦点直送拦下来的那一格，改完直接就能再点保存。
              (result.offender || form.focusTarget).focus();
              return false;
            }
            saved = result.tables;
            return true;
          },
          onConfirm: () => resolve(saved),
          onCancel: () => resolve(null),
        },
        {
          cancelLabel: t("action.cancel", "取消"),
          node: form.node,
          focusTarget: form.focusTarget,
          errorNode: errorLine,
        },
      );
      if (!opened) {
        // 已有别的弹窗在用：明确告诉用户为什么点了没反应，而不是静默什么都不做。
        setStatusText(t("http.confirmBusy", "请先处理当前对话框"));
        resolve(null);
      }
    });
  }

  async function confirmDialogAction() {
    // 记进状态的那一份按本文件的形状读：跨层那份装不下 onBeforeConfirm。
    const dialog = state.confirmDialog as ConfirmDialogWithForm | null;
    if (!dialog) return;

    // 先问校验：没过就什么都不动——弹窗留着、等待方也收不到答复，错误那一行由正文自己显示。
    if (dialog.onBeforeConfirm && !dialog.onBeforeConfirm()) return;

    state.confirmDialog = null;
    formBody = null;
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
    // 这一轮还没画出确认钮；带校验的正文要的「当前那颗」从这里取，所以先把上一颗的清掉。
    dialogConfirmButton = null;

    const confirmState = state.confirmDialog;
    if (!confirmState) return;
    // 正文替换由调用方随本次弹窗一起放好；确认框那一路永远是 null，正文照旧。
    const body = formBody;

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
      } else if (event.key === "Enter" && (body || event.target === dialog)) {
        // 正文里有输入框时 Enter 就等于点确认（创建环境那一路就是点保存）；
        // 确认框没正文替换，维持原样——焦点在弹窗本体上才算数。
        event.preventDefault();
        void confirmDialogAction();
      }
    });

    const title = el("h2", "sfe-confirm-title", confirmState.title);
    // 右上角一颗 ❌：跟 Esc、点遮罩同一条取消路，光靠键盘快捷键关弹窗不算人人都会。
    const closeButton = el("button", "sfe-confirm-close");
    closeButton.type = "button";
    closeButton.title = t("dialog.close", "关闭");
    closeButton.setAttribute("aria-label", closeButton.title);
    closeButton.appendChild(createActionIcon("close", 14));
    closeButton.addEventListener("click", closeConfirmDialog);
    const actions = el("div", "sfe-confirm-actions");
    const cancelButton = el("button", "sfe-confirm-button", (body && body.cancelLabel) || t("action.cancel", "取消"));
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
    dialogConfirmButton = confirmButton;

    // 统一保持“取消 → 确认动作”的顺序，危险动作通过 danger 样式强调。
    actions.appendChild(cancelButton);
    actions.appendChild(confirmButton);
    dialog.appendChild(title);
    dialog.appendChild(closeButton);
    if (body) {
      // 调用方给的整块正文取代 message。节点建一次就留着复用：面板全量重绘会连弹窗 DOM 一起重建，
      // 换新元素等于把用户刚打进去的字抹掉。
      dialog.appendChild(body.node);
      // 校验错误那一行：只在有正文替换、且调用方给了错误位的弹窗里出现，
      // 没有错误时它一直 hidden，不占位置。
      if (body.errorNode) dialog.appendChild(body.errorNode);
    } else {
      dialog.appendChild(el("p", "sfe-confirm-message", confirmState.message));
    }
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    root.appendChild(overlay);
    // 正文要刷的就是这一颗：画一次问一次，重绘换了按钮也不用重新挂监听。
    if (body && body.onRendered) body.onRendered();

    setTimeout(() => {
      if (!disposed && dialog.isConnected) {
        // 带正文替换的弹窗打开就落在它给的元素上（输入框 / 环境名），直接就能打字；
        // 确认框没有正文替换，焦点照旧留在弹窗本体。
        if (body) body.focusTarget.focus();
        else dialog.focus();
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
    // 忙碌或已有确认弹窗时不弹菜单：菜单会盖在遮罩之上，点进去只会撞上「请先处理当前对话框」。
    // 闸门放在这里，所有入口（文件树 / Git / HTTP 列表 / 空白区）自动一致。
    if (state.operationBusy || state.confirmDialog) {
      state.contextMenu = null;
      return;
    }

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

    // 选项画完必须挂上菜单并按视口夹住位置：任何分支提前 return 前都得先走这一步，
    // 否则菜单建在内存里、屏幕上什么都没有，用户看到的就只是「右键没反应」。
    const showMenu = () => {
      root.appendChild(menu);
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const rect = menu.getBoundingClientRect();
      const left = Math.max(4, Math.min(context.x, viewportWidth ? viewportWidth - rect.width - 4 : context.x));
      const top = Math.max(4, Math.min(context.y, viewportHeight ? viewportHeight - rect.height - 4 : context.y));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    };

    // HTTP 请求文件行的右键菜单：与文件树/Git 列表对等的那几项。
    // 不复用下面的 entry 分支：「打开文件」在那边走的是文件树通道，会与当前主视图对不上。
    const httpFile = context.httpFile;
    if (httpFile) {
      addItem(
        t("action.openFile", "打开文件"),
        () => {
          closeContextMenu();
          void http.openFile(httpFile);
        },
        disabled,
      );
      separator();
      addItem(
        t("action.revealInExplorer", "在资源管理器中打开"),
        () => handleRevealInExplorer({ path: httpFile.path }),
        disabled,
      );
      separator();
      addItem(
        t("action.refresh", "刷新"),
        () => {
          closeContextMenu();
          void http.rescan({ force: true });
        },
        disabled,
      );
      addItem(t("action.copyPath", "复制路径"), () => copyPathText(httpFile.path), disabled);
      addItem(
        t("action.copyRelativePath", "复制相对路径"),
        () => {
          const value = workspaceRelativePath(state.rootPath, httpFile.path);
          if (value == null) setOperationStatus(false, "目标路径不在当前工作区内");
          else void copyPathText(value);
        },
        disabled,
      );
      showMenu();
      return;
    }

    // HTTP 列表目录行的右键菜单：只有「在这个目录里新建请求文件」这一项。
    // 目录不是文件树条目（列表来自整仓扫描），下面那几条分支的动作都是按文件树的条目办事的，套不上。
    const folderMenu = httpFolderMenu && httpFolderMenu.owner === context ? httpFolderMenu : null;
    if (folderMenu) {
      const relPath = folderMenu.relPath;
      addItem(
        t("http.newRequestFile", "新建请求文件"),
        () => {
          closeContextMenu();
          void createRequestFileIn(relPath);
        },
        disabled,
      );
      showMenu();
      return;
    }

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
          // 忽略开关直接决定请求文件清单该不该含被忽略项：先作废缓存的扫描根，
          // 正停在 HTTP 视图就立刻重扫，否则等下次进入该视图时再扫。
          http.invalidateScan();
          void tree.toggleViewSetting("respectGitignore").then(() => {
            if (state.mainView === "http") void http.rescan({ force: true });
          });
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
      // 空白区右键：无具体条目，仅提供工作区级操作（新建文件 / 刷新 / 打开工作区 / 复制工作区路径）
      addItem(
        t("action.newFile", "新建文件"),
        () => {
          closeContextMenu();
          void createPlainFileIn(state.rootPath);
        },
        disabled || !state.rootPath,
      );
      separator();
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
      // 刷新放在复制路径之前；删除是危险操作，单独隔离在普通文件操作之外。
      addItem(t("action.refresh", "刷新"), () => handleRefresh(), disabled);
      addItem(t("action.copyPath", "复制路径"), () => copyPathText(entry.path), disabled);
      addItem(
        t("action.copyRelativePath", "复制相对路径"),
        () => {
          const value = workspaceRelativePath(state.rootPath, entry.path);
          if (value == null) setOperationStatus(false, "目标路径不在当前工作区内");
          else void copyPathText(value);
        },
        disabled,
      );
      // 文件右键的发送入口只放在文件分支；目录菜单不提供该动作。
      if (!entry.isDirectory) {
        addItem(
          t("action.sendToChat", "发送到对话框"),
          () => {
            closeContextMenu();
            void handleSendFileToChat(entry);
          },
          disabled,
        );
      }
      separator();
      // 「新建文件」要跟着人刚点的那一处，只有右键空白区（没有那一项）才退回项目根。
      addItem(
        t("action.newFile", "新建文件"),
        () => {
          closeContextMenu();
          const directory = entry.isDirectory ? entry.path : tree.parentDirectoryPath(entry.path);
          void createPlainFileIn(directory || state.rootPath);
        },
        disabled,
      );
      separator();
      addItem(t("action.rename", "重命名"), () => beginRename(entry), disabled);
      separator();
      addItem(t("action.delete", "删除"), () => tree.handleDelete(entry), disabled);
      separator();
      appendViewToggles(disabled);
    }

    showMenu();
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
        // HTTP 请求视图里发送就在每条请求上点，顶栏这套运行控件在这里没有落点，整组收起。
        if (state.mainView === "http") return { commands: [] as FlatRunCommand[], ready: true, isCommandRunning: () => false };
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
    // 顶部主视图三选一：文件 / Git 变更 / HTTP 请求（必有其一激活，不可都关）。
    const sidebarTop = el("div", "sfe-sidebar-top");
    sidebar.appendChild(sidebarTop);
    const fileViewBtn = sidebarBtn(sidebarTop, "folderOpen", t("sidebar.files", "文件"), () => switchMainView("files"));
    const gitViewBtn = sidebarBtn(sidebarTop, "folderGit2", t("sidebar.git", "Git 变更"), () => switchMainView("git"));
    const httpViewBtn = sidebarBtn(sidebarTop, "globe", t("sidebar.http", "REST 请求"), () => switchMainView("http"));
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
      httpViewBtn,
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
      httpPane: null,
      httpPreviewPane: null,
    };
    return layoutEls;
  }

  /**
   * 切换主视图（文件 / Git 变更 / HTTP 请求）——三选一，必有其一激活，不可都关。
   * @description 手动切换后仅改 state.mainView 并重建主视图；mainView 不持久化，
   *   每次重新打开面板从「文件」开始。
   * @param view 目标主视图；"files" / "git" / "http" 之一
   */
  async function switchMainView(view: PanelState["mainView"]) {
    if (disposed || (view !== "files" && view !== "git" && view !== "http")) return;
    if (state.mainView === view) return;
    // 离开 HTTP 视图前先把缓冲里的改动落盘：它是「焦点移开就写回」的延伸——
    // 正文缓冲会被别的视图的预览覆盖，等切回来时原文已经找不回来了。
    if ((state.mainView === "http" || isActiveHttpDocument()) && view !== "http") await http.commit();
    if (disposed) return;
    state.mainView = view;
    if (view === "git") {
      // 每次重新进入 Git 都恢复已暂存区的默认折叠；用户上一次手动展开不跨视图复用。
      git.resetStagedCollapse();
    }
    if (view === "files") {
      // 离开 Git 变更视图：清空查看器状态，否则再切回时会残留上次打开的比对。
      state.gitPreview = null;
      state.gitSelected = null;
    }
    if (view === "http") http.syncWithSelection();
    render();
    // 每次进入 Git 都刷新一次，确保 resetStagedCollapse 能按本次最新状态重建默认折叠。
    if (view === "git") await git.refreshGitViewStatus();
    // 首次进入 HTTP 请求视图时扫一遍工作区的请求文件（同根只扫一次）。
    if (view === "http") await http.rescan();
  }

  /** 同步左侧入口栏选中态与运行中圆点。 */
  function syncSidebar() {
    if (!layoutEls) return;
    if (layoutEls.fileViewBtn) layoutEls.fileViewBtn.classList.toggle("active", state.mainView === "files");
    if (layoutEls.gitViewBtn) layoutEls.gitViewBtn.classList.toggle("active", state.mainView === "git");
    if (layoutEls.httpViewBtn) layoutEls.httpViewBtn.classList.toggle("active", state.mainView === "http");
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
    layoutEls!.httpPane = null;
    layoutEls!.httpPreviewPane = null;

    if (state.mainView === "git") {
      buildGitView(mainView);
      renderGitPane();
      renderGitPreview();
      syncGitIndicator();
      return;
    }
    if (state.mainView === "http") {
      buildHttpView(mainView);
      renderHttpPane();
      renderHttpPreview();
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
        onSelectFile: (entry) => openFileFromExplorer(entry),
        onContextMenu: handleContextMenu,
        onOpenFileEdit: (entry) => openFileFromExplorer(entry),
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
      head.addEventListener("click", () => {
        if (isHttpRestFileName(result.name)) {
          // 搜索结果没有可靠的请求块定位；HTTP 文件打开后交给 GUI/文本切换器处理。
          void openFileFromExplorer(result);
          return;
        }
        void preview.handleSearchResultOpen(result);
      });
      row.appendChild(head);
      // 内容匹配行：点击直接跳转到对应行号。
      for (const match of result.lineMatches || []) {
        const lineEl = el("div", "sfe-search-result-line");
        lineEl.title = `${result.path}:${match.line}`;
        lineEl.appendChild(el("span", "sfe-search-line-no", String(match.line)));
        lineEl.appendChild(el("span", "sfe-search-line-text", match.text || ""));
        lineEl.addEventListener("click", () => {
          if (isHttpRestFileName(result.name)) {
            // HTTP 文本行可能是请求体或注释，不能把普通代码行号硬套到请求 GUI。
            void openFileFromExplorer(result);
            return;
          }
          void preview.handleSearchResultOpen(result, match.line);
        });
        row.appendChild(lineEl);
      }
      list.appendChild(row);
    }
    parent.appendChild(list);
  }

  // 局部：普通文件预览（代码查看器本体，落点由调用方给）
  function drawCodeViewer(pane: HTMLElement | null) {
    if (disposed || !pane) return;
    const inHttpView = state.mainView === "http" || isActiveHttpDocument();
    renderCodeViewer(pane, {
      preview: state.preview,
      rootPath: state.rootPath,
      copied: state.copied,
      onCopy: () => preview.handleCopyCode(),
      onSetMode: (mode) => preview.setPreviewMode(mode),
      onToggleEdit: (next) => preview.setPreviewEditable(next),
      onEditInput: (value) => {
        preview.handlePreviewInput(value);
        // 只有 HTTP 视图把「正文动过」记进自己的脏标记，文件视图的保存节奏一字不改。
        if (inHttpView) http.markDirty();
      },
      // HTTP 视图里的保存（工具栏按钮）与失焦写盘走同一条路：脏标记只有控制器能清，
      // 直连保存通道会留下一个清不掉的假「未保存」。文件视图的节奏一字不改。
      onSave: inHttpView ? () => void http.commit() : () => preview.handleSavePreview(),
      onEditBlur: inHttpView ? () => void http.commit() : undefined,
      onRevealFile: () => preview.handlePreviewRevealFile(),
      onCopyPath: () => preview.handlePreviewCopyPath(),
      onCopyRelativePath: () => preview.handlePreviewCopyRelativePath(),
      // 右键“发送到当前会话”：查看器只发送选区正文；
      // 文件右键的文件引用走独立的 handleSendFileToChat。
      onSendToChat: (message: string) => {
        void sendTextToChat(message);
      },
      onRefresh: () => preview.handlePreviewRefresh(),
      // 运行入口：代码查看器需要完整源码 main 列表，顶栏仍使用过滤后的可见命令列表。
      runCommands: () => flattenCommands(state.projectCommands, { includeHidden: true }),
      // 右键「运行」分组的上限：与顶栏下拉同一份列表，菜单不得多出顶栏没有的命令。
      runMenuCommands: () => mergeRunCommands(flattenCommands(state.projectCommands), state.manualScriptCommands),
      onRunCommand: (command) => terminal.handleRunCommand(command),
      // HTTP 请求文件：每条请求那一行的行号槽给一个 ▶，点了就发这一条（同 package.json 的 scripts）。
      gutterMarkers: inHttpView
        ? () =>
            http
              .runMarkers()
              .map((marker) => ({
                line: marker.line,
                title: `${t("http.runRequest", "发送此请求")}: ${marker.title}`,
                onRun: () => void http.send(marker.index),
              }))
        : undefined,
      editable: state.preview.editable === true,
      saving: state.preview.saveState === "saving",
      // HTTP 视图没选文件时右侧也是这块查看器，空态要给一句「点左边」而不是一片白。
      emptyHint: inHttpView ? t("http.previewHint", "点击左侧的请求文件查看内容") : undefined,
      t,
    });
  }

  // 局部：普通文件预览。HTTP 请求文件无论从独立列表还是文件树打开，都落到同一套请求查看器。
  function renderPreview() {
    if (disposed || !layoutEls) return;
    if (state.mainView === "http" || isActiveHttpDocument()) {
      renderHttpPreview();
      return;
    }
    // 同一个 state.preview 通道，落点随主视图走。
    drawCodeViewer(layoutEls.previewPane);
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
      // Git 控制器在进入视图前会重置集合；状态尚未拉取时仍传空集合，组件永不消费 null。
      collapsedStaged: state.collapsedStaged || new Set(),
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

  // 构建 HTTP 请求视图骨架（左列表 + 右查看器）
  function buildHttpView(mainView: HTMLElement) {
    const httpPane = el("div", "sfe-http-pane");
    // 空白区右键：与文件树同一套工作区级菜单兜底，否则浏览器原生菜单会冒出来。
    httpPane.addEventListener("contextmenu", (event) => {
      const target = event.target as Element | null;
      if (target && typeof target.closest === "function" && target.closest(".sfe-http-row")) return;
      event.preventDefault();
      state.contextMenu = { entry: null, x: event.clientX, y: event.clientY };
      renderContextMenu();
    });
    mainView.appendChild(httpPane);
    layoutEls!.httpPane = httpPane;

    // 查看器与文件视图共用 state.preview 通道（请求文件首先是文本文件），
    // 因此这里另给一个容器，让 renderPreview 按 mainView 选落点。
    const httpPreviewPane = el("div", "sfe-preview-pane");
    mainView.appendChild(httpPreviewPane);
    layoutEls!.httpPreviewPane = httpPreviewPane;
  }

  /**
   * 「新建请求文件」该落在哪一层：跟着刚点的那一处——列表里当前选中的那个请求文件所在的那个目录。
   * @returns 相对项目根的路径（正斜杠）；空串表示项目根
   * @description 一个文件都没选中（刚打开项目、或选中的就是根下那几个）才退回项目根。
   */
  function selectedRequestFileDirectory(): string {
    const selected = state.httpSelected;
    if (!selected) return "";
    const rel = relativePath(state.rootPath, selected);
    if (!rel || rel === ".") return "";
    return directoryOf(rel);
  }

  /**
   * 「新建请求文件」两颗入口共用的流程：问名字 → 取消或空名就不建 → 剩下的整个交给控制器。
   * @param relPath 目标目录相对项目根的路径（正斜杠）；空串表示项目根。
   * @description 落点跟着名字一起显示在弹窗里（「文件名 · api」）：建错了当场就看得见，
   *   不用等文件出现在列表里才发现建错了地方。
   * @description 目录在不在项目根以内、名字合不合法、缺扩展名补什么、有没有撞名，都由
   *   http.createRequestFile 判定并在状态条上说清，这里不重说一遍，成功也不补一句「已创建」——
   *   文件到底建没建出来只有它知道。
   */
  async function createRequestFileIn(relPath: string) {
    const answer = await askText({
      title: t("http.newFileTitle", "新建请求文件"),
      label: `${t("http.newFileLabel", "文件名")} · ${relPath || t("action.newFileAtRoot", "项目根")}`,
      placeholder: t("http.newFilePlaceholder", "例如 users.http"),
      confirmLabel: t("http.createConfirm", "创建"),
      cancelLabel: t("action.cancel", "取消"),
      // 名字空着、带路径字符、或写了名单外的扩展名，「创建」就一直是暗的：这一类入口只建请求文件。
      validate: (raw: string) =>
        newFileNameProblem(t, raw, REQUEST_FILE_EXTENSIONS, REQUEST_FILE_EXTENSION_HINT),
    });
    // 取消（null）与只填了空白都算「没说要建」：什么都不建，也不留任何话。
    if (answer === null) return;
    const name = answer.trim();
    if (!name) return;
    const directory = relPath ? joinPath(state.rootPath, relPath) : state.rootPath;
    await http.createRequestFile(directory, name);
  }

  /**
   * 文件树「新建文件」的流程：问名字 → 取消或只填空白就不建 → 剩下的整个交给树控制器。
   * @param directoryPath 目标目录绝对路径（右键那个目录；右键文件就是它所在的那个目录；空白区就是项目根）
   * @description 这一路不收扩展名名单：代码编辑器要建的是 `.ts` / `.json` / `Dockerfile` 这一类名字，
   *   只有请求文件那一类才按扫描认的名单判。位置在不在项目根以内、名字合不合法、有没有撞名，
   *   都由写文件那一层判并在状态条说清，这里不重说一遍，成功也不补一句「已创建」——
   *   文件到底建没建出来只有那边知道。
   */
  async function createPlainFileIn(directoryPath: string) {
    const rel = relativePath(state.rootPath, directoryPath);
    const answer = await askText({
      title: t("action.newFile", "新建文件"),
      label: `${t("action.newFileLabel", "文件名")} · ${!rel || rel === "." ? t("action.newFileAtRoot", "项目根") : rel}`,
      placeholder: t("action.newFilePlaceholder", "例如 config.json"),
      confirmLabel: t("action.create", "创建"),
      cancelLabel: t("action.cancel", "取消"),
      validate: (raw: string) => newFileNameProblem(t, raw),
    });
    if (answer === null) return;
    const name = answer.trim();
    if (!name) return;
    await tree.createFileIn(directoryPath, name);
  }

  // 局部：请求文件列表
  function renderHttpPane() {
    if (disposed || !layoutEls || !layoutEls.httpPane) return;
    renderHttpList(layoutEls.httpPane, {
      files: state.httpFiles,
      scanning: state.httpScanning,
      truncated: state.httpTruncated,
      failedCount: state.httpScanFailed,
      selectedPath: state.httpSelected,
      collapsed: state.httpCollapsed,
      onOpenFile: (file) => {
        void http.openFile(file);
      },
      onToggleCollapse: (relPath) => http.toggleCollapse(relPath),
      onRefresh: () => {
        void http.rescan({ force: true });
      },
      // 工具条新建：落点跟着刚点的那一处——当前选中那个请求文件所在的目录，没选中才回项目根。
      onCreateRequestFile: () => void createRequestFileIn(selectedRequestFileDirectory()),
      // 右键：与文件树/Git 列表同一套菜单通道（定位 + 目标），选项见 renderContextMenu 的 httpFile 分支。
      onContextMenu: (file, event) => {
        state.contextMenu = { entry: null, httpFile: file, x: event.clientX, y: event.clientY };
        renderContextMenu();
      },
      // 目录行右键：菜单走同一条通道，但那一个目录记在 httpFolderMenu 里（那份状态没有放目录的字段）。
      onFolderContextMenu: (node, event) => {
        const menu: ContextMenuState = { entry: null, x: event.clientX, y: event.clientY };
        state.contextMenu = menu;
        httpFolderMenu = { owner: menu, relPath: node.relPath };
        renderContextMenu();
      },
      t,
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

  // 构建「GUI / 文本」分段控件（工具栏用，与 Git 的「差异 / 内容」同款外观：图标 + 文字）
  function buildHttpViewSwitch(current: HttpViewerMode) {
    const switcher = el("div", "sfe-md-mode-switch-inline");
    switcher.setAttribute("role", "group");
    const segments = [
      { key: "gui", icon: "gui", label: t("http.modeGui", "GUI") },
      { key: "text", icon: "code", label: t("http.modeText", "文本") },
    ] as const;
    for (const seg of segments) {
      const isActive = seg.key === current;
      const btn = el("button", "sfe-md-mode-btn" + (isActive ? " active" : ""));
      btn.type = "button";
      btn.title = seg.label;
      btn.setAttribute("aria-label", seg.label);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      btn.appendChild(createActionIcon(seg.icon, 13));
      // 与 Git 那组一样带上文字：只画图标的控件，用户得先猜 Rows3 是「GUI」还是「分栏」。
      btn.appendChild(el("span", "sfe-md-mode-label", seg.label));
      if (!isActive) btn.addEventListener("click", () => http.setMode(seg.key));
      switcher.appendChild(btn);
    }
    return switcher;
  }

  // 同步工具栏中的「GUI / 文本」切换：独立 HTTP 视图和文件树直接打开请求文件都可用。
  function renderHttpViewSwitchInToolbar() {
    if (!layoutEls || !layoutEls.gitViewSwitchWrap) return;
    const wrap = layoutEls.gitViewSwitchWrap;
    // 与 Git 的切换共用容器：同一时刻只可能有一个视图需要它。
    const terminalOwnsRight = state.toolDock === "right" && (state.bottomView === "run" || state.bottomView === "terminal");
    const httpDocumentOpen = state.mainView === "http" || isActiveHttpDocument();
    if (!httpDocumentOpen || !state.httpFile || !isRightPanelFullscreen() || terminalOwnsRight) {
      // 与 Git 分支同规矩：隐藏时把旧节点清掉，否则每次渲染都往这个共用容器里续一批不可见按钮。
      if (wrap.firstChild) wrap.replaceChildren();
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    wrap.replaceChildren(buildHttpViewSwitch(state.httpMode));
  }

  // 局部：HTTP 右侧查看器（GUI 卡片 / 文本＝这篇文件的代码查看器）。
  // 文件树直接打开时复用普通预览槽，独立 HTTP 视图则使用自己的右侧槽。
  function renderHttpPreview() {
    if (disposed || !layoutEls) return;
    const pane = state.mainView === "http" ? layoutEls.httpPreviewPane : layoutEls.previewPane;
    if (!pane) return;
    // 上一轮若是文本态，左分栏里挂过查看器的虚拟列表与视口观察者：容器马上要被换掉，
    // 先断开它们，否则每次切形态都会漏一份（观察者会拖住整块可视行与闭包里的全文）。
    disposeViewerViewport(pane.querySelector<HTMLElement>(".sfe-http-text-code"));
    if (state.httpMode === "gui" && state.httpFile) {
      renderHttpRequestPanel(pane, {
        file: state.httpFile,
        getForm: (index) => {
          const stored = state.httpForms.get(index);
          if (stored) return stored;
          const request = state.httpFile ? state.httpFile.requests[index] : null;
          // 表单与解析结果不同源时（刚重扫过）按当前请求摊一份初值，而不是把 undefined 递进组件。
          return request ? formValuesOfRequest(request) : { method: "GET", url: "", headers: [], body: null };
        },
        responses: state.httpResponses,
        runningIndex: state.httpRunning,
        expanded: state.httpExpanded,
        collapsedBodies: state.httpBodyCollapsed,
        onToggle: (key) => http.toggleExpand(key),
        onToggleBody: (index, open) => http.setRequestBodyOpen(index, open),
        dirty: http.isDirty(),
        // 保存走控制器：它才知道「保存成功要清脏标记」这件事（直连保存通道会留下
        // 一个清不掉的假「未保存」，直到切文件）。
        onSave: () => void http.commit(),
        onReload: () => void http.discardChanges(),
        onFormChange: (index, values) => http.handleFormChange(index, values),
        onCommit: () => void http.commit(),
        onSend: (index) => void http.send(index),
        onPromptChange: (index, name, value) => http.handlePromptChange(index, name, value),
        getPromptValue: (index, name) => http.promptValue(index, name),
        environment: http.environmentSummary(),
        onEnvironmentChange: (name) => void http.setEnvironment(name),
        // 一颗钮管整张表：弹窗、现读、落盘都在这条路上，面板自己不算要写什么，名字与值只在弹窗里改。
        onManageEnvironments: async () => {
          const tables = await askEnvironmentTables();
          if (tables) await http.saveEnvironmentTables(tables);
        },
        // 文件变量那一排默认收起，折叠钮在环境那一行右侧（开合只重画面板，不碰磁盘也不动缓冲）。
        variablesCollapsed: state.httpVariablesCollapsed,
        onToggleVariables: () => void http.toggleVariablesCollapsed(),
        t,
      });
      renderHttpViewSwitchInToolbar();
      return;
    }
    // 文本态就是这篇文件本来的代码查看器（行号、高亮、复制、右键菜单一个不少），
    // 只多了行号槽上的 ▶ 与「失焦即存盘」；重读文件之后也要停在编辑态。
    // 右侧再分一栏摆「请求体 + 响应」：请求与响应要同屏对照，和 Git 的分栏比对是同一个理由。
    // 文本态没有别的地方放结果，不分栏就只能靠跳去 GUI 看，那正是之前「点了没反应」的来源。
    if (state.httpMode === "text") http.ensureEditable();
    // 代码模式：没发过请求时不给右分栏——空着摆一块「点 ▶ 发送」的占位纯属碍眼，
    // 代码查看器独占整幅宽度。发出请求后（httpResultIndex 非空）才分出右栏摆结果。
    if (http.resultIndex() === null) {
      const codeOnly = el("div", "sfe-http-text-code");
      pane.replaceChildren(codeOnly);
      drawCodeViewer(codeOnly);
      renderHttpViewSwitchInToolbar();
      return;
    }
    const split = el("div", "sfe-http-text-split");
    const codePane = el("div", "sfe-http-text-code");
    const resultPane = el("div", "sfe-http-text-result");
    split.appendChild(codePane);
    split.appendChild(resultPane);
    pane.replaceChildren(split);
    drawCodeViewer(codePane);
    renderHttpResultPane(resultPane);
    renderHttpViewSwitchInToolbar();
  }

  /**
   * 渲染文本态右分栏：最近一次发送的请求体与响应。
   * @param host 目标容器；缺省时按当前布局里的右分栏找
   * @description 只重建这一栏。发送期间与发送完成后都只刷这里，
   *   左边的代码编辑区（含光标、选区、滚动位置）一动不动。
   */
  function renderHttpResultPane(host?: HTMLElement | null) {
    if (disposed) return;
    const previewPane =
      layoutEls && (state.mainView === "http" ? layoutEls.httpPreviewPane : layoutEls.previewPane);
    const target = host || (previewPane ? previewPane.querySelector<HTMLElement>(".sfe-http-text-result") : null);
    if (!target) return;
    target.replaceChildren();
    const index = http.resultIndex();
    const result = index === null ? null : state.httpResponses.get(index);
    if (index === null || !result) {
      target.appendChild(
        el("div", "sfe-http-empty", t("http.resultHint", "点左边行号上的 ▶ 发送，请求体和响应会显示在这里"))
      );
      return;
    }
    const request = state.httpFile ? state.httpFile.requests[index] : null;
    const name = request ? request.title || request.name || request.url : "";
    target.appendChild(
      el("div", "sfe-http-result-title", `${t("http.requestN", "请求 {{n}}", { n: index + 1 })}${name ? ` · ${name}` : ""}`)
    );
    renderHttpResult(target, result, t);
  }

  // 局部：按当前视图刷新「正在使用的」查看器（复制按钮反馈用）
  function renderActiveViewer() {
    if (state.mainView === "git") renderGitPreview();
    else if (state.mainView === "http") renderHttpPreview();
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
    const [initialRoot, viewSettings, diffMode, httpMode, httpEnvironment, commitMode, toolDock] = await Promise.all([
      resolveRoot(),
      loadViewSettings(api),
      loadDiffViewMode(api),
      loadHttpViewerMode(api),
      loadHttpEnvironment(api),
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
    state.httpMode = httpMode;
    // 上次选中的环境先落到状态里；环境表本身要等打开某个请求文件时按那个文件的目录去读。
    http.restoreEnvironment(httpEnvironment);
    render();
    if (state.rootPath) {
      // 根目录此刻才就绪（resolveRoot 是异步 IPC，侧边栏按钮早在 renderChrome 里建好了）：
      // 用户若在这段空窗里点过「HTTP 请求」，那次 rescan 会因 rootPath 还是空串被跳过，
      // 而 render 只重绘不扫描——列表会一直空着，直到先切去文件视图再切回来。
      // 这里按当前视图补一次；rescan 对「同根且非扫描中」自会短路，不会重复跑。
      if (state.mainView === "http") void http.rescan();
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
    // HTTP 文本态把同一个代码查看器画在自己的查看器面板上，这块也得断：漏掉它观察者与
    // 虚拟列表会随每次重载插件线性累积。
    disposeViewerViewport(layoutEls && layoutEls.httpPreviewPane);
    // 文本态现在把查看器嵌在左右分栏的左栏里，挂载状态（__sfeVList / 观察者）也在那一层，
    // 只断外层面板会漏掉它。
    disposeViewerViewport(
      layoutEls && layoutEls.httpPreviewPane
        ? layoutEls.httpPreviewPane.querySelector<HTMLElement>(".sfe-http-text-code")
        : null
    );
    // 两个工具窗口控制器随面板销毁（xterm 实例与监听一起释放）。
    terminal.releaseWindows();
    // 随懒块注入的样式随插件一起摘除，不在宿主 head 里留残留（重挂载时 loadChunk 会重新注入）。
    releaseChunkStyles();
    container.replaceChildren();
  };
}

// 默认导出与命名导出双重兼容
export default { mount };
