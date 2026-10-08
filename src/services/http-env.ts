/**
 * HTTP 环境变量服务 (src/services/http-env.ts)
 * @description 环境的存放位置固定在工作区的插件配置目录里，读两个 JSON 文件：
 *     `<工作区根>/.snow/.snow-file-explorer/env.json`         公开环境表，随仓库走
 *     `<工作区根>/.snow/.snow-file-explorer/env.private.json` 同名覆盖公开表，放密钥、不进版本库
 *   两份文件都是 `{ "环境名": { "变量名": "值" } }` 这一种形状。只认这一处，不做逐层向上查找：
 *   一个项目里有好几份环境表，用户看不出当前用的是哪一份，比少一个层级更麻烦。
 * @description `.env` 同样只读工作区根：选了环境时先试 `.env.<环境名>`，没有再回落到 `.env`。
 * @description 取用规则：
 *   - 保留环境名 `$shared`：其中的变量对所有环境可见，但不出现在可切换清单里
 *   - 当前环境的同名变量覆盖 `$shared`，合并序 `{...shared, ...current}`
 *   - 值里的 `{{$shared 键}}` 与 `{{当前环境名 键}}` 在取用前先就地展开；
 *     匹配用的正则不带 g，所以**一个值里只展开第一处**，后面的引用原样留着
 *   - 没选环境时只有 `$shared` 可见
 * @description 一条边界：展开引用时找不到键，就保留原引用不动，不把 `undefined` 写进值里——
 *   `undefined` 是个看起来像值的假值，会照常发进 URL；留着原引用，
 *   变量解析那一路才会点名「这个引用没换成值」。
 */

/** 保留环境名：这一段里的变量对所有环境可见，名字本身不算可切换的环境。 */
export const SHARED_ENVIRONMENT_NAME = "$shared";

/** 「无环境」档的取值：本插件用空串表示，界面上写作「不选环境」。 */
export const NO_ENVIRONMENT_NAME = "";

/** 插件在工作区里的配置目录：`<根>/.snow/.snow-file-explorer/`，逐层拼出来。 */
export const PLUGIN_CONFIG_DIR_SEGMENTS: readonly string[] = Object.freeze([".snow", ".snow-file-explorer"]);

/** 公开环境表文件名（放在插件配置目录里）。 */
export const ENVIRONMENT_FILE_NAME = "env.json";

/** 私密环境表文件名：同名环境与同名变量都覆盖公开表。 */
export const PRIVATE_ENVIRONMENT_FILE_NAME = "env.private.json";

/**
 * 界面上「创建环境」弹窗交回来的那一份草稿。
 * @description 变量行允许为空（先建环境再填值是一种正常用法）；名字与键的合法性由收集方自己判，
 *   这里只描述形状。
 */
export type HttpEnvironmentDraft = {
  /** 环境名（已经 trim 过）。 */
  name: string;
  /** 变量行，按界面上的顺序。 */
  variables: Array<{ key: string; value: string }>;
};

/**
 * 这个名字能不能当环境名用：空、带 `/`、带 `\`、带 `..` 都不行。
 * @param name 候选名字
 * @returns 合法时 true
 * @description 这个名字会被拼进 `.env.<环境名>` 的读盘路径，而宿主写文件不校验包含性，
 *   所以创建与编辑两头都得先拦这一层，别让一份环境表把读写路径带出项目。
 */
export function isStorableEnvironmentName(name: string): boolean {
  const value = String(name || "");
  return Boolean(value) && !value.includes("/") && !value.includes("\\") && !value.includes("..");
}

/**
 * 拼出插件配置目录的绝对路径。
 * @param rootPath 工作区根
 * @returns `<根>/.snow/.snow-file-explorer`；根为空时返回空串（调用方按「没有项目」处理）
 */
export function pluginConfigDirectory(rootPath: string): string {
  const root = String(rootPath || "");
  if (!root) return "";
  return PLUGIN_CONFIG_DIR_SEGMENTS.reduce((dir, segment) => joinPath(dir, segment), root);
}

