/**
 * Git 控制器 (src/controllers/git-controller.ts)
 * @description Git 状态应用与刷新、写操作串行队列、暂存/提交/同步/丢弃、
 *   右侧差异查看器的取数缓存与子视图切换、AI 提交信息生成。
 *   从 index.ts mount 闭包原样迁出；原闭包变量 disposed / layoutEls / 渲染回调
 *   改由 deps 注入，函数体保持逐字不变（仅标识符替换）。
 */

import type { PluginRuntimeApi } from "../types/plugin-runtime.ts";
import type { TranslateFn, GitOperation, DiffViewMode } from "../types/panel-state.ts";
import type { GitStatusResult, GitFileStatus } from "../types/host/host-git.ts";
import type {
  PanelState,
  LayoutEls,
  ConfirmDialogState,
  LoadGitPreviewDiffArgs,
  PanelPreviewState,
  GitPreviewState,
  GitActionQueueItem,
} from "../state/panel-state.ts";
import { pathKey } from "../state/panel-state.ts";
import {
  getGitStatus,
  partitionGitFiles,
  collectGitFolderPaths,
  gitFilesSignature,
} from "../services/git-service.ts";
import type { GitStatusMap } from "../services/git-service.ts";
import type { GitSection, GitCommitMode } from "../components/git-view.ts";
import type { GitViewerMode, CodePreviewDiff } from "../components/code-viewer.ts";
import { saveDiffViewMode } from "../services/settings.ts";
import {
  requestRightPanelFullscreen,
  isRightPanelFullscreen,
} from "../utils/panel-fullscreen.ts";
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
} from "../services/git-actions.ts";
import { parseUnifiedDiff } from "../services/diff.ts";
import { loadChunk } from "../services/lazy-chunk.ts";
import { basename, workspaceRelativePath, readFileContent } from "../services/file-service.ts";
import { joinPath } from "../services/file-filter.ts";
import { isOversizeMarkdown } from "../services/markdown-asset.ts";
import { paintTreeGitStatus } from "../components/tree-view.ts";

/** Git 控制器的注入依赖：渲染回调与跨控制器回调由 mount 装配阶段回填。 */
export type GitControllerDeps = {
  state: PanelState;
  t: TranslateFn;
  api: PluginRuntimeApi;
  /** 面板是否已卸载（原闭包变量 disposed 的只读访问）。 */
  isDisposed(): boolean;
  /** 骨架 DOM 引用（原闭包变量 layoutEls 的读取）。 */
  getLayout(): LayoutEls | null;
  /** 插件挂载根容器（updateCommitInput 就地找提交输入框用）。 */
  getContainer(): HTMLElement;
  /** 渲染层回调（index.ts 渲染分区，函数声明提升后引用）。 */
  renderGitPane(): void;
  renderGitPaneCommit(): void;
  renderGitPreview(): void;
  syncGitIndicator(): void;
  /** 打开插件内确认弹窗（丢弃更改的破坏性确认）。 */
  openConfirmDialog(dialog: ConfirmDialogState): boolean;
  /** 跨控制器回调（mount 装配晚绑定）。 */
  loadRoot(options?: { followups?: boolean }): Promise<void>;
  buildFilePreview(
    entry: { name: string; path: string },
    result: import("../types/host/host-workspace.ts").FileContentResult | null,
  ): PanelPreviewState;
  inlineMarkdownImages(docPath: string): Promise<void>;
  /** 代码要占右侧时，把右侧停靠的终端/运行窗口放回底栏。 */
  yieldRightDockToCode(): void;
  /** 复制文本到系统剪贴板（宿主 system.writeClipboardText 优先）。 */
  copyPathText(text: string): Promise<boolean>;
  /** 在资源管理器中打开（宿主 system.showItemInFolder）。 */
  handleRevealInExplorer(entry: { path: string } | null): Promise<void>;
};

