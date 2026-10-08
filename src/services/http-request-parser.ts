/**
 * HTTP 请求文件解析器 (src/services/http-request-parser.ts)
 * @description 本插件支持的语法：
 *   分节行 `^#{2,}`——`###` 这类 `^#{3,}` 写法自然命中，井号后的同行文字是本节标题、
 *   请求行「方法 地址」，方法表固定（见 HTTP_REQUEST_METHODS），尾部的 `HTTP/x.y` 只当协议版本声明剥掉、
 *   查询串续行 `^\\s*[&?]`：地址允许换行续写，逐行拼回同一条 URL、
 *   头部从请求行下一行读到首个空行为止，同名头部用逗号合并（Cookie 用分号）、
 *   元数据 `# @name` / `@note` / `@no-redirect` / `@no-cookie-jar` / `@prompt`、
 *   文件变量 `@name = value`、
 *   以 `curl` 起头的一节改用 curl 解析、
 *   地址里的查询参数拆成参数表供 GUI 编辑（拆完还能原样拼回去）。
 *   响应脚本 `> {% %}` 与 `< environment >` 多环境段都不在这份语法里，故本解析器不发明它们的执行逻辑；
 *   但 `> {% … %}` 与 `> ./file` 会被**认出来并从正文里摘走**（见 extractResponseDirectives），
 *   因为把它们当正文发出去、或当头部名发给宿主，都是拿用户的文件猜。
 * @description `### 登录` 这种写在分隔行上的文字也读出来当界面标题（httpRequestTitle）：
 *   请求文件作者普遍用它给人看，丢掉的话这一行写的东西就没处显示了。
 *   `# @name` 仍是请求变量的键，两者各管各的。
 * @description 纯函数：不发起 IO、不做变量替换。变量引用的原文必须原样留着，
 *   行区间也要留——GUI 表单与文本视图要能按行号写回同一个文件。
 */

import { parseCurlCommand } from "./http-curl.ts";

/** 请求行认得的方法全集：第一个词不在表里时整行当地址，方法按 GET。 */
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
 *   `###`（`^#{3,}`）是最常见的写法，但 `##` 起头的行也必须算分节，漏掉会把下一条请求吞进上一条的正文。
 */
const SECTION_DELIMITER = /^#{2,}/;

/** 分节行同行可带标题：`## 登录接口`，取走前导 `#` 与空白后的剩余文本。 */
const SECTION_TITLE = /^#{2,}\s*(.*)$/;

