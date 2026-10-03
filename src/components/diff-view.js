/**
 * 轻量 Unified / Split Diff 渲染组件 (src/components/diff-view.js)
 * 渲染 parseUnifiedDiff 的解析结果：hunk 头 + 双行号 + 增删着色；
 * 支持两种展示模式（对齐宿主 DiffViewer 的 unified / split 切换）：
 *   - unified：单列，删除行在上、新增行在下（经典 unified 视图）；
 *   - split：左右两栏，删除行占左栏、新增行占右栏，一一配对。
 * 不依赖任何第三方 diff 视图库（宿主用的 @git-diff-view 是打包进宿主渲染进程的
 * React 组件，既不在 window.snow 上，插件也无法 import，故只能自写轻量实现）。
 */

import { el } from "../utils/dom.js";
import { createActionIcon } from "../icons/action-icons.js";
import { buildSplitRows, buildFullFileDiff, buildFullSplitRows } from "../services/diff.js";
import { highlightCodeHtml } from "./highlighter.js";

/** 单次渲染的最大行数，防止超大 diff 阻塞界面 */
const MAX_RENDER_LINES = 8000;

/**
 * 渲染差异视图
 * @param {HTMLElement} parentEl 承载视图的容器
 * @param {Object} options
 * @param {Object|null} options.result parseUnifiedDiff 的解析结果
 * @param {string|null} [options.fullContent] 新版本完整文件内容
 * @param {string} [options.extension] 文件扩展名（不含点），用于选择 Prism 语法
 * @param {boolean} [options.loading] 是否加载中
 * @param {string} [options.error] 错误信息
 * @param {'unified'|'split'} [options.mode] 展示模式（默认 unified）
 * @param {'full'|'hunks'} [options.scopeMode] 范围模式（默认 full 完整文件，对标 VS Code）
 * @param {Function} [options.onSetMode] 切换展示模式回调 (mode)
 * @param {Function} [options.onSetScopeMode] 切换范围模式回调 (scopeMode)
 * @param {Function} options.t 国际化翻译函数
 */
