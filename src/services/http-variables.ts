/**
 * HTTP 变量解析服务 (src/services/http-variables.ts)
 * @description 把 `{{ ... }}` 引用换成实际值。取用顺序是先命中先返回：
 *   `# @prompt` 填的值 → 系统变量（`$…`）→ 请求变量（`name.request…` / `name.response…`）→ 文件变量 → 环境变量，
 *   解析不出来的引用原样回传 `{{x}}`，同时把名字报给调用方，
 *   界面才能说清「这几处没换值」而不是静默发一个花括号出去。
 * @description 要碰宿主外部世界的系统变量，本宿主拿不到就不实现而不是假装实现：
 *   `$processEnv`（渲染进程没有 process.env，连 `%` 间接那一跳的落点也在 OS 上）、
 *   `$aadToken` / `$aadV2Token` / `$oidcAccessToken`（设备码交互与本地回调服务）。
 *   `$dotenv` 能做到：读的是项目里的 `.env`，由调用方先读进来再交给我们（见 http-env.ts）。
 *   `$datetime` / `$localDatetime` 的自定义格式串是 dayjs token 语义，
 *   这里不引依赖、只实现那份 token 的常用子集，认不出的 token 原样留在输出里。
 * @description 取值口径：JSONPath 与 XPath 都**只取第一个命中**，不做多命中拼接；
 *   路径落空回空串（值为空），引用本身取不到才报未解析。
 */

import { selectFirstByXPath } from "./http-xml.ts";

/** 一个已发送请求的最近响应（请求变量的取值来源）。 */
export type HttpResponseRecord = {
  /** 状态码（如 200）；请求变量只取正文与头部，不读它。 */
  status: number;
  /** 状态文本。 */
  statusText: string;
  /** 响应头，键为宿主回传的原始大小写；查找时大小写不敏感。 */
  headers: Record<string, string>;
  /** 响应正文文本。 */
  body: string;
};

/** 一次已发送请求的请求侧快照（`{{name.request....}}` 的取值来源）。 */
export type HttpRequestRecord = {
  /** 方法（大写）。 */
  method: string;
  /** 最终发出去的 URL（变量已展开）。 */
  url: string;
  /** 最终请求头。 */
  headers: Record<string, string>;
  /** 最终请求体文本；没有请求体时为 null。 */
  body: string | null;
};

/** 解析器可用的时钟与随机源，测试注入固定值才能断言生成型变量。 */
export type HttpVariableRandomizers = {
  /** 取当前时间；缺省用 new Date()。 */
  now?: () => Date;
  /** 生成 uuid；缺省用 crypto.randomUUID，宿主不可用时该变量报未解析。 */
  uuid?: () => string;
  /** 取 [min, max) 的整数；缺省用 Math.random。 */
  randomInt?: (min: number, max: number) => number;
};

/** 一次解析所需的全部变量来源。 */
export type HttpVariableScope = {
  /** 文件变量表（`@name = value`），值里的引用在解析时递归展开。 */
  fileVariables: ReadonlyMap<string, string>;
  /** 环境变量表（当前环境与 `$shared` 合并后的那份）；本插件的来源见 http-env.ts。 */
  environment?: ReadonlyMap<string, string>;
  /** `.env` 表；`{{$dotenv x}}` 从这里取，没给视为项目里没有 .env 文件。 */
  dotenv?: ReadonlyMap<string, string>;
  /** 会话内按 `# @name` 缓存的最近响应；没发过的请求变量按未解析处理。 */
  responses?: ReadonlyMap<string, HttpResponseRecord>;
  /** 会话内按 `# @name` 缓存的最近请求侧快照；与 responses 同键，供 `{{name.request....}}` 取值。 */
  requests?: ReadonlyMap<string, HttpRequestRecord>;
  /** `# @prompt` 由用户填进来的值。 */
  prompts?: ReadonlyMap<string, string>;
  /** 时钟与随机源。 */
  randomizers?: HttpVariableRandomizers;
};

