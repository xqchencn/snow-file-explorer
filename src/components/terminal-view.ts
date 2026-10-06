/**
 * xterm 终端视图 (src/components/terminal-view.ts)
 *
 * 把一个 xterm 终端挂到宿主元素上，并接好双向交互所需的回调：
 *   - 键盘输入 → options.onData（调用方转发给 pty）
 *   - 尺寸变化 → options.onResize（调用方转发给 pty.resize）
 *   - 复制：Ctrl+C（有选区时复制到系统剪贴板，否则放行作 SIGINT）；粘贴交给浏览器原生 paste。
 *
 * 为什么用 xterm：宿主的 pty 是交互式 shell，输出含 ANSI 控制序列；
 *   自己用 <pre> 渲染需要重写整个终端仿真（颜色/光标/TUI），既复杂又不完整。
 *   xterm 是宿主自身终端所用的同一实现（snow-app TerminalPanelContent.tsx），
 *   直接复用即可得到与宿主终端一致的效果。
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

/**
 * requestAnimationFrame 的排队句柄。
 * @description 浏览器里是 rAF 返回的 number；无 rAF 的环境（单测 / 老内核）走
 *   `setTimeout` 兜底分支，句柄是 Timeout，故必须并进联合类型。
 */
type RafHandle = number | ReturnType<typeof setTimeout>;

/**
 * createXtermView 的入参：全部可缺，缺省即可读可写、右键不弹菜单。
 * @description 这些回调都由调用方（src/components/tool-window.ts 的 ensureViews）注入，
 *   最终转发到宿主 PTY（见 src/services/terminal-runner.ts 的 createPtySession）。
 */
export type XtermViewOptions = {
  /** 键盘输入回调（含控制字符，如 Ctrl+C 的 \\x03）；可缺，缺失时输入被丢弃。 */
  onData?: (data: string) => void;
  /** 尺寸变化回调；可缺，缺失时不通知 PTY resize。 */
  onResize?: (cols: number, rows: number) => void;
  /** 只读（模式 A 一次性运行）：禁止键盘输入；可缺，默认 false。 */
  readOnly?: boolean;
  /** 右键回调（由调用方弹菜单），参数是视口坐标；可缺，缺失时不拦截浏览器默认菜单。 */
  onContextMenu?: (x: number, y: number) => void;
  /** 选区变化回调（供调用方刷新「复制选中文本」按钮可用态）；可缺。 */
  onSelectionChange?: () => void;
};

/**
 * createXtermView 的返回：终端视图的对外操作面。
 * @description 除 cols / rows 是读取 xterm 当前尺寸的 getter 外，其余全是方法；
 *   每个方法内部都 try/catch，实例已释放时静默返回。
 */
export type XtermView = {
  /** 写入原始输出（含 ANSI，交给 xterm 解析）。 */
  write: (data: string) => void;
  /** 按容器尺寸重算终端行列数，并补挂 WebGL 渲染器、同步一次原生滚动。 */
  fit: () => void;
  /** 聚焦终端（元素未挂载时静默忽略）。 */
  focus: () => void;
  /** 视图隐藏 / 显示：隐藏期只攒输出不解析，重新显示时一次性冲刷。 */
  setHidden: (hidden: boolean) => void;
  /** 再排一次输出冲刷（容器刚拿到尺寸、或激活态变了时用）；队列空时是空操作。 */
  kick: () => void;
  /** 清空当前视口与回滚缓冲（只清显示，不杀进程）。 */
  clear: () => void;
  /** 滚动到底部（把视口拉回最新输出）。 */
  scrollToBottom: () => void;
  /** 是否有文本选区（右键菜单「复制」的可用性）。 */
  hasSelection: () => boolean;
  /** 读取当前选区文本；实例已释放时返回空串。 */
  getSelection: () => string;
  /** 粘贴文本到终端（走 xterm.paste，尊重 bracketed paste 模式）。 */
  paste: (text: string) => void;
  /** 全选终端缓冲。 */
  selectAll: () => void;
  /** 当前列数（xterm 实时值）。 */
  cols: number;
  /** 当前行数（xterm 实时值）。 */
  rows: number;
  /** 释放 xterm 实例、渲染器与全部监听。 */
  dispose: () => void;
};