export function renderDiffView(parentEl, {
  result,
  fullContent,
  extension,
  loading,
  error,
  mode,
  scopeMode,
  onSetMode,
  onSetScopeMode,
  t,
}) {
  parentEl.replaceChildren();

  if (loading) {
    parentEl.appendChild(emptyState(t("preview.loading", "正在读取…")));
    return;
  }
  if (error) {
    parentEl.appendChild(emptyState(t("preview.error", "无法读取：") + error, true));
    return;
  }
  if (!result) {
    parentEl.appendChild(emptyState(t("git.diffUnavailable", "无法读取差异")));
    return;
  }
  if (result.isBinary) {
    parentEl.appendChild(emptyState(t("git.diffBinary", "二进制文件，无法显示差异。")));
    return;
  }
  if (!result.hasHunks && (!fullContent || fullContent.length === 0)) {
    parentEl.appendChild(emptyState(t("git.noDiff", "无文本差异")));
    return;
  }

  const viewMode = mode === "split" ? "split" : "unified";
  // 默认为完整文件 (full)，如 VS Code 一样显示全部内容并标记差异
  const currentScope = scopeMode === "hunks" ? "hunks" : "full";
  const wrap = el("div", "sfe-diff-view");

  // 顶部条：增删统计 + 范围切换（完整文件/仅差异） + 展示模式切换（统一/分栏）
  const bar = el("div", "sfe-diff-bar");
  const stat = el("div", "sfe-diff-stat");
  stat.appendChild(el("span", "sfe-diff-stat-add", "+" + result.additions));
  stat.appendChild(el("span", "sfe-diff-stat-del", "-" + result.deletions));
  bar.appendChild(stat);

  const controls = el("div", "sfe-diff-controls");
  controls.appendChild(renderScopeSwitch(currentScope, t, onSetScopeMode));
  controls.appendChild(renderModeSwitch(viewMode, t, onSetMode));
  bar.appendChild(controls);
  wrap.appendChild(bar);

  const scroll = el("div", "sfe-diff-scroll" + (viewMode === "split" ? " split" : ""));
  let rendered = 0;
  let truncated = false;

  if (currentScope === "full" && (typeof fullContent === "string" || result.hasHunks)) {
    // 全文件模式：合成完整文件所有行（未改动行 + hunk 增删改行）
    const fullLines = buildFullFileDiff(result, fullContent);
    if (viewMode === "split") {
      for (const row of buildFullSplitRows(fullLines)) {
        if (rendered >= MAX_RENDER_LINES) {
          truncated = true;
          break;
        }
        scroll.appendChild(renderSplitRow(row, extension));
        rendered++;
      }
    } else {
      for (const line of fullLines) {
        if (rendered >= MAX_RENDER_LINES) {
          truncated = true;
          break;
        }
        scroll.appendChild(renderDiffLine(line, extension));
        rendered++;
      }
    }
  } else {
    // 仅差异片段模式 (hunks)
    for (const hunk of result.hunks) {
      if (truncated) break;
      scroll.appendChild(el("div", "sfe-diff-hunk-head", hunk.header));
      if (viewMode === "split") {
        for (const row of buildSplitRows(hunk)) {
          if (rendered >= MAX_RENDER_LINES) {
            truncated = true;
            break;
          }
          scroll.appendChild(renderSplitRow(row, extension));
          rendered++;
        }
      } else {
        for (const line of hunk.lines) {
          if (rendered >= MAX_RENDER_LINES) {
            truncated = true;
            break;
          }
          scroll.appendChild(renderDiffLine(line, extension));
          rendered++;
        }
      }
    }
  }

  wrap.appendChild(scroll);
  if (truncated) {
    wrap.appendChild(
      el(
        "div",
        "sfe-pv-note",
        t("preview.diffTruncated", "差异过大，仅显示前 {{count}} 行。", { count: MAX_RENDER_LINES })
      )
    );
  }
  parentEl.appendChild(wrap);
}

/**
 * 渲染范围模式切换分段控件（完整文件 / 仅差异）
 * @param {'full'|'hunks'} current 当前范围模式
 * @param {Function} t 国际化翻译函数
 * @param {Function} [onSetScope] 切换回调
 * @returns {HTMLElement}
 */
function renderScopeSwitch(current, t, onSetScope) {
  const switcher = el("div", "sfe-diff-mode-switch");
  switcher.setAttribute("role", "group");
  const segments = [
    { key: "full", label: t("diff.full", "完整文件") },
    { key: "hunks", label: t("diff.hunks", "仅差异") },
  ];
  for (const seg of segments) {
    const isActive = seg.key === current;
    const btn = el("button", "sfe-md-mode-btn" + (isActive ? " active" : ""));
    btn.type = "button";
    btn.title = seg.label;
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    btn.appendChild(el("span", "sfe-md-mode-label", seg.label));
    if (!isActive && typeof onSetScope === "function") {
      btn.addEventListener("click", () => onSetScope(seg.key));
    }
    switcher.appendChild(btn);
  }
  return switcher;
}

/**
 * 渲染展示模式切换分段控件（统一 / 分栏）
 * @param {'unified'|'split'} current 当前模式
 * @param {Function} t 国际化翻译函数
 * @param {Function} [onSetMode] 切换回调
 * @returns {HTMLElement}
 */
function renderModeSwitch(current, t, onSetMode) {
  const switcher = el("div", "sfe-diff-mode-switch");
  switcher.setAttribute("role", "group");
  const segments = [
    { key: "unified", icon: "unified", label: t("diff.unified", "统一视图") },
    { key: "split", icon: "split", label: t("diff.split", "分栏视图") },
  ];
  for (const seg of segments) {
    const isActive = seg.key === current;
    const btn = el("button", "sfe-md-mode-btn" + (isActive ? " active" : ""));
    btn.type = "button";
    btn.title = seg.label;
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    btn.appendChild(createActionIcon(seg.icon, 13));
    if (!isActive && typeof onSetMode === "function") {
      btn.addEventListener("click", () => onSetMode(seg.key));
    }
    switcher.appendChild(btn);
  }
  return switcher;
}

