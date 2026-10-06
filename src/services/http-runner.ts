/**
 * HTTP 请求执行服务 (src/services/http-runner.ts)
 * @description 把解析出来的请求换成实际发出去的一次调用，并收拢宿主代发的硬边界。
 *   发送通道只有一个：宿主 `api.net.fetch`（宿主侧 `plugins:http-request`，
 *   由 Electron 的 net.fetch 代发，绕开渲染进程的 CORS 与混合内容限制）。
 * @description 宿主通道的边界必须在发之前讲清楚，不能假装成功：
 *   只收 http/https 绝对地址；方法表是 GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS
 *   （上游方法表里的 CONNECT/TRACE 与 WebDAV 一族宿主不收）；正文是字符串，
 *   二进制文件正文发不出去；响应体上限 5MB；超时钳在 1s..120s；
 *   重定向恒跟随（故 `# @no-redirect` 只能报「做不到」）；不带也不存 cookie。
 * @description 表单正文按上游 `formParamEncodingStrategy: "never"` 的口径原样发出，
 *   不做 automatic 那层再编码——那是 encodeurl 的字符集细节，此处不凭印象复刻。
 *   所有面向用户的文案都经 t() 出，三语词条见 locales/*.json 的 http.* 组。
 */

import type { PluginNetRequestOptions, PluginNetResponse } from "../types/plugin-runtime.ts";
import type { TranslateFn } from "../types/panel-state.ts";
import type { HttpBodyFileRef, HttpParsedFile, HttpParsedRequest } from "./http-request-parser.ts";
import { resolveHttpVariables } from "./http-variables.ts";
import type { HttpVariableScope, HttpVariableWarning, HttpResponseRecord } from "./http-variables.ts";
import { errorMessage, readFileContent } from "./file-service.ts";

/** 宿主代发通道（`api.net.fetch` 的同形接口，测试注入手替身）。 */
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
  /** 工作区根绝对路径；引用路径先按它试（上游解析顺序：绝对 → 工作区根 → 当前文件目录）。 */
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
 * 拼出一个正文文件引用的候选绝对路径。
 * @description 顺序照上游 requestParserUtil.resolveRequestBodyPath：绝对路径原样用；
 *   否则先按工作区根、再按当前 .http 文件所在目录拼。
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
  return warning.code === "varRequestSide"
    ? t("http.warn.varRequestSide", "请求变量「{{name}}」只有响应快照，取不到请求内容", { name: warning.name })
    : t("http.warn.varNoResponse", "请求变量「{{name}}」还没有可取的响应，请先发送那条请求", { name: warning.name });
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
    // `<@` 才做变量替换，普通 `<` 原样并入（上游 inputFileSyntax 的 processVariables 分支）。
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

  // GraphQL：上游按 X-Request-Type 判定后换成 { query, operationName, variables } 的 JSON 正文。
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

  const sent: HttpSentRequest = { method: request.method.toUpperCase(), url: urlResult.value, headers, body };
  const blockers: string[] = [];

  if (!/^https?:\/\//i.test(sent.url)) {
    // 上游允许 `Host` 头 + 根路径写法，宿主只收绝对地址，能就地拼就拼一个。
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
  if (request.noRedirect) {
    warnings.push(t("http.warn.noRedirect", "无法禁止自动跟随重定向"));
  }
  if (request.noCookieJar) {
    warnings.push(t("http.warn.noCookieJar", "请求不带也不保存 cookie"));
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
