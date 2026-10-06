/**
 * 生态辅助函数 (src/services/ecosystems.ts)
 *
 * 提供各生态的命令生成纯逻辑，供 project-commands.js 组合：
 *   - Node：resolveNodeEntry / readNodeScripts（package.json scripts → 包管理器 run）。
 *   - Go / Wails：readTaskfileCommands（Taskfile 任务名 → `task <name>`）、
 *     readWails2Commands（wails.json → `wails dev|build`）、
 *     readWails3NativeCommands（wails3 原生命令）、readGoCommands（go build|test|vet|run）。
 *
 * 说明：原先的 ECOSYSTEMS 声明式注册表已移除——命令识别已改为「扫描标记文件」
 *   的模型（多级目录 / 多标记文件），根目录单项目只是它的一个特例，
 *   旧的「根目录命中即整体识别」注册表契约不再适用。
 *
 * 所有函数均为无 IO 纯函数：调用方负责读文件 / 列目录，本模块只做文本解析与命令拼装。
 */

/* ─────────────────────────── 共享词汇类型 ─────────────────────────── */

/**
 * 运行命令项的公共字段：任何生态生成的命令都必须给出这 6 项，渲染层只依赖它们。
 */
export type RunCommandCore = {
  /** 命令稳定 id，形如 `<来源>:<包路径>:<名称>`（根包省略路径）；用于下拉选中、运行复用与去重。 */
  id: string;
  /** 展示名的本地化词条 key；没有词条时为 null，展示退回 labelFallback 原文。 */
  labelKey: string | null;
  /** 下拉项显示名（Node 用 script 名、Go/Wails 用命令原文）；根包兜底命令可缺，缺时展示走 labelFallback。 */
  label?: string;
  /** 未本地化的原文标签；子包命令带 `包路径/名称`，供多包同名 script 区分。 */
  labelFallback: string;
  /** 交给 shell 执行的命令原文。 */
  cmd: string;
  /** lucide 图标名（package / go / wails / python / java / terminal）。 */
  icon: string;
};

/** 运行命令项的可选元数据：按生态补充，运行层据此切目录、选解释器、定位源码行。 */
export type RunCommandMetadata = {
  /** 包管理器（Node：npm/yarn/pnpm/bun；Python：python/uv/poetry/pipenv/pdm/hatch）；其余生态省略。 */
  packageManager?: string;
  /** 运行种类标记（script / python / spring-boot / maven-exec / gradle-application / gradle-application-main / android-task）；缺省表示普通命令。 */
  runKind?: string;
  /** 命令归属的源文件绝对路径（脚本文件、Java/Kotlin 源码、Python 入口）；没有源文件时省略。 */
  sourcePath?: string;
  /** 源码 main 所在行号（1 基，供代码查看器行内 ▶ 匹配）；仅 JVM 的 main 命令带。 */
  mainLine?: number;
  /** JVM 主类全限定名；仅 Maven/Gradle 的 main 运行命令带。 */
  mainClass?: string;
  /** 实际运行目录（相对工作区根的 POSIX 路径）；Gradle 任务需从根目录执行时为 ""，缺省表示用命令所属目录。 */
  runDir?: string;
};

/** 一条可运行命令：所有生态产物的统一形状，供顶栏下拉、右键菜单与运行窗口消费。 */
export type RunCommand = RunCommandCore & RunCommandMetadata;

/** 只需名称的目录条目（判断文件是否存在用这一层；宿主 DirectoryEntry 可直接传入）。 */
export type ProjectNameEntry = {
  /** 文件或目录名（不含路径分隔符）。 */
  name: string;
  /** 是否目录；缺省按文件处理。 */
  isDirectory?: boolean;
};

/** 需要回传源文件位置的目录条目（脚本文件与 Python 入口必须带绝对路径）。 */
export type ProjectEntry = ProjectNameEntry & {
  /** 条目绝对路径：运行层用它定位文件，也是命令 sourcePath 的来源。 */
  path: string;
};

/**
 * package.json 的解析结果：只声明识别链路用到的字段，其余字段留在索引签名里不解释。
 * 允许为 null 表示解析失败或文件不存在（调用方读到什么就传什么）。
 */
export type PackageJson = {
  /** package.json 的其余任意字段（name / workspaces / dependencies 等），本模块只透传不解读。 */
  [key: string]: unknown;
  /** 入口文件字段；一期只认根目录下的裸文件名，带子目录的 main（如 dist/index.js）忽略。 */
  main?: string;
  /** 包管理器声明，形如 `pnpm@9.0.0`；优先级高于同目录锁文件。 */
  packageManager?: string;
  /** npm scripts 表：key 为脚本名，value 为命令原文（非字符串值的脚本会被忽略）。 */
  scripts?: Record<string, unknown> | null;
};

/** 只按所属目录生成命令的选项（Wails / 脚本文件生态）。 */
export type PrefixCommandOptions = {
  /** 命令所属包目录（相对工作区根的 POSIX 路径，根目录为 ""）；只进入 id 与 labelFallback。 */
  prefix?: string;
};

