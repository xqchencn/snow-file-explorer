/**
 * 轻量 Unified / Split Diff 渲染组件 (src/components/diff-view.ts)
 * 渲染 parseUnifiedDiff 的解析结果：hunk 头 + 双行号 + 增删着色；
 * 支持两种展示模式（对齐宿主 DiffViewer 的 unified / split 切换）：
 *   - unified：单列，删除行在上、新增行在下（经典 unified 视图）；
 *   - split：左右两栏（左=旧、右=新），**每栏独立横向滚动**（对标 VS Code），
 *     纵向滚动互锁同步。两个虚拟列表共享同一份行下标空间，配对关系由
 *     createFullDiffAccess(split) 保证：下标 i 的左右两行一一对应。
 * 语法高亮与代码查看器走**同一条管线**：逐行 highlightCodeHtml；
 * SFC（.vue/.svelte）按新版本全文解析区块语言（sfc-highlight.ts），
 * context/新增行按新行号精确取语言，删除行用所在 hunk 的 old→new 偏移近似。
 * 不依赖任何第三方 diff 视图库（宿主用的 @git-diff-view 是打包进宿主渲染进程的
 * React 组件，既不在 window.snow 上，插件也无法 import，故只能自写轻量实现）。
 */

import { el } from "../utils/dom.ts";
import { createActionIcon } from "../icons/action-icons.ts";
import { createFullDiffAccess } from "../services/diff.ts";
import type {
  DiffLine,
  DiffLineType,
  DiffSplitRow,
  UnifiedDiffResult,
} from "../services/diff.ts";
import type { DiffViewMode, TranslateFn } from "../types/panel-state.ts";
import { MAX_HIGHLIGHT_LINE_LEN } from "./highlight-policy.ts";
import { ensureHighlighter, highlighterReady, highlightCodeHtml } from "./highlight-client.ts";
import { isSfcExt, sfcLineLangs } from "./sfc-highlight.ts";
import { createVirtualList } from "./virtual-list.ts";
import type { VirtualListHandle } from "./virtual-list.ts";

/**
 * 渲染层看到的差异行：unified 的 DiffLine 与 split 的 DiffSplitRow 两种形态的并集视图。
 * @description 具体取哪一组字段由展示模式决定，因此两侧字段都可缺。
 */
export type RenderDiffRow = Partial<DiffLine> & Partial<DiffSplitRow>;

/** 虚拟列表的单个行项：只有一种形态（数据行），hunk 头由 diff.ts 归进行序列。 */
export type DiffRowItem = {
  /** 行项类型；唯一数据源 `src/services/diff.ts` 的 `createFullDiffAccess().at()` 只产出 "line"。 */
  kind: "line";
  /** unified 行或 split 配对行；下标越界时为 null（虚拟列表不会请求越界下标）。 */
  row: RenderDiffRow | null;
};

/** renderDiffView 的入参。 */
export type DiffViewOptions = {
  /** parseUnifiedDiff 的解析结果；null 表示尚未取到差异。 */
  result: UnifiedDiffResult | null;
  /** 新版本完整文件内容，用于把 hunk 之外的行补成全文差异；省略时只展补丁行。 */
  fullContent?: string | null;
  /** 文件扩展名（不含点），用于选择 Prism 语法；省略时不做语言映射。 */
  extension?: string;
  /** 是否加载中，仅显示占位文案。 */
  loading?: boolean;
  /** 错误信息；非空时渲染错误态。 */
  error?: string;
  /** 展示模式（默认 unified）。 */
  mode?: DiffViewMode;
  /** 切换展示模式回调 (mode)。 */
  onSetMode?: (mode: DiffViewMode) => void;
  /** 国际化翻译函数 */
  t: TranslateFn;
};

/** hunk 导航控件：按既有约定把刷新函数挂在容器节点上。 */
type HunkNavElement = HTMLDivElement & {
  /** 按当前定位刷新按钮可用态与计数文案。 */
  update: () => void;
};