/** 注释行：`#` 或 `//` 开头（忽略前导空白），整行不参与语法。 */
const COMMENT_LINE = /^\s*(#|\/{2})/;

/** 元数据行：`# @key value` / `// @key value`，键名是字母数字下划线或连字符，值可以缺。 */
const METADATA_LINE = /^\s*(?:#|\/{2})\s*@([\w-]+)(?:\s+(.*?))?\s*$/;

/** 文件变量定义行：`@name = value`，名字不得含空格与 `=`，值可以为空。 */
const FILE_VARIABLE_LINE = /^\s*@([^\s=]+)\s*=\s*(.*?)\s*$/;

/** 查询串续行：紧跟请求行、以 `?` 或 `&` 开头，trim 后直接拼在地址尾部。 */
const QUERY_CONTINUATION = /^\s*[&?]/;

/** 响应状态行：`HTTP/1.1 200 OK` 一类；一节以它起头说明这是粘贴进来的响应，不是请求。 */
const RESPONSE_STATUS_LINE = /^\s*HTTP\/[\d.]+/;

/** 请求体文件引用：`< 路径`、`<@ 路径`、`<@latin1 路径`；`<` 后要有空白，`@` 表示先做变量替换。 */
const BODY_FILE_LINE = /^<(?:(@)(\w+)?)?\s+(.+?)\s*$/;

/**
 * 响应侧指令行：`> ./out.json` 与 `> {% … %}`（`< {%` 起头的那一类见 RESPONSE_HANDLER_OPEN）。
 * @description 落盘与脚本执行都不在本插件的能力范围内，这里不执行，但必须**认出来**：
 *   当成头部发给宿主会让宿主收到 `> {%;` 这种非法头部名，当成正文发出去又把脚本原样贴给对方服务器。
 */
const RESPONSE_DIRECTIVE_LINE = /^\s*>\s*/;

/** 响应脚本块的起与止：`> {%` 或 `< {%` 开，含 `%}` 的那行收。 */
const RESPONSE_HANDLER_OPEN = /^\s*[><]\s*\{%\s*$/;

/** 响应脚本块的收尾行。 */
const RESPONSE_HANDLER_CLOSE = /%\}\s*$/;

/** curl 命令的起头行：一节以它开头时整节交给 parseCurlCommand 还原，不走请求行状态机。 */
const CURL_LINE = /^\s*curl\b/i;

/** 变量引用：`{{ ... }}`，非贪婪取到最近的 `}}`；这里只用来扫出引用名，替换在 http-variables。 */
const VARIABLE_REFERENCE = /\{{2}(.+?)\}{2}/;

/** 花括号式变量定义（`{{name}} = value`）：本插件不认这种写法，它也不算注释。 */
const BRACE_STYLE_VARIABLE_LINE = /^\s*\{\{\s*[^{}\s]+[^{}]*\}\}\s*=/;

/** 是否花括号式变量定义：它既不是变量也不是注释，不挡掉会被当成请求行读进去。 */
export function isBraceStyleVariableLine(line: string): boolean {
  return BRACE_STYLE_VARIABLE_LINE.test(line);
}

/** 一条请求头。 */
export type HttpHeaderEntry = {
  /** 头部名原文（保留文件里的大小写写法）。 */
  name: string;
  /** 头部值原文；同名重复时是合并后的结果（Cookie 用 `;`，其余用 `,`）。 */
  value: string;
  /** 该头部在文件中的行号（0 基）；同名合并时取首次出现的行号。 */
  line: number;
};

/** 请求体里的一条文件引用（`< ./demo.xml`）。 */
export type HttpBodyFileRef = {
  /** 所在行号（0 基）。 */
  line: number;
  /** 路径原文（可能带 `./`）；绝对路径原样用，相对路径先按工作区根、再按当前文件目录找。 */
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

/** 地址里 `?` 之后的一对查询参数；名与值都是原文（没做 URL 解码）。 */
export type HttpQueryParameter = {
  /** 参数名原文。 */
  name: string;
  /** 参数值原文，可能带着 `{{ }}` 引用；没有 `=` 时为空串。 */
  value: string;
};

/**
 * 拆出地址里的查询参数。
 * @param url 地址原文
 * @returns `{ base, params }`：`?` 之前的部分与参数清单
 * @description 只在第一个 `?` 之后拆；值里出现的 `&` 按分隔符处理（与浏览器地址栏一致）。
 *   不做编解码：`{{name}}` 引用必须原样留着，等变量那一趟再展开，
 *   在这里 decode 一次会让「值本身含 %20」与「写法含 %20」两种文件变得不可逆。
 */
export function splitUrlQuery(url: string): { base: string; params: HttpQueryParameter[] } {
  const text = String(url ?? "");
  const mark = text.indexOf("?");
  if (mark === -1) return { base: text, params: [] };
  const base = text.slice(0, mark);
  const params = text
    .slice(mark + 1)
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => {
      const eq = pair.indexOf("=");
      return eq === -1
        ? { name: pair, value: "" }
        : { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
    });
  return { base, params };
}

/**
 * 用参数表重拼地址。
 * @param base `?` 之前的地址原文
 * @param params 参数清单（顺序即写出顺序）
 * @returns 拼好的地址；参数表为空时只回 base（连 `?` 都不留）
 * @description 没有值的参数写成 `名字=`：表单里一格「有名无值」就是一个空值参数，
 *   写回时统一成这个形状，下一轮解析与再写回就稳定了。
 *   只在用户真的动过参数表时才会走到这里，没动过的 `?flag` 原样留着。
 */
export function buildUrlWithQuery(base: string, params: readonly HttpQueryParameter[]): string {
  const clean = String(base ?? "").replace(/\?+$/, "");
  const pairs = (params || [])
    .filter((param) => String(param.name ?? "") !== "")
    .map((param) => `${String(param.name).trim()}=${String(param.value ?? "")}`);
  if (!pairs.length) return clean;
  return `${clean}?${pairs.join("&")}`;
}

/** 解析出的单个请求。 */
export type HttpParsedRequest = {
  /** 方法，大写；请求行第一个词不在方法表里时整行当地址，方法按 GET。 */
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
  /** 未识别的 `# @key` 元数据键名：解析层不采纳，留痕给界面点名，免得写错键名后静默失效。 */
  unknownMetadata: string[];
  /** 是否 `X-Request-Type: GraphQL` 请求：只看这个头部；为真时请求体在首个空行处拆出变量段。 */
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
  /**
   * 这一条是从 curl 命令还原出来的吗。
   * @description 以 `curl` 起头的一节整段交给 parseCurlCommand 还原，不走「请求行 / 头部 / 正文」状态机。
   *   标出来有两个用处：界面上要说「这是 curl 还原的」，写回时不能把 curl 命令重排成 HTTP 请求行。
   */
  curl: boolean;
  /** 地址里 `?` 之后的查询参数（原文，未解码）；没有 `?` 时为空数组。 */
  queryParams: HttpQueryParameter[];
  /** `> {% … %}` / `< {% … %}` 里的响应脚本原文；没写时为 null。 */
  responseHandler: string | null;
  /** `> ./out.json` 写的响应落盘路径；没写时为 null。 */
  outputRedirect: string | null;
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
  /** 值原文（`\n` / `\r` / `\t` 已还原成控制字符，其余 `\x` 只吃掉反斜杠）。 */
  value: string;
  /** 定义所在行号（0 基）。 */
  line: number;
};

/** parseHttpFile 的返回。 */
export type HttpParsedFile = {
  /** 文件级变量，整文件可见、不分节：全文先扫一遍收集，同名后定义的覆盖先定义的。 */
  variables: HttpFileVariable[];
  /** 请求清单，按文件顺序；只有注释／变量定义的空节不产生请求。 */
  requests: HttpParsedRequest[];
  /** 被当作响应粘贴段而整节丢弃的起始行号：记的是本节第一条内容行，也就是 `HTTP/…` 状态行那一行。 */
  skippedResponseSections: number[];
  /** 写成 `{{name}} = value` 的行号（0 基）：本插件只认 `@name = value`，这些行不会成为变量定义，如实报给界面。 */
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

/** 转义表：只有这三个转义会被还原成控制字符，其余字符前的反斜杠单纯消失。 */
const VARIABLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

/** 还原变量值里的 `\n` / `\r` / `\t`；其他 `\x` 只吃掉反斜杠本身，后面那个字符留着。 */
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
 * @returns 按行号顺序的变量清单；同名变量后定义的覆盖先定义的
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
 * 按分节行（SECTION_DELIMITER）切节；一节就是一个候选请求块。
 * @param lines 文件全文行数组
 * @returns 行窗口清单；整份文件没有分节行时，文件本身即一节
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
 * @description `{{name}} = value` 这种写法本插件不当变量、也不当注释，
 *   于是会被当成请求行——用户会看到一个 URL 是 `{{host}} = https://...` 的假请求。
 *   这里把它一并排除在请求块外，并由 braceStyleVariableLines 如实告诉界面那行没生效。
 */
function findRequestRange(lines: readonly string[], section: Section): { start: number; end: number } | null {
  let start = section.start;
  let end = section.end;
  while (start <= end) {
    const line = lines[start];
    // 响应粘贴段（`HTTP/1.1 200 OK` 起头）整节跳过，不当请求解析。
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
 * @returns `@name`／`@note`／`@no-redirect`／`@no-cookie-jar`／`@prompt` 五个键的取值与未识别键名
 * @description 只扫请求行之前的注释行：空行与 `@name = value` 行可以穿插，
 *   但一碰到第一条非注释行就停，所以请求行之后写的 `# @name` 不会被采纳。
 *   认不了的键不报错，收进 unknownMetadata 留给界面提示。
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
      // `@prompt 变量名 描述`：变量名必有，描述可缺。
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
 * @description 注释行必须在解析前剔掉，而本插件要按原文行号写回，
 *   故这里只跳过注释行、保留原行号，而不是真的删行。
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
  // 请求行与后续 `?`／`&` 行各自 trim 后直接相连，中间不补空白。
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
  // 尾部 HTTP/x.y 只是协议版本声明，不参与请求：按 /\s+HTTP\/.*$/ 剥出来。
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
 * 解析头部行：`名: 值`，无冒号时值为空串；同名重复时合并进首次出现的那一条。
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
    // 同名合并：Cookie 用分号，其余用逗号；合并后行号仍是首次出现那一行。
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
 * 取出正文里的响应侧指令（`> {% … %}` 与 `> 路径`），并把这些行从正文里摘走。
 * @param bodyLines 正文行（原文 + 原文行号）
 * @returns 剩下的正文行，以及脚本原文与落盘路径
 * @description 这两样本插件的语法里没有，也不执行；摘走的理由是
 *   「不能假装成请求的一部分」：留在头部区会被当成非法头部名发给宿主，
 *   留在正文区又会把脚本原样贴到对方服务器上。摘下来之后由界面逐条点名。
 */
function extractResponseDirectives(bodyLines: BlockLine[]): {
  lines: BlockLine[];
  responseHandler: string | null;
  outputRedirect: string | null;
} {
  const kept: BlockLine[] = [];
  const handler: string[] = [];
  let outputRedirect: string | null = null;
  let inHandler = false;
  for (const item of bodyLines) {
    if (inHandler) {
      const inner = item.text.replace(RESPONSE_HANDLER_CLOSE, "").trim();
      // 收尾那行 `%}` 去掉标记后是空的：留一条空行会让写回时多出一行空白。
      if (inner) handler.push(inner);
      if (RESPONSE_HANDLER_CLOSE.test(item.text)) inHandler = false;
      continue;
    }
    if (RESPONSE_HANDLER_OPEN.test(item.text)) {
      inHandler = true;
      continue;
    }
    if (RESPONSE_DIRECTIVE_LINE.test(item.text)) {
      const target = item.text.replace(/^\s*>\s*/, "").trim();
      // `> {%` 写在同一行时（`> {% ... %}` 一行版）也按脚本处理，不当落盘路径。
      if (target.startsWith("{%")) {
        const inner = target.replace(/^\{%/, "").replace(RESPONSE_HANDLER_CLOSE, "").trim();
        if (inner) handler.push(inner);
        if (!RESPONSE_HANDLER_CLOSE.test(target)) inHandler = true;
        continue;
      }
      if (target && outputRedirect === null) outputRedirect = target;
      continue;
    }
    kept.push(item);
  }
  if (inHandler) {
    // 脚本块没闭合：已经摘走的行不能再塞回正文，否则又变成发出去的内容。
    handler.push("// (未闭合)");
  }
  // 摘掉指令后，原来只为隔开它而留的空行不该再算正文的一部分——
  // 不然 `{"probe":1}` 这种正文会带出一个多余尾换行，与文件里的字节对不上。
  let lines = kept;
  if (handler.length || outputRedirect !== null) {
    lines = [...kept];
    while (lines.length && lines[lines.length - 1].text.trim() === "") lines.pop();
  }
  return { lines, responseHandler: handler.length ? handler.join("\n") : null, outputRedirect };
}

/**
 * 解析请求体：识别文件引用行、响应侧指令与 GraphQL 变量段。
 * @param rawBodyLines 请求体行（原文，不 trim 行内内容以外的部分）
 * @param graphQl 是否为 GraphQL 请求
 * @returns 请求体原文、变量段原文、文件引用清单与「正文每一行对应的原文行号」
 * @description 返回的行号表必须与 `body` 的行一一对应：GraphQL 的 `body` 只含查询段，
 *   变量段的行号不能一起塞进去，否则正文里的 `< 文件` 引用会按错误的下标落位。
 */
function parseBody(rawBodyLines: Array<{ text: string; line: number }>, graphQl: boolean): {
  body: string | null;
  graphQlVariables: string | null;
  files: HttpBodyFileRef[];
  lineNumbers: number[];
  variablesLineNumbers: number[];
  responseHandler: string | null;
  outputRedirect: string | null;
} {
  const directives = extractResponseDirectives(rawBodyLines as BlockLine[]);
  const bodyLines = directives.lines;
  if (!bodyLines.length) {
    return {
      body: null,
      graphQlVariables: null,
      files: [],
      lineNumbers: [],
      variablesLineNumbers: [],
      responseHandler: directives.responseHandler,
      outputRedirect: directives.outputRedirect,
    };
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
      responseHandler: directives.responseHandler,
      outputRedirect: directives.outputRedirect,
    };
  }
  // GraphQL：请求体在首个空行处分成「查询」与「变量」两段。
  const blank = bodyLines.findIndex((item) => item.text.trim() === "");
  if (blank === -1) {
    return {
      body: bodyLines.map((item) => item.text).join("\n"),
      graphQlVariables: null,
      files,
      lineNumbers: allNumbers,
      variablesLineNumbers: [],
      responseHandler: directives.responseHandler,
      outputRedirect: directives.outputRedirect,
    };
  }
  const query = bodyLines.slice(0, blank).map((item) => item.text).join("\n");
  // 变量段从空行的下一行开始，那个空行两段都不算。
  const variableLines = bodyLines.slice(blank + 1);
  const variables = variableLines.map((item) => item.text).join("\n");
  return {
    body: query,
    graphQlVariables: variables || null,
    files,
    lineNumbers: allNumbers.slice(0, blank),
    variablesLineNumbers: variableLines.map((item) => item.line),
    responseHandler: directives.responseHandler,
    outputRedirect: directives.outputRedirect,
  };
}

/**
 * 解析一份 `.http` / `.rest` 文件。
 * @param text 文件全文（CRLF 与 LF 混用都可，内部统一按行拆）
 * @returns 文件变量与请求清单；无请求的文件得到空清单
 */
export function parseHttpFile(text: string): HttpParsedFile {
  // 首行 BOM 必须在按行拆之前吃掉：`\uFEFF### 标题` 会被 SECTION_DELIMITER 判成普通注释行，
  // 于是整份文件的第一个分节与标题一起失效（宿主读盘不保证已经剥掉 BOM）。
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
      // 记的是「本节第一条真正的内容行」：分节行本身永远不是状态行，
      // 用 section.start 去判会把这段跳过的响应整个漏报，界面就说不清少了几段。
      const responseAt = responseSectionLine(lines, section);
      if (responseAt !== -1) skippedResponseSections.push(responseAt);
      continue;
    }
    const metadata = parseMetadata(lines, section);
    // 注释行不参与语法：头部区、正文区里的 `#`／`//` 行在这一步就被剥掉（行号仍是原文）。
    const { lines: block, comments } = requestBlockLines(lines, range);

    // curl 一节：整段交给 curl 解析器，不再走「请求行 / 头部 / 正文」状态机。
    // 还原出的头部不来自某一行原文，行号只能给 -1。
    if (CURL_LINE.test(block[0]?.text ?? "")) {
      const parts = parseCurlCommand(block.map((item) => item.text).join("\n"));
      const lastLine = block[block.length - 1].line;
      // `-d @文件` 摊成一行 `< 路径`：这样正文文件走的是与手写引用完全相同的那条内联链路，
      // 不必在发送层再开一个只有 curl 才用的读取分支。
      const curlBodyFile = parts.bodyFile === null ? null : `< ${parts.bodyFile}`;
      const curlBody = parts.bodyFile === null ? parts.body : curlBodyFile;
      requests.push({
        method: parts.method,
        url: parts.url,
        httpVersion: null,
        requestLineEnd: block[0].line,
        headerStart: -1,
        headerEnd: -1,
        bodyStart: parts.body === null && parts.bodyFile === null ? -1 : lastLine,
        bodyEnd: parts.body === null && parts.bodyFile === null ? -1 : lastLine,
        bodyLineNumbers: parts.body === null && parts.bodyFile === null ? [] : [lastLine],
        startLine: range.start,
        endLine: range.end,
        sectionStart: section.opening ?? section.start,
        title: section.title,
        headers: parts.headers.map((header) => ({ ...header, line: -1 })),
        body: curlBody,
        name: metadata.name,
        note: metadata.note,
        noRedirect: metadata.noRedirect,
        noCookieJar: metadata.noCookieJar,
        prompts: metadata.prompts,
        unknownMetadata: metadata.unknown,
        graphQl: parts.headers.some((header) => header.name.toLowerCase() === "x-request-type" && header.value.trim().toLowerCase() === "graphql"),
        graphQlVariables: null,
        graphQlVariableLineNumbers: [],
        bodyFiles: parts.bodyFile === null ? [] : [{ line: lastLine, path: parts.bodyFile, processVariables: false, encoding: null }],
        curl: true,
        queryParams: splitUrlQuery(parts.url).params,
        responseHandler: null,
        outputRedirect: null,
        variableRefs: collectRefs(`${parts.url}\n${parts.headers.map((header) => `${header.name}: ${header.value}`).join("\n")}\n${parts.body ?? ""}`),
        commentLines: comments,
      });
      continue;
    }

    const { method, url, httpVersion, requestLineEnd, requestLineRowCount } = parseRequestLine(block);

    let headerStart = -1;
    let headerEnd = -1;
    let bodyStart = -1;
    let bodyEnd = -1;
    const headerLines: Array<{ text: string; line: number }> = [];
    const bodyLines: Array<{ text: string; line: number }> = [];

    // 状态机：请求行之后，紧接非空行即进入头部，遇到首个空行切换到请求体。
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

    // 头部区也可能撞上没有空行的响应指令（`> {% … %}` 紧贴请求行写时落在这里）：
    // 不摘走就会被切成 `> {% client.log(1); %}` 这种非法头部名发给宿主。
    const headerDirectives = extractResponseDirectives(headerLines);
    const headers = parseHeaders(headerDirectives.lines);
    // GraphQL 判定只看一个条件：X-Request-Type 头部值等于 graphql（大小写不敏感）。
    const graphQl = headers.some(
      (header) => header.name.toLowerCase() === "x-request-type" && header.value.trim().toLowerCase() === "graphql"
    );
    const parsedBody = parseBody(bodyLines, graphQl);
    const responseHandler = parsedBody.responseHandler || headerDirectives.responseHandler;
    const outputRedirect = parsedBody.outputRedirect || headerDirectives.outputRedirect;
    const raw = `${url}\n${headerDirectives.lines.map((item) => item.text).join("\n")}\n${parsedBody.body || ""}\n${parsedBody.graphQlVariables || ""}`;

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
      curl: false,
      queryParams: splitUrlQuery(url).params,
      responseHandler,
      outputRedirect,
      variableRefs: collectRefs(raw),
      commentLines: comments,
    });
  }

  return { variables, requests, skippedResponseSections, braceStyleVariableLines };
}

/**
 * 找出「粘贴进来的响应段」里那条状态行的行号。
 * @param lines 文件全文行数组
 * @param section 本节的行窗口
 * @returns 状态行行号；本节不是响应粘贴段时为 -1
 */
function responseSectionLine(lines: readonly string[], section: Section): number {
  for (let index = section.start; index <= section.end; index += 1) {
    const line = String(lines[index] ?? "");
    if (line.trim() === "" || isHttpCommentLine(line) || isHttpFileVariableLine(line) || isBraceStyleVariableLine(line)) {
      continue;
    }
    return RESPONSE_STATUS_LINE.test(line) ? index : -1;
  }
  return -1;
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
