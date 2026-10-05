/**
 * UI 动作图标模块 (src/icons/action-icons.js)
 * 基于官方 lucide 依赖库构建，提供折叠、同步、刷新、复制、成功、预览/代码切换等标准矢量图标
 */

import {
  createElement,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Copy,
  Check,
  Eye,
  Pencil,
  Code,
  MoreHorizontal,
  Square,
  Sparkles,
  GitCommitHorizontal,
  Minus,
  Plus,
  Undo2,
  Scissors,
  ClipboardPaste,
  FileText,
  FileDiff,
  Rows3,
  Columns2,
  ArrowUp,
  ArrowDown,
  ArrowDownUp,
  GitBranch,
  FolderOpen,
  FolderGit2,
  Play,
  RotateCw,
  Package,
  Terminal,
  X,
  Eraser,
  PanelRight,
  PanelBottom,
} from 'lucide';
import { fileIconMarkup } from "./file-icons.js";

const ICON_MAP = {
  chevronRight: ChevronRight,
  chevronDown: ChevronDown,
  refresh: RefreshCw,
  copy: Copy,
  check: Check,
  eye: Eye,
  pencil: Pencil,
  code: Code,
  more: MoreHorizontal,
  square: Square,
  sparkles: Sparkles,
  gitCommit: GitCommitHorizontal,
  minus: Minus,
  plus: Plus,
  undo: Undo2,
  scissors: Scissors,
  clipboardPaste: ClipboardPaste,
  fileText: FileText,
  diff: FileDiff,
  // 差异视图模式切换：统一视图（Rows3）/ 分栏视图（Columns2），与宿主 DiffViewer 一致
  unified: Rows3,
  split: Columns2,
  // 同步：下载远端更新 + 上传本地提交。
  sync: ArrowDownUp,
  // 同步计数：未推送（↑，发往远端）/ 未拉取（↓，来自远端）。
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  // 当前分支（同步栏分支下拉触发器）
  branch: GitBranch,
  folderOpen: FolderOpen,
  // Git 变更主视图入口（侧栏顶部，与「文件」二选一）
  folderGit2: FolderGit2,
  // 项目运行：播放（启动命令）、重新运行（Rerun）、配置图标（Package）、终端（运行面板标题）、关闭（收起面板）、清空（输出区）
  play: Play,
  rerun: RotateCw,
  package: Package,
  terminal: Terminal,
  close: X,
  eraser: Eraser,
  // 工具窗口停靠：右侧（与代码预览同侧）/ 底栏
  panelRight: PanelRight,
  panelBottom: PanelBottom,
};

/**
 * 创建动作图标 SVG 节点。
 * @description 运行配置图标（go / wails / nodejs 等）复用已安装的文件图标 SVG（与文件树同一来源），
 *   其余走 lucide 动作图标。这样 Go / Wails / Node 图标不重复定义、来源统一。
 * @param {string} name 图标名称（lucide 动作图标名，或 icon-data 中的图标 id 如 go / wails / nodejs）
 * @param {number} [size=14] 图标大小
 * @returns {SVGSVGElement|HTMLElement}
 */
export function createActionIcon(name, size = 14) {
  // lucide 动作图标优先（chevronRight / play / copy…），避免 icon-data 同名 key 覆盖。
  const iconDef = ICON_MAP[name];
  if (iconDef) {
    // 注意：lucide createElement 只识别 width/height 等 SVG 属性，不识别 size（React 专有）。
    // 传 size 会被当作无效属性忽略，导致图标始终按默认 24×24 渲染而溢出容器。
    return createElement(iconDef, {
      width: size,
      height: size,
      "stroke-width": 1.8,
    });
  }
  // 否则取已安装的彩色品牌图标（go / wails / nodejs…），与文件树共用同一份 SVG。
  const svgMarkup = fileIconMarkup(name);
  if (svgMarkup) {
    const wrap = document.createElement("span");
    wrap.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;flex-shrink:0;`;
    wrap.innerHTML = svgMarkup;
    const svg = wrap.querySelector("svg");
    if (svg) {
      svg.setAttribute("width", size);
      svg.setAttribute("height", size);
    }
    return wrap;
  }
  return createElement(ChevronRight, { width: size, height: size, "stroke-width": 1.8 });
}
