/**
 * HTTP 请求执行服务 (src/services/http-runner.ts)
 * @description 把解析出来的请求换成实际发出去的一次调用，并收拢宿主代发的硬边界。
 *   发送通道只有一个：宿主 `api.net.fetch`（宿主侧 `plugins:http-request`，
 *   由 Electron 的 net.fetch 代发，绕开渲染进程的 CORS 与混合内容限制）。
 * @description 宿主通道的边界必须在发之前讲清楚，不能假装成功：
 *   只收 http/https 绝对地址；方法表就是 GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS，
 *   CONNECT/TRACE 与 WebDAV 一族宿主不收；正文是字符串，
 *   二进制文件正文发不出去；响应体上限 5MB；超时钳在 1s..120s；
 *   重定向恒跟随（故 `# @no-redirect` 只能报「做不到」）；不带也不存 cookie。
 *   做不到的那些要么前置拒绝、要么点名提示，不能让用户以为照自己写的发出去了。
 * @description 表单正文按原文发出，不做第二次编码：值里已经写成 `%20` 的转义再编一次
 *   就变成 `%2520`，服务端解出来的值就错了。要不要预编码由用户写文件时定，本插件不替他猜，
 *   也不自己发明一套按字符集的自动编码规则——吃不准服务端要什么时，宁可不编码。
 *   所有面向用户的文案都经 t() 出，三语词条见 locales/*.json 的 http.* 组。
 */

import type { PluginNetRequestOptions, PluginNetResponse } from "../types/plugin-runtime.ts";
import type { TranslateFn } from "../types/panel-state.ts";
import type { HttpBodyFileRef, HttpParsedFile, HttpParsedRequest } from "./http-request-parser.ts";
import { resolveHttpVariables, mimeTypeOf } from "./http-variables.ts";
import type { HttpVariableScope, HttpVariableWarning, HttpResponseRecord } from "./http-variables.ts";
import { errorMessage, readFileContent } from "./file-service.ts";
import { encodeBase64Utf8 } from "../utils/encoding.ts";

/** 宿主代发通道：签名就是 `api.net.fetch`，测试里注入替身顶掉它。 */
export type HttpFetch = (url: string, options?: PluginNetRequestOptions) => Promise<PluginNetResponse>;

/** 一次真实响应。 */
export type HttpRunResponse = HttpResponseRecord & {
  /** 跟随重定向后实际请求到的地址；宿主没回时为空串。 */
  finalUrl: string;
  /** 是否 2xx；取宿主回传的 ok。 */
  ok: boolean;
  /** 响应头里的 Content-Type 原文；没有时为空串。 */
  contentType: string;
  /** 从发出到收到响应的毫秒数。 */
  elapsedMs: number;
  /** 响应体字符数（宿主只回文本，按长度估）。 */
  bodyLength: number;
};

/** 实际发出去的最终请求（变量已替换、文件正文已并入）。 */
export type HttpSentRequest = {
  /** 方法（大写）。 */
  method: string;
  /** 最终 URL。 */
  url: string;
  /** 最终请求头；Content-Length 与 GraphQL 标记已剔除。 */
  headers: Record<string, string>;
  /** 最终请求体文本；没有请求体时为 null。 */
  body: string | null;
};

/** 一次执行的完整结果。 */
export type HttpRunResult = {
  /** 最终请求；即便被前置拒绝也带回来，界面好指出是哪一条发不出去。 */
  sent: HttpSentRequest;
  /** 真拿到的响应；前置拒绝或传输失败时为 null。 */
  response: HttpRunResponse | null;
  /** 失败原因文案（已经过 t）；成功时为 null。多条用换行拼在一起。 */
  error: string | null;
  /** 未能替换的变量引用名；非空表示请求里带着 `{{x}}` 原样发出去了。 */
  unresolved: string[];
  /** 执行过程中的提示（请求变量没发过、某条指令宿主做不到等）。 */
  warnings: string[];
  /** 是否真的发出了网络请求；前置拒绝为 false。 */
  attempted: boolean;
};

