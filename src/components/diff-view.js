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
 * @param {Function} [options.onSetMode] 切换展示模式回调 (mode)
 * @param {Function} options.t 国际化翻译函数
 */
export function renderDiffView(parentEl, {
  result,
  fullContent,
  extension,
  loading,
  error,
  mode,
  onSetMode,
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
  // 差异范围固定为完整文件；用户只需要选择统一或分栏布局。
  const currentScope = "full";
  const wrap = el("div", "sfe-diff-view");
  const scroll = el("div", "sfe-diff-scroll" + (viewMode === "split" ? " split" : ""));
  const hunkAnchors = [];
  const hunkStartByLine = new Map();

  // 完整文件模式复用 hunk 行对象引用，用对象身份建立稳定的跳转锚点。
  result.hunks.forEach((hunk, index) => {
    if (hunk && Array.isArray(hunk.lines) && hunk.lines[0]) {
      hunkStartByLine.set(hunk.lines[0], index);
    }
  });

  const appendHunkAnchor = (index) => {
    if (hunkAnchors[index]) return;
    const anchor = el("div", "sfe-diff-hunk-anchor");
    anchor.dataset.hunkIndex = String(index);
    anchor.setAttribute("aria-hidden", "true");
    hunkAnchors[index] = anchor;
    scroll.appendChild(anchor);
  };

  const appendFullHunkAnchor = (value) => {
    const line = value && Object.prototype.hasOwnProperty.call(value, "left")
      ? value.left || value.right
      : value;
    const index = hunkStartByLine.get(line);
    if (index !== undefined) appendHunkAnchor(index);
  };

  // 顶部条：增删统计 + hunk 导航 + 展示模式切换（统一/分栏）
  const bar = el("div", "sfe-diff-bar");
  const stat = el("div", "sfe-diff-stat");
  stat.appendChild(el("span", "sfe-diff-stat-add", "+" + result.additions));
  stat.appendChild(el("span", "sfe-diff-stat-del", "-" + result.deletions));
  bar.appendChild(stat);

  const controls = el("div", "sfe-diff-controls");
  const hunkNavigator = renderHunkNavigator(scroll, hunkAnchors, result.hunks.length, t);
  controls.appendChild(hunkNavigator);
  controls.appendChild(renderModeSwitch(viewMode, t, onSetMode));
  bar.appendChild(controls);
  wrap.appendChild(bar);

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
        appendFullHunkAnchor(row);
        scroll.appendChild(renderSplitRow(row, extension));
        rendered++;
      }
    } else {
      for (const line of fullLines) {
        if (rendered >= MAX_RENDER_LINES) {
          truncated = true;
          break;
        }
        appendFullHunkAnchor(line);
        scroll.appendChild(renderDiffLine(line, extension));
        rendered++;
      }
    }
  } else {
    // 仅差异片段模式 (hunks)
    for (const [index, hunk] of result.hunks.entries()) {
      if (truncated) break;
      appendHunkAnchor(index);
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

  hunkNavigator.update();
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

// 范围模式固定为完整文件，不渲染范围切换控件。

/**
 * 渲染 hunk 上一个/下一个导航；按钮只在 Git 差异视图内部出现。
 * @param {HTMLElement} scroll 差异滚动容器
 * @param {Array<HTMLElement>} anchors 每个 hunk 的滚动锚点
 * @param {number} count hunk 总数
 * @param {Function} t 国际化翻译函数
 * @returns {HTMLElement}
 */
function renderHunkNavigator(scroll, anchors, count, t) {
  const nav = el("div", "sfe-diff-hunk-nav");
  // -1 表示尚未定位到任何 hunk；即使只有一个 hunk，也必须允许首次点击下箭头跳过去。
  let current = -1;
  const previous = el("button", "sfe-diff-nav-btn sfe-diff-nav-previous");
  const position = el("span", "sfe-diff-hunk-position");
  const next = el("button", "sfe-diff-nav-btn sfe-diff-nav-next");
  previous.type = "button";
  next.type = "button";
  previous.title = t("diff.previous", "上一个差异");
  next.title = t("diff.next", "下一个差异");
  previous.setAttribute("aria-label", previous.title);
  next.setAttribute("aria-label", next.title);
  previous.appendChild(createActionIcon("arrowUp", 13));
  next.appendChild(createActionIcon("arrowDown", 13));

  const update = () => {
    const total = Math.max(0, count);
    position.textContent = total ? `${current < 0 ? 0 : current + 1}/${total}` : "0/0";
    previous.disabled = current <= 0 || !anchors[current - 1];
    next.disabled = !anchors[0] || (current >= 0 && current >= total - 1);
  };
  const jump = (delta) => {
    const firstTargetIndex = current < 0 && delta > 0 ? 0 : current + delta;
    const targetIndex = Math.max(0, Math.min(Math.max(0, count - 1), firstTargetIndex));
    const target = anchors[targetIndex];
    if (!target) return;
    current = targetIndex;
    update();
    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "start" });
    } else {
      scroll.scrollTop = target.offsetTop;
    }
  };

  previous.addEventListener("click", () => jump(-1));
  next.addEventListener("click", () => jump(1));
  nav.appendChild(previous);
  nav.appendChild(position);
  nav.appendChild(next);
  nav.update = update;
  update();
  return nav;
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