/** 变量解析过程中的一条告警。 */
export type HttpVariableWarning = {
  /**
   * 告警种类：
   * `varNoResponse` 请求变量还没发过 / `varTooDeep` 变量链套得太深 /
   * `varNoDotenv` 项目里没有 .env 文件 / `varNoDotenvKey` .env 里没有这个键 /
   * `varUnsupported` 引用的是本宿主拿不到的外部态（`$processEnv`、`$aadToken` 一族）
   */
  code: "varNoResponse" | "varTooDeep" | "varNoDotenv" | "varNoDotenvKey" | "varUnsupported";
  /** 涉及的变量名。 */
  name: string;
};

/** resolveHttpVariables 的返回。 */
export type HttpResolvedText = {
  /** 替换后的文本；未解析的引用保持 `{{x}}` 原样。 */
  value: string;
  /** 未能解析的引用名（去重）；空数组表示全部换成功。 */
  unresolved: string[];
  /**
   * 解析过程中的告警（如请求变量还没发过）。
   * @description 这里只说「哪一类问题、哪个名字」，不拼面向用户的句子：
   *   解析层是纯函数、不知道界面语言，之前写死的中文会原样出现在英文/繁中界面上。
   */
  warnings: HttpVariableWarning[];
};

/**
 * 文件变量 / 环境变量链的展开深度上限。
 * @description 变量值里的引用要再展开，这条路径本质是递归的（成环由 trail 拦住，
 *   但长度上千的链仍会把调用栈打穿）。超限按未解析处理并在界面点名，不做静默截断。
 */
const MAX_VARIABLE_DEPTH = 32;

/** 引用正则：`{{ ... }}`，中间不含花括号；一次只匹配第一个引用，替换由外层逐个推进。 */
const REFERENCE = /\{\{([^{}]*)\}\}/;

/** 时间偏移单位表：`y Q M w d h m s ms`；年与季按历法加月，其余换算成毫秒位移。 */
const OFFSET_UNITS: ReadonlyMap<string, (amount: number, date: Date) => Date> = new Map([
  ["y", (amount, date) => addMonths(date, amount * 12)],
  ["Q", (amount, date) => addMonths(date, amount * 3)],
  ["M", (amount, date) => addMonths(date, amount)],
  ["w", (amount, date) => addMillis(date, amount * 7 * 86400000)],
  ["d", (amount, date) => addMillis(date, amount * 86400000)],
  ["h", (amount, date) => addMillis(date, amount * 3600000)],
  ["m", (amount, date) => addMillis(date, amount * 60000)],
  ["s", (amount, date) => addMillis(date, amount * 1000)],
  ["ms", (amount, date) => addMillis(date, amount)],
]);

/** 时间戳正则：`$timestamp [偏移 单位]`，偏移与单位成对出现，取的是秒。 */
const TIMESTAMP = /^\$timestamp(?:\s+(-?\d+)\s+(y|Q|M|w|d|h|m|s|ms))?$/;

/**
 * 日期时间正则：`$local?Datetime 格式 [偏移 单位]`。
 * @description 格式位三档：`rfc1123`、`iso8601`、引号包裹的自定义串（单双引号都行）。
 *   `$datetime` 与 `$localDatetime` 的大写 D 两种拼法都收，免得同一份文件里一半能解析一半不能。
 */
const DATETIME =
  /^\$(local)?[Dd]atetime\s+(rfc1123|iso8601|"([^"\n]*)"|'([^'\n]*)')(?:\s+(-?\d+)\s+(y|Q|M|w|d|h|m|s|ms))?$/;

/** 随机整数正则：`$randomInt 最小 最大`，两数都要有，且要求 min < max（不满足按未解析处理）。 */
const RANDOM_INT = /^\$randomInt\s+(-?\d+)\s+(-?\d+)$/;

/** `.env` 引用正则：`$dotenv [%]键名`，键名字符集 `[\w-.]`；`%` 表示先经环境变量一跳。 */
const DOTENV = /^\$dotenv\s+(%?)([\w.-]+)$/;

