/**
 * 现代多语言语法高亮引擎 (src/components/highlighter.js)
 * 基于 PrismJS 全量语言包（297 种语言）构建，提供精准分词高亮与 XSS 防御
 */

import { escapeHtml } from '../utils/dom.js';
import Prism, { EXT_TO_PRISM_LANG } from './prism-langs.js';

// 单次高亮的熔断阈值：总字符数、总行数、单行长度任一超限即降级纯文本（保护宿主渲染性能）
const MAX_HIGHLIGHT_LEN = 250000;
export const MAX_HIGHLIGHT_LINES = 4000;
// 单行长度阈值：Prism 分词成本随单行长度急剧上升，压缩 JSON / minified JS 这类「单行超长」
// 文本即便总字符数与行数都未超限，也会让 Prism 灾难性卡死，必须单独熔断。
export const MAX_HIGHLIGHT_LINE_LEN = 20000;

/**
 * 判断一段文本是否因体积过大而需要放弃语法高亮 / 走虚拟化渲染
 * @description 大文件一次性高亮是同步阻塞操作（Prism 非增量），会冻住主线程；
 *   统一在此判定，避免各调用方（代码预览 / 差异视图 / 编辑态）各写一套阈值而漏判。
 *   遍历一次同时统计行数与最长行长度（charCodeAt 手动计数），比 split(/\n/) 少分配行数组。
 * @param {string} code 源代码字符串
 * @returns {boolean} 超过字符数、行数或单行长度任一阈值返回 true；空文本、普通文件返回 false
 */
export function isLargeText(code) {
  const raw = String(code || '');
  if (!raw) return false;
  if (raw.length > MAX_HIGHLIGHT_LEN) return true;
  let lines = 1;
  let lineLen = 0;
  let maxLineLen = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) === 10) {
      lines++;
      if (lineLen > maxLineLen) maxLineLen = lineLen;
      lineLen = 0;
    } else {
      lineLen++;
    }
  }
  if (lineLen > maxLineLen) maxLineLen = lineLen;
  return lines > MAX_HIGHLIGHT_LINES || maxLineLen > MAX_HIGHLIGHT_LINE_LEN;
}

/**
 * 判断一段文本是否值得做语法高亮（熔断判定的唯一入口）
 * @description 与 shouldHighlight 互补：非空且未超阈值才高亮。空文本返回 false。
 * @param {string} code 源代码字符串
 * @returns {boolean} 未超阈值且非空返回 true；否则 false
 */
export function shouldHighlight(code) {
  const raw = String(code || '');
  return raw !== '' && !isLargeText(raw);
}

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
