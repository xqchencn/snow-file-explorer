/**
 * Snow App 文件浏览器插件 (renderMode: "esm")
 * 模块化顶层入口：协调文件服务、Git 状态、目录树视图与代码预览器
 */

import { el, copyToClipboard } from "./utils/dom.js";
import { createActionIcon } from "./icons/action-icons.js";
import {
  basename,
  sortEntries,
  readDirectoryEntries,
  readFileContent,
  writeFileContent,
  renameFileSystemEntry,
  deleteFileSystemEntry,
  relativePath,
  resolveActiveDirectoryPath,
  detectJvmProject,
} from "./services/file-service.js";
import {
  subscribeGitStatus,
  getRelativeGitPath,
  getGitStatus,
  partitionGitFiles,
  gitStatusSignature,
  collectGitFolderPaths,
} from "./services/git-service.js";
import { shouldVirtualize } from "./components/highlight-policy.js";
import { loadChunk } from "./services/lazy-chunk.js";
import { installFileIcons, refreshInstalledIcons } from "./icons/file-icons.js";
import { mapPool } from "./utils/async.js";
import { renderTreeView, paintTreeGitStatus } from "./components/tree-view.js";
import { loadJvmPackageTree } from "./services/java-project.js";
import { renderCodeViewer } from "./components/code-viewer.js";
import { renderGitCommitBar, renderGitList, closeGitContextMenu } from "./components/git-view.js";
import { renderGitSyncIndicator } from "./components/git-sync-indicator.js";
import {
  isMarkdownPath,
  normalizePath,
  resolveMarkdownAssetPath,
  readImageAsDataUrl,
} from "./services/markdown-asset.js";
import {
  filterExcludedEntries,
  parseGitignore,
  isExcludedMeta,
  isIgnoredByRules,
  joinPath,
} from "./services/file-filter.js";
import {
  loadViewSettings,
  saveViewSettings,
  loadDiffViewMode,
  saveDiffViewMode,
} from "./services/settings.js";
import {
  gitStage,
  gitUnstage,
  gitStageAll,
  gitUnstageAll,
  gitCommit,
  gitPush,
  gitSync,
  gitDiscardChanges,
  gitFileDiff,
  generateCommitMessage,
  abortCommitMessage,
} from "./services/git-actions.js";
import { parseUnifiedDiff } from "./services/diff.js";
import { ensureProjectCommands, flattenCommands } from "./services/project-commands.js";
import {
  createPtySession,
  isTerminalAvailable,
  resolveRunShell,
  resolveScriptShell,
  DEFAULT_COLS,
  DEFAULT_ROWS,
} from "./services/terminal-runner.js";
import { renderToolWindow } from "./components/tool-window.js";
import { renderRunToolbar } from "./components/run-toolbar.js";

/**
 * 当前面板根目录的规范化键（小写 + 去尾部分隔符）
 * @description 宿主在 Windows 可能返回反斜杠路径，比较前统一大小写与分隔符。
 * @param {string} p 路径
 * @returns {string}
 */
function pathKey(p) {
  return normalizePath(p || "").toLowerCase().replace(/[/\\]+$/, "");
}

/**
 * 触发宿主右面板全屏模式切换
 * @description 宿主全屏按钮 className 恒为 "icon-btn ghost right-panel-fullscreen-btn"，
 *   全屏状态由 .right-panel.fullscreen / .app-shell.right-panel-fullscreen 承载。
 * @returns {boolean} 是否成功触发
 */
function requestRightPanelFullscreen() {
  const btn = document.querySelector(".right-panel-fullscreen-btn");
  if (btn && typeof btn.click === "function") {
    btn.click();
    return true;
  }
  return false;
}

/**
 * 判断宿主右侧面板是否处于全屏态
 * @description 宿主全屏状态由 .right-panel.fullscreen / .app-shell.right-panel-fullscreen 承载。
 * @returns {boolean}
 */
function isRightPanelFullscreen() {
  return !!document.querySelector(".right-panel.fullscreen, .app-shell.right-panel-fullscreen");
}

/**
 * 等待浏览器完成下一帧渲染。
 * @returns {Promise<void>}
 */