/**
 * 把编辑后的环境表序列化回磁盘文本。
 * @param environments 环境名 → 变量表；`$shared` 排在最前，其余按名升序
 * @returns 带结尾换行的 JSON 文本
 * @description GUI 写回走这一条，保证同一份表每次写出的键序稳定（改一个值不该让整份文件 diff 开花）。
 */
export function serializeEnvironmentJson(environments: Map<string, HttpEnvironmentTable>): string {
  const names = [...environments.keys()].sort((a, b) => {
    if (a === SHARED_ENVIRONMENT_NAME) return -1;
    if (b === SHARED_ENVIRONMENT_NAME) return 1;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  });
  const record: Record<string, Record<string, string>> = {};
  for (const name of names) record[name] = Object.fromEntries(environments.get(name) || []);
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** 界面要画的环境概况（由控制器把 store 与当前环境名汇总成这一份）。 */
export type HttpEnvironmentSummary = {
  /** 可切换的环境名（不含 `$shared`）。 */
  names: string[];
  /** 当前环境名；NO_ENVIRONMENT_NAME 表示只用 `$shared`。 */
  active: string;
  /** 环境表里有没有 `$shared` 这一段。 */
  hasShared: boolean;
  /** 当前生效的变量表（已合并共享与环境，值仍是原文引用）。 */
  variables: HttpEnvironmentTable;
  /** 被当前环境覆盖掉的共享变量名。 */
  overriddenShared: string[];
  /** 读到的环境表文件路径；空数组说明项目里还没有。 */
  files: string[];
  /** 环境表该放的位置（`<根>/.snow/.snow-file-explorer`）；没打开项目时为空串。 */
  directory: string;
  /** 两份表合并后的全量环境（含 `$shared`）：界面上「有哪些环境、各自带哪些变量」看这一份。 */
  tables: Map<string, HttpEnvironmentTable>;
  /**
   * 只有公开表的那一份：编辑弹窗摊开的行与删除动作都以它为底。
   * @description 界面上写得回去的只有公开表，合并表里那些来自私密表的值不该被抄回去。
   */
  publicTables: Map<string, HttpEnvironmentTable>;
  /** 私密表里出现过的「环境名/变量名」，这些行改公开表不生效，界面要标出来。 */
  privateKeys: string[];
  /** 解析环境表时留下的问题清单。 */
  issues: HttpEnvironmentIssue[];
  /** `.env` 命中路径；没有时 null。 */
  dotenvPath: string | null;
  /** `.env` 里的键数。 */
  dotenvCount: number;
};

/** 一层环境表：变量名 → 值原文（`{{ }}` 引用未展开）。 */
export type HttpEnvironmentTable = Map<string, string>;

/** 环境表解析过程中的一条问题；只带种类与线索，句子由界面按当前语言拼。 */
export type HttpEnvironmentIssue = {
  /** 问题种类。 */
  code: "invalidJson" | "notObject" | "skippedValue" | "readFailed";
  /** 出问题的文件名（不含目录，界面已经知道是哪个文件）。 */
  file: string;
  /** 涉及的环境名或变量名；没有时为 null。 */
  name: string | null;
};

/** 读齐两套环境表后的结果。 */
export type HttpEnvironmentStore = {
  /** 环境名 → 变量表；`$shared` 也在里面，私密表的同名项已覆盖公开表。 */
  environments: Map<string, HttpEnvironmentTable>;
  /** 私密表自己的原始内容：GUI 要标出「这一项被私密表盖住，改公开表不生效」。 */
  privateTables: Map<string, HttpEnvironmentTable>;
  /**
   * 公开表自己的原始内容：界面上改出来的每一段都只往这一份上叠。
   * @description 写回的是公开表那个文件，所以草稿的底稿必须是公开表的原值。拿合并后的表当底稿，
   *   私密表里的密钥就会被原样抄进随仓库走的那一份。
   */
  publicTables: Map<string, HttpEnvironmentTable>;
  /** 实际读到的文件绝对路径；空数组说明项目里还没有环境表。 */
  files: string[];
  /** 解析问题清单。 */
  issues: HttpEnvironmentIssue[];
};

/** 活动环境算出来的可用变量。 */
export type HttpActiveEnvironment = {
  /** `$shared` 与当前环境合并后的表（当前环境优先）。 */
  variables: HttpEnvironmentTable;
  /** 当前环境名；未选环境时为 NO_ENVIRONMENT_NAME。 */
  environment: string;
  /** 合并后被当前环境盖掉的 `$shared` 键名，界面要说「这几个共享变量被覆盖了」。 */
  overriddenShared: string[];
};

/** 读文件的注入手，缺省用宿主通道；测试与 SSH 工作区都靠它替身。 */
type ReadText = (path: string) => Promise<string | null>;

/** 把宿主读到的 content 收成字符串；二进制与读失败一律按 null（调用方按「没有这个文件」处理）。 */
async function readTextDefault(path: string): Promise<string | null> {
  // 延迟引入：本模块被纯函数测试直接引用时不该拉进整个文件服务与 window.snow 依赖。
  const { readFileContent } = await import("./file-service.ts");
  const result = await readFileContent(path);
  if (!result || typeof result.content !== "string" || result.isBinary) return null;
  return result.content;
}

/**
 * 解析一份环境表 JSON。
 * @param text 文件全文
 * @param file 文件名，只用于问题清单里指认出处
 * @returns 环境名 → 变量表；JSON 不合法时得到空表加一条问题
 * @description 值只收字符串、数字与布尔（数字转字符串）；对象、数组与 null 逐个跳过并登记，
 *   因为变量最终要拼进 URL 与头部，把一个对象悄悄变成 `[object Object]` 比报错更难查。
 */
export function parseEnvironmentJson(text: string, file: string): { environments: Map<string, HttpEnvironmentTable>; issues: HttpEnvironmentIssue[] } {
  const environments = new Map<string, HttpEnvironmentTable>();
  const issues: HttpEnvironmentIssue[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(text ?? ""));
  } catch {
    issues.push({ code: "invalidJson", file, name: null });
    return { environments, issues };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    issues.push({ code: "notObject", file, name: null });
    return { environments, issues };
  }
  for (const [environmentName, rawEnvironment] of Object.entries(parsed as Record<string, unknown>)) {
    if (!rawEnvironment || typeof rawEnvironment !== "object" || Array.isArray(rawEnvironment)) {
      issues.push({ code: "notObject", file, name: environmentName });
      continue;
    }
    const table: HttpEnvironmentTable = new Map();
    for (const [key, value] of Object.entries(rawEnvironment as Record<string, unknown>)) {
      if (typeof value === "string") table.set(key, value);
      else if (typeof value === "number" || typeof value === "boolean") table.set(key, String(value));
      else issues.push({ code: "skippedValue", file, name: `${environmentName}.${key}` });
    }
    environments.set(environmentName, table);
  }
  return { environments, issues };
}