/** 执行所需的宿主能力与偏好。 */
export type HttpRunOptions = {
  /** 代发通道。 */
  fetch: HttpFetch;
  /** 变量作用域（环境变量、已发响应、prompt 值、随机源；文件变量由本服务从 file 上取）。 */
  scope: HttpVariableScope;
  /** 文案翻译函数。 */
  t: TranslateFn;
  /** 当前 .http 文件的绝对路径，用于解析相对正文文件引用。 */
  filePath: string;
  /** 工作区根绝对路径；正文里的相对文件引用先按它拼、再按当前文件所在目录拼。 */
  rootPath?: string;
  /** 超时毫秒；缺省交给宿主默认（宿主夹在 1s..120s）。 */
  timeoutMs?: number;
  /** 读文本文件的手替身；缺省用宿主 readFileContent。 */
  readText?: (path: string) => Promise<{ text: string; isBinary: boolean } | null>;
};

/** 宿主代发通道收的方法表（大写比较）。 */
const HOST_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** 大概率是二进制的正文文件后缀；宿主通道只发字符串，遇到即拒绝并说明。 */
const BINARY_BODY_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "tar",
  "7z",
  "rar",
  "mp3",
  "m4a",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "exe",
  "dll",
  "so",
  "dylib",
  "class",
  "jar",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
]);

/** 取扩展名（小写、不含点）。 */
function extensionOf(path: string): string {
  const name = String(path || "").split(/[\\/]/).pop() || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** 大小写不敏感地取一个头部值。 */
function pickHeader(headers: Record<string, string>, name: string): string {
  const key = name.toLowerCase();
  for (const [header, value] of Object.entries(headers || {})) {
    if (header.toLowerCase() === key) return value;
  }
  return "";
}

/** 大小写不敏感地删掉一个头部。 */
function dropHeader(headers: Record<string, string>, name: string): void {
  const key = name.toLowerCase();
  for (const header of Object.keys(headers)) {
    if (header.toLowerCase() === key) delete headers[header];
  }
}

/**
 * 按 Content-Type 组正文的行结束符。
 * @param body 已做完变量替换与 `< 文件` 内联的正文
 * @param contentType 最终请求头里的 Content-Type（没写时空串）
 * @returns 该发的正文
 * @description 服务端就靠这些分隔符解正文，错一个字节整段都解不出来，所以框架必须在发送前定死：
 *   - `application/x-www-form-urlencoded`：`&` 起头的行并进上一行，其余行之间留一个换行，
 *     于是文件里分行写的表单字段发出去是**一行** `name=foo&password=bar`——换行不是表单
 *     语法的一部分，留着它上一个字段的值里就多出个换行。
 *   - `multipart/form-data`：行结束符强制 `\r\n`，并整体补一个尾 CRLF。
 *     boundary 的收尾行本来就要求前面是 CRLF，少这一字节服务端就解析不出结束标记；
 *     所以不管正文是不是从文件内联来的都补——内联与否只是来源不同，线上格式是同一种。
 *   - `application/x-ndjson`：补一个行结束符。一行一条记录，末行缺换行时读的一方常把它丢掉。
 *   先按 `\r?\n` 归一再按目标结束符拼：内联进来的文件本身带 CRLF 时，
 *   不归一就会拼出 `\r\r\n`，multipart 直接坏掉。
 */
export function frameHttpBody(body: string, contentType: string): string {
  const mime = mimeTypeOf(contentType);
  const lines = String(body ?? "").split(/\r?\n/);
  if (mime === "application/x-www-form-urlencoded") {
    return lines.reduce((acc, line, at) => `${acc}${at === 0 || line.startsWith("&") ? "" : "\n"}${line}`, "");
  }
  const ending = mime === "multipart/form-data" ? "\r\n" : "\n";
  let result = lines.join(ending);
  if (mime === "application/x-ndjson") result += ending;
  else if (mime === "multipart/form-data") result += "\r\n";
  return result;
}

/**
 * 把 `Authorization` 里的用户名密码补成真正的认证头。
 * @param headers 最终请求头（就地改）
 * @param warn 过程信息回报
 * @param t 翻译函数
 * @description `Authorization: Basic` 允许三种写法，但线上只有一种：`Basic <base64>`，
 *   所以在本插件里归一：
 *   `Basic 用户 密码`（三个及以上词，用户名之后的全是密码）与 `Basic 用户:密码`（一个词且含冒号）
 *   都就地重写为 `Basic base64(用户:密码)`；只有一个词又不含冒号时视为已经是 base64，原样发。
 *   `Digest` 要先收 401 挑战再重试、`AWS` 要按最终正文与主机签 SigV4、`COGNITO` 要先拿凭据换
 *   Bearer 令牌——宿主给的是一次性代发通道，一发一收，没有重试也没有额外签名的位置，这三样给不了。
 *   于是这三类带凭据的写法逐条点名说明，不把 `Digest 用户 密码` 这种半截值当认证头发出去。
 */
function normalizeAuthorizationHeader(
  headers: Record<string, string>,
  warn: (text: string) => void,
  t: TranslateFn
): void {
  const raw = pickHeader(headers, "Authorization");
  if (!raw) return;
  const key = Object.keys(headers).find((header) => header.toLowerCase() === "authorization") || "Authorization";
  const [scheme, first, ...rest] = String(raw).split(/\s+/);
  const normalized = String(scheme || "").toLowerCase();
  if (normalized === "basic") {
    // 密码里带空格是常事：`Basic x y z` 第一个词是用户名，之后拼回去才不把后半截密码丢掉。
    const credential = rest.length ? `${first}:${rest.join(" ")}` : first && first.includes(":") ? first : "";
    if (credential) headers[key] = `Basic ${encodeBase64Utf8(credential)}`;
    return;
  }
  if (rest.length && (normalized === "digest" || normalized === "aws" || normalized === "cognito")) {
    warn(
      normalized === "digest"
        ? t("http.warn.authDigest", "暂不支持 Digest 认证（要靠 401 挑战重试），这条 Authorization 已按原文发出")
        : normalized === "aws"
          ? t("http.warn.authAws", "暂不支持自动计算 AWS Signature v4，这条 Authorization 已按原文发出")
          : t("http.warn.authCognito", "暂不支持用 COGNITO 凭据换取 Bearer 令牌，这条 Authorization 已按原文发出")
    );
  }
}

/**
 * 拼出一个正文文件引用的候选绝对路径。
 * @description 绝对路径原样用。相对写法在本插件里有两个都说得通的落点——相对工作区根、
 *   相对当前 .http 文件所在目录——光看字符串分不出用户指哪个，于是按
 *   「工作区根 → 当前文件目录」依次拼候选，谁先读到算谁，两个都读不到才报缺文件。
 * @param ref 引用原文（可能带 `./`）
 * @param options 执行选项（filePath / rootPath）
 * @returns 候选路径清单，按尝试顺序
 */
function candidatePaths(ref: string, options: HttpRunOptions): string[] {
  const clean = String(ref || "").trim();
  if (!clean) return [];
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(clean)) return [clean];
  const relative = clean.replace(/^\.\/[\\/]?/, "");
  const out: string[] = [];
  const root = String(options.rootPath || "").replace(/[\\/]+$/, "");
  if (root) out.push(`${root}/${relative}`);
  const dir = String(options.filePath || "").replace(/[\\/]+$/, "").split(/[\\/]/).slice(0, -1).join("/");
  if (dir && `${dir}/${relative}` !== out[0]) out.push(`${dir}/${relative}`);
  if (!out.length) out.push(relative);
  return out;
}