/** bindNativeScroll 的返回：把宿主滚动条与 xterm 视口对齐的控制面。 */
type NativeScrollBinding = {
  /** 排一次「视口 → 滚动条」同步（内部用 rAF 合帧）。 */
  sync: () => void;
  /** 解绑滚动 / 滚轮监听与 xterm 订阅。 */
  dispose: () => void;
};

/** mountNativeScrollPort 的返回：原生滚动层的两个节点。 */
type NativeScrollPort = {
  /** 粘性容器：xterm 画在这里，滚动时不动。 */
  sticky: HTMLElement;
  /** 撑高度的占位节点，高度按回滚缓冲行数写入 style。 */
  spacer: HTMLElement;
};

/** 深色主题 ANSI 16 色：Windows Terminal 默认 (Campbell) 配色。 */
const DARK_THEME = {
  background: "#0E0E0E",
  foreground: "#e0e0e0",
  cursor: "#e0e0e0",
  selectionBackground: "rgba(255, 255, 255, 0.18)",
  black: "#0C0C0C",
  red: "#C50F1F",
  green: "#13A10E",
  yellow: "#C19C00",
  blue: "#0037DA",
  magenta: "#881798",
  cyan: "#3A96DD",
  white: "#CCCCCC",
  brightBlack: "#767676",
  brightRed: "#E74856",
  brightGreen: "#16C60C",
  brightYellow: "#F9F1A5",
  brightBlue: "#3B78FF",
  brightMagenta: "#B4009E",
  brightCyan: "#61D6D6",
  brightWhite: "#F2F2F2",
};

/** 浅色主题 ANSI 16 色：One Half Light 配色（white 固定为深灰，保证浅底可读）。 */
const LIGHT_THEME = {
  background: "#FBFCFD",
  foreground: "#333333",
  cursor: "#333333",
  selectionBackground: "rgba(0, 0, 0, 0.12)",
  black: "#383A42",
  red: "#E45649",
  green: "#50A14F",
  yellow: "#C18401",
  blue: "#0184BC",
  magenta: "#A626A4",
  cyan: "#0997B3",
  white: "#555555",
  brightBlack: "#4F525E",
  brightRed: "#E06C75",
  brightGreen: "#98C379",
  brightYellow: "#E5C07B",
  brightBlue: "#61AFEF",
  brightMagenta: "#C678DD",
  brightCyan: "#56B6C2",
  brightWhite: "#a5a5a5",
};

/** 依据宿主当前主题选择终端配色（跟随 data-theme，与宿主终端一致）。 */
function currentTheme() {
  if (typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark") {
    return DARK_THEME;
  }
  return LIGHT_THEME;
}

/** 写入系统剪贴板：优先宿主 IPC（渲染进程无权限限制），否则退化为标准 Clipboard API。 */
function writeClipboard(text: string): Promise<unknown> {
  const snow = typeof window !== "undefined" ? window.snow : null;
  if (snow && typeof snow.writeClipboardText === "function") return snow.writeClipboardText(text);
  if (typeof navigator !== "undefined" && navigator.clipboard) return navigator.clipboard.writeText(text);
  return Promise.resolve();
}

/**
 * 在宿主里铺一层和代码区相同的原生滚动结构。
 * 画面放在 sticky 里不动，spacer 把可滚动高度撑到回滚缓冲那么高。
 * @param host 终端挂载宿主元素
 * @returns 粘性容器与撑高度占位节点
 */
function mountNativeScrollPort(host: HTMLElement): NativeScrollPort {
  const sticky = document.createElement("div");
  sticky.className = "sfe-xterm-sticky";
  const spacer = document.createElement("div");
  spacer.className = "sfe-xterm-spacer";
  spacer.setAttribute("aria-hidden", "true");
  host.appendChild(sticky);
  host.appendChild(spacer);
  return { sticky, spacer };
}

/**
 * 把宿主的原生滚动位置和 xterm 视口对齐。
 * 滚轮停在捕获阶段，避免 xterm preventDefault 把浏览器的惯性滚动取消掉。
 * 备用屏和鼠标跟踪仍交给 xterm（vim / less 把滚轮当按键或鼠标上报）。
 * @param host 终端挂载宿主元素（滚动条在它身上）
 * @param spacer 撑可滚动高度的占位节点
 * @param term xterm 终端实例
 * @returns 同步与释放句柄，见 NativeScrollBinding
 */
