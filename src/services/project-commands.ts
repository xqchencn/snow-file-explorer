/**
 * 项目识别与命令生成服务 (src/services/project-commands.ts)
 *
 * 职责：
 *   1. 纯函数 detectProjectCommands：由「已发现的包」列表生成可运行命令（无 IO，可单测）。
 *   2. 异步扫描 scanProjectCommands：递归扫工作区里的包标记（package.json / go.mod / Taskfile / wails.json），
 *      跳过大目录（node_modules/.git/target 等）与独立 go 测试模块，懒加载并缓存结果。
 *
 * 设计要点：
 *   - 从「根目录命中即整体识别」改为「每个标记文件就是一个包」：
 *     每条命令在所属目录执行；Node 用 packageManager 推断出的包管理器，
 *     Go/Wails 用 Taskfile 任务名或原生 CLI / 通用 go 子命令。
 *   - 命令 id 带包路径与来源，避免多个包或多种来源的同名命令冲突。
 *   - 排序：父包在前；同一层级内服务端（Go/Wails）展示在前端（Node）之前（见 ECOSYSTEM_PRIORITY）。
 */

import { readDirectoryEntries } from "./file-service.ts";
import { mapPool } from "../utils/async.ts";
import type {
  JvmMainCandidateInput,
  PackageJson,
  ProjectEntry,
  PythonPackageModule,
  RunCommand,
} from "./ecosystems.ts";
import {
  readNodeScripts,
  nodeEntryFallback,
  readScriptCommands,
  detectPackageManager,
  readWails2Commands,
  readWails3Commands,
  readGoCommands,
  findJavaMainCandidates,
  readMavenCommands,
  readGradleCommands,
  detectPythonPackageManager,
  readPythonCommands,
} from "./ecosystems.ts";

/* ─────────────────────────── 词汇类型 ─────────────────────────── */

/**
 * 生态标识：一个包（标记文件所在目录）被识别成哪一种可运行生态。
 */
export type EcosystemKind = "node" | "go" | "python" | "script" | "maven" | "gradle";

/**
 * 一个生态分组：同一目录同一生态的全部可运行命令。
 */
export type EcosystemGroup = {
  /** 生态标识；JVM 分组从包记录继承，故允许缺失。 */
  kind?: EcosystemKind | string;
  /** 分组 id：`<生态>:<包路径>`（根包省略路径），flattenCommands 用它标注命令来源。 */
  id: string;
  /** 分组展示名（如 `Go · frontend`、`Node.js`）。 */
  label: string;
  /** 触发该分组的标记文件名（如 `package.json`、`go.mod`），仅用于展示与排查。 */
  markers: string[];
  /** 分组所属包目录（相对工作区根的 POSIX 路径，根包为 ""）。 */
  dir: string;
  /** 该分组的包管理器（Node / Python 生态才有；其余省略）。 */
  packageManager?: string | null;
  /** 生态入口文件（预留字段，当前识别链路一律置 null，渲染层不得依赖）。 */
  entry: string | null;
  /** 该分组下的全部命令。 */
  commands: RunCommand[];
};

/**
 * 包摘要：detectProjectCommands 对每个被识别的包给出的一行统计。
 */
export type EcosystemSummary = {
  /** 摘要 id（多数生态等于分组 id，Node/Go 走 `prefix || 生态名` 兜底）。 */
  id: string;
  /** 包目录（相对工作区根的 POSIX 路径，根包为 ""）。 */
  dir: string;
  /** 生态标识；JVM 分支直接继承包记录，故允许缺失。 */
  ecosystem?: EcosystemKind | string;
  /** 包管理器（仅 Node / Python 生态给出）。 */
  packageManager?: string | null;
  /** 该包生成的命令条数。 */
  commandCount: number;
};

/**
 * 单个「已发现的包」：scanProjectCommands 的产物，也是 detectProjectCommands 的输入。
 * @description 一个包 = 一个标记文件所在目录；不同生态只填自己用到的字段，未填字段由
 *   detectProjectCommands 按生态兜底。
 */