/**
 * 本宿主拿不到的外部态。
 * @description 系统变量一共 10 个，本宿主拿不到的是这 4 个；列进表里而不是静默「解析不出」，
 *   界面才能说清「这个变量是宿主做不到，不是你写错了」：
 *   `$processEnv` 要读 OS 环境变量，渲染进程没有（`%` 间接那一跳的落点也在 OS 上）；
 *   三个 token 变量要设备码交互与本地回调端口。
 */
const UNSUPPORTED_SYSTEM_VARIABLES: readonly string[] = Object.freeze([
  "$processEnv",
  "$aadToken",
  "$aadV2Token",
  "$oidcAccessToken",
]);

/** 请求变量路径正则：至少点一层（`.request` / `.response`）才算请求变量引用。 */
const REQUEST_VARIABLE = /^(\w+)\.(request|response)(?:\.(body|headers)(?:\.(.*))?)?$/;

/** 强制按某一种正文格式取值的前缀：`asJson.` / `asXml.`，剥掉前缀剩下的才是路径。 */
const FORCE_JSON_PREFIX = "asJson.";
const FORCE_XML_PREFIX = "asXml.";

/** RFC 1123 的星期与月份缩写：英文三字母固定写死，不随界面语言变。 */
const RFC1123_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RFC1123_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** 两位补零。 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 本地时区偏移的正负号；东八区是 `+`，UTC 本地下也是 `+`。 */
function zoneSign(date: Date): string {
  return -date.getTimezoneOffset() >= 0 ? "+" : "-";
}

/**
 * 本地时区偏移的数字部分。
 * @param date 时刻
 * @param separator 两位之间的分隔符，`":"` 排出 `08:00`，缺省排出 `0800`
 * @returns 不含符号的数字串
 */
function zoneDigits(date: Date, separator = ""): string {
  const abs = Math.abs(-date.getTimezoneOffset());
  const hours = pad2(Math.floor(abs / 60));
  const minutes = pad2(abs % 60);
  return separator ? `${hours}${separator}${minutes}` : `${hours}${minutes}`;
}

/**
 * 按 RFC 1123 的 UTC 形态排一个时刻，`{{$datetime rfc1123}}` 走的是这一档。
 * @param date 时刻
 * @returns 形如 `Wed, 06 Oct 2026 12:34:56 GMT` 的字符串
 * @description 只排 UTC、尾缀写 `GMT`：`$localDatetime rfc1123` 要的是本地时区尾缀
 *   `+0800` 而不是 `GMT+0800`，那一档交给 token 排版（`ddd, DD MMM YYYY HH:mm:ss ZZ`）。
 */
function formatRfc1123Utc(date: Date): string {
  return `${RFC1123_WEEKDAYS[date.getUTCDay()]}, ${pad2(date.getUTCDate())} ${RFC1123_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad2(
    date.getUTCHours(),
  )}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())} GMT`;
}

/** ISO 8601 的本地时区尾缀，形如 `+08:00`；本机就是 UTC 时写 `Z`。 */
function localIsoOffset(date: Date): string {
  if (date.getTimezoneOffset() === 0) return "Z";
  return `${zoneSign(date)}${zoneDigits(date, ":")}`;
}