/** 容器 → 视口尺寸观察器：重渲染时先断开旧的，避免同一容器叠加多个。 */
const diffViewportObservers = new WeakMap<HTMLElement, ResizeObserver>();

/**
 * 视口高度变化后让虚拟列表按新尺寸重算可视行数。
 * @description 此前只有高亮块到达时才 refresh()，面板由窄变宽/由隐藏转可见后仍按旧的
 *   clientHeight 出行数，底部留白要等下一次滚动才修好。回调只读 contentRect（不回读元素），
 *   同高度与零高度通知去重，重算合到一帧里跑。
 * @param parentEl 渲染容器（观察器句柄挂它上面，重渲染前统一断开）
 * @param scrollers 滚动容器列表（split 模式为左右两个）
 * @param refresh 任一视口尺寸变化后要执行的重算（split 时刷新两个列表）
 */
function observeDiffViewport(
  parentEl: HTMLElement,
  scrollers: HTMLElement[],
  refresh: () => void,
): void {
  const previous = diffViewportObservers.get(parentEl);
  if (previous) {
    previous.disconnect();
    diffViewportObservers.delete(parentEl);
  }
  if (typeof ResizeObserver !== "function") return;
  const lastHeights = new Map<HTMLElement, number>();
  let scheduled = false;
  let observer: ResizeObserver | null = null;
  const schedule = () => {
    if (scheduled || !scrollers.some((s) => s.isConnected)) return;
    scheduled = true;
    const run = () => {
      scheduled = false;
      if (scrollers.some((s) => s.isConnected)) refresh();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  };
  try {
    observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const height = entry.contentRect ? Math.round(entry.contentRect.height) : 0;
        if (!height || height === lastHeights.get(target)) continue;
        lastHeights.set(target, height);
        schedule();
      }
    });
    for (const scroller of scrollers) observer.observe(scroller);
  } catch {
    // 无布局/无观察能力的测试环境：静默降级，滚动时仍会自然重算。
    if (observer) observer.disconnect();
    return;
  }
  diffViewportObservers.set(parentEl, observer);
}

/**
 * 渲染差异视图
 * @param parentEl 承载视图的容器
 * @param options 差异结果与渲染配置，见 DiffViewOptions
 */
