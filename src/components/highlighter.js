/**
 * 现代多语言语法高亮引擎 (src/components/highlighter.js)
 * 基于 PrismJS 全量语言包（297 种语言）构建，提供精准分词高亮与 XSS 防御
 */

import { escapeHtml } from '../utils/dom.js';
import Prism, { EXT_TO_PRISM_LANG } from './prism-langs.js';
import { shouldHighlight } from './highlight-policy.js';

export {
  isLargeText,
  shouldHighlight,
  shouldVirtualize,
  measureText,
  MAX_HIGHLIGHT_LEN,
  MAX_HIGHLIGHT_LINES,
  MAX_HIGHLIGHT_LINE_LEN,
  VIRTUAL_LINE_THRESHOLD,
} from './highlight-policy.js';

/**
 * 将代码文本转换为语法高亮 HTML
 * @param {string} code 源代码字符串
 * @param {string} ext 文件扩展名（不含点）
 * @returns {string} 高亮后的 HTML
 */
export function highlightCodeHtml(code, ext) {
  const raw = String(code || '');
  if (!raw) return '';

  // 超大文本保护快速通道（字符数 / 行数任一超限即转义为纯文本）
  if (!shouldHighlight(raw)) {
    return escapeHtml(raw);
  }

  const cleanExt = String(ext || '').toLowerCase().replace(/^\./, '');
  const prismLang = EXT_TO_PRISM_LANG[cleanExt] || cleanExt;

  if (prismLang && Prism.languages[prismLang]) {
    try {
      return Prism.highlight(raw, Prism.languages[prismLang], prismLang);
    } catch {
      // 解析异常时安全降级到纯文本转义
      return escapeHtml(raw);
    }
  }

  return escapeHtml(raw);
}