function bindNativeScroll(host: HTMLElement, spacer: HTMLElement, term: Terminal): NativeScrollBinding {
  let applying = false;
  let queued: RafHandle = 0;

  const measureCellHeight = (): number => {
    const rows = term.rows || 0;
    if (rows < 1) return 0;
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    const canvas = screen ? screen.querySelector("canvas") : null;
    const styled = (el: HTMLElement | null): number => {
      if (!el) return 0;
      if (el.clientHeight > 0) return el.clientHeight;
      const parsed = parseFloat(el.style && el.style.height);
      return parsed > 0 ? parsed : 0;
    };
    // WebGL 会把屏幕高度写在 style 上；DOM 渲染则撑开 clientHeight。都没有时用粘性视口兜底。
    const height = styled(screen) || styled(canvas) || styled(host.querySelector<HTMLElement>(".sfe-xterm-sticky"));
    if (height <= 0) return 0;
    return height / rows;
  };

  // cellHeight 的测量含 3 次 querySelector + clientHeight 强制布局读取；
  // 结果只随 fit / resize / 渲染器变化，而那些时点都会经过 syncFromTerm（fit 后调用方必调 sync）。
  // 因此测量只在 syncFromTerm 里做并刷新缓存，高频的原生 scroll 事件直接读缓存。
  let cachedCell = 0;
  const cellHeight = (): number => (cachedCell > 0 ? cachedCell : measureCellHeight());

  const syncFromTerm = (): void => {
    if (applying) return;
    const cell = measureCellHeight();
    if (cell <= 0) return;
    cachedCell = cell;
    let maxLine;
    let viewportY;
    try {
      const buf = term.buffer.active;
      maxLine = Math.max(0, buf.baseY);
      viewportY = buf.viewportY;
    } catch {
      return;
    }
    const nextHeight = maxLine * cell;
    if (spacer.style.height !== `${nextHeight}px`) spacer.style.height = `${nextHeight}px`;
    // 用户正在拖/甩原生滚动条时，视口行已经跟上，不要回写 scrollTop，否则惯性会被掐断。
    const line = Math.round(host.scrollTop / cell);
    if (line === viewportY) return;
    applying = true;
    host.scrollTop = Math.min(viewportY, maxLine) * cell;
    applying = false;
  };

  const sync = (): void => {
    if (queued) return;
    const raf =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(cb, 16);
    queued = raf(() => {
      queued = 0;
      syncFromTerm();
    });
  };

  const onHostScroll = (): void => {
    if (applying) return;
    const cell = cellHeight();
    if (cell <= 0) return;
    const line = Math.round(host.scrollTop / cell);
    let viewportY;
    try {
      viewportY = term.buffer.active.viewportY;
    } catch {
      return;
    }
    if (line === viewportY) return;
    applying = true;
    try {
      term.scrollToLine(line);
    } catch {
      // 忽略：实例已释放
    }
    applying = false;
  };

  const onWheel = (event: WheelEvent): void => {
    if (event.shiftKey) return;
    let passThrough;
    try {
      passThrough = term.buffer.active.type === "alternate" || term.modes.mouseTrackingMode !== "none";
    } catch {
      return;
    }
    if (passThrough) return;
    // 不 preventDefault：浏览器才能对这条原生滚动条做惯性滑动。
    event.stopImmediatePropagation();
  };

  host.addEventListener("scroll", onHostScroll, { passive: true });
  host.addEventListener("wheel", onWheel, { capture: true, passive: false });
  const scrollSub = term.onScroll(() => sync());
  const parsedSub = term.onWriteParsed(() => sync());

  return {
    sync,
    dispose() {
      // as: queued 只在 rAF 可用的环境里被当作 number 传给 cancelAnimationFrame；
      //   rAF 缺失时走的是 setTimeout 兜底分支，那时 typeof cancelAnimationFrame 不是函数，
      //   这个守卫已经把整句短路掉，Timeout 句柄不会进到 cancelAnimationFrame 里。
      if (queued && typeof cancelAnimationFrame === "function") cancelAnimationFrame(queued as number);
      queued = 0;
      host.removeEventListener("scroll", onHostScroll);
      host.removeEventListener("wheel", onWheel, { capture: true });
      try {
        scrollSub.dispose();
        parsedSub.dispose();
      } catch {
        // 忽略：实例已释放
      }
    },
  };
}

