/**
 * 文件目录树组件 (src/components/tree-view.ts)
 * 渲染层次化文件树列表，支持递归展开/折叠、Git 状态染色与字母徽章、专有图标绑定
 */

import { el, humanSize } from "../utils/dom.ts";
import { createActionIcon } from "../icons/action-icons.ts";
import { createFileIconNode } from "../icons/file-icons.ts";
import {
  resolveGitStatus,
  resolveGitFolderStatus,
  applyGitNameStyle,
  gitStatusClass,
  createGitBadge,
} from "../services/git-service.ts";
import type { GitStatusMap } from "../services/git-service.ts";
import type { FileTreeEntry } from "../services/file-service.ts";
import type { TranslateFn } from "../types/panel-state.ts";

/**
 * 文件树条目：就是 services/file-service.ts 的 FileTreeEntry（单一真源）。
 * @description 组件需要的 name/path/isDirectory/size 与插件追加的 displayName、isSoftHidden 等
 *   全在那一处声明；本组件历史上另立过一份 `DirectoryEntry & {…}`，于是 index.ts 传进来时要断言，
 *   写 `isJavaSourceRoot` 时也要断言。留这个名字只为调用点可读。
 */
export type TreeEntry = FileTreeEntry;

/** 树展平后的一行：条目 + 缩进深度。 */
export type TreeRow = {
  /** 该行对应的树条目。 */
  entry: TreeEntry;
  /** 缩进深度，顶层为 0。 */
  depth: number;
};

/** 展开状态字典：键为条目绝对路径，值为是否展开（index.js 的 state.expanded）。 */
export type TreeExpandedMap = Record<string, boolean>;

/** 选中态变化事件（行点击时上报给 index.js 的 handleTreeSelectionChange）。 */
export type TreeSelectionChange = {
  /** 被点击条目的绝对路径。 */
  path: string;
  /** 是否按住 Ctrl/Cmd：增量切换该行的选中态。 */
  additive: boolean;
  /** 是否按住 Shift：从上一次选中行到该行做范围选择。 */
  range: boolean;
  /** 当前可见行路径，顺序即视觉顺序；范围选择与全选据此计算。 */
  visiblePaths: string[];
};

/** renderTreeView 的入参（由 index.js 的 renderTree 构造）。 */
export type TreeViewOptions = {
  /** 工作区根目录绝对路径；为空时渲染「未检测到当前项目目录」空态。 */
  rootPath: string;
  /** 顶层条目列表；null 表示正在加载。 */
  rootNodes: TreeEntry[] | null;
  /** 展开状态字典，键为绝对路径。 */
  expanded?: TreeExpandedMap;
  /** 当前选中的路径集合（Set），未选中时为空集合或 null。 */
  selected?: Set<string> | null;
  /** Git 状态映射表，键为仓库相对路径（正斜杠）。 */
  gitStatusMap?: GitStatusMap;
  /** 是否拥有目录枚举权限。 */
  canList?: boolean;
  /** 是否拥有文件读取权限。 */
  canRead?: boolean;
  /** 切换目录展开/折叠回调 */
  onToggleDir?: (entry: TreeEntry) => void;
  /** 选中文件回调 */
  onSelectFile?: (entry: TreeEntry) => void;
  /** 文件/目录右键回调（clientX/clientY 为视口坐标） */
  onContextMenu?: (entry: TreeEntry, clientX: number, clientY: number) => void;
  /** 双击文件进入快速编辑回调 */
  onOpenFileEdit?: (entry: TreeEntry) => void;
  /** 选中态变化回调（Ctrl/Cmd、Shift 与普通单选共用） */
  onSelectionChange?: (change: TreeSelectionChange) => void;
  /** 树容器键盘回调 (event, visiblePaths)：Ctrl/Cmd+A 全选、Escape 清空 */
  onTreeKeyDown?: (event: KeyboardEvent, visiblePaths: string[]) => void;
  /** 国际化翻译函数 */
  t: TranslateFn;
};

/** paintTreeGitStatus 的入参。 */
export type TreeGitPaintOptions = {
  /** 仓库根目录绝对路径，用于把绝对路径换算成状态表键。 */
  rootPath: string;
  /** Git 状态表；缺省时按无变更渲染。 */
  gitStatusMap?: GitStatusMap;
  /** 国际化翻译函数 */
  t: TranslateFn;
};

/**
 * 将树状结构展平为带深度的列表行
 * @param nodes 当前层级节点数组
 * @param depth 当前层级深度
 * @param expanded 展开状态字典
 * @param out 输出行容器（就地追加）
 */
export function flattenTree(
  nodes: TreeEntry[] | null | undefined,
  depth: number,
  expanded: TreeExpandedMap,
  out: TreeRow[],
): void {
  if (!Array.isArray(nodes)) return;
  for (const entry of nodes) {
    if (!entry) continue;
    out.push({ entry, depth });
    if (entry.isDirectory && expanded[entry.path] === true && Array.isArray(entry.children)) {
      flattenTree(entry.children, depth + 1, expanded, out);
    }
  }
}

