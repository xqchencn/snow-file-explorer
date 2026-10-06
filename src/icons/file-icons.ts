/**
 * 文件图标模块 (src/icons/file-icons.ts)
 * 采用 material-icon-theme（VSCode 官方文件图标主题）的彩色 SVG 图标：
 * 先按完整文件名、再按扩展名匹配专有彩色图标，其余回退通用文件/文件夹图标。
 */

import { el } from "../utils/dom.ts";

/** 懒加载图标块（chunks/icons.js，真源 src/icons/icon-data.ts）的导出形状。 */
export type FileIconModule = {
  /** 扩展名（小写、不含点）→ 图标 id；缺省时沿用已安装的表。 */
  EXT_ICONS?: Record<string, string>;
  /** 完整文件名（小写）→ 图标 id；缺省时沿用已安装的表。 */
  NAME_ICONS?: Record<string, string>;
  /** 图标 id → 彩色 SVG 源码；缺失即视为块未就绪，整个安装跳过。 */
  ICON_SVGS?: Record<string, string>;
  /** 通用文件图标 id；缺省时沿用内置的 "file"。 */
  FILE?: string;
  /** 通用文件夹图标 id；缺省时沿用内置的 "folder"。 */
  FOLDER?: string;
  /** 通用展开文件夹图标 id；缺省时沿用内置的 "folder-open"。 */
  FOLDER_OPEN?: string;
};

// 图标数据在 chunks/icons.js，打开面板后安装。安装前退回无 SVG 的占位，避免入口打包整套图标。
let EXT_ICONS: Record<string, string> = Object.create(null);
let NAME_ICONS: Record<string, string> = Object.create(null);
let ICON_SVGS: Record<string, string> = Object.create(null);
let FILE = "file";
let FOLDER = "folder";
let FOLDER_OPEN = "folder-open";

/**
 * 安装全部文件图标数据。
 * @param mod chunks/icons.js 的导出；null/未就绪时保持现状
 */
export function installFileIcons(mod: FileIconModule | null | undefined): void {
  if (!mod || !mod.ICON_SVGS) return;
  EXT_ICONS = mod.EXT_ICONS || EXT_ICONS;
  NAME_ICONS = mod.NAME_ICONS || NAME_ICONS;
  ICON_SVGS = mod.ICON_SVGS;
  FILE = mod.FILE || FILE;
  FOLDER = mod.FOLDER || FOLDER;
  FOLDER_OPEN = mod.FOLDER_OPEN || FOLDER_OPEN;
  // 数据源整体替换：已解析的 template 缓存随旧数据失效，必须清空重建。
  iconTemplateCache.clear();
}

/**
 * 解析文件名对应的图标 id
 * @param fileName 文件名
 * @param isDir 是否目录
 * @param isExpanded 目录是否展开
 * @returns 图标 id
 */
function resolveIconId(fileName: string, isDir: boolean, isExpanded: boolean): string {
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
 * 已解析图标的缓存：图标 id → 承载该 SVG 的 template 元素。
 * @description 同一图标的 SVG 文本内容固定；逐行 innerHTML 会每次重新走 HTML 解析，
 *   大目录首次渲染数千行时成为显著开销。预解析一次后按 id cloneNode 复用。
 */
const iconTemplateCache = new Map<string, HTMLTemplateElement | null>();

/**
 * 取图标 id 对应的可克隆内容片段（首次访问时解析 SVG 文本）
 * @param id 图标 id
 * @returns 含 SVG 子节点的克隆片段；图标不存在或解析为空时为 null
 */
function cloneIconContent(id: string): DocumentFragment | null {
  let tpl = iconTemplateCache.get(id);
  if (tpl === undefined) {
    const svg = ICON_SVGS[id];
    if (svg) {
      tpl = document.createElement("template");
      tpl.innerHTML = svg;
    } else {
      tpl = null;
    }
    iconTemplateCache.set(id, tpl);
  }
  return tpl ? tpl.content.cloneNode(true) as DocumentFragment : null;
}

/**
 * 获取专有文件/文件夹图标 DOM 节点
 * @param fileName 文件名
 * @param isDir 是否是目录
 * @param isExpanded 目录是否展开
 * @returns 包含对应 SVG 的 span 节点
 */
export function createFileIconNode(fileName: string, isDir: boolean, isExpanded: boolean): HTMLSpanElement {
  const span = el("span", "sfe-type-icon");
  span.dataset.iconName = String(fileName || "");
  span.dataset.iconDir = isDir ? "1" : "0";
  span.dataset.iconOpen = isExpanded ? "1" : "0";
  const id = resolveIconId(fileName, isDir, isExpanded);
  const frag = cloneIconContent(id) || cloneIconContent(FILE);
  if (frag) {
    span.appendChild(frag);
  }
  return span;
}

/**
 * 把已经挂上、但图标块尚未到达的占位填上 SVG。已有图标的节点不动。
 * @param root 搜索范围
 */
export function refreshInstalledIcons(root: ParentNode | null | undefined): void {
  if (!root || typeof root.querySelectorAll !== "function") return;
  if (!ICON_SVGS[FILE] && !ICON_SVGS[FOLDER]) return;
  // .sfe-type-icon 全部由本模块用 span 创建，dataset 只在 HTMLElement 上存在。
  for (const span of root.querySelectorAll<HTMLSpanElement>(".sfe-type-icon")) {
    if (span.childElementCount) continue;
    const id = resolveIconId(span.dataset.iconName || "", span.dataset.iconDir === "1", span.dataset.iconOpen === "1");
    const frag = cloneIconContent(id) || cloneIconContent(FILE);
    if (frag) span.appendChild(frag);
  }
}

/**
 * 取已安装图标的 SVG 文本。动作图标里的品牌图标（go / wails / nodejs）与文件树共用这一份。
 * @param id 图标 id
 * @returns 图标 SVG 文本；未安装该图标时为空串
 */
export function fileIconMarkup(id: string): string {
  return ICON_SVGS[id] || "";
}