export type ProjectPackage = {
  /** 包目录相对工作区根的 POSIX 路径；根包为 ""，缺失按根包处理。 */
  dir?: string;
  /** 生态标识；缺失按 node 处理（node 是唯一有 package.json 兜底路径的生态）。 */
  ecosystem?: EcosystemKind;
  /** 已解析的 package.json（node 生态用）；解析失败为 null。 */
  packageJson?: PackageJson | null;
  /** 包目录的直接子条目（各生态都用来判断入口 / 标记文件）。 */
  entries?: ProjectEntry[] | null;
  /** 已解析或从父目录继承的包管理器；缺失时按 package.json / 锁文件推断。 */
  packageManager?: string | null;
  /** `cmd/` 下的子目录名（go 生态的 main 包入口）。 */
  cmdDirs?: string[] | null;
  /** 是否含 wails.json（go 生态：Wails v2 项目）。 */
  hasWails2?: boolean;
  /** go.mod 是否依赖 wails/v3（go 生态：Wails v3 项目）。 */
  hasWails3?: boolean;
  /** 已读取的 pyproject.toml 文本（python 生态）。 */
  pyprojectText?: string;
  /** 含 `__main__.py` 的 Python 包入口列表（python 生态）。 */
  pythonModules?: PythonPackageModule[] | null;
  /** 已读取的 pom.xml 文本（maven 生态）。 */
  pomText?: string;
  /** 已读取的 build.gradle(.kts) 文本（gradle 生态）。 */
  buildText?: string;
  /** 已读取的 settings.gradle(.kts) 文本（gradle 生态，当前只作上下文保留）。 */
  settingsText?: string;
  /** 扫描到的 JVM 源码 main 候选（maven / gradle 生态）。 */
  mainCandidates?: JvmMainCandidateInput[] | null;
  /** 模块可用的 wrapper 文件名（`mvnw.cmd` / `gradlew.bat`）；从父目录继承，缺失表示用系统命令。 */
  wrapper?: string | null;
  /** Gradle 任务路径（如 `:admin`）；缺省按 dir 推导。 */
  modulePath?: string;
  /** 强制按 JVM 项目生成 Gradle build/test（无插件声明时由调用方指定）。 */
  forceJvm?: boolean;
  /** 是否 Spring Boot 模块（maven 生态）；缺省按 pomText 内容判断。 */
  springBoot?: boolean;
  /** 触发该包被发现的标记文件名列表（仅随记录携带，识别逻辑不读取）。 */
  markers?: string[];
};

/** detectProjectCommands 的结果：生态分组 + 包摘要 + 扫描时间。 */
export type ProjectCommandsSummary = {
  /** 按发现顺序排列的生态分组。 */
  ecosystems: EcosystemGroup[];
  /** 与分组一一对应的包摘要。 */
  packages: EcosystemSummary[];
  /** 本次识别完成的时间戳（毫秒）。 */
  scannedAt: number;
};

/** scanProjectCommands 的结果：识别产物 + 根目录（作为缓存键与过期判定依据）。 */
export type ProjectCommandsResult = ProjectCommandsSummary & {
  /** 本次扫描的工作区根目录绝对路径。 */
  rootPath: string;
};

/** ensureProjectCommands 就地读写的状态槽位（面板 state 里与项目识别有关的那部分）。 */
export type ProjectCommandsState = {
  /** 上一次识别结果缓存；null 表示尚未扫描或当前没有根目录。 */
  projectCommands: ProjectCommandsResult | null;
};

/** ensureProjectCommands 的选项。 */
export type EnsureProjectCommandsOptions = {
  /** true 时忽略缓存重新扫描（目录变化后的刷新）。 */
  force?: boolean;
};

/** flattenCommands 的选项。 */
export type FlattenCommandsOptions = {
  /** true 时返回全部命令（含顶栏隐藏的脚本命令与各模块公共命令），供代码查看器匹配源码行 ▶。 */
  includeHidden?: boolean;
};

/** 扁平化后的命令：RunCommand 加上归属生态与目录，顶栏下拉与右键菜单直接消费。 */
export type FlatRunCommand = RunCommand & {
  /** 所属生态分组 id（如 `node:sub`、`go`）。 */
  ecosystem: string;
  /** 命令所属包目录（相对工作区根，根包为 ""）；运行层据此切 cwd。 */
  dir: string;
  /** 分组标题；根包为 null（由渲染层用「根目录」本地化文案）。 */
  group: string | null;
};

/** 递归扫描 JVM 源码的共享预算计数器（跨目录累计已读源码文件数）。 */
type ScanBudgetState = {
  /** 已消耗的源码文件读取次数，达到 budget 后停止继续扫描。 */
  count: number;
};

/** 标准 JVM 源码根（`src/main/java` 或 `src/main/kotlin`）。 */
type JvmSourceRoot = {
  /** 源码根绝对路径。 */
  path: string;
  /** 源码根相对包目录的 POSIX 路径（如 `src/main/java`），用于递归时拼接子路径。 */
  rel: string;
};

/** 递归扫描时跳过的目录名（海量 / 无关 / 生成物）。 */
const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "vendor",
  "target",
]);

/** 单次扫描允许发现的最大包数量（防御性上限，避免超大仓库卡顿）。 */
const MAX_PACKAGES = 50;
/** 递归扫描最大深度。 */
const MAX_SCAN_DEPTH = 6;

/**
 * 扫描时跳过的 go 测试模块目录名（仅非根目录生效）。
 * @description go-desktop/tests、gyt-treatment/tests 等是「隔离测试模块」（自带 go.mod + replace ..），
 *   不是可运行的产品入口；若当作 module 会生成无意义的 `go test` 噪声，故跳过。
 */
