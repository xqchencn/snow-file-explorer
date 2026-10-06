/**
 * 文件树控制器 (src/controllers/tree-controller.ts)
 * @description 目录实时监听、树加载 / 刷新 / 展开收起、.gitignore 规则收集与应用、
 *   删除 / 重命名 / 右键动作、搜索定位所需的展开与滚动。
 *   从 index.ts mount 闭包原样迁出；原闭包变量 disposed / layoutEls / 渲染回调
 *   改由 deps 注入，函数体保持逐字不变（仅标识符替换）。
 */

import type { PluginRuntimeApi } from "../types/plugin-runtime.ts";
import type { TranslateFn } from "../types/panel-state.ts";
import type { Unsubscribe } from "../types/snow-api.ts";
import type { SnowApi } from "../types/snow-api.ts";
import type { BatchWorkspaceDeleteResult, DirectoryEntry } from "../types/host/host-workspace.ts";
import type { FileTreeEntry, ErrorLike } from "../services/file-service.ts";
import { isExcludedMeta, type GitignoreRule, type ExclusionFilterOptions } from "../services/file-filter.ts";
import { loadJvmPackageTree } from "../services/java-project.ts";
import type { PanelState, LayoutEls, ConfirmDialogState } from "../state/panel-state.ts";
import { pathKey } from "../state/panel-state.ts";
import {
  basename,
  sortEntries,
  readDirectoryEntries,
  readFileContent,
  renameFileSystemEntry,
  deleteFileSystemEntry,
  deleteFileSystemEntries,
  detectJvmProject,
} from "../services/file-service.ts";
import {
  filterExcludedEntries,
  parseGitignore,
  isIgnoredByRules,
  joinPath,
} from "../services/file-filter.ts";
import { saveViewSettings } from "../services/settings.ts";
import { getRelativeGitPath } from "../services/git-service.ts";
import { mapPool } from "../utils/async.ts";
import { paintTreeGitStatus } from "../components/tree-view.ts";
import type { TreeSelectionChange } from "../components/tree-view.ts";
import { normalizePath } from "../services/markdown-asset.ts";

/** 视图开关的键（respectGitignore / javaPackageView / excludeMeta）。 */
export type ViewSettingKey = "excludeMeta" | "respectGitignore" | "javaPackageView";

/** 文件树控制器的注入依赖：渲染回调与跨控制器回调由 mount 装配阶段回填。 */
export type TreeControllerDeps = {
  state: PanelState;
  t: TranslateFn;
  api: PluginRuntimeApi;
  isDisposed(): boolean;
  getLayout(): LayoutEls | null;
  /** 宿主 preload API（window.snow）。 */
  snowApi(): SnowApi | null;
  /** 渲染层回调。 */
  renderTree(): void;
  renderContextMenu(): void;
  renderToolbar(): void;
  applyTreeSelectionHighlight(): void;
  closeContextMenu(): void;
  openConfirmDialog(dialog: ConfirmDialogState): boolean;
  setOperationStatus(ok: boolean, error?: string): void;
  /** 跨控制器回调（mount 装配晚绑定）。 */
  previewFile(entry: FileTreeEntry): Promise<void>;
  refreshGitAll(): Promise<void>;
  resetPreviewForDeletedPaths(deletedPaths: string[]): boolean;
  pruneSelectionForDeletedPaths(deletedPaths: string[]): void;
  /** 图标块的就绪 Promise（loadRoot 首帧绘树前的限时到账窗口用）。 */
  ensureIcons(): Promise<void>;
  /** loadRoot({ followups: true }) 完成后的启动后续（图标回填 / JVM / Git / 命令识别）。 */
  onRootLoaded?(entries: DirectoryEntry[]): void;
};

