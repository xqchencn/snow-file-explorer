/**
 * UI 动作图标模块 (src/icons/action-icons.ts)
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
  Globe,
  Play,
  RotateCw,
  Package,
  Terminal,
  X,
  Eraser,
  PanelRight,
  PanelBottom,
  Search,
} from 'lucide';
import type { IconNode } from 'lucide';
import { fileIconMarkup } from "./file-icons.ts";

const ICON_MAP: Record<string, IconNode> = {
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
  // HTTP 请求的 GUI 表单态：一行一字段的多列表单观感，沿用同一枚 Rows3。
  gui: Rows3,
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
  // HTTP 请求文件主视图入口（侧栏顶部，紧随 Git）：网络请求语义取 Globe。
  globe: Globe,
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
  // 文件搜索栏
  search: Search,
};

/**
 * 创建动作图标 SVG 节点。
 * @description 运行配置图标（go / wails / nodejs 等）复用已安装的文件图标 SVG（与文件树同一来源），
 *   其余走 lucide 动作图标。这样 Go / Wails / Node 图标不重复定义、来源统一。
 * @param name 图标名称（lucide 动作图标名，或 icon-data 中的图标 id 如 go / wails / nodejs）
 * @param [size=14] 图标大小
 * @returns lucide 生成的 SVG，或品牌图标的外层 span；未命中任何图标时退回 chevronRight
 */
export function createActionIcon(name: string, size = 14): SVGElement | HTMLSpanElement {
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
      // setAttribute 的 value 在 WebIDL 里是 DOMString，浏览器对 number 做隐式 ToString；
      // 这里显式 String(size) 取得同样的结果，不再用双重断言把 number→string 的不符压掉。
      svg.setAttribute("width", String(size));
      svg.setAttribute("height", String(size));
    }
    return wrap;
  }
  return createElement(ChevronRight, { width: size, height: size, "stroke-width": 1.8 });
}
