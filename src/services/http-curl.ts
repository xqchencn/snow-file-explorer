/**
 * curl 命令解析服务 (src/services/http-curl.ts)
 * @description 一节以 `curl` 起头时，整段按 curl 命令行还原成方法 / URL / 头部 / 正文。
 *   认识的选项只有这些：`-X/--request`、`-L/--location`、`--compressed`、`--url`、
 *   `-H/--header`、`-I/--head`、`-b/--cookie`、`-u/--user`、
 *   `-d/--data/--data-ascii/--data-binary/--data-raw/--data-urlencode`；
 *   名单外的旗标只跳过自己，紧跟其后的值会被当成位置参数，而第一个位置参数就是 URL。
 *   `--data-urlencode` 也在名单里，但取的是原文，这一段不做 URL 编码。
 * @description 命令行先并续行、把两个以上空白压成一个，再按引号切词。
 *   切词只管引号与转义，不展开变量、不执行 shell：URL 与正文要原样交给后面变量替换那一趟。
 * @description 三条固定后果：多个 `-d` 用 `&` 连成一段正文；有正文却没写 Content-Type 时
 *   补 `application/x-www-form-urlencoded`；没写方法时有正文按 POST、否则 GET。
 *   `-u` 在这一层就写成 base64 的 Basic 头部，并先丢掉命令行里已有的 Authorization，
 *   免得两个认证头并存。
 */

import type { HttpHeaderEntry } from "./http-request-parser.ts";
import { encodeBase64Utf8 } from "../utils/encoding.ts";

/** curl 解析出来的请求要素；行号由调用方补（整节都算这一条请求）。 */
export type HttpCurlParts = {
  /** 方法（大写）。 */
  method: string;
  /** URL 原文，`{{ }}` 引用未展开。 */
  url: string;
  /** 头部清单，保留命令行里的顺序与原文大小写。 */
  headers: HttpHeaderEntry[];
  /** 请求体原文；`-d @文件` 时是文件引用，交给 bodyFile。 */
  body: string | null;
  /** `-d @路径` 读出来的文件引用路径；没有时为 null。 */
  bodyFile: string | null;
};

/** 值型短选项：后面必须跟一个值（可以紧贴也可以空一格）。 */
const VALUE_SHORT_FLAGS: ReadonlySet<string> = new Set(["X", "H", "b", "u", "d"]);

/** 值型长选项（不含前置 `--`）。 */
const VALUE_LONG_FLAGS: ReadonlySet<string> = new Set([
  "request",
  "header",
  "cookie",
  "user",
  "data",
  "data-ascii",
  "data-binary",
  "data-raw",
  "data-urlencode",
  "url",
]);

/**
 * 是否 curl 命令的起头行。
 * @param line 行原文
 * @returns 以 `curl` 起头（忽略前导空白、大小写不敏感）时 true
 */
export function isCurlCommandLine(line: string): boolean {
  return /^\s*curl\b/i.test(String(line ?? ""));
}

