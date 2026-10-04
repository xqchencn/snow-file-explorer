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
const ECOSYSTEM_PRIORITY = { go: 0, node: 1 };

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

  /** 读取文本文件内容；读取失败或二进制返回 null（识别只在读得到文本时才产命令）。 */
  const readText = async (entry) => {
    if (!canRead || !entry || !entry.path) return null;
    try {
      const result = await snow.readFileContent(entry.path);
      if (result && typeof result.content === "string" && !result.isBinary) return result.content;
    } catch {
      // 读取失败：不产命令
    }
    return null;
  };

  /** 读取并解析 package.json；解析失败返回 null（仅保留包标记，不产命令）。 */
  const readPackageJson = async (entry) => {
    const text = await readText(entry);
    if (text == null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  /** 该目录是否为 Go module：有 go.mod，或（根目录/无 package.json 时）有 Taskfile / wails.json。 */
  const isGoModule = (entries) => {
    const has = (name) => entries.some((e) => e && e.name === name && e.isDirectory !== true);
    return has("go.mod") || has("Taskfile.yml") || has("Taskfile.yaml") || has("wails.json");
  };

  /** 收集 go 包识别信息：探测 wails 版本（wails.json / go.mod 依赖）与 cmd/ 入口候选。 */
  const buildGoPackage = async (dirRel, entries) => {
    const findFile = (name) => entries.find((e) => e && e.name === name && e.isDirectory !== true);
    const goModText = (await readText(findFile("go.mod"))) || "";
    // 标准布局的入口候选：cmd/ 下的子目录名（每个通常是一个 main 包）。
    // 根无 main.go 时生成 `go run ./cmd/<name>`；根有 main.go 时走 `go run .`（见 readGoCommands）。
    const cmdEntry = entries.find((e) => e && e.name === "cmd" && e.isDirectory === true);
    let cmdDirs = [];
    if (cmdEntry) {
      try {
        const cmdChildren = await readDirectoryEntries(cmdEntry.path);
        cmdDirs = (Array.isArray(cmdChildren) ? cmdChildren : [])
          .filter((e) => e && e.isDirectory === true && e.name)
          .map((e) => e.name);
      } catch {
        cmdDirs = [];
      }
    }
    return {
      dir: dirRel,
      ecosystem: "go",
      entries,
      hasWails2: Boolean(findFile("wails.json")),
      hasWails3: /wailsapp\/wails\/v3/.test(goModText),
      cmdDirs,
    };
  };

  const walk = async (dirPath, relNames, depth, inheritedManager = "npm") => {
    if (depth > MAX_SCAN_DEPTH || packages.length >= MAX_PACKAGES) return;
    let entries;
    try {
      entries = await readDirectoryEntries(dirPath);
    } catch {
      return;
    }
    if (!Array.isArray(entries)) return;

    // 独立的 go 测试模块（xxx/tests 自带 go.mod）：不是产品入口，整体跳过（不下探、不产命令）。
    const lastSeg = relNames[relNames.length - 1];
    if (relNames.length > 0 && GO_TEST_DIRS.has(lastSeg) && isGoModule(entries)) return;

    const pkgEntry = entries.find((e) => e && e.name === "package.json" && e.isDirectory !== true);
    const packageJson = pkgEntry ? await readPackageJson(pkgEntry) : null;
    // workspace 子包默认继承根包管理器；子包自己的 packageManager / 锁文件可以显式覆盖。
    const packageManager = pkgEntry
      ? detectPackageManager(packageJson, entries, inheritedManager)
      : inheritedManager;
    // 同一目录可同时是 Node 包与 Go module（如 wails 项目根目录既有 package.json 又有 go.mod），
    // 两个生态都要收集，不能用 else——否则有 package.json 就漏掉 Go/Wails。
    if (pkgEntry) {
      packages.push({
        dir: joinRel(relNames),
        packageJson,
        packageManager,
        entries,
      });
    }
    if (isGoModule(entries)) {
      packages.push(await buildGoPackage(joinRel(relNames), entries));
    }

    const subDirs = entries.filter((e) => e && e.isDirectory === true && !SCAN_SKIP_DIRS.has(e.name));
    for (const sub of subDirs) {
      if (packages.length >= MAX_PACKAGES) break;
      await walk(sub.path, relNames.concat(sub.name), depth + 1, packageManager);
    }
  };

  let rootEntries;
  try {
    rootEntries = await readDirectoryEntries(rootPath);
  } catch {
    return empty;
  }
  if (!Array.isArray(rootEntries)) return empty;

  // 已在根目录列出条目：直接复用，避免 walk 再列一次根目录。
  const rootPkgEntry = rootEntries.find((e) => e && e.name === "package.json" && e.isDirectory !== true);
  let rootPackageManager = "npm";
  if (rootPkgEntry) {
    const rootPackageJson = await readPackageJson(rootPkgEntry);
    rootPackageManager = detectPackageManager(rootPackageJson, rootEntries, "npm");
    packages.push({
      dir: "",
      packageJson: rootPackageJson,
      packageManager: rootPackageManager,
      entries: rootEntries,
    });
  }
  // 根目录也可能同时是 Go module（wails 项目根既有 package.json 又有 go.mod）：两个生态都收。
  if (isGoModule(rootEntries)) {
    packages.push(await buildGoPackage("", rootEntries));
  }
  for (const sub of rootEntries.filter((e) => e && e.isDirectory === true && !SCAN_SKIP_DIRS.has(e.name))) {
    if (packages.length >= MAX_PACKAGES) break;
    await walk(sub.path, [sub.name], 1, rootPackageManager);
  }

  const detected = detectProjectCommands(packages);
  return { rootPath, ...detected };
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
 * 汇总所有包的命令为扁平列表（供右键菜单 / 运行控件直接渲染）。
 * @description 每条命令携带 `dir`（所属包目录，根包 ""）与 `group`（分组显示名，根包 null），
 *   且整体按「父包在前」排序：渲染层据此按文件夹分组、并在组名变化处插入分组标题。
 * @param {Object|null} projectCommands 识别结果
 * @returns {Array<{id: string, labelKey: string|null, labelFallback: string, cmd: string, ecosystem: string, dir: string, group: string|null}>}
 */
export function flattenCommands(projectCommands) {
  const out = [];
  const ecosystems = projectCommands && Array.isArray(projectCommands.ecosystems) ? projectCommands.ecosystems : [];
  const ordered = [...ecosystems].sort(compareEcosystem);
  for (const eco of ordered) {
    const dir = eco.dir || "";
    const group = nodeGroupLabel(dir);
    for (const command of eco.commands || []) {
      out.push({ ...command, ecosystem: eco.id, dir, group });
    }
  }
  return out;
}
