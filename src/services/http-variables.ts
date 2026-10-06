/**
 * HTTP 变量解析服务 (src/services/http-variables.ts)
 * @description 把 `{{ ... }}` 引用换成实际值，替换顺序与上游一致：
 *   系统变量 → 请求变量 → 文件变量 → 环境变量（variableProcessor.ts 的 provider 顺序），
 *   解析不出来的引用原样回传 `{{x}}`（上游同行为），同时把名字报给调用方，
 *   界面才能说清「这几处没换值」而不是静默发一个花括号出去。
 * @description 上游能接的外部态在本宿主拿不到，故不实现而不是假装实现：
 *   `$processEnv` / `$dotenv`（渲染进程没有 process.env）、`$aadToken` / `$aadV2Token` /
 *   `$oidcAccessToken`（设备码交互与本地回调服务）、AWS / Cognito / Digest 认证。
 *   `$datetime` 的自定义格式串依赖 dayjs token 语义，只支持 rfc1123 与 iso8601 两档。
 */

/** 一个已发送请求的最近响应（请求变量的取值来源）。 */
export type HttpResponseRecord = {
  /** 状态码；上游叫 statusCode。 */
  status: number;
  /** 状态文本。 */
  statusText: string;
  /** 响应头，键为宿主回传的原始大小写；查找时大小写不敏感。 */
  headers: Record<string, string>;
  /** 响应正文文本。 */
  body: string;
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
  /** 环境变量表；本插件的来源由调用方决定，缺省视为空。 */
  environment?: ReadonlyMap<string, string>;
  /** 会话内按 `# @name` 缓存的最近响应；没发过的请求变量按未解析处理。 */
  responses?: ReadonlyMap<string, HttpResponseRecord>;
  /** `# @prompt` 由用户填进来的值。 */
  prompts?: ReadonlyMap<string, string>;
  /** 时钟与随机源。 */
  randomizers?: HttpVariableRandomizers;
};