/** 月份全名（dayjs token 的 `MMMM`）：英文写死，不随界面语言变。 */
const LONG_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** 星期全名（dayjs 的 dddd）。 */
const LONG_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** dayjs 格式 token 表；长 token 必须排在短 token 前面，否则 `YYYY` 会被 `YY` 吃掉一位。 */
const FORMAT_TOKENS: ReadonlyMap<string, (date: Date, utc: boolean) => string> = new Map([
  ["YYYY", (d, utc) => String(utc ? d.getUTCFullYear() : d.getFullYear())],
  ["YY", (d, utc) => String(utc ? d.getUTCFullYear() : d.getFullYear()).slice(-2)],
  ["MMMM", (d, utc) => LONG_MONTHS[utc ? d.getUTCMonth() : d.getMonth()]],
  ["MMM", (d, utc) => RFC1123_MONTHS[utc ? d.getUTCMonth() : d.getMonth()]],
  ["MM", (d, utc) => pad2((utc ? d.getUTCMonth() : d.getMonth()) + 1)],
  ["M", (d, utc) => String((utc ? d.getUTCMonth() : d.getMonth()) + 1)],
  ["dddd", (d, utc) => LONG_WEEKDAYS[utc ? d.getUTCDay() : d.getDay()]],
  ["ddd", (d, utc) => RFC1123_WEEKDAYS[utc ? d.getUTCDay() : d.getDay()]],
  ["DD", (d, utc) => pad2(utc ? d.getUTCDate() : d.getDate())],
  ["D", (d, utc) => String(utc ? d.getUTCDate() : d.getDate())],
  ["HH", (d, utc) => pad2(utc ? d.getUTCHours() : d.getHours())],
  ["H", (d, utc) => String(utc ? d.getUTCHours() : d.getHours())],
  ["hh", (d, utc) => pad2(((utc ? d.getUTCHours() : d.getHours()) + 11) % 12 + 1)],
  ["h", (d, utc) => String(((utc ? d.getUTCHours() : d.getHours()) + 11) % 12 + 1)],
  ["mm", (d, utc) => pad2(utc ? d.getUTCMinutes() : d.getMinutes())],
  ["m", (d, utc) => String(utc ? d.getUTCMinutes() : d.getMinutes())],
  ["ss", (d, utc) => pad2(utc ? d.getUTCSeconds() : d.getSeconds())],
  ["s", (d, utc) => String(utc ? d.getUTCSeconds() : d.getSeconds())],
  ["SSS", (d, utc) => String((utc ? d.getUTCMilliseconds() : d.getMilliseconds()) + 1000).slice(1)],
  ["A", (d, utc) => ((utc ? d.getUTCHours() : d.getHours()) < 12 ? "AM" : "PM")],
  ["a", (d, utc) => ((utc ? d.getUTCHours() : d.getHours()) < 12 ? "am" : "pm")],
  ["Q", (d, utc) => String(Math.floor(((utc ? d.getUTCMonth() : d.getMonth()) + 3) / 3))],
  // 时区尾缀两档：`Z` 带冒号（+08:00），`ZZ` 不带（+0800）；UTC 下分别是 +00:00 与 +0000。
  ["ZZ", (d, utc) => (utc ? "+0000" : `${zoneSign(d)}${zoneDigits(d)}`)],
  ["Z", (d, utc) => (utc ? "+00:00" : `${zoneSign(d)}${zoneDigits(d, ":")}`)],
]);

/** token 匹配用的正则：候选顺序与上表一致（长 token 优先）。 */
const FORMAT_TOKEN_PATTERN = new RegExp(
  `\\[[^\\]]*\\]|${[...FORMAT_TOKENS.keys()].join("|")}`,
  "g"
);

/**
 * 按 dayjs 的常用 token 排一个时刻。
 * @param date 时刻
 * @param format 格式串（`{{$datetime 'YYYY-MM-DD'}}` 引号里那一段）
 * @param utc 是否按 UTC 排
 * @returns 排好的字符串
 * @description 支持上表那二十来个 token 与 `[原文]`；其余字符原样留着。
 *   本插件不引 dayjs，只实现上表这一份 token；认不出的 token 不猜——用户从输出上就能看出没换。
 */
function formatWithTokens(date: Date, format: string, utc: boolean): string {
  return String(format ?? "").replace(FORMAT_TOKEN_PATTERN, (token) => {
    if (token.startsWith("[")) return token.slice(1, -1);
    const apply = FORMAT_TOKENS.get(token);
    return apply ? apply(date, utc) : token;
  });
}

/** 偏移量按历法加月：先把日序置 1 再加月，日序超出目标月长度时钳到月末。 */
function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next;
}

/** 偏移量按毫秒加：单位换算成毫秒后直接位移，时区无关。 */
function addMillis(date: Date, millis: number): Date {
  return new Date(date.getTime() + millis);
}