/**
 * 把请求体里的 `< 文件` 引用换成文件内容。
 * @param body 已替换过变量的请求体文本
 * @param request 解析出的请求（提供引用行号与 `<@` 标记）
 * @param options 执行选项
 * @param scope 变量作用域（`<@` 读进来的内容要再替换一次变量）
 * @returns 拼好的正文、错误文案与提示
 */
/**
 * 变量层的结构化告警翻成一句话。
 * @param warning 告警（种类 + 变量名）
 * @param t 翻译函数
 * @returns 当前语言的提示文案
 */
function variableWarningText(warning: HttpVariableWarning, t: TranslateFn): string {
  if (warning.code === "varTooDeep") {
    return t("http.warn.varTooDeep", "变量「{{name}}」的引用嵌套太深，已按原文发出", { name: warning.name });
  }
  if (warning.code === "varNoDotenv") {
    return t("http.warn.varNoDotenv", "项目里没读到 .env 文件，变量「{{name}}」没有值", { name: warning.name });
  }
  if (warning.code === "varNoDotenvKey") {
    return t("http.warn.varNoDotenvKey", ".env 里没有「{{name}}」这一项", { name: warning.name });
  }
  if (warning.code === "varUnsupported") {
    return t("http.warn.varUnsupported", "变量「{{name}}」要读的东西本宿主拿不到，已按原文发出", { name: warning.name });
  }
  return t("http.warn.varNoResponse", "请求变量「{{name}}」还没有可取的内容，请先发送那条请求", { name: warning.name });
}