/**
 * 一次 `term.write` 投喂的最大字符数（合帧切片上限）。
 * @description xterm 的 WriteBuffer 在 `_pendingData > 5e7`（五千万字符）时直接 throw
 *   `"write data discarded, use flow control to avoid losing data"`，且它每轮 `_innerWrite`
 *   只解析 12ms 就把主线程交还出去。512 KiB 一片既能把一帧攒下的成百条 chunk 合成一次解析
 *   （省掉逐条 write 的调度开销），又比抛错阈值低两个数量级：在途计数保证同一时刻最多一片
 *   没解析完，于是 `_pendingData` 的上界就是这个常量本身，那条 throw 分支从结构上走不到。
 */
const WRITE_SLICE_CHARS = 512 * 1024;

/** 在途 write 的解锁时限（毫秒）：回调因 xterm 内部异常不再触发时，队列不能永远堵死。 */
const WRITE_INFLIGHT_TIMEOUT_MS = 2000;

/** 连续写入失败达到该次数即放弃合帧，降级为逐块直写（成功一次后自动恢复合帧）。 */
const WRITE_FAILURE_LIMIT = 3;

/**
 * 积压队列的字符上限：超过即丢弃最旧的头部块（保新弃旧）。
 * @description 隐藏 / 未布局期间只攒不解析，若无上限，后台长跑进程会把整份日志积在
 *   队列里（旧实现写进 xterm 受 scrollback 5000 行约束，内存有界）。8 MiB 约等于
 *   scrollback 满载的数倍，正常冲刷路径（≤ 一片 512 KiB）永远不会触及。
 */
const WRITE_BACKLOG_LIMIT_CHARS = 8 * 1024 * 1024;

/** createWritePump 的返回：输出队列的控制面。 */
type WritePump = {
  /** 入队一段输出（原样含 ANSI），同一帧内的多段合并成一次 write。 */
  push: (text: string) => void;
  /** 视图隐藏 / 显示：隐藏期只入队不解析，显示时一次性冲刷。 */
  setHidden: (hidden: boolean) => void;
  /** 再排一次冲刷（fit 后用：容器刚拿到尺寸、或窗口刚从收起转为可见）。 */
  kick: () => void;
  /** 丢弃尚未冲刷的积压（清空输出时连未渲染的旧内容一起清掉）。 */
  drop: () => void;
  /** 停止调度并清空队列。 */
  dispose: () => void;
};

/**
 * 建一个「合帧 + 背压 + 不许炸」的输出泵。
 * 数据先进队列，一帧最多排一次 write；write 的回调作在途计数，上一片没解析完就下一帧再试；
 * 队列超切片阈值只「延后渲染」——留队下一帧继续搬，绝不丢字；整条路径 try/catch。
 * @param term 目标 xterm 实例
 * @param host 终端宿主元素（用它判断容器是否真的有尺寸）
 * @returns 队列控制面，见 WritePump
 */
