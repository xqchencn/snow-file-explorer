/**
 * HTTP 请求文件解析器 (src/services/http-request-parser.ts)
 * @description 语法按 vscode-restclient 0.26.0 的【实际实现】复刻，不是按传闻或别家客户端补齐：
 *   分节 `^#{3,}`（selector.ts 的 getDelimiterRows）、
 *   请求行方法表与尾部 `HTTP/x.y` 剥离（httpRequestParser.ts 的 parseRequestLine）、
 *   查询串续行 `^\\s*[&?]`（同类 queryStringLinePrefix）、
 *   头部读到首个空行为止、同名头部用逗号（Cookie 用分号）合并（requestParserUtil.ts 的 parseRequestHeaders）、
 *   元数据 `# @name` / `@note` / `@no-redirect` / `@no-cookie-jar` / `@prompt`（requestMetadata.ts 的枚举全集）、
 *   文件变量 `@name = value`（constants.ts 的 FileVariableDefinitionRegex）。
 *   该版本没有 `> {% %}` 响应脚本，也没有 `< environment >` 多环境段，故本解析器不发明它们。
 * @description 偏离上游一处（已登记）：上游 0.26.0 的符号名只取 `# @name`，`### 登录` 这种写在分隔行上的
 *   标题被丢弃。这里把它读出来当界面标题（httpRequestTitle），因为请求文件作者普遍用它给人看；
 *   `@name` 仍是请求变量的键，两者各管各的。
 * @description 纯函数：不发起 IO、不做变量替换。变量引用的原文必须原样留着，
 *   行区间也要留——GUI 表单与文本视图要能按行号写回同一个文件。
 */

/** 上游 parseRequestLine 认的方法全集（顺序与正则分支一致）；未命中时按 GET 处理。 */
export const HTTP_REQUEST_METHODS: readonly string[] = Object.freeze([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
  "CONNECT",
  "TRACE",
  "LOCK",
  "UNLOCK",
  "PROPFIND",
  "PROPPATCH",
  "COPY",
  "MOVE",
  "MKCOL",
  "MKCALENDAR",
  "ACL",
  "SEARCH",
]);

/** 请求行的方法前缀：方法后必须跟空白或整行结束，故 `GET` 单独一行＝一条地址为空的请求。 */
const REQUEST_LINE_METHOD = new RegExp(`^(${HTTP_REQUEST_METHODS.join("|")})(?:\\s+|$)`, "i");

/**
 * 分节行：两个及以上 `#` 开头。
 * @description 单井号 `#` 是注释（COMMENT_LINE），故分节从两个井号起——
 *   `## 1.1 A5纸` / `### 登录接口` / `#### …` 都算新分节，标题取井号后的文字。
 *   上游只认三个及以上，实际文件里 `##` 极常见，漏掉会把下一条请求吞进上一条的正文。
 */
const SECTION_DELIMITER = /^#{2,}/;

/** 分节行同行可带标题：`## 登录接口`，取走前导 `#` 与空白后的剩余文本。 */
const SECTION_TITLE = /^#{2,}\s*(.*)$/;

