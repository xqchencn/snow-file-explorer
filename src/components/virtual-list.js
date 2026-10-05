/**
 * 固定行高窗口化虚拟列表 (src/components/virtual-list.js)
 * @description 只渲染「可视区 + 上下缓冲」的行，DOM 数量与总行数解耦，
 *   从而支持打开超大文件 / 超大 diff 而不卡顿，且不需要截断内容。
 *   约束：行高必须固定（等宽代码行天然满足）；动态行高需另写测量方案。
 */

/** 上下各多渲染的行数，缓解快速滚动时的白屏 */
const OVERSCAN = 8;
/** 容器尚未布局（clientHeight 为 0，如测试环境或首帧）时的兜底可视高度 */
const FALLBACK_VIEWPORT_HEIGHT = 600;

const raf =
  typeof requestAnimationFrame === "function"
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16);
const caf =
  typeof cancelAnimationFrame === "function"
    ? (id) => cancelAnimationFrame(id)
    : (id) => clearTimeout(id);

/**
 * 解析固定行高（px）
 * @param {HTMLElement} viewport 滚动容器
 * @param {number} [explicit] 显式指定行高
 * @returns {number} 行高（px）；无法解析时回退 20
 */
function resolveRowHeight(viewport, explicit) {
  if (typeof explicit === "number" && explicit > 0) return explicit;
  try {
    const lh = parseFloat(window.getComputedStyle(viewport).lineHeight);
    if (lh > 0) return lh;
  } catch {
    /* 测试环境可能没有 getComputedStyle，忽略 */
  }
  return 20;
}

/**
 * 创建虚拟列表
 * @param {Object} options
 * @param {HTMLElement} options.viewport 作为滚动容器的元素（需 overflow:auto 且 position:relative）
 * @param {number} [options.rowHeight] 固定行高（px）；省略时从容器 line-height 推断
 * @param {Function} options.renderRow (item, index) => HTMLElement 渲染单行
 * @param {Function} [options.onRangeChange] (start, end) => void 渲染区间变化回调
 * @returns {{setItems: Function, scrollToIndex: Function, getRange: Function, refresh: Function, destroy: Function}}
 */
export function createVirtualList({ viewport, rowHeight, renderRow, onRangeChange }) {
  const rowHeightPx = resolveRowHeight(viewport, rowHeight);

  // 结构：viewport > spacer(撑出总高度) + content(绝对定位，仅承载可视行)
  const spacer = document.createElement("div");
  spacer.className = "sfe-vlist-spacer";
  spacer.setAttribute("aria-hidden", "true");
  const content = document.createElement("div");
  content.className = "sfe-vlist-content";
  viewport.appendChild(spacer);
  viewport.appendChild(content);

  let items = [];
  let startIndex = -1;
  let endIndex = -1;
  let rafId = 0;
  let destroyed = false;

  const viewportHeight = () =>
    viewport.clientHeight > 0 ? viewport.clientHeight : FALLBACK_VIEWPORT_HEIGHT;

  const computeRange = () => {
    const total = items.length;
    const visible = Math.ceil(viewportHeight() / rowHeightPx) + OVERSCAN * 2;
    const first = Math.max(0, Math.floor(viewport.scrollTop / rowHeightPx) - OVERSCAN);
    return { first, last: Math.min(total, first + visible) };
  };

  const render = () => {
    if (destroyed) return;
    const { first, last } = computeRange();
    // 区间未变则不重绘，保住行内选中与滚动流畅
    if (first === startIndex && last === endIndex && content.childElementCount) return;
    startIndex = first;
    endIndex = last;
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) frag.appendChild(renderRow(items.at(i), i));
    content.replaceChildren(frag);
    content.style.transform = `translateY(${first * rowHeightPx}px)`;
    if (typeof onRangeChange === "function") onRangeChange(first, last);
  };

  const scheduleRender = () => {
    if (rafId || destroyed) return;
    rafId = raf(() => {
      rafId = 0;
      render();
    });
  };

  const handleScroll = () => scheduleRender();
  viewport.addEventListener("scroll", handleScroll, { passive: true });

  /**
   * 全量替换数据并重绘
   * @param {Array} nextItems 行数据数组
   */
  const setItems = (nextItems) => {
    items = Array.isArray(nextItems) || (nextItems && typeof nextItems.length === "number" && typeof nextItems.at === "function")
      ? nextItems
      : [];
    spacer.style.height = `${items.length * rowHeightPx}px`;
    startIndex = -1;
    endIndex = -1;
    render();
  };

  /**
   * 滚动到指定行索引（用于 diff hunk 跳转等）
   * @param {number} index 行索引（0 基）
   */
  const scrollToIndex = (index) => {
    if (!items.length) return;
    const i = Math.max(0, Math.min(items.length - 1, index));
    viewport.scrollTop = i * rowHeightPx;
    render();
  };

  /** 强制按当前尺寸重绘（容器尺寸变化后调用） */
  const refresh = () => {
    startIndex = -1;
    endIndex = -1;
    render();
  };

  /** 读取当前渲染区间与行高 */
  const getRange = () => ({ startIndex, endIndex, rowHeight: rowHeightPx });

  /** 销毁：移除监听与内部节点 */
  const destroy = () => {
    destroyed = true;
    viewport.removeEventListener("scroll", handleScroll);
    if (rafId) {
      caf(rafId);
      rafId = 0;
    }
    spacer.remove();
    content.remove();
  };

  return { setItems, scrollToIndex, refresh, getRange, destroy };
}