const GO_TEST_DIRS = new Set(["tests", "test"]);

/**
 * 生态排序优先级：数值小的排在前。
 * @description 用户规矩——**服务端（Go / Wails）展示在前端（Node）之前**。
 *   仅在「同一目录层级」内比较，父包在前的既有层级规则不受影响。
 */
const ECOSYSTEM_PRIORITY: Record<string, number> = { go: 0, maven: 1, gradle: 1, python: 1, script: 2, node: 2 };

/**
 * 规范化根目录键：统一分隔符、小写、去尾部分隔符。
 * @param p 路径
 * @returns 可比较的目录键
 */
function rootKey(p: string): string {
  return String(p || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

/** 把目录名数组拼成 POSIX 相对路径，用于包分组和工作目录计算。 */
function joinRel(dirNames: string[]): string {
  return dirNames.filter(Boolean).join("/");
}

/**
 * 懒加载入口：按根目录缓存识别结果。
 * @description 同一根目录内命中缓存即返回，切换项目根目录才重新扫描。
 * @param state 面板状态（就地读写）
 * @param rootPath 工作区根目录
 * @param opts 是否强制重扫
 * @returns 识别结果；无根目录时返回 null
 */
export async function ensureProjectCommands(
  state: ProjectCommandsState,
  rootPath: string | null | undefined,
  opts: EnsureProjectCommandsOptions = {},
): Promise<ProjectCommandsResult | null> {
  if (!rootPath) {
    state.projectCommands = null;
    return null;
  }
  const cached = state.projectCommands;
  if (!opts.force && cached && rootKey(cached.rootPath) === rootKey(rootPath)) {
    return cached;
  }
  const result = await scanProjectCommands(rootPath);
  // 异步扫描期间可能已切换项目：过期结果不得写回。
  if (rootKey(result.rootPath) !== rootKey(rootPath)) return result;
  state.projectCommands = result;
  return result;
}

/**
 * 生成 Go / Wails 生态的运行命令。
 * @description 按项目类型分流：
 *   1. Wails v3（go.mod 依赖 wails/v3）→ 标准 `task dev` / `task package` / `task build`；
 *   2. Wails v2（有 wails.json）→ `wails dev` / `wails build`；
 *   3. 纯 Go → 通用 `go build/test/vet`（+ 入口 run）。
 * @param pkg go 条目
 * @param prefix 相对根目录的 POSIX 路径（根目录 ""）
 * @returns 与 Node 命令同构的命令数组
 */
function buildGoCommands(pkg: ProjectPackage, prefix: string): RunCommand[] {
  if (pkg.hasWails3) return readWails3Commands({ prefix });
  if (pkg.hasWails2) return readWails2Commands({ prefix });
  return readGoCommands(pkg.entries, { prefix, cmdDirs: pkg.cmdDirs });
}

function buildPythonCommands(pkg: ProjectPackage, prefix: string): RunCommand[] {
  return readPythonCommands({
    prefix,
    entries: pkg.entries,
    pyprojectText: pkg.pyprojectText,
    packageManager: pkg.packageManager,
    modules: pkg.pythonModules,
  });
}

function buildScriptCommands(pkg: ProjectPackage, prefix: string): RunCommand[] {
  return readScriptCommands(pkg.entries, { prefix });
}

function buildJvmCommands(pkg: ProjectPackage, prefix: string): RunCommand[] {
  if (pkg.ecosystem === "maven") {
    return readMavenCommands({
      prefix,
      pomText: pkg.pomText,
      mainCandidates: pkg.mainCandidates,
      wrapper: pkg.wrapper,
      springBoot: pkg.springBoot,
    });
  }
  return readGradleCommands({
    prefix,
    buildText: pkg.buildText,
    settingsText: pkg.settingsText,
    mainCandidates: pkg.mainCandidates,
    wrapper: pkg.wrapper,
    modulePath: pkg.modulePath,
    forceJvm: pkg.forceJvm,
  });
}

/**
 * 把 JVM 构建标记转换为生态命令组；没有源码 main 的聚合根仍保留基础构建命令。
 */
function buildJvmEcosystem(pkg: ProjectPackage, prefix: string): EcosystemGroup {
  // as: 只有 detectProjectCommands 的 maven / gradle 分支会调用本函数，此时 ecosystem 必为二者之一。
  const kind = pkg.ecosystem as EcosystemKind;
  const commands = buildJvmCommands(pkg, prefix);
  return {
    kind,
    id: prefix ? `${kind}:${prefix}` : kind,
    label: prefix ? `${kind === "maven" ? "Maven" : "Gradle"} · ${prefix}` : kind === "maven" ? "Maven" : "Gradle",
    markers: kind === "maven" ? ["pom.xml"] : ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
    dir: prefix,
    entry: null,
    commands,
  };
}

/**
 * 纯函数：由「已发现的包」列表生成命令集合。
 * @description 每个包由标记类型（node / go）+ 相对根目录的路径前缀描述；
 *   node 包用 packageJson 内容，go 包用目录条目 + Taskfile 任务名。
 * @param packages 包列表（允许夹带空元素，函数内逐项跳过）
 * @returns 生态分组、包摘要与扫描时间
 */
export function detectProjectCommands(packages?: (ProjectPackage | null | undefined)[] | null): ProjectCommandsSummary {
  const list = Array.isArray(packages) ? packages : [];
  const ecosystems: EcosystemGroup[] = [];
  const summary: EcosystemSummary[] = [];

  for (const pkg of list) {
    if (!pkg) continue;
    const dir = typeof pkg.dir === "string" ? pkg.dir : "";
    const prefix = dir.replace(/^\/+|\/+$/g, "");

    if (pkg.ecosystem === "go") {
      const commands = buildGoCommands(pkg, prefix);
      ecosystems.push({
        kind: "go",
        id: prefix ? `go:${prefix}` : "go",
        label: prefix ? `Go · ${prefix}` : "Go",
        markers: ["go.mod"],
        dir: prefix,
        entry: null,
        commands,
      });
      summary.push({ id: prefix || "go", dir: prefix, ecosystem: "go", commandCount: commands.length });
      continue;
    }

    if (pkg.ecosystem === "python") {
      const commands = buildPythonCommands(pkg, prefix);
      const eco = {
        kind: "python",
        id: prefix ? `python:${prefix}` : "python",
        label: prefix ? `Python · ${prefix}` : "Python",
        markers: ["pyproject.toml", "requirements.txt", "Pipfile", "setup.py", "*.py"],
        dir: prefix,
        packageManager: pkg.packageManager || "python",
        entry: null,
        commands,
      };
      ecosystems.push(eco);
      summary.push({ id: eco.id, dir: prefix, ecosystem: "python", packageManager: eco.packageManager, commandCount: commands.length });
      continue;
    }

    if (pkg.ecosystem === "script") {
      const commands = buildScriptCommands(pkg, prefix);
      const eco = {
        kind: "script",
        id: prefix ? `script:${prefix}` : "script",
        label: prefix ? `Scripts · ${prefix}` : "Scripts",
        markers: ["*.bat", "*.ps1", "*.sh"],
        dir: prefix,
        entry: null,
        commands,
      };
      ecosystems.push(eco);
      summary.push({ id: eco.id, dir: prefix, ecosystem: "script", commandCount: commands.length });
      continue;
    }

    if (pkg.ecosystem === "maven" || pkg.ecosystem === "gradle") {
      const eco = buildJvmEcosystem(pkg, prefix);
      ecosystems.push(eco);
      summary.push({ id: eco.id, dir: prefix, ecosystem: pkg.ecosystem, commandCount: eco.commands.length });
      continue;
    }

    const packageManager = detectPackageManager(pkg.packageJson, pkg.entries, pkg.packageManager || "npm");
    const commands = readNodeScripts(pkg.packageJson, { prefix, packageManager });
    // 仅根包在无 scripts 时兜底为 `node <entry>`（子包不走，避免相对 cwd 的入口命令歧义）。
    const entryFallback = prefix ? [] : nodeEntryFallback(pkg.packageJson, pkg.entries);
    const finalCommands = commands.length ? commands : entryFallback;

    ecosystems.push({
      kind: "node",
      id: prefix ? `node:${prefix}` : "node",
      label: prefix ? `Node · ${prefix}` : "Node.js",
      markers: ["package.json"],
      dir: prefix,
      packageManager,
      entry: null,
      commands: finalCommands,
    });
    summary.push({ id: prefix || "node", dir: prefix, ecosystem: "node", packageManager, commandCount: finalCommands.length });
  }

  return { ecosystems, packages: summary, scannedAt: Date.now() };
}

/**
 * 递归扫描工作区，发现所有包标记并解析为包列表（Node package.json / Go 项目）。
 * @param rootPath 工作区根目录绝对路径
 * @returns 带根目录键的识别结果；根目录不可读时为空的识别结果
 */
export async function scanProjectCommands(rootPath: string | null | undefined): Promise<ProjectCommandsResult> {
  const empty: ProjectCommandsResult = { rootPath: rootPath || "", ecosystems: [], packages: [], scannedAt: Date.now() };
  if (!rootPath) return empty;

  const snow = typeof window !== "undefined" ? window.snow : null;
  const canRead = snow && typeof snow.readFileContent === "function";
  const packages: ProjectPackage[] = [];
  const MAX_SOURCE_FILES = 240;

  const readText = async (entry: ProjectEntry | null | undefined): Promise<string | null> => {
    if (!canRead || !entry || !entry.path) return null;
    try {
      const result = await snow.readFileContent(entry.path);
      return result && typeof result.content === "string" && !result.isBinary ? result.content : null;
    } catch {
      return null;
    }
  };
  const readJson = async (entry: ProjectEntry | null | undefined): Promise<PackageJson | null> => {
    const text = await readText(entry);
    if (text == null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const findFile = (entries: ProjectEntry[], name: string): ProjectEntry | undefined => entries.find((entry) => entry && entry.name === name && entry.isDirectory !== true);
  const findDir = (entries: ProjectEntry[], name: string): ProjectEntry | undefined => entries.find((entry) => entry && entry.name === name && entry.isDirectory === true);
  const hasFile = (entries: ProjectEntry[], name: string): boolean => Boolean(findFile(entries, name));
  const isGoModule = (entries: ProjectEntry[]): boolean =>
    hasFile(entries, "go.mod") || hasFile(entries, "Taskfile.yml") || hasFile(entries, "Taskfile.yaml") || hasFile(entries, "wails.json");
  const isPythonProject = (entries: ProjectEntry[] | null | undefined): boolean =>
    (Array.isArray(entries) ? entries : []).some((entry) => {
      if (!entry || entry.isDirectory === true || typeof entry.name !== "string") return false;
      const name = entry.name.toLowerCase();
      return (
        name === "pyproject.toml" ||
        name === "pipfile" ||
        name === "pipfile.lock" ||
        name === "setup.py" ||
        name === "setup.cfg" ||
        name === "requirements.txt" ||
        /^requirements(?:[.-].+)?\.txt$/i.test(entry.name) ||
        name === "uv.lock" ||
        name === "poetry.lock" ||
        name === "pdm.lock" ||
        // 包目录中的 __main__.py / helpers.py 由父项目的 modules 逻辑处理，不能单独触发递归项目识别。
        /^(?:main|app|cli|run|server)\.py$/i.test(entry.name)
      );
    });
  const isScriptProject = (entries: ProjectEntry[] | null | undefined): boolean =>
    (Array.isArray(entries) ? entries : []).some(
      (entry) => entry && entry.isDirectory !== true && typeof entry.name === "string" && /\.(?:bat|ps1|sh)$/i.test(entry.name)
    );

  // JVM 源码只从标准源码根读取，且有文件数上限，避免扫描生成物或巨型仓库卡死。
  const collectJvmSources = async (
    sourceRoot: string | null | undefined,
    rootRel: string,
    result: JvmMainCandidateInput[],
    budget: number,
    state: ScanBudgetState,
  ): Promise<void> => {
    if (!sourceRoot || state.count >= budget) return;
    let entries: ProjectEntry[] | undefined;
    try {
      entries = await readDirectoryEntries(sourceRoot);
    } catch {
      return;
    }
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || !entry.path || state.count >= budget) break;
      if (entry.isDirectory === true) {
        if (SCAN_SKIP_DIRS.has(String(entry.name || "").toLowerCase()) || /^(?:test|generated)$/i.test(entry.name || "")) continue;
        await collectJvmSources(entry.path, `${rootRel}/${entry.name}`, result, budget, state);
        continue;
      }
      if (!/\.(?:java|kt)$/i.test(entry.name || "")) continue;
      state.count += 1;
      const text = await readText(entry);
      if (text == null) continue;
      const candidates = findJavaMainCandidates(text, entry.name).map((candidate) => ({
        ...candidate,
        sourcePath: entry.path,
      }));
      result.push(...candidates);
    }
  };

  const findSourceRoots = async (baseEntries: ProjectEntry[]): Promise<JvmSourceRoot[]> => {
    const roots: JvmSourceRoot[] = [];
    for (const language of ["java", "kotlin"]) {
      const src = findDir(baseEntries, "src");
      if (!src) continue;
      try {
        const srcEntries = await readDirectoryEntries(src.path);
        const mainDir = findDir(srcEntries, "main");
        if (mainDir) {
          const mainEntries = await readDirectoryEntries(mainDir.path);
          const root = findDir(mainEntries, language);
          if (root) roots.push({ path: root.path, rel: `src/main/${language}` });
        }
      } catch {
        // 某个标准源码根读取失败时继续检查其它根。
      }
    }
    return roots;
  };

  const buildPythonPackage = async (dirRel: string, entries: ProjectEntry[]): Promise<ProjectPackage> => {
    const pyprojectEntry = findFile(entries, "pyproject.toml");
    const pyprojectText = pyprojectEntry ? (await readText(pyprojectEntry)) || "" : "";
    const packageManager = detectPythonPackageManager(entries, pyprojectText, "python");
    const modules: PythonPackageModule[] = [];
    const collectModules = async (baseEntries: ProjectEntry[] | null | undefined): Promise<void> => {
      for (const entry of Array.isArray(baseEntries) ? baseEntries : []) {
        if (!entry || entry.isDirectory !== true || SCAN_SKIP_DIRS.has(String(entry.name || "").toLowerCase())) continue;
        let children: ProjectEntry[] | undefined;
        try {
          children = await readDirectoryEntries(entry.path);
        } catch {
          continue;
        }
        const main = findFile(children, "__main__.py");
        if (main) modules.push({ name: entry.name, sourcePath: main.path });
      }
    };
    await collectModules(entries);
    const srcDir = findDir(entries, "src");
    if (srcDir) {
      try {
        await collectModules(await readDirectoryEntries(srcDir.path));
      } catch {
        // src 布局读取失败时仍保留根目录 Python 入口。
      }
    }
    return {
      dir: dirRel,
      ecosystem: "python",
      entries,
      pyprojectText,
      packageManager,
      pythonModules: modules,
      markers: ["pyproject.toml", "requirements.txt", "Pipfile", "setup.py", "*.py"],
    };
  };

  const buildScriptPackage = (dirRel: string, entries: ProjectEntry[]): ProjectPackage => ({
    dir: dirRel,
    ecosystem: "script",
    entries,
    markers: ["*.bat", "*.ps1", "*.sh"],
  });

  const buildJvmPackage = async (
    dirRel: string,
    entries: ProjectEntry[],
    ecosystem: EcosystemKind,
    inheritedWrapper: string | null | undefined,
  ): Promise<ProjectPackage> => {
    const mainCandidates: JvmMainCandidateInput[] = [];
    const scanState: ScanBudgetState = { count: 0 };
    const roots = await findSourceRoots(entries);
    for (const root of roots) await collectJvmSources(root.path, root.rel, mainCandidates, MAX_SOURCE_FILES, scanState);
    const prefix = dirRel;
    const wrapperName = ecosystem === "maven" ? "mvnw.cmd" : "gradlew.bat";
    const wrapper = findFile(entries, wrapperName) ? wrapperName : inheritedWrapper;
    const buildEntry = ecosystem === "maven" ? findFile(entries, "pom.xml") : findFile(entries, "build.gradle.kts") || findFile(entries, "build.gradle");
    const settingsEntry = findFile(entries, "settings.gradle.kts") || findFile(entries, "settings.gradle");
    const buildText = buildEntry ? await readText(buildEntry) : "";
    const settingsText = settingsEntry ? await readText(settingsEntry) : "";
    return {
      dir: dirRel,
      ecosystem,
      pomText: ecosystem === "maven" ? buildText || "" : "",
      buildText: ecosystem === "gradle" ? buildText || "" : "",
      settingsText: settingsText || "",
      mainCandidates,
      wrapper,
      modulePath: prefix ? `:${prefix.split("/").join(":")}` : "",
      // 只有 Gradle application 插件才给 main 生成 run；Android 插件由 readGradleCommands 专门处理。
      forceJvm: false,
      springBoot: ecosystem === "maven" && /spring-boot-maven-plugin/.test(buildText || ""),
    };
  };

  const buildGoPackage = async (dirRel: string, entries: ProjectEntry[]): Promise<ProjectPackage> => {
    const goModText = (await readText(findFile(entries, "go.mod"))) || "";
    const cmdEntry = findDir(entries, "cmd");
    let cmdDirs: string[] = [];
    if (cmdEntry) {
      try {
        const children = await readDirectoryEntries(cmdEntry.path);
        cmdDirs = (Array.isArray(children) ? children : []).filter((entry) => entry && entry.isDirectory && entry.name).map((entry) => entry.name);
      } catch {
        cmdDirs = [];
      }
    }
    return {
      dir: dirRel,
      ecosystem: "go",
      entries,
      hasWails2: Boolean(findFile(entries, "wails.json")),
      hasWails3: /wailsapp\/wails\/v3/.test(goModText),
      cmdDirs,
    };
  };

  const inspectDirectory = async (
    dirPath: string,
    relNames: string[],
    depth: number,
    inheritedManager: string | null | undefined,
    inheritedMvnw: string | null | undefined,
    inheritedGradlew: string | null | undefined,
  ): Promise<ProjectPackage[]> => {
    if (depth > MAX_SCAN_DEPTH || packages.length >= MAX_PACKAGES) return [];
    let entries: ProjectEntry[] | undefined;
    try {
      entries = await readDirectoryEntries(dirPath);
    } catch {
      return [];
    }
    if (!Array.isArray(entries)) return [];
    const rel = joinRel(relNames);
    const last = relNames[relNames.length - 1];
    if (relNames.length && GO_TEST_DIRS.has(last) && isGoModule(entries)) return [];

    const found: ProjectPackage[] = [];
    const pkgEntry = findFile(entries, "package.json");
    const packageJson = pkgEntry ? await readJson(pkgEntry) : null;
    const packageManager = pkgEntry ? detectPackageManager(packageJson, entries, inheritedManager) : inheritedManager;
    const mvnw = findFile(entries, "mvnw.cmd") ? "mvnw.cmd" : inheritedMvnw;
    const gradlew = findFile(entries, "gradlew.bat") ? "gradlew.bat" : inheritedGradlew;
    if (pkgEntry) found.push({ dir: rel, packageJson, packageManager, entries });
    if (isGoModule(entries)) found.push(await buildGoPackage(rel, entries));
    if (isPythonProject(entries)) found.push(await buildPythonPackage(rel, entries));
    if (isScriptProject(entries)) found.push(buildScriptPackage(rel, entries));
    if (hasFile(entries, "pom.xml")) found.push(await buildJvmPackage(rel, entries, "maven", mvnw));
    if (hasFile(entries, "build.gradle") || hasFile(entries, "build.gradle.kts") || hasFile(entries, "settings.gradle") || hasFile(entries, "settings.gradle.kts")) {
      found.push(await buildJvmPackage(rel, entries, "gradle", gradlew));
    }
    const subDirs = entries.filter((entry) => entry && entry.isDirectory === true && !SCAN_SKIP_DIRS.has(String(entry.name || "").toLowerCase()));
    const nested = await mapPool(subDirs, 8, async (sub) => {
      if (packages.length + found.length >= MAX_PACKAGES) return [];
      return inspectDirectory(sub.path, relNames.concat(sub.name), depth + 1, packageManager, mvnw, gradlew);
    });
    for (const list of nested) {
      if (Array.isArray(list)) found.push(...list);
    }
    return found;
  };

  let rootEntries: ProjectEntry[] | undefined;
  try {
    rootEntries = await readDirectoryEntries(rootPath);
  } catch {
    return empty;
  }
  if (!Array.isArray(rootEntries)) return empty;
  const rootPkg = findFile(rootEntries, "package.json");
  const rootJson = rootPkg ? await readJson(rootPkg) : null;
  const rootManager = rootPkg ? detectPackageManager(rootJson, rootEntries, "npm") : "npm";
  if (rootPkg) packages.push({ dir: "", packageJson: rootJson, packageManager: rootManager, entries: rootEntries });
  if (isGoModule(rootEntries)) packages.push(await buildGoPackage("", rootEntries));
  if (isPythonProject(rootEntries)) packages.push(await buildPythonPackage("", rootEntries));
  if (isScriptProject(rootEntries)) packages.push(buildScriptPackage("", rootEntries));
  const rootMvnw = findFile(rootEntries, "mvnw.cmd") ? "mvnw.cmd" : null;
  const rootGradlew = findFile(rootEntries, "gradlew.bat") ? "gradlew.bat" : null;
  if (hasFile(rootEntries, "pom.xml")) packages.push(await buildJvmPackage("", rootEntries, "maven", rootMvnw));
  if (hasFile(rootEntries, "build.gradle") || hasFile(rootEntries, "build.gradle.kts") || hasFile(rootEntries, "settings.gradle") || hasFile(rootEntries, "settings.gradle.kts")) {
    packages.push(await buildJvmPackage("", rootEntries, "gradle", rootGradlew));
  }
  const rootSubs = rootEntries.filter((entry) => entry && entry.isDirectory === true && !SCAN_SKIP_DIRS.has(String(entry.name || "").toLowerCase()));
  const nested = await mapPool(rootSubs, 8, (sub) => {
    if (packages.length >= MAX_PACKAGES) return [];
    return inspectDirectory(sub.path, [sub.name], 1, rootManager, rootMvnw, rootGradlew);
  });
  for (const list of nested) {
    if (!Array.isArray(list)) continue;
    for (const pkg of list) {
      if (packages.length >= MAX_PACKAGES) break;
      packages.push(pkg);
    }
  }
  return { rootPath, ...detectProjectCommands(packages) };
}

/**
 * 包目录 → 分组显示名：根包返回 null（由渲染层用「根目录」本地化文案），子包返回目录路径。
 * @description 分组名只用目录路径：同一目录下若同时存在 Go（服务端）与 Node（前端）两组命令，
 *   会归入同一分组标题，靠排序（服务端在前）区分先后，不额外插入生态标题行。
 * @param dir 相对根目录的 POSIX 路径（根包为 ""）
 * @returns 分组标题原文；根包返回 null
 */
function nodeGroupLabel(dir: string): string | null {
  return dir || null;
}

/**
 * 比较两个生态分组：先比目录层级（父包在前），再比服务端/前端优先级（服务端在前），最后按字典序。
 * @description 多标记文件时命令按包（目录）分组且父包先于子包；用户规矩要求同一层级内
 *   服务端（Go/Wails）展示在前端（Node）之前。目录遍历顺序不保证，故显式排序。
 * @param a 生态项
 * @param b 生态项
 * @returns 比较结果（负数 a 在前）
 */
function compareEcosystem(a: EcosystemGroup, b: EcosystemGroup): number {
  const dirA = (a && a.dir) || "";
  const dirB = (b && b.dir) || "";
  const depthA = dirA ? dirA.split("/").length : 0;
  const depthB = dirB ? dirB.split("/").length : 0;
  if (depthA !== depthB) return depthA - depthB;
  const priorityA = ECOSYSTEM_PRIORITY[(a && a.kind) || ""] ?? 2;
  const priorityB = ECOSYSTEM_PRIORITY[(b && b.kind) || ""] ?? 2;
  if (priorityA !== priorityB) return priorityA - priorityB;
  return dirA < dirB ? -1 : dirA > dirB ? 1 : 0;
}

/**
 * 判断命令是否应进入顶栏运行配置列表。
 * @description 脚本命令（bat/sh/ps1）默认**不进**顶栏下拉——只在文件里提供行内 ▶；
 *   手动点过 ▶ 的命令由调用方（index.js）单独并入下拉。
 *   根 JVM 项目的 test/package/build 等公共命令只显示一次；子模块只显示真实
 *   源码 main 和 Android 专用任务。子模块的完整 test/package 仍保留在 ecosystem.commands，
 *   供模块级数据和后续入口使用，但不再污染顶栏的扁平列表。
 */
function isVisibleInTopbar(eco: EcosystemGroup, command: RunCommand, dir: string, commands: RunCommand[]): boolean {
  if (eco.kind === "script") return false;
  if (eco.kind !== "maven" && eco.kind !== "gradle") return true;
  if (!dir) {
    // Gradle application 已有源码 main 时，隐藏无具体入口的通用 run，避免同一入口出现两次。
    return !(command.runKind === "gradle-application" && commands.some((item) => item.mainClass));
  }
  return command.runKind === "spring-boot" || command.runKind === "gradle-application-main" || command.runKind === "android-task";
}

/**
 * 各生态的包管理 / 构建清单与锁文件名（小写裸文件名）。
 * @description 与项目识别链路（`package.json` / `go.mod` / `pom.xml` / `pyproject.toml` / gradle 脚本 /
 *   Taskfile / wails.json）保持一致，另收录各自的锁文件；脚本（bat/ps1/sh）没有清单文件，故不在此列。
 */
const PACKAGE_MANIFEST_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "bun.lock",
  "bun.lockb",
  "go.mod",
  "go.sum",
  "go.work",
  "taskfile.yml",
  "taskfile.yaml",
  "wails.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "pipfile",
  "pipfile.lock",
  "uv.lock",
  "poetry.lock",
  "pdm.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
]);