/**
 * 渲染单行 unified 差异（旧行号 / 新行号 / 标记 / 正文）
 * @param {{type:string, text:string, oldNo:number|null, newNo:number|null}} line 解析出的行
 * @param {string} [extension] 文件扩展名（不含点）
 * @returns {HTMLElement}
 */
function renderDiffLine(line, extension) {
  const row = el("div", "sfe-diff-line " + line.type);
  row.appendChild(el("span", "sfe-diff-no", line.oldNo == null ? "" : String(line.oldNo)));
  row.appendChild(el("span", "sfe-diff-no", line.newNo == null ? "" : String(line.newNo)));
  row.appendChild(el("span", "sfe-diff-sign", diffSign(line.type)));
  // 标记列与代码正文分离，Prism 只处理源码，避免把 +/- 当成语法内容。
  const text = el("span", "sfe-diff-text");
  text.innerHTML = highlightDiffText(line.text, extension, line.type);
  row.appendChild(text);
  return row;
}

/**
 * 渲染单行 split 差异（左栏删除 / 右栏新增，一一配对）
 * @param {{left: Object|null, right: Object|null}} row buildSplitRows 产出的分栏行
 * @returns {HTMLElement}
 */
function renderSplitRow(row, extension) {
  const line = el("div", "sfe-diff-split-row");
  line.appendChild(renderSplitCell(row.left, "left", extension));
  line.appendChild(renderSplitCell(row.right, "right", extension));
  return line;
}

/**
 * 渲染 split 的单个单元格（行号 + 标记 + 正文；空行留白占位）
 * @param {Object|null} cell 解析出的行或 null（对侧无配对行）
 * @param {'left'|'right'} side 所在栏
 * @param {string} [extension] 文件扩展名（不含点）
 * @returns {HTMLElement}
 */
function renderSplitCell(cell, side, extension) {
  if (!cell) return el("div", "sfe-diff-split-cell empty " + side);
  const type = cell.type === "meta" ? "meta" : cell.type;
  const box = el("div", "sfe-diff-split-cell " + type + " " + side);
  box.appendChild(el("span", "sfe-diff-no", cell.oldNo == null ? "" : String(cell.oldNo)));
  box.appendChild(el("span", "sfe-diff-no", cell.newNo == null ? "" : String(cell.newNo)));
  box.appendChild(el("span", "sfe-diff-sign", diffSign(cell.type)));
  // 与 unified 视图共用同一高亮入口，保证两种布局的颜色和安全策略一致。
  const text = el("span", "sfe-diff-text");
  text.innerHTML = highlightDiffText(cell.text, extension, cell.type);
  box.appendChild(text);
  return box;
}

/**
 * 对差异正文做语法高亮；元信息行不属于源代码，强制走纯文本安全转义。
 * @param {string} text 差异行正文
 * @param {string} [extension] 文件扩展名（不含点）
 * @param {string} type 差异行类型
 * @returns {string} 可安全写入 innerHTML 的高亮 HTML
 */
function highlightDiffText(text, extension, type) {
  return highlightCodeHtml(text, type === "meta" ? "" : extension);
}

/**
 * 差异行类型 → 行首标记字符
 * @param {string} type add|del|context|meta
 * @returns {string}
 */
function diffSign(type) {
  if (type === "add") return "+";
  if (type === "del") return "-";
  if (type === "meta") return "";
  return " ";
}

/**
 * 构建空态/提示节点
 * @param {string} text 提示文案
 * @param {boolean} [isError] 是否为错误态
 * @returns {HTMLElement}
 */
function emptyState(text, isError) {
  const empty = el("div", "sfe-file-viewer-empty" + (isError ? " error" : ""));
  empty.appendChild(el("div", null, text));
  return empty;
}