/** readNodeScripts 的选项。 */
export type NodeScriptsOptions = PrefixCommandOptions & {
  /** 已解析出的包管理器；省略时按 packageJson / entries 推断。 */
  packageManager?: string | null;
  /** 包目录的直接子条目，仅在 packageManager 省略时用于锁文件推断。 */
  entries?: ProjectNameEntry[] | null;
};

/** readGoCommands 的选项。 */
export type GoCommandOptions = PrefixCommandOptions & {
  /** `cmd/` 下的子目录名，每个通常是一个 main 包；缺省表示只按根 main.go 定位入口。 */
  cmdDirs?: string[] | null;
};

/** Python 包管理器取值：无明确包管理器时回退系统 python。 */
export type PythonPackageManager = "python" | "uv" | "poetry" | "pipenv" | "pdm" | "hatch";

/** 含 `__main__.py` 的 Python 包目录（扫描器显式传入的包入口）。 */
export type PythonPackageModule = {
  /** 包目录名，同时作为 `python -m` 的模块名。 */
  name: string;
  /** 包内 `__main__.py` 的绝对路径；缺失时该包被跳过。 */
  sourcePath?: string;
  /** 包目录绝对路径；当前扫描器只回传 sourcePath，保留字段兼容其它调用方。 */
  path?: string;
};

/** findPythonMainCandidates 的选项。 */
export type PythonMainOptions = {
  /** 项目内的 Python 包入口列表（含 `__main__.py` 的目录）。 */
  modules?: PythonPackageModule[] | null;
};

/** readPythonCommands 的选项。 */
export type PythonCommandOptions = PrefixCommandOptions & PythonMainOptions & {
  /** 项目目录直接条目：既用于入口候选，也用于锁文件推断包管理器。 */
  entries?: ProjectEntry[] | null;
  /** 已读取的 pyproject.toml 文本；缺省按空文本处理。 */
  pyprojectText?: string;
  /** 已解析出的 Python 包管理器；省略时按 entries / pyprojectText 推断。 */
  packageManager?: string | null;
};

/** JVM 源码语言标记。 */
export type JvmLanguage = "java" | "kotlin";

/** findJavaMainCandidates 识别出的一个 main 声明。 */
export type JvmMainCandidate = {
  /** 主类全限定名（含包名；Kotlin 顶层函数编译为 `包名.FileNameKt`）。 */
  mainClass: string;
  /** main 声明所在行号（1 基）。 */
  line: number;
  /** 声明所属语言。 */
  language: JvmLanguage;
};

/** Maven / Gradle 命令生成接受的 main 候选：允许调用方只提供部分字段（如手工登记的入口）。 */
export type JvmMainCandidateInput = {
  /** 主类全限定名；为空时该候选被跳过。 */
  mainClass: string;
  /** main 所在行号（1 基）；缺省表示该命令不带源码行定位。 */
  line?: number;
  /** 语言标记：由调用方从 findJavaMainCandidates 透传，可缺。 */
  language?: JvmLanguage;
  /** 源码文件绝对路径；缺省表示这个 main 没有可跳转的源文件。 */
  sourcePath?: string;
};

/** readMavenCommands 的选项。 */
export type MavenCommandOptions = {
  /** 模块目录（相对工作区根的 POSIX 路径，根模块为 ""）；决定 id 前缀与 wrapper 的相对路径深度。 */
  prefix?: string;
  /** 已读取的 pom.xml 文本，用于判断是否 spring-boot 插件。 */
  pomText?: string;
  /** 源码 main 候选列表；缺省表示只生成 Maven 基础命令。 */
  mainCandidates?: JvmMainCandidateInput[] | null;
  /** Maven wrapper 文件名（如 `mvnw.cmd`）；缺省按系统 mvn 处理。 */
  wrapper?: string | null;
  /** 无 wrapper 时使用的 mvn 命令名；缺省 "mvn"。 */
  mvn?: string;
  /** 显式声明为 Spring Boot 模块；省略时按 pomText 内容判断。 */
  springBoot?: boolean;
};

/** readGradleCommands 的选项。 */
export type GradleCommandOptions = {
  /** 模块目录（相对工作区根的 POSIX 路径，根模块为 ""）；决定 id 前缀与 `:module:task` 路径。 */
  prefix?: string;
  /** 已读取的 build.gradle(.kts) 文本，用于判断 Android / application / jvm 插件。 */
  buildText?: string;
  /** 已读取的 settings.gradle(.kts) 文本；当前只作为上下文保留，不参与命令拼接。 */
  settingsText?: string;
  /** 源码 main 候选列表；仅 application 插件时生成 main 运行命令。 */
  mainCandidates?: JvmMainCandidateInput[] | null;
  /** Gradle wrapper 文件名（如 `gradlew.bat`）；缺省按系统 gradle 处理。 */
  wrapper?: string | null;
  /** 无 wrapper 时使用的 gradle 命令名；缺省 "gradle"。 */
  gradle?: string;
  /** 模块在 Gradle 里的任务路径（如 `:admin`）；缺省按 prefix 推导。 */
  modulePath?: string;
  /** 强制按 JVM 项目生成 build/test（无插件声明的模块由调用方指定）。 */
  forceJvm?: boolean;
};