export function createTreeController(deps: TreeControllerDeps) {
  const { state, t, api } = deps;
  const isDisposed = deps.isDisposed;
  const getLayout = deps.getLayout;

  function viewFilterOpts(): ExclusionFilterOptions {
    const filterEnabled = state.viewSettings.respectGitignore;
    return {
      excludeMeta: filterEnabled,
      useGitignore: filterEnabled,
      gitignoreRules: state.gitignoreRules,
    };
  }

  /**
   * 加载目录的直接子节点；JVM 源码根目录只在用户展开时构造包树。
   * @param entry 要展开的真实目录条目
   */
  async function loadDirectoryChildren(entry: FileTreeEntry) {
    // 只声明用到的入参：JvmEntryFilter 的 dirPath 在本回调里没用，写进形参会改变产物（arrow 长度）。
    const filtered = (entries: FileTreeEntry[]): FileTreeEntry[] =>
      sortEntries(filterExcludedEntries(entries, state.rootPath, viewFilterOpts()));
    const isJvmSourceRoot =
      state.viewSettings.javaPackageView &&
      state.javaProject &&
      Array.isArray(state.javaProject.sourceRoots) &&
      state.javaProject.sourceRoots.some((root) => pathKey(root) === pathKey(entry.path));

    // 展开同样只等一趟 IPC：这一层的 .gitignore 与列目录并发读。
    const ignorePromise = needsGitignoreLayer(entry.path) ? readGitignoreText(entry.path) : null;
    if (isJvmSourceRoot) {
      const sub = await readDirectoryEntries(entry.path);
      await appendGitignoreFromEntries(entry.path, sub, ignorePromise ? await ignorePromise : undefined);
      entry.children = await loadJvmPackageTree(entry.path, filtered);
      entry.isJavaSourceRoot = true;
      return;
    }

    const sub = await readDirectoryEntries(entry.path);
    await appendGitignoreFromEntries(entry.path, sub, ignorePromise ? await ignorePromise : undefined);
    entry.children = filtered(sub);
  }

  /**
   * 递归收集仓库内所有 .gitignore 规则（浅层在前、深层在后，深层覆盖浅层）
   * @description 与 git 语义一致：每层目录的 .gitignore 相对于自身生效。
   *   扫描时对已被忽略 / 元数据目录剪枝，避免进入 node_modules 等海量目录。
   * @param dir 当前扫描目录绝对路径
   * @param inherited 父层已收集的规则（由浅到深拼接）
   * @returns 本目录及其子目录的 .gitignore 规则清单
   */
  async function collectGitignoreRules(dir: string, inherited: GitignoreRule[]): Promise<GitignoreRule[]> {
    if (isDisposed()) return [];
    let entries: DirectoryEntry[];
    try {
      entries = await readDirectoryEntries(dir);
    } catch {
      return [];
    }
    const own: GitignoreRule[] = [];
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

  // 读某一层的 .gitignore 文本；该层没有这个文件 / 读失败一律返回 null（不抛给调用方）。
  async function readGitignoreText(dir: string): Promise<string | null> {
    try {
      const res = await readFileContent(joinPath(dir, ".gitignore"));
      if (!res || res.isBinary || typeof res.content !== "string") return null;
      return res.content;
    } catch {
      return null;
    }
  }

  /** 这一层的 .gitignore 还需不需要读（全仓已扫完 / 该层已读过就不再发 IPC）。 */
  function needsGitignoreLayer(dir: string): boolean {
    return !state.gitignoreFullyLoaded && !state.gitignoreLoadedDirs.has(pathKey(dir));
  }

  // 把某一层的 .gitignore 文本并入规则表。
  function applyGitignoreText(dir: string, text: string | null): void {
    if (!text) return;
    const own = parseGitignore(text, getRelativeGitPath(dir, state.rootPath));
    if (own.length) state.gitignoreRules = state.gitignoreRules.concat(own);
  }

  // 打开目录时补上这一层的 .gitignore。父目录的规则已经在更早的展开里读过。
  // prefetchedText 是「已与列目录并发读好」的文本（null 表示该层没有 .gitignore），
  // 传了就不再排队第二次 IPC；不传（undefined）时按列目录结果决定要不要读。
  async function appendGitignoreFromEntries(
    dir: string,
    entries: DirectoryEntry[],
    prefetchedText?: string | null
  ) {
    if (state.gitignoreFullyLoaded) return;
    const key = pathKey(dir);
    if (state.gitignoreLoadedDirs.has(key)) return;
    state.gitignoreLoadedDirs.add(key);
    const root = state.rootPath;
    if (prefetchedText !== undefined) {
      if (isDisposed() || state.gitignoreFullyLoaded || pathKey(root) !== pathKey(state.rootPath)) return;
      applyGitignoreText(dir, prefetchedText);
      return;
    }
    if (!Array.isArray(entries)) return;
    const gitignoreEntry = entries.find((entry) => entry && entry.name === ".gitignore" && !entry.isDirectory);
    if (!gitignoreEntry) return;
    let res;
    try {
      res = await readFileContent(gitignoreEntry.path);
    } catch {
      return;
    }
    if (isDisposed() || state.gitignoreFullyLoaded || pathKey(root) !== pathKey(state.rootPath)) return;
    if (!res || res.isBinary || typeof res.content !== "string") return;
    applyGitignoreText(dir, res.content);
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
    if (isDisposed() || pathKey(root) !== pathKey(state.rootPath)) return;
    state.gitignoreRules = rules;
    state.gitignoreFullyLoaded = true;
  }

  // 切换视图开关：持久化后重新加载数据（入口：文件树右键菜单的勾选项）
  async function toggleViewSetting(key: ViewSettingKey) {
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
  async function loadRoot({ followups = false }: { followups?: boolean } = {}) {
    if (!state.rootPath) {
      state.status = "";
      deps.renderToolbar();
      deps.renderTree();
      return;
    }
    const root = state.rootPath;
    state.status = t("status.loading", "加载中…");
    deps.renderToolbar();
    try {
      // 首屏只等一趟 IPC：根层 .gitignore 与列目录并发投机读（该层没这个文件时读失败即当作无规则）。
      const gitignorePromise = needsGitignoreLayer(root) ? readGitignoreText(root) : null;
      // 图标块在挂载时已并行发起：这里只给「列目录先完成而图标未到」的情况一个有限到账窗口，
      // 让树的第一帧就带完整图标集（消除占位图标回填的闪现）。超时兜底：极端慢盘下首屏
      // 不被图标拖死，图标到齐后由 scheduleStartupFollowups 里的 refreshInstalledIcons 就地回填。
      // iconsPromise 会话内记忆化：首次之后的 loadRoot 该 race 立即返回。
      const iconsReady = Promise.race([
        deps.ensureIcons(),
        new Promise<void>((resolve) => setTimeout(resolve, 120)),
      ]);
      const [entries] = await Promise.all([readDirectoryEntries(root), iconsReady]);
      if (isDisposed() || pathKey(root) !== pathKey(state.rootPath)) return;
      const prefetched = gitignorePromise ? await gitignorePromise : undefined;
      if (isDisposed() || pathKey(root) !== pathKey(state.rootPath)) return;
      await appendGitignoreFromEntries(root, entries, prefetched);
      if (isDisposed() || pathKey(root) !== pathKey(state.rootPath)) return;
      state.rootNodes = sortEntries(filterExcludedEntries(entries, root, viewFilterOpts()));
      state.status = "";
      deps.renderToolbar();
      deps.renderTree();
      if (followups && deps.onRootLoaded) deps.onRootLoaded(entries);
    } catch {
      if (isDisposed() || pathKey(root) !== pathKey(state.rootPath)) return;
      state.rootNodes = [];
      state.status = t("error.readRoot", "无法读取根目录");
      deps.renderToolbar();
      deps.renderTree();
    }
  }

  // 4. 切换文件夹展开与收起
  async function toggleDir(entry: FileTreeEntry) {
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
    deps.renderTree();
  }

  // 目录打开只负责展开，不把已经展开的目录误切换回收起状态。
  async function openDirectory(entry: FileTreeEntry | null) {
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
      deps.renderTree();
    }
    deps.closeContextMenu();
  }

  function parentDirectoryPath(filePath: string): string {
    const normalized = String(filePath || "").replace(/[\\/]+$/, "");
    const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
    if (index < 0) return "";
    if (index === 2 && /^[A-Za-z]:/.test(normalized)) return normalized.slice(0, 3);
    return normalized.slice(0, index) || normalized.slice(0, 1);
  }

  function findTreeEntry(nodes: FileTreeEntry[] | null | undefined, targetPath: string): FileTreeEntry | null {
    if (!Array.isArray(nodes)) return null;
    for (const entry of nodes) {
      if (entry && pathKey(entry.path) === pathKey(targetPath)) return entry;
      const nested = entry && findTreeEntry(entry.children, targetPath);
      if (nested) return nested;
    }
    return null;
  }

  async function refreshFileTreeAfterMutation(affectedDirs?: string[] | null) {
    // 改名 / 删除只影响父目录本身：定向重读那几个目录，绘树一次。
    // 不给范围时退回原全量路径（重载根 + 重读每个已展开目录），供范围未知的调用使用。
    if (affectedDirs && affectedDirs.length) {
      await refreshLoadedDirectories(affectedDirs.map((dir) => pathKey(dir)));
      return;
    }
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
    deps.renderTree();
  }

  function remapPath(path: string, oldPath: string, newPath: string): string {
    if (!path) return path;
    const currentKey = pathKey(path);
    const oldKey = pathKey(oldPath);
    if (currentKey === oldKey) return newPath;
    const normalizedPath = normalizePath(path);
    const normalizedOld = normalizePath(oldPath).replace(/[/\\]+$/, "");
    if (!normalizedPath.toLowerCase().startsWith(oldKey + "/")) return path;
    return newPath + normalizedPath.slice(normalizedOld.length);
  }

  function remapStatePaths(oldPath: string, newPath: string) {
    const expanded: Record<string, boolean> = Object.create(null);
    for (const path of Object.keys(state.expanded)) {
      expanded[remapPath(path, oldPath, newPath)] = state.expanded[path];
    }
    state.expanded = expanded;
    const nextSelected = new Set<string>();
    for (const path of state.selected) nextSelected.add(remapPath(path, oldPath, newPath));
    state.selected = nextSelected;
    if (state.selectionAnchor) state.selectionAnchor = remapPath(state.selectionAnchor, oldPath, newPath);
    if (state.preview && state.preview.path) {
      state.preview.path = remapPath(state.preview.path, oldPath, newPath);
      state.preview.name = basename(state.preview.path);
    }
  }

  /**
   * 删除工作区文件或目录。
   * @description 删除是破坏性操作，必须先确认；成功后刷新文件树和 Git 状态。
   * @param {Object} entry 要删除的文件或目录条目
   */
  function handleDelete(entry: FileTreeEntry | null) {
    if (!entry || state.operationBusy || state.confirmDialog) return;

    // 多选（选中集合含该条目且不止一个）：右键菜单切批量删除。
    const isMulti = state.selected.size > 1 && state.selected.has(entry.path);
    // 菜单先同步移除，再显示插件内的异步确认弹窗，避免阻塞宿主渲染线程。
    deps.closeContextMenu();
    if (isMulti) {
      const count = state.selected.size;
      deps.openConfirmDialog({
        title: t("action.delete", "删除"),
        message: t("action.deleteSelectedConfirm", "确定删除选中的 {{count}} 项吗？此操作不可撤销。", { count }),
        confirmLabel: t("action.delete", "删除"),
        onConfirm: () => deleteSelectedEntries(),
      });
      return;
    }
    deps.openConfirmDialog({
      title: t("action.delete", "删除"),
      message: t("action.deleteConfirm", "确定删除“{{name}}”吗？此操作不可撤销。", {
        name: entry.name || entry.path,
      }),
      confirmLabel: t("action.delete", "删除"),
      onConfirm: () => deleteEntry(entry),
    });
  }

  async function deleteEntry(entry: FileTreeEntry | null) {
    if (!entry || state.operationBusy) return;

    state.operationBusy = true;
    deps.renderToolbar();
    deps.renderTree();

    try {
      const result = await deleteFileSystemEntry(api, state.rootPath, entry.path);
      if (isDisposed()) return;

      if (result.ok !== true) {
        deps.setOperationStatus(false, result.error);
        return;
      }

      deps.resetPreviewForDeletedPaths([entry.path]);
      deps.pruneSelectionForDeletedPaths([entry.path]);

      await refreshFileTreeAfterMutation([parentDirectoryPath(entry.path)]);
      await deps.refreshGitAll();
      deps.setOperationStatus(true);
    } catch (err) {
      if (!isDisposed()) {
        deps.setOperationStatus(false, err && (err as ErrorLike).message ? (err as ErrorLike).message : String(err));
      }
    } finally {
      if (!isDisposed()) {
        state.operationBusy = false;
        deps.renderToolbar();
        deps.renderTree();
      }
    }
  }

  /** 批量删除当前选中条目：单次 IPC 调宿主批量接口，部分失败时提示失败数量。 */
  async function deleteSelectedEntries() {
    if (state.operationBusy) return;
    const paths = Array.from(state.selected);
    if (!paths.length) return;

    state.operationBusy = true;
    deps.renderToolbar();
    deps.renderTree();

    try {
      const result = await deleteFileSystemEntries(api, state.rootPath, paths);
      if (isDisposed()) return;

      if (result.ok !== true) {
        deps.setOperationStatus(false, result.error);
        return;
      }

      // Partial 承接「宿主没回传 data」这一支：不必断言，也不新增语句
      const data: Partial<BatchWorkspaceDeleteResult> = result.data || {};
      const deleted = Array.isArray(data.deleted) ? data.deleted : [];
      const failed = Array.isArray(data.failed) ? data.failed : [];
      if (deleted.length) {
        deps.resetPreviewForDeletedPaths(deleted);
        deps.pruneSelectionForDeletedPaths(deleted);
      }

      await refreshFileTreeAfterMutation();
      await deps.refreshGitAll();
      if (failed.length) {
        deps.setOperationStatus(false, t("action.batchDeletePartial", "{{count}} 项删除失败", { count: failed.length }));
      } else {
        deps.setOperationStatus(true);
      }
    } catch (err) {
      if (!isDisposed()) {
        deps.setOperationStatus(false, err && (err as ErrorLike).message ? (err as ErrorLike).message : String(err));
      }
    } finally {
      if (!isDisposed()) {
        state.operationBusy = false;
        deps.renderToolbar();
        deps.renderTree();
      }
    }
  }

  async function submitRename(newName: string) {
    const context = state.contextMenu;
    if (!context || state.operationBusy) return;
    // entry 非空是重命名流程的不变量：renaming 只由 beginRename 置真，而 beginRename 先判过 entry。
    const entry = context.entry!;
    const trimmed = String(newName || "").trim();
    if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed)) {
      deps.setOperationStatus(false, "名称不能为空，且不能包含路径分隔符");
      return;
    }
    if (trimmed.toLowerCase() === String(entry.name || "").toLowerCase()) {
      deps.setOperationStatus(false, "新名称与原名称相同");
      return;
    }

    const oldPath = entry.path;
    const newPath = joinPath(parentDirectoryPath(oldPath), trimmed);
    state.operationBusy = true;
    deps.renderContextMenu();
    const result = await renameFileSystemEntry(api, state.rootPath, oldPath, trimmed);
    if (isDisposed()) return;
    if (result.ok !== true) {
      state.operationBusy = false;
      deps.renderContextMenu();
      deps.setOperationStatus(false, result.error);
      return;
    }

    remapStatePaths(oldPath, newPath);
    state.operationBusy = false;
    deps.closeContextMenu();
    await refreshFileTreeAfterMutation([parentDirectoryPath(oldPath)]);
    await deps.refreshGitAll();
    deps.setOperationStatus(true);
  }

  async function handleContextOpen(entry: FileTreeEntry | null) {
    if (!entry || state.operationBusy) return;

    deps.closeContextMenu();

    if (entry.isDirectory) {
      await openDirectory(entry);
      return;
    }

    await deps.previewFile(entry);
  }

  /** 文件树多选：普通=单选并置锚点；ctrl/cmd=切换；shift=从锚点按可见顺序范围选择。 */
  function handleTreeSelectionChange({ path, additive, range, visiblePaths }: TreeSelectionChange) {
    if (range) {
      const anchor = state.selectionAnchor;
      const anchorIndex = anchor ? visiblePaths.indexOf(anchor) : -1;
      const currentIndex = visiblePaths.indexOf(path);
      if (anchorIndex >= 0 && currentIndex >= 0) {
        const from = Math.min(anchorIndex, currentIndex);
        const to = Math.max(anchorIndex, currentIndex);
        state.selected = new Set(visiblePaths.slice(from, to + 1));
      } else {
        state.selected = new Set([path]);
        state.selectionAnchor = path;
      }
      deps.applyTreeSelectionHighlight();
      return;
    }
    if (additive) {
      const next = new Set(state.selected);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      state.selected = next;
      state.selectionAnchor = path;
      deps.applyTreeSelectionHighlight();
      return;
    }
    state.selected = new Set([path]);
    state.selectionAnchor = path;
    deps.applyTreeSelectionHighlight();
  }

  /** 文件树键盘：Ctrl/Cmd+A 全选可见行、Escape 清空选择。 */
  function handleTreeKeyDown(event: KeyboardEvent, visiblePaths: string[]) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      state.selected = new Set(Array.isArray(visiblePaths) ? visiblePaths : []);
      state.selectionAnchor =
        visiblePaths && visiblePaths.length ? visiblePaths[visiblePaths.length - 1] : null;
      deps.applyTreeSelectionHighlight();
      return;
    }
    if (event.key === "Escape") {
      state.selected = new Set();
      state.selectionAnchor = null;
      deps.applyTreeSelectionHighlight();
    }
  }

  /**
   * 展开目标文件的所有祖先目录，使其在文件树中可见。
   * @description 从根逐级在真实树里找到对应目录条目并 loadDirectoryChildren（写回 entry.children），
   *   再置 expanded；只处理缺失的层级，某级不可读时静默中止，不影响预览打开。
   */
  async function expandTreeToPath(targetPath: string) {
    if (!state.rootPath) return;
    const rootKey = pathKey(state.rootPath);
    const rootNorm = normalizePath(state.rootPath);
    const rel = normalizePath(targetPath).slice(rootNorm.length).replace(/^[/\\]+/, "");
    if (!rel) return;
    const segments = rel.split(/[/\\]+/).filter(Boolean);
    if (segments.length <= 1) return; // 目标就在根目录下，无需展开
    let currentPath = state.rootPath;
    for (let i = 0; i < segments.length - 1; i++) {
      currentPath = joinPath(currentPath, segments[i]);
      if (state.expanded[currentPath]) continue;
      const entry = findTreeEntry(state.rootNodes, currentPath);
      if (!entry || !entry.isDirectory) return;
      if (!Array.isArray(entry.children)) {
        try {
          await loadDirectoryChildren(entry);
        } catch {
          entry.children = [];
        }
      }
      if (isDisposed() || pathKey(rootKey) !== pathKey(state.rootPath)) return;
      state.expanded[currentPath] = true;
    }
  }

  /** 把文件树滚动到当前选中行并高亮（搜索定位用；树未渲染该行时忽略）。 */
  function scrollTreeToSelected() {
    if (isDisposed() || !getLayout()) return;
    const layout = getLayout()!;
    const body = layout.treeBody || layout.treePane;
    if (!body || !state.selected || state.selected.size === 0) return;
    const [selectedPath] = state.selected;
    const row = [...body.querySelectorAll<HTMLElement>(".sfe-file-item")].find(
      (node) => pathKey(node.dataset.path) === pathKey(selectedPath)
    );
    if (!row) return;
    // 用 rect 换算相对滚动容器的偏移，避免 offsetParent 不是 treeBody 时 offsetTop 失真。
    const bodyRect = body.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const rowTop = rowRect.top - bodyRect.top + body.scrollTop;
    const rowBottom = rowTop + rowRect.height;
    if (rowTop < body.scrollTop) body.scrollTop = rowTop;
    else if (rowBottom > body.scrollTop + body.clientHeight) body.scrollTop = rowBottom - body.clientHeight;
  }

  // 刷新 JVM 项目识别结果：与目录树并行，避免阻塞 Git 状态刷新。
  // 结果保存在状态中，后续 JVM 包视图直接复用，不在渲染层重复扫描。
  async function refreshJavaProject(projectPath?: string | null, knownEntries?: FileTreeEntry[]) {
    if (isDisposed() || !state.rootPath) return;
    const path = projectPath || state.rootPath;
    const detected = await detectJvmProject(path, knownEntries);
    // 异步检测期间可能已切换项目，过期结果不能写回当前状态。
    if (isDisposed() || pathKey(path) !== pathKey(state.rootPath)) return;
    state.javaProject = detected;
  }

  // ------------------------------------------------------------------
  // 目录实时监听：文件系统变化时静默刷新「已加载」目录，保留展开态与滚动位置
  // （对标 snow-app 资源管理器；数据源为宿主 preload 的 startDirectoryWatch / onDirectoryChanged）
  // ------------------------------------------------------------------
  let dirWatchPath = "";        // 当前已 startDirectoryWatch 的根路径
  let unsubDirChanged: Unsubscribe | null = null;   // onDirectoryChanged 取消订阅句柄
  let dirRefreshTimer: ReturnType<typeof setTimeout> | null = null;   // 变化事件防抖定时器（一次写盘可能连发多次）
  // 防抖窗口内累积的变更路径键；null 表示出现过「范围未知」的事件，必须全量刷。
  let dirChangeKeys: string[] | null = [];

  /** 停止目录监听并解绑事件。 */
  function stopDirectoryWatch() {
    if (dirRefreshTimer) {
      clearTimeout(dirRefreshTimer);
      dirRefreshTimer = null;
    }
    // 攒着没消费的变更路径随监听一起作废，下次启动不带旧范围。
    dirChangeKeys = [];
    if (typeof unsubDirChanged === "function") {
      unsubDirChanged();
      unsubDirChanged = null;
    }
    if (dirWatchPath) {
      const snow = deps.snowApi();
      if (snow && typeof snow.stopDirectoryWatch === "function") {
        void snow.stopDirectoryWatch(dirWatchPath).catch(() => undefined);
      }
      dirWatchPath = "";
    }
  }

  /**
   * 启动目录监听：仅监听工作区根目录，事件到达后刷新「已加载」目录（含根）。
   * @description 只刷新已经展开过、已读盘过的目录，未加载目录不主动读盘（惰性展开语义不变）；
   *   变更事件做 250ms 防抖，避免一次写盘触发的连发事件反复读盘。宿主未提供能力时静默降级。
   */
  function startDirectoryWatch() {
    stopDirectoryWatch();
    if (isDisposed() || !state.rootPath) return;
    const snow = deps.snowApi();
    if (!snow || typeof snow.startDirectoryWatch !== "function" || typeof snow.onDirectoryChanged !== "function") {
      return;
    }
    dirWatchPath = state.rootPath;
    void snow.startDirectoryWatch(dirWatchPath).catch(() => undefined);
    unsubDirChanged = snow.onDirectoryChanged((changedPath) => {
      if (isDisposed()) return;
      const root = state.rootPath;
      if (!root) return;
      const changedKey = pathKey(changedPath);
      // 只关心当前工作区内的变化（宿主 watcher 可能推送其它项目的路径）。
      if (changedPath && changedKey !== pathKey(root) && !changedKey.startsWith(pathKey(root) + "/")) {
        return;
      }
      if (dirRefreshTimer) clearTimeout(dirRefreshTimer);
      // 防抖窗口内累积变更路径；收到「无路径」的事件就退回全量刷新（范围未知，不敢猜）。
      if (changedPath) {
        if (dirChangeKeys) dirChangeKeys.push(changedKey);
        else dirChangeKeys = [changedKey];
      } else {
        dirChangeKeys = null;
      }
      dirRefreshTimer = setTimeout(() => {
        dirRefreshTimer = null;
        const keys = dirChangeKeys;
        dirChangeKeys = [];
        void refreshLoadedDirectories(keys);
      }, 250);
    });
  }

  /** 收集所有「已加载」目录路径：根 + 每个已展开且已加载子项的目录（前序，浅层在前）。 */
  function collectLoadedDirPaths() {
    const paths: string[] = [];
    if (state.rootPath) paths.push(state.rootPath);
    const walk = (nodes: FileTreeEntry[] | null) => {
      if (!Array.isArray(nodes)) return;
      for (const entry of nodes) {
        if (entry && entry.isDirectory && state.expanded[entry.path] && Array.isArray(entry.children)) {
          paths.push(entry.path);
          walk(entry.children);
        }
      }
    };
    walk(state.rootNodes);
    return paths;
  }

  /**
   * 用新读取的直接子项替换目录 children，但保留同名子目录已加载的更深层 children。
   * @description 刷新根目录时新节点是全新对象；若不迁移旧 children，所有已展开子目录会丢展开态。
   * @param newNodes 新读取并排序过滤后的条目
   * @param oldNodes 旧的同级条目（用于迁移已加载 children）
   * @returns 合并后的条目
   */
  function mergeLoadedChildren(
    newNodes: FileTreeEntry[],
    oldNodes: FileTreeEntry[] | null | undefined,
  ): FileTreeEntry[] {
    const oldByKey = new Map<string, FileTreeEntry>();
    if (Array.isArray(oldNodes)) {
      for (const node of oldNodes) {
        if (node && node.path) oldByKey.set(pathKey(node.path), node);
      }
    }
    return newNodes.map((node) => {
      const previous = oldByKey.get(pathKey(node.path));
      if (previous && node.isDirectory && Array.isArray(previous.children)) {
        return { ...node, children: previous.children };
      }
      return node;
    });
  }

  /**
   * 静默刷新所有已加载目录：重新读取直接子项，就地替换 children。
   * @description 不重建整棵树，只重渲染列表（renderTree 自身保留 scrollTop）；保留展开态与选中态。
   *   目录读取按 mapPool 并行（watcher 一次防抖可能涉及多层目录，串行 IPC 等待累加）；
   *   读到后的应用阶段保持串行，保证 gitignore 追加与 children 替换按稳定顺序执行。
   */
  async function refreshLoadedDirectories(changedKeys?: string[] | null) {
    if (isDisposed() || !state.rootPath) return;
    const root = state.rootPath;
    const dirPaths = collectLoadedDirPaths();
    // 只刷「包含该变更的最深已加载目录」。重读所有已展开目录会让一次构建写盘变成几十趟 IPC，
    // 而且变更落在没展开的层级时树上根本看不见，读了也是白读。
    let scoped = dirPaths;
    if (changedKeys && changedKeys.length) {
      const targets = new Set<string>();
      for (const changedKey of changedKeys) {
        let deepest = "";
        for (const dirPath of dirPaths) {
          const dirKey = pathKey(dirPath);
          if ((changedKey === dirKey || changedKey.startsWith(dirKey + "/")) && dirKey.length > deepest.length) {
            deepest = dirKey;
          }
        }
        if (deepest) targets.add(deepest);
      }
      if (!targets.size) return;
      scoped = dirPaths.filter((dirPath) => targets.has(pathKey(dirPath)));
    }
    const readResults = await mapPool(scoped, 6, async (dirPath) => {
      try {
        const entries = await readDirectoryEntries(dirPath);
        if (isDisposed() || pathKey(root) !== pathKey(state.rootPath)) return null;
        return { dirPath, entries };
      } catch {
        // 目录可能已被删除或暂时不可读：跳过，不打断其它目录的刷新。
        return null;
      }
    });
    if (isDisposed() || pathKey(root) !== pathKey(state.rootPath)) return;
    for (const read of readResults) {
      if (!read) continue;
      const { dirPath, entries } = read;
      if (pathKey(dirPath) === pathKey(root)) {
        await appendGitignoreFromEntries(dirPath, entries);
        if (isDisposed() || pathKey(root) !== pathKey(state.rootPath)) return;
        const nextNodes = sortEntries(filterExcludedEntries(entries, root, viewFilterOpts()));
        state.rootNodes = mergeLoadedChildren(nextNodes, state.rootNodes);
      } else {
        const node = findTreeEntry(state.rootNodes, dirPath);
        if (!node || !node.isDirectory) continue;
        await appendGitignoreFromEntries(dirPath, entries);
        const nextChildren = sortEntries(filterExcludedEntries(entries, root, viewFilterOpts()));
        node.children = mergeLoadedChildren(nextChildren, node.children);
      }
    }
    if (isDisposed()) return;
    deps.renderTree();
    // 已展开目录的 .gitignore 可能变化：刷新后重算 Git 染色（轻量，不重建树）。
    paintTreeGitStatus(getLayout() && getLayout()!.treePane, {
      rootPath: state.rootPath,
      gitStatusMap: state.gitStatusMap,
      t,
    });
  }

  return {
    viewFilterOpts,
    loadDirectoryChildren,
    reloadGitignore,
    toggleViewSetting,
    loadRoot,
    toggleDir,
    openDirectory,
    parentDirectoryPath,
    findTreeEntry,
    refreshFileTreeAfterMutation,
    handleDelete,
    submitRename,
    handleContextOpen,
    handleTreeSelectionChange,
    handleTreeKeyDown,
    expandTreeToPath,
    scrollTreeToSelected,
    refreshJavaProject,
    stopDirectoryWatch,
    startDirectoryWatch,
  };
}

