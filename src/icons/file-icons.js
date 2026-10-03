/**
 * 文件图标模块 (src/icons/file-icons.js)
 * 采用 material-icon-theme（VSCode 官方文件图标主题）的彩色 SVG 图标：
 * 先按完整文件名、再按扩展名匹配专有彩色图标，其余回退通用文件/文件夹图标。
 */

import { el } from "../utils/dom.js";
import {
  EXT_ICONS,
  NAME_ICONS,
  ICON_SVGS,
  FILE,
  FOLDER,
  FOLDER_OPEN,
} from "./icon-data.js";

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
  const id = resolveIconId(fileName, isDir, isExpanded);
  const svg = ICON_SVGS[id] || ICON_SVGS[FILE];
  if (svg) {
    span.innerHTML = svg;
  }
  return span;
}