/**
 * Node 根目录入口文件的兜底候选（package.json 无 main 字段时按序探测）。
 */
const NODE_ENTRY_CANDIDATES: string[] = ["index.js", "main.js", "app.js", "server.js"];

/** 支持的 Node 包管理器；框架命令最终都通过 package.json scripts 暴露。 */
const PACKAGE_MANAGERS = new Set(["npm", "yarn", "pnpm", "bun"]);

/** 锁文件优先级：显式 packageManager 仍然优先于锁文件。 */
const PACKAGE_MANAGER_LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
];

/**
 * 规范化包管理器名称，兼容 packageManager 的 `pnpm@9.0.0` 形式。
 * @param value packageManager 字段、锁文件推断值或回退值
 * @returns npm / yarn / pnpm / bun；未知值返回 null
 */
function normalizePackageManager(value: unknown): string | null {
  const match = String(value || "").trim().toLowerCase().match(/^([a-z]+)(?:@.*)?$/);
  const name = match ? match[1] : "";
  return PACKAGE_MANAGERS.has(name) ? name : null;
}

/**
 * 从 package.json 与目录条目推断包管理器。
 * @description 显式 `packageManager` > 同目录锁文件 > 调用方传入的继承值 > npm。
 * @param packageJson 已解析的 package.json
 * @param entries 包目录直接条目
 * @param fallback monorepo 子包继承的根包管理器
 * @returns npm / yarn / pnpm / bun
 */
export function detectPackageManager(packageJson: PackageJson | null | undefined, entries?: ProjectNameEntry[] | null, fallback: string | null | undefined = "npm"): string {
  const declared = normalizePackageManager(packageJson && packageJson.packageManager);
  if (declared) return declared;

  const names = new Set(
    (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && entry.isDirectory !== true && typeof entry.name === "string")
      .map((entry) => entry.name.toLowerCase())
  );
  for (const [lockfile, manager] of PACKAGE_MANAGER_LOCKFILES) {
    if (names.has(lockfile)) return manager;
  }
  return normalizePackageManager(fallback) || "npm";
}

/**
 * 为包管理器生成运行 scripts 的命令前缀。
 * @param manager 包管理器
 * @returns 归一后的包管理器名
 */
function runCommandPrefix(manager: string): string {
  return normalizePackageManager(manager) || "npm";
}

/**
 * 从目录条目中挑选入口文件。
 * @description 优先 package.json 的 main 字段（仅支持根目录下的裸文件名，
 *   带子目录的 main 如 dist/index.js 一期不解析），其次按候选名探测。
 * @param packageJson 已解析的 package.json
 * @param entries 根目录条目
 * @returns 入口文件名；未找到返回 null
 */
