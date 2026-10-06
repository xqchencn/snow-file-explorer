/**
 * 固定行高窗口化虚拟列表 (src/components/virtual-list.ts)
 * @description 只渲染「可视区 + 上下缓冲」的行，DOM 数量与总行数解耦，
 *   从而支持打开超大文件 / 超大 diff 而不卡顿，且不需要截断内容。
 *   约束：行高必须固定（等宽代码行天然满足）；动态行高需另写测量方案。
 */

/** 上下各多渲染的行数，缓解快速滚动时的白屏 */
const OVERSCAN = 8;
/** 容器尚未布局（clientHeight 为 0，如测试环境或首帧）时的兜底可视高度 */
const FALLBACK_VIEWPORT_HEIGHT = 600;

/** 帧调度句柄：有 requestAnimationFrame 时是 number，测试等环境用 setTimeout 顶替。 */
type FrameHandle = number | ReturnType<typeof setTimeout>;

const raf =
  typeof requestAnimationFrame === "function"
    ? (cb: () => void): FrameHandle => requestAnimationFrame(cb)
    : (cb: () => void): FrameHandle => setTimeout(cb, 16);
const caf =
  typeof cancelAnimationFrame === "function"
    // 两个分支成对使用：走到这里说明环境有原生 rAF，句柄必然是 number。
    ? (id: FrameHandle): void => cancelAnimationFrame(id as number)
    : (id: FrameHandle): void => clearTimeout(id);

/**
 * 虚拟列表的数据源形状：既接受普通数组，也接受 createFullDiffAccess 那种
 * 只暴露 length + at() 的按需访问器（只为可视下标物化行对象，不整份展开）。
 */
export type VirtualItems<T> = {
  /** 行总数：撑出 spacer 的可滚动高度，并作为可视区间上界。 */
  length: number;
  /** 按下标取行；下标越界返回 undefined。 */
  at: (index: number) => T | undefined;
};

/** createVirtualList 的入参。 */
export type VirtualListOptions<T> = {
  /** 作为滚动容器的元素（需 overflow:auto 且 position:relative）。 */
  viewport: HTMLElement;
  /** 固定行高（px）；省略时从容器 line-height 推断，推断失败按 20。 */
  rowHeight?: number;
  /** 渲染单行：返回的行节点由列表插入内容层。 */
  renderRow: (item: T, index: number) => HTMLElement;
  /** 渲染区间变化回调（起止下标，end 不含）；用于外部统计可视行。 */
  onRangeChange?: (start: number, end: number) => void;
};

/** 虚拟列表句柄读取到的当前渲染区间。 */
export type VirtualListRange = {
  /** 已渲染的首行下标；尚未渲染时为 -1。 */
  startIndex: number;
  /** 已渲染的末行下标（不含）；尚未渲染时为 -1。 */
  endIndex: number;
  /** 生效的固定行高（px）。 */
  rowHeight: number;
};

/** createVirtualList 的返回值：渲染容器与调用方之间唯一的交互面。 */
export type VirtualListHandle<T> = {
  /** 全量替换数据并重绘。 */
  setItems: (nextItems: VirtualItems<T>) => void;
  /** 滚动到指定行下标（0 基），用于 hunk 跳转等定位未渲染行。 */
  scrollToIndex: (index: number) => void;
  /** 强制按当前尺寸重绘（容器尺寸变化后调用）。 */
  refresh: () => void;
  /** 读取当前渲染区间与行高。 */
  getRange: () => VirtualListRange;
  /** 销毁：移除监听与内部节点。 */
  destroy: () => void;
};

/** 挂在渲染容器上的虚拟列表子集：容器只需要销毁与定位这两个动作。 */
export type VirtualListControls = {
  /** 滚动到指定行下标（0 基）。 */
  scrollToIndex: (index: number) => void;
  /** 释放滚动监听与内部节点。 */
  destroy: () => void;
};

declare global {
  interface HTMLElement {
    /** 该容器上正在挂载的虚拟列表句柄；未挂载时不存在或为 null。 */
    __sfeVList?: VirtualListControls | null;
  }
}

/**
 * 解析固定行高（px）
 * @param viewport 滚动容器
 * @param [explicit] 显式指定行高
 * @returns 行高（px）；无法解析时回退 20
 */
function resolveRowHeight(viewport: HTMLElement, explicit?: number): number {
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
 * @param options 配置项
 * @param options.viewport 作为滚动容器的元素（需 overflow:auto 且 position:relative）
 * @param [options.rowHeight] 固定行高（px）；省略时从容器 line-height 推断
 * @param options.renderRow (item, index) => HTMLElement 渲染单行
 * @param [options.onRangeChange] (start, end) => void 渲染区间变化回调
 * @returns setItems / scrollToIndex / refresh / getRange / destroy 句柄
 */
export function createVirtualList<T>({
  viewport,
  rowHeight,
  renderRow,
  onRangeChange,
}: VirtualListOptions<T>): VirtualListHandle<T> {
  const rowHeightPx = resolveRowHeight(viewport, rowHeight);

  // 结构：viewport > spacer(撑出总高度) + content(绝对定位，仅承载可视行)
  const spacer = document.createElement("div");
  spacer.className = "sfe-vlist-spacer";
  spacer.setAttribute("aria-hidden", "true");
  const content = document.createElement("div");
  content.className = "sfe-vlist-content";
  viewport.appendChild(spacer);
  viewport.appendChild(content);

  let items: VirtualItems<T> = [];
  let startIndex = -1;
  let endIndex = -1;
  let rafId: FrameHandle = 0;
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
    // first/last 已被 computeRange 夹在 [0, items.length) 内，下标必然落在有效行上。
    for (let i = first; i < last; i++) frag.appendChild(renderRow(items.at(i) as T, i));
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
   * @param nextItems 行数据数组，或只暴露 length + at() 的按需访问器
   */
  const setItems = (nextItems: VirtualItems<T>) => {
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
   * @param index 行索引（0 基）
   */
  const scrollToIndex = (index: number) => {
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
