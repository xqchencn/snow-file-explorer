/**
 * 现代多语言语法高亮引擎 (src/components/highlighter.ts)
 * 基于 PrismJS 全量语言包（297 种语言）构建，提供精准分词高亮与 XSS 防御
 * @description 本模块只做「一段文本 → 高亮 HTML」：调用方（只读虚拟行 / 编辑切片 /
 *   diff 行）一律按**单行**喂入，熔断只剩单行长度上限（highlight-policy 的
 *   MAX_HIGHLIGHT_LINE_LEN）。例外是 `.http` / `.rest`：它们由首屏模块 syntax-basic.ts
 *   的正则着色器负责（Prism 内置 http 语法只认 Content-Type、且无 rest 扩展名），
 *   本模块入口先分流，保证与 highlight-client.ts 的同步通道同一语义。
 */

import { escapeHtml } from '../utils/dom.ts';
import Prism, { EXT_TO_PRISM_LANG } from './prism-langs.ts';
import { MAX_HIGHLIGHT_LINE_LEN } from './highlight-policy.ts';
import { isBasicHighlightExt, basicHighlightCodeHtml } from './syntax-basic.ts';
import { isSfcExt, sfcLineLangs } from './sfc-highlight.ts';

/**
 * 高亮结果 LRU 的条目上限。
 * @description 虚拟列表往返滚动会对相同可视行反复分词（纯函数，结果只取决于 文本+语言）；
 *   缓存命中即免掉 Prism 分词。条目按单行文本计，600 条 × 平均百字符量级的 HTML，
 *   内存上界约百 KB。
 */
const HIGHLIGHT_CACHE_LIMIT = 600;
/** 超过该长度的文本不进缓存：长期持有大字符串的缓存键得不偿失。 */
const HIGHLIGHT_CACHE_KEY_MAX = 2000;

/** 高亮结果缓存：插入序即访问序（命中时删除重插），超出上限淘汰最旧条目。 */
const highlightCache = new Map<string, string>();

/**
 * 将一段（通常是单行）代码文本转换为语法高亮 HTML
 * @param code 源代码字符串
 * @param ext 扩展名或 Prism 语言名（不含点）
 * @returns 高亮后的 HTML；超长行或语言未注册时退化为转义后的纯文本
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
  // `.http` / `.rest` 一律走行级自足高亮（与首屏 syntax-basic.ts 同一份实现）：
  // Prism 内置的 http 语法只认 Content-Type 才给正文上色，且没有 rest 扩展名——
  // 不在这里先分流，两个扩展名就会一个走 Prism、一个无色（测试钉住了这条同构性）。
  // 熔断只剩单行上限，由 basicHighlightCodeHtml 内部按行跳过超长行。
  if (isBasicHighlightExt(cleanExt)) {
    html = basicHighlightCodeHtml(raw, cleanExt);
  } else if (isSfcExt(cleanExt)) {
    // `.vue` / `.svelte`：Prism 没有 SFC 语言组件（EXT_TO_PRISM_LANG 也已不再映射到
    // markup），整篇调用必须在这里按 SFC 区块拆行分节着色（与逐行管线同一实现），
    // 否则 diff 兜底路径等整篇调用方会拿到纯文本。行语言是 markup/js/css，不会再进本分支。
    const lines = raw.split(/\r\n|\r|\n/);
    const langs = sfcLineLangs(lines);
    html = lines
      .map((line, i) =>
        line.length > MAX_HIGHLIGHT_LINE_LEN
          ? escapeHtml(line)
          : highlightCodeHtml(line, langs[i] || "markup")
      )
      .join("\n");
  } else if (raw.length > MAX_HIGHLIGHT_LINE_LEN) {
    // 超长单行（压缩成一行的 JSON / minified JS）会让 Prism 灾难性回溯，直接转义。
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
