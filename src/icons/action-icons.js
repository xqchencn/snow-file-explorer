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
  FileText,
  FileDiff,
  Rows3,
  Columns2,
  ArrowUp,
  ArrowDown,
  ArrowDownUp,
  GitBranch,
  FolderOpen,
} from 'lucide';

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
};

/**
 * 创建动作图标 SVG 节点
 * @param {'chevronRight'|'chevronDown'|'refresh'|'sync'|'copy'|'check'|'eye'|'pencil'|'code'|'more'|'square'|'sparkles'|'gitCommit'|'minus'|'plus'|'undo'|'fileText'|'diff'|'unified'|'split'|'arrowUp'|'arrowDown'|'branch'|'folderOpen'} name 图标名称
 * @param {number} [size=14] 图标大小
 * @returns {SVGSVGElement|HTMLElement}
 */
export function createActionIcon(name, size = 14) {
  const iconDef = ICON_MAP[name] || ChevronRight;
  // 注意：lucide createElement 只识别 width/height 等 SVG 属性，不识别 size（React 专有）。
  // 传 size 会被当作无效属性忽略，导致图标始终按默认 24×24 渲染而溢出容器。
  return createElement(iconDef, {
    width: size,
    height: size,
    "stroke-width": 1.8,
  });
}