/** 把覆盖表并进被覆盖表（同名环境内同名变量后者胜）。 */
function mergeTables(base: Map<string, HttpEnvironmentTable>, override: Map<string, HttpEnvironmentTable>): void {
  for (const [environmentName, table] of override) {
    const target = base.get(environmentName);
    if (!target) {
      base.set(environmentName, new Map(table));
      continue;
    }
    for (const [key, value] of table) target.set(key, value);
  }
}

/**
 * 就地把表里每个值的第一处 `{{引用}}` 换成 lookup 给的值；正则不带 g，一个值里只展开最前面那一处。
 * @param environment 用来拼引用名的环境标签：`$shared` 那一路传 `shared`（`$` 由正则补上，
 *   所以传的是去掉 `$` 的名字、匹配到的却是 `{{$shared x}}`），命名环境那一路传环境名本身。
 */
function mapFirstReference(table: HttpEnvironmentTable, environment: string, lookup: HttpEnvironmentTable): void {
  const pattern = new RegExp(`\\{{2}\\$${environment} (.+?)\\}{2}`);
  for (const [key, value] of table) {
    const matched = pattern.exec(value);
    if (!matched) continue;
    const replacement = lookup.get(matched[1].trim());
    // 找不到键时保留原引用：`undefined` 是个看起来像值的假值，会照常拼进 URL；
    // 原引用留着，变量解析那一路才会把它列进未解析名单。
    if (replacement === undefined) continue;
    table.set(key, value.slice(0, matched.index) + replacement + value.slice(matched.index + matched[0].length));
  }
}