/**
 * 判断是否为某个生态的包管理 / 构建清单文件（只看裸文件名，不含路径）。
 * @description 供代码查看器决定右键是否给出「运行」分组——清单文件代表一个可运行的包。
 * @param name 文件名（大小写与分隔符不限）
 * @returns 是清单/锁文件返回 true
 */
export function isPackageManifestFile(name: string | null | undefined): boolean {
  const value = String(name || "").toLowerCase();
  if (!value) return false;
  return PACKAGE_MANIFEST_NAMES.has(value) || /^requirements(?:[.-].+)?\.txt$/.test(value);
}

/**
 * 汇总所有包的可见命令为扁平列表（供右键菜单 / 运行控件直接渲染）。
 * @description JVM 多模块保留模块层级信息，但顶栏只显示根项目公共命令和模块真实入口；
 *   模块的 test/package/build 不在顶栏重复展开。
 * @param projectCommands 识别结果
 * @param options includeHidden=true 时返回所有模块 main，供代码查看器匹配源码行
 * @returns 扁平命令列表（已按包层级与生态优先级排序）
 */
export function flattenCommands(projectCommands: ProjectCommandsSummary | null | undefined, options: FlattenCommandsOptions = {}): FlatRunCommand[] {
  const out: FlatRunCommand[] = [];
  const includeHidden = options.includeHidden === true;
  const ecosystems = projectCommands && Array.isArray(projectCommands.ecosystems) ? projectCommands.ecosystems : [];
  const ordered = [...ecosystems].sort(compareEcosystem);
  for (const eco of ordered) {
    const dir = eco.dir || "";
    const group = nodeGroupLabel(dir);
    const commands = Array.isArray(eco.commands) ? eco.commands : [];
    for (const command of commands) {
      if (!includeHidden && !isVisibleInTopbar(eco, command, dir, commands)) continue;
      out.push({ ...command, ecosystem: eco.id, dir, group });
    }
  }
  return out;
}
