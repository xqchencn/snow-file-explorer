/**
 * DOM 操作辅助工具模块 (src/utils/dom.js)
 */

/**
 * 创建指定标签、类名和文本的 DOM 节点
 * @param {string} tag 标签名称
 * @param {string} [className] CSS 类名
 * @param {string|null} [text] 文本内容
 * @returns {HTMLElement}
 */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * 格式化文件字节大小为人类可读格式 (B / KB / MB)
 * @param {number} bytes 字节数
 * @returns {string}
 */
export function humanSize(bytes) {
  if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

/**
 * 转义字符串中的 HTML 特殊字符，防止 XSS 并保持原样渲染
 * @param {string} str 原生文本
 * @returns {string} 转义后的 HTML 字符串
 */
export function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 复制文本到系统剪贴板（支持标准 Clipboard API 与 textarea 兼容后备方案）
 * @param {string} text 要复制的文本
 * @returns {Promise<boolean>}
 */
export async function copyToClipboard(text) {
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