/** 续行反斜杠并进一行、两个以上空白压成一个；切词只在单行上做，续行不改变语义。 */
function mergeToSingleLine(text: string): string {
  return String(text ?? "")
    .replace(/\\\r|\\\n/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * 按引号切词。
 * @param text 单行命令
 * @returns 词序列；双引号内的 `\$`、`\\"`、`\\` 按 shell 习惯还原，单引号内一律原文
 * @description 不用 eval、不展开变量：正文里的 `{{ }}` 与 `$` 必须原样留着，
 *   变量替换是后面那一趟的事，在这里展开会把「同一份文件两次解析得到不同结果」变成常态。
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      quoted = true;
      started = true;
      continue;
    }
    if (char === "'") {
      // 单引号内反斜杠不是转义符，整段原文照收（shell 语义）。
      const close = text.indexOf("'", index + 1);
      if (close === -1) {
        current += text.slice(index + 1);
        started = true;
        break;
      }
      current += text.slice(index + 1, close);
      started = true;
      index = close;
      continue;
    }
    if (quoted && char === "\\" && (text[index + 1] === '"' || text[index + 1] === "\\" || text[index + 1] === "$")) {
      current += text[index + 1];
      index += 1;
      continue;
    }
    if (char === " " && !quoted) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** 解析一个 `-H` 值：按第一个冒号切成 `名: 值`；没有冒号时整串当名字、值为空串。 */
function splitHeader(raw: string): { name: string; value: string } {
  const text = String(raw ?? "").trim();
  const colon = text.indexOf(":");
  if (colon === -1) return { name: text, value: "" };
  return { name: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim() };
}

/**
 * 解析一条 curl 命令。
 * @param text 整段 curl 命令（可含 `\` 续行）
 * @returns 方法 / URL / 头部 / 正文；解析不出 URL 时 url 为空串，由调用方按「地址为空」处理
 * @description 同名头部合并成一条：Cookie 用 `;` 相接、其余用 `,`，名字与位置都按首次出现那一次留。
 */
export function parseCurlCommand(text: string): HttpCurlParts {
  const tokens = tokenize(mergeToSingleLine(text));
  const headers: HttpHeaderEntry[] = [];
  const dataParts: string[] = [];
  const positionals: string[] = [];
  let method: string | null = null;
  let cookie: string | null = null;
  let user: string | null = null;
  let urlFromFlag: string | null = null;

  const pushHeader = (raw: string) => {
    const { name, value } = splitHeader(raw);
    if (!name) return;
    const key = name.toLowerCase();
    const existing = headers.find((header) => header.name.toLowerCase() === key);
    if (!existing) {
      headers.push({ name, value, line: -1 });
      return;
    }
    existing.value = `${existing.value}${key === "cookie" ? ";" : ","}${value}`;
  };

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    // 长选项的三种给值写法都收：`--name=value`、`--name: value`、`--name` 后面单列一个值。
    const long = /^--([^=:\s]+)(?:[=:]([\s\S]*))?$/.exec(token);
    if (long) {
      const name = long[1];
      const inline = long[2] === undefined || long[2] === "" ? undefined : long[2].replace(/^\s/, "");
      if (VALUE_LONG_FLAGS.has(name)) {
        const value = inline !== undefined ? inline : tokens[index + 1] ?? "";
        if (inline === undefined) index += 1;
        if (name === "request") method = value;
        else if (name === "header") pushHeader(value);
        else if (name === "cookie") cookie = value;
        else if (name === "user") user = value;
        else if (name === "url") urlFromFlag = value;
        else dataParts.push(value);
        continue;
      }
      if (name === "location" || name === "compressed") {
        // `--location`、`--compressed` 只是开关，不影响发出去的请求；写成 `--名字=值` 时这个值才被当作地址。
        if (inline !== undefined) urlFromFlag = inline;
        continue;
      }
      if (name === "head") method = "HEAD";
      continue;
    }
    const short = /^-([^-])(.*)$/.exec(token);
    if (short) {
      const flag = short[1];
      const rest = short[2];
      if (VALUE_SHORT_FLAGS.has(flag)) {
        const value = rest ? rest : tokens[index + 1] ?? "";
        if (!rest) index += 1;
        if (flag === "X") method = value;
        else if (flag === "H") pushHeader(value);
        else if (flag === "b") cookie = value;
        else if (flag === "u") user = value;
        else dataParts.push(value);
        continue;
      }
      if (flag === "L") {
        if (rest) urlFromFlag = rest;
        continue;
      }
      if (flag === "I") method = "HEAD";
      continue;
    }
    positionals.push(token);
  }

  const url = String(positionals[0] || urlFromFlag || "").trim();
  let body: string | null = null;
  let bodyFile: string | null = null;
  if (dataParts.length) {
    const joined = dataParts.join("&");
    if (joined.startsWith("@")) bodyFile = joined.slice(1);
    else body = joined;
  }
  if (cookie && cookie.includes("=")) pushHeader(`Cookie: ${cookie}`);
  if (user) {
    const existing = headers.findIndex((header) => header.name.toLowerCase() === "authorization");
    // 必须判 -1：`splice(-1, 1)` 删的是最后一项，会把用户写的最后一个头部悄悄吞掉。
    if (existing >= 0) headers.splice(existing, 1);
    headers.push({ name: "Authorization", value: `Basic ${encodeBase64Utf8(user)}`, line: -1 });
  }
  // 空串正文按「没有正文」处理：`-d ''` 既不补 Content-Type，也不把方法顶成 POST。
  const hasBody = (body !== null && body !== "") || bodyFile !== null;
  if (hasBody && !headers.some((header) => header.name.toLowerCase() === "content-type")) {
    pushHeader("Content-Type: application/x-www-form-urlencoded");
  }
  const finalMethod = String(method || (hasBody ? "POST" : "GET")).toUpperCase();
  return { method: finalMethod, url, headers, body, bodyFile };
}
