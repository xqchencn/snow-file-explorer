/**
 * HTTP 请求表单写回服务 (src/services/http-serialize.ts)
 * @description GUI 表单改完要把结果落回 `.http` 文本。这里只做「按请求块整段替换」：
 *   解析器已经记下每个请求块占用的行区间，未改动的那一段一个字节都不碰——
 *   包括注释、`###` 分隔行、文件变量定义与别的请求块。
 * @description 改动过的块按 `请求行 / 头部行 / 空行 / 请求体` 重排，因此块内格式会被规范化
 *   （缩进的查询串续行合成一行、头部值前的多余空格消失）。这是改写一段文本的必然代价，
 *   换的粒度按块，不按整份文件。
 */

import { parseHttpFile } from "./http-request-parser.ts";
import type { HttpParsedFile, HttpParsedRequest } from "./http-request-parser.ts";

/** GUI 表单里一条请求的可改字段。 */
export type HttpFormValues = {
  /** 方法（大写表单值）。 */
  method: string;
  /** URL 原文，允许带着 `{{ }}` 引用。 */
  url: string;
  /** 头部清单，按表单行序；空名行在写回时丢弃。 */
  headers: Array<{ name: string; value: string }>;
  /** 请求体文本；null 或空串表示这条没有请求体。 */
  body: string | null;
};

/** 一段替换：行区间 [from, to]（含）整体换成 lines。 */
type SpanReplacement = {
  /** 起始行号（含）。 */
  from: number;
  /** 结束行号（含）。 */
  to: number;
  /** 替换后的行。 */
  lines: string[];
};

/** 取一个请求块重排后的行序列。 */
function buildBlock(request: HttpParsedRequest, values: HttpFormValues): string[] {
  const method = values.method.trim() || "GET";
  const url = values.url.trim();
  // 协议版本必须紧跟 URL；地址被清空时只写方法一行（解析端把「仅方法」认成地址为空的请求）。
  const requestLine = url ? `${method} ${url}${request.httpVersion ? ` ${request.httpVersion}` : ""}` : method;
  const lines = [requestLine];
  const comments = request.commentLines || [];
  // 注释不参与语法，但它是用户写在块里的内容：重排时按区域带回去，别让改一个字段把注释抹掉。
  const isHeaderRegion = (line: number) => request.bodyStart < 0 || line < request.bodyStart;
  for (const comment of comments) {
    if (isHeaderRegion(comment.line)) lines.push(comment.text);
  }
  const headers = values.headers
    .map((header) => ({ name: header.name.trim(), value: String(header.value ?? "") }))
    .filter((header) => header.name);
  for (const header of headers) lines.push(`${header.name}: ${header.value}`);
  const body = values.body === null ? "" : String(values.body);
  const hasBody = body.trim() !== "";
  const bodyComments = comments.filter((comment) => !isHeaderRegion(comment.line));
  if (hasBody) {
    const bodyLines = body.split("\n");
    const bodyLineNumbers = request.bodyLineNumbers || [];
    // 正文区注释按「原文里夹在哪两行正文之间」落回同样的相对位置；正文行数被改过时按最近的边界靠。
    const insertAt = new Map<number, string[]>();
    for (const comment of bodyComments) {
      let at = bodyLineNumbers.findIndex((line) => line > comment.line);
      if (at < 0) at = bodyLines.length;
      const bucket = insertAt.get(at);
      if (bucket) bucket.push(comment.text);
      else insertAt.set(at, [comment.text]);
    }
    lines.push("");
    for (let at = 0; at < bodyLines.length; at += 1) {
      for (const text of insertAt.get(at) || []) lines.push(text);
      lines.push(bodyLines[at]);
    }
    for (const text of insertAt.get(bodyLines.length) || []) lines.push(text);
  } else {
    // 正文被清空也别把注释吞了：原样附在块尾，用户能在文本态自己处置。
    for (const comment of bodyComments) lines.push(comment.text);
  }
  // GraphQL 的变量段不在表单里可编，但它属于请求体：写回必须原样带上。
  // 少了这一步，用户在卡片上改一下 URL 就会把 variables 静默删掉（发送时变成空对象）。
  if (hasBody && request.graphQl && request.graphQlVariables) {
    lines.push("");
    lines.push(...request.graphQlVariables.split("\n"));
  }
  // `> ./file` 与 `> {% … %}` 不属于请求，但它们是用户写在这一节里的内容：
  // 按块重排时原样附在块尾，否则改一个字段就把别人的脚本删了（本插件不执行它，也不该销毁它）。
  if (request.outputRedirect) lines.push(`> ${request.outputRedirect}`);
  if (request.responseHandler) {
    lines.push("> {%");
    lines.push(...request.responseHandler.split("\n"));
    lines.push("%}");
  }
  return lines;
}

