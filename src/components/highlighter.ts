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
 * 高亮结果 LRU 的条目上限。
 * @description 虚拟列表往返滚动会对相同可视行反复分词（纯函数，结果只取决于 文本+语言）；
 *   缓存命中即免掉 Prism 分词与内部 shouldHighlight 全文扫描。条目按单行文本计，
 *   600 条 × 平均百字符量级的 HTML，内存上界约百 KB。
 */
const HIGHLIGHT_CACHE_LIMIT = 600;
/** 超过该长度的文本不进缓存：整篇高亮（每次打开只算一次）缓存键会长期持有大字符串。 */
const HIGHLIGHT_CACHE_KEY_MAX = 2000;

/** 高亮结果缓存：插入序即访问序（命中时删除重插），超出上限淘汰最旧条目。 */
const highlightCache = new Map<string, string>();

/**
 * 将代码文本转换为语法高亮 HTML
 * @param code 源代码字符串
 * @param ext 文件扩展名（不含点）
 * @returns 高亮后的 HTML；超阈值或语言未注册时退化为转义后的纯文本
 */
export function highlightCodeHtml(code: string, ext: string): string {
  const raw = String(code || '');
  if (!raw) return '';

  const cleanExt = String(ext || '').toLowerCase().replace(/^\./, '');
  // 短文本（可视行 / diff 行）走 LRU：滚动热路径上同一行不重复分词。
  const cacheable = raw.length <= HIGHLIGHT_CACHE_KEY_MAX;
  const cacheKey = cacheable ? `${cleanExt}\u0000${raw}` : '';
  if (cacheable) {
    const cached = highlightCache.get(cacheKey);
    if (cached !== undefined) {
      // 刷新访问序（LRU）。
      highlightCache.delete(cacheKey);
      highlightCache.set(cacheKey, cached);
      return cached;
    }
  }

  let html: string;
  // 超大文本保护快速通道（字符数 / 行数任一超限即转义为纯文本）
  if (!shouldHighlight(raw)) {
    html = escapeHtml(raw);
  } else {
    const prismLang = EXT_TO_PRISM_LANG[cleanExt] || cleanExt;
    if (prismLang && Prism.languages[prismLang]) {
      try {
        html = Prism.highlight(raw, Prism.languages[prismLang], prismLang);
      } catch {
        // 解析异常时安全降级到纯文本转义
        html = escapeHtml(raw);
      }
    } else {
      html = escapeHtml(raw);
    }
  }

  if (cacheable) {
    highlightCache.set(cacheKey, html);
    if (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
      const oldest = highlightCache.keys().next().value;
      if (oldest !== undefined) highlightCache.delete(oldest);
    }
  }
  return html;
}
