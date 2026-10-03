/**
 * Snow App 文件浏览器插件 (renderMode: "esm")
 * 模块化顶层入口：协调文件服务、Git 状态、目录树视图与代码预览器
 */

import { el, copyToClipboard } from "./utils/dom.js";
import { createActionIcon } from "./icons/action-icons.js";
import {
  basename,
  extname,
  sortEntries,
  readDirectoryEntries,
  readFileContent,
  writeFileContent,
  renameFileSystemEntry,
  deleteFileSystemEntry,
  relativePath,
  resolveActiveDirectoryPath,
  detectJavaProject,
} from "./services/file-service.js";
import {
  fetchGitStatusMap,
  subscribeGitStatus,
  getRelativeGitPath,
  getGitStatus,
  partitionGitFiles,
  gitStatusSignature,
} from "./services/git-service.js";
import { highlightCodeHtml } from "./components/highlighter.js";
import { renderMarkdownHtml } from "./components/markdown-renderer.js";
import { renderTreeView } from "./components/tree-view.js";
import { loadJavaPackageTree } from "./services/java-project.js";
import { renderCodeViewer } from "./components/code-viewer.js";
import { renderGitCommitBar, renderGitList, renderGitSyncBar, resetGitSyncBar } from "./components/git-view.js";
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
  gitPull,
  gitSync,
  gitDiscardChanges,
  gitFileDiff,
  gitBranches,
  gitCheckout,
  generateCommitMessage,
  abortCommitMessage,
} from "./services/git-actions.js";
import { parseUnifiedDiff } from "./services/diff.js";