/**
 * 把表单改动写回文件全文。
 * @param text 文件原文
 * @param file 该原文的解析结果（必须与 text 同源，行号才对得上）
 * @param edits 请求下标 → 表单值；只处理出现过的下标
 * @returns 写回后的全文；换行风格与原文一致（原文含 CRLF 就继续用 CRLF），首行 BOM 原样保留
 */
export function applyHttpEdits(
  text: string,
  file: HttpParsedFile,
  edits: ReadonlyMap<number, HttpFormValues>
): string {
  const source = String(text ?? "");
  if (!edits.size) return source;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  // 解析视图里首行 BOM 已被剥掉（见 parseHttpFile）：这里同步拆行、写回时再补上，
  // 否则「在卡片上改一次」就把文件的 BOM 抹掉，Git 里凭空多出一行 diff。
  const hasBom = source.startsWith("\uFEFF");
  const lines = source.slice(hasBom ? 1 : 0).split(/\r?\n/);
  const replacements: SpanReplacement[] = [];
  for (const [index, values] of edits) {
    const request = file.requests[index];
    if (!request) continue;
    // curl 一节不在这里重排：整段替换要按「请求行 / 头部 / 正文」重拼，
    // 而 curl 命令的信息全在 `-H`/`-d` 这些参数里，重拼出来的行和原文不可能一模一样——
    // 改一下地址就把用户写的命令换成另一种写法，等于悄悄换了一份内容。界面上这一类只读
    // （见 http-request-panel）。
    if (request.curl) continue;
    const block = buildBlock(request, values);
    const current = lines.slice(request.startLine, request.endLine + 1);
    // 重排结果与原文一字不差时一个字节都不碰：这条路径同时守住「没改动不产生 diff」
    // 和「不去动它就永远不会被重排」——表单只是正文的投影，投影没变就不该惊动正文。
    if (block.length === current.length && block.every((line, at) => line === current[at])) continue;
    replacements.push({ from: request.startLine, to: request.endLine, lines: block });
  }
  // 从后往前替换：前面的行号不会因为后面的块增减而失效。
  replacements.sort((a, b) => b.from - a.from);
  for (let at = 1; at < replacements.length; at += 1) {
    // 行区间必须两两不重叠。真出现重叠说明解析出来的区间已经不可信，
    // 此时宁可不改也不能把文件写坏（后落位的整段会盖掉前一个块）。
    if (replacements[at].to >= replacements[at - 1].from) return source;
  }
  for (const replacement of replacements) {
    lines.splice(replacement.from, replacement.to - replacement.from + 1, ...replacement.lines);
  }
  return (hasBom ? "\uFEFF" : "") + lines.join(eol);
}

/**
 * 改一条请求后同步更新全文与解析结果。
 * @description GUI 每敲一个字都会走到这里：先按旧行区间写回，再立刻重解析，
 *   下一次改动用的就是新行区间。若只写回不重解析，区间就会随行数增减失真，
 *   第二次按键起会把文本切坏——这一步是这条链路的不变量。
 * @param text 当前全文
 * @param file text 的解析结果
 * @param index 被改的请求下标
 * @param values 该请求的新表单值
 * @returns 新全文与据此重算的解析结果
 */
export function updateHttpText(
  text: string,
  file: HttpParsedFile,
  index: number,
  values: HttpFormValues
): { text: string; file: HttpParsedFile } {
  const next = applyHttpEdits(text, file, new Map([[index, values]]));
  if (next === text) return { text, file };
  return { text: next, file: parseHttpFile(next) };
}
/**
 * 一条请求的当前表单初值（把解析结果摊平成可编辑字段）。
 * @param request 解析出的请求
 * @returns 表单值；请求体取解析器留存的原文
 */
export function formValuesOfRequest(request: HttpParsedRequest): HttpFormValues {
  return {
    method: request.method,
    url: request.url,
    headers: request.headers.map((header) => ({ name: header.name, value: header.value })),
    body: request.body,
  };
}

