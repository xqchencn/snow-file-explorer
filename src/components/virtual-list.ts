/**
 * 固定行高窗口化虚拟列表 (src/components/virtual-list.ts)
 * @description 只渲染「可视区 + 上下缓冲」的行，DOM 数量与总行数解耦，
 *   从而支持打开超大文件 / 超大 diff 而不卡顿，且不需要截断内容。
 *   窗口位移按首尾差集增删行（下标即行身份），只在换数据 / 改行高 / refresh /
 *   滚动跨度大过整窗时整窗重建；渲染所需的布局读数一律先读后写，避免强制同步布局。
 *   约束：行高必须固定（等宽代码行天然满足）；动态行高需另写测量方案。
 */

/** 上下各多渲染的行数，缓解快速滚动时的白屏 */
const OVERSCAN = 8;
/** 容器尚未布局（clientHeight 为 0，如测试环境或首帧）时的兜底可视高度 */
const FALLBACK_VIEWPORT_HEIGHT = 600;

/** 帧调度句柄：有 requestAnimationFrame 时是 number，测试等环境用 setTimeout 顶替。 */
type FrameHandle = number | ReturnType<typeof setTimeout>;

/**
 * 一次渲染所需的布局读数。
 * 必须在写样式之前取好：写完 spacer / scrollTop 再读 clientHeight 会强制同步布局，
 * 而这正是本模块要避免的（render 只能在读数就绪后拿到它，不再自己读盘）。
 */