/**
 * 渲染文件树 DOM 节点
 * @param parentEl 承载文件树列表的父容器
 * @param options 渲染与交互配置，字段说明见 TreeViewOptions：
 *   rootPath 工作区根目录路径、rootNodes 顶层条目列表、expanded 展开字典、
 *   selected 当前选中的路径集合、gitStatusMap Git 状态映射表、canList 是否拥有目录枚举权限、
 *   canRead 是否拥有文件读取权限、onToggleDir 切换目录展开/折叠回调、onSelectFile 选中文件回调、
 *   onContextMenu 文件/目录右键回调、onOpenFileEdit 双击进入快速编辑回调、
 *   onSelectionChange 选中态变化回调、onTreeKeyDown 树容器键盘回调、t 国际化翻译函数
 */
export function renderTreeView(parentEl: HTMLElement, options: TreeViewOptions): void {
  const {
    rootPath,
    rootNodes,
    expanded = {},
    selected = null,
    gitStatusMap = {},
    canList = true,
    canRead = true,
    onToggleDir,
    onSelectFile,
    onContextMenu,
    onOpenFileEdit,
    onSelectionChange,
    onTreeKeyDown,
    t,
  } = options;

  parentEl.replaceChildren();

  if (!canList || !canRead) {
    parentEl.appendChild(el("div", "sfe-empty", t("error.noApi", "当前版本未开放本地文件接口。")));
    return;
  }
  if (!rootPath) {
    const empty = el("div", "sfe-empty");
    empty.appendChild(createFileIconNode("", true, false));
    empty.appendChild(el("div", "sfe-empty-title", t("empty.noRoot", "未检测到当前项目目录")));
    parentEl.appendChild(empty);
    return;
  }
  if (rootNodes === null) {
    parentEl.appendChild(el("div", "sfe-empty", t("status.loading", "加载中…")));
    return;
  }
  if (!rootNodes.length) {
    parentEl.appendChild(el("div", "sfe-empty", t("empty.emptyDir", "该目录为空或不可读。")));
    return;
  }

  const rows: TreeRow[] = [];
  flattenTree(rootNodes, 0, expanded, rows);
  // 当前可见行路径（顺序即视觉顺序）：shift 范围选择与 Ctrl+A 全选据此计算。
  const visiblePaths = rows.map((row) => row.entry.path);

  const list = el("div", "sfe-list");
  list.tabIndex = -1;
  // 键盘：Ctrl/Cmd+A 全选可见行、Escape 清空选择（由 index.js 处理，传入可见路径）。
  list.addEventListener("keydown", (e) => {
    if (typeof onTreeKeyDown === "function") onTreeKeyDown(e, visiblePaths);
  });
  for (const row of rows) {
    const entry = row.entry;
    const isDir = !!entry.isDirectory;
    const displayName = entry.displayName || entry.name;
    const isExpanded = expanded[entry.path] === true;
    const isSelected = selected && typeof selected.has === "function" ? selected.has(entry.path) : false;

    // 解析当前项的 Git 状态：文件取自身状态；文件夹取子孙聚合状态（对齐 VS Code）
    const gitStatus = isDir
      ? resolveGitFolderStatus(entry.path, rootPath, gitStatusMap)
      : resolveGitStatus(entry.path, rootPath, gitStatusMap);

    const item = el(
      "div",
      "sfe-file-item" +
        (isDir ? " sfe-folder-row" : "") +
        (entry.isVirtualPackage ? " sfe-java-package-row" : "") +
        (entry.isJavaSourceRoot ? " sfe-java-source-root-row" : "") +
        (entry.isSoftHidden ? " sfe-soft-hidden" : "") +
        (isSelected ? " selected" : "")
    );
    item.style.paddingLeft = 12 + row.depth * 14 + "px";
    // 记录条目路径：选中态变化时据此就地定位行，避免整棵树重建（大目录卡顿根因）
    item.dataset.path = entry.path;
    if (entry.packageName) item.title = entry.packageName;

    // 1. 展开/折叠三角（仅目录显示）
    const chevronWrap = el("span", "sfe-tree-chevron" + (isExpanded ? " expanded" : ""));
    if (isDir) {
      chevronWrap.appendChild(
        createActionIcon(isExpanded ? "chevronDown" : "chevronRight", 13)
      );
    }
    item.appendChild(chevronWrap);

    // 2. 文件/文件夹专有矢量图标
    const iconEl = createFileIconNode(entry.name, isDir, isExpanded);
    item.appendChild(iconEl);

    // 3. 文件名称与 Git 染色
    const nameWrap = el("span", "sfe-file-name");
    const nameText = el("span", "sfe-file-name-text", displayName);
    if (gitStatus) {
      applyGitNameStyle(nameText, gitStatus);
    }
    nameWrap.appendChild(nameText);
    item.appendChild(nameWrap);

    // 4. 辅助信息（子项数或文件大小）：紧跟名称，Git 标记排在其后
    if (isDir) {
      if (Array.isArray(entry.children)) {
        item.appendChild(el("span", "sfe-tree-folder-count", String(entry.children.length)));
      }
    } else {
      const sizeStr = humanSize(entry.size);
      if (sizeStr) item.appendChild(el("span", "sfe-file-size", sizeStr));
    }

    // 5. Git 状态标识（行尾）：文件用字母徽章 U/M/A/D/R，文件夹用圆点。
    //    排序约定：文件「名称 大小 U/M」、文件夹「名称 数字 •」。
    if (gitStatus) {
      if (isDir) {
        // 调用点已在 if (gitStatus) 分支内；圆点仅在状态字母无法识别时才为 null（原实现同样直接 append）。
        item.appendChild(createFolderGitDot(gitStatus, t)!);
      } else {
        const badge = createGitBadge(gitStatus);
        if (badge) item.appendChild(badge);
      }
    }

    // 6. 点击事件绑定
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      // 让树容器获得焦点，保证 Ctrl+A / Escape 键盘操作可用。
      try {
        list.focus({ preventScroll: true });
      } catch {
        list.focus();
      }
      const additive = e.ctrlKey || e.metaKey;
      const range = e.shiftKey;
      // ctrl/cmd（切换）与 shift（范围）只改选中，不打开文件、不展开目录。
      if (additive || range) {
        if (typeof onSelectionChange === "function") {
          onSelectionChange({ path: entry.path, additive, range, visiblePaths });
        }
        return;
      }
      // 普通点击：先单选（就地高亮），再展开目录或打开文件。
      if (typeof onSelectionChange === "function") {
        onSelectionChange({ path: entry.path, additive: false, range: false, visiblePaths });
      }
      if (isDir) {
        if (typeof onToggleDir === "function") onToggleDir(entry);
      } else if (typeof onSelectFile === "function") {
        onSelectFile(entry);
      }
    });

    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof onContextMenu === "function") {
        onContextMenu(entry, e.clientX, e.clientY);
      }
    });

    // 双击文件：进入快速编辑（目录双击仍走单击的展开/折叠，不额外处理）。
    item.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (!isDir && typeof onOpenFileEdit === "function") onOpenFileEdit(entry);
    });

    list.appendChild(item);
  }

  parentEl.appendChild(list);
}