export function renderDiffView(parentEl: HTMLElement, {
  result,
  fullContent,
  extension,
  loading,
  error,
  mode,
  onSetMode,
  t,
}: DiffViewOptions) {
  // 释放上一次差异视图可能残留的虚拟列表（滚动监听 / 内部节点）与视口观察器
  if (parentEl.__sfeVList && typeof parentEl.__sfeVList.destroy === "function") {
    parentEl.__sfeVList.destroy();
    parentEl.__sfeVList = null;
  }
  const staleObserver = diffViewportObservers.get(parentEl);
  if (staleObserver) {
    staleObserver.disconnect();
    diffViewportObservers.delete(parentEl);
  }
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
  const ext = String(extension || "").toLowerCase().replace(/^\./, "");
  const wrap = el("div", "sfe-diff-view");

  // 1. 把差异序列化为统一的「行项」数组：unified 直接是行对象，split 是 {left,right} 配对。
  //    虚拟列表只渲染可视区的行项，DOM 数量与差异总行数解耦，因此无需再截断内容。
  //    行项携带 hunkIndex（hunk 头或该 hunk 首行），供 hunk 跳转按索引定位。
  // 全文按需取行：虚拟列表只为可视下标创建行对象，不先物化整份文件。
  const items = createFullDiffAccess(
    result,
    typeof fullContent === "string" ? fullContent : null,
    viewMode,
  );
  const hunkStartRow = items.hunkStartRow;

  // 2. SFC（.vue/.svelte）的逐行语言：与新文件同一套 sfc-highlight 解析。
  //    context / 新增 / 补齐行按新行号精确取语言；删除行（只有旧行号）用所在 hunk 的
  //    old→new 偏移（newStart - oldStart）近似映射到新文件位置——SFC 区块动辄几百行，
  //    hunk 头几行的偏差不会跨区块。非 SFC 文件恒用文件扩展名。
  let sfcLangs: string[] | null = null;
  const hunkDeltaRanges: Array<{ from: number; to: number; delta: number }> = [];
  if (isSfcExt(ext) && typeof fullContent === "string" && fullContent.length > 0) {
    sfcLangs = sfcLineLangs(fullContent.split(/\r\n|\r|\n/));
    for (const hunk of result.hunks) {
      hunkDeltaRanges.push({
        from: hunk.oldStart,
        to: hunk.oldStart + hunk.oldLines - 1,
        delta: hunk.newStart - hunk.oldStart,
      });
    }
  }
  const deltaForOld = (oldNo: number): number => {
    for (const range of hunkDeltaRanges) {
      if (oldNo >= range.from && oldNo <= range.to) return range.delta;
    }
    return 0;
  };
  const langForLine = (line: RenderDiffRow): string => {
    if (!sfcLangs) return ext;
    const newNo = line.newNo ?? (line.oldNo != null ? line.oldNo + deltaForOld(line.oldNo) : null);
    const lang = newNo != null ? sfcLangs[newNo - 1] : undefined;
    return lang || ext;
  };

  // 3. 虚拟列表。split 模式用左右两个列表共享同一行下标空间：每栏独立横向滚动
  //    （拖左边只动旧版本、拖右边只动新版本，对标 VS Code），纵向滚动互锁同步。
  //    此时 scroll 尚未挂载，setItems 延后到挂载后调用，clientHeight 才可用。
  const makeRowRenderer = (side: "unified" | "left" | "right") =>
    (item: DiffRowItem): HTMLElement => {
      const row = item.row;
      if (side === "unified") return renderDiffLine(row ?? {}, langForLine(row ?? {}));
      const cell = side === "left" ? row?.left ?? null : row?.right ?? null;
      return renderSplitCell(cell, side, cell ? langForLine(cell) : ext);
    };

  let listLeft: VirtualListHandle<DiffRowItem> | null = null;
  let listRight: VirtualListHandle<DiffRowItem> | null = null;
  const scrollers: HTMLElement[] = [];

  // 4. 顶部条：增删统计 + hunk 导航 + 展示模式切换（先入 wrap，滚动区排它后面）
  const bar = el("div", "sfe-diff-bar");
  const stat = el("div", "sfe-diff-stat");
  stat.appendChild(el("span", "sfe-diff-stat-add", "+" + result.additions));
  stat.appendChild(el("span", "sfe-diff-stat-del", "-" + result.deletions));
  bar.appendChild(stat);

  const jumpToHunk = (index: number) => {
    if (listLeft) listLeft.scrollToIndex(index);
    if (listRight) listRight.scrollToIndex(index);
  };
  const refreshAll = () => {
    if (listLeft) listLeft.refresh();
    if (listRight) listRight.refresh();
  };

  const controls = el("div", "sfe-diff-controls");
  const hunkNavigator = renderHunkNavigator(hunkStartRow, jumpToHunk, t);
  controls.appendChild(hunkNavigator);
  controls.appendChild(renderModeSwitch(viewMode, t, onSetMode));
  bar.appendChild(controls);
  wrap.appendChild(bar);
  parentEl.appendChild(wrap);

  if (viewMode === "split") {
    const splitBody = el("div", "sfe-diff-split-body");
    const scrollLeft = el("div", "sfe-diff-scroll side left");
    const scrollRight = el("div", "sfe-diff-scroll side right");
    listLeft = createVirtualList<DiffRowItem>({ viewport: scrollLeft, renderRow: makeRowRenderer("left") });
    listRight = createVirtualList<DiffRowItem>({ viewport: scrollRight, renderRow: makeRowRenderer("right") });
    // 纵向互锁：把 scrollTop 镜像给另一栏即可。同值赋值不会再触发 scroll 事件，
    // 镜像链条自然收敛，不会来回抖；各栏自己的虚拟列表监听各自的滚动补渲染窗口。
    const mirror = (source: HTMLElement, target: HTMLElement) => {
      if (target.scrollTop !== source.scrollTop) target.scrollTop = source.scrollTop;
    };
    scrollLeft.addEventListener("scroll", () => mirror(scrollLeft, scrollRight), { passive: true });
    scrollRight.addEventListener("scroll", () => mirror(scrollRight, scrollLeft), { passive: true });
    splitBody.appendChild(scrollLeft);
    splitBody.appendChild(scrollRight);
    wrap.appendChild(splitBody);
    scrollers.push(scrollLeft, scrollRight);
  } else {
    const scroll = el("div", "sfe-diff-scroll");
    listLeft = createVirtualList<DiffRowItem>({ viewport: scroll, renderRow: makeRowRenderer("unified") });
    wrap.appendChild(scroll);
    scrollers.push(scroll);
  }

  // 挂载后灌数据（clientHeight 才可用）。挂容器上的句柄统一暴露 scrollToIndex 与
  // destroy，code-viewer 的 disposeViewerViewport 只认这一份协议；分栏是两个列表的合体。
  if (listLeft && listRight) {
    const left = listLeft;
    const right = listRight;
    left.setItems(items);
    right.setItems(items);
    parentEl.__sfeVList = {
      scrollToIndex: (index: number) => {
        left.scrollToIndex(index);
        right.scrollToIndex(index);
      },
      destroy: () => {
        left.destroy();
        right.destroy();
        listLeft = null;
        listRight = null;
      },
    };
  } else if (listLeft) {
    listLeft.setItems(items);
    parentEl.__sfeVList = listLeft;
  }

  observeDiffViewport(parentEl, scrollers, refreshAll);
  // 高亮块未就绪时先出纯文本，加载完成只重绘当前可视行。
  if (!highlighterReady()) {
    void ensureHighlighter().then(() => {
      if (!scrollers.some((s) => s.isConnected) || !highlighterReady()) return;
      refreshAll();
    });
  }
}

