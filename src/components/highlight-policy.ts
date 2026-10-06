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

/** 一次文本扫描得到的体量指标，是高亮与虚拟化熔断判定的唯一依据。 */
export type MeasuredText = {
  /** 文本总字符数；空串为 0。 */
  length: number;
  /** 行数；空串为 0，非空按换行符数 + 1。 */
  lines: number;
  /** 最长行的字符数（不含行尾换行符）。 */
  maxLineLen: number;
};

/**
 * 一次扫描同时得到长度、行数和最长行。
 * @param code 文本；允许缺省形状（预览联合里 `text` 是可选字段），第一行已归一为空串
 * @returns 长度、行数与最长行体量
 */
export function measureText(code: string | null | undefined): MeasuredText {
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
 * @param code 文本
 * @returns 是否需要在整篇高亮前熔断
 */
export function isLargeText(code: string): boolean {
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
 * @param code 文本
 * @returns 是否应当做整篇高亮
 */
export function shouldHighlight(code: string): boolean {
  const raw = String(code || "");
  return raw !== "" && !isLargeText(raw);
}

/**
 * 是否只渲染可视行。约 400 行以上、超长单行或超大字符数都走虚拟列表。
 * @param code 文本；预览联合里 `text` 是可选字段，未加载时可为 null/undefined，
 *   由 `measureText` 的 `String(code || "")` 归一为空串（即「不虚拟化」）
 * @returns 是否改用虚拟列表渲染
 */
export function shouldVirtualize(code: string | null | undefined): boolean {
  const measured = measureText(code);
  if (!measured.length) return false;
  return (
    measured.length > MAX_HIGHLIGHT_LEN ||
    measured.lines > VIRTUAL_LINE_THRESHOLD ||
    measured.maxLineLen > MAX_HIGHLIGHT_LINE_LEN
  );
}
