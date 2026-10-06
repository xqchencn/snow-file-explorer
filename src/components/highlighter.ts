/**
 * 现代多语言语法高亮引擎 (src/components/highlighter.ts)
 * 基于 PrismJS 全量语言包（297 种语言）构建，提供精准分词高亮与 XSS 防御
 */

import { escapeHtml } from '../utils/dom.ts';
import Prism, { EXT_TO_PRISM_LANG } from './prism-langs.ts';
import { shouldHighlight } from './highlight-policy.ts';

export {
  isLargeText,
  shouldHighlight,
  shouldVirtualize,
  measureText,
  MAX_HIGHLIGHT_LEN,
  MAX_HIGHLIGHT_LINES,
  MAX_HIGHLIGHT_LINE_LEN,
  VIRTUAL_LINE_THRESHOLD,
} from './highlight-policy.ts';

/**
 * 将代码文本转换为语法高亮 HTML
 * @param code 源代码字符串
 * @param ext 文件扩展名（不含点）
 * @returns 高亮后的 HTML；超阈值或语言未注册时退化为转义后的纯文本
 */
export function highlightCodeHtml(code: string, ext: string): string {
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