export function resolveNodeEntry(packageJson: PackageJson | null | undefined, entries?: ProjectNameEntry[] | null): string | null {
  const items = Array.isArray(entries) ? entries : [];
  const fileNames = new Set(
    items.filter((e) => e && e.isDirectory !== true && typeof e.name === "string").map((e) => e.name)
  );

  const main =
    packageJson && typeof packageJson.main === "string" ? packageJson.main.trim().replace(/^\.\//, "") : "";
  if (main && !main.includes("/") && !main.includes("\\") && fileNames.has(main)) {
    return main;
  }
  for (const candidate of NODE_ENTRY_CANDIDATES) {
    if (fileNames.has(candidate)) return candidate;
  }
  return null;
}

/**
 * 由 package.json 的 scripts 生成可运行命令列表。
 * @description 保持 scripts 的定义顺序；每条 script 使用对应包管理器的 `<manager> run <name>`。
 *   标签**原样使用 script 名**（不汉化、不归类）：与 IDEA 一致，`dev` 就显示 `dev`，
 *   避免「开发 / 构建」这类改写造成与 package.json 定义不一致、难以对上号。
 * @param packageJson 已解析的 package.json
 * @param opts
 *   - prefix：子包相对根目录的路径（如 `sub` / `sub/nested`），只用于命令归属和分组；
 *   - packageManager：已解析的包管理器；省略时从 package.json / entries 推断。
 * @returns 与 package.json scripts 同序的可运行命令列表
 */
export function readNodeScripts(packageJson: PackageJson | null | undefined, opts: NodeScriptsOptions = {}): RunCommand[] {
  const scripts =
    packageJson && typeof packageJson === "object" && packageJson.scripts && typeof packageJson.scripts === "object"
      ? packageJson.scripts
      : null;
  if (!scripts) return [];

  const prefix = typeof opts.prefix === "string" ? opts.prefix.replace(/^\/+|\/+$/g, "") : "";
  const manager = runCommandPrefix(
    opts.packageManager || detectPackageManager(packageJson, opts.entries, "npm")
  );
  const commands: RunCommand[] = [];
  for (const name of Object.keys(scripts)) {
    if (!name || typeof scripts[name] !== "string") continue;
    commands.push({
      // id 带上包路径和包管理器，避免多包 / 多管理器的同名 script 冲突。
      id: prefix ? `${manager}:${prefix}:${name}` : `${manager}:${name}`,
      labelKey: null,
      // label：下拉项显示的**纯 script 名**（所属包由分组标题表达，条目里不重复路径）。
      label: name,
      // labelFallback：带包路径的完整名（工具栏当前配置按钮 / 右键菜单需区分多包同名命令）。
      labelFallback: prefix ? `${prefix}/${name}` : name,
      packageManager: manager,
      // 运行时会把 cwd 切到 package.json 所在目录，避免为不同包管理器维护 --prefix / --cwd 方言。
      cmd: `${manager} run ${name}`,
      // 运行配置图标：Node 用 npm 图标（lucide package）。
      icon: "package",
    });
  }
  return commands;
}

/**
 * 根包（package.json 无 scripts 时）的兜底命令：探测入口文件，生成 `node <entry>`。
 * @description 仅用于**工作区根目录**的 package.json（子包不走此兜底，避免 `node sub/index.js`
 *   这类相对 cwd 的入口命令在宿主 shell（cwd=根目录）里语义不清）。
 * @param packageJson 已解析的 package.json
 * @param entries 该包目录的直接子条目
 * @returns 单条 `node <entry>` 命令，或空数组
 */
export function nodeEntryFallback(packageJson: PackageJson | null | undefined, entries?: ProjectNameEntry[] | null): RunCommand[] {
  const entry = resolveNodeEntry(packageJson, entries);
  if (!entry) return [];
  return [
    {
      id: "node:entry",
      labelKey: "run.nodeEntry",
      labelFallback: "Run entry",
      cmd: `node ${entry}`,
      icon: "package",
    },
  ];
}

/* ─────────────────────────── Script files ─────────────────────────── */

/** 归一化命令前缀（相对根目录的 POSIX 路径）：去首尾斜杠。 */
function normalizePrefix(prefix?: string): string {
  return typeof prefix === "string" ? prefix.replace(/^\/+|\/+$/g, "") : "";
}

/**
 * 为目录中的可执行脚本生成运行命令。
 * @description 脚本由调用方在所属目录执行；这里只生成运行命令，不执行脚本、不解析脚本内容。
 *   命令文本就是脚本文件路径——**解释器由运行层按扩展名选择**（bat→cmd、ps1→powershell、
 *   sh→POSIX），这里不写死解释器前缀。
 * @param entries 目录直接条目
 * @param opts 命令所属包路径
 * @returns 脚本命令列表（runKind 为 script，sourcePath 指向脚本文件）
 */
export function readScriptCommands(entries?: ProjectEntry[] | null, opts: PrefixCommandOptions = {}): RunCommand[] {
  const prefix = normalizePrefix(opts.prefix);
  const scripts = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.isDirectory !== true && typeof entry.name === "string" && /\.(?:bat|ps1|sh)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return scripts.map((entry) => ({
    id: prefix ? `script:${prefix}:${entry.name}` : `script:${entry.name}`,
    labelKey: null,
    label: entry.name,
    labelFallback: prefix ? `${prefix}/${entry.name}` : entry.name,
    // 命令文本即脚本文件名；解释器由运行层按扩展名选（bat→cmd / ps1→powershell / sh→POSIX）。
    cmd: entry.name,
    icon: "terminal",
    runKind: "script",
    sourcePath: entry.path,
  }));
}

/* ─────────────────────────── Python ─────────────────────────── */

const PYTHON_ENTRY_CANDIDATES: string[] = ["main.py", "app.py", "cli.py", "run.py", "server.py", "__main__.py"];
const PYTHON_PACKAGE_MANAGERS = new Set(["uv", "poetry", "pipenv", "pdm", "hatch"]);

function normalizePythonPackageManager(value: unknown): PythonPackageManager {
  const name = String(value || "").trim().toLowerCase();
  // as: 上一行的集合成员判定已保证 name 必为 PythonPackageManager 之一，但 Set.has 不做类型收窄。
  return PYTHON_PACKAGE_MANAGERS.has(name) ? (name as PythonPackageManager) : "python";
}

/**
 * 根据项目标记判断 Python 包管理器；没有明确包管理器时回退到系统 Python。
 * @param entries 项目目录直接条目
 * @param pyprojectText 已读取的 pyproject.toml 文本
 * @param fallback 无锁文件时的回退值
 * @returns python / uv / poetry / pipenv / pdm / hatch
 */
export function detectPythonPackageManager(entries?: ProjectNameEntry[] | null, pyprojectText: string = "", fallback: string | null | undefined = "python"): PythonPackageManager {
  const names = new Set(
    (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && entry.isDirectory !== true && typeof entry.name === "string")
      .map((entry) => entry.name.toLowerCase())
  );
  const text = String(pyprojectText || "");
  if (names.has("uv.lock")) return "uv";
  if (names.has("poetry.lock") || /\[tool\.poetry\]/.test(text)) return "poetry";
  if (names.has("pipfile") || names.has("pipfile.lock")) return "pipenv";
  if (names.has("pdm.lock") || /\[tool\.pdm\]/.test(text)) return "pdm";
  if (names.has("hatch.toml") || /\[tool\.hatch/.test(text)) return "hatch";
  return normalizePythonPackageManager(fallback);
}

/** Python 文件入口候选（`python <file>.py`）。 */
export type PythonFileMainCandidate = {
  /** 判别字段：入口是单个脚本文件。 */
  kind: "file";
  /** 入口文件名（相对项目目录），也是命令里的目标路径。 */
  name: string;
  /** 入口文件绝对路径，供运行层与源码定位使用。 */
  path: string;
};

/** Python 包入口候选（`python -m <module>`）。 */
export type PythonModuleMainCandidate = {
  /** 判别字段：入口是含 `__main__.py` 的包目录。 */
  kind: "module";
  /** 展示名（包目录名）。 */
  name: string;
  /** 包内 `__main__.py` 的绝对路径。 */
  path: string;
  /** 传给 `python -m` 的模块名。 */
  module: string;
};

/** Python 可运行入口候选：文件入口与包入口两种，kind 决定命令拼法。 */
export type PythonMainCandidate = PythonFileMainCandidate | PythonModuleMainCandidate;

/**
 * 识别 Python 可运行入口。入口只来自直接文件；包目录由扫描器显式传入 modules。
 * @param entries 项目目录条目
 * @param opts 包入口
 * @returns 去重后的入口候选（按 PYTHON_ENTRY_CANDIDATES 顺序，再跟包入口）
 */
export function findPythonMainCandidates(entries?: ProjectEntry[] | null, opts: PythonMainOptions = {}): PythonMainCandidate[] {
  const items = Array.isArray(entries) ? entries : [];
  const files = new Map(
    items
      .filter((entry) => entry && entry.isDirectory !== true && typeof entry.name === "string")
      .map((entry) => [entry.name.toLowerCase(), entry])
  );
  const result: PythonMainCandidate[] = [];
  const seen = new Set();
  for (const name of PYTHON_ENTRY_CANDIDATES) {
    const entry = files.get(name.toLowerCase());
    if (!entry || seen.has(entry.path)) continue;
    seen.add(entry.path);
    result.push({ name: entry.name, path: entry.path, kind: "file" });
  }
  for (const module of Array.isArray(opts.modules) ? opts.modules : []) {
    if (!module || !module.name || !module.sourcePath || seen.has(module.sourcePath)) continue;
    seen.add(module.sourcePath);
    result.push({ name: module.name, path: module.sourcePath, kind: "module", module: module.name });
  }
  return result;
}

/**
 * 生成 Python 项目运行命令；包管理器只包裹解释器，不擅自生成安装命令。
 * @param opts 所属目录、目录条目、pyproject 文本、包管理器与包入口
 * @returns 每个入口一条命令（runKind 为 python，sourcePath 指向入口文件）
 */
export function readPythonCommands(opts: PythonCommandOptions = {}): RunCommand[] {
  const prefix = normalizePrefix(opts.prefix);
  const manager = normalizePythonPackageManager(
    opts.packageManager || detectPythonPackageManager(opts.entries, opts.pyprojectText, "python")
  );
  const runner = {
    python: "python",
    uv: "uv run python",
    poetry: "poetry run python",
    pipenv: "pipenv run python",
    pdm: "pdm run python",
    hatch: "hatch run python",
  }[manager];
  const candidates = findPythonMainCandidates(opts.entries, { modules: opts.modules });
  return candidates.map((candidate) => {
    const target = candidate.kind === "module" ? `-m ${candidate.module}` : candidate.name;
    const label = candidate.kind === "module" ? candidate.module : candidate.name;
    return {
      id: prefix ? `python:${prefix}:${label}` : `python:${label}`,
      labelKey: null,
      label,
      labelFallback: prefix ? `${prefix}/${label}` : label,
      cmd: `${runner} ${target}`,
      icon: "python",
      packageManager: manager,
      runKind: "python",
      sourcePath: candidate.path,
    };
  });
}

/* ─────────────────────────── Go / Wails ─────────────────────────── */

/**
 * 生成命令对象的公共外壳（与 readNodeScripts 产物同构，供渲染层统一消费）。
 * @param {string} kind 命令来源标识（go / wails / wails3），用作 id 前缀
 * @param {string} prefix 所属目录前缀（根目录为 ""）
 * @param {string} name 稳定名（用于 id，多项目同名不冲突）
 * @param {string} cmd 实际执行的命令文本
 * @param {string} [label] 显示名（缺省用 name）
 * @param {string} [icon] 运行配置图标名（go / wails / package）
 */
function makeCommand(kind: string, prefix: string, name: string, cmd: string, label: string = name, icon: string = "package"): RunCommand {
  return {
    id: prefix ? `${kind}:${prefix}:${name}` : `${kind}:${name}`,
    labelKey: null,
    label,
    labelFallback: prefix ? `${prefix}/${label}` : label,
    cmd,
    icon,
  };
}

/**
 * Wails v3 标准运行入口：固定的 `wails3 task dev` / `wails3 task package` / `wails3 task build`。
 * @description wails3 项目自带 Taskfile，这三个是标准任务。用 wails3 CLI 的 `task` 子命令执行
 *   （不依赖系统单独安装 go-task，wails3 内置）。不再解析 Taskfile 的全部任务，避免把
 *   run / setup:docker / build:server 等一次性 / CI 任务也塞进运行列表（用户要求精简）。
 * @param opts 命令所属包路径
 * @returns 三条固定 wails3 任务命令
 */
export function readWails3Commands(opts: PrefixCommandOptions = {}): RunCommand[] {
  const prefix = normalizePrefix(opts.prefix);
  return [
    ["dev", "wails3 task dev"],
    ["package", "wails3 task package"],
    ["build", "wails3 task build"],
  ].map(([name, cmd]) => makeCommand("wails3", prefix, name, cmd, cmd, "wails"));
}

/** Wails v2 命令：`wails dev` / `wails build`（图标同 Wails）。 */
export function readWails2Commands(opts: PrefixCommandOptions = {}): RunCommand[] {
  const prefix = normalizePrefix(opts.prefix);
  return [
    ["dev", "wails dev"],
    ["build", "wails build"],
  ].map(([name, cmd]) => makeCommand("wails", prefix, name, cmd, cmd, "wails"));
}

/**
 * 纯 Go 项目命令（图标用 Go）。
 * @description 两类作用域：
 *   - build / run：必须定位到 main 包入口（`go build ./cmd/server` 才产出可执行文件，
 *     `go build ./...` 不产出）。入口包：根 main.go → `.`；否则每个 `cmd/<name>/main.go` → `./cmd/<name>`。
 *   - test / vet：作用域是整个模块，保持 `./...`（`go test ./cmd/server` 只测入口包，会漏掉 internal 等库代码）。
 *   无 main 入口（纯库）时 build 也退化为 `./...`。
 * @param entries 项目目录直接条目
 * @param opts prefix：所属包路径；cmdDirs：cmd/ 下的子目录名（每个通常是一个 main 包）
 * @returns go build / run / test / vet 命令列表
 */
export function readGoCommands(entries?: ProjectNameEntry[] | null, opts: GoCommandOptions = {}): RunCommand[] {
  const prefix = normalizePrefix(opts.prefix);
  const items = Array.isArray(entries) ? entries : [];
  const hasMain = items.some((e) => e && e.name === "main.go" && e.isDirectory !== true);
  const cmdDirs = (Array.isArray(opts.cmdDirs) ? opts.cmdDirs : []).filter((dir) => typeof dir === "string" && dir);

  // 入口 main 包列表：根 main.go → "."；否则每个 cmd/<name> → "./cmd/<name>"。
  const entryPackages = hasMain ? ["."] : cmdDirs.map((dir) => `./cmd/${dir}`);

  const specs: [string, string][] = [];
  if (entryPackages.length) {
    for (const pkg of entryPackages) {
      // 多入口时用包路径作区分后缀，保证 id / label 不冲突（根入口用 root）。
      const tag = pkg === "." ? "root" : pkg.replace(/^\.\//, "").replace(/\//g, "-");
      specs.push([`build:${tag}`, `go build ${pkg}`]);
      specs.push([`run:${tag}`, `go run ${pkg}`]);
    }
  } else {
    // 无 main 入口（纯库）：build 也只能模块级。
    specs.push(["build", "go build ./..."]);
  }
  // test / vet 恒为模块级：覆盖全部包。
  specs.push(["test", "go test ./..."]);
  specs.push(["vet", "go vet ./..."]);
  return specs.map(([name, cmd]) => makeCommand("go", prefix, name, cmd, cmd, "go"));
}

/* ─────────────────────────── Java / Kotlin / JVM ─────────────────────────── */

/**
 * 去除 Java/Kotlin 注释但保留换行，确保行号稳定且注释中的 main 不会被识别。
 * 字符串和字符字面量不会把其中的 // 或 /* 当成注释起点。
 * @param text Java 或 Kotlin 源码
 * @returns 保留换行的可扫描源码
 */
function stripJvmComments(text: string): string {
  const source = String(text == null ? "" : text);
  let output = "";
  let state = "code";
  let quote = "";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "line") {
      if (ch === "\n" || ch === "\r") {
        output += ch;
        state = "code";
      } else {
        output += " ";
      }
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        output += "  ";
        i += 1;
        state = "code";
      } else {
        output += ch === "\n" || ch === "\r" ? ch : " ";
      }
      continue;
    }
    if (state === "string") {
      output += ch === "\n" || ch === "\r" ? ch : " ";
      if (ch === "\\") {
        if (i + 1 < source.length) {
          output += source[i + 1] === "\n" || source[i + 1] === "\r" ? source[i + 1] : " ";
          i += 1;
        }
      } else if (ch === quote) {
        state = "code";
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      output += "  ";
      i += 1;
      state = "line";
    } else if (ch === "/" && next === "*") {
      output += "  ";
      i += 1;
      state = "block";
    } else if (ch === '"' || ch === "'") {
      output += " ";
      quote = ch;
      state = "string";
    } else {
      output += ch;
    }
  }
  return output;
}

function joinJvmName(pkg: string, name: string): string {
  return pkg ? `${pkg}.${name}` : name;
}

/**
 * 识别 Java/Kotlin 的 main 声明，并返回可供构建工具运行的类名和源码行。
 * @param text Java/Kotlin 源码
 * @param fileName 源文件名（用于 Kotlin 顶层 main 的 FileNameKt）
 * @returns 去重后的 main 候选（按出现顺序）
 */
export function findJavaMainCandidates(text: string, fileName: string = "Main.java"): JvmMainCandidate[] {
  const clean = stripJvmComments(text);
  const lines = clean.split(/\r\n|\r|\n/);
  const packageMatch = clean.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;?/m);
  const pkg = packageMatch ? packageMatch[1] : "";
  const base = String(fileName || "Main").replace(/^.*[\\/]/, "").replace(/\.(?:java|kt)$/i, "") || "Main";
  const candidates: JvmMainCandidate[] = [];
  const add = (mainClass: string, line: number, language: JvmLanguage): void => {
    if (!mainClass || !line || candidates.some((item) => item.mainClass === mainClass && item.line === line)) return;
    candidates.push({ mainClass, line, language });
  };

  // Java 的 main 必须是静态 void 方法；类名取当前文件中最外层/首个声明类。
  let javaClass = null;
  for (const line of lines) {
    const match = /\b(?:public\s+)?(?:final\s+|abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (match) {
      javaClass = match[1];
      break;
    }
  }
  if (javaClass) {
    for (let index = 0; index < lines.length; index += 1) {
      if (/\b(?:public\s+)?static\s+void\s+main\s*\(\s*String(?:\s*\[\s*\]|\s+\w+\s*\[\s*\])/.test(lines[index])) {
        add(joinJvmName(pkg, javaClass), index + 1, "java");
      }
    }
  }

  // Kotlin 顶层函数编译为 FileNameKt；object/class 内的 main 运行所属对象/类。
  let currentObject = null;
  for (let index = 0; index < lines.length; index += 1) {
    const objectMatch = /\bobject\s+([A-Za-z_$][\w$]*)/.exec(lines[index]);
    if (objectMatch) currentObject = objectMatch[1];
    const classMatch = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(lines[index]);
    if (classMatch && !currentObject) currentObject = classMatch[1];
    if (/\bfun\s+main\s*\(\s*(?:args\s*:\s*Array\s*<\s*String\s*>\s*)?\)\s*(?::\s*Unit)?/.test(lines[index])) {
      add(joinJvmName(pkg, currentObject || `${base}Kt`), index + 1, "kotlin");
    }
  }
  return candidates;
}

function normalizeJvmPrefix(prefix?: string): string {
  return typeof prefix === "string" ? prefix.replace(/^\/+|\/+$/g, "") : "";
}

function wrapperCommand(wrapper: string | null | undefined, prefix: string, fallback: string): string {
  const value = String(wrapper || "").trim();
  const command = String(fallback || "").trim();
  if (!value) return command || "mvn";
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value)) return value;
  if (!prefix || /[\\/]/.test(value.replace(/^\.\.?[\\/]/, ""))) return value;
  const depth = normalizeJvmPrefix(prefix).split("/").filter(Boolean).length;
  return `${"../".repeat(depth)}${value.replace(/^\.\//, "")}`;
}