export function createGitController(deps: GitControllerDeps) {
  const { state, t, api } = deps;
  const isDisposed = deps.isDisposed;
  const getLayout = deps.getLayout;

  // 统一的 Git 刷新：同一次 snow.gitStatus 同时更新染色、变更列表和同步栏。
  // 同源短路：内容未变化时跳过 render。render 会整体 replaceChildren 重建 DOM，
  // 从而销毁滚动位置与文本选区（表现为「一滑就弹回顶部 / 无法选中复制」）。
  let gitInflight: Promise<GitStatusResult | null> | null = null;
  let gitInflightRoot = "";
  let gitDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  // 进入 Git 主视图后，下一次状态回填必须重新建立默认折叠，不能复用用户上一次的展开态。
  let stagedCollapseResetPending = false;

  function isSameGitMap(a: GitStatusMap, b: GitStatusMap): boolean {
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

  /**
   * 重置本次 Git 视图的已暂存目录折叠状态。
   * @description 进入 Git 主视图时调用；先用已有状态提供即时默认值，再让下一次状态回填按最新文件集合重建。
   *   没有仓库状态或没有 staged 文件时使用空集合，避免 null 参与组件渲染。
   */
  function resetStagedCollapse(): void {
    const { staged } = partitionGitFiles(state.gitStatus?.files);
    state.collapsedStaged = state.gitStatus?.isRepo ? collectGitFolderPaths(staged) : new Set();
    stagedCollapseResetPending = true;
  }

  function gitStatusToMap(status: GitStatusResult | null): GitStatusMap {
    const map: GitStatusMap = Object.create(null);
    if (status && Array.isArray(status.files)) {
      for (const item of status.files) {
        if (!item || !item.path) continue;
        map[item.path.replace(/\\/g, "/")] = item.status;
      }
    }
    return map;
  }

  function applyGitStatus(status: GitStatusResult | null) {
    const map = gitStatusToMap(status);
    const prev = state.gitStatus;
    const prevFiles = gitFilesSignature(prev);
    const nextFiles = gitFilesSignature(status);
    state.gitStatus = status;
    if (stagedCollapseResetPending || state.collapsedStaged === null) {
      const { staged } = partitionGitFiles(status?.files);
      state.collapsedStaged = status?.isRepo ? collectGitFolderPaths(staged) : new Set();
      stagedCollapseResetPending = false;
    }
    const mapChanged = !isSameGitMap(state.gitStatusMap, map);
    if (mapChanged) {
      state.gitStatusMap = map;
      // 变更集合一变，之前缓存的差异与工作区全文都可能过期（同一 key 指向的内容已被改写）。
      gitDiffCache.clear();
    }
    // 列表重建只看「文件集合 / 分支 / 仓库状态」；ahead/behind 只喂同步指示器（顶栏 ↑/↓），
    // 一次 fetch 更新计数不该把整张变更列表重建一遍（滚动位置与选区跟着丢）。
    const repoChanged =
      (!!prev !== !!status) || (!!prev?.isRepo) !== (!!status?.isRepo);
    const branchChanged = (prev?.currentBranch || "") !== (status?.currentBranch || "");
    const listChanged = prevFiles !== nextFiles || repoChanged || branchChanged;
    const countsChanged =
      (prev?.ahead || 0) !== (status?.ahead || 0) ||
      (prev?.behind || 0) !== (status?.behind || 0);
    if (!listChanged && !countsChanged && !mapChanged) return;
    if (mapChanged && state.mainView === "files") {
      paintTreeGitStatus(getLayout() && getLayout()!.treePane, {
        rootPath: state.rootPath,
        gitStatusMap: state.gitStatusMap,
        t,
      });
    }
    deps.syncGitIndicator();
    if (state.mainView === "git" && listChanged) deps.renderGitPane();
  }

  async function refreshGitAll() {
    if (!state.rootPath || isDisposed()) return;
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
    if (isDisposed() || pathKey(state.rootPath) !== rootToken) return;
    applyGitStatus(status);
  }

  // 窗口切回与宿主 watcher 常在几百毫秒内连打，每次都发一趟全仓 status。
  // 统一走同一个尾沿防抖；不做「最小间隔抑制」，避免给用户看过期状态。
  function scheduleGitRefresh(wait = 250): void {
    if (isDisposed()) return;
    if (gitDebounceTimer) clearTimeout(gitDebounceTimer);
    gitDebounceTimer = setTimeout(() => {
      gitDebounceTimer = null;
      void refreshGitAll();
    }, wait);
  }

  // ------------------------------------------------------------------
  // Git 变更视图操作
  // ------------------------------------------------------------------
  // Git 写操作队列：串行执行，忙时入队而非丢弃。
  // 旧实现 `if (state.gitBusy) return null` 会静默吞掉忙碌期的点击（表现为「点了没反应 /
  // 要等一会 / 得先点别处」）；排队后连点会依次执行，且不会并发写同一仓库。
  const gitActionQueue: GitActionQueueItem[] = [];
  let gitActionRunning = false;
  // 写操作只登记刷新需求，由 drainGitActions 在排空后一次付清（见其中注释）。
  let gitRefreshRequested = false;
  function requestGitRefresh(): void {
    gitRefreshRequested = true;
  }

  /** 串行排空队列；每个操作执行前后同步提交栏 / 底栏的忙碌态。 */
  async function drainGitActions() {
    if (gitActionRunning) return;
    gitActionRunning = true;
    try {
      while (gitActionQueue.length && !isDisposed()) {
        const { busy, fn } = gitActionQueue.shift() as GitActionQueueItem;
        state.gitBusy = busy;
        deps.renderGitPaneCommit();
        deps.syncGitIndicator();
        try {
          await fn();
        } catch (err) {
          console.warn("[FileExplorer] Git 操作失败:", err);
        }
      }
      // 队列排空后统一刷一次：原本每个写操作自带一次全仓 status + 整表重建，
      // 连点 N 个文件暂存就要等 N 轮 status（大仓单轮可达秒级）。
      if (!isDisposed() && gitRefreshRequested) {
        gitRefreshRequested = false;
        await refreshGitAll();
      }
    } finally {
      gitActionRunning = false;
      if (!isDisposed()) {
        state.gitBusy = null;
        deps.renderGitPaneCommit();
        deps.syncGitIndicator();
      }
    }
  }

  /**
   * 执行一个 Git 写操作（忙时入队，串行执行，不丢用户点击）。
   * @param busy 进行中的操作名（用于提交栏 / 底栏忙碌态）
   * @param fn 实际写操作（内部自行 refresh）
   * @returns 队列排空完成
   */
  function runGitAction(busy: GitOperation, fn: () => Promise<void>): Promise<void> {
    gitActionQueue.push({ busy, fn });
    return drainGitActions();
  }

  function handleStageToggle(files: GitFileStatus[], section: GitSection) {
    if (!state.rootPath || !Array.isArray(files) || files.length === 0) return;
    const paths = files.map((f) => f.path);
    const isStaged = section === "staged";
    void runGitAction(isStaged ? "unstage" : "stage", async () => {
      const res = isStaged
        ? await gitUnstage(state.rootPath, paths)
        : await gitStage(state.rootPath, paths);
      if (res && res.success) state.gitSelected = null;
      requestGitRefresh();
    });
  }

  function handleStageAll() {
    if (!state.rootPath) return;
    void runGitAction("stageAll", async () => {
      await gitStageAll(state.rootPath);
      state.gitSelected = null;
      requestGitRefresh();
    });
  }

  function handleUnstageAll() {
    if (!state.rootPath) return;
    void runGitAction("unstageAll", async () => {
      await gitUnstageAll(state.rootPath);
      state.gitSelected = null;
      requestGitRefresh();
    });
  }

  function handleCommit() {
    const message = String(state.gitCommitMessage || "").trim();
    if (!state.rootPath || !message) return;
    state.gitCommitMenuOpen = false;
    void runGitAction("commit", async () => {
      const res = await gitCommit(state.rootPath, message);
      if (res && res.success) state.gitCommitMessage = "";
      requestGitRefresh();
    });
  }

  // 提交并推送：提交成功后按当前上游/分支推送
  function handleCommitAndPush() {
    const message = String(state.gitCommitMessage || "").trim();
    if (!state.rootPath || !message) return;
    state.gitCommitMenuOpen = false;
    const upstream = state.gitStatus?.upstream;
    const branch = state.gitStatus?.currentBranch || "";
    const remote = upstream ? String(upstream).split("/")[0] : undefined;
    void runGitAction("commitAndPush", async () => {
      const res = await gitCommit(state.rootPath, message);
      if (!res || !res.success) return;
      state.gitCommitMessage = "";
      state.gitBusy = "push";
      deps.renderGitPaneCommit();
      deps.syncGitIndicator();
      await gitPush(state.rootPath, remote, branch || undefined, !upstream);
      requestGitRefresh();
    });
  }

  // 同步：顶栏文件夹名右侧的同步指示器点击触发（pull → 刷新 → push）。
  // 切换分支 / 逐条拉取推送已移除（宿主内置 Git 面板已提供，插件不再重复）。
  async function handleSync() {
    if (state.gitSyncBusy || state.gitBusy || isDisposed() || !state.rootPath) return;
    state.gitSyncBusy = "sync";
    deps.syncGitIndicator();
    try {
      // 走 refreshGitAll（带在途去重）取基准状态；原先的 `state.gitStatus || await getGitStatus`
      // 绕开了去重，会和并发刷新各发一趟全仓 status。
      await refreshGitAll();
      const status = state.gitStatus;
      const result = await gitSync(state.rootPath, status, async () => {
        await refreshGitAll();
        return state.gitStatus;
      });
      if (!result.success) {
        console.warn("[FileExplorer] Git 同步失败:", result.message);
        return;
      }
      await refreshGitAll();
      // 只有真的可能拉到新提交才重载文件树：树里没有别的同步会改到的内容。
      if ((status?.behind || 0) > 0) await deps.loadRoot();
    } catch (err) {
      console.warn("[FileExplorer] Git 同步异常:", err);
    } finally {
      if (!isDisposed()) {
        state.gitSyncBusy = null;
        deps.syncGitIndicator();
      }
    }
  }

  // 设置提交按钮模式（提交 / 提交并推送），并持久化
  function handleSetCommitMode(mode: GitCommitMode) {
    state.gitCommitMode = mode === "commitAndPush" ? "commitAndPush" : "commit";
    state.gitCommitMenuOpen = false;
    if (api && api.storage && typeof api.storage.setJson === "function") {
      // 偏离（已登记）：宿主 setJson 返回 Promise，原先包它的那个同步 try/catch 挡不住它的拒绝，
      // 写失败会逃逸成 unhandled rejection。改挂 .catch，保持原 catch「静默忽略持久化失败」的语义。
      api.storage.setJson("gitCommitMode", state.gitCommitMode).catch(() => {
        // 忽略持久化失败
      });
    }
    deps.renderGitPaneCommit();
  }

  // 折叠/展开 Git 树的目录
  function handleToggleGitCollapse(section: GitSection, path: string) {
    // collapsedStaged 的初值是 null（还没按首次仓库状态建默认折叠），建表发生在 applyGitStatus，
    // 而折叠 caret 只随 Git 树一起渲染；这里为 null 就是「没有可折叠的树」，直接返回而不是抛 TypeError。
    const set = section === "staged" ? state.collapsedStaged : state.collapsedUnstaged;
    if (!set) return;
    if (set.has(path)) set.delete(path);
    else set.add(path);
    deps.renderGitPane();
  }

  // 丢弃改动：需用户确认（破坏性操作）
  function handleDiscard(files: GitFileStatus[]) {
    if (!state.rootPath || !Array.isArray(files) || files.length === 0) return;
    const label =
      files.length === 1
        ? files[0].path
        : t("git.discardCount", "{{count}} 个文件", { count: files.length });
    deps.openConfirmDialog({
      title: t("git.discardFile", "丢弃更改"),
      message: t("git.discardConfirm", "确定丢弃这些文件的更改？此操作不可撤销。\n{{label}}", { label }),
      confirmLabel: t("git.discardFile", "丢弃更改"),
      onConfirm: async () => {
        const paths = files.map((f) => f.path);
        await runGitAction("discard", async () => {
          await gitDiscardChanges(state.rootPath, paths);
          state.gitSelected = null;
          requestGitRefresh();
        });
      },
    });
  }

  /**
   * 打开 Git 变更文件的差异视图（右侧面板）
   * @description 数据层完全复用宿主 gitFileDiff（内部执行 git diff），插件只负责渲染；
   *   section 决定取暂存区（--cached）还是工作区差异，与宿主 Git 面板双击行为一致。
   * @param file GitFileStatus
   * @param section 文件所在分区
   */
  async function openGitDiff(file: GitFileStatus, section: GitSection) {
    if (!file || !state.rootPath) return;
    const isStaged = section === "staged";
    const relPath = file.path;
    const absPath = joinPath(state.rootPath, relPath);
    const key = `${section}:${relPath}`;

    // 终端占着右侧时先让回底栏，差异才能画到代码那一列。
    deps.yieldRightDockToCode();
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
    deps.renderGitPreview();

    await loadGitPreviewDiff({ key, relPath, absPath, isStaged });
  }

  // 差异取数缓存：key → 已解析的 diff（含工作区全文）。一次点击 = 一个 git 进程 + 整份文件跨 IPC，
  // 来回点同一文件、在「差异↔内容」之间切换都会重复这笔开销。失效只有两处：
  // 变更集合变化（applyGitStatus）、文件被保存，以及显式刷新（force）绕过读取。
  const gitDiffCache = new Map<string, CodePreviewDiff>();
  const GIT_DIFF_CACHE_LIMIT = 24;

  function rememberGitDiff(key: string, diff: CodePreviewDiff): void {
    gitDiffCache.set(key, diff);
    if (gitDiffCache.size > GIT_DIFF_CACHE_LIMIT) {
      const oldest = gitDiffCache.keys().next().value;
      if (oldest !== undefined) gitDiffCache.delete(oldest);
    }
  }

  /** 磁盘内容已变（保存 / 变更集合刷新）时由外部调用的缓存失效入口。 */
  function invalidateDiffCache(): void {
    gitDiffCache.clear();
  }

  // 拉取并解析指定文件的 Git 差异（含工作区完整内容），供打开与右键刷新复用。
  // 过期结果（切换了文件 / 已卸载）在内部丢弃，调用方无需重复校验。
  async function loadGitPreviewDiff({ key, relPath, absPath, isStaged, force }: LoadGitPreviewDiffArgs) {
    if (!force) {
      const cached = gitDiffCache.get(key);
      if (cached) {
        if (isDisposed() || !state.gitPreview || state.gitPreview.key !== key) return;
        state.gitPreview = { ...state.gitPreview, diff: cached };
        deps.renderGitPreview();
        return;
      }
    }
    const [diffRes, fileRes] = await Promise.all([
      gitFileDiff(state.rootPath, relPath, isStaged),
      readFileContent(absPath),
    ]);
    if (isDisposed() || !state.gitPreview || state.gitPreview.key !== key) return;

    // 工作区全文用来把未改动行补回差异视图，打开后看到的是整份文件。
    const fullContent = typeof fileRes?.content === "string" && !fileRes.isBinary && !fileRes.isImage
      ? fileRes.content
      : null;
    const diff: CodePreviewDiff = { loading: false, result: null, fullContent, error: "" };
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
    rememberGitDiff(key, diff);
    deps.renderGitPreview();
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
    deps.renderGitPreview();
    await loadGitPreviewDiff({ ...gp, force: true });
  }

  // 切换右侧文件查看器的「差异 / 内容」子视图
  function setGitPreviewMode(mode: GitViewerMode) {
    if (!state.gitPreview) return;
    const next = mode === "content" ? "content" : "diff";
    if (state.gitPreview.mode === next) return;
    const key = state.gitPreview.key;
    state.gitPreview = { ...state.gitPreview, mode: next };
    deps.renderGitPreview();
    if (next !== "content") return;
    const existing = state.gitPreview.file;
    if (existing && existing.kind === "text") {
      if (existing.isMarkdown && existing.mode === "preview") void hydrateGitMarkdown(key);
      return;
    }
    void loadGitPreviewFile(key);
  }

  async function loadGitPreviewFile(key: string) {
    const gp = state.gitPreview;
    if (!gp || gp.key !== key || !gp.absPath) return;
    state.gitPreview = {
      ...gp,
      file: { kind: "loading", name: gp.name, path: gp.absPath },
    };
    deps.renderGitPreview();
    const fileRes = await readFileContent(gp.absPath);
    if (isDisposed() || !state.gitPreview || state.gitPreview.key !== key) return;
    const file = deps.buildFilePreview({ name: gp.name, path: gp.absPath }, fileRes);
    state.gitPreview = { ...state.gitPreview, file };
    deps.renderGitPreview();
    if (file.kind === "text" && file.isMarkdown && file.mode === "preview") {
      await hydrateGitMarkdown(key);
    }
  }

  async function hydrateGitMarkdown(key: string) {
    // state.gitPreview 在挂载初值与切换项目时为 null；为 null 时下面的判空直接返回，
    // 不再伪造一个「有预览」的对象出来。
    const gp = state.gitPreview;
    const file = gp?.file;
    if (!gp || !file || gp.key !== key || !file.isMarkdown || file.mode !== "preview") return;
    if (isOversizeMarkdown(file.text)) {
      state.gitPreview = { ...gp, file: { ...file, mode: "code" } };
      deps.renderGitPreview();
      return;
    }
    // 已渲染过就复用：marked + DOMPurify 全文解析只为新文本付一次。
    if (file.html) {
      void deps.inlineMarkdownImages(file.path);
      return;
    }
    // 块加载失败（宿主取不到插件文件 / blob import 抛错）与「宿主没挂出渲染器」是同一降级：
    // 归一成 null 后走下面的 return，预览保持无 html 态；不让拒绝从 void 调用点逃成 unhandled rejection。
    const mod = await loadChunk("markdown").catch(() => null);
    if (isDisposed() || !state.gitPreview || state.gitPreview.key !== key || !state.gitPreview.file) return;
    if (!mod || typeof mod.renderMarkdownHtml !== "function") return;
    // 下面三处断言是承重的：await 之后必须重读 state.gitPreview（期间可能被别处换成另一个预览），
    // 而 TS 不会把 `!state.gitPreview.file` 的收窄穿过紧接着对 state.gitPreview 的赋值，
    // 去掉就会退化成 spread 可空类型（key 变可选）。
    state.gitPreview = {
      ...(state.gitPreview as GitPreviewState),
      file: {
        ...(state.gitPreview.file as PanelPreviewState),
        html: mod.renderMarkdownHtml(state.gitPreview.file.text || ""),
      },
    };
    deps.renderGitPreview();
    void deps.inlineMarkdownImages(state.gitPreview.file!.path);
  }

  // 切换差异展示模式（unified / split），持久化偏好并仅重绘右侧查看器
  function setDiffMode(mode: DiffViewMode) {
    const next = mode === "split" ? "split" : "unified";
    if (state.diffMode === next) return;
    state.diffMode = next;
    saveDiffViewMode(api, next);
    deps.renderGitPreview();
  }

  // 差异范围固定为完整文件，不提供范围切换。

  // 将 Git 变更视图的文件状态映射为 code-viewer 的 preview 结构
  function gitPreviewView(): PanelPreviewState | null {
    const gp = state.gitPreview;
    if (!gp) return null;
    const base = gp.file || { kind: "loading", name: gp.name, path: gp.absPath };
    return {
      ...base,
      diff: gp.diff,
      // base 为 loading 分支时没有 text，故 `?? base.text` 的类型是 string | undefined；
      // 而展开后的 kind 仍是 base 的那一支，TS 不会按分支重算 text。断言只把「与 base 同 kind」
      // 这一事实补回类型，运行时不变（loading 分支的渲染不读 text）。
      text: (gp.diff?.fullContent ?? base.text) as string,
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
    deps.renderGitPaneCommit();
    const repo = state.rootPath;
    generateCommitMessage(
      repo,
      (chunk) => {
        if (isDisposed()) return;
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
        if (isDisposed()) return;
        if (result && result.status !== "error" && result.content) {
          state.gitCommitMessage = result.content;
        }
      })
      .catch(() => {
        // 出错/取消：保留已流式生成的内容
      })
      .finally(() => {
        if (isDisposed()) return;
        state.gitGenerating = false;
        state.gitStreamId = null;
        deps.renderGitPaneCommit();
      });
  }

  function updateCommitInput() {
    // 仅就地更新提交输入框内容：AI 流式生成时每个 chunk 都会到达，
    // 整体重建提交栏会打断用户正在输入的内容与光标（基准行为，勿改成 renderGitPaneCommit）。
    const ta = deps.getContainer().querySelector<HTMLTextAreaElement>(".sfe-git-commit-input");
    if (ta) ta.value = state.gitCommitMessage;
  }

  /**
   * Git 视图的「刷新」：只重拉变更状态与当前打开的差异。
   * @description 不能复用 refreshAll —— 它会重走全仓 .gitignore 递归扫描（每个目录一次
   *   宿主 IPC）并整树重载，那属于文件树的事；混进来后大仓点一次刷新要等几十秒，
   *   而且刷新的从来不是 Git 面板。
   */
  function handleGitRefresh() {
    void (async () => {
      await refreshGitAll();
      if (isDisposed()) return;
      const gp = state.gitPreview;
      if (gp && gp.absPath) await handleGitPreviewRefresh();
    })();
  }

  async function handleGitRevealFile(file: GitFileStatus | null) {
    if (!file || !state.rootPath) return;
    await deps.handleRevealInExplorer({ path: joinPath(state.rootPath, file.path) });
  }

  function handleGitCopyRelativePath(file: GitFileStatus | null) {
    if (!file || !state.rootPath) return;
    const value = workspaceRelativePath(state.rootPath, joinPath(state.rootPath, file.path));
    if (value) void deps.copyPathText(value);
  }

  // Git 右侧查看器右键：按当前打开的差异文件（state.gitPreview.relPath/absPath）。
  async function handleGitPreviewRevealFile() {
    const gp = state.gitPreview;
    if (!gp || !gp.absPath) return;
    await deps.handleRevealInExplorer({ path: gp.absPath });
  }

  function handleGitPreviewCopyPath() {
    const gp = state.gitPreview;
    if (!gp || !gp.absPath) return;
    void deps.copyPathText(gp.absPath);
  }

  function handleGitPreviewCopyRelativePath() {
    const gp = state.gitPreview;
    if (!gp || !gp.absPath || !state.rootPath) return;
    const value = workspaceRelativePath(state.rootPath, gp.absPath);
    if (value) void deps.copyPathText(value);
  }

  function handleGitCopyAbsolutePath(file: GitFileStatus | null) {
    if (!file || !state.rootPath) return;
    void deps.copyPathText(joinPath(state.rootPath, file.path));
  }

  /** 卸载：清掉防抖定时器，并中止仍在进行的 AI 提交信息流（宿主还在往回调里灌分片）。 */
  function release(): void {
    if (gitDebounceTimer) {
      clearTimeout(gitDebounceTimer);
      gitDebounceTimer = null;
    }
    if (state.gitStreamId) abortCommitMessage(state.gitStreamId);
  }

  return {
    refreshGitAll,
    refreshGitViewStatus,
    resetStagedCollapse,
    scheduleGitRefresh,
    requestGitRefresh,
    handleStageToggle,
    handleStageAll,
    handleUnstageAll,
    handleCommit,
    handleCommitAndPush,
    handleSync,
    handleSetCommitMode,
    handleToggleGitCollapse,
    handleDiscard,
    openGitDiff,
    handleGitPreviewRefresh,
    setGitPreviewMode,
    setDiffMode,
    gitPreviewView,
    handleGenerateCommitMessage,
    handleGitRefresh,
    handleGitRevealFile,
    handleGitCopyRelativePath,
    handleGitPreviewRevealFile,
    handleGitPreviewCopyPath,
    handleGitPreviewCopyRelativePath,
    handleGitCopyAbsolutePath,
    invalidateDiffCache,
    release,
  };
}