/** 注释行：`#` 或 `//` 开头（上游 CommentIdentifiersRegex）。 */
const COMMENT_LINE = /^\s*(#|\/{2})/;

/** 元数据行：`# @key value` / `// @key value`（上游 RequestMetadataRegex）。 */
const METADATA_LINE = /^\s*(?:#|\/{2})\s*@([\w-]+)(?:\s+(.*?))?\s*$/;

/** 文件变量定义行：`@name = value`，名字不得含空格（上游 FileVariableDefinitionRegex）。 */
const FILE_VARIABLE_LINE = /^\s*@([^\s=]+)\s*=\s*(.*?)\s*$/;

/** 查询串续行：紧跟请求行、以 `?` 或 `&` 开头（上游 queryStringLinePrefix）。 */
const QUERY_CONTINUATION = /^\s*[&?]/;

/** 响应状态行：`HTTP/1.1 200 OK` 一类，遇到即不再是请求（上游 responseStatusLineRegex）。 */
const RESPONSE_STATUS_LINE = /^\s*HTTP\/[\d.]+/;

/** 请求体文件引用：`< 路径`、`<@ 路径`、`<@latin1 路径`（上游 inputFileSyntax）。 */
const BODY_FILE_LINE = /^<(?:(@)(\w+)?)?\s+(.+?)\s*$/;

/** 变量引用：`{{ ... }}`（引用形态与上游 variableReferenceRegex 同形）。 */
const VARIABLE_REFERENCE = /\{{2}(.+?)\}{2}/;

/** 花括号式变量定义（`{{name}} = value`）：JetBrains HTTP Client 的写法，上游不认。 */
const BRACE_STYLE_VARIABLE_LINE = /^\s*\{\{\s*[^{}\s]+[^{}]*\}\}\s*=/;

/** 定义形态的花括号写法会不会被误读：它同时能被 `@name = value` 切走首段，必须先挡掉。 */
export function isBraceStyleVariableLine(line: string): boolean {
  return BRACE_STYLE_VARIABLE_LINE.test(line);
}

/** 一条请求头。 */
export type HttpHeaderEntry = {
  /** 头部名原文（保留文件里的大小写写法）。 */
  name: string;
  /** 头部值原文；同名重复时是上游合并后的结果（Cookie 用 `;`，其余用 `,`）。 */
  value: string;
  /** 该头部在文件中的行号（0 基）；同名合并时取首次出现的行号。 */
  line: number;
};

/** 请求体里的一条文件引用（`< ./demo.xml`）。 */
export type HttpBodyFileRef = {
  /** 所在行号（0 基）。 */
  line: number;
  /** 路径原文（可能带 `./`，上游按工作区根与当前文件目录两级解析）。 */
  path: string;
  /** 是否用 `<@` 要求先做变量替换。 */
  processVariables: boolean;
  /** `@` 后紧跟的编码名，如 `latin1`；未写时为 null。 */
  encoding: string | null;
};

/** 一个 `# @prompt var 描述` 声明。 */
export type HttpPromptVariable = {
  /** 变量名。 */
  name: string;
  /** 描述文案；未写时为 null。 */
  description: string | null;
};

/** 解析出的单个请求。 */
export type HttpParsedRequest = {
  /** 方法，大写；请求行没写方法时上游默认 GET。 */
  method: string;
  /** URL 原文（`{{ }}` 引用未展开）。 */
  url: string;
  /** 请求行尾声明的协议版本原文（如 `HTTP/1.1`）；没写时为 null，GUI 写回时按原样补回。 */
  httpVersion: string | null;
  /** 请求行结束处的行号（0 基）；查询串续行会占多行，写回时按这段整体替换。 */
  requestLineEnd: number;
  /** 头部区起始行号；无头部时为 -1。 */
  headerStart: number;
  /** 头部区结束行号（含）；无头部时为 -1。 */
  headerEnd: number;
  /** 请求体起始行号（含）；无请求体时为 -1。 */
  bodyStart: number;
  /** 请求体结束行号（含）；无请求体时为 -1。 */
  bodyEnd: number;
  /**
   * 请求体每一行对应的原文行号（0 基），与 `body` 的行一一对应。
   * @description 请求块内的注释行会被剥掉，`body` 的行号因此不再连续；
   *   正文里的 `< 文件` 引用要落位就得查这张表，不能用 `行号 - bodyStart` 推算。
   *   无请求体时为空数组。
   */
  bodyLineNumbers: number[];
  /** 本请求块起始行号（0 基，已刨掉前导注释、空行与文件变量定义行）。 */
  startLine: number;
  /** 本请求块结束行号（0 基，含）。 */
  endLine: number;
  /** 本节起始行号（0 基，含开启本节的 `###` 分隔行）：分块展示按这一行起切，一块覆盖到下一块之前。 */
  sectionStart: number;
  /** `###` 分隔行上写的标题（`### 登录接口`）；分隔行后没有文字时为 null。 */
  title: string | null;
  /** 头部清单，保留文件顺序。 */
  headers: HttpHeaderEntry[];
  /** 请求体原文（按文件换行 join）；无请求体时为 null。 */
  body: string | null;
  /** `# @name` 指定的请求名；匿名请求为 null。 */
  name: string | null;
  /** `# @note` 文案；未写为 null。 */
  note: string | null;
  /** `# @no-redirect`：不跟随 3XX 重定向。 */
  noRedirect: boolean;
  /** `# @no-cookie-jar`：本次不写 cookie jar。 */
  noCookieJar: boolean;
  /** `# @prompt` 声明的待填变量清单；没有则为空数组。 */
  prompts: HttpPromptVariable[];
  /** 未识别的 `# @key` 元数据键名（上游会忽略，这里留痕给界面提示）。 */
  unknownMetadata: string[];
  /** 是否 `X-Request-Type: GraphQL` 请求（上游按该头部判定并从请求体剥离变量段）。 */
  graphQl: boolean;
  /** GraphQL 变量段原文；非 GraphQL 或没写变量段时为 null。 */
  graphQlVariables: string | null;
  /**
   * GraphQL 变量段每一行对应的原文行号（0 基），与 `graphQlVariables` 的行一一对应。
   * @description 变量段也要过变量替换与 `< 文件` 内联，落位同样只能查这张表。
   *   非 GraphQL 或没有变量段时为空数组。
   */
  graphQlVariableLineNumbers: number[];
  /** 请求体中的文件引用行；没有则为空数组。 */
  bodyFiles: HttpBodyFileRef[];
  /** 本块内出现的全部 `{{ }}` 引用原文（不含外层花括号），按出现顺序去重。 */
  variableRefs: string[];
  /**
   * 请求块内的注释行（原文与行号）。
   * @description 注释不参与语法（见 requestBlockLines），但它仍是用户的文件内容：
   *   GUI 表单是按块重排写回的，不带回去的话，改一次地址就把块里的注释永久抹掉。
   */
  commentLines: Array<{ line: number; text: string }>;
};

/** 一个文件变量定义。 */
export type HttpFileVariable = {
  /** 变量名（`@` 与 `=` 之间的部分）。 */
  name: string;
  /** 值原文（`\` 转义已按上游规则还原）。 */
  value: string;
  /** 定义所在行号（0 基）。 */
  line: number;
};

/** parseHttpFile 的返回。 */
export type HttpParsedFile = {
  /** 文件级变量，整文件可见、不分节（上游就是全文扫一遍再按名取用）。 */
  variables: HttpFileVariable[];
  /** 请求清单，按文件顺序；只有注释／变量定义的空节不产生请求。 */
  requests: HttpParsedRequest[];
  /** 因而是被当作响应粘贴段而整节丢弃的起始行号集合（上游 ignoreResponseRange 同效）。 */
  skippedResponseSections: number[];
  /** 写成 `{{name}} = value` 的行号（0 基）：上游只认 `@name = value`，这些行不会成为变量定义。 */
  braceStyleVariableLines: number[];
};

/** 一个待解析的请求块（分节后的原始行窗口）。 */
type Section = {
  /** 起始行号（含）。 */
  start: number;
  /** 结束行号（含）。 */
  end: number;
  /** 开启本节的 `###` 分隔行行号；整份文件没有分隔行、或本节就是第一段时为 null。 */
  opening: number | null;
  /** 分隔行上写的标题；没有则 null。 */
  title: string | null;
};

/**
 * 是否注释行
 * @param line 行原文
 * @returns 以 `#` 或 `//` 起始（忽略前导空白）时为 true
 */
export function isHttpCommentLine(line: string): boolean {
  return COMMENT_LINE.test(line);
}

/**
 * 是否文件变量定义行
 * @param line 行原文
 * @returns 命中 `@name = value` 时为 true
 */
export function isHttpFileVariableLine(line: string): boolean {
  return FILE_VARIABLE_LINE.test(line);
}

/** 上游 escapee 表：只有这三个转义会被还原，其余字符前的反斜杠单纯消失。 */
const VARIABLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

/** 按上游规则还原变量值里的 `\n` / `\r` / `\t`；其他 `\x` 只吃掉反斜杠本身。 */
function unescapeVariableValue(raw: string): string {
  let value = "";
  let escaping = false;
  for (const char of raw) {
    if (escaping) {
      value += VARIABLE_ESCAPES.get(char) || char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    value += char;
  }
  return value;
}

/**
 * 收集整份文件的变量定义。
 * @param lines 已按行拆开的文件全文
 * @returns 按行号顺序的变量清单；同名变量后定义的覆盖先定义的（上游用 Map.set，同效）
 */
function collectFileVariables(lines: readonly string[]): HttpFileVariable[] {
  const byName = new Map<string, HttpFileVariable>();
  lines.forEach((line, index) => {
    const matched = FILE_VARIABLE_LINE.exec(line);
    if (!matched) return;
    byName.set(matched[1], {
      name: matched[1],
      value: unescapeVariableValue(matched[2]),
      line: index,
    });
  });
  return [...byName.values()].sort((a, b) => a.line - b.line);
}

/**
 * 按 `^#{3,}` 切节；一节就是一个候选请求块。
 * @param lines 文件全文行数组
 * @returns 行窗口清单；没有分隔行时整份文件即一节（与上游 getDelimitedText 的空分隔处理一致）
 */
function splitSections(lines: readonly string[]): Section[] {
  const delimiters: number[] = [];
  lines.forEach((line, index) => {
    if (SECTION_DELIMITER.test(line)) delimiters.push(index);
  });
  const bounds = delimiters.length ? [...delimiters, lines.length] : [lines.length];
  const sections: Section[] = [];
  let prev = -1;
  for (const current of bounds) {
    const start = prev + 1;
    const end = current - 1;
    // opening 只在真的有分隔行时成立：首段之前没有分隔行（prev 为 -1）。
    const opening = prev >= 0 ? prev : null;
    if (start <= end) {
      sections.push({ start, end, opening, title: opening === null ? null : sectionTitle(lines[opening]) });
    }
    prev = current;
  }
  return sections;
}

/**
 * 取分隔行上写的标题。
 * @param line 分隔行原文
 * @returns `### 登录接口` 里的「登录接口」；只有 `###` 时返回 null
 */
function sectionTitle(line: string | undefined): string | null {
  const matched = SECTION_TITLE.exec(String(line ?? ""));
  const text = String(matched?.[1] ?? "").trim();
  return text || null;
}

/**
 * 在一节里定位请求块：刨掉前导注释／空行／变量定义行与尾部空行／注释行。
 * @param lines 文件全文行数组
 * @param section 本节的行窗口
 * @returns 收缩后的行窗口；本节没有可用请求时返回 null
 * @description 偏离上游一处（已登记）：`{{name}} = value` 这种 JetBrains 写法上游不当变量、
 *   也不当注释，于是会被当成请求行——用户会看到一个 URL 是 `{{host}} = https://...` 的假请求。
 *   这里把它一并排除在请求块外，并由 braceStyleVariableLines 如实告诉界面那行没生效。
 */
function findRequestRange(lines: readonly string[], section: Section): { start: number; end: number } | null {
  let start = section.start;
  let end = section.end;
  while (start <= end) {
    const line = lines[start];
    // 响应粘贴段（`HTTP/1.1 200 OK` 起头）整节跳过：上游 ignoreResponseRange 同效。
    if (RESPONSE_STATUS_LINE.test(line)) return null;
    if (
      isHttpCommentLine(line) ||
      isHttpFileVariableLine(line) ||
      isBraceStyleVariableLine(line) ||
      line.trim() === ""
    ) {
      start += 1;
      continue;
    }
    break;
  }
  while (end >= start) {
    const line = lines[end];
    if (isHttpCommentLine(line) || line.trim() === "") {
      end -= 1;
      continue;
    }
    break;
  }
  if (start > end) return null;
  return { start, end };
}

/**
 * 解析节首的元数据行（`# @key value`）。
 * @param lines 文件全文行数组
 * @param section 本节的行窗口
 * @returns 上游 RequestMetadata 五个键的取值与未识别键名
 * @description 只扫请求行之前的注释行：空行与 `@name = value` 行可以穿插，
 *   但一碰到第一条非注释行就停（上游 parseReqMetadatas 的 break），
 *   所以写在请求体里的 `# @name` 不会被采纳。
 */
function parseMetadata(lines: readonly string[], section: Section): {
  name: string | null;
  note: string | null;
  noRedirect: boolean;
  noCookieJar: boolean;
  prompts: HttpPromptVariable[];
  unknown: string[];
} {
  const result = {
    name: null as string | null,
    note: null as string | null,
    noRedirect: false,
    noCookieJar: false,
    prompts: [] as HttpPromptVariable[],
    unknown: [] as string[],
  };
  for (let index = section.start; index <= section.end; index += 1) {
    const line = String(lines[index] ?? "");
    if (line.trim() === "" || isHttpFileVariableLine(line)) continue;
    if (!isHttpCommentLine(line)) break;
    const matched = METADATA_LINE.exec(line);
    if (!matched) continue;
    const key = matched[1].toLowerCase();
    const value = matched[2];
    if (key === "name") result.name = value || null;
    else if (key === "note") result.note = value || null;
    else if (key === "no-redirect") result.noRedirect = true;
    else if (key === "no-cookie-jar") result.noCookieJar = true;
    else if (key === "prompt") {
      // `@prompt 变量名 描述`：变量名必有，描述可缺（上游 PromptCommentRegex 同形）。
      const promptMatched = /^\s*(\S+)(?:\s+(.*))?$/.exec(String(value || "").trim());
      if (promptMatched) result.prompts.push({ name: promptMatched[1], description: promptMatched[2] || null });
    } else if (!result.unknown.includes(key)) result.unknown.push(key);
  }
  return result;
}

/** 请求块内的一行：原文文本 + 该行在全文里的行号（0 基）。 */
type BlockLine = { text: string; line: number };

/**
 * 取出请求块内的有效行：剥掉注释行，行号仍指原文。
 * @param lines 文件全文行数组
 * @param range 本请求块在全文中的行区间（首行必非注释，由 findRequestRange 保证）
 * @returns 逻辑行序列与块内注释行（两者都带原文行号）
 * @description 上游 `Selector.getRequest` 在解析前先 `filter(line => !isCommentLine(line))`，
 *   本插件要按原文行号写回，故这里只跳过注释行、保留原行号，而不是真的删行。
 *   漏掉这一步的后果很具体：`# Content-Type: application/json` 会被当成头部名发给宿主，
 *   而 `#`、空格都不是合法 header token，宿主直接抛错。
 * @description 注释行不参与语法，但也不该被写回丢掉（GUI 是按块重排的），
 *   所以连同原文一起交回调用方，由 http-serialize 在重排时带上。
 */
function requestBlockLines(lines: readonly string[], range: { start: number; end: number }): {
  lines: BlockLine[];
  comments: BlockLine[];
} {
  const out: BlockLine[] = [];
  const comments: BlockLine[] = [];
  for (let index = range.start; index <= range.end; index += 1) {
    const text = String(lines[index] ?? "");
    if (isHttpCommentLine(text)) {
      comments.push({ text, line: index });
      continue;
    }
    out.push({ text, line: index });
  }
  return { lines: out, comments };
}

/**
 * 解析请求行：取出方法与 URL，并吃掉紧随其后的查询串续行。
 * @param block 本请求块的逻辑行（注释行已剥离，首项即请求行）
 * @returns 方法、URL、协议版本、请求行末行行号与请求行占用的逻辑行数
 */
function parseRequestLine(block: readonly BlockLine[]): {
  method: string;
  url: string;
  httpVersion: string | null;
  requestLineEnd: number;
  requestLineRowCount: number;
} {
  // 上游把请求行与后续 `?`／`&` 行各自 trim 后直接相连，故这里同样逐行拼接。
  let index = 0;
  let joined = String(block[0]?.text ?? "").trim();
  let next = 1;
  while (next <= block.length - 1 && QUERY_CONTINUATION.test(block[next].text)) {
    joined += String(block[next].text).trim();
    index = next;
    next += 1;
  }
  const matched = REQUEST_LINE_METHOD.exec(joined);
  let method = "GET";
  let url = joined;
  if (matched) {
    method = matched[1].toUpperCase();
    url = joined.slice(matched[0].length);
  }
  url = url.trim();
  // 尾部 HTTP/x.y 只是协议版本声明，不参与请求（上游 /\s+HTTP\/.*$/ 剥离）。
  const version = /\s+HTTP\/.*$/i.exec(url);
  let httpVersion: string | null = null;
  if (version) {
    httpVersion = url.slice(version.index).trim().replace(/^\s+/, "");
    // 剥掉版本后 URL 可能只剩空白：地址栏被清空时写回的就是 `GET` 这一种形状，必须能往返解析。
    url = url.slice(0, version.index).trim();
  }
  return {
    method,
    url,
    httpVersion,
    requestLineEnd: block[index].line,
    requestLineRowCount: index + 1,
  };
}

/**
 * 解析头部行：`名: 值`，无冒号时值为空串；同名重复按上游规则合并。
 * @param headerLines 行原文与全文行号的配对清单
 * @returns 保留首次出现顺序的头部清单
 */
function parseHeaders(headerLines: Array<{ text: string; line: number }>): HttpHeaderEntry[] {
  const entries: HttpHeaderEntry[] = [];
  const indexByName = new Map<string, number>();
  for (const { text, line } of headerLines) {
    const trimmed = text.trim();
    const separator = trimmed.indexOf(":");
    const name = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim();
    const value = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
    const key = name.toLowerCase();
    const existing = indexByName.get(key);
    if (existing === undefined) {
      indexByName.set(key, entries.length);
      entries.push({ name, value, line });
      continue;
    }
    // 同名合并：Cookie 用分号，其余用逗号（上游 parseRequestHeaders 的 splitter 选择）。
    const joiner = key === "cookie" ? ";" : ",";
    entries[existing].value = `${entries[existing].value}${joiner}${value}`;
  }
  return entries;
}

/**
 * 收集一段文本里出现过的 `{{ }}` 引用名。
 * @param text 待扫文本
 * @returns 去重后的引用原文（已 trim），按出现顺序
 */
function collectRefs(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  // 全局正则带 lastIndex 状态，每次调用都用一份新的，避免跨次残留。
  const scanner = new RegExp(VARIABLE_REFERENCE.source, "g");
  let matched: RegExpExecArray | null;
  while ((matched = scanner.exec(text)) !== null) {
    const name = matched[1].trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      found.push(name);
    }
  }
  return found;
}

/**
 * 解析请求体：识别文件引用行与 GraphQL 变量段。
 * @param bodyLines 请求体行（原文，不 trim 行内内容以外的部分）
 * @param graphQl 是否为 GraphQL 请求
 * @returns 请求体原文、变量段原文、文件引用清单与「正文每一行对应的原文行号」
 * @description 返回的行号表必须与 `body` 的行一一对应：GraphQL 的 `body` 只含查询段，
 *   变量段的行号不能一起塞进去，否则正文里的 `< 文件` 引用会按错误的下标落位。
 */
function parseBody(bodyLines: Array<{ text: string; line: number }>, graphQl: boolean): {
  body: string | null;
  graphQlVariables: string | null;
  files: HttpBodyFileRef[];
  lineNumbers: number[];
  variablesLineNumbers: number[];
} {
  if (!bodyLines.length) {
    return { body: null, graphQlVariables: null, files: [], lineNumbers: [], variablesLineNumbers: [] };
  }
  const files: HttpBodyFileRef[] = [];
  for (const { text, line } of bodyLines) {
    const matched = BODY_FILE_LINE.exec(text);
    if (!matched) continue;
    files.push({ line, path: matched[3], processVariables: matched[1] === "@", encoding: matched[2] || null });
  }
  const allNumbers = bodyLines.map((item) => item.line);
  if (!graphQl) {
    return {
      body: bodyLines.map((item) => item.text).join("\n"),
      graphQlVariables: null,
      files,
      lineNumbers: allNumbers,
      variablesLineNumbers: [],
    };
  }
  // GraphQL：请求体在首个空行处分成「查询」与「变量」两段（上游 isGraphQlRequest 分支）。
  const blank = bodyLines.findIndex((item) => item.text.trim() === "");
  if (blank === -1) {
    return {
      body: bodyLines.map((item) => item.text).join("\n"),
      graphQlVariables: null,
      files,
      lineNumbers: allNumbers,
      variablesLineNumbers: [],
    };
  }
  const query = bodyLines.slice(0, blank).map((item) => item.text).join("\n");
  // 变量段从空行的下一行开始；上游随后 pop 掉查询与变量之间那个空行。
  const variableLines = bodyLines.slice(blank + 1);
  const variables = variableLines.map((item) => item.text).join("\n");
  return {
    body: query,
    graphQlVariables: variables || null,
    files,
    lineNumbers: allNumbers.slice(0, blank),
    variablesLineNumbers: variableLines.map((item) => item.line),
  };
}

/**
 * 解析一份 `.http` / `.rest` 文件。
 * @param text 文件全文（CRLF 与 LF 混用都可，内部统一按行拆）
 * @returns 文件变量与请求清单；无请求的文件得到空清单
 */
export function parseHttpFile(text: string): HttpParsedFile {
  // 首行 BOM 必须在按行拆之前吃掉：`\uFEFF### 标题` 会被 SECTION_DELIMITER 判成普通注释行，
  // 于是整份文件的第一个分节与标题一起失效（宿主读盘不做解码期 BOM 剥离，VS Code 会）。
  // 只是解析视图里去掉，写回时由 http-serialize 原样补回，文件字节不被改写。
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const variables = collectFileVariables(lines);
  const braceStyleVariableLines: number[] = [];
  lines.forEach((line, index) => {
    if (isBraceStyleVariableLine(line)) braceStyleVariableLines.push(index);
  });
  const requests: HttpParsedRequest[] = [];
  const skippedResponseSections: number[] = [];

  for (const section of splitSections(lines)) {
    const range = findRequestRange(lines, section);
    if (!range) {
      if (RESPONSE_STATUS_LINE.test(String(lines[section.start] ?? ""))) skippedResponseSections.push(section.start);
      continue;
    }
    const metadata = parseMetadata(lines, section);
    // 注释行不参与语法：头部区、正文区里的 `#`／`//` 行在这一步就被剥掉（行号仍是原文）。
    const { lines: block, comments } = requestBlockLines(lines, range);
    const { method, url, httpVersion, requestLineEnd, requestLineRowCount } = parseRequestLine(block);

    let headerStart = -1;
    let headerEnd = -1;
    let bodyStart = -1;
    let bodyEnd = -1;
    const headerLines: Array<{ text: string; line: number }> = [];
    const bodyLines: Array<{ text: string; line: number }> = [];

    // 上游状态机：请求行之后，紧接非空行即进入头部，遇到首个空行切换到请求体。
    let cursor = requestLineRowCount;
    if (cursor <= block.length - 1 && block[cursor].text.trim() !== "") {
      headerStart = block[cursor].line;
      while (cursor <= block.length - 1 && block[cursor].text.trim() !== "") {
        headerLines.push({ text: block[cursor].text, line: block[cursor].line });
        cursor += 1;
      }
      headerEnd = block[cursor - 1].line;
    }
    if (cursor <= block.length - 1 && block[cursor].text.trim() === "") cursor += 1;
    if (cursor <= block.length - 1) {
      bodyStart = block[cursor].line;
      bodyEnd = block[block.length - 1].line;
      for (let index = cursor; index <= block.length - 1; index += 1) {
        bodyLines.push({ text: block[index].text, line: block[index].line });
      }
    }

    const headers = parseHeaders(headerLines);
    // GraphQL 判定走上游同一条件：X-Request-Type 头部值等于 graphql（大小写不敏感）。
    const graphQl = headers.some(
      (header) => header.name.toLowerCase() === "x-request-type" && header.value.trim().toLowerCase() === "graphql"
    );
    const parsedBody = parseBody(bodyLines, graphQl);
    const raw = `${url}\n${headerLines.map((item) => item.text).join("\n")}\n${parsedBody.body || ""}\n${parsedBody.graphQlVariables || ""}`;

    requests.push({
      method,
      url,
      httpVersion,
      requestLineEnd,
      headerStart,
      headerEnd,
      bodyStart,
      bodyEnd,
      bodyLineNumbers: parsedBody.lineNumbers,
      startLine: range.start,
      endLine: range.end,
      sectionStart: section.opening ?? section.start,
      title: section.title,
      headers,
      body: parsedBody.body,
      name: metadata.name,
      note: metadata.note,
      noRedirect: metadata.noRedirect,
      noCookieJar: metadata.noCookieJar,
      prompts: metadata.prompts,
      unknownMetadata: metadata.unknown,
      graphQl,
      graphQlVariables: parsedBody.graphQlVariables,
      graphQlVariableLineNumbers: parsedBody.variablesLineNumbers,
      bodyFiles: parsedBody.files,
      variableRefs: collectRefs(raw),
      commentLines: comments,
    });
  }

  return { variables, requests, skippedResponseSections, braceStyleVariableLines };
}

/**
 * 一条请求在界面上该显示什么名字。
 * @param request 解析出的请求
 * @returns 标题；`###` 上写的标题优先于 `# @name`，两者都没写时 null
 * @description `# @name` 同时是请求变量 `{{name.response...}}` 的键，只当标识符用；
 *   界面标题取人写的 `### 登录接口`，没有才退到 `@name`。
 */
export function httpRequestTitle(request: HttpParsedRequest): string | null {
  return request.title || request.name || null;
}
