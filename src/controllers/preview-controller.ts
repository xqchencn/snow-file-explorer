/**
 * 预览控制器 (src/controllers/preview-controller.ts)
 * @description 文件预览的打开 / 编辑 / 保存、Markdown 水合、行内图片回填、
 *   文件搜索（防抖 + 序列号防过期）、搜索跳行定位、复制反馈与删除后的预览清理。
 *   从 index.ts mount 闭包原样迁出；原闭包变量 disposed / layoutEls / 渲染回调
 *   改由 deps 注入，函数体保持逐字不变（仅标识符替换）。
 */

import type { PluginRuntimeApi } from "../types/plugin-runtime.ts";
import type { TranslateFn } from "../types/panel-state.ts";
import type { FileContentResult, FileSearchResult } from "../types/host/host-workspace.ts";
import type { FileTreeEntry, ErrorLike } from "../services/file-service.ts";
import type { PanelState, LayoutEls, PanelPreviewState } from "../state/panel-state.ts";
import { pathKey, MAX_PREVIEW_BYTES } from "../state/panel-state.ts";
import { copyToClipboard, humanSize } from "../utils/dom.ts";
import { basename, relativePath, readFileContent, writeFileContent } from "../services/file-service.ts";
import {
  isMarkdownPath,
  resolveMarkdownAssetPath,
  readImageAsDataUrl,
} from "../services/markdown-asset.ts";
import { shouldVirtualize } from "../components/highlight-policy.ts";
import { filterExcludedEntries } from "../services/file-filter.ts";
import { loadChunk } from "../services/lazy-chunk.ts";
import { syncViewerChrome } from "../components/code-viewer.ts";
import type { CodePreviewMode } from "../components/code-viewer.ts";
import {
  waitForNextFrame,
  isRightPanelFullscreen,
  ensureRightPanelFullscreen,
} from "../utils/panel-fullscreen.ts";

/** 预览控制器的注入依赖：渲染回调与跨控制器回调由 mount 装配阶段回填。 */
export type PreviewControllerDeps = {
  state: PanelState;
  t: TranslateFn;
  api: PluginRuntimeApi;
  isDisposed(): boolean;
  getLayout(): LayoutEls | null;
  /** 插件挂载根容器（inlineMarkdownImages 在其中找当前 Markdown 正文）。 */
  container: HTMLElement;
  /** 宿主 preload API（window.snow，searchFiles 用）。 */
  snowApi(): import("../types/snow-api.ts").SnowApi | null;
  /** 渲染层回调。 */
  renderPreview(): void;
  renderActiveViewer(): void;
  renderTree(): void;
  applyTreeSelectionHighlight(): void;
  setOperationStatus(ok: boolean, error?: string): void;
  /** 跨控制器回调（mount 装配晚绑定）。 */
  refreshGitAll(): Promise<void>;
  copyPathText(text: string): Promise<boolean>;
  handleRevealInExplorer(entry: { path: string } | null): Promise<void>;
  expandTreeToPath(targetPath: string): Promise<void>;
  scrollTreeToSelected(): void;
  yieldRightDockToCode(): void;
  viewFilterOpts(): import("../services/file-filter.ts").ExclusionFilterOptions;
  invalidateGitDiffCache(): void;
};

