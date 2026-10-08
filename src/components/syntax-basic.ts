/**
 * 首屏内置语法着色器 (src/components/syntax-basic.ts)
 * @description `.http` / `.rest` 的着色**只靠正则**，不需要 Prism。
 *   把它放在首屏同步模块里，是为了不再依赖那个 575KB 的懒加载高亮块：
 *   块还没到达（或加载失败）时，http 文件里的 JSON 正文就不会一片白——
 *   而这正是「装了最新版仍全篇无色」的根因（着色逻辑住在块里，块没就绪就什么都不上色）。
 * @description 其它语言仍由 Prism 块负责；本模块只认 http / rest。
 */

import { HTTP_REQUEST_METHODS } from "../services/http-request-parser.ts";
import { escapeHtml } from "../utils/dom.ts";
import { segmentJsonLine, PRISM_JSON_CLASSES } from "./json-view.ts";

/** 单行着色上限。超过只跳过该行（转义为纯文本），不连累整篇——超长行多是压缩 JSON / 超长 URL。 */
const MAX_BASIC_LINE_LEN = 20000;

/** 本模块负责的扩展名（小写、不含点）。 */
const BASIC_EXTS: ReadonlySet<string> = new Set(["http", "rest"]);

/**
 * 该扩展名是否由首屏内置着色器负责。
 * @param ext 扩展名（可含前导点、任意大小写）
 * @returns http / rest 时为 true
 */
export function isBasicHighlightExt(ext: string): boolean {
  return BASIC_EXTS.has(String(ext || "").toLowerCase().replace(/^\./, ""));
}

/**
 * 请求行整体：方法 + 地址 + 可选 `HTTP/x.y` 版本。
 * @description 地址不做字符级校验（只要求非空白）：`.http` 里的地址普遍是 `{{host}}/login`
 *   这种「变量前缀 + 相对路径」写法，用 `https?://` 或 `/` 开头去卡会整行漏掉——
 *   方法 / 地址不着色，`HTTP/1.1` 还会被当 JSON 数字染上颜色。
 *   方法表复用解析器的 HTTP_REQUEST_METHODS，避免高亮与解析两处各维护一份而漂移。
 */
const HTTP_REQUEST_LINE = new RegExp(
  `^([ \\t]*)(${HTTP_REQUEST_METHODS.join("|")})([ \\t]+)(\\S+)(?:([ \\t]+)(HTTP\\/[\\d.]+))?[ \\t]*$`,
  "i"
);

/**
 * 给请求行里的地址段着色：`{{变量}}` 引用单独一色，其余按 URL 一色。
 * @param url 地址原文
 * @returns 着色后的 HTML（已转义）
 */
function highlightUrlSegment(url: string): string {
  const out: string[] = [];
  const re = /\{\{[^{}]*\}\}/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(url)) !== null) {
    if (match.index > last) out.push(`<span class="token url">${escapeHtml(url.slice(last, match.index))}</span>`);
    out.push(`<span class="token variable">${escapeHtml(match[0])}</span>`);
    last = match.index + match[0].length;
  }
  if (last < url.length) out.push(`<span class="token url">${escapeHtml(url.slice(last))}</span>`);
  return out.join("");
}

/**
 * `.http` / `.rest` 的行级高亮。
 * @description 关键：代码查看器对大文件（>约 400 行）走虚拟列表，是**逐行**调用的。
 *   因此正文着色必须**逐行自足**——任何依赖「空行 + 跨行正文」的整段正则在单行上永远匹配不到。
 *   这里对每一行独立判断：请求行 / 头部 / 注释 / 变量 / 分节各自成形，其余行（含 JSON 正文）
 *   一律按 JSON 语义着色，无论有没有写 Content-Type。
 * @param line 单行文本
 * @returns 着色后的 HTML（已转义）
 */
export function highlightHttpLine(line: string): string {
  const escaped = (text: string) => escapeHtml(text);
  // 分节行 `## 标题`（两个及以上井号）
  if (/^[ \t]*#{2,}/.test(line)) return `<span class="token comment">${escaped(line)}</span>`;
  // 注释行 `# ...` / `// ...`
  if (/^[ \t]*(?:#|\/\/)/.test(line)) return `<span class="token comment">${escaped(line)}</span>`;
  // 文件变量 `@name = value`
  const variable = /^([ \t]*)(@[\w-]+)([ \t]*=[ \t]*)([\s\S]*)$/.exec(line);
  if (variable) {
    return (
      escaped(variable[1]) +
      `<span class="token variable">${escaped(variable[2])}</span>` +
      escaped(variable[3]) +
      escaped(variable[4])
    );
  }
  // 请求行：方法 + 地址（可为 `{{变量}}` 前缀的相对地址）+ 可选 `HTTP/x.y`
  const requestLine = HTTP_REQUEST_LINE.exec(line);
  if (requestLine) {
    return (
      escaped(requestLine[1]) +
      `<span class="token property">${escaped(requestLine[2])}</span>` +
      escaped(requestLine[3]) +
      highlightUrlSegment(requestLine[4]) +
      (requestLine[5] ? escaped(requestLine[5]) : "") +
      (requestLine[6] ? `<span class="token keyword">${escaped(requestLine[6])}</span>` : "")
    );
  }
  // 头部行 `Name: value`：名字是标识符、值不是 JSON 结构（不以 { [ " 数字 开头）
  const header = /^([ \t]*)([A-Za-z][\w-]*)(:)([ \t]*)(.*)$/.exec(line);
  if (header && !/^[[{"\d]/.test(header[5].trim())) {
    return (
      escaped(header[1]) +
      `<span class="token keyword">${escaped(header[2])}</span>` +
      `<span class="token punctuation">${escaped(header[3])}</span>` +
      escaped(header[4]) +
      `<span class="token string">${escaped(header[5])}</span>`
    );
  }
  // 其余行（JSON 正文）：按 JSON 语义逐段着色
  const out: string[] = [];
  for (const segment of segmentJsonLine(line, PRISM_JSON_CLASSES)) {
    out.push(segment.cls ? `<span class="token ${segment.cls}">${escaped(segment.text)}</span>` : escaped(segment.text));
  }
  return out.join("");
}

/**
 * 对 `.http` / `.rest` 整篇文本做内置着色。
 * @param code 全文
 * @param ext 扩展名（http / rest）
 * @returns 着色后的 HTML；用带分隔符的 split 保留原换行符，只对文本行着色
 */
export function basicHighlightCodeHtml(code: string, ext: string): string {
  // 目前只有 http / rest 走这条通道；扩展名判定由 isBasicHighlightExt 把关。
  void ext;
  return String(code ?? "")
    .split(/(\r\n|\r|\n)/)
    .map((part, index) => {
      if (index % 2 !== 0) return part; // 换行符原样保留
      // 单行超长：只跳过这一行（转义），其余行照常着色——不因一行超长把整篇拖成纯文本。
      if (part.length > MAX_BASIC_LINE_LEN) return escapeHtml(part);
      return highlightHttpLine(part);
    })
    .join("");
}