function jvmMainLabel(mainClass: string): string {
  const value = String(mainClass || "");
  return value.split(".").pop() || value;
}

function jvmCommand(
  kind: string,
  prefix: string,
  name: string,
  cmd: string,
  label: string,
  icon: string,
  metadata: RunCommandMetadata = {},
): RunCommand {
  return {
    id: prefix ? `${kind}:${prefix}:${name}` : `${kind}:${name}`,
    labelKey: null,
    label: label || name,
    labelFallback: prefix ? `${prefix}/${label || name}` : label || name,
    cmd,
    icon,
    ...metadata,
  };
}

/**
 * 生成 Maven 基础命令和源码 main 命令。调用方负责把 cwd 切到 prefix 对应模块。
 * @param opts 所属模块目录、pom 文本、main 候选、wrapper 与包管理器命令名
 * @returns Maven test / package 与（Spring Boot 或 exec:java）main 运行命令
 */
export function readMavenCommands(opts: MavenCommandOptions = {}): RunCommand[] {
  const prefix = normalizeJvmPrefix(opts.prefix);
  const mvn = wrapperCommand(opts.wrapper, prefix, opts.mvn || "mvn");
  const commands = [
    jvmCommand("maven", prefix, "test", `${mvn} test`, "test", "java"),
    jvmCommand("maven", prefix, "package", `${mvn} package`, "package", "java"),
  ];
  const springBoot = opts.springBoot === true || /spring-boot-maven-plugin/.test(String(opts.pomText || ""));
  for (const candidate of Array.isArray(opts.mainCandidates) ? opts.mainCandidates : []) {
    if (!candidate || !candidate.mainClass) continue;
    const suffix = String(candidate.mainClass).replace(/[^A-Za-z0-9_$]+/g, "-");
    const cmd = springBoot
      ? `${mvn} spring-boot:run -Dspring-boot.run.main-class=${candidate.mainClass}`
      : `${mvn} compile exec:java -Dexec.mainClass=${candidate.mainClass}`;
    commands.push(
      jvmCommand(
        "maven",
        prefix,
        `main:${suffix}`,
        cmd,
        jvmMainLabel(candidate.mainClass),
        "java",
        {
          sourcePath: candidate.sourcePath,
          mainLine: candidate.line,
          mainClass: candidate.mainClass,
          runKind: springBoot ? "spring-boot" : "maven-exec",
        }
      )
    );
  }
  return commands;
}