function waitForNextFrame() {
  return new Promise((resolve) => {
    if (
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function"
    ) {
      window.requestAnimationFrame(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * 确保宿主右侧面板进入全屏。
 * @description 宿主全屏状态由 React 异步更新，点击按钮后必须等待 DOM class 更新并确认结果。
 * @returns {Promise<boolean>} 是否已进入全屏
 */
async function ensureRightPanelFullscreen() {
  if (isRightPanelFullscreen()) return true;
  if (!requestRightPanelFullscreen()) return false;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await waitForNextFrame();
    if (isRightPanelFullscreen()) return true;
  }

  return false;
}

/**
 * 插件主挂载入口
 * @param {HTMLElement} container 挂载目标容器
 * @param {Object} api Snow App 注入的插件运行时 API
 * @param {Object} [options] 额外宿主挂载参数（保留签名兼容，插件不自建多项目会话）
 * @returns {Function} 清理卸载函数
 */
export function mount(container, api, _options = {}) {
  let disposed = false;
  let copiedTimer = null;
  let operationTimer = null;
  let gitDebounceTimer = null;
  let previewRequestId = 0;
  let saveRequestId = 0;
  // 终端创建令牌：终端在 pty 建好前被关闭时，用它作废「迟到」的创建结果，避免泄漏孤儿进程。
  let terminalToken = 0;
  // 底部工具窗口控制器（renderToolWindow 的返回值）。两个窗口各自常驻、互斥显示：
  //   terminalWindow = 交互终端窗口；runWindow = 运行窗口。各自持有自己的 xterm 实例，切换不丢输出。
  let terminalWindow = null;
  let runWindow = null;
  // 工具栏运行控件控制器（renderRunToolbar 的返回值）。
  let runToolbar = null;
  // 顶栏同步指示器控制器（renderGitSyncIndicator 的返回值）。
  let gitSyncIndicator = null;
  // 图标块、运行 shell、Git 状态在一次面板生命周期内复用，避免重复解析和重复请求。
  let iconsPromise = null;
  let runShellPromise = null;
  let gitInflight = null;
  let gitInflightRoot = "";

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
   * 树出现之后再做图标回填、JVM 识别和 Git 状态。
   * 右上角运行识别等这三件事都结束再开始，识别完再预载终端块。
   * @param {Array} rootEntries 刚刚列到的根目录条目
   */
  function scheduleStartupFollowups(rootEntries) {
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
          refreshJavaProject(root, rootEntries),
          refreshGitAll(),
        ]);
      } catch (err) {
        console.warn("[FileExplorer] 启动后续任务失败", err);
      }
      if (disposed || token !== startupToken || pathKey(state.rootPath) !== rootToken) return;
      try {
        await ensureCommands();
      } catch (err) {
        console.warn("[FileExplorer] 项目命令识别失败", err);
      }
      if (disposed || token !== startupToken || pathKey(state.rootPath) !== rootToken) return;
      // 识别已经结束：解析 xterm，并提前确定运行命令要用的 shell。
      // 否则点击运行后要先等 detectTerminals，PowerShell 才会启动。
      void cachedRunShell();
      void loadChunk("terminal").catch((err) => {
        console.warn("[FileExplorer] 终端组件预载失败", err);
      });
    })();
  }

  /** xterm 在终端块里。工具窗口允许工厂返回 Promise，输出会先暂存。 */
  function createLazyTerminalView(host, opts) {
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

  // 翻译：api.t 不可用时回退到 defaultValue
  const t = (key, fallback, values) => {
    if (api && typeof api.t === "function") {
      return api.t(key, { defaultValue: fallback, values });
    }
    return fallback;
  };

  const state = {
    rootPath: "",
    rootNodes: null,
    javaProject: null,
    // 项目识别与终端：projectCommands 为懒加载的识别结果（含 rootPath 缓存键）；
    // terminals 为终端集合（IDEA 式多 tab：一个终端一个 tab），activeTerminalId 标记当前 tab。
    projectCommands: null,
    // 脚本命令（bat/sh/ps1）默认不进顶栏 Run 下拉；只有用户手动点过文件行内 ▶ 才临时登记在此。
    manualScriptCommands: [],
    terminals: [],
    // 终端窗口（mode B）的激活 tab。
    activeTerminalId: null,
    // 运行窗口（mode A）的激活 tab（与 activeTerminalId 分开：两个窗口各自维护激活项）。
    activeRunTerminalId: null,
    // 底部当前显示哪个工具窗口：null=收起 | "terminal" | "run"；由左侧竖排入口栏切换。
    bottomView: null,
    // 终端 / 运行窗口的停靠：bottom 底栏 | right 右侧（与代码预览同侧）。两个窗口共用。
    toolDock: "bottom",
    // 主视图：始终二选一 —— "files"（文件树）/ "git"（Git 变更）；由左侧入口栏顶部切换，不可都关。
    mainView: "files",
    expanded: Object.create(null),
    selected: null,
    status: "",
    copied: false,
    gitStatusMap: Object.create(null),
    // 视图开关（默认开启）与多层 .gitignore 规则
    viewSettings: {
      excludeMeta: true,
      respectGitignore: true,
      javaPackageView: true,
    },
    gitignoreRules: [],
    gitignoreFullyLoaded: false,
    gitignoreLoadedDirs: new Set(),
    contextMenu: null,
    confirmDialog: null,
    operationBusy: false,
    // Git 变更视图状态
    gitStatus: null,
    gitCommitMessage: "",
    gitBusy: null,
    // 同步按钮的进行态：与 gitBusy 区分，负责远端 pull / 本地 push 的完整同步链路
    gitSyncBusy: null,
    gitGenerating: false,
    gitStreamId: null,
    gitSelected: null,
    // Git 变更视图右侧文件查看器状态（双击文件行后加载）
    gitPreview: null,
    // 差异展示模式（unified / split）；差异范围固定显示完整文件
    diffMode: "unified",
    gitCommitMode: "commit",
    gitCommitMenuOpen: false,
    // 首次加载仓库时，已暂存目录默认折叠；null 表示尚未初始化默认状态。
    // 初始化后只响应用户自己的折叠/展开操作，不因 Git watcher 刷新而覆盖。
    collapsedStaged: null,
    collapsedUnstaged: new Set(),
    preview: {
      kind: "empty",
      name: "",
      path: "",
      text: "",
      highlightedHtml: "",
      // Markdown 专用字段
      isMarkdown: false,
      mode: "preview", // 预览模式（默认）| code 模式
      html: "", // 已净化的 Markdown HTML
      editable: false,
      saveState: "idle",
      saveMessage: "",
    },
  };

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
  async function applyActiveProject(nextPath, { force = false } = {}) {
    if (disposed) return;
    const next = nextPath || "";
    if (!force && pathKey(next) === pathKey(state.rootPath)) return;
    state.rootPath = next;
    state.rootNodes = null;
    state.javaProject = null;
    // 切换项目：先终止上一项目的全部终端（避免残留「看不见的进程」），再清空识别缓存与终端状态。
    killAllTerminals();
    if (terminalWindow && typeof terminalWindow.dispose === "function") terminalWindow.dispose();
    if (runWindow && typeof runWindow.dispose === "function") runWindow.dispose();
    state.projectCommands = null;
    state.manualScriptCommands = [];
    runShellPromise = null;
    state.terminals = [];
    state.activeTerminalId = null;
    state.activeRunTerminalId = null;
    state.bottomView = null;
    terminalWindow = null;
    runWindow = null;
    // 运行控件随新项目重建（命令集合必然变化）。
    if (runToolbar && typeof runToolbar.dispose === "function") runToolbar.dispose();
    runToolbar = null;
    // 同步指示器状态随新项目刷新（getState 读 state，控制器可复用，无需销毁）。
    state.expanded = Object.create(null);
    state.selected = null;
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
    previewRequestId++;
    saveRequestId++;
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
      state.status = "";
      renderToolbar();
      return;
    }
    // 先列出根目录。图标、JVM 和 Git 在树出现之后补；运行识别再等它们结束。
    await loadRoot({ followups: true });
  }

  // 刷新 JVM 项目识别结果：与目录树并行，避免阻塞 Git 状态刷新。
  // 结果保存在状态中，后续 JVM 包视图直接复用，不在渲染层重复扫描。
  async function refreshJavaProject(projectPath, knownEntries) {
    if (disposed || !state.rootPath) return;
    const path = projectPath || state.rootPath;
    const detected = await detectJvmProject(path, knownEntries);
    // 异步检测期间可能已切换项目，过期结果不能写回当前状态。
    if (disposed || pathKey(path) !== pathKey(state.rootPath)) return;
    state.javaProject = detected;
  }

  // 刷新当前面板：显式刷新会重扫忽略规则；打开面板和窗口聚焦不走这里。
  async function refreshAll() {
    if (disposed || !state.rootPath) return;
    await reloadGitignore();
    if (disposed) return;
    await Promise.all([loadRoot(), refreshJavaProject(), refreshGitAll()]);
  }

  // 2. 拉取 Git 状态（文件树染色与变更列表共用同一次 gitStatus）
  // 同源短路：内容未变化时跳过 render。render 会整体 replaceChildren 重建 DOM，
  // 从而销毁滚动位置与文本选区（表现为「一滑就弹回顶部 / 无法选中复制」）。
  function isSameGitMap(a, b) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (a[key] !== b[key]) return false;
    }
    return true;
  }

  async function refreshGitViewStatus() {
    await refreshGitAll();
  }

  function gitStatusToMap(status) {
    const map = Object.create(null);
    if (status && Array.isArray(status.files)) {
      for (const item of status.files) {
        if (!item || !item.path) continue;
        map[item.path.replace(/\\/g, "/")] = item.status;
      }
    }
    return map;
  }

  function applyGitStatus(status) {
    const map = gitStatusToMap(status);
    const prevSig = gitStatusSignature(state.gitStatus);
    const nextSig = gitStatusSignature(status);
    state.gitStatus = status;
    if (state.collapsedStaged === null && status && status.isRepo) {
      const { staged } = partitionGitFiles(status.files);
      state.collapsedStaged = collectGitFolderPaths(staged);
    }
    const mapChanged = !isSameGitMap(state.gitStatusMap, map);
    if (mapChanged) state.gitStatusMap = map;
    if (prevSig === nextSig && prevSig !== "" && !mapChanged) return;
    if (mapChanged && state.mainView === "files") {
      paintTreeGitStatus(layoutEls && layoutEls.treePane, {
        rootPath: state.rootPath,
        gitStatusMap: state.gitStatusMap,
        t,
      });
    }
    syncGitIndicator();
    if (state.mainView === "git" && prevSig !== nextSig) renderGitPane();
  }

  // 统一的 Git 刷新：同一次 snow.gitStatus 同时更新染色、变更列表和同步栏。
  async function refreshGitAll() {
    if (!state.rootPath || disposed) return;
    const root = state.rootPath;
    const rootToken = pathKey(root);
    if (!gitInflight || gitInflightRoot !== rootToken) {
      gitInflightRoot = rootToken;
      const request = getGitStatus(root).finally(() => {
        if (gitInflight === request) gitInflight = null;
      });
      gitInflight = request;
    }
    const status = await gitInflight;
    if (disposed || pathKey(state.rootPath) !== rootToken) return;
    applyGitStatus(status);
  }

  // ------------------------------------------------------------------
  // Git 变更视图操作
  // ------------------------------------------------------------------
  // Git 写操作队列：串行执行，忙时入队而非丢弃。
  // 旧实现 `if (state.gitBusy) return null` 会静默吞掉忙碌期的点击（表现为「点了没反应 /
  // 要等一会 / 得先点别处」）；排队后连点会依次执行，且不会并发写同一仓库。
  const gitActionQueue = [];
  let gitActionRunning = false;

  /** 串行排空队列；每个操作执行前后同步提交栏 / 底栏的忙碌态。 */
  async function drainGitActions() {
    if (gitActionRunning) return;
    gitActionRunning = true;
    try {
      while (gitActionQueue.length && !disposed) {
        const { busy, fn } = gitActionQueue.shift();
        state.gitBusy = busy;
        renderGitPaneCommit();
        syncGitIndicator();
        try {
          await fn();
        } catch (err) {
          console.warn("[FileExplorer] Git 操作失败:", err);
        }
      }
    } finally {
      gitActionRunning = false;
      if (!disposed) {
        state.gitBusy = null;
        renderGitPaneCommit();
        syncGitIndicator();
      }
    }
  }

  /**
   * 执行一个 Git 写操作（忙时入队，串行执行，不丢用户点击）。
   * @param {string} busy 进行中的操作名（用于提交栏 / 底栏忙碌态）
   * @param {Function} fn 实际写操作（内部自行 refresh）
   * @returns {Promise<void>}
   */
  function runGitAction(busy, fn) {
    gitActionQueue.push({ busy, fn });
    return drainGitActions();
  }

  function handleStageToggle(files, section) {
    if (!state.rootPath || !Array.isArray(files) || files.length === 0) return;
    const paths = files.map((f) => f.path);
    const isStaged = section === "staged";
    runGitAction(isStaged ? "unstage" : "stage", async () => {
      const res = isStaged
        ? await gitUnstage(state.rootPath, paths)
        : await gitStage(state.rootPath, paths);
      if (res && res.success) state.gitSelected = null;
      await refreshGitAll();
    });
  }

  function handleStageAll() {
    if (!state.rootPath) return;
    runGitAction("stageAll", async () => {
      await gitStageAll(state.rootPath);
      state.gitSelected = null;
      await refreshGitAll();
    });
  }

  function handleUnstageAll() {
    if (!state.rootPath) return;
    runGitAction("unstageAll", async () => {
      await gitUnstageAll(state.rootPath);
      state.gitSelected = null;
      await refreshGitAll();
    });
  }

  function handleCommit() {
    const message = String(state.gitCommitMessage || "").trim();
    if (!state.rootPath || !message) return;
    state.gitCommitMenuOpen = false;
    runGitAction("commit", async () => {
      const res = await gitCommit(state.rootPath, message);
      if (res && res.success) state.gitCommitMessage = "";
      await refreshGitAll();
    });
  }

  // 提交并推送：提交成功后按当前上游/分支推送
  function handleCommitAndPush() {
    const message = String(state.gitCommitMessage || "").trim();
    if (!state.rootPath || !message) return;
    state.gitCommitMenuOpen = false;
    const status = state.gitStatus || {};
    const branch = status.currentBranch || "";
    const remote = status.upstream ? String(status.upstream).split("/")[0] : undefined;
    runGitAction("commitAndPush", async () => {
      const res = await gitCommit(state.rootPath, message);
      if (!res || !res.success) return;
      state.gitCommitMessage = "";
      state.gitBusy = "push";
      renderGitPaneCommit();
      syncGitIndicator();
      await gitPush(state.rootPath, remote, branch || undefined, !status.upstream);
      await refreshGitAll();
    });
  }

  // 同步：顶栏文件夹名右侧的同步指示器点击触发（pull → 刷新 → push）。
  // 切换分支 / 逐条拉取推送已移除（宿主内置 Git 面板已提供，插件不再重复）。
  async function handleSync() {
    if (state.gitSyncBusy || state.gitBusy || disposed || !state.rootPath) return;
    state.gitSyncBusy = "sync";
    syncGitIndicator();
    try {
      const status = state.gitStatus || (await getGitStatus(state.rootPath));
      const result = await gitSync(state.rootPath, status, async () => {
        await refreshGitAll();
        return state.gitStatus;
      });
      if (!result.success) {
        console.warn("[FileExplorer] Git 同步失败:", result.message);
        return;
      }

      await refreshGitAll();
      await loadRoot();
    } catch (err) {
      console.warn("[FileExplorer] Git 同步异常:", err);
    } finally {
      if (!disposed) {
        state.gitSyncBusy = null;
        syncGitIndicator();
      }
    }
  }

  // 设置提交按钮模式（提交 / 提交并推送），并持久化
  function handleSetCommitMode(mode) {
    state.gitCommitMode = mode === "commitAndPush" ? "commitAndPush" : "commit";
    state.gitCommitMenuOpen = false;
    try {
      api.storage && typeof api.storage.setJson === "function" &&
        api.storage.setJson("gitCommitMode", state.gitCommitMode);
    } catch {
      // 忽略持久化失败
    }
    renderGitPaneCommit();
  }

  // 折叠/展开 Git 树的目录
  function handleToggleGitCollapse(section, path) {
    const set = section === "staged" ? state.collapsedStaged : state.collapsedUnstaged;
    if (set.has(path)) set.delete(path);
    else set.add(path);
    renderGitPane();
  }

  // 丢弃改动：需用户确认（破坏性操作）
  function handleDiscard(files) {
    if (!state.rootPath || !Array.isArray(files) || files.length === 0) return;
    const label =
      files.length === 1
        ? files[0].path
        : t("git.discardCount", "{{count}} 个文件", { count: files.length });
    openConfirmDialog({
      title: t("git.discardFile", "丢弃更改"),
      message: t("git.discardConfirm", "确定丢弃这些文件的更改？此操作不可撤销。\n{{label}}", { label }),
      confirmLabel: t("git.discardFile", "丢弃更改"),
      onConfirm: async () => {
        const paths = files.map((f) => f.path);
        await runGitAction("discard", async () => {
          await gitDiscardChanges(state.rootPath, paths);
          state.gitSelected = null;
          await refreshGitAll();
        });
      },
    });
  }

  /**
   * 打开 Git 变更文件的差异视图（右侧面板）
   * @description 数据层完全复用宿主 gitFileDiff（内部执行 git diff），插件只负责渲染；
   *   section 决定取暂存区（--cached）还是工作区差异，与宿主 Git 面板双击行为一致。
   * @param {Object} file GitFileStatus
   * @param {'staged'|'unstaged'} section 文件所在分区
   */
  async function openGitDiff(file, section) {
    if (!file || !state.rootPath) return;
    const isStaged = section === "staged";
    const relPath = file.path;
    const absPath = joinPath(state.rootPath, relPath);
    const key = `${section}:${relPath}`;

    // 终端占着右侧时先让回底栏，差异才能画到代码那一列。
    yieldRightDockToCode();
    // 与文件管理器（previewFile）一致：非全屏时自动全屏，右侧才能展开查看器
    if (!isRightPanelFullscreen()) {
      requestRightPanelFullscreen();
    }

    // 先渲染加载态，避免右侧空白（「差异 / 内容」切换在工具栏，见 renderGitViewSwitchInToolbar）
    state.gitPreview = {
      key,
      name: basename(relPath),
      relPath,
      absPath,
      section,
      isStaged,
      mode: "diff",
      diff: { loading: true, result: null, error: "" },
      file: null,
    };
    renderGitPreview();

    await loadGitPreviewDiff({ key, relPath, absPath, isStaged });
  }

  // 拉取并解析指定文件的 Git 差异（含工作区完整内容），供打开与右键刷新复用。
  // 过期结果（切换了文件 / 已卸载）在内部丢弃，调用方无需重复校验。
  async function loadGitPreviewDiff({ key, relPath, absPath, isStaged }) {
    const [diffRes, fileRes] = await Promise.all([
      gitFileDiff(state.rootPath, relPath, isStaged),
      readFileContent(absPath),
    ]);
    if (disposed || !state.gitPreview || state.gitPreview.key !== key) return;

    // 工作区全文用来把未改动行补回差异视图，打开后看到的是整份文件。
    const fullContent = typeof fileRes?.content === "string" && !fileRes.isBinary && !fileRes.isImage
      ? fileRes.content
      : null;
    const diff = { loading: false, result: null, fullContent, error: "" };
    if (!diffRes) {
      diff.error = t("git.diffUnavailable", "无法读取差异");
    } else if (diffRes.error) {
      diff.error = String(diffRes.error);
    } else {
      diff.result = parseUnifiedDiff(diffRes.content);
      if (diffRes.isBinary) diff.result.isBinary = true;
    }

    state.gitPreview = {
      ...state.gitPreview,
      diff,
    };
    renderGitPreview();
  }

  // Git 差异查看器右键「刷新」：重新拉取差异与工作区完整内容（该视图天然只读）。
  async function handleGitPreviewRefresh() {
    const gp = state.gitPreview;
    // 空态（未打开文件）没有具体差异可刷：回落到刷新左侧变更列表与状态，而不是空操作。
    if (!gp || !gp.absPath) {
      await refreshGitAll();
      return;
    }
    state.gitPreview = { ...gp, diff: { loading: true, result: null, error: "" } };
    renderGitPreview();
    await loadGitPreviewDiff(gp);
  }

  // 切换右侧文件查看器的「差异 / 内容」子视图
  function setGitPreviewMode(mode) {
    if (!state.gitPreview) return;
    const next = mode === "content" ? "content" : "diff";
    if (state.gitPreview.mode === next) return;
    const key = state.gitPreview.key;
    state.gitPreview = { ...state.gitPreview, mode: next };
    renderGitPreview();
    if (next !== "content") return;
    const existing = state.gitPreview.file;
    if (existing && existing.kind === "text") {
      if (existing.isMarkdown && existing.mode === "preview") void hydrateGitMarkdown(key);
      return;
    }
    void loadGitPreviewFile(key);
  }

  async function loadGitPreviewFile(key) {
    const gp = state.gitPreview;
    if (!gp || gp.key !== key || !gp.absPath) return;
    state.gitPreview = {
      ...gp,
      file: { kind: "loading", name: gp.name, path: gp.absPath },
    };
    renderGitPreview();
    const fileRes = await readFileContent(gp.absPath);
    if (disposed || !state.gitPreview || state.gitPreview.key !== key) return;
    const file = buildFilePreview({ name: gp.name, path: gp.absPath }, fileRes);
    state.gitPreview = { ...state.gitPreview, file };
    renderGitPreview();
    if (file.kind === "text" && file.isMarkdown && file.mode === "preview") {
      await hydrateGitMarkdown(key);
    }
  }

  async function hydrateGitMarkdown(key) {
    const gp = state.gitPreview;
    const file = gp && gp.file;
    if (!file || gp.key !== key || !file.isMarkdown || file.mode !== "preview") return;
    if (shouldVirtualize(file.text)) {
      state.gitPreview = { ...state.gitPreview, file: { ...file, mode: "code" } };
      renderGitPreview();
      return;
    }
    const mod = await loadChunk("markdown");
    if (disposed || !state.gitPreview || state.gitPreview.key !== key || !state.gitPreview.file) return;
    if (!mod || typeof mod.renderMarkdownHtml !== "function") return;
    state.gitPreview = {
      ...state.gitPreview,
      file: { ...state.gitPreview.file, html: mod.renderMarkdownHtml(state.gitPreview.file.text || "") },
    };
    renderGitPreview();
    inlineMarkdownImages(state.gitPreview.file.path);
  }

  // 切换差异展示模式（unified / split），持久化偏好并仅重绘右侧查看器
  function setDiffMode(mode) {
    const next = mode === "split" ? "split" : "unified";
    if (state.diffMode === next) return;
    state.diffMode = next;
    saveDiffViewMode(api, next);
    renderGitPreview();
  }

  // 差异范围固定为完整文件，不提供范围切换。


  // 将 Git 变更视图的文件状态映射为 code-viewer 的 preview 结构
  function gitPreviewView() {
    const gp = state.gitPreview;
    if (!gp) return null;
    const base = gp.file || { kind: "loading", name: gp.name, path: gp.absPath };
    return {
      ...base,
      diff: gp.diff,
      text: gp.diff?.fullContent ?? base.text,
      gitView: gp.mode,
      diffMode: state.diffMode,
    };
  }

  // 生成 / 中止提交信息
  function handleGenerateCommitMessage() {
    if (!state.rootPath) return;
    if (state.gitGenerating) {
      if (state.gitStreamId) abortCommitMessage(state.gitStreamId);
      return;
    }
    state.gitGenerating = true;
    state.gitCommitMessage = "";
    renderGitPaneCommit();
    const repo = state.rootPath;
    generateCommitMessage(
      repo,
      (chunk) => {
        if (disposed) return;
        if (chunk && chunk.contentDelta) {
          state.gitCommitMessage += chunk.contentDelta;
          updateCommitInput();
        }
      },
      (streamId) => {
        state.gitStreamId = streamId;
      }
    )
      .then((result) => {
        if (disposed) return;
        if (result && result.status !== "error" && result.content) {
          state.gitCommitMessage = result.content;
        }
      })
      .catch(() => {
        // 出错/取消：保留已流式生成的内容
      })
      .finally(() => {
        if (disposed) return;
        state.gitGenerating = false;
        state.gitStreamId = null;
        renderGitPaneCommit();
      });
  }

  // 仅更新提交输入框内容，避免整体重建打断输入
  function updateCommitInput() {
    const ta = container.querySelector(".sfe-git-commit-input");
    if (ta) ta.value = state.gitCommitMessage;
  }

  // 过滤选项：同一个 .gitignore 开关同时控制 Git 元数据与 .gitignore 命中项
  function viewFilterOpts() {
    const filterEnabled = state.viewSettings.respectGitignore;
    return {
      excludeMeta: filterEnabled,
      useGitignore: filterEnabled,
      gitignoreRules: state.gitignoreRules,
    };
  }

  /**
   * 加载目录的直接子节点；JVM 源码根目录只在用户展开时构造包树。
   * @param {Object} entry 要展开的真实目录条目
   * @returns {Promise<void>}
   */
  async function loadDirectoryChildren(entry) {
    const filtered = (entries) =>
      sortEntries(filterExcludedEntries(entries, state.rootPath, viewFilterOpts()));
    const isJvmSourceRoot =
      state.viewSettings.javaPackageView &&
      state.javaProject &&
      Array.isArray(state.javaProject.sourceRoots) &&
      state.javaProject.sourceRoots.some((root) => pathKey(root) === pathKey(entry.path));

    if (isJvmSourceRoot) {
      const sub = await readDirectoryEntries(entry.path);
      await appendGitignoreFromEntries(entry.path, sub);
      entry.children = await loadJvmPackageTree(entry.path, filtered);
      entry.isJavaSourceRoot = true;
      return;
    }

    const sub = await readDirectoryEntries(entry.path);
    await appendGitignoreFromEntries(entry.path, sub);
    entry.children = filtered(sub);
  }

  /**
   * 递归收集仓库内所有 .gitignore 规则（浅层在前、深层在后，深层覆盖浅层）
   * @description 与 git 语义一致：每层目录的 .gitignore 相对于自身生效。
   *   扫描时对已被忽略 / 元数据目录剪枝，避免进入 node_modules 等海量目录。
   * @param {string} dir 当前扫描目录绝对路径
   * @param {Array} rules 规则累加器
   */
  async function collectGitignoreRules(dir, inherited) {
    if (disposed) return [];
    let entries;
    try {
      entries = await readDirectoryEntries(dir);
    } catch {
      return [];
    }
    const own = [];
    const base = getRelativeGitPath(dir, state.rootPath);
    const gitignoreEntry = entries.find((e) => e && e.name === ".gitignore" && !e.isDirectory);
    if (gitignoreEntry) {
      const res = await readFileContent(gitignoreEntry.path);
      if (res && !res.isBinary && typeof res.content === "string") {
        own.push(...parseGitignore(res.content, base));
      }
    }
    const rulesHere = inherited.concat(own);
    const children = entries.filter((e) => {
      if (!e || !e.isDirectory) return false;
      if (isExcludedMeta(e.name)) return false;
      const rel = getRelativeGitPath(e.path, state.rootPath);
      return !(rel && isIgnoredByRules(rel, true, rulesHere));
    });
    const nested = await mapPool(children, 8, (child) => collectGitignoreRules(child.path, rulesHere));
    const rules = own.slice();
    for (const list of nested) {
      if (Array.isArray(list)) rules.push(...list);
    }
    return rules;
  }

  // 打开目录时补上这一层的 .gitignore。父目录的规则已经在更早的展开里读过。
  async function appendGitignoreFromEntries(dir, entries) {
    if (state.gitignoreFullyLoaded) return;
    const key = pathKey(dir);
    if (state.gitignoreLoadedDirs.has(key)) return;
    state.gitignoreLoadedDirs.add(key);
    if (!Array.isArray(entries)) return;
    const gitignoreEntry = entries.find((entry) => entry && entry.name === ".gitignore" && !entry.isDirectory);
    if (!gitignoreEntry) return;
    const root = state.rootPath;
    let res;
    try {
      res = await readFileContent(gitignoreEntry.path);
    } catch {
      return;
    }
    if (disposed || state.gitignoreFullyLoaded || pathKey(root) !== pathKey(state.rootPath)) return;
    if (!res || res.isBinary || typeof res.content !== "string") return;
    const own = parseGitignore(res.content, getRelativeGitPath(dir, state.rootPath));
    if (own.length) state.gitignoreRules = state.gitignoreRules.concat(own);
  }

  // 显式刷新时重走整仓 .gitignore。打开面板只读根上的那一个文件。
  async function reloadGitignore() {
    if (!state.rootPath) {
      state.gitignoreRules = [];
      state.gitignoreFullyLoaded = false;
      return;
    }
    const root = state.rootPath;
    const rules = await collectGitignoreRules(root, []);
    if (disposed || pathKey(root) !== pathKey(state.rootPath)) return;
    state.gitignoreRules = rules;
    state.gitignoreFullyLoaded = true;
  }

  // 切换视图开关：持久化后重新加载数据（入口：文件树右键菜单的勾选项）
  async function toggleViewSetting(key) {
    state.viewSettings = { ...state.viewSettings, [key]: !state.viewSettings[key] };
    saveViewSettings(api, state.viewSettings);
    if (key === "respectGitignore") await reloadGitignore();
    if (key === "javaPackageView") {
      // 普通目录树与 Java 虚拟包树的 children 结构不同，必须从根重新加载。
      state.expanded = Object.create(null);
      await loadRoot();
      return;
    }
    await loadRoot();
  }

  // 3. 加载根目录
  async function loadRoot({ followups = false } = {}) {
    if (!state.rootPath) {
      state.status = "";
      renderToolbar();
      renderTree();
      return;
    }
    const root = state.rootPath;
    state.status = t("status.loading", "加载中…");
    renderToolbar();
    try {
      const entries = await readDirectoryEntries(root);
      if (disposed || pathKey(root) !== pathKey(state.rootPath)) return;
      await appendGitignoreFromEntries(root, entries);
      if (disposed || pathKey(root) !== pathKey(state.rootPath)) return;
      state.rootNodes = sortEntries(filterExcludedEntries(entries, root, viewFilterOpts()));
      state.status = "";
      renderToolbar();
      renderTree();
      if (followups) scheduleStartupFollowups(entries);
    } catch {
      if (disposed || pathKey(root) !== pathKey(state.rootPath)) return;
      state.rootNodes = [];
      state.status = t("error.readRoot", "无法读取根目录");
      renderToolbar();
      renderTree();
    }
  }

  // 4. 切换文件夹展开与收起
  async function toggleDir(entry) {
    const next = !state.expanded[entry.path];
    state.expanded[entry.path] = next;
    if (next && !Array.isArray(entry.children)) {
      try {
        await loadDirectoryChildren(entry);
      } catch {
        // JVM 包树失败时保持普通目录可用，当前节点显示为空而不是冒泡到 UI。
        entry.children = [];
      }
    }
    renderTree();
  }

  // 目录打开只负责展开，不把已经展开的目录误切换回收起状态。
  async function openDirectory(entry) {
    if (!entry || !entry.isDirectory || state.operationBusy) return;
    if (!state.expanded[entry.path]) {
      state.expanded[entry.path] = true;
      if (!Array.isArray(entry.children)) {
        try {
          await loadDirectoryChildren(entry);
        } catch {
          entry.children = [];
        }
      }
      renderTree();
    }
    closeContextMenu();
  }

  function parentDirectoryPath(filePath) {
    const normalized = String(filePath || "").replace(/[\\/]+$/, "");
    const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
    if (index < 0) return "";
    if (index === 2 && /^[A-Za-z]:/.test(normalized)) return normalized.slice(0, 3);
    return normalized.slice(0, index) || normalized.slice(0, 1);
  }

  function findTreeEntry(nodes, targetPath) {
    if (!Array.isArray(nodes)) return null;
    for (const entry of nodes) {
      if (entry && pathKey(entry.path) === pathKey(targetPath)) return entry;
      const nested = entry && findTreeEntry(entry.children, targetPath);
      if (nested) return nested;
    }
    return null;
  }

  async function refreshFileTreeAfterMutation() {
    const expandedPaths = Object.keys(state.expanded).filter((path) => state.expanded[path]);
    await loadRoot();
    for (const path of expandedPaths) {
      const entry = findTreeEntry(state.rootNodes, path);
      if (!entry || !entry.isDirectory) {
        delete state.expanded[path];
        continue;
      }
      try {
        await loadDirectoryChildren(entry);
      } catch {
        entry.children = [];
      }
    }
    renderTree();
  }

  function remapPath(path, oldPath, newPath) {
    if (!path) return path;
    const currentKey = pathKey(path);
    const oldKey = pathKey(oldPath);
    if (currentKey === oldKey) return newPath;
    const normalizedPath = normalizePath(path);
    const normalizedOld = normalizePath(oldPath).replace(/[/\\]+$/, "");
    if (!normalizedPath.toLowerCase().startsWith(oldKey + "/")) return path;
    return newPath + normalizedPath.slice(normalizedOld.length);
  }

  function remapStatePaths(oldPath, newPath) {
    const expanded = Object.create(null);
    for (const path of Object.keys(state.expanded)) {
      expanded[remapPath(path, oldPath, newPath)] = state.expanded[path];
    }
    state.expanded = expanded;
    state.selected = remapPath(state.selected, oldPath, newPath);
    if (state.preview && state.preview.path) {
      state.preview.path = remapPath(state.preview.path, oldPath, newPath);
      state.preview.name = basename(state.preview.path);
    }
  }

  function setOperationStatus(ok, error = "") {
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

  async function runSystemWriteAction(actionId, params) {
    const run = api && api.write && api.write.run;
    if (typeof run !== "function") {
      return { ok: false, error: "当前宿主未提供系统操作能力" };
    }
    try {
      const result = await run(`system.${actionId}`, params);
      if (result && result.ok === true) return result;
      return { ok: false, error: result && result.error ? String(result.error) : "系统操作失败" };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  async function copyPathText(text) {
    closeContextMenu();
    const result = await runSystemWriteAction("writeClipboardText", { text });
    if (result.ok === true) return true;
    const fallbackOk = await copyToClipboard(text);
    if (fallbackOk) return true;
    setOperationStatus(false, result.error);
    return false;
  }

  async function handleRevealInExplorer(entry) {
    if (!entry || state.operationBusy) return;
    closeContextMenu();
    const result = await runSystemWriteAction("showItemInFolder", { path: entry.path });
    if (result.ok !== true) setOperationStatus(false, result.error);
  }

  async function handleGitRevealFile(file) {
    if (!file || !state.rootPath) return;
    await handleRevealInExplorer({ path: joinPath(state.rootPath, file.path) });
  }

  function handleGitCopyRelativePath(file) {
    if (!file) return;
    void copyPathText(file.path);
  }

  // Git 右侧查看器右键：按当前打开的差异文件（state.gitPreview.relPath/absPath）。
  async function handleGitPreviewRevealFile() {
    const gp = state.gitPreview;
    if (!gp || !gp.absPath) return;
    await handleRevealInExplorer({ path: gp.absPath });
  }

  function handleGitPreviewCopyPath() {
    const gp = state.gitPreview;
    if (!gp || !gp.absPath) return;
    void copyPathText(gp.absPath);
  }

  function handleGitPreviewCopyRelativePath() {
    const gp = state.gitPreview;
    if (!gp || !gp.relPath) return;
    void copyPathText(gp.relPath);
  }

  function handleGitCopyAbsolutePath(file) {
    if (!file || !state.rootPath) return;
    void copyPathText(joinPath(state.rootPath, file.path));
  }

  // 普通预览区的文件操作只针对当前打开文件，不污染文件树菜单或 Git 差异查看器。
  function handlePreviewRevealFile() {
    const filePath = state.preview && state.preview.path;
    if (!filePath) return;
    void handleRevealInExplorer({ path: filePath });
  }

  function handlePreviewCopyPath() {
    const filePath = state.preview && state.preview.path;
    if (!filePath) return;
    void copyPathText(filePath);
  }

  function handlePreviewCopyRelativePath() {
    const filePath = state.preview && state.preview.path;
    if (!filePath || !state.rootPath) return;

    const value = relativePath(state.rootPath, filePath);
    if (value == null) {
      setOperationStatus(false, "目标路径不在当前工作区内");
      return;
    }

    void copyPathText(value);
  }

  // 只读态右键「刷新」：重新从磁盘读取当前文件（编辑态不显示该项，避免丢弃未保存修改）。
  async function handlePreviewRefresh() {
    const current = state.preview;
    if (!current || !current.path) return;
    const filePath = current.path;
    const name = current.name;
    // 先回到加载态给即时反馈，再用最新磁盘内容重建预览
    state.preview = { kind: "loading", name, path: filePath };
    renderPreview();
    const result = await readFileContent(filePath);
    if (disposed || !state.preview || pathKey(state.preview.path) !== pathKey(filePath)) return;
    state.preview = buildFilePreview({ name, path: filePath }, result);
    renderPreview();
  }

  /**
   * 删除工作区文件或目录。
   * @description 删除是破坏性操作，必须先确认；成功后刷新文件树和 Git 状态。
   * @param {Object} entry 要删除的文件或目录条目
   */
  function handleDelete(entry) {
    if (!entry || state.operationBusy || state.confirmDialog) return;

    // 菜单先同步移除，再显示插件内的异步确认弹窗，避免阻塞宿主渲染线程。
    closeContextMenu();
    openConfirmDialog({
      title: t("action.delete", "删除"),
      message: t("action.deleteConfirm", "确定删除“{{name}}”吗？此操作不可撤销。", {
        name: entry.name || entry.path,
      }),
      confirmLabel: t("action.delete", "删除"),
      onConfirm: () => deleteEntry(entry),
    });
  }

  function openConfirmDialog({ title, message, confirmLabel, danger = true, onConfirm }) {
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
      if (!disposed) setOperationStatus(false, err && err.message ? err.message : String(err));
    }
  }

  async function deleteEntry(entry) {
    if (!entry || state.operationBusy) return;

    state.operationBusy = true;
    renderToolbar();
    renderTree();

    try {
      const result = await deleteFileSystemEntry(api, state.rootPath, entry.path);
      if (disposed) return;

      if (result.ok !== true) {
        setOperationStatus(false, result.error);
        return;
      }

      const selectedPath = pathKey(state.selected);
      const deletedPath = pathKey(entry.path);
      if (selectedPath && (selectedPath === deletedPath || selectedPath.startsWith(`${deletedPath}/`))) {
        // 删除当前预览文件或其父目录时，不能继续显示已经不存在的内容。
        state.selected = null;
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
        renderPreview();
      }

      await refreshFileTreeAfterMutation();
      await refreshGitAll();
      setOperationStatus(true);
    } catch (err) {
      if (!disposed) {
        setOperationStatus(false, err && err.message ? err.message : String(err));
      }
    } finally {
      if (!disposed) {
        state.operationBusy = false;
        renderToolbar();
        renderTree();
      }
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

  async function submitRename(newName) {
    const context = state.contextMenu;
    if (!context || state.operationBusy) return;
    const entry = context.entry;
    const trimmed = String(newName || "").trim();
    if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed)) {
      setOperationStatus(false, "名称不能为空，且不能包含路径分隔符");
      return;
    }
    if (trimmed.toLowerCase() === String(entry.name || "").toLowerCase()) {
      setOperationStatus(false, "新名称与原名称相同");
      return;
    }

    const oldPath = entry.path;
    const newPath = joinPath(parentDirectoryPath(oldPath), trimmed);
    state.operationBusy = true;
    renderContextMenu();
    const result = await renameFileSystemEntry(api, state.rootPath, oldPath, trimmed);
    if (disposed) return;
    if (result.ok !== true) {
      state.operationBusy = false;
      renderContextMenu();
      setOperationStatus(false, result.error);
      return;
    }

    remapStatePaths(oldPath, newPath);
    state.operationBusy = false;
    closeContextMenu();
    await refreshFileTreeAfterMutation();
    await refreshGitAll();
    setOperationStatus(true);
  }

  function closeContextMenu() {
    if (!state.contextMenu) return;
    state.contextMenu = null;
    renderContextMenu();
  }

  async function handleContextOpen(entry) {
    if (!entry || state.operationBusy) return;

    closeContextMenu();

    if (entry.isDirectory) {
      await openDirectory(entry);
      return;
    }

    await previewFile(entry);
  }

  function beginRename(entry) {
    if (!entry || state.operationBusy) return;
    state.contextMenu = { ...state.contextMenu, entry, renaming: true };
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

    const addItem = (label, action, isDisabled = false) => {
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
    const addToggleItem = (label, checked, action, isDisabled = false) => {
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
    const appendViewToggles = (isDisabled) => {
      addToggleItem(
        t("settings.respectGitignore", "按 .gitignore 过滤"),
        state.viewSettings.respectGitignore !== false,
        () => {
          closeContextMenu();
          void toggleViewSetting("respectGitignore");
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
            void toggleViewSetting("javaPackageView");
          },
          isDisabled,
        );
      }
    };

    if (context.renaming) {
      const input = el("input", "sfe-context-menu-input");
      input.type = "text";
      input.value = entry.name || "";
      input.setAttribute("aria-label", t("action.renamePrompt", "请输入新名称"));
      input.disabled = disabled;
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submitRename(input.value);
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
        () => handleContextOpen(entry),
        disabled,
      );
      separator();
      addItem(t("action.revealInExplorer", "在资源管理器中打开"), () => handleRevealInExplorer(entry), disabled);
      addItem(t("action.copyPath", "复制路径"), () => copyPathText(entry.path), disabled);
      addItem(
        t("action.copyRelativePath", "复制相对路径"),
        () => {
          const value = relativePath(state.rootPath, entry.path);
          if (value == null) setOperationStatus(false, "目标路径不在当前工作区内");
          else copyPathText(value);
        },
        disabled,
      );
      separator();
      addItem(t("action.rename", "重命名"), () => beginRename(entry), disabled);
      addItem(t("action.delete", "删除"), () => handleDelete(entry), disabled);
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

  function handleContextMenu(entry, x, y) {
    if (state.operationBusy || state.confirmDialog) return;
    state.contextMenu = { entry, x, y };
    renderContextMenu();
  }

  /** 刷新文件树与 Git 状态（工具栏刷新按钮与右键菜单「刷新」共用同一入口）。 */
  function handleRefresh() {
    closeContextMenu();
    refreshAll();
  }

  // ------------------------------------------------------------------
  // 5.0 项目终端：识别（懒加载）→ 右键 / 工具栏运行 → IDEA 式多 tab 交互终端
  // ------------------------------------------------------------------

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
  function findTerminal(id) {
    return state.terminals.find((term) => term && term.id === id) || null;
  }

  /**
   * 关闭终端后修正两个窗口的激活项：被移除的是激活项（或激活项已不存在）时回退到
   *   同窗口首条；否则保持不动（不误改另一窗口的激活项）。
   * @param {Iterable<string>} removedIds 被移除的终端 id
   */
  function reconcileActiveTerminals(removedIds) {
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

  /** 终端集合变化后重建两个窗口的 tab 列表（xterm 实例由组件内部增量维护，不丢失）。 */
  function rebuildTerminalWindows() {
    if (terminalWindow && typeof terminalWindow.rebuild === "function") terminalWindow.rebuild();
    if (runWindow && typeof runWindow.rebuild === "function") runWindow.rebuild();
  }

  /**
   * 某条命令仍在运行的终端集合（模式 A 且未结束，按 commandId 归属）。
   * @description 工具栏 Run/Stop 二态与「同一命令要么运行要么停止」的判定依据；
   *   commandId 是终端记录上稳定的命令标识（不是命令文本，避免同 cmd 不同配置误判）。
   * @param {{id?: string}|null} command 命令对象
   * @returns {Array<Object>}
   */
  function runningTerminalsForCommand(command) {
    const commandId = command && command.id ? command.id : null;
    if (!commandId) return [];
    return state.terminals.filter(
      (term) => term && term.mode === "run" && term.exited !== true && term.commandId === commandId,
    );
  }

  /** 某条命令当前是否运行中（驱动工具栏主按钮的 Run/Stop 二态）。 */
  function runCountForCommand(command) {
    return runningTerminalsForCommand(command).length;
  }

  /**
   * 关闭一个终端会话（终止 pty + 从集合移除）。切换项目 / 卸载 / 关闭 tab 共用。
   * @param {string} id 终端 id
   * @returns {boolean} 是否确实移除了会话
   */
  function killTerminalById(id) {
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
  function killRunTerminalsForCommand(command) {
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
  function stopCommandAndSync(command) {
    killRunTerminalsForCommand(command);
    rebuildTerminalWindows();
    syncSidebar();
    syncSidebar();
    syncRunToolbar();
  }

  /**
   * 停止全部运行中的命令（模式 A）——工具栏 ⋮ 菜单「停止全部 N 个」的语义。
   * @description 只有用户**显式**选择「全部停止」时才走这里（不是 Stop 的默认行为，这正是本轮修复点）；
   *   模式 B 常驻交互终端不参与，只能由各自的 tab × 关闭。
   */
  function stopAllRunTerminals() {
    for (const term of state.terminals) {
      if (!term || term.mode !== "run") continue;
      try {
        if (term.session && typeof term.session.kill === "function") term.session.kill();
      } catch {
        // 忽略：进程可能已自然退出
      }
    }
    state.terminals = state.terminals.filter((term) => !term || term.mode !== "run");
    reconcileActiveTerminals([state.activeRunTerminalId]);
    rebuildTerminalWindows();
    syncSidebar();
    syncRunToolbar();
  }

  /**
   * 收起底部工具窗口（IDEA：关闭工具窗口不终止进程，仅隐藏；会话与输出保留，侧栏入口可随时拉回）。
   */
  function handleMinimizeRunPanel() {
    state.bottomView = null;
    refreshBottomVisibility();
    syncSidebar();
  }

  /** 左侧竖排入口栏点击：切到指定工具窗口；再次点击同一入口则收起回文件视图。 */
  function selectBottomView(view) {
    const next = state.bottomView === view ? null : view;
    state.bottomView = next;
    if (next) ensureBottomWindows();
    refreshBottomVisibility();
    syncSidebar();
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
  function handleSelectTerminal(id) {
    if (disposed || state.activeTerminalId === id) return;
    if (!findTerminal(id)) return;
    state.activeTerminalId = id;
    if (terminalWindow && typeof terminalWindow.syncActive === "function") terminalWindow.syncActive();
  }

  /** 切换运行窗口激活 tab（点 tab）。 */
  function handleSelectRunTerminal(id) {
    if (disposed || state.activeRunTerminalId === id) return;
    if (!findTerminal(id)) return;
    state.activeRunTerminalId = id;
    if (runWindow && typeof runWindow.syncActive === "function") runWindow.syncActive();
  }

  /** 关闭某个终端 tab（终止会话 + 移除），并同步两个工具窗口与底栏/工具栏。 */
  function handleCloseTerminal(id) {
    if (!killTerminalById(id)) return;
    rebuildTerminalWindows();
    syncSidebar();
    syncRunToolbar();
  }

  /** 关闭某窗口内除指定 tab 之外的其它 tab（同 mode）。 */
  function closeOtherTerminals(id) {
    const target = findTerminal(id);
    if (!target) return;
    const victims = state.terminals.filter((term) => term.mode === target.mode && term.id !== id);
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
    syncSidebar();
    syncRunToolbar();
  }

  /** 关闭某窗口内的全部 tab（按 mode 区分，不动另一窗口）。 */
  function closeAllTerminalsOfMode(mode) {
    const victims = state.terminals.filter((term) => term && term.mode === mode);
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
    syncSidebar();
    syncRunToolbar();
  }

  /**
   * 懒加载项目识别：结果缓存进 state.projectCommands。
   * @description 首次在项目加载时触发（与 IDEA 一致：项目一打开就能 Run）。
   *   扫描完成后同步运行控件；识别结果不影响运行面板（面板只展示运行，不展示命令）。
   * @returns {Promise<Object|null>}
   */
  async function ensureCommands() {
    if (disposed || !state.rootPath) return null;
    const rootPath = state.rootPath;
    const before = state.projectCommands;
    const result = await ensureProjectCommands(state, rootPath);
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

  /** 底部工具窗口可见性：按 bottomView 互斥显示「终端」/「运行」窗口，null 时全部收起。 */
  function refreshBottomVisibility() {
    if (!layoutEls) return;
    if (layoutEls.terminalWindowEl) layoutEls.terminalWindowEl.hidden = state.bottomView !== "terminal";
    if (layoutEls.runWindowEl) layoutEls.runWindowEl.hidden = state.bottomView !== "run";
    applyToolDock();
  }

  /** 工具窗口是否正打开（终端或运行，二者互斥）。 */
  function toolWindowOpen() {
    return state.bottomView === "terminal" || state.bottomView === "run";
  }

  function saveToolDock() {
    try {
      if (api && api.storage && typeof api.storage.setJson === "function") {
        api.storage.setJson("toolDock", state.toolDock);
      }
    } catch {
      // 忽略：偏好写失败不影响这次切换
    }
  }

  /**
   * 把停靠写到主体上。窗口收起时仍按底栏布局，避免主视图被右侧空列挤窄。
   * 偏好本身留在 state.toolDock，下次打开继续用。
   */
  function applyToolDock() {
    if (!layoutEls || !layoutEls.body) return;
    layoutEls.body.dataset.toolDock = toolWindowOpen() && state.toolDock === "right" ? "right" : "bottom";
    if (terminalWindow && typeof terminalWindow.syncDock === "function") terminalWindow.syncDock();
    if (runWindow && typeof runWindow.syncDock === "function") runWindow.syncDock();
    renderGitViewSwitchInToolbar();
  }

  /**
   * 右侧停靠跟代码预览一样：必须先进入宿主全屏，左侧才是侧栏宽度、右侧才铺满。
   * 代码预览由样式让出，不会和终端并排。
   */
  async function ensureRightDock() {
    if (disposed || state.toolDock !== "right" || !toolWindowOpen()) return;
    applyToolDock();
    if (!isRightPanelFullscreen()) {
      const ok = await ensureRightPanelFullscreen();
      if (disposed) return;
      if (!ok) setOperationStatus(false, "无法进入右侧面板全屏");
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
    if (disposed) return;
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
    if (!layoutEls || !layoutEls.terminalWindowEl || !layoutEls.runWindowEl) return;
    if (!terminalWindow) terminalWindow = renderToolWindow(layoutEls.terminalWindowEl, terminalWindowOptions());
    if (!runWindow) runWindow = renderToolWindow(layoutEls.runWindowEl, runWindowOptions());
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
  function mergeRunCommands(commands, extra) {
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
          isCommandRunning: (command) => runCountForCommand(command) > 0,
        };
      },
      onRun: handleRunCommand,
      // Rerun：先停该命令的运行终端，再重新运行（IDEA 的 Rerun 语义）。
      onRerun: (command) => {
        stopCommandAndSync(command);
        handleRunCommand(command);
      },
      // Stop：只停「当前选中命令」，不波及其它命令（修复「点一个 Stop 全停」）。
      // 逐条 / 全部停止已移到「运行」工具窗口工具栏，顶栏不再提供 ⋮。
      onStop: stopCommandAndSync,
    });
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

  /** 停止某个运行 tab（运行窗口工具栏 ■ / tab 右键）——停该 tab 所属命令。 */
  function handleStopTerminal(id) {
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
  function handleRerunTerminal(id) {
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
    syncRunToolbar();
    syncSidebar();
    void createTerminalForId(term);
  }

  /** 复制某 tab 的标识（运行=命令原文，终端=标题）到系统剪贴板。 */
  function copyTerminalTab(id) {
    const term = findTerminal(id);
    if (!term) return;
    void copyToClipboard(term.title || "");
  }

  /** 复制某 tab 终端的选中文本到系统剪贴板（运行窗口工具栏「复制选中文本」用）。 */
  function copyTerminalSelection(id, text) {
    if (!findTerminal(id)) return;
    void copyToClipboard(text || "");
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
  function terminalWindowOptions() {
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
      onPasteText: readClipboardText,
    };
  }

  /** 运行窗口（mode A）组件配置。 */
  function runWindowOptions() {
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
      onCopySelection: copyTerminalSelection,
      onPasteText: readClipboardText,
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
  function handleNewTerminal(options) {
    if (disposed) return;
    if (!isTerminalAvailable()) {
      setOperationStatus(false, t("run.terminalUnavailable", "当前宿主未提供终端能力"));
      return;
    }
    const opts = typeof options === "string" ? { command: options } : options || {};
    const command = typeof opts.command === "string" ? opts.command : "";
    const mode = opts.mode === "run" ? "run" : "terminal";
    const id = `term-${Date.now().toString(36)}-${(terminalToken += 1)}`;
    const term = {
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
    syncSidebar();
    syncRunToolbar();
    void createTerminalForId(term);
  }

  /** 为一条终端记录创建 pty 会话，并接好输入 / 尺寸 / 输出 / 退出。 */
  async function createTerminalForId(term) {
    if (!term || disposed) return;
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
    term.onInput = (data) => {
      if (term.session) term.session.write(data);
    };
    term.onResize = (nextCols, nextRows) => {
      if (term.resizeTimer) clearTimeout(term.resizeTimer);
      // 面板刚展开时 fit 会连着触发几次。尾沿防抖，避免 ConPTY 每次都整屏重绘。
      term.resizeTimer = setTimeout(() => {
        term.resizeTimer = null;
        if (term.phase !== phase || !term.session) return;
        term.session.resize(nextCols, nextRows);
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
    let runShell = null;
    let runCommand = "";
    let exitCommand = "";
    if (term.mode === "run") {
      if (term.scriptPath) {
        const scriptShell = await resolveScriptShell(term.scriptPath);
        if (!scriptShell.supported) {
          const ext = scriptShell.extension ? `.${scriptShell.extension}` : "";
          const need = scriptShell.requiredLabel ? `（需要 ${scriptShell.requiredLabel}）` : "";
          setOperationStatus(false, t("run.scriptUnsupported", "当前终端不支持运行 {{ext}} 脚本{{need}}", { ext, need }));
          return;
        }
        runShell = { shellPath: scriptShell.shellPath, exitCommand: scriptShell.exitCommand };
        runCommand = scriptShell.runCommand;
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
    let session = null;
    const sendCommand = () => {
      if (commandSent || !session || !commandText) return;
      if (disposed || term.phase !== phase || !state.terminals.includes(term)) return;
      commandSent = true;
      if (term.commandTimer) {
        clearTimeout(term.commandTimer);
        term.commandTimer = null;
      }
      term.pendingCommand = "";
      session.write(`${commandText}\r`);
      if (term.mode === "run" && exitCommand) session.write(`${exitCommand}\r`);
    };

    const result = await createPtySession({
      cwd: term.cwd || state.rootPath,
      cols,
      rows,
      // 仅模式 A 指定 shellPath；模式 B 传 undefined，走宿主默认检测。
      shellPath: runShell ? runShell.shellPath : undefined,
      onData: (data) => {
        if (disposed || term.phase !== phase) return;
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
        // 模式 A 退出后刷新运行窗口 tab（✓/✗ + 退出码 + 状态点/工具栏态）。
        if (term.mode === "run") rebuildTerminalWindows();
        syncRunToolbar();
        syncSidebar();
      },
    });

    // 终端在创建期间被关闭 / 项目已切换：回收本次会话，避免孤儿进程。
    if (disposed || !state.terminals.includes(term)) {
      if (result.ok && typeof result.kill === "function") result.kill();
      return;
    }
    if (!result.ok) {
      setOperationStatus(false, result.error || t("run.startFailed", "启动失败"));
      return;
    }
    term.session = result;
    session = result;
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
    syncRunToolbar();
    syncSidebar();
  }

  /**
   * 运行一条命令（模式 A）：新建一个终端 tab 并把命令敲进去执行。
   * @description 「同一命令要么运行要么停止」：该命令已有运行中的终端时**不再新建**
   *   （按钮此时应为 Stop，正常不会走到这里；此守卫兜底右键「运行」与代码行 ▶ 的并发触发，
   *   替代原先的 300ms 时间窗口去重——按真实运行状态判定更准，且不误伤快速重跑）。
   * @param {{id?: string, cmd: string, labelFallback?: string, labelKey?: string|null}} command 命令对象
   */
  function handleRunCommand(command) {
    if (disposed || !command || !command.cmd) return;
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
  function rememberManualScriptCommand(command) {
    if (!command || command.runKind !== "script" || !command.id) return;
    if (state.manualScriptCommands.some((item) => item.id === command.id)) return;
    state.manualScriptCommands.push(command);
    renderRunToolbarView();
  }

  // 文件树空白区右键：命中具体条目时由行自身处理并 stopPropagation（见 tree-view.js），
  // 只有落在空白处才冒泡到这里，弹出工作区级菜单（刷新 / 打开工作区 / 复制工作区路径）。
  function handleTreePaneContextMenu(event) {
    if (event.target?.closest?.(".sfe-file-item")) return;
    event.preventDefault();
    handleContextMenu(null, event.clientX, event.clientY);
  }

  // 5.1.1 右键菜单动作实现结束：所有实体变更都经过宿主 filesystem 写动作。

  /**
   * 由宿主文件读取结果构造预览状态对象。
   * @description 同时供 Git 变更视图的内容模式复用，避免重复构造预览状态。
   */
  function buildFilePreview(entry, result) {
    // 宿主接口不可用（返回 null）
    if (!result) {
      return {
        kind: "error",
        name: entry.name,
        path: entry.path,
        message: t("error.noApi", "当前版本未开放本地文件接口。"),
      };
    }

    // 图片：宿主返回 base64 内容 + mimeType，组装 data URL 交给 <img>
    if (result.isImage) {
      return {
        kind: "image",
        name: entry.name,
        path: entry.path,
        url: "data:" + (result.mimeType || "image/png") + ";base64," + result.content,
      };
    }

    // 二进制：不提供内联预览
    if (result.isBinary) {
      return {
        kind: "binary",
        name: entry.name,
        path: entry.path,
        mime: result.mimeType || "application/octet-stream",
      };
    }

    const text = String(result.content || "");
    const isMarkdown = isMarkdownPath(entry.name);
    const virtual = shouldVirtualize(text);

    return {
      kind: "text",
      name: entry.name,
      path: entry.path,
      text,
      highlightedHtml: "",
      isMarkdown,
      // 大 Markdown 先显示源码。小 Markdown 的 HTML 由后续的块加载补上。
      mode: isMarkdown && virtual ? "code" : "preview",
      html: "",
      editable: false,
      saveState: "idle",
      saveMessage: "",
    };
  }

  // 5. 选中并预览文件
  async function previewFile(entry) {
    const requestId = ++previewRequestId;
    saveRequestId++;
    state.selected = entry.path;
    // 终端占着右侧时先让回底栏，这次点击的文件才能显示在代码预览里。
    yieldRightDockToCode();

    // 先立刻切到「正在读取」并渲染，保证点击后马上看到反馈。
    // 全屏联动可能等待宿主 React 更新数帧（见 ensureRightPanelFullscreen），
    // 若排在 loading 之前，用户会先看到界面无响应，误以为卡死——这是体验倒退的根因。
    state.preview = {
      kind: "loading",
      name: entry.name,
      path: entry.path,
    };
    // 仅就地切换文件树选中高亮与重绘右侧预览：不重建整棵树，大目录下点文件不再卡顿
    applyTreeSelectionHighlight();
    renderPreview();

    // 让出当前任务，使浏览器先把「正在读取」绘制出来，再执行可能阻塞的全屏联动；
    // 否则全屏触发与 loading 渲染同处一个同步任务，绘制被推迟，点击后仍会先卡一下。
    await waitForNextFrame();

    // 智能联动全屏：非全屏模式下点击具体文件自动全屏展开代码大视野
    if (!isRightPanelFullscreen()) {
      const fullscreenReady = await ensureRightPanelFullscreen();
      if (!fullscreenReady) {
        setOperationStatus(false, "无法进入右侧面板全屏");
      }
    }

    try {
      const result = await readFileContent(entry.path);
      if (disposed || requestId !== previewRequestId || pathKey(entry.path) !== pathKey(state.selected)) return;
      state.preview = buildFilePreview(entry, result);
      renderPreview();
      if (state.preview.kind === "text" && state.preview.isMarkdown && state.preview.mode === "preview") {
        void hydrateFileMarkdown(requestId);
      }
      return;
    } catch (err) {
      if (disposed || requestId !== previewRequestId || pathKey(entry.path) !== pathKey(state.selected)) return;
      state.preview = {
        kind: "error",
        name: entry.name,
        path: entry.path,
        message: err && err.message ? err.message : String(err),
      };
    }
    renderPreview();
  }

  // 5.1 将 Markdown 预览中的本地相对图片读取为 data URL 后回填
  // 只改预览 DOM，不触发整体重渲染，避免打断滚动与选区
  async function inlineMarkdownImages(docPath) {
    const holder = container.querySelector(".sfe-markdown-body");
    if (!holder) return;
    const images = Array.from(holder.querySelectorAll("img[data-sfe-src]"));
    if (!images.length) return;

    await Promise.all(
      images.map(async (img) => {
        const ref = img.getAttribute("data-sfe-src") || "";
        const absPath = resolveMarkdownAssetPath(ref, docPath);
        if (!absPath) return;
        const dataUrl = await readImageAsDataUrl(absPath);
        // 异步期间可能已卸载或切换到其他文档
        if (disposed || !dataUrl || !holder.isConnected) return;
        img.setAttribute("src", dataUrl);
      })
    );
  }

  async function hydrateFileMarkdown(requestId) {
    const preview = state.preview;
    if (!preview || preview.kind !== "text" || !preview.isMarkdown || preview.mode !== "preview") return;
    if (shouldVirtualize(preview.text)) {
      if (disposed || requestId !== previewRequestId) return;
      state.preview = { ...state.preview, mode: "code" };
      renderPreview();
      return;
    }
    const mod = await loadChunk("markdown");
    if (disposed || requestId !== previewRequestId || !state.preview || state.preview.mode !== "preview") return;
    if (!mod || typeof mod.renderMarkdownHtml !== "function") return;
    state.preview = { ...state.preview, html: mod.renderMarkdownHtml(state.preview.text || "") };
    renderPreview();
    inlineMarkdownImages(state.preview.path);
  }

  // 5.2 切换 Markdown 的预览 / 代码模式
  function setPreviewMode(mode) {
    const next = mode === "code" ? "code" : "preview";
    if (state.preview.mode === next) return;
    const requestId = previewRequestId;
    state.preview = {
      ...state.preview,
      mode: next,
      editable: false,
      saveState: "idle",
      saveMessage: "",
    };
    renderPreview();
    if (next === "preview" && state.preview.kind === "text" && state.preview.isMarkdown) {
      void hydrateFileMarkdown(requestId);
    }
  }

  // 5.3 编辑状态只属于当前文件；输入时不重建 DOM，避免光标跳动。
  function setPreviewEditable(next) {
    if (!state.preview || state.preview.kind !== "text") return;
    if (state.preview.isMarkdown && state.preview.mode !== "code") return;
    state.preview = {
      ...state.preview,
      editable: next === true,
      saveState: "idle",
      saveMessage: "",
    };
    renderPreview();
  }

  function handlePreviewInput(value) {
    if (!state.preview || !state.preview.editable) return;
    state.preview.text = String(value ?? "");
    state.preview.saveState = "idle";
    state.preview.saveMessage = "";
  }

  // 保存只接受当前文件的完整文本；写入完成后再更新高亮和 Git 状态。
  async function handleSavePreview() {
    if (
      !state.preview ||
      state.preview.kind !== "text" ||
      !state.preview.editable ||
      !state.preview.path
    ) return;

    const saveId = ++saveRequestId;
    const filePath = state.preview.path;
    const content = state.preview.text;
    state.preview.saveState = "saving";
    state.preview.saveMessage = "";
    renderPreview();

    const result = await writeFileContent(api, filePath, content);
    if (
      disposed ||
      saveId !== saveRequestId ||
      !state.preview ||
      pathKey(state.preview.path) !== pathKey(filePath)
    ) return;

    if (result && result.ok === true) {
      state.preview.highlightedHtml = "";
      state.preview.html = "";
      state.preview.saveState = "saved";
      state.preview.saveMessage = "";
      renderPreview();
      if (state.preview.isMarkdown && state.preview.mode === "preview") {
        void hydrateFileMarkdown(previewRequestId);
      }
      await refreshGitAll();
    } else {
      state.preview.saveState = "failed";
      state.preview.saveMessage =
        result && result.error === "当前宿主未提供文件写入能力"
          ? t("preview.editUnavailable", "当前宿主未提供文件写入能力")
          : result && result.error
            ? String(result.error)
            : t("action.saveFailed", "保存失败");
      renderPreview();
    }
  }

  // 6. 复制当前代码
  async function handleCopyCode() {
    if (!state.preview || state.preview.kind !== "text" || !state.preview.text) return;
    const ok = await copyToClipboard(state.preview.text);
    if (!ok) return;

    state.copied = true;
    renderActiveViewer();
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      if (disposed) return;
      state.copied = false;
      renderActiveViewer();
    }, 1600);
  }

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

  let layoutEls = null;

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
    const sidebarBtn = (parent, iconName, label, onClick) => {
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
    const runSideBtn = sidebarBtn(sidebarBottom, "play", t("sidebar.run", "运行"), () => selectBottomView("run"));
    const runSideDot = el("span", "sfe-sidebar-dot");
    runSideDot.hidden = true;
    runSideBtn.appendChild(runSideDot);
    // 终端：切到「终端」工具窗口。
    const terminalSideBtn = sidebarBtn(
      sidebarBottom,
      "terminal",
      t("sidebar.terminal", "终端"),
      () => selectBottomView("terminal"),
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
  async function switchMainView(view) {
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
    if (view === "git" && !state.gitStatus) await refreshGitViewStatus();
  }

  /** 同步左侧入口栏选中态与运行中圆点。 */
  function syncSidebar() {
    if (!layoutEls) return;
    if (layoutEls.fileViewBtn) layoutEls.fileViewBtn.classList.toggle("active", state.mainView === "files");
    if (layoutEls.gitViewBtn) layoutEls.gitViewBtn.classList.toggle("active", state.mainView === "git");
    if (layoutEls.runSideBtn) layoutEls.runSideBtn.classList.toggle("active", state.bottomView === "run");
    if (layoutEls.terminalSideBtn) layoutEls.terminalSideBtn.classList.toggle("active", state.bottomView === "terminal");
    if (layoutEls.runSideDot) layoutEls.runSideDot.hidden = runningCount() <= 0;
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
  function buildGitViewSwitch(current) {
    const switcher = el("div", "sfe-md-mode-switch-inline");
    switcher.setAttribute("role", "group");
    const segments = [
      { key: "diff", icon: "diff", label: t("action.diff", "差异") },
      { key: "content", icon: "code", label: t("action.content", "内容") },
    ];
    for (const seg of segments) {
      const isActive = seg.key === current;
      const btn = el("button", "sfe-md-mode-btn" + (isActive ? " active" : ""));
      btn.type = "button";
      btn.title = seg.label;
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      btn.appendChild(createActionIcon(seg.icon, 13));
      btn.appendChild(el("span", "sfe-md-mode-label", seg.label));
      if (!isActive) btn.addEventListener("click", () => setGitPreviewMode(seg.key));
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
  function render() {
    if (disposed) return;
    ensureLayout();
    renderToolbar();
    renderConfirmDialog();
    // 运行控件（常驻工具栏，按识别结果与运行状态同步）。
    renderRunToolbarView();
    // 底部工具窗口 / 左侧入口栏挂在主体上（不随 mainView 重建），此处同步显隐与选中态。
    refreshBottomVisibility();
    syncSidebar();
    // 窗口可见时让终端适配尺寸（视图切换可能改变容器宽度）。
    fitTerminalPanel();
    const { mainView } = layoutEls;
    mainView.replaceChildren();
    renderGitViewSwitchInToolbar();
    layoutEls.treePane = null;
    layoutEls.previewPane = null;
    layoutEls.gitPane = null;
    layoutEls.gitPreviewPane = null;

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
  function buildFileView(mainView) {
    const treePane = el("div", "sfe-tree-pane");
    // 空白区右键：行内条目自行处理并阻止冒泡，其余区域在此兜底弹出工作区级菜单
    treePane.addEventListener("contextmenu", handleTreePaneContextMenu);
    mainView.appendChild(treePane);
    layoutEls.treePane = treePane;

    const previewPane = el("div", "sfe-preview-pane");
    mainView.appendChild(previewPane);
    layoutEls.previewPane = previewPane;
  }

  // 构建 Git 变更视图骨架（左列表 + 右查看器）
  function buildGitView(mainView) {
    const gitPane = el("div", "sfe-git-pane");
    mainView.appendChild(gitPane);
    layoutEls.gitPane = gitPane;

    const gitPreviewPane = el("div", "sfe-git-preview-pane");
    mainView.appendChild(gitPreviewPane);
    layoutEls.gitPreviewPane = gitPreviewPane;
  }

  // 局部：仅切换文件树的选中行高亮，不重建 DOM
  // @description previewFile 只改 state.selected，不重建整棵树：大目录下整树重建是卡顿根因。
  //   选中态对文件行只是 .selected class（纯背景色），就地切换与重建后的渲染结果完全等价，
  //   同时天然保住滚动位置、展开态与行内事件。
  function applyTreeSelectionHighlight() {
    if (disposed || !layoutEls || !layoutEls.treePane) return;
    const pane = layoutEls.treePane;
    const selectedKey = pathKey(state.selected);
    pane.querySelectorAll(".sfe-file-item.selected").forEach((node) => {
      if (pathKey(node.dataset.path) !== selectedKey) node.classList.remove("selected");
    });
    if (!state.selected) return;
    for (const node of pane.querySelectorAll(".sfe-file-item")) {
      if (pathKey(node.dataset.path) === selectedKey) {
        node.classList.add("selected");
        return;
      }
    }
  }

  // 局部：文件树（保留滚动位置）
  function renderTree() {
    if (disposed || !layoutEls || !layoutEls.treePane) return;
    const pane = layoutEls.treePane;
    const scroll = pane.scrollTop;
    renderTreeView(pane, {
      rootPath: state.rootPath,
      rootNodes: state.rootNodes,
      expanded: state.expanded,
      selected: state.selected,
      gitStatusMap: state.gitStatusMap,
      canList: true,
      canRead: true,
       onToggleDir: toggleDir,
       onSelectFile: previewFile,
       onContextMenu: handleContextMenu,
       t,
    });
    pane.scrollTop = scroll;
  }

  // 局部：普通文件预览
  function renderPreview() {
    if (disposed || !layoutEls || !layoutEls.previewPane) return;
    renderCodeViewer(layoutEls.previewPane, {
      preview: state.preview,
      rootPath: state.rootPath,
      copied: state.copied,
      onCopy: handleCopyCode,
      onSetMode: setPreviewMode,
      onToggleEdit: setPreviewEditable,
      onEditInput: handlePreviewInput,
      onSave: handleSavePreview,
      onRevealFile: handlePreviewRevealFile,
      onCopyPath: handlePreviewCopyPath,
      onCopyRelativePath: handlePreviewCopyRelativePath,
      onRefresh: handlePreviewRefresh,
      // 运行入口：代码查看器需要完整源码 main 列表，顶栏仍使用过滤后的可见命令列表。
      runCommands: () => flattenCommands(state.projectCommands, { includeHidden: true }),
      onRunCommand: handleRunCommand,
      editable: state.preview.editable === true,
      saving: state.preview.saveState === "saving",
      t,
    });
  }

  // Git 变更视图选项（提交框与列表共用）
  function gitViewOptions() {
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
      collapsedStaged: state.collapsedStaged,
      collapsedUnstaged: state.collapsedUnstaged,
      // 单击仅更新选中态（就地改样式，不重建 DOM）
      onSelectFile: (file, section) => {
        state.gitSelected = `${section}:${file.path}`;
      },
      // 单击文件夹行：同样记录选中态（与文件选中共用 gitSelected，天然互斥），
      // 使目录行的行内加号/减号常显，而非仅 hover 时可见。
      onSelectFolder: (node, section) => {
        state.gitSelected = `${section}:${node.path}`;
      },
      onStageToggle: handleStageToggle,
      onStageAll: handleStageAll,
      onUnstageAll: handleUnstageAll,
      onDiscard: handleDiscard,
      onCommit: handleCommit,
      onCommitAndPush: handleCommitAndPush,
      onSetCommitMode: handleSetCommitMode,
      onToggleCommitMenu: () => {
        state.gitCommitMenuOpen = !state.gitCommitMenuOpen;
        renderGitPaneCommit();
      },
      onToggleCollapse: handleToggleGitCollapse,
      onGenerate: handleGenerateCommitMessage,
      // 输入只写回 state，不触发重建（重建会销毁节点、打断输入与光标）
      onCommitMessageInput: (value) => {
        state.gitCommitMessage = value;
      },
       // 单击文件行：右侧加载该文件的 Git 差异
       onOpenFile: openGitDiff,
       // 右键菜单复用普通文件树已有系统能力，不新增复制/移动等文件 API。
       onRevealFile: handleGitRevealFile,
       onCopyRelativePath: handleGitCopyRelativePath,
       onCopyAbsolutePath: handleGitCopyAbsolutePath,
       // 右键菜单「刷新」：与文件树刷新共用同一入口
       onRefresh: handleRefresh,
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
      onSync: handleSync,
    });
  }

  // 局部：Git 右侧文件查看器（差异 / 内容）
  function renderGitPreview() {
    if (disposed || !layoutEls || !layoutEls.gitPreviewPane) return;
    const preview = gitPreviewView();
    // 有文件时提供文件操作（资源管理器 / 复制路径）；无文件（空态）时不注入，
    // 但保留 onRefresh —— 空态右键也能弹出「刷新」，刷新左侧变更列表与当前差异。
    const hasFile = preview && state.gitPreview;
    renderCodeViewer(layoutEls.gitPreviewPane, {
      preview,
      emptyHint: t("git.previewHint", "在左侧选择变更文件以查看差异。"),
      copied: state.copied,
      onCopy: handleCopyCode,
      onSetMode: setPreviewMode,
      onSetDiffMode: setDiffMode,
      onRefresh: handleGitPreviewRefresh,
      // 右侧差异查看器的右键菜单：与文件管理器预览区一致的文件操作（仅打开文件时注入）
      onRevealFile: hasFile ? handleGitPreviewRevealFile : undefined,
      onCopyPath: hasFile ? handleGitPreviewCopyPath : undefined,
      onCopyRelativePath: hasFile ? handleGitPreviewCopyRelativePath : undefined,
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


  // 8. 启动与初始化生命周期（立即同步执行初次渲染骨架，随后异步拉取数据）
  render();

  // 点击插件外部区域关闭三点菜单（capture 阶段，避免被内部 stopPropagation 拦截）
  const closeMenuOnOutside = (e) => {
    // 提交模式下拉：点击 split 区域外时关闭
    if (state.gitCommitMenuOpen) {
      const split = container.querySelector(".sfe-git-commit-split");
      if (split && !split.contains(e.target)) {
        state.gitCommitMenuOpen = false;
        renderGitPaneCommit();
        return;
      }
    }
    if (state.contextMenu) {
      const contextMenu = container.querySelector(".sfe-context-menu");
      if (contextMenu && !contextMenu.contains(e.target)) {
        closeContextMenu();
      }
    }
  };
  document.addEventListener("click", closeMenuOnOutside, true);

  const closeContextMenuOnEscape = (e) => {
    if (e.key !== "Escape" || !state.contextMenu) return;
    e.preventDefault();
    closeContextMenu();
  };
  document.addEventListener("keydown", closeContextMenuOnEscape, true);

  // 宿主全屏态变化（用户点全屏按钮）时同步工具栏「差异 / 内容」切换的显隐。
  // MutationObserver / document.body 在真实宿主必然存在；此处做防御以兼容极简测试环境。
  let fullscreenObserver = null;
  if (typeof MutationObserver === "function" && document.body) {
    let lastFullscreen = isRightPanelFullscreen();
    fullscreenObserver = new MutationObserver(() => {
      const now = isRightPanelFullscreen();
      if (now === lastFullscreen) return;
      lastFullscreen = now;
      // 右侧布局依赖全屏。用户退出全屏时终端回到底栏，避免和代码预览抢同一列。
      if (!now && state.toolDock === "right" && (state.bottomView === "run" || state.bottomView === "terminal")) {
        state.toolDock = "bottom";
        saveToolDock();
        applyToolDock();
        fitTerminalPanel();
      }
      renderGitViewSwitchInToolbar();
    });
    fullscreenObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
      subtree: true,
    });
  }

  // 宿主 Tab 切换感知：当从宿主其他面板（如 Git、终端、代码库）切回当前文件浏览器时，
  // 宿主 .right-panel-tab-pane 获得 .active 类，此时必须执行刷新（重新拉取目录树与 Git 状态）
  let tabPaneObserver = null;
  const tabPaneEl = typeof container.closest === "function" ? container.closest(".right-panel-tab-pane") : null;
  if (tabPaneEl && typeof MutationObserver === "function") {
    let wasActive = tabPaneEl.classList.contains("active");
    tabPaneObserver = new MutationObserver(() => {
      if (disposed) return;
      const isActiveNow = tabPaneEl.classList.contains("active");
      if (isActiveNow && !wasActive) {
        // 从其他面板切回文件浏览器：自动触发全量刷新
        refreshGitAll();
      }
      wasActive = isActiveNow;
    });
    tabPaneObserver.observe(tabPaneEl, { attributes: true, attributeFilter: ["class"] });
  }

  // 宿主窗口切回感知（用户从外部应用切回 Snow App 时刷新）
  const handleWindowFocus = () => {
    if (disposed) return;
    if (!tabPaneEl || tabPaneEl.classList.contains("active")) {
      refreshGitAll();
    }
  };
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("focus", handleWindowFocus);
  }

  let unsubGit = null;
  let unsubProjects = null;
  ensureIcons();
  (async () => {
    const [initialRoot, viewSettings, diffMode, commitMode, toolDock] = await Promise.all([
      resolveRoot(),
      loadViewSettings(api),
      loadDiffViewMode(api),
      (async () => {
        try {
          if (api.storage && typeof api.storage.getJson === "function") {
            return await api.storage.getJson("gitCommitMode");
          }
        } catch {
          // 忽略读取失败，使用默认模式
        }
        return null;
      })(),
      (async () => {
        try {
          if (api.storage && typeof api.storage.getJson === "function") {
            return await api.storage.getJson("toolDock");
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
      await loadRoot({ followups: true });
      if (disposed) return;
    }
    // 跟随宿主项目切换：订阅 projects 域（live），activeDirectory 变化时全量切换到新项目。
    // 与宿主「打开文件夹」按钮天然一致，插件不自建多开与目录选择。
    if (api && api.metadata && typeof api.metadata.subscribe === "function") {
      try {
        const sub = api.metadata.subscribe("projects", (response) => {
          if (disposed) return;
          const nextPath = resolveActiveDirectoryPath(response);
          if (pathKey(nextPath) === pathKey(state.rootPath)) return;
          applyActiveProject(nextPath);
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
      if (gitDebounceTimer) clearTimeout(gitDebounceTimer);
      gitDebounceTimer = setTimeout(() => {
        gitDebounceTimer = null;
        refreshGitAll();
      }, 300);
    });
  })();

  return () => {
    disposed = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    if (operationTimer) clearTimeout(operationTimer);
    if (gitDebounceTimer) clearTimeout(gitDebounceTimer);
    if (typeof unsubGit === "function") unsubGit();
    if (typeof unsubProjects === "function") unsubProjects();
    if (runToolbar && typeof runToolbar.dispose === "function") runToolbar.dispose();
    runToolbar = null;
    if (gitSyncIndicator && typeof gitSyncIndicator.dispose === "function") gitSyncIndicator.dispose();
    gitSyncIndicator = null;
    if (terminalWindow && typeof terminalWindow.dispose === "function") terminalWindow.dispose();
    terminalWindow = null;
    if (runWindow && typeof runWindow.dispose === "function") runWindow.dispose();
    runWindow = null;
    if (fullscreenObserver) fullscreenObserver.disconnect();
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
    killAllTerminals();
    closeGitContextMenu(layoutEls && layoutEls.gitPane);
    container.replaceChildren();
  };
}

// 默认导出与命名导出双重兼容
export default { mount };