// 范围模式固定为完整文件，不渲染范围切换控件。

/**
 * 渲染 hunk 上一个/下一个导航；按钮只在 Git 差异视图内部出现。
 * @param hunkStartRow 每个 hunk 在虚拟列表中的行下标
 * @param onJump (rowIndex) => void 跳转到指定行下标（由虚拟列表滚动）
 * @param t 国际化翻译函数
 * @returns 导航容器节点
 */
function renderHunkNavigator(hunkStartRow: number[], onJump: (rowIndex: number) => void, t: TranslateFn): HTMLDivElement {
  const nav = el("div", "sfe-diff-hunk-nav") as HunkNavElement;
  const count = Array.isArray(hunkStartRow) ? hunkStartRow.length : 0;
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
    previous.disabled = current <= 0 || hunkStartRow[current - 1] === undefined;
    next.disabled = hunkStartRow[0] === undefined || (current >= 0 && current >= total - 1);
  };
  const jump = (delta: number) => {
    const firstTargetIndex = current < 0 && delta > 0 ? 0 : current + delta;
    const targetIndex = Math.max(0, Math.min(Math.max(0, count - 1), firstTargetIndex));
    const rowIndex = hunkStartRow[targetIndex];
    if (rowIndex === undefined) return;
    current = targetIndex;
    update();
    onJump(rowIndex);
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
 * @param current 当前模式
 * @param t 国际化翻译函数
 * @param onSetMode 切换回调
 * @returns 分段控件容器
 */
function renderModeSwitch(current: DiffViewMode, t: TranslateFn, onSetMode?: (mode: DiffViewMode) => void): HTMLDivElement {
  const switcher = el("div", "sfe-diff-mode-switch");
  switcher.setAttribute("role", "group");
  const segments: Array<{ key: DiffViewMode; icon: string; label: string }> = [
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
 * 渲染单行 unified 差异（单列行号 + 标记 + 正文）
 * @param line 解析出的行
 * @param lang 该行的 Prism 语言（SFC 已按行解析出区块语言）
 * @returns 差异行节点
 * @description 行号只有一列：上下文 / 新增行显示新文件行号，删除行显示旧文件行号
 *   （对标 JetBrains 统一视图的合并行号槽）。曾渲染新旧两列，视觉上既挤又无用——
 *   要对照两侧行号该用分栏视图。
 */
function renderDiffLine(line: RenderDiffRow, lang: string): HTMLDivElement {
  const row = el("div", "sfe-diff-line " + line.type);
  const no = line.type === "del" ? line.oldNo : line.newNo;
  row.appendChild(el("span", "sfe-diff-no", no == null ? "" : String(no)));
  row.appendChild(el("span", "sfe-diff-sign", diffSign(line.type)));
  // 标记列与代码正文分离，Prism 只处理源码，避免把 +/- 当成语法内容。
  const text = el("span", "sfe-diff-text");
  applyDiffText(text, line.text, lang, line.type);
  row.appendChild(text);
  return row;
}

/**
 * 渲染 split 单栏的一个单元格（行号 + 标记 + 正文；对侧无配对行时留白占位）。
 * @description 分栏模式下单元格就是所在侧的一整行：每栏独立横向滚动，
 *   行号钉在左侧（拖动时保持可见）。
 * @param cell 解析出的行或 null（对侧无配对行）
 * @param side 所在栏
 * @param lang 该行的 Prism 语言（cell 为 null 时被忽略）
 * @returns 单元格节点
 */
function renderSplitCell(cell: DiffLine | null | undefined, side: "left" | "right", lang: string): HTMLDivElement {
  if (!cell) return el("div", "sfe-diff-split-cell empty " + side);
  const type = cell.type === "meta" ? "meta" : cell.type;
  const box = el("div", "sfe-diff-split-cell " + type + " " + side);
  // 每侧只显示自己这侧的行号（对标 VS Code 分栏）：左栏=旧行号，右栏=新行号。
  // buildSplitRows 的配对保证左栏只会是 del/context（有 oldNo）、右栏只会是 add/context（有 newNo）；
  // 旧实现两侧都渲染 oldNo+newNo，上下文行两侧都是「1 1」，整屏出现四列行号。
  const no = side === "left" ? cell.oldNo : cell.newNo;
  box.appendChild(el("span", "sfe-diff-no", no == null ? "" : String(no)));
  box.appendChild(el("span", "sfe-diff-sign", diffSign(cell.type)));
  // 与 unified 视图共用同一写入入口，保证两种布局的颜色和安全策略一致。
  const text = el("span", "sfe-diff-text");
  applyDiffText(text, cell.text, lang, cell.type);
  box.appendChild(text);
  return box;
}

/**
 * 把差异行正文写入文本节点。可视行走 Prism；超长单行和元信息行保持纯文本。
 * @param textEl 差异正文节点（.sfe-diff-text）
 * @param text 差异行正文
 * @param lang Prism 语言名（含 SFC 按行解析出的区块语言）
 * @param type 差异行类型
 */
function applyDiffText(
  textEl: HTMLSpanElement,
  text: string | undefined,
  lang: string | undefined,
  type: string | undefined,
): void {
  const source = String(text ?? "");
  if (type === "meta" || source.length > MAX_HIGHLIGHT_LINE_LEN || !highlighterReady()) {
    textEl.textContent = source;
    return;
  }
  // lang 缺失时高亮块按「无语言」处理，与原运行时行为一致。
  const html = highlightCodeHtml(source, lang || "");
  if (!html) {
    textEl.textContent = source;
    return;
  }
  textEl.innerHTML = html;
}

/**
 * 差异行类型 → 行首标记字符
 * @param type add|del|context|meta
 * @returns 行首标记字符
 */
function diffSign(type: DiffLineType | undefined): string {
  if (type === "add") return "+";
  if (type === "del") return "-";
  if (type === "meta") return "";
  return " ";
}

/**
 * 构建空态/提示节点
 * @param text 提示文案
 * @param [isError] 是否为错误态
 * @returns 空态节点
 */
function emptyState(text: string, isError?: boolean): HTMLDivElement {
  const empty = el("div", "sfe-file-viewer-empty" + (isError ? " error" : ""));
  empty.appendChild(el("div", null, text));
  return empty;
}