/** 取偏移后的时刻；没写偏移就是当下。 */
function shifted(now: Date, offset: string | undefined, unit: string | undefined): Date {
  if (!offset || !unit) return now;
  const apply = OFFSET_UNITS.get(unit);
  if (!apply) return now;
  return apply(Number(offset), now);
}

/**
 * 这个引用是不是「不用本文件定义」的那类（系统变量 / 请求变量）。
 * @param reference 引用原文（不含外层花括号，可带 `%` 编码前缀）
 * @returns 系统变量或请求变量时为 true
 * @description 界面要提示「哪些变量在本文件里没定义」，就得先能把这两类摘出去：
 *   它们本来就不该在文件里有定义，否则每个用了请求变量的正常文件都会常驻一条假警告。
 */
export function isBuiltinVariableReference(reference: string): boolean {
  const name = String(reference || "").replace(/^%/, "").trim();
  if (!name) return false;
  return name.startsWith("$") || REQUEST_VARIABLE.test(name);
}

/**
 * 引用里哪些名字哪张表都没有值。
 * @param references `{{...}}` 引用原文集合（可带 `%` 编码前缀）
 * @param defined 已经有值的名字集合：文件变量、当前环境的键、`# @prompt` 声明的名字都并到这里
 * @returns 缺值的名字，按出现顺序去重
 * @description 系统变量与请求变量天生不在任何表里，先摘出去；剩下的名字才谈得上「没定义」。
 *   卡片提示与环境条的引导用的是同一个判断，两处各写一份迟早会给出两个答案。
 */
export function missingVariableNames(references: readonly string[], defined: ReadonlySet<string>): string[] {
  const missing: string[] = [];
  for (const reference of references) {
    if (isBuiltinVariableReference(reference)) continue;
    const name = String(reference || "").replace(/^%/, "").trim();
    if (!name || defined.has(name) || missing.includes(name)) continue;
    missing.push(name);
  }
  return missing;
}

/**
 * 大小写不敏感地取响应头。
 * @param headers 响应头表
 * @param name 要找的头部名
 * @returns 头部值；不存在时为 null
 */
function pickHeader(headers: Record<string, string>, name: string): string | null {
  const key = name.trim().toLowerCase();
  for (const [header, value] of Object.entries(headers || {})) {
    if (header.toLowerCase() === key) return value;
  }
  return null;
}

/**
 * 用 JSONPath 子集从 JSON 文本里取值。
 * @description 支持 `$`、`.name`、`["name"]`、`[0]` 与 `.*`；沿一条路径往下走，
 *   只回第一个命中值，不做通配展开与多命中拼接。
 *   属性/下标名里允许连字符与点（用引号形式）。
 * @param json JSON 文本
 * @param path 选择器；`*` 或空表示整份正文
 * @returns 命中的标量文本；未命中或不是 JSON 时为 null
 */