/**
 * 算出当前环境可用的变量表。
 * @param store 读齐的环境表
 * @param activeName 活动环境名；NO_ENVIRONMENT_NAME 表示不选环境
 * @returns 合并结果与被覆盖的共享键
 * @description 映射按固定顺序跑三趟：先解共享表里的 `{{$shared x}}`，再解当前表里的 `{{$shared x}}`，
 *   最后解当前表里的 `{{本环境名 x}}`（没选环境时这一趟跳过）。顺序不能换，后两趟读的必须是
 *   前两趟已经展开过的值。返回的表是**新表**，不改 store 里的原表——切环境来回切不能把值越换越短。
 */
export function resolveActiveEnvironment(store: HttpEnvironmentStore, activeName: string): HttpActiveEnvironment {
  const shared = new Map(store.environments.get(SHARED_ENVIRONMENT_NAME) || []);
  const current = new Map(store.environments.get(activeName) || []);
  mapFirstReference(shared, "shared", shared);
  mapFirstReference(current, "shared", shared);
  if (activeName && activeName !== NO_ENVIRONMENT_NAME) mapFirstReference(current, activeName, current);
  const overriddenShared = [...current.keys()].filter((key) => shared.has(key));
  return {
    variables: new Map([...shared, ...current]),
    environment: activeName === NO_ENVIRONMENT_NAME ? NO_ENVIRONMENT_NAME : activeName,
    overriddenShared,
  };
}

/**
 * 取环境表里出现过的全部环境名（不含 `$shared`），按名升序。
 * @param store 环境表
 * @returns 可切换的环境名清单
 */
export function listEnvironmentNames(store: HttpEnvironmentStore): string[] {
  return [...store.environments.keys()]
    .filter((name) => name !== SHARED_ENVIRONMENT_NAME)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

/**
 * 解析 `.env` 文本（dotenv 的形状）。
 * @param text 文件全文
 * @returns 键 → 值；重复键后定义覆盖先定义
 * @description 认这些形状：`K=V`、`export K=V`、单双引号包裹（双引号里还原 `\n`、`\t`、`\"`）、
 *   `#` 起头的注释行、行尾注释、空值。引号值可以跨行，闭合引号之前的换行原样留在值里。
 *   不做变量插值：`${OTHER}` 原样留着，键与键之间不互相引用，这里只有一趟读取。
 */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  const pattern = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*([\s\S]*)$/;
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || /^\s*#/.test(line) || !line.trim()) continue;
    const matched = pattern.exec(line);
    if (!matched) continue;
    const name = matched[1];
    let rest = matched[2].trim();
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      // 引号值可以跨行：把后续行一直吃到闭合引号为止，指针随之跳过这一段。
      let value = rest.slice(1);
      let closed = false;
      while (true) {
        const at = value.indexOf(quote);
        if (at !== -1) {
          value = value.slice(0, at);
          closed = true;
          break;
        }
        index += 1;
        if (index >= lines.length) break;
        value += `\n${lines[index]}`;
      }
      if (!closed) index = lines.length;
      out.set(name, quote === '"' ? unescapeDoubleQuoted(value) : value);
      continue;
    }
    const comment = rest.search(/\s#/);
    if (comment !== -1) rest = rest.slice(0, comment);
    out.set(name, rest.trim());
  }
  return out;
}

