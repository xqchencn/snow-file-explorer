/**
 * 文件目录树组件 (src/components/tree-view.js)
 * 渲染层次化文件树列表，支持递归展开/折叠、Git 状态染色与字母徽章、专有图标绑定
 */

import { el, humanSize } from "../utils/dom.js";
import { createActionIcon } from "../icons/action-icons.js";
import { createFileIconNode } from "../icons/file-icons.js";
import {
  resolveGitStatus,
  resolveGitFolderStatus,
  applyGitNameStyle,
  gitStatusClass,
  createGitBadge,
} from "../services/git-service.js";

/**
 * 将树状结构展平为带深度的列表行
 * @param {Array} nodes 当前层级节点数组
 * @param {number} depth 当前层级深度
 * @param {Record<string, boolean>} expanded 展开状态字典
 * @param {Array} out 输出行容器
 */
export function flattenTree(nodes, depth, expanded, out) {
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
 * @param {HTMLElement} parentEl 承载文件树列表的父容器
 * @param {Object} options
 * @param {string} options.rootPath 工作区根目录路径
 * @param {Array|null} options.rootNodes 顶层条目列表
 * @param {Record<string, boolean>} options.expanded 展开字典
 * @param {string|null} options.selected 当前选中的文件绝对路径
 * @param {Record<string, string>} options.gitStatusMap Git 状态映射表
 * @param {boolean} options.canList 是否拥有目录枚举权限
 * @param {boolean} options.canRead 是否拥有文件读取权限
 * @param {Function} options.onToggleDir 切换目录展开/折叠回调
 * @param {Function} options.onSelectFile 选中文件回调
 * @param {Function} options.onContextMenu 文件/目录右键回调
 * @param {Function} options.t 国际化翻译函数
 */
export function renderTreeView(parentEl, options) {
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

  const rows = [];
  flattenTree(rootNodes, 0, expanded, rows);

  const list = el("div", "sfe-list");
  for (const row of rows) {
    const entry = row.entry;
    const isDir = !!entry.isDirectory;
    const displayName = entry.displayName || entry.name;
    const isExpanded = expanded[entry.path] === true;
    const isSelected = !isDir && selected === entry.path;

    // 解析当前项的 Git 状态：文件取自身状态；文件夹取子孙聚合状态（对齐 VS Code）
    const gitStatus = isDir
      ? resolveGitFolderStatus(entry.path, rootPath, gitStatusMap)
      : resolveGitStatus(entry.path, entry.name, rootPath, gitStatusMap);

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

    // 4. Git 状态标识：文件用字母徽章；文件夹用圆点（对齐 VS Code，文件夹不带字母）
    if (gitStatus) {
      if (isDir) {
        item.appendChild(createFolderGitDot(gitStatus, t));
      } else {
        const badge = createGitBadge(gitStatus);
        if (badge) item.appendChild(badge);
      }
    }

    // 5. 辅助信息（子项数或文件大小）
    if (isDir) {
      if (Array.isArray(entry.children)) {
        item.appendChild(el("span", "sfe-tree-folder-count", String(entry.children.length)));
      }
    } else {
      const sizeStr = humanSize(entry.size);
      if (sizeStr) item.appendChild(el("span", "sfe-file-size", sizeStr));
    }

    // 6. 点击事件绑定
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isDir) {
        if (typeof onToggleDir === "function") onToggleDir(entry);
      } else {
        if (typeof onSelectFile === "function") onSelectFile(entry);
      }
    });

    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof onContextMenu === "function") {
        onContextMenu(entry, e.clientX, e.clientY);
      }
    });

    list.appendChild(item);
  }

  parentEl.appendChild(list);
}

/**
 * 创建文件夹的 Git 变更圆点（对齐 VS Code 的 "Contains emphasized items" 气泡徽章）
 * @description 文件夹不显示字母徽章，仅以圆点表示「子孙含变更」；圆点颜色由状态染色 Class 的
 *   currentColor 决定，无单一字母语义。
 * @param {string} gitStatus 文件夹的聚合状态字符
 * @param {Function} t 国际化翻译函数
 * @returns {HTMLElement|null}
 */
function createFolderGitDot(gitStatus, t) {
  if (!gitStatus) return null;
  const cls = gitStatusClass(gitStatus);
  if (!cls) return null;
  const dot = el("span", "sfe-git-dot " + cls);
  dot.setAttribute("aria-hidden", "true");
  dot.title =
    typeof t === "function" ? t("git.folderChanged", "包含变更") : "包含变更";
  return dot;
}
