/**
 * 高亮与虚拟化阈值。
 * @description 放在不含 Prism 的模块里，打开面板时不必解析语法引擎。
 */

/** 单次整篇高亮的字符上限。超过则不做整篇 Prism。 */
export const MAX_HIGHLIGHT_LEN = 250000;
/** 单次整篇高亮的行数上限。超过则差异与预览都不再逐行分词。 */
export const MAX_HIGHLIGHT_LINES = 4000;
/** 单行长度上限。压缩成一行的 JSON / minified JS 会让 Prism 灾难性变慢。 */
export const MAX_HIGHLIGHT_LINE_LEN = 20000;
/** 超过该行数即走虚拟列表，只创建可视行的 DOM。 */
export const VIRTUAL_LINE_THRESHOLD = 400;

/**
 * 一次扫描同时得到长度、行数和最长行。
 * @param {string} code 文本
 * @returns {{length: number, lines: number, maxLineLen: number}}
 */
export function measureText(code) {
  const raw = String(code || "");
  if (!raw) return { length: 0, lines: 0, maxLineLen: 0 };
  let lines = 1;
  let lineLen = 0;
  let maxLineLen = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) === 10) {
      lines += 1;
      if (lineLen > maxLineLen) maxLineLen = lineLen;
      lineLen = 0;
    } else {
      lineLen += 1;
    }
  }
  if (lineLen > maxLineLen) maxLineLen = lineLen;
  return { length: raw.length, lines, maxLineLen };
}

/**
 * 文本是否大到不能整篇做语法高亮。
 * @param {string} code 文本
 * @returns {boolean}
 */
export function isLargeText(code) {
  const measured = measureText(code);
  if (!measured.length) return false;
  return (
    measured.length > MAX_HIGHLIGHT_LEN ||
    measured.lines > MAX_HIGHLIGHT_LINES ||
    measured.maxLineLen > MAX_HIGHLIGHT_LINE_LEN
  );
}

/**
 * 非空且未超过整篇高亮熔断时才值得做 Prism。
 * @param {string} code 文本
 * @returns {boolean}
 */
export function shouldHighlight(code) {
  const raw = String(code || "");
  return raw !== "" && !isLargeText(raw);
}

/**
 * 是否只渲染可视行。约 400 行以上、超长单行或超大字符数都走虚拟列表。
 * @param {string} code 文本
 * @returns {boolean}
 */
export function shouldVirtualize(code) {
  const measured = measureText(code);
  if (!measured.length) return false;
  return (
    measured.length > MAX_HIGHLIGHT_LEN ||
    measured.lines > VIRTUAL_LINE_THRESHOLD ||
    measured.maxLineLen > MAX_HIGHLIGHT_LINE_LEN
  );
}
