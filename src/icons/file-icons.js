/**
 * 文件图标模块 (src/icons/file-icons.js)
 * 采用 material-icon-theme（VSCode 官方文件图标主题）的彩色 SVG 图标：
 * 先按完整文件名、再按扩展名匹配专有彩色图标，其余回退通用文件/文件夹图标。
 */

import { el } from "../utils/dom.js";

// 图标数据在 chunks/icons.js，打开面板后安装。安装前退回无 SVG 的占位，避免入口打包整套图标。
let EXT_ICONS = Object.create(null);
let NAME_ICONS = Object.create(null);
let ICON_SVGS = Object.create(null);
let FILE = "file";
let FOLDER = "folder";
let FOLDER_OPEN = "folder-open";

/**
 * 安装全部文件图标数据。
 * @param {Object|null} mod chunks/icons.js 的导出
 */
export function installFileIcons(mod) {
  if (!mod || !mod.ICON_SVGS) return;
  EXT_ICONS = mod.EXT_ICONS || EXT_ICONS;
  NAME_ICONS = mod.NAME_ICONS || NAME_ICONS;
  ICON_SVGS = mod.ICON_SVGS;
  FILE = mod.FILE || FILE;
  FOLDER = mod.FOLDER || FOLDER;
  FOLDER_OPEN = mod.FOLDER_OPEN || FOLDER_OPEN;
}

/**
 * 解析文件名对应的图标 id
 * @param {string} fileName 文件名
 * @param {boolean} isDir 是否目录
 * @param {boolean} isExpanded 目录是否展开
 * @returns {string} 图标 id
 */
function resolveIconId(fileName, isDir, isExpanded) {
  if (isDir) {
    return isExpanded ? FOLDER_OPEN : FOLDER;
  }
  const lower = String(fileName || "").toLowerCase();
  if (NAME_ICONS[lower]) {
    return NAME_ICONS[lower];
  }
  const dot = lower.lastIndexOf(".");
  if (dot > 0) {
    const ext = lower.slice(dot + 1);
    if (EXT_ICONS[ext]) {
      return EXT_ICONS[ext];
    }
  }
  return FILE;
}

/**
 * 获取专有文件/文件夹图标 DOM 节点
 * @param {string} fileName 文件名
 * @param {boolean} isDir 是否是目录
 * @param {boolean} isExpanded 目录是否展开
 * @returns {HTMLElement} 包含对应 SVG 的 span 节点
 */
export function createFileIconNode(fileName, isDir, isExpanded) {
  const span = el("span", "sfe-type-icon");
  span.dataset.iconName = String(fileName || "");
  span.dataset.iconDir = isDir ? "1" : "0";
  span.dataset.iconOpen = isExpanded ? "1" : "0";
  const id = resolveIconId(fileName, isDir, isExpanded);
  const svg = ICON_SVGS[id] || ICON_SVGS[FILE];
  if (svg) {
    span.innerHTML = svg;
  }
  return span;
}

/**
 * 把已经挂上、但图标块尚未到达的占位填上 SVG。已有图标的节点不动。
 * @param {ParentNode|null} root 搜索范围
 */
export function refreshInstalledIcons(root) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  if (!ICON_SVGS[FILE] && !ICON_SVGS[FOLDER]) return;
  for (const span of root.querySelectorAll(".sfe-type-icon")) {
    if (span.childElementCount) continue;
    const id = resolveIconId(span.dataset.iconName || "", span.dataset.iconDir === "1", span.dataset.iconOpen === "1");
    const svg = ICON_SVGS[id] || ICON_SVGS[FILE];
    if (svg) span.innerHTML = svg;
  }
}

/**
 * 取已安装图标的 SVG 文本。动作图标里的品牌图标（go / wails / nodejs）与文件树共用这一份。
 * @param {string} id 图标 id
 * @returns {string}
 */
export function fileIconMarkup(id) {
  return ICON_SVGS[id] || "";
}