type LayoutSnapshot = {
  /** 滚动容器的纵向偏移。 */
  scrollTop: number;
  /** 滚动容器的可视高度；未布局时为 0，由 render 兜底。 */
  viewportHeight: number;
};

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
  /** 内容层附加类名（如树列表的 .sfe-list），用于复用既有行样式与焦点样式。 */
  contentClassName?: string;
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
  /** 全量替换数据并同步渲染首屏（返回时内容层已有可视行）。 */
  setItems: (nextItems: VirtualItems<T>) => void;
  /** 滚动到指定行下标（0 基），用于 hunk 跳转等定位未渲染行；行在下一帧补上。 */
  scrollToIndex: (index: number) => void;
  /** 强制按当前尺寸重绘（容器尺寸变化后调用）。 */
  refresh: () => void;
  /** 读取当前渲染区间与行高。 */
  getRange: () => VirtualListRange;
  /** 校准固定行高（px）：行高来自真实渲染测量时使用，更新 spacer 与可视区间（下一帧生效）。 */
  setRowHeight: (px: number) => void;
  /** 内容层元素（可视行的直接父节点）；供调用方挂事件委托与焦点。 */
  contentEl: HTMLElement;
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
  contentClassName,
}: VirtualListOptions<T>): VirtualListHandle<T> {
  let rowHeightPx = resolveRowHeight(viewport, rowHeight);

  // 结构：viewport > spacer(撑出总高度) + content(绝对定位，仅承载可视行)
  const spacer = document.createElement("div");
  spacer.className = "sfe-vlist-spacer";
  spacer.setAttribute("aria-hidden", "true");
  const content = document.createElement("div");
  content.className = "sfe-vlist-content" + (contentClassName ? " " + contentClassName : "");
  viewport.appendChild(spacer);
  viewport.appendChild(content);

  let items: VirtualItems<T> = [];
  /** 内容层已渲染窗口的首行下标；-1 表示窗口作废（换数据 / 改行高 / refresh），下次渲染整窗重建。 */
  let startIndex = -1;
  /** 窗口末行下标（不含）。不变量：content 的子节点顺序恒等于 [startIndex, endIndex) 的下标顺序。 */
  let endIndex = -1;
  let rafId: FrameHandle = 0;
  let destroyed = false;

  /** 读取布局读数；务必在任何样式写入之前调用。 */
  const readLayout = (): LayoutSnapshot => ({
    scrollTop: viewport.scrollTop,
    viewportHeight: viewport.clientHeight,
  });

  /** 容器未布局（clientHeight 为 0，如测试环境或首帧）时按兜底高度算窗口。 */
  const effectiveViewportHeight = (measured: number) =>
    measured > 0 ? measured : FALLBACK_VIEWPORT_HEIGHT;

  const computeRange = (layout: LayoutSnapshot) => {
    const total = items.length;
    const visible = Math.ceil(effectiveViewportHeight(layout.viewportHeight) / rowHeightPx) + OVERSCAN * 2;
    // 快照 scrollTop 可能超出当前内容（换数据前的旧值），下标须夹在 total 内，否则窗口倒挂成空。
    const first = Math.min(total, Math.max(0, Math.floor(layout.scrollTop / rowHeightPx) - OVERSCAN));
    return { first, last: Math.min(total, first + visible) };
  };

  /** 按下标产出行节点：下标即身份，行内容不做跨下标复用（那是调用方的事）。 */
  const buildRow = (index: number): HTMLElement => renderRow(items.at(index) as T, index);

  /** 整窗重建：窗口内没有一行能对应上新下标时使用。 */
  const fillWindow = (first: number, last: number) => {
    const frag = document.createDocumentFragment();
    // first/last 已被 computeRange 夹在 [0, items.length] 内，下标必然落在有效行上。
    for (let i = first; i < last; i++) frag.appendChild(buildRow(i));
    content.replaceChildren(frag);
  };

  /**
   * 窗口位移的增量更新：删掉滑出窗口的头尾，再在滑入的一侧补入新行，
   * 中间已渲染的行（含调用方就地 patch 的选中态与高亮）原样留在 DOM 里。
   * @param prevStart 上一窗口的首行下标
   * @param prevEnd 上一窗口的末行下标（不含）
   * @param first 新窗口的首行下标
   * @param last 新窗口的末行下标（不含）
   */
  const slideWindow = (prevStart: number, prevEnd: number, first: number, last: number) => {
    const keepStart = Math.max(first, prevStart);
    const keepEnd = Math.min(last, prevEnd);
    for (let i = keepStart - prevStart; i > 0; i--) content.firstElementChild?.remove();
    for (let i = prevEnd - keepEnd; i > 0; i--) content.lastElementChild?.remove();
    if (keepStart > first) {
      const frag = document.createDocumentFragment();
      for (let i = first; i < keepStart; i++) frag.appendChild(buildRow(i));
      // fragment 内的顺序即下标顺序，整段插到最前即可，不会打乱与下标的对齐。
      content.insertBefore(frag, content.firstElementChild);
    }
    if (last > keepEnd) {
      const frag = document.createDocumentFragment();
      for (let i = keepEnd; i < last; i++) frag.appendChild(buildRow(i));
      content.appendChild(frag);
    }
  };

  /**
   * 按布局读数渲染当前窗口
   * @param layout 渲染所需布局读数（须在写入样式前取好；rAF 帧内取即最新）
   */
  const render = (layout: LayoutSnapshot) => {
    if (destroyed) return;
    const { first, last } = computeRange(layout);
    // 区间未变则不重绘，保住行内选中与滚动流畅
    if (first === startIndex && last === endIndex && content.childElementCount) return;
    // 窗口作废（换数据 / 改行高 / refresh）或新旧窗口不相交时没有一行可复用，只能整窗重建；
    // 其余情况（滚动的常态是单端移动）都只补删差集。
    const keepStart = Math.max(first, startIndex);
    const keepEnd = Math.min(last, endIndex);
    if (startIndex < 0 || keepEnd <= keepStart) fillWindow(first, last);
    else slideWindow(startIndex, endIndex, first, last);
    startIndex = first;
    endIndex = last;
    content.style.transform = `translateY(${first * rowHeightPx}px)`;
    if (typeof onRangeChange === "function") onRangeChange(first, last);
  };

  const scheduleRender = () => {
    if (rafId || destroyed) return;
    rafId = raf(() => {
      rafId = 0;
      render(readLayout());
    });
  };

  const handleScroll = () => scheduleRender();
  viewport.addEventListener("scroll", handleScroll, { passive: true });

  /**
   * 全量替换数据并同步渲染首屏
   * @param nextItems 行数据数组，或只暴露 length + at() 的按需访问器
   */
  const setItems = (nextItems: VirtualItems<T>) => {
    items = Array.isArray(nextItems) || (nextItems && typeof nextItems.length === "number" && typeof nextItems.at === "function")
      ? nextItems
      : [];
    // 读数早于 spacer 写入：换数据时同步出首屏（调用方紧接着就恢复 scrollTop / 读行），
    // 把强制同步布局的代价挡在写入之前，是这条路径能保住的最好形态。
    const layout = readLayout();
    spacer.style.height = `${items.length * rowHeightPx}px`;
    // spacer 变矮后浏览器会把 scrollTop 夹回新的滚动范围；按同一公式先夹一次，
    // 免得用换数据前的旧位置算出一个空窗口（收起长目录后的首帧即空）。
    const maxScroll = Math.max(0, items.length * rowHeightPx - effectiveViewportHeight(layout.viewportHeight));
    layout.scrollTop = Math.min(layout.scrollTop, maxScroll);
    // 下标不再指向原来那一行，差集失去意义 → 作废窗口，让 render 走整窗重建。
    startIndex = -1;
    endIndex = -1;
    render(layout);
  };

  /**
   * 滚动到指定行索引（用于 diff hunk 跳转等）
   * @param index 行索引（0 基）
   */
  const scrollToIndex = (index: number) => {
    if (!items.length) return;
    const i = Math.max(0, Math.min(items.length - 1, index));
    viewport.scrollTop = i * rowHeightPx;
    // scrollTop 写入使布局失效：渲染合进本帧 rAF（先于该帧绘制），不再同帧回读布局。
    scheduleRender();
  };

  /** 强制按当前尺寸重绘（容器尺寸变化后调用） */
  const refresh = () => {
    startIndex = -1;
    endIndex = -1;
    render(readLayout());
  };

  /**
   * 校准固定行高（px）
   * @param px 实测行高；非正数或与当前一致时忽略
   * @description 行高来自真实渲染测量（如树行内容驱动高度）时，首帧后校准一次，
   *   保证 spacer 总高度与 translateY 步长和真实行堆叠一致。
   */
  const setRowHeight = (px: number) => {
    if (!(px > 0) || px === rowHeightPx) return;
    rowHeightPx = px;
    spacer.style.height = `${items.length * rowHeightPx}px`;
    // 可视行数随行高变了 → 作废窗口，走整窗重建；渲染合到 rAF，spacer 写完不再回读布局。
    startIndex = -1;
    endIndex = -1;
    scheduleRender();
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

  return { setItems, scrollToIndex, refresh, getRange, setRowHeight, contentEl: content, destroy };
}