/**
 * 逐行组装正文：变量替换与 `< 文件` 内联在同一趟里按原文行号对齐。
 * @param text 正文原文（普通请求体，或 GraphQL 的查询段 / 变量段）
 * @param lineNumbers 该文本每一行对应的原文行号，与 `text` 的行一一对应
 * @param refs 该请求全部文件引用（按原文行号匹配；不属于本段的行自动落空）
 * @param options 执行选项（相对路径解析与读文件）
 * @param scope 变量作用域
 * @returns 组装后的正文、错误与过程信息
 * @description 必须逐行做：先整体替换变量再内联文件是错的——变量值里的换行会改变行数，
 *   之后再按行号定位 `< 文件` 引用就会把文件内容插到别的行上、甚至覆盖普通正文。
 */
async function assembleBody(
  text: string,
  lineNumbers: readonly number[],
  refs: readonly HttpBodyFileRef[],
  options: HttpRunOptions,
  scope: HttpVariableScope
): Promise<{ text: string; error: string | null; warnings: string[]; unresolved: string[] }> {
  const { t } = options;
  const readText =
    options.readText ||
    (async (path: string) => {
      const result = await readFileContent(path);
      if (!result || typeof result.content !== "string") return null;
      return { text: result.content, isBinary: result.isBinary };
    });
  const warnings: string[] = [];
  const unresolved: string[] = [];
  const byLine = new Map<number, HttpBodyFileRef>();
  for (const ref of refs) if (!byLine.has(ref.line)) byLine.set(ref.line, ref);

  const lines = text.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const sourceLine = lines[index];
    const originalLine = lineNumbers[index];
    const ref = originalLine === undefined ? undefined : byLine.get(originalLine);
    if (!ref) {
      const resolved = resolveHttpVariables(sourceLine, scope);
      unresolved.push(...resolved.unresolved);
      for (const warning of resolved.warnings) warnings.push(variableWarningText(warning, t));
      out.push(resolved.value);
      continue;
    }
    // 引用行：路径本身也可能带变量（`< {{dir}}/body.json`），先解析路径再找文件。
    const pathResult = resolveHttpVariables(ref.path, scope);
    unresolved.push(...pathResult.unresolved);
    for (const warning of pathResult.warnings) warnings.push(variableWarningText(warning, t));
    const refPath = pathResult.value;
    if (BINARY_BODY_EXTENSIONS.has(extensionOf(refPath))) {
      return { text: "", error: t("http.err.binaryBody", "暂不支持发送二进制文件正文（{{path}}）", { path: refPath }), warnings, unresolved };
    }
    // 宿主只按 UTF-8 交回文本，`<@latin1 文件` 这类编码声明做不到：说清楚，不假装做到了。
    if (ref.encoding && !/^utf-?8$/i.test(ref.encoding)) {
      warnings.push(
        t("http.warn.bodyFileEncoding", "正文文件声明的编码 {{encoding}} 不支持，已按 UTF-8 读取", {
          encoding: ref.encoding,
        })
      );
    }
    let loaded: { text: string; isBinary: boolean } | null = null;
    for (const candidate of candidatePaths(refPath, options)) {
      if (BINARY_BODY_EXTENSIONS.has(extensionOf(candidate))) {
        return { text: "", error: t("http.err.binaryBody", "暂不支持发送二进制文件正文（{{path}}）", { path: candidate }), warnings, unresolved };
      }
      try {
        loaded = await readText(candidate);
      } catch {
        loaded = null;
      }
      if (loaded) break;
    }
    if (!loaded) {
      warnings.push(t("http.warn.bodyFileMissing", "请求体引用的文件没读到：{{path}}", { path: refPath }));
      out.push(sourceLine);
      continue;
    }
    if (loaded.isBinary) {
      return { text: "", error: t("http.err.binaryBody", "暂不支持发送二进制文件正文（{{path}}）", { path: refPath }), warnings, unresolved };
    }
    // 只有 `<@` 对并入的内容再做一遍变量替换，普通 `<` 原样并入：
    // 外部文件里的 `{{ }}` 多半是它自己的语法，不默认替用户吃掉。
    if (ref.processVariables) {
      const injected = resolveHttpVariables(loaded.text, scope);
      unresolved.push(...injected.unresolved);
      for (const warning of injected.warnings) warnings.push(variableWarningText(warning, t));
      out.push(injected.value);
    } else {
      out.push(loaded.text);
    }
  }
  return { text: out.join("\n"), error: null, warnings, unresolved };
}