function createWritePump(term: Terminal, host: HTMLElement): WritePump {
  let queue: string[] = [];
  let queuedChars = 0;
  let inFlight = 0;
  let inFlightAt = 0;
  let failures = 0;
  let scheduled: RafHandle = 0;
  let hidden = false;
  let direct = false;
  let disposed = false;

  // 容器量不出尺寸 = 宿主被收起了（display:none 的子树 clientWidth/Height 恒为 0）。
  const laidOut = (): boolean => (host.clientWidth || 0) >= 2 && (host.clientHeight || 0) >= 2;

  const cancelScheduled = (): void => {
    if (!scheduled) return;
    // as: rAF 缺失时句柄是 Timeout；那时 typeof cancelAnimationFrame 不是函数，整句短路，
    //   Timeout 不会混进 cancelAnimationFrame。
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(scheduled as number);
    else clearTimeout(scheduled as ReturnType<typeof setTimeout>);
    scheduled = 0;
  };

  const schedule = (): void => {
    if (scheduled || hidden || direct || disposed || !queue.length) return;
    const raf =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(cb, 16);
    scheduled = raf(() => {
      scheduled = 0;
      drain();
    });
  };

  /** 从队列取出一片（≤ WRITE_SLICE_CHARS）；取不出一片也不清空队列。 */
  const takeSlice = (): string => {
    if (!queue.length) return "";
    if (queuedChars <= WRITE_SLICE_CHARS) {
      const text = queue.join("");
      queue = [];
      queuedChars = 0;
      return text;
    }
    let taken = 0;
    let index = 0;
    while (index < queue.length && taken + queue[index].length <= WRITE_SLICE_CHARS) {
      taken += queue[index].length;
      index += 1;
    }
    if (index > 0) {
      const text = queue.slice(0, index).join("");
      queue.splice(0, index);
      queuedChars -= text.length;
      return text;
    }
    // 队首单块就超一片的上限（宿主一次灌入超长输出）：按字符切开，保证每帧都有进展。
    const head = queue[0];
    const text = head.slice(0, WRITE_SLICE_CHARS);
    queue[0] = head.slice(WRITE_SLICE_CHARS);
    queuedChars -= text.length;
    return text;
  };

  /**
   * 积压超限时丢弃最旧的头部块（保新弃旧，语义对齐 xterm scrollback 满载丢旧行）。
   * @description 只在 push 入队后调用：冲刷路径一次至多取走一片，队列本身不会越限。
   */
  const trimBacklog = (): void => {
    let overflow = queuedChars - WRITE_BACKLOG_LIMIT_CHARS;
    while (overflow > 0 && queue.length) {
      const head = queue[0];
      if (head.length > overflow) {
        queue[0] = head.slice(overflow);
        queuedChars -= overflow;
        overflow = 0;
      } else {
        overflow -= head.length;
        queuedChars -= head.length;
        queue.shift();
      }
    }
  };

  /** 直写一块：失败只丢这一块并继续写后面的，异常绝不逃逸回宿主的事件派发。 */
  const writeDirect = (text: string): void => {
    try {
      term.write(text, () => {
        if (!direct || disposed) return;
        // 直写能成功说明 xterm 又吃得下：回到合帧路径，别让批处理永久退化。
        direct = false;
        failures = 0;
        schedule();
      });
    } catch {
      // 忽略：降级路径里也没有更低的写法可用
    }
  };

  /** 把队列里的存量按上限切片逐块直写（进入降级模式、或降级模式下重新可见时用）。 */
  const drainDirectly = (): void => {
    direct = true;
    cancelScheduled();
    const backlog = queue;
    queue = [];
    queuedChars = 0;
    for (const chunk of backlog) {
      if (chunk.length <= WRITE_SLICE_CHARS) {
        writeDirect(chunk);
        continue;
      }
      for (let i = 0; i < chunk.length; i += WRITE_SLICE_CHARS) writeDirect(chunk.slice(i, i + WRITE_SLICE_CHARS));
    }
  };

  function drain(): void {
    if (disposed || hidden || direct) return;
    // 容器量不出尺寸 = 宿主被收起了，解析了也看不见：只攒不解析。
    // 冲刷的三个触发点都在别人手里——新输出入队（push）、视图转可见（setHidden）、
    // 容器重新拿到尺寸（fit 里的 kick），不需要在这里自轮询。
    if (!laidOut()) return;
    const now = Date.now();
    if (inFlight > 0) {
      if (now - inFlightAt < WRITE_INFLIGHT_TIMEOUT_MS) {
        schedule();
        return;
      }
      // 回调超时没回（xterm 某些异常路径会吞掉回调）：强制解锁，宁可多喂一片也不能永远停住。
      inFlight = 0;
    }
    const text = takeSlice();
    if (!text) return;
    let rejected: unknown = null;
    let threw = false;
    inFlight = 1;
    inFlightAt = now;
    try {
      term.write(text, () => {
        if (inFlight > 0) inFlight -= 1;
        failures = 0;
        schedule();
      });
    } catch (err) {
      threw = true;
      rejected = err;
    }
    if (!threw) return;
    // write 抛错：这片没进 xterm，放回队首保住字节序，下一帧重试。
    inFlight = 0;
    queue.unshift(text);
    queuedChars += text.length;
    failures += 1;
    if (failures < WRITE_FAILURE_LIMIT) {
      schedule();
      return;
    }
    console.warn("[FileExplorer] 终端输出合帧写入连续失败，降级为逐块直写", rejected);
    drainDirectly();
  }

  return {
    push(text: string): void {
      if (!text || disposed) return;
      if (direct && !hidden) {
        writeDirect(text);
        return;
      }
      queue.push(text);
      queuedChars += text.length;
      // 隐藏 / 未布局期间只攒不解析：积压超上限时丢最旧头部，内存有界（见 WRITE_BACKLOG_LIMIT_CHARS）。
      trimBacklog();
      schedule();
    },
    setHidden(next: boolean): void {
      if (hidden === next) return;
      hidden = next;
      if (hidden) {
        cancelScheduled();
        return;
      }
      if (direct) drainDirectly();
      else schedule();
    },
    kick(): void {
      schedule();
    },
    drop(): void {
      queue = [];
      queuedChars = 0;
      inFlight = 0;
      cancelScheduled();
    },
    dispose(): void {
      disposed = true;
      cancelScheduled();
      queue = [];
      queuedChars = 0;
      inFlight = 0;
    },
  };
}