const GIT_NAME_CLASSES = ["sfe-git-modify", "sfe-git-untracked", "sfe-git-add", "sfe-git-delete", "sfe-git-rename"];

/**
 * 按当前 Git 状态表更新已渲染行的文件名颜色和徽章，不重建列表。
 * @param parentEl 文件树容器
 * @param options rootPath 仓库根目录、gitStatusMap 状态表、t 翻译函数（见 TreeGitPaintOptions）
 */
export function paintTreeGitStatus(
  parentEl: HTMLElement | null | undefined,
  { rootPath, gitStatusMap = {}, t }: TreeGitPaintOptions,
): void {
  if (!parentEl || typeof parentEl.querySelectorAll !== "function") return;
  // .sfe-file-item 全部由本组件用 div 创建，dataset 只在 HTMLElement 上存在。
  for (const item of parentEl.querySelectorAll<HTMLElement>(".sfe-file-item")) {
    const filePath = item.dataset.path || "";
    if (!filePath) continue;
    const isDir = item.classList.contains("sfe-folder-row");
    const gitStatus = isDir
      ? resolveGitFolderStatus(filePath, rootPath, gitStatusMap)
      : resolveGitStatus(filePath, rootPath, gitStatusMap);
    const nameText: HTMLElement | null = item.querySelector(".sfe-file-name-text");
    if (nameText) {
      nameText.classList.remove(...GIT_NAME_CLASSES);
      if (gitStatus) applyGitNameStyle(nameText, gitStatus);
    }
    for (const old of item.querySelectorAll(".sfe-git-badge, .sfe-git-dot")) old.remove();
    if (!gitStatus) continue;
    const marker = isDir ? createFolderGitDot(gitStatus, t) : createGitBadge(gitStatus);
    if (marker) item.appendChild(marker);
  }
}

/**
 * 创建文件夹的 Git 变更圆点（对齐 VS Code 的 "Contains emphasized items" 气泡徽章）
 * @description 文件夹不显示字母徽章，仅以圆点表示「子孙含变更」；圆点颜色由状态染色 Class 的
 *   currentColor 决定，无单一字母语义。
 * @param gitStatus 文件夹的聚合状态字符
 * @param t 国际化翻译函数
 * @returns 圆点节点；状态为空或无法识别时返回 null
 */
function createFolderGitDot(gitStatus: string, t: TranslateFn): HTMLSpanElement | null {
  if (!gitStatus) return null;
  const cls = gitStatusClass(gitStatus);
  if (!cls) return null;
  const dot = el("span", "sfe-git-dot " + cls);
  dot.setAttribute("aria-hidden", "true");
  dot.title =
    typeof t === "function" ? t("git.folderChanged", "包含变更") : "包含变更";
  return dot;
}