export function createPreviewController(deps: PreviewControllerDeps) {
  const { state, t, api } = deps;
  const isDisposed = deps.isDisposed;
  const getLayout = deps.getLayout;

  let previewRequestId = 0;
  let saveRequestId = 0;
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let searchSeq = 0;

  /**
   * 由宿主文件读取结果构造预览状态对象。
   * @description 同时供 Git 变更视图的内容模式复用，避免重复构造预览状态。
   */
  function buildFilePreview(
    entry: Pick<FileTreeEntry, "name" | "path">,
    result: FileContentResult | null,
  ): PanelPreviewState {
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

  /**
   * 双击文件：打开该文件并直接进入快速编辑（复用右侧预览的内联编辑态）。
   * @description 单击已负责打开预览；双击在此之上叠加「进入编辑」，避免新增独立弹窗组件。
   *   二进制 / 图片 / 非文本预览不支持编辑，setPreviewEditable 内部会拒绝。
   */
  async function handleOpenFileEdit(entry: FileTreeEntry | null) {
    if (!entry || entry.isDirectory || state.operationBusy) return;
    await previewFile(entry);
    if (isDisposed() || !state.preview || pathKey(state.preview.path) !== pathKey(entry.path)) return;
    if (state.preview.kind !== "text") return;
    setPreviewEditable(true);
  }

  /** 搜索框输入：防抖调用宿主 searchFiles；空查询即退出搜索模式。 */
  function handleSearchInput(value: string) {
    state.searchQuery = String(value ?? "");
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    const query = state.searchQuery.trim();
    if (!query || !state.rootPath) {
      state.searching = false;
      state.searchResults = [];
      deps.renderTree();
      return;
    }
    state.searching = true;
    deps.renderTree();
    const seq = ++searchSeq;
    const root = state.rootPath;
    searchTimer = setTimeout(async () => {
      searchTimer = null;
      const snow = deps.snowApi();
      let results: FileSearchResult[] = [];
      if (snow && typeof snow.searchFiles === "function") {
        try {
          results = await snow.searchFiles(root, query);
        } catch {
          results = [];
        }
      }
      if (isDisposed() || seq !== searchSeq || pathKey(root) !== pathKey(state.rootPath)) return;
      // 开启「按 .gitignore 过滤」时，搜索结果同样排除元数据项（.git 等）与被 .gitignore 命中的项。
      // 说明：宿主 searchFiles 无排除参数、且其遍历不读 .gitignore，插件只能在结果上过滤；
      // 这不会减少宿主的磁盘扫描量（搜索前的剪枝需要改宿主 Rust 侧）。
      let list = Array.isArray(results) ? results : [];
      if (state.viewSettings.respectGitignore) {
        list = filterExcludedEntries(list, root, deps.viewFilterOpts());
      }
      state.searchResults = list;
      state.searching = false;
      deps.renderTree();
    }, 300);
  }

  /** 退出搜索模式：清空查询、结果与防抖计时器，恢复文件树。 */
  function clearSearch() {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    searchSeq++;
    state.searchQuery = "";
    state.searchResults = [];
    state.searching = false;
    // 必须同步清空输入框：否则框里仍留着关键词，看上去像「点了没反应」。
    const layout = getLayout();
    if (layout && layout.searchInput) layout.searchInput.value = "";
    deps.renderTree();
  }

  /** 点击搜索结果：选中该文件、退出搜索、打开预览，并把侧边栏与代码都定位到目标（行）。 */
  async function handleSearchResultOpen(result: FileSearchResult | null, line?: number) {
    if (!result || !result.path) return;
    state.selected = new Set([result.path]);
    state.selectionAnchor = result.path;
    const target = {
      name: result.name || basename(result.path),
      path: result.path,
      isDirectory: !!result.isDirectory,
    };
    // 必须先 await 展开祖先目录：否则下面重建的树里没有该行，侧边栏无法定位。
    await deps.expandTreeToPath(target.path);
    if (isDisposed()) return;
    clearSearch();
    // 文件树已重建且目标行已存在：把侧边栏滚动到该行（选中高亮由 .selected 承担）。
    deps.scrollTreeToSelected();
    if (target.isDirectory) return;
    if (typeof line === "number") state.pendingRevealLine = line;
    void previewFile(target);
  }

  /** 预览渲染后把代码滚动容器定位到目标行（按可视行元素精确测量，兼容虚拟列表）。 */
  function revealPreviewLine(line: number) {
    if (isDisposed() || !getLayout()) return;
    const pane = getLayout()!.previewPane;
    if (!pane) return;
    const scroller = pane.querySelector(".sfe-file-viewer-code-scroll, .sfe-file-viewer-edit-scroll");
    if (!scroller) return;
    // 大文件走虚拟列表：只有 scrollToIndex 能定位到未渲染行。
    const vlist = pane.__sfeVList;
    if (vlist && typeof vlist.scrollToIndex === "function") {
      vlist.scrollToIndex(line - 1);
      return;
    }
    // 整块高亮态：行号槽逐行有元素，按行号取真实元素定位最准。
    const gutterRow = pane.querySelector<HTMLElement>(`.sfe-file-viewer-gutter-row:nth-child(${line})`);
    if (gutterRow) {
      scroller.scrollTop = Math.max(0, gutterRow.offsetTop - 4);
      return;
    }
    // 编辑态：按 textarea 行高换算（textarea 高度贴合内容）。
    const textarea = pane.querySelector(".sfe-file-viewer-textarea");
    if (textarea) {
      let lh = 20;
      try {
        const parsed = parseFloat(window.getComputedStyle(textarea).lineHeight);
        if (parsed > 0) lh = parsed;
      } catch {
        /* 测试环境可能无 getComputedStyle */
      }
      scroller.scrollTop = Math.max(0, (line - 1) * lh);
      return;
    }
    let lineHeight = 20;
    try {
      const probe = pane.querySelector(".sfe-file-viewer-code-content");
      const parsed = probe ? parseFloat(window.getComputedStyle(probe).lineHeight) : NaN;
      if (parsed > 0) lineHeight = parsed;
    } catch {
      /* 测试环境可能无 getComputedStyle：沿用默认行高 */
    }
    scroller.scrollTop = Math.max(0, (line - 1) * lineHeight);
  }

  // 5. 选中并预览文件
  async function previewFile(entry: FileTreeEntry) {
    const requestId = ++previewRequestId;
    saveRequestId++;
    // 单选打开：选中集合收敛为当前文件。
    state.selected = new Set([entry.path]);
    state.selectionAnchor = entry.path;
    // 终端占着右侧时先让回底栏，这次点击的文件才能显示在代码预览里。
    deps.yieldRightDockToCode();

    // 先立刻切到「正在读取」并渲染，保证点击后马上看到反馈。
    // 全屏联动可能等待宿主 React 更新数帧（见 ensureRightPanelFullscreen），
    // 若排在 loading 之前，用户会先看到界面无响应，误以为卡死——这是体验倒退的根因。
    state.preview = {
      kind: "loading",
      name: entry.name,
      path: entry.path,
    };
    // 仅就地切换文件树选中高亮与重绘右侧预览：不重建整棵树，大目录下点文件不再卡顿
    deps.applyTreeSelectionHighlight();
    deps.renderPreview();

    // 让出当前任务，使浏览器先把「正在读取」绘制出来，再执行可能阻塞的全屏联动；
    // 否则全屏触发与 loading 渲染同处一个同步任务，绘制被推迟，点击后仍会先卡一下。
    await waitForNextFrame();

    // 智能联动全屏：非全屏模式下点击具体文件自动全屏展开代码大视野
    if (!isRightPanelFullscreen()) {
      const fullscreenReady = await ensureRightPanelFullscreen();
      if (!fullscreenReady) {
        deps.setOperationStatus(false, "无法进入右侧面板全屏");
      }
    }

    try {
      // 巨型文件先挡在读取之前：宿主 readFileContent 没有长度参数，一旦发起就是整份文件
      // 跨 IPC 进内存，再叠上分行与文本扫描，表现为整个面板假死。
      if (typeof entry.size === "number" && entry.size > MAX_PREVIEW_BYTES) {
        state.preview = {
          kind: "error",
          name: entry.name,
          path: entry.path,
          message: t("preview.fileTooLarge", "文件（{{size}}）过大，无法预览，请改用外部编辑器打开", {
            size: humanSize(entry.size),
          }),
        };
        deps.renderPreview();
        return;
      }
      const result = await readFileContent(entry.path);
      if (isDisposed() || requestId !== previewRequestId || !state.selected.has(entry.path)) return;
      // 列目录没给尺寸时（size 缺省）按宿主回传的 size 兜底，判定同一阈值。
      if (typeof result?.size === "number" && result.size > MAX_PREVIEW_BYTES) {
        state.preview = {
          kind: "error",
          name: entry.name,
          path: entry.path,
          message: t("preview.fileTooLarge", "文件（{{size}}）过大，无法预览，请改用外部编辑器打开", {
            size: humanSize(result.size),
          }),
        };
        deps.renderPreview();
        return;
      }
      state.preview = buildFilePreview(entry, result);
      deps.renderPreview();
      if (state.pendingRevealLine) {
        const line = state.pendingRevealLine;
        state.pendingRevealLine = null;
        if (state.preview.kind === "text") {
          requestAnimationFrame(() => {
            if (!isDisposed()) revealPreviewLine(line);
          });
        }
      }
      if (state.preview.kind === "text" && state.preview.isMarkdown && state.preview.mode === "preview") {
        void hydrateFileMarkdown(requestId);
      }
      return;
    } catch (err) {
      if (isDisposed() || requestId !== previewRequestId || !state.selected.has(entry.path)) return;
      state.preview = {
        kind: "error",
        name: entry.name,
        path: entry.path,
        // 条件分支已对同一表达式判真，但 TS 不跨两次 cast 复用收窄，故断言 message 非空。
        message: err && (err as ErrorLike).message ? (err as ErrorLike).message! : String(err),
      };
    }
    deps.renderPreview();
  }

  // 5.1 将 Markdown 预览中的本地相对图片读取为 data URL 后回填
  // 只改预览 DOM，不触发整体重渲染，避免打断滚动与选区
  async function inlineMarkdownImages(docPath: string) {
    const holder = deps.container.querySelector(".sfe-markdown-body");
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
        if (isDisposed() || !dataUrl || !holder.isConnected) return;
        img.setAttribute("src", dataUrl);
      })
    );
  }

  async function hydrateFileMarkdown(requestId: number) {
    const preview = state.preview;
    if (!preview || preview.kind !== "text" || !preview.isMarkdown || preview.mode !== "preview") return;
    if (shouldVirtualize(preview.text)) {
      if (isDisposed() || requestId !== previewRequestId) return;
      state.preview = { ...state.preview, mode: "code" };
      deps.renderPreview();
      return;
    }
    // 已有与当前文本同源的渲染结果就复用：marked 解析 + DOMPurify 全文净化只在首次
    // 或文本变化后付一次（html 在文本改动与保存时都会清空）。
    if (state.preview.html) {
      void inlineMarkdownImages(state.preview.path);
      return;
    }
    // 块加载失败与「宿主没挂出渲染器」同一降级：归一成 null 走下面的 return，
    // 预览保持无 html 态；不让拒绝从 void 调用点逃成 unhandled rejection。
    const mod = await loadChunk("markdown").catch(() => null);
    if (isDisposed() || requestId !== previewRequestId || !state.preview || state.preview.mode !== "preview") return;
    if (!mod || typeof mod.renderMarkdownHtml !== "function") return;
    state.preview = { ...state.preview, html: mod.renderMarkdownHtml(state.preview.text || "") };
    deps.renderPreview();
    void inlineMarkdownImages(state.preview.path);
  }

  // 5.2 切换 Markdown 的预览 / 代码模式
  function setPreviewMode(mode: CodePreviewMode) {
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
    deps.renderPreview();
    if (next === "preview" && state.preview.kind === "text" && state.preview.isMarkdown) {
      void hydrateFileMarkdown(requestId);
    }
  }

  // 5.3 编辑状态只属于当前文件；输入时不重建 DOM，避免光标跳动。
  function setPreviewEditable(next?: boolean) {
    if (!state.preview || state.preview.kind !== "text") return;
    if (state.preview.isMarkdown && state.preview.mode !== "code") return;
    state.preview = {
      ...state.preview,
      editable: next === true,
      saveState: "idle",
      saveMessage: "",
    };
    deps.renderPreview();
  }

  function handlePreviewInput(value: string) {
    if (!state.preview || !state.preview.editable) return;
    state.preview.text = String(value ?? "");
    state.preview.saveState = "idle";
    state.preview.saveMessage = "";
    // 整篇高亮 HTML 与 text 同源才可用；文本一改立即作废，避免编辑态复用到过期配色。
    state.preview.highlightedHtml = "";
    state.preview.html = "";
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
    // 就地同步保存中态：不重建编辑区，textarea 的光标与滚动得以保留。
    if (!syncPreviewChrome()) deps.renderPreview();

    const result = await writeFileContent(api, filePath, content);
    if (
      isDisposed() ||
      saveId !== saveRequestId ||
      !state.preview ||
      pathKey(state.preview.path) !== pathKey(filePath)
    ) return;

    if (result && result.ok === true) {
      state.preview.highlightedHtml = "";
      state.preview.html = "";
      // 磁盘内容已变，Git 预览里缓存的 diff / 工作区全文随之过期。
      deps.invalidateGitDiffCache();
      state.preview.saveState = "saved";
      state.preview.saveMessage = "";
      if (!syncPreviewChrome()) deps.renderPreview();
      if (state.preview.isMarkdown && state.preview.mode === "preview") {
        void hydrateFileMarkdown(previewRequestId);
      }
      await deps.refreshGitAll();
    } else {
      state.preview.saveState = "failed";
      state.preview.saveMessage =
        result && result.error === "当前宿主未提供文件写入能力"
          ? t("preview.editUnavailable", "当前宿主未提供文件写入能力")
          : result && result.error
            ? String(result.error)
            : t("action.saveFailed", "保存失败");
      if (!syncPreviewChrome()) deps.renderPreview();
    }
  }

  // 复制 / 保存等微状态变化：优先走查看器注册的就地同步通道（只翻转按钮与提示条），
  // 不为翻转一个按钮销毁重建整个预览（那会连带虚拟列表与可视行高亮全部重来）。
  // 容器上没有同步句柄（非文本预览 / 尚未渲染）时退回整体重渲染。
  function syncPreviewChrome(): boolean {
    const layout = getLayout();
    if (!layout) return false;
    const pane =
      state.mainView === "git"
        ? layout.gitPreviewPane
        : state.mainView === "http"
          ? layout.httpPreviewPane
          : layout.previewPane;
    if (!pane) return false;
    // 保存状态只属于走 state.preview 的面板（files 与 http 都走这一条通道）；
    // Git 查看器内容来自 gitPreviewView 的新对象，不得消费 files 的保存态，
    // 否则会在 Git 面板画出无关的「已保存」提示条。
    const ownsSaveState = state.mainView !== "git";
    return syncViewerChrome(pane, {
      copied: state.copied,
      saving: ownsSaveState && state.preview.saveState === "saving",
      saveState: ownsSaveState ? state.preview.saveState || "idle" : "idle",
      saveMessage: ownsSaveState ? state.preview.saveMessage || "" : "",
    });
  }

  // 6. 复制当前代码
  async function handleCopyCode() {
    if (!state.preview || state.preview.kind !== "text" || !state.preview.text) return;
    const ok = await copyToClipboard(state.preview.text);
    if (!ok) return;

    state.copied = true;
    if (!syncPreviewChrome()) deps.renderActiveViewer();
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      if (isDisposed()) return;
      state.copied = false;
      if (!syncPreviewChrome()) deps.renderActiveViewer();
    }, 1600);
  }

  /** 若当前预览文件位于被删除路径之下，则清空预览（避免继续显示已不存在的内容）。 */
  function resetPreviewForDeletedPaths(deletedPaths: string[]) {
    const currentPath = state.preview && state.preview.path;
    if (!currentPath) return false;
    const currentKey = pathKey(currentPath);
    const hit = deletedPaths.some((p) => {
      const dk = pathKey(p);
      return currentKey === dk || currentKey.startsWith(dk + "/");
    });
    if (!hit) return false;
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
    deps.renderPreview();
    return true;
  }

  /** 从选中集合与 shift 锚点中移除被删除路径及其子路径。 */
  function pruneSelectionForDeletedPaths(deletedPaths: string[]) {
    const keys = deletedPaths.map(pathKey);
    const hit = (p: string) => {
      const pk = pathKey(p);
      return keys.some((dk: string) => pk === dk || pk.startsWith(dk + "/"));
    };
    const next = new Set<string>();
    for (const p of state.selected) {
      if (!hit(p)) next.add(p);
    }
    state.selected = next;
    if (state.selectionAnchor && hit(state.selectionAnchor)) state.selectionAnchor = null;
  }

  // 普通预览区的文件操作只针对当前打开文件，不污染文件树菜单或 Git 差异查看器。
  function handlePreviewRevealFile() {
    const filePath = state.preview && state.preview.path;
    if (!filePath) return;
    void deps.handleRevealInExplorer({ path: filePath });
  }

  function handlePreviewCopyPath() {
    const filePath = state.preview && state.preview.path;
    if (!filePath) return;
    void deps.copyPathText(filePath);
  }

  function handlePreviewCopyRelativePath() {
    const filePath = state.preview && state.preview.path;
    if (!filePath || !state.rootPath) return;

    const value = relativePath(state.rootPath, filePath);
    if (value == null) {
      deps.setOperationStatus(false, "目标路径不在当前工作区内");
      return;
    }

    void deps.copyPathText(value);
  }

  // 只读态右键「刷新」：重新从磁盘读取当前文件（编辑态不显示该项，避免丢弃未保存修改）。
  async function handlePreviewRefresh() {
    const current = state.preview;
    if (!current || !current.path) return;
    const filePath = current.path;
    const name = current.name;
    // 先回到加载态给即时反馈，再用最新磁盘内容重建预览
    state.preview = { kind: "loading", name, path: filePath };
    deps.renderPreview();
    const result = await readFileContent(filePath);
    if (isDisposed() || !state.preview || pathKey(state.preview.path) !== pathKey(filePath)) return;
    state.preview = buildFilePreview({ name, path: filePath }, result);
    deps.renderPreview();
  }

  /** 切换项目 / 卸载后作废在途的预览与保存回调（原 applyActiveProject 里的计数器自增）。 */
  function bumpRequestIds(): void {
    previewRequestId++;
    saveRequestId++;
  }

  /** 卸载：清掉复制反馈与搜索防抖的定时器。 */
  function release(): void {
    if (copiedTimer) {
      clearTimeout(copiedTimer);
      copiedTimer = null;
    }
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
  }

  return {
    buildFilePreview,
    previewFile,
    handleOpenFileEdit,
    handleSearchInput,
    clearSearch,
    handleSearchResultOpen,
    revealPreviewLine,
    inlineMarkdownImages,
    setPreviewMode,
    setPreviewEditable,
    handlePreviewInput,
    handleSavePreview,
    handleCopyCode,
    resetPreviewForDeletedPaths,
    pruneSelectionForDeletedPaths,
    handlePreviewRevealFile,
    handlePreviewCopyPath,
    handlePreviewCopyRelativePath,
    handlePreviewRefresh,
    bumpRequestIds,
    release,
  };
}