/**
 * 创建 xterm 终端视图。
 * @param host 终端挂载宿主元素（必须有尺寸）
 * @param [options] 交互回调集合，逐项含义见 XtermViewOptions
 * @param [options.onData] 键盘输入回调
 * @param [options.onResize] 尺寸变化回调
 * @param [options.readOnly] 只读（模式 A 一次性运行）：禁止键盘输入
 * @param [options.onContextMenu] 右键回调（由调用方弹菜单）
 * @param [options.onSelectionChange] 选区变化回调（供调用方刷新「复制选中文本」按钮可用态）
 * @returns 视图操作面，形状见 XtermView
 */
export function createXtermView(host: HTMLElement, options: XtermViewOptions = {}): XtermView {
  const { onData, onResize, readOnly = false, onContextMenu, onSelectionChange } = options;

  const term = new Terminal({
    cursorBlink: readOnly !== true,
    // 只读（模式 A）：disableStdin 让 xterm 不再产生 onData，用户无法干扰排队的退出指令。
    disableStdin: readOnly === true,
    fontFamily: "'Cascadia Mono', 'Consolas', 'Courier New', monospace",
    fontSize: 12,
    scrollback: 5000,
    theme: currentTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  // DOM 渲染器在滚动时要逐行改 DOM，输出一长就卡。WebGL 只负责把字形画在画布上。
  // 滚动手感不靠它：xterm 自带滑块在 Windows 上横移超过一段距离就会松手回弹，
  // 滚轮也没有惯性。下面的原生滚动层才和代码区一样，滑一下会带着走。
  let webgl: WebglAddon | null = null;
  let webglFailed = false;
  const attachWebgl = () => {
    if (webgl || webglFailed) return;
    const width = host.clientWidth || 0;
    const height = host.clientHeight || 0;
    if (width < 2 || height < 2) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        // addon 内部已经给过 3s 的 contextrestored 窗口才走到这里，再建一个新上下文等于
        // 把显存重新分配一遍、然后大概率再丢一次：置 webglFailed 让 attachWebgl 永久早退。
        webglFailed = true;
        if (webgl === addon) webgl = null;
        try {
          // dispose 会触发 addon 自己注册的还原回调：_renderService.setRenderer(_createRenderer())，
          // 即换回默认 DOM 渲染器，所以此后 DOM 路径照常出画面。
          addon.dispose();
        } catch {
          // 上下文已经丢了
        }
      });
      term.loadAddon(addon);
      webgl = addon;
    } catch (err) {
      webglFailed = true;
      console.warn("[FileExplorer] 终端 WebGL 不可用，改用 DOM 渲染", err);
    }
  };

  // 输出泵：宿主 PTY 的回调是「来一条写一条」，直接灌给 xterm 会在高频输出下逐条解析、
  // 且 xterm 内部积压超限就 throw。所有输出先入队，按帧合并后再投喂。
  const pump = createWritePump(term, host);

  // 先铺原生滚动层，xterm 画在粘性视口里，滚动条留给浏览器。
  const scrollPort = mountNativeScrollPort(host);
  term.open(scrollPort.sticky);
  const nativeScroll = bindNativeScroll(host, scrollPort.spacer, term);
  try {
    fit.fit();
  } catch {
    // 宿主尺寸尚未就绪（隐藏/零宽）：由调用方在可见后再次 fit。
  }
  nativeScroll.sync();
  attachWebgl();

  // Windows 终端惯例：Ctrl+C 有选中则复制（无选中时放行给 shell 作中断信号 SIGINT）。
  // 粘贴不在此拦截：交给浏览器原生 paste 事件（xterm 原生处理），少一条剪贴板读取失败路径。
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === "c" && term.hasSelection()) {
      void writeClipboard(term.getSelection());
      term.clearSelection();
      event.preventDefault();
      return false;
    }
    return true;
  });

  const dataSub = term.onData((data) => {
    if (typeof onData === "function") onData(data);
  });
  const resizeSub = term.onResize(({ cols, rows }) => {
    if (typeof onResize === "function") onResize(cols, rows);
  });
  // 选区变化（用户拖选 / 全选 / 清选区）：通知调用方刷新依赖选区的按钮可用态。
  const selectionSub = term.onSelectionChange(() => {
    if (typeof onSelectionChange === "function") onSelectionChange();
  });

  // 右键：拦截浏览器默认菜单，交给调用方弹出自定义菜单（复制/粘贴/清空/关闭…）。
  const handleContextMenu = (event: MouseEvent): void => {
    if (typeof onContextMenu !== "function") return;
    event.preventDefault();
    // 阻断冒泡：xterm 自身的右键菜单（选中→复制 / 粘贴 / 全选）必须先落地，
    //   否则事件会冒到工具窗口 body 的空白区监听器，被 tab 菜单（只有「复制命令」）覆盖。
    event.stopPropagation();
    onContextMenu(event.clientX, event.clientY);
  };
  if (typeof host.addEventListener === "function") host.addEventListener("contextmenu", handleContextMenu);

  return {
    write(data: string): void {
      pump.push(String(data == null ? "" : data));
    },
    fit() {
      try {
        fit.fit();
      } catch {
        // 忽略：容器尺寸不可用
      }
      attachWebgl();
      nativeScroll.sync();
      // fit 是「容器刚拿到尺寸 / 窗口刚展开」的唯一可靠信号：把收起期间攒下的输出冲出去。
      pump.kick();
    },
    focus() {
      try {
        term.focus();
      } catch {
        // 忽略：元素未挂载
      }
    },
    // 隐藏 tab 不再解析输出（后台跑的大构建日志是最白花 CPU 的一档），重新可见时一次性冲刷。
    setHidden(hidden: boolean) {
      pump.setHidden(hidden);
    },
    kick() {
      pump.kick();
    },
    // 清空当前视口与回滚缓冲（运行窗口工具栏 🗑：清的是显示，不杀进程）。
    clear() {
      // 连尚未冲刷的积压一起丢，否则清空后旧输出会立刻涌回来。
      pump.drop();
      try {
        term.clear();
      } catch {
        // 忽略：实例已释放
      }
    },
    // 滚动到底部（运行窗口工具栏 ⬇：把视口拉回最新输出）。
    scrollToBottom() {
      try {
        term.scrollToBottom();
      } catch {
        // 忽略：实例已释放
      }
    },
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    /** 是否有文本选区（右键菜单「复制」的可用性）。 */
    hasSelection() {
      try {
        return term.hasSelection();
      } catch {
        return false;
      }
    },
    /** 读取当前选区文本。 */
    getSelection() {
      try {
        return term.getSelection();
      } catch {
        return "";
      }
    },
    /** 粘贴文本到终端（走 xterm.paste，尊重 bracketed paste 模式）。 */
    paste(text: string): void {
      try {
        term.paste(String(text == null ? "" : text));
      } catch {
        // 忽略：实例已释放
      }
    },
    /** 全选终端缓冲。 */
    selectAll() {
      try {
        term.selectAll();
      } catch {
        // 忽略：实例已释放
      }
    },
    dispose() {
      try {
        pump.dispose();
        nativeScroll.dispose();
        if (typeof host.removeEventListener === "function") host.removeEventListener("contextmenu", handleContextMenu);
        dataSub.dispose();
        resizeSub.dispose();
        selectionSub.dispose();
        if (webgl) {
          try {
            webgl.dispose();
          } catch {
            // 忽略：addon 已释放
          }
          webgl = null;
        }
        term.dispose();
      } catch {
        // 忽略：重复释放
      }
    },
  };
}