/** 变量解析过程中的一条告警。 */
export type HttpVariableWarning = {
  /** 告警种类：请求变量还没发过 / 只缓存了响应取不到请求快照 / 变量链套得太深。 */
  code: "varNoResponse" | "varRequestSide" | "varTooDeep";
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

/** 引用正则：`{{ ... }}`，与上游 variableReferenceRegex 同形。 */
const REFERENCE = /\{\{([^{}]*)\}\}/;

/** 时间偏移单位表（上游用 dayjs 的 y Q M w d h m s ms）。 */
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

/** 时间戳正则：`$timestamp [偏移 单位]`（上游 timestampRegex）。 */
const TIMESTAMP = /^\$timestamp(?:\s+(-?\d+)\s+(y|Q|M|w|d|h|m|s|ms))?$/;

/** 日期时间正则：`$local?Datetime 格式 [偏移 单位]`；上游把 `$datetime` 与 `$localDatetime` 的 D 大小写写得不一致，这里两个拼法都收。 */
const DATETIME = /^\$(local)?[Dd]atetime\s+(rfc1123|iso8601)(?:\s+(-?\d+)\s+(y|Q|M|w|d|h|m|s|ms))?$/;

/** 随机整数正则：`$randomInt 最小 最大`（两数都要有，上游要求 min < max）。 */
const RANDOM_INT = /^\$randomInt\s+(-?\d+)\s+(-?\d+)$/;

/** 请求变量路径正则：至少点一层才算请求变量引用（上游 requestVariableCacheValueProcessor 同形）。 */
const REQUEST_VARIABLE = /^(\w+)\.(request|response)(?:\.(body|headers)(?:\.(.*))?)?$/;

/** RFC 1123 的星期与月份缩写：上游用 toUTCString / dayjs 输出，这里按同样的字面量排。 */
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

/**
 * 按 RFC 1123 排出一个时刻。
 * @param date 时刻
 * @param utc true 排 UTC（尾缀 GMT），false 排本地时区（尾缀 GMT±HHMM）
 * @returns 形如 `Wed, 06 Oct 2026 12:34:56 GMT` 的字符串
 */
function formatRfc1123(date: Date, utc: boolean): string {
  const parts = utc
    ? {
        weekday: date.getUTCDay(),
        day: date.getUTCDate(),
        month: date.getUTCMonth(),
        year: date.getUTCFullYear(),
        hours: date.getUTCHours(),
        minutes: date.getUTCMinutes(),
        seconds: date.getUTCSeconds(),
      }
    : {
        weekday: date.getDay(),
        day: date.getDate(),
        month: date.getMonth(),
        year: date.getFullYear(),
        hours: date.getHours(),
        minutes: date.getMinutes(),
        seconds: date.getSeconds(),
      };
  const zone = utc ? "GMT" : localZoneSuffix(date);
  return `${RFC1123_WEEKDAYS[parts.weekday]}, ${pad2(parts.day)} ${RFC1123_MONTHS[parts.month]} ${parts.year} ${pad2(
    parts.hours,
  )}:${pad2(parts.minutes)}:${pad2(parts.seconds)} ${zone}`;
}

/** 本地时区偏移尾缀，形如 `GMT+0800`；UTC 本地下就是 `GMT`。 */
function localZoneSuffix(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  if (offsetMinutes === 0) return "GMT";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return `GMT${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
}

/** ISO 8601 的本地时区尾缀，形如 `+08:00`；UTC 本地下是 `Z`。 */
function localIsoOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  if (offsetMinutes === 0) return "Z";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** 偏移量按历法加月：日序超出目标月长度时钳到月末，与 dayjs 的加月行为一致。 */
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
 * @description 支持 `$`、`.name`、`["name"]`、`[0]` 与 `.*`；通配只取第一个命中项，
 *   够请求变量用（上游返回全部命中值再拼接）。属性/下标名里允许连字符与点（用引号形式）。
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
 * @returns 值；无法解析时为 null
 */
function resolveSystemVariable(name: string, scope: HttpVariableScope): string | null {
  const random = scope.randomizers || {};
  const now = (random.now ? random.now() : new Date()).getTime();
  const clock = new Date(now);

  if (name === "$guid") {
    if (random.uuid) return random.uuid();
    const cryptoUuid = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID : null;
    return cryptoUuid ? cryptoUuid() : null;
  }

  const timestamp = TIMESTAMP.exec(name);
  if (timestamp) {
    const [, offset, unit] = timestamp;
    return String(Math.floor(shifted(clock, offset, unit).getTime() / 1000));
  }

  const datetime = DATETIME.exec(name);
  if (datetime) {
    const [, local, format, offset, unit] = datetime;
    const target = shifted(clock, offset, unit);
    if (format === "iso8601") {
      if (local) {
        // 本地墙上时间写成 ISO 形态：把时区偏移折进毫秒再按 UTC 排，得到与 dayjs 本地格式一致的字面量。
        const asUtc = new Date(target.getTime() - target.getTimezoneOffset() * 60000);
        return asUtc.toISOString().replace(/Z$/, localIsoOffset(target));
      }
      return target.toISOString();
    }
    return formatRfc1123(target, !local);
  }

  const randomInt = RANDOM_INT.exec(name);
  if (randomInt) {
    const min = Number(randomInt[1]);
    const max = Number(randomInt[2]);
    if (!(min < max)) return null;
    if (random.randomInt) return String(random.randomInt(min, max));
    return String(Math.floor(Math.random() * (max - min)) + min);
  }

  return null;
}

/**
 * 取一个请求变量引用的实际值。
 * @param record 该 `# @name` 请求的最近响应
 * @param reference 引用原文，形如 `login.response.body.$.token`
 * @returns 文本值；路径落空时返回空串（调用方按「已解析但为空」处理）
 */
function requestVariableValue(record: HttpResponseRecord, reference: string): string {
  const matched = REQUEST_VARIABLE.exec(reference);
  if (!matched) return "";
  const [, , side, part, selector] = matched;
  if (side !== "response") return "";
  if (!part || part === "body") return pickJsonValue(record.body, selector || "*") ?? "";
  return selector ? pickHeader(record.headers, selector) ?? "" : record.body;
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

    // `@prompt` 填进来的值优先级最高（上游 promptVariables 先于全部 provider）。
    if (scope.prompts?.has(bareName)) return wrap(scope.prompts.get(bareName) || "");
    if (bareName.startsWith("$")) {
      const value = resolveSystemVariable(bareName, scope);
      return value === null ? null : wrap(value);
    }
    if (REQUEST_VARIABLE.test(bareName)) {
      const [, name2, side] = Array.from(REQUEST_VARIABLE.exec(bareName) || []);
      const record = scope.responses?.get(name2);
      if (!record) warn("varNoResponse", name2);
      else if (side === "request") warn("varRequestSide", name2);
      else return wrap(requestVariableValue(record, bareName));
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
