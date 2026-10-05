/**
 * xterm 终端视图 (src/components/terminal-view.js)
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
function writeClipboard(text) {
  const snow = typeof window !== "undefined" ? window.snow : null;
  if (snow && typeof snow.writeClipboardText === "function") return snow.writeClipboardText(text);
  if (typeof navigator !== "undefined" && navigator.clipboard) return navigator.clipboard.writeText(text);
  return Promise.resolve();
}

/**
 * 创建 xterm 终端视图。
 * @param {HTMLElement} host 终端挂载宿主元素（必须有尺寸）
 * @param {Object} [options]
 * @param {(data: string) => void} [options.onData] 键盘输入回调
 * @param {(cols: number, rows: number) => void} [options.onResize] 尺寸变化回调
 * @param {boolean} [options.readOnly] 只读（模式 A 一次性运行）：禁止键盘输入
 * @param {(x: number, y: number) => void} [options.onContextMenu] 右键回调（由调用方弹菜单）
 * @param {Function} [options.onSelectionChange] 选区变化回调（供调用方刷新「复制选中文本」按钮可用态）
 * @returns {{write: Function, fit: Function, focus: Function, clear: Function, scrollToBottom: Function, hasSelection: Function, getSelection: Function, paste: Function, selectAll: Function, cols: number, rows: number, dispose: Function}}
 */
export function createXtermView(host, options = {}) {
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

  term.open(host);
  try {
    fit.fit();
  } catch {
    // 宿主尺寸尚未就绪（隐藏/零宽）：由调用方在可见后再次 fit。
  }

  // Windows 终端惯例：Ctrl+C 有选中则复制（无选中时放行给 shell 作中断信号 SIGINT）。
  // 粘贴不在此拦截：交给浏览器原生 paste 事件（xterm 原生处理），少一条剪贴板读取失败路径。
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === "c" && term.hasSelection()) {
      writeClipboard(term.getSelection());
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
  const handleContextMenu = (event) => {
    if (typeof onContextMenu !== "function") return;
    event.preventDefault();
    // 阻断冒泡：xterm 自身的右键菜单（选中→复制 / 粘贴 / 全选）必须先落地，
    //   否则事件会冒到工具窗口 body 的空白区监听器，被 tab 菜单（只有「复制命令」）覆盖。
    event.stopPropagation();
    onContextMenu(event.clientX, event.clientY);
  };
  if (typeof host.addEventListener === "function") host.addEventListener("contextmenu", handleContextMenu);

  return {
    write(data) {
      term.write(String(data == null ? "" : data));
    },
    fit() {
      try {
        fit.fit();
      } catch {
        // 忽略：容器尺寸不可用
      }
    },
    focus() {
      try {
        term.focus();
      } catch {
        // 忽略：元素未挂载
      }
    },
    // 清空当前视口与回滚缓冲（运行窗口工具栏 🗑：清的是显示，不杀进程）。
    clear() {
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
    paste(text) {
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
        if (typeof host.removeEventListener === "function") host.removeEventListener("contextmenu", handleContextMenu);
        dataSub.dispose();
        resizeSub.dispose();
        selectionSub.dispose();
        term.dispose();
      } catch {
        // 忽略：重复释放
      }
    },
  };
}