/** 双引号值里的反斜杠转义还原；不认识的两字符组合原样留着。 */
function unescapeDoubleQuoted(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/** 拼目录与文件名；沿用所在层的分隔符风格。 */
export function joinPath(dir: string, name: string): string {
  const separator = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${separator}${name}`;
}

/** 读一个候选文件；读不到（不存在、二进制、通道报错）一律按 null，由调用方试下一个名字。 */
async function readOrNull(read: ReadText, path: string): Promise<string | null> {
  try {
    return await read(path);
  } catch {
    return null;
  }
}

/**
 * 读齐插件配置目录里的环境表。
 * @param options.rootPath 工作区根绝对路径
 * @param options.readText 读文本的手；缺省走宿主通道
 * @returns 环境表；`<根>/.snow/.snow-file-explorer/` 下没有这两份文件时 environments 为空、files 为空数组
 * @description 位置只认这一处，不做逐层向上：好几份环境表会让用户看不出当前用的是哪一份。
 *   先读公开表打底，再读私密表，同名环境与同名变量都由私密表胜出——
 *   放密钥的那份不该被公开表盖掉，所以私密表总是后合并。
 */
export async function loadEnvironmentStore(options: {
  rootPath: string;
  readText?: ReadText;
}): Promise<HttpEnvironmentStore> {
  const read = options.readText || readTextDefault;
  const issues: HttpEnvironmentIssue[] = [];
  const files: string[] = [];
  const merged = new Map<string, HttpEnvironmentTable>();
  const privateTables = new Map<string, HttpEnvironmentTable>();
  const publicTables = new Map<string, HttpEnvironmentTable>();
  const directory = pluginConfigDirectory(options.rootPath);
  if (!directory) return { environments: merged, privateTables, publicTables, files, issues };
  for (const name of [ENVIRONMENT_FILE_NAME, PRIVATE_ENVIRONMENT_FILE_NAME]) {
    const path = joinPath(directory, name);
    const text = await readOrNull(read, path);
    if (text === null) continue;
    files.push(path);
    const parsed = parseEnvironmentJson(text, name);
    mergeTables(merged, parsed.environments);
    // 两份表各留一份原样：私密表那份用来标「这一行被盖住了」，公开表那份是界面改动的底稿。
    if (name === PRIVATE_ENVIRONMENT_FILE_NAME) mergeTables(privateTables, parsed.environments);
    if (name === ENVIRONMENT_FILE_NAME) mergeTables(publicTables, parsed.environments);
    issues.push(...parsed.issues);
  }
  return { environments: merged, privateTables, publicTables, files, issues };
}

/**
 * 读工作区根上当前环境对应的 `.env`。
 * @param options.rootPath 工作区根
 * @param options.environment 活动环境名（决定先试 `.env.<环境名>`）
 * @param options.readText 读文本的手
 * @returns 变量表与命中的文件路径；没找到时表为空、路径为 null
 * @description 只看工作区根，不再逐层向上：环境名是用户自己写在表里的，
 *   「哪个目录的 .env 生效」必须一眼能答出来。
 *   选了环境时先试 `.env.<环境名>`，没有再回落 `.env`——但环境名里带分隔符或 `..` 时不拼这个名字，
 *   否则一份改过的环境表就能把读盘路径带出工作区。
 */
export async function loadDotenvVariables(options: {
  rootPath: string;
  environment: string;
  readText?: ReadText;
}): Promise<{ variables: Map<string, string>; path: string | null }> {
  const read = options.readText || readTextDefault;
  const root = String(options.rootPath || "");
  if (!root) return { variables: new Map(), path: null };
  const environment = String(options.environment || "");
  const safeEnvironment = /^[\w.-]+$/.test(environment) && !environment.includes("..");
  const names = environment && safeEnvironment ? [`.env.${environment}`, ".env"] : [".env"];
  for (const name of names) {
    const path = joinPath(root, name);
    const text = await readOrNull(read, path);
    if (text === null) continue;
    return { variables: parseDotenv(text), path };
  }
  return { variables: new Map(), path: null };
}
