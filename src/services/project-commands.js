/**
 * 项目识别与命令生成服务 (src/services/project-commands.js)
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

import { readDirectoryEntries } from "./file-service.js";
import {
  readNodeScripts,
  nodeEntryFallback,
  detectPackageManager,
  readWails2Commands,
  readWails3Commands,
  readGoCommands,
  findJavaMainCandidates,
  readMavenCommands,
  readGradleCommands,
} from "./ecosystems.js";

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
const ECOSYSTEM_PRIORITY = { go: 0, maven: 1, gradle: 1, node: 2 };

/**
 * 规范化根目录键：统一分隔符、小写、去尾部分隔符。
 * @param {string} p 路径
 * @returns {string}
 */
function rootKey(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

/** 把目录名数组拼成 POSIX 相对路径，用于包分组和工作目录计算。 */
function joinRel(dirNames) {
  return dirNames.filter(Boolean).join("/");
}

/**
 * 懒加载入口：按根目录缓存识别结果。
 * @description 同一根目录内命中缓存即返回，切换项目根目录才重新扫描。
 * @param {{projectCommands: Object|null}} state 面板状态（就地读写）
 * @param {string} rootPath 工作区根目录
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<Object|null>} 识别结果；无根目录时返回 null
 */
export async function ensureProjectCommands(state, rootPath, opts = {}) {
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
 * @param {{entries?: Array, cmdDirs?: string[], hasWails2?: boolean, hasWails3?: boolean}} pkg go 条目
 * @param {string} prefix 相对根目录的 POSIX 路径（根目录 ""）
 * @returns {Array} 与 Node 命令同构的命令数组
 */
function buildGoCommands(pkg, prefix) {
  if (pkg.hasWails3) return readWails3Commands({ prefix });
  if (pkg.hasWails2) return readWails2Commands({ prefix });
  return readGoCommands(pkg.entries, { prefix, cmdDirs: pkg.cmdDirs });
}

function buildJvmCommands(pkg, prefix) {
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
function buildJvmEcosystem(pkg, prefix) {
  const kind = pkg.ecosystem;
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
 * @param {Array<{dir: string, ecosystem?: string, packageJson?: Object|null, entries?: Array, packageManager?: string, taskNames?: string[], hasWails2?: boolean, hasWails3?: boolean}>} packages 包列表
 * @returns {{ecosystems: Array, packages: Array, scannedAt: number}}
 */
export function detectProjectCommands(packages) {
  const list = Array.isArray(packages) ? packages : [];
  const ecosystems = [];
  const summary = [];

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
 * @param {string} rootPath 工作区根目录绝对路径
 * @returns {Promise<{rootPath: string, ecosystems: Array, packages: Array, scannedAt: number}>}
 */
export async function scanProjectCommands(rootPath) {
  const empty = { rootPath: rootPath || "", ecosystems: [], packages: [], scannedAt: Date.now() };
  if (!rootPath) return empty;

  const snow = typeof window !== "undefined" ? window.snow : null;
  const canRead = snow && typeof snow.readFileContent === "function";
  const packages = [];
  const MAX_SOURCE_FILES = 240;

  const readText = async (entry) => {
    if (!canRead || !entry || !entry.path) return null;
    try {
      const result = await snow.readFileContent(entry.path);
      return result && typeof result.content === "string" && !result.isBinary ? result.content : null;
    } catch {
      return null;
    }
  };
  const readJson = async (entry) => {
    const text = await readText(entry);
    if (text == null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const findFile = (entries, name) => entries.find((entry) => entry && entry.name === name && entry.isDirectory !== true);
  const findDir = (entries, name) => entries.find((entry) => entry && entry.name === name && entry.isDirectory === true);
  const hasFile = (entries, name) => Boolean(findFile(entries, name));
  const isGoModule = (entries) =>
    hasFile(entries, "go.mod") || hasFile(entries, "Taskfile.yml") || hasFile(entries, "Taskfile.yaml") || hasFile(entries, "wails.json");

  // JVM 源码只从标准源码根读取，且有文件数上限，避免扫描生成物或巨型仓库卡死。
  const collectJvmSources = async (sourceRoot, rootRel, result, budget, state) => {
    if (!sourceRoot || state.count >= budget) return;
    let entries;
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

  const findSourceRoots = async (baseEntries) => {
    const roots = [];
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

  const buildJvmPackage = async (dirRel, entries, ecosystem, inheritedWrapper) => {
    const mainCandidates = [];
    const scanState = { count: 0 };
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

  const buildGoPackage = async (dirRel, entries) => {
    const goModText = (await readText(findFile(entries, "go.mod"))) || "";
    const cmdEntry = findDir(entries, "cmd");
    let cmdDirs = [];
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

  const inspectDirectory = async (dirPath, relNames, depth, inheritedManager, inheritedMvnw, inheritedGradlew) => {
    if (depth > MAX_SCAN_DEPTH || packages.length >= MAX_PACKAGES) return;
    let entries;
    try {
      entries = await readDirectoryEntries(dirPath);
    } catch {
      return;
    }
    if (!Array.isArray(entries)) return;
    const rel = joinRel(relNames);
    const last = relNames[relNames.length - 1];
    if (relNames.length && GO_TEST_DIRS.has(last) && isGoModule(entries)) return;

    const pkgEntry = findFile(entries, "package.json");
    const packageJson = pkgEntry ? await readJson(pkgEntry) : null;
    const packageManager = pkgEntry ? detectPackageManager(packageJson, entries, inheritedManager) : inheritedManager;
    const mvnw = findFile(entries, "mvnw.cmd") ? "mvnw.cmd" : inheritedMvnw;
    const gradlew = findFile(entries, "gradlew.bat") ? "gradlew.bat" : inheritedGradlew;
    if (pkgEntry) packages.push({ dir: rel, packageJson, packageManager, entries });
    if (isGoModule(entries)) packages.push(await buildGoPackage(rel, entries));
    if (hasFile(entries, "pom.xml")) packages.push(await buildJvmPackage(rel, entries, "maven", mvnw));
    if (hasFile(entries, "build.gradle") || hasFile(entries, "build.gradle.kts") || hasFile(entries, "settings.gradle") || hasFile(entries, "settings.gradle.kts")) {
      packages.push(await buildJvmPackage(rel, entries, "gradle", gradlew));
    }
    const subDirs = entries.filter((entry) => entry && entry.isDirectory === true && !SCAN_SKIP_DIRS.has(String(entry.name || "").toLowerCase()));
    for (const sub of subDirs) {
      if (packages.length >= MAX_PACKAGES) break;
      await inspectDirectory(sub.path, relNames.concat(sub.name), depth + 1, packageManager, mvnw, gradlew);
    }
  };

  let rootEntries;
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
  const rootMvnw = findFile(rootEntries, "mvnw.cmd") ? "mvnw.cmd" : null;
  const rootGradlew = findFile(rootEntries, "gradlew.bat") ? "gradlew.bat" : null;
  if (hasFile(rootEntries, "pom.xml")) packages.push(await buildJvmPackage("", rootEntries, "maven", rootMvnw));
  if (hasFile(rootEntries, "build.gradle") || hasFile(rootEntries, "build.gradle.kts") || hasFile(rootEntries, "settings.gradle") || hasFile(rootEntries, "settings.gradle.kts")) {
    packages.push(await buildJvmPackage("", rootEntries, "gradle", rootGradlew));
  }
  for (const sub of rootEntries.filter((entry) => entry && entry.isDirectory === true && !SCAN_SKIP_DIRS.has(String(entry.name || "").toLowerCase()))) {
    if (packages.length >= MAX_PACKAGES) break;
    await inspectDirectory(sub.path, [sub.name], 1, rootManager, rootMvnw, rootGradlew);
  }
  return { rootPath, ...detectProjectCommands(packages) };
}

/**
 * 包目录 → 分组显示名：根包返回 null（由渲染层用「根目录」本地化文案），子包返回目录路径。
 * @description 分组名只用目录路径：同一目录下若同时存在 Go（服务端）与 Node（前端）两组命令，
 *   会归入同一分组标题，靠排序（服务端在前）区分先后，不额外插入生态标题行。
 * @param {string} dir 相对根目录的 POSIX 路径（根包为 ""）
 * @returns {string|null}
 */
function nodeGroupLabel(dir) {
  return dir || null;
}

/**
 * 比较两个生态分组：先比目录层级（父包在前），再比服务端/前端优先级（服务端在前），最后按字典序。
 * @description 多标记文件时命令按包（目录）分组且父包先于子包；用户规矩要求同一层级内
 *   服务端（Go/Wails）展示在前端（Node）之前。目录遍历顺序不保证，故显式排序。
 * @param {{dir?: string, kind?: string}} a 生态项
 * @param {{dir?: string, kind?: string}} b 生态项
 * @returns {number}
 */
function compareEcosystem(a, b) {
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
 * @description 根 JVM 项目的 test/package/build 等公共命令只显示一次；子模块只显示真实
 *   源码 main 和 Android 专用任务。子模块的完整 test/package 仍保留在 ecosystem.commands，
 *   供模块级数据和后续入口使用，但不再污染顶栏的扁平列表。
 */
function isVisibleJvmCommand(eco, command, dir, commands) {
  if (eco.kind !== "maven" && eco.kind !== "gradle") return true;
  if (!dir) {
    // Gradle application 已有源码 main 时，隐藏无具体入口的通用 run，避免同一入口出现两次。
    return !(command.runKind === "gradle-application" && commands.some((item) => item.mainClass));
  }
  return command.runKind === "spring-boot" || command.runKind === "gradle-application-main" || command.runKind === "android-task";
}

/**
 * 汇总所有包的可见命令为扁平列表（供右键菜单 / 运行控件直接渲染）。
 * @description JVM 多模块保留模块层级信息，但顶栏只显示根项目公共命令和模块真实入口；
 *   模块的 test/package/build 不在顶栏重复展开。
 * @param {Object|null} projectCommands 识别结果
 * @param {{includeHidden?: boolean}} [options] includeHidden=true 时返回所有模块 main，供代码查看器匹配源码行
 * @returns {Array<{id: string, labelKey: string|null, labelFallback: string, cmd: string, ecosystem: string, dir: string, group: string|null}>}
 */
export function flattenCommands(projectCommands, options = {}) {
  const out = [];
  const includeHidden = options.includeHidden === true;
  const ecosystems = projectCommands && Array.isArray(projectCommands.ecosystems) ? projectCommands.ecosystems : [];
  const ordered = [...ecosystems].sort(compareEcosystem);
  for (const eco of ordered) {
    const dir = eco.dir || "";
    const group = nodeGroupLabel(dir);
    const commands = Array.isArray(eco.commands) ? eco.commands : [];
    for (const command of commands) {
      if (!includeHidden && !isVisibleJvmCommand(eco, command, dir, commands)) continue;
      out.push({ ...command, ecosystem: eco.id, dir, group });
    }
  }
  return out;
}
