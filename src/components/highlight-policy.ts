/**
 * 高亮熔断策略 (src/components/highlight-policy.ts)
 * @description 全插件的代码高亮只有**一条**管线：逐行窗口化高亮（只读态虚拟列表、
 *   编辑态切片、diff 行都是它）。因此唯一的熔断是「单行长度上限」——
 *   压缩成一行的 minified JS / JSON 会让 Prism 灾难性回溯，超限行退化为纯文本，
 *   不连累整篇。曾存在过整篇字符数 / 行数阈值（250k 字符 / 4000 行），
 *   后果是「长文件整篇变纯文本」，已随双管线一起废除。
 */

/** 单行长度上限。超限只跳过该行（转义为纯文本），不连累整篇。 */
export const MAX_HIGHLIGHT_LINE_LEN = 20000;

/**
 * 一次文本扫描得到的体量指标。
 * @description 高亮本身不再消费它（逐行管线不需要整篇体量），
 *   仍留给 Markdown 水合门控（canHydrateMarkdownHtml）等按体量决策的调用方。
 */
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