/**
 * 生成 Gradle/Kotlin DSL 命令。Android application 只生成 Android 任务，不把 Activity 当 main。
 * @param opts 所属模块目录、Gradle 构建文本、main 候选、wrapper 与任务路径
 * @returns Gradle 任务命令列表（Android 任务 / build / test / run / main run）
 */
export function readGradleCommands(opts: GradleCommandOptions = {}): RunCommand[] {
  const prefix = normalizeJvmPrefix(opts.prefix);
  const buildText = String(opts.buildText || "");
  // `apply false` 只是根聚合器预声明插件，不代表当前项目是 Android application/library。
  // 只按同一行实际应用的插件判断，避免把 Gradle 根项目生成 Android 专用任务。
  const android = buildText
    .split(/\r\n|\r|\n/)
    .some((line) => /com\.android\.(?:application|library)/.test(line) && !/\bapply\s+false\b/.test(line));
  const application = !android && /(?:^|[\s"'`])(?:application|org\.gradle\.application)(?:[\s"'`]|$)/.test(buildText);
  const jvm = !android && /java|org\.jetbrains\.kotlin\.jvm|kotlin\("jvm"\)/.test(buildText);
  const modulePath = String(opts.modulePath || (prefix ? `:${prefix.split("/").join(":")}` : ""));
  // Gradle 的 `:module:task` 是根项目任务路径，必须从工作区根目录启动。
  // `command.dir` 仍保留模块目录用于分组和源码匹配，运行时改用 `runDir`。
  const runDir = "";
  const wrapper = wrapperCommand(opts.wrapper, runDir, opts.gradle || "gradle");
  const task = (name: string) => `${wrapper}${modulePath ? ` ${modulePath}:${name}` : ` ${name}`}`;
  const commands: RunCommand[] = [];
  if (android) {
    for (const name of ["assembleDebug", "testDebugUnitTest", "lint"]) {
      commands.push(jvmCommand("gradle", prefix, name, task(name), name, "java", { runKind: "android-task", runDir }));
    }
    return commands;
  }
  if (!jvm && !application && !opts.forceJvm) return commands;
  for (const name of ["build", "test"]) commands.push(jvmCommand("gradle", prefix, name, task(name), name, "java", { runDir }));
  if (application) {
    commands.push(jvmCommand("gradle", prefix, "run", task("run"), "run", "java", { runKind: "gradle-application", runDir }));
    for (const candidate of Array.isArray(opts.mainCandidates) ? opts.mainCandidates : []) {
      if (!candidate || !candidate.mainClass) continue;
      commands.push(
        jvmCommand(
          "gradle",
          prefix,
          `main:${String(candidate.mainClass).replace(/[^A-Za-z0-9_$]+/g, "-")}`,
          task("run"),
          jvmMainLabel(candidate.mainClass),
          "java",
          {
            runDir,
            sourcePath: candidate.sourcePath,
            mainLine: candidate.line,
            mainClass: candidate.mainClass,
            runKind: "gradle-application-main",
          }
        )
      );
    }
  }
  return commands;
}