export function pickJsonValue(json: string, path: string): string | null {
  const selector = String(path || "").trim();
  if (!selector || selector === "*") return json;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const segments = selector
    .replace(/^\$\.?/, "")
    .split(/\.(?![^[]*\])/g)
    .flatMap((segment) => String(segment).match(/\[[^\]]*\]|[^[\]]+/g) || [])
    .map((token) => token.replace(/^\[|\]$/g, "").replace(/^["']|["']$/g, ""));
  let current: unknown = parsed;
  for (const segment of segments) {
    if (!segment || segment === "*") continue;
    if (current === null || typeof current !== "object") return null;
    const record = current as Record<string, unknown>;
    // 必须用 own property 判定：`in` 会走原型链，`$.constructor` / `$.__proto__`
    // 会返回 JS 内置对象而不是「没命中」，用户写错键名反而拿到一串看似成功的垃圾值。
    if (!Object.prototype.hasOwnProperty.call(record, segment)) {
      const index = Number(segment);
      if (!Array.isArray(current) || !Number.isInteger(index) || index < 0 || index >= current.length) return null;
      current = current[index];
      continue;
    }
    current = record[segment];
  }
  if (current === null || current === undefined) return null;
  return typeof current === "object" ? JSON.stringify(current) : String(current);
}

/**
 * 解析系统变量。
 * @param name 引用原文（已 trim，含 `$`）
 * @param scope 变量作用域
 * @param warn 过程信息回报（种类 + 变量名）
 * @returns 值；无法解析时为 null
 */
function resolveSystemVariable(
  name: string,
  scope: HttpVariableScope,
  warn: (code: HttpVariableWarning["code"], name: string) => void
): string | null {
  const random = scope.randomizers || {};
  const clock = random.now ? random.now() : new Date();

  if (UNSUPPORTED_SYSTEM_VARIABLES.some((prefix) => name === prefix || name.startsWith(`${prefix} `))) {
    warn("varUnsupported", name);
    return null;
  }

  if (name === "$guid") {
    if (random.uuid) return random.uuid();
    // 必须按 `crypto.randomUUID()` 的写法调用：把方法从 crypto 上摘下来单独调，
    // Node 抛 ERR_INVALID_THIS、浏览器抛 Illegal invocation——一份写了 {{$guid}} 的文件会当场崩。
    if (typeof globalThis.crypto?.randomUUID !== "function") return null;
    return globalThis.crypto.randomUUID();
  }

  const timestamp = TIMESTAMP.exec(name);
  if (timestamp) {
    const [, offset, unit] = timestamp;
    return String(Math.floor(shifted(clock, offset, unit).getTime() / 1000));
  }

  const datetime = DATETIME.exec(name);
  if (datetime) {
    const [, local, format, doubleQuoted, singleQuoted, offset, unit] = datetime;
    const target = shifted(clock, offset, unit);
    // `$datetime` 恒按 UTC 排，`$localDatetime` 按本地时区排。
    const utc = !local;
    if (format === "iso8601") {
      if (local) {
        // 本地墙上时间写成 ISO 形态：把时区偏移折进毫秒再按 UTC 排，尾缀换成实际偏移。
        const asUtc = new Date(target.getTime() - target.getTimezoneOffset() * 60000);
        return asUtc.toISOString().replace(/Z$/, localIsoOffset(target));
      }
      return target.toISOString();
    }
    if (format === "rfc1123") {
      // 这两档的尾缀形状不同：本地那档是 `+0800`，UTC 那档是 `GMT`，不能共用一套排版。
      if (local) return formatWithTokens(target, "ddd, DD MMM YYYY HH:mm:ss ZZ", false);
      return formatRfc1123Utc(target);
    }
    return formatWithTokens(target, doubleQuoted ?? singleQuoted ?? "", utc);
  }

  const randomInt = RANDOM_INT.exec(name);
  if (randomInt) {
    const min = Number(randomInt[1]);
    const max = Number(randomInt[2]);
    if (!(min < max)) return null;
    if (random.randomInt) return String(random.randomInt(min, max));
    return String(Math.floor(Math.random() * (max - min)) + min);
  }

  const dotenv = DOTENV.exec(name);
  if (dotenv) {
    const [, indirect, key] = dotenv;
    if (!scope.dotenv || scope.dotenv.size === 0) {
      warn("varNoDotenv", key);
      return null;
    }
    let lookupKey = key;
    if (indirect === "%") {
      // `%` 是两级跳转：先把 key 当环境变量的键查值，再用那个值当 .env 里的键名。
      const mapped = scope.environment?.get(key);
      if (mapped === undefined) {
        warn("varNoDotenvKey", key);
        return null;
      }
      lookupKey = mapped;
    }
    const value = scope.dotenv.get(lookupKey);
    if (value === undefined) {
      warn("varNoDotenvKey", lookupKey);
      return null;
    }
    return value;
  }

  return null;
}

/** 取 MIME 主类型（丢掉 `; boundary=...`、`; charset=utf-8` 这类参数），统一小写比较。 */
export function mimeTypeOf(contentType: string): string {
  return String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

/** 正文像 JSON 吗：只在首字符是 `{` / `[` 时才真去 parse 一次，别给每段正文都付一次全文扫描。 */
function looksLikeJson(body: string): boolean {
  const head = String(body ?? "").trimStart();
  if (!head.startsWith("{") && !head.startsWith("[")) return false;
  try {
    JSON.parse(head);
    return true;
  } catch {
    return false;
  }
}

/** 正文像 XML 吗：首字符是 `<`（`<?xml`、`<!DOCTYPE` 与根元素都算）。 */
function looksLikeXml(body: string): boolean {
  return String(body ?? "").trimStart().startsWith("<");
}

/**
 * 按 Content-Type 与 `asJson.` / `asXml.` 前缀从一侧正文里取值。
 * @param body 正文原文
 * @param contentType 该侧的 Content-Type（没有时空串）
 * @param selector 引用里点出来的路径，可能带强制格式前缀
 * @returns 文本值；路径落空时为空串（调用方按「已解析但为空」处理）
 * @description 判定顺序：先看 JSON（或写了 asJson.），再看 XML（或写了 asXml.）。
 *   格式由谁说了算没有硬要求：**Content-Type 说不出格式时按正文长相猜**
 *   （宿主代发通道不保证回头部，而 `# @name` 之后引用自己刚发出去的 JSON 正文是最常见的用法）。
 *   两种格式都对不上、又写了路径时，把整份正文当值返回，不猜路径。
 */
function pickBodyValue(body: string, contentType: string, selector: string): string {
  let path = selector;
  let forceJson = false;
  let forceXml = false;
  if (path.startsWith(FORCE_JSON_PREFIX)) {
    forceJson = true;
    path = path.slice(FORCE_JSON_PREFIX.length);
  } else if (path.startsWith(FORCE_XML_PREFIX)) {
    forceXml = true;
    path = path.slice(FORCE_XML_PREFIX.length);
  }
  if (!path || path === "*") return body;
  const mime = mimeTypeOf(contentType);
  const jsonish = forceJson || mime.includes("json") || (!forceXml && !mime.includes("xml") && looksLikeJson(body));
  if (jsonish) return pickJsonValue(body, path) ?? "";
  const xmlish = forceXml || mime.includes("xml") || looksLikeXml(body);
  if (xmlish) return selectFirstByXPath(body, path)?.value ?? "";
  return body;
}

/** 一侧快照（响应或请求）里可取的两部分。 */
type HttpEntitySnapshot = {
  /** 头部表。 */
  headers: Record<string, string>;
  /** 正文文本；没有正文时为 null。 */
  body: string | null;
};

/**
 * 取一个请求变量引用的实际值。
 * @param snapshot 该 `# @name` 请求的最近响应或请求侧快照
 * @param reference 引用原文，形如 `login.response.body.$.token`
 * @returns 文本值；返回 null 表示「这条引用取不到」，调用方按未解析点名
 * @description 正文路径落空时给的是空串（已解析、值为空）；头部名没写、或那个头部不存在，才报取不到。
 */
function requestVariableValue(snapshot: HttpEntitySnapshot, reference: string): string | null {
  const matched = REQUEST_VARIABLE.exec(reference);
  if (!matched) return null;
  const [, , , part, selector] = matched;
  const body = snapshot.body ?? "";
  if (!part || part === "body") {
    return pickBodyValue(body, pickHeader(snapshot.headers, "Content-Type") || "", selector || "*");
  }
  // 只写 `.headers` 不写头部名时，回整个头部对象拼出来就是 `[object Object]`；
  // 这里按「没取到值」处理，让界面点名，而不是把一个没法用的串发出去。
  if (!selector) return null;
  return pickHeader(snapshot.headers, selector);
}

/**
 * 替换一段文本里的全部变量引用。
 * @param text 含 `{{ }}` 引用的原文
 * @param scope 变量作用域
 * @returns 替换结果；引用名解析不出时保留 `{{x}}` 原样并回报
 * @description 文件变量的值本身可以再含引用，递归展开并带环检测：
 *   成环时那一条按未解析处理，而不是无限递归把面板卡死。
 */
export function resolveHttpVariables(text: string, scope: HttpVariableScope): HttpResolvedText {
  const unresolved: string[] = [];
  const warnings: HttpVariableWarning[] = [];
  /** 同名同类告警只留一条：正文里重复 50 处引用不该堆 50 条一样的提示。 */
  const warn = (code: HttpVariableWarning["code"], name: string) => {
    if (!warnings.some((item) => item.code === code && item.name === name)) warnings.push({ code, name });
  };

  const lookup = (reference: string, trail: Set<string>, depth: number): string | null => {
    const name = String(reference || "").trim();
    if (!name || trail.has(name)) return null;
    const percentEncoded = name.startsWith("%");
    const bareName = percentEncoded ? name.slice(1) : name;
    const wrap = (value: string): string => (percentEncoded ? encodeURIComponent(value) : value);

    // `@prompt` 填进来的值优先级最高，压过文件变量与环境变量的同名值。
    if (scope.prompts?.has(bareName)) return wrap(scope.prompts.get(bareName) || "");
    if (bareName.startsWith("$")) {
      const value = resolveSystemVariable(bareName, scope, warn);
      return value === null ? null : wrap(value);
    }
    if (REQUEST_VARIABLE.test(bareName)) {
      const [, name2, side] = Array.from(REQUEST_VARIABLE.exec(bareName) || []);
      // `.request.` 与 `.response.` 两条都有来源：发一条请求同时留下请求侧与响应侧两份快照。
      const snapshot = side === "request" ? scope.requests?.get(name2) : scope.responses?.get(name2);
      if (snapshot) {
        const value = requestVariableValue(snapshot, bareName);
        if (value !== null) return wrap(value);
      } else {
        warn("varNoResponse", name2);
      }
    }
    const rawFile = scope.fileVariables.get(bareName);
    if (rawFile !== undefined) {
      if (depth >= MAX_VARIABLE_DEPTH) {
        // 链套得太深就按未解析处理：这条路径本来就是递归的（变量值里的引用要再展开），
        // 只靠迭代改写挡不住长度上千的变量链把调用栈打穿。
        warn("varTooDeep", bareName);
        return null;
      }
      const nextTrail = new Set(trail);
      nextTrail.add(bareName);
      return wrap(substitute(rawFile, nextTrail, depth + 1));
    }
    const environmentValue = scope.environment?.get(bareName);
    if (environmentValue !== undefined) {
      if (depth >= MAX_VARIABLE_DEPTH) {
        warn("varTooDeep", bareName);
        return null;
      }
      const nextTrail = new Set(trail);
      nextTrail.add(bareName);
      return wrap(substitute(environmentValue, nextTrail, depth + 1));
    }
    return null;
  };

  const substitute = (input: string, trail: Set<string>, depth: number): string => {
    let output = "";
    let rest = input;
    // 逐个吃掉最外层的引用：正文里可能有嵌套花括号（JSON 请求体），一次性全局替换会切错，
    // 故按「切一段、查一个」推进，而不是递归——递归深度曾等于未解析引用个数，
    // 100KB 的正文就能抛 RangeError 穿透到界面。
    // 解析不出来的引用原样留在结果里并推过它继续扫：既不会反复命中同一个引用，
    // 也没有「扫到第 N 个就停手」的静默上限（那会让后半个文件的变量原样发出去）。
    for (;;) {
      const matched = REFERENCE.exec(rest);
      if (!matched) break;
      const head = rest.slice(0, matched.index);
      const reference = matched[1];
      const value = lookup(reference, trail, depth);
      if (value === null) {
        const name = reference.trim();
        // 空引用（`{{}}`）不是变量，别塞进未解析名单让用户去找一个不存在的名字。
        if (name && !unresolved.includes(name)) unresolved.push(name);
        output += head + matched[0];
      } else {
        output += head + value;
      }
      rest = rest.slice(matched.index + matched[0].length);
    }
    return output + rest;
  };

  return { value: substitute(String(text ?? ""), new Set(), 0), unresolved, warnings };
}