/**
 * 组装并发送一个请求。
 * @param request 解析出的请求（GUI 表单改过的字段应已并回 request 上的原文）
 * @param file 所在文件的解析结果，提供文件变量表
 * @param options 执行选项
 * @returns 执行结果；前置拒绝也带 sent 与原因，界面按同一套渲染
 */
export async function runHttpRequest(
  request: HttpParsedRequest,
  file: HttpParsedFile,
  options: HttpRunOptions
): Promise<HttpRunResult> {
  const { t } = options;
  const scope: HttpVariableScope = {
    ...options.scope,
    fileVariables: new Map([
      ...options.scope.fileVariables,
      ...file.variables.map((variable) => [variable.name, variable.value] as [string, string]),
    ]),
  };
  const warnings: string[] = [];
  const unresolved: string[] = [];
  /** 同一条提示只留一份：正文里重复 50 处同一个未发过的请求变量时，界面不该堆 50 行相同文案。 */
  const collectWarnings = () => [...new Set(warnings)];
  /** 变量层的结构化告警 → 当前语言的一句话。 */
  const pushVariableWarnings = (resolved: { warnings: HttpVariableWarning[] }) => {
    for (const warning of resolved.warnings) warnings.push(variableWarningText(warning, t));
  };

  const urlResult = resolveHttpVariables(request.url, scope);
  unresolved.push(...urlResult.unresolved);
  pushVariableWarnings(urlResult);

  const headers: Record<string, string> = {};
  for (const header of request.headers) {
    const nameResult = resolveHttpVariables(header.name, scope);
    const valueResult = resolveHttpVariables(header.value, scope);
    unresolved.push(...nameResult.unresolved, ...valueResult.unresolved);
    pushVariableWarnings(nameResult);
    pushVariableWarnings(valueResult);
    const name = nameResult.value.trim();
    if (!name) continue;
    // Content-Length 一律丢掉：宿主按最终正文重算，写死了必然对不上。
    if (name.toLowerCase() === "content-length") continue;
    headers[name] = valueResult.value;
  }

  let body: string | null = null;
  let bodyError: string | null = null;
  if (request.body !== null) {
    // 变量替换与 `< 文件` 内联在同一趟里按原文行号逐行做：先整体替换再内联是错的——
    // 变量值里的换行会改变行数，之后按行号定位引用就会把文件内容插到别的行上。
    const assembled = await assembleBody(request.body, request.bodyLineNumbers, request.bodyFiles, options, scope);
    body = assembled.text;
    bodyError = assembled.error;
    unresolved.push(...assembled.unresolved);
    warnings.push(...assembled.warnings);
  }

  // GraphQL：`X-Request-Type: GraphQL` 只是本文件里的开关，服务端收的是 `{ query, operationName,
  // variables }` 这一份 JSON，所以发送前要把查询段和变量段并成它，标记头本身不发出去。
  if (request.graphQl && body !== null && bodyError === null) {
    dropHeader(headers, "X-Request-Type");
    const operationName = /^\s*query\s+([^@{(\s]+)/i.exec(body)?.[1];
    let variables: unknown = {};
    if (request.graphQlVariables) {
      // 变量段也是正文的一部分：同一套逐行组装（变量与 `< 文件` 都要生效）。
      const assembledVariables = await assembleBody(
        request.graphQlVariables,
        request.graphQlVariableLineNumbers,
        request.bodyFiles,
        options,
        scope
      );
      unresolved.push(...assembledVariables.unresolved);
      warnings.push(...assembledVariables.warnings);
      if (assembledVariables.error) bodyError = assembledVariables.error;
      try {
        variables = JSON.parse(assembledVariables.text);
      } catch {
        warnings.push(t("http.warn.graphQlVariables", "变量段不是合法的 JSON，按空对象发出"));
      }
    }
    body = JSON.stringify({ query: body, operationName: operationName || null, variables });
  }

  // 正文的框架（行结束符、表单并成一行、ndjson 补尾换行）在变量与 `< 文件` 都落定之后再按
  // Content-Type 过一遍。顺序不能颠倒：变量的值和内联进来的文件都自带换行，先定框架就会让
  // 这些换行绕过归一——multipart 拼出 `\r\r\n`，正文直接坏掉。
  if (body !== null && bodyError === null) {
    body = frameHttpBody(body, pickHeader(headers, "Content-Type"));
  }
  normalizeAuthorizationHeader(headers, (text) => warnings.push(text), t);

  const sent: HttpSentRequest = { method: request.method.toUpperCase(), url: urlResult.value, headers, body };
  const blockers: string[] = [];

  if (!/^https?:\/\//i.test(sent.url)) {
    // 只写 `/path` 再配一个 `Host` 头也是合法请求，但宿主只收绝对地址：能就地拼出完整 URL 就拼，
    // 协议段没得读就按端口猜（443/8443 走 https）。拼完把 `Host` 头摘掉，主机名已在 URL 里，
    // 两处各说一份迟早对不上。
    const host = pickHeader(headers, "Host");
    if (host && sent.url.startsWith("/")) {
      const port = host.split(":")[1];
      const scheme = port === "443" || port === "8443" ? "https" : "http";
      sent.url = `${scheme}://${host}${sent.url}`;
      dropHeader(headers, "Host");
    } else {
      blockers.push(t("http.err.absoluteUrl", "只能访问 http(s) 完整地址，当前是 {{url}}", {
        url: sent.url || t("http.emptyUrl", "空"),
      }));
    }
  }
  if (!HOST_METHODS.has(sent.method)) {
    blockers.push(t("http.err.method", "暂不支持用 {{method}} 发送", { method: sent.method }));
  }
  // 这两条都是发送方的能力开关，宿主通道没有：重定向恒跟随，cookie 一律不带也不存
  // （本来也没有一份 cookie 表可关）。做不到的只报提示、不拦发送——请求本身照用户写的发出。
  if (request.noRedirect) {
    warnings.push(t("http.warn.noRedirect", "无法禁止自动跟随重定向"));
  }
  if (request.noCookieJar) {
    warnings.push(t("http.warn.noCookieJar", "请求不带也不保存 cookie"));
  }
  // 响应脚本（`> {% %}`）与响应落盘（`> ./file`）不在本插件的执行范围：既不跑也不写文件。
  // 解析时这两段已从正文里拆走，不点名就是静默吞掉用户写在这一节里的内容，所以逐条说清哪段被忽略。
  if (request.responseHandler) {
    warnings.push(t("http.warn.responseHandler", "这段响应脚本（> {% %}）不会被执行"));
  }
  if (request.outputRedirect) {
    warnings.push(
      t("http.warn.outputRedirect", "响应不会写进 {{path}}，这一行原样留在请求里", {
        path: request.outputRedirect,
      })
    );
  }
  if (unresolved.length) {
    // 只报「有几处」等于没说：用户找不出是哪个变量，把名字列出来才叫说明白。
    warnings.push(
      t("http.warn.unresolved", "这些变量没换成值，已按原文发出：{{names}}", {
        names: [...new Set(unresolved)].join(", "),
      })
    );
  }

  // 正文组装（含 `< 文件` 内联）已经在前面那一趟里做完，这里只把它的错误并进前置拒绝。
  if (bodyError) blockers.push(bodyError);

  if (blockers.length) {
    return { sent, response: null, error: blockers.join("\n"), unresolved, warnings: collectWarnings(), attempted: false };
  }

  const startedAt = Date.now();
  let raw: PluginNetResponse;
  try {
    raw = await options.fetch(sent.url, {
      method: sent.method,
      headers: sent.headers,
      body: sent.body ?? undefined,
      timeoutMs: options.timeoutMs,
    });
  } catch (err) {
    return { sent, response: null, error: errorMessage(err), unresolved, warnings: collectWarnings(), attempted: true };
  }
  const elapsedMs = Date.now() - startedAt;
  const responseHeaders: Record<string, string> = raw && raw.headers && typeof raw.headers === "object" ? raw.headers : {};
  const responseBody = String(raw?.body ?? "");
  return {
    sent,
    response: {
      status: Number(raw?.status ?? 0),
      statusText: String(raw?.statusText ?? ""),
      headers: responseHeaders,
      body: responseBody,
      finalUrl: String(raw?.url ?? ""),
      ok: raw?.ok === true,
      contentType: pickHeader(responseHeaders, "Content-Type"),
      elapsedMs,
      bodyLength: responseBody.length,
    },
    error: raw && raw.error ? String(raw.error) : null,
    unresolved,
    warnings: collectWarnings(),
    attempted: true,
  };
}
