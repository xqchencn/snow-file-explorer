/**
 * DOM 操作辅助工具模块 (src/utils/dom.ts)
 */

/**
 * 创建指定标签、类名和文本的 DOM 节点。
 * @description 标签名可推断时返回精确元素类型，动态标签名退回 HTMLElement。
 *   className / text 都接受 null：实现按假值跳过，调用方常写 el("div", null, text) 表达「不要类名」。
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  text?: string | null,
): HTMLElementTagNameMap[K];
export function el(tag: string, className?: string | null, text?: string | null): HTMLElement;
/**
 * 创建指定标签、类名和文本的 DOM 节点
 * @param tag 标签名称
 * @param [className] CSS 类名；假值时不设置
 * @param [text] 文本内容；null/undefined 时不设置
 * @returns {HTMLElement}
 */
export function el(tag: string, className?: string | null, text?: string | null): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * 格式化文件字节大小为人类可读格式 (B / KB / MB)
 * @param bytes 字节数；非有限数或负数返回空串
 * @returns 体积文本；空串表示「不显示体积」
 */
export function humanSize(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

/**
 * 转义字符串中的 HTML 特殊字符，防止 XSS 并保持原样渲染
 * @description 单趟替换：& 必须最先被转义为 &amp; 的形式，其余实体都含 & 字符，
 *   故用回调按字符映射，一次遍历完成，避免多趟 replace 产生多份中间字符串。
 * @param str 原生文本
 * @returns 转义后的 HTML 字符串
 */
const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(str: unknown): string {
  const raw = String(str || "");
  return raw.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/**
 * 复制文本到系统剪贴板（支持标准 Clipboard API 与 textarea 兼容后备方案）
 * @param text 要复制的文本
 * @returns 是否复制成功；空文本直接为 false
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const val = String(text || "");
  if (!val) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(val);
      return true;
    }
  } catch {
    // 降级到传统 textarea 方案
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = val;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