const MAX_PREVIEW_CHARS = 200000;

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
    expanded: Object.create(null),
    selected: null,
    status: "",
    copied: false,
    gitStatusMap: Object.create(null),
    // 视图开关（默认开启）与多层 .gitignore 规则
    viewSettings: {
      excludeMeta: true,
      respectGitignore: true,
      onlyGitChanges: false,
      javaPackageView: true,
    },
    gitignoreRules: [],
    menuOpen: false,
    contextMenu: null,
    confirmDialog: null,
    operationBusy: false,
    // Git 变更视图状态
    gitStatus: null,
    gitCommitMessage: "",
    gitBusy: null,
    // 同步按钮的进行态：与 gitBusy 区分，负责远端 pull / 本地 push 的完整同步链路
    gitSyncBusy: null,
    // 分支切换进行态（禁用分支下拉，避免并发 checkout）
    gitBranchBusy: null,
    gitGenerating: false,
    gitStreamId: null,
    gitSelected: null,
    // Git 变更视图右侧文件查看器状态（双击文件行后加载）
    gitPreview: null,
    // 差异展示模式（unified / split）；差异范围固定显示完整文件
    diffMode: "unified",
    gitCommitMode: "commit",
    gitCommitMenuOpen: false,
    collapsedStaged: new Set(),
    collapsedUnstaged: new Set(),
    preview: {
      kind: "empty",
      name: "",
      path: "",
      text: "",
      highlightedHtml: "",
      truncated: false,
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
    state.expanded = Object.create(null);
    state.selected = null;
    state.contextMenu = null;
    state.confirmDialog = null;
    state.operationBusy = false;
    state.gitStatus = null;
    state.gitStatusMap = Object.create(null);
    state.gitignoreRules = [];
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
      truncated: false,
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
    await reloadGitignore();
    await refreshAll();
  }

  // 刷新 Java 项目识别结果：与目录树并行，避免阻塞 Git 状态刷新。
  // 结果保存在状态中，后续 Java 包视图直接复用，不在渲染层重复扫描。
  async function refreshJavaProject() {
    if (disposed || !state.rootPath) return;
    const projectPath = state.rootPath;
    const detected = await detectJavaProject(projectPath);
    // 异步检测期间可能已切换项目，过期结果不能写回当前状态。
    if (disposed || pathKey(projectPath) !== pathKey(state.rootPath)) return;
    state.javaProject = detected;
  }

  // 刷新当前面板全部数据：Java 项目识别必须先完成，源码根目录展开才有可靠的 sourceRoots。
  async function refreshAll() {
    if (disposed || !state.rootPath) return;
    await refreshJavaProject();
    await Promise.all([loadRoot(), refreshGitStatus(), refreshGitViewStatus()]);
  }

  // 2. 拉取 Git 状态
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

  async function refreshGitStatus() {
    if (!state.rootPath || disposed) return;
    const map = await fetchGitStatusMap(state.rootPath);
    if (disposed) return;
    if (isSameGitMap(state.gitStatusMap, map)) return;
    state.gitStatusMap = map;
    // 文件树视图才需要文件级染色；Git 变更视图下无需重绘文件树
    if (!state.viewSettings.onlyGitChanges) renderTree();
  }

  // 拉取完整 Git 状态（供 Git 变更视图使用）
  // 内容未变则跳过重绘：宿主 watcher 会因 git status 自身刷新索引等原因高频触发，
  // 无条件重建列表会反复销毁行节点——表现为列表持续跳动、hover 出现的行内按钮闪烁。
  // 仅当签名变化时才重绘，可保住行节点、选中态与滚动位置。
  async function refreshGitViewStatus() {
    if (!state.rootPath || disposed) return;
    const status = await getGitStatus(state.rootPath);
    if (disposed) return;
    const prevSig = gitStatusSignature(state.gitStatus);
    const nextSig = gitStatusSignature(status);
    state.gitStatus = status;
    // 内容未变则跳过重绘（宿主 watcher 高频触发，无条件重建会让列表跳动）。
    if (prevSig === nextSig && prevSig !== "") return;
    // 底部同步栏（当前分支名 + ↑/↓ 计数）依赖 gitStatus，文件树视图下同样要刷新，
    // 否则该视图底栏会一直停在「无分支 / 无计数」的初始态。
    renderGitPaneSync();
    if (!state.viewSettings.onlyGitChanges) return;
    renderGitPane();
  }

  // 统一的 Git 刷新：同时刷新文件树染色、变更视图与底部同步栏。
  // 等待两个异步刷新完成，调用方 await 后即为「已刷新到最新状态」。
  async function refreshGitAll() {
    await Promise.all([refreshGitStatus(), refreshGitViewStatus()]);
  }

  // ------------------------------------------------------------------
  // Git 变更视图操作
  // ------------------------------------------------------------------
  // 执行一个 Git 写操作：置忙 → 执行 → 刷新，失败仅记录
  // 返回操作结果，便于调用方按 success 决定后续（如仅成功时清空选中）
  async function runGitAction(busy, fn) {
    if (state.gitBusy) return null;
    state.gitBusy = busy;
    renderGitPaneCommit();
    renderGitPaneSync();
    try {
      return await fn();
    } catch (err) {
      console.warn("[FileExplorer] Git 操作失败:", err);
      return null;
    } finally {
      if (!disposed) {
        state.gitBusy = null;
        renderGitPaneCommit();
        renderGitPaneSync();
      }
    }
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
      renderGitPaneSync();
      await gitPush(state.rootPath, remote, branch || undefined, !status.upstream);
      await refreshGitAll();
    });
  }

  // 执行真正的 Git 同步：先拉取远端，再根据拉取后的状态推送本地提交。
  // 同步编排集中在服务层，入口只负责忙碌态、最终刷新和异常兜底。
  async function handleSync() {
    if (state.gitSyncBusy || state.gitBusy || state.gitBranchBusy || disposed || !state.rootPath) return;
    state.gitSyncBusy = "sync";
    renderGitPaneSync();
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
        renderGitPaneSync();
      }
    }
  }

  // 拉取远端更新（底部同步栏的 ↓ 计数区点击触发）
  function handlePull() {
    if (!state.rootPath || state.gitSyncBusy || state.gitBranchBusy) return;
    const status = state.gitStatus || {};
    const branch = status.currentBranch || "";
    const remote = status.upstream ? String(status.upstream).split("/")[0] : undefined;
    runGitAction("pull", async () => {
      await gitPull(state.rootPath, remote, branch || undefined);
      await refreshGitAll();
    });
  }

  // 推送本地提交到远端（底部同步栏的 ↑ 计数区点击触发）
  function handlePush() {
    if (!state.rootPath || state.gitSyncBusy || state.gitBranchBusy) return;
    const status = state.gitStatus || {};
    const branch = status.currentBranch || "";
    const remote = status.upstream ? String(status.upstream).split("/")[0] : undefined;
    runGitAction("push", async () => {
      await gitPush(state.rootPath, remote, branch || undefined, !status.upstream);
      await refreshGitAll();
    });
  }

  // 切换分支（底部同步栏的分支下拉选中后触发）
  // 破坏性操作：先二次确认（切换分支会改变工作区内容，未提交改动可能受影响）。
  // 独立于 gitBusy：避免复用 runGitAction 的忙碌名导致按钮语义混乱；完成后统一刷新。
  function handleCheckoutBranch(branch) {
    const name = branch && branch.name;
    if (!state.rootPath || !name || state.gitBranchBusy || state.gitBusy) return;
    const from = String((state.gitStatus && state.gitStatus.currentBranch) || "").trim();
    openConfirmDialog({
      title: t("git.switchBranch", "切换分支"),
      message: t("git.checkoutConfirm", "确定切换到分支「{{name}}」？未提交的改动可能受影响（当前：{{from}}）", {
        name,
        from: from || "-",
      }),
      confirmLabel: t("git.switchBranch", "切换分支"),
      onConfirm: async () => {
        if (state.gitBranchBusy || state.gitBusy) return;
        state.gitBranchBusy = name;
        renderGitPaneSync();
        try {
          const res = await gitCheckout(state.rootPath, name);
          if (res && res.success === false) {
            console.warn("[FileExplorer] 切换分支失败:", res.message);
            return;
          }
          state.gitSelected = null;
          state.gitPreview = null;
          await refreshGitAll();
          renderGitPreview();
        } catch (err) {
          console.warn("[FileExplorer] 切换分支异常:", err);
        } finally {
          if (!disposed) {
            state.gitBranchBusy = null;
            renderGitPaneSync();
          }
        }
      },
    });
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

    const [diffRes, fileRes] = await Promise.all([
      gitFileDiff(state.rootPath, relPath, isStaged),
      readFileContent(absPath),
    ]);
    if (disposed) return;
    // 异步期间用户可能已切换文件，丢弃过期结果
    if (!state.gitPreview || state.gitPreview.key !== key) return;

    // 工作区完整文件文本（供 VS Code 风格全文件差异比较及未修改行补充）
    const fullContent = typeof fileRes?.content === "string" ? fileRes.content : null;
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
      file: buildFilePreview({ name: basename(relPath), path: absPath }, fileRes),
    };
    renderGitPreview();
  }

  // 切换右侧文件查看器的「差异 / 内容」子视图
  function setGitPreviewMode(mode) {
    if (!state.gitPreview) return;
    const next = mode === "content" ? "content" : "diff";
    if (state.gitPreview.mode === next) return;
    state.gitPreview = { ...state.gitPreview, mode: next };
    renderGitPreview();
    // 切到内容模式且为 Markdown 时，需回填本地图片（内容 DOM 是重建的）
    const p = state.gitPreview.file;
    if (next === "content" && p && p.kind === "text" && p.isMarkdown && p.html) {
      inlineMarkdownImages(p.path);
    }
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
   * 加载目录的直接子节点；Java 源码根目录只在用户展开时构造包树。
   * @param {Object} entry 要展开的真实目录条目
   * @returns {Promise<void>}
   */
  async function loadDirectoryChildren(entry) {
    const filtered = (entries) =>
      sortEntries(filterExcludedEntries(entries, state.rootPath, viewFilterOpts()));
    const isJavaSourceRoot =
      state.viewSettings.javaPackageView &&
      state.javaProject &&
      Array.isArray(state.javaProject.sourceRoots) &&
      state.javaProject.sourceRoots.some((root) => pathKey(root) === pathKey(entry.path));

    if (isJavaSourceRoot) {
      entry.children = await loadJavaPackageTree(entry.path, filtered);
      entry.isJavaSourceRoot = true;
      return;
    }

    const sub = await readDirectoryEntries(entry.path);
    entry.children = filtered(sub, entry.path);
  }

  /**
   * 递归收集仓库内所有 .gitignore 规则（浅层在前、深层在后，深层覆盖浅层）
   * @description 与 git 语义一致：每层目录的 .gitignore 相对于自身生效。
   *   扫描时对已被忽略 / 元数据目录剪枝，避免进入 node_modules 等海量目录。
   * @param {string} dir 当前扫描目录绝对路径
   * @param {Array} rules 规则累加器
   */
  async function collectGitignoreRules(dir, rules, _isRoot = false) {
    if (disposed) return;
    let entries;
    try {
      entries = await readDirectoryEntries(dir);
    } catch {
      return;
    }
    const base = getRelativeGitPath(dir, state.rootPath);
    const gitignoreEntry = entries.find((e) => e && e.name === ".gitignore" && !e.isDirectory);
    if (gitignoreEntry) {
      const res = await readFileContent(gitignoreEntry.path);
      if (res && !res.isBinary && typeof res.content === "string") {
        rules.push(...parseGitignore(res.content, base));
      }
    }
    const children = entries.filter((e) => {
      if (!e || !e.isDirectory) return false;
      // 规则始终用于标记浅色条目，同时继续剪枝避免扫描被忽略的大型目录。
      if (isExcludedMeta(e.name)) return false;
      const rel = getRelativeGitPath(e.path, state.rootPath);
      return !(rel && isIgnoredByRules(rel, true, rules));
    });
    for (const child of children) {
      if (disposed) return;
      await collectGitignoreRules(child.path, rules, false);
    }
  }

  // 扫描并重建 .gitignore 规则。无论过滤开关状态如何都保留规则，关闭时只改变显示策略。
  async function reloadGitignore() {
    if (!state.rootPath) {
      state.gitignoreRules = [];
      return;
    }
    const rules = [];
    await collectGitignoreRules(state.rootPath, rules, true);
    if (disposed) return;
    state.gitignoreRules = rules;
  }

  // 切换视图开关：持久化后重新加载数据
  async function toggleViewSetting(key) {
    state.viewSettings = { ...state.viewSettings, [key]: !state.viewSettings[key] };
    saveViewSettings(api, state.viewSettings);
    if (key === "respectGitignore") await reloadGitignore();
    if (key === "javaPackageView") {
      // 普通目录树与 Java 虚拟包树的 children 结构不同，必须从根重新加载。
      state.expanded = Object.create(null);
      state.menuOpen = false;
      await loadRoot();
      return;
    }
    if (key === "onlyGitChanges") {
      // 关闭菜单，并重建主视图以在「文件树 / Git 变更」之间切换
      state.menuOpen = false;
      if (!state.viewSettings.onlyGitChanges) {
        // 离开 Git 变更视图：清空查看器状态，否则切回时会残留显示上次打开的比对
        state.gitPreview = null;
        state.gitSelected = null;
      }
      render();
      if (state.viewSettings.onlyGitChanges && !state.gitStatus) {
        await refreshGitViewStatus();
      }
      return;
    }
    await loadRoot();
  }

  // 3. 加载根目录
  async function loadRoot() {
    if (!state.rootPath) {
      state.status = "";
      renderToolbar();
      renderTree();
      return;
    }
    state.status = t("status.loading", "加载中…");
    renderToolbar();
    try {
      const entries = await readDirectoryEntries(state.rootPath);
      if (disposed) return;
      state.rootNodes = sortEntries(filterExcludedEntries(entries, state.rootPath, viewFilterOpts()));
      // 加载成功后清空状态文案（不再显示条目计数）
      state.status = "";
    } catch {
      if (disposed) return;
      state.rootNodes = [];
      state.status = t("error.readRoot", "无法读取根目录");
    }
    renderToolbar();
    renderTree();
  }

  // 4. 切换文件夹展开与收起
  async function toggleDir(entry) {
    const next = !state.expanded[entry.path];
    state.expanded[entry.path] = next;
    if (next && !Array.isArray(entry.children)) {
      try {
        await loadDirectoryChildren(entry);
      } catch {
        // Java 包树失败时保持普通目录可用，当前节点显示为空而不是冒泡到 UI。
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
          truncated: false,
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
    state.menuOpen = false;
    renderToolbar();
    state.contextMenu = { entry, x, y };
    renderContextMenu();
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
    const truncated = text.length > MAX_PREVIEW_CHARS;
    const displayText = truncated ? text.slice(0, MAX_PREVIEW_CHARS) : text;
    const isMarkdown = isMarkdownPath(entry.name);

    // Markdown 文件默认进入预览模式：额外生成净化 HTML（代码模式复用语法高亮）
    const html = isMarkdown ? renderMarkdownHtml(displayText) : "";

    return {
      kind: "text",
      name: entry.name,
      path: entry.path,
      text: displayText,
      highlightedHtml: highlightCodeHtml(displayText, extname(entry.name)),
      truncated,
      isMarkdown,
      mode: "preview",
      html,
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

    // 智能联动全屏：非全屏模式下点击具体文件自动全屏展开代码大视野
    if (!isRightPanelFullscreen()) {
      const fullscreenReady = await ensureRightPanelFullscreen();
      if (!fullscreenReady) {
        setOperationStatus(false, "无法进入右侧面板全屏");
      }
    }

    state.preview = {
      kind: "loading",
      name: entry.name,
      path: entry.path,
    };
    // 仅更新文件树选中高亮与右侧预览，不重建整个主视图（保留树滚动与选区）
    renderTree();
    renderPreview();

    try {
      const result = await readFileContent(entry.path);
      if (disposed || requestId !== previewRequestId || pathKey(entry.path) !== pathKey(state.selected)) return;
      state.preview = buildFilePreview(entry, result);
      renderPreview();

      // 本地相对图片按需读取为 data URL 后回填（异步，不阻塞首屏）
      if (state.preview.kind === "text" && state.preview.isMarkdown && state.preview.html) {
        inlineMarkdownImages(entry.path);
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

  // 5.2 切换 Markdown 的预览 / 代码模式
  function setPreviewMode(mode) {
    const next = mode === "code" ? "code" : "preview";
    if (state.preview.mode === next) return;
    state.preview = {
      ...state.preview,
      mode: next,
      // Markdown 回到预览模式时强制退出编辑，预览 DOM 永远不可编辑。
      editable: false,
      saveState: "idle",
      saveMessage: "",
    };
    renderPreview();
    // 切回预览模式时需重新触发本地图片内联（预览 DOM 是重建的）
    if (next === "preview" && state.preview.kind === "text" && state.preview.isMarkdown) {
      inlineMarkdownImages(state.preview.path);
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

  // 保存只接受当前文件的完整未截断文本；写入完成后再更新高亮和 Git 状态。
  async function handleSavePreview() {
    if (
      !state.preview ||
      state.preview.kind !== "text" ||
      !state.preview.editable ||
      state.preview.truncated ||
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
      state.preview.highlightedHtml = highlightCodeHtml(content, extname(state.preview.name));
      state.preview.html = state.preview.isMarkdown ? renderMarkdownHtml(content) : "";
      state.preview.saveState = "saved";
      state.preview.saveMessage = "";
      renderPreview();
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

  // 视图选项下拉菜单（三点按钮触发）：同步到固定的菜单容器内
  // 菜单只涉及按钮与下拉，重建其内容不会打断输入框 / 文本选区
  function syncViewMenu(wrap) {
    if (!wrap) return;
    wrap.replaceChildren();

    const moreBtn = el("button", "sfe-btn-icon" + (state.menuOpen ? " active" : ""));
    moreBtn.type = "button";
    moreBtn.title = t("action.viewOptions", "视图选项");
    moreBtn.setAttribute("aria-haspopup", "true");
    moreBtn.setAttribute("aria-expanded", state.menuOpen ? "true" : "false");
    moreBtn.appendChild(createActionIcon("more", 15));
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.menuOpen = !state.menuOpen;
      renderToolbar();
    });
    wrap.appendChild(moreBtn);

    if (state.menuOpen) {
      const menu = el("div", "sfe-menu");
      menu.addEventListener("click", (e) => e.stopPropagation());

      const item = (key, label) => {
        const on = !!state.viewSettings[key];
        const row = el("button", "sfe-menu-item");
        row.type = "button";
        row.setAttribute("role", "menuitemcheckbox");
        row.setAttribute("aria-checked", on ? "true" : "false");
        row.appendChild(el("span", "sfe-menu-label", label));
        row.appendChild(el("span", "sfe-switch" + (on ? " on" : "")));
        row.addEventListener("click", () => {
          toggleViewSetting(key);
        });
        return row;
      };

      menu.appendChild(item("respectGitignore", t("settings.respectGitignore", "按 .gitignore 过滤")));
      menu.appendChild(item("onlyGitChanges", t("settings.onlyGitChanges", "只显示 Git 变更")));
      if (
        state.javaProject &&
        Array.isArray(state.javaProject.sourceRoots) &&
        state.javaProject.sourceRoots.length
      ) {
        menu.appendChild(item("javaPackageView", t("settings.javaPackageView", "Java 包结构视图")));
      }

      wrap.appendChild(menu);
    }
  }

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
    const layout = el("div", "sfe-container");

    const toolbar = el("div", "sfe-toolbar");
    const pathText = el("div", "sfe-toolbar-path");
    const actions = el("div", "sfe-toolbar-actions");
    const statusEl = el("span", "sfe-toolbar-status");
    statusEl.hidden = true;
    actions.appendChild(statusEl);

    // 刷新按钮：重新拉取文件树与 Git 状态
    const refreshBtn = el("button", "sfe-btn-icon");
    refreshBtn.type = "button";
    refreshBtn.title = t("action.refresh", "刷新目录");
    refreshBtn.appendChild(createActionIcon("refresh", 13));
    refreshBtn.addEventListener("click", () => {
      refreshAll();
    });
    actions.appendChild(refreshBtn);

    // 「差异 / 内容」切换容器：紧邻刷新按钮，仅在 Git 变更视图且已打开文件时显示
    // （容器固定，内容由 renderGitViewSwitchInToolbar 按需同步，避免重建工具栏）
    const gitViewSwitchWrap = el("div", "sfe-toolbar-git-view");
    gitViewSwitchWrap.hidden = true;
    actions.appendChild(gitViewSwitchWrap);

    // 三点下拉：常用视图开关（容器固定，内容按需同步）
    const menuWrap = el("div", "sfe-menu-wrap");
    actions.appendChild(menuWrap);

    toolbar.appendChild(pathText);
    toolbar.appendChild(actions);
    layout.appendChild(toolbar);
    const mainView = el("div", "sfe-main-view");
    layout.appendChild(mainView);
    // 底部状态栏（分支切换 + Git 同步 + ↑↓ 计数）：文件树与 Git 变更视图共用，
    // 挂在 layout 上（不随 mainView 重建而消失），常驻可见。
    const syncBar = el("div", "sfe-sync-bar");
    layout.appendChild(syncBar);
    root.appendChild(layout);
    container.appendChild(root);

    layoutEls = {
      root,
      layout,
      mainView,
      syncBar,
      pathText,
      statusEl,
      gitViewSwitchWrap,
      menuWrap,
      treePane: null,
      previewPane: null,
      gitPane: null,
      gitPreviewPane: null,
    };
    return layoutEls;
  }

  // 同步工具栏（路径、状态、三点菜单）
  function renderToolbar() {
    if (!layoutEls) return;
    const { pathText, statusEl, menuWrap } = layoutEls;
    const name = state.rootPath ? basename(state.rootPath) : "-";
    if (pathText.textContent !== name) pathText.textContent = name;
    if (pathText.title !== (state.rootPath || "")) pathText.title = state.rootPath || "";
    if (state.status) {
      if (statusEl.textContent !== state.status) statusEl.textContent = state.status;
      statusEl.hidden = false;
    } else {
      statusEl.hidden = true;
    }
    syncViewMenu(menuWrap);
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
    if (!state.viewSettings.onlyGitChanges || !gp || !isRightPanelFullscreen()) {
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
    const { mainView } = layoutEls;
    mainView.replaceChildren();
    // 视图切换会清空 mainView；旧底栏虽挂在 layout 上未丢失，但其中可能残留
    // 已脱离文档的分支下拉节点，重建前先移除旧底栏骨架，避免复用脱离的 DOM。
    resetGitSyncBar(layoutEls.syncBar);
    renderGitViewSwitchInToolbar();
    layoutEls.treePane = null;
    layoutEls.previewPane = null;
    layoutEls.gitPane = null;
    layoutEls.gitPreviewPane = null;

    if (state.viewSettings.onlyGitChanges) {
      buildGitView(mainView);
      renderGitPane();
      renderGitPreview();
      renderGitPaneSync();
      return;
    }
    buildFileView(mainView);
    renderTree();
    renderPreview();
    renderGitPaneSync();
  }

  // 构建文件树视图骨架（左树 + 右预览）
  function buildFileView(mainView) {
    const treePane = el("div", "sfe-tree-pane");
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
      copied: state.copied,
      onCopy: handleCopyCode,
      onSetMode: setPreviewMode,
      onToggleEdit: setPreviewEditable,
      onEditInput: handlePreviewInput,
      onSave: handleSavePreview,
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
      // 底部同步栏：左侧分支切换 + Git 同步（点击执行 pull / push），右侧 ↓/↑ 计数（0 灰、>0 彩色，点击分别拉取/推送）
      syncBusy: state.gitSyncBusy,
      branchBusy: state.gitBranchBusy,
      onSync: handleSync,
      onPull: handlePull,
      onPush: handlePush,
      loadBranches: gitBranches,
      onCheckout: handleCheckoutBranch,
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

  // 局部：仅底部同步栏（分支 / 同步进行态 / 未推送未拉取计数变化）
  // 底栏挂在 layout.syncBar 上，文件树与 Git 变更视图共用。
  function renderGitPaneSync() {
    if (disposed || !layoutEls || !layoutEls.syncBar) return;
    renderGitSyncBar(layoutEls.syncBar, gitViewOptions());
  }

  // 局部：Git 右侧文件查看器（差异 / 内容）
  function renderGitPreview() {
    if (disposed || !layoutEls || !layoutEls.gitPreviewPane) return;
    renderCodeViewer(layoutEls.gitPreviewPane, {
      preview: gitPreviewView(),
      copied: state.copied,
      onCopy: handleCopyCode,
      onSetMode: setPreviewMode,
      onSetDiffMode: setDiffMode,
      t,
    });
    // 「差异 / 内容」切换位于工具栏，需随查看器同步（打开/切换文件、切换子视图）
    renderGitViewSwitchInToolbar();
  }

  // 局部：按当前视图刷新「正在使用的」查看器（复制按钮反馈用）
  function renderActiveViewer() {
    if (state.viewSettings.onlyGitChanges) renderGitPreview();
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
    if (!state.menuOpen) return;
    const wrap = container.querySelector(".sfe-menu-wrap");
    if (wrap && !wrap.contains(e.target)) {
      state.menuOpen = false;
      renderToolbar();
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
        refreshAll();
      }
      wasActive = isActiveNow;
    });
    tabPaneObserver.observe(tabPaneEl, { attributes: true, attributeFilter: ["class"] });
  }

  // 宿主窗口切回感知（用户从外部应用切回 Snow App 时刷新）
  const handleWindowFocus = () => {
    if (disposed) return;
    if (!tabPaneEl || tabPaneEl.classList.contains("active")) {
      refreshAll();
    }
  };
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("focus", handleWindowFocus);
  }

  let unsubGit = null;
  let unsubProjects = null;
  (async () => {
    const initialRoot = await resolveRoot();
    if (disposed) return;
    state.rootPath = initialRoot || "";
    // 读取持久化的视图开关，并按需加载 .gitignore
    state.viewSettings = await loadViewSettings(api);
    if (disposed) return;
    // 读取持久化的提交按钮模式
    try {
      if (api.storage && typeof api.storage.getJson === "function") {
        const mode = await api.storage.getJson("gitCommitMode");
        if (mode === "commitAndPush") state.gitCommitMode = "commitAndPush";
      }
    } catch {
      // 忽略读取失败，使用默认模式
    }
     // 读取持久化的差异展示模式（unified / split）
    state.diffMode = await loadDiffViewMode(api);
    if (disposed) return;
    await reloadGitignore();
    if (disposed) return;
    // 初始渲染只建立骨架；统一刷新会先完成 Java 项目识别，再加载根目录。
    render();
    await refreshAll();
    if (disposed) return;
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
    container.replaceChildren();
  };
}

// 默认导出与命名导出双重兼容
export default { mount };
