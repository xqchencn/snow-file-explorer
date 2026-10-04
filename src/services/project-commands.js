/**
 * 项目识别与命令生成服务 (src/services/project-commands.js)
 *
 * 职责：
 *   1. 纯函数 detectProjectCommands：由「已发现的包」列表生成可运行命令（无 IO，可单测）。
 *   2. 异步扫描 scanProjectCommands：递归扫工作区里的 package.json（多级目录 + 多个包），
 *      跳过大目录（node_modules/.git 等），懒加载并缓存结果。
 *
 * 设计要点：
 *   - 从「根目录命中即整体识别」改为「每个 package.json 就是一个包」：
 *       子包命令用 `npm --prefix <相对路径> run <name>`，在 cwd=工作区根目录的 shell 里正确执行。
 *   - 命令 id 带包路径前缀，避免多个包同名 script 冲突。
 */

import { readDirectoryEntries } from "./file-service.js";
import { readNodeScripts, nodeEntryFallback } from "./ecosystems.js";

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
 * 规范化根目录键：统一分隔符、小写、去尾部分隔符。
 * @param {string} p 路径
 * @returns {string}
 */
function rootKey(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

/** 把目录名数组拼成 POSIX 相对路径（供 npm --prefix）。 */
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
 * 纯函数：由「已发现的包」列表生成命令集合。
 * @description 每个包由 packageJson 内容 + 相对根目录的路径前缀（+ 该包目录条目，供根包入口兜底）描述。
 * @param {Array<{dir: string, packageJson: Object|null, entries?: Array}>} packages 包列表
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
    const commands = readNodeScripts(pkg.packageJson, { prefix });
    // 仅根包在无 scripts 时兜底为 `node <entry>`（子包不走，避免相对 cwd 的入口命令歧义）。
    const entryFallback = prefix ? [] : nodeEntryFallback(pkg.packageJson, pkg.entries);
    const finalCommands = commands.length ? commands : entryFallback;

    ecosystems.push({
      id: prefix ? `node:${prefix}` : "node",
      label: prefix ? `Node · ${prefix}` : "Node.js",
      markers: ["package.json"],
      dir: prefix,
      entry: null,
      commands: finalCommands,
    });
    summary.push({ id: prefix || "node", dir: prefix, commandCount: finalCommands.length });
  }

  return { ecosystems, packages: summary, scannedAt: Date.now() };
}

/**
 * 递归扫描工作区，发现所有 package.json 并解析为包列表。
 * @param {string} rootPath 工作区根目录绝对路径
 * @returns {Promise<{rootPath: string, ecosystems: Array, packages: Array, scannedAt: number}>}
 */
export async function scanProjectCommands(rootPath) {
  const empty = { rootPath: rootPath || "", ecosystems: [], packages: [], scannedAt: Date.now() };
  if (!rootPath) return empty;

  const snow = typeof window !== "undefined" ? window.snow : null;
  const canRead = snow && typeof snow.readFileContent === "function";
  const packages = [];

  const readPackageJson = async (entry) => {
    if (!canRead || !entry.path) return null;
    try {
      const result = await snow.readFileContent(entry.path);
      if (result && typeof result.content === "string" && !result.isBinary) {
        return JSON.parse(result.content);
      }
    } catch {
      // 解析 / 读取失败：仅保留包标记，不产命令
    }
    return null;
  };

  const walk = async (dirPath, relNames, depth) => {
    if (depth > MAX_SCAN_DEPTH || packages.length >= MAX_PACKAGES) return;
    let entries;
    try {
      entries = await readDirectoryEntries(dirPath);
    } catch {
      return;
    }
    if (!Array.isArray(entries)) return;

    const pkgEntry = entries.find((e) => e && e.name === "package.json" && e.isDirectory !== true);
    if (pkgEntry) {
      packages.push({
        dir: joinRel(relNames),
        packageJson: await readPackageJson(pkgEntry),
        entries: depth === 0 ? entries : null,
      });
    }

    const subDirs = entries.filter((e) => e && e.isDirectory === true && !SCAN_SKIP_DIRS.has(e.name));
    for (const sub of subDirs) {
      if (packages.length >= MAX_PACKAGES) break;
      await walk(sub.path, relNames.concat(sub.name), depth + 1);
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
  if (rootPkgEntry) {
    packages.push({ dir: "", packageJson: await readPackageJson(rootPkgEntry), entries: rootEntries });
  }
  for (const sub of rootEntries.filter((e) => e && e.isDirectory === true && !SCAN_SKIP_DIRS.has(e.name))) {
    if (packages.length >= MAX_PACKAGES) break;
    await walk(sub.path, [sub.name], 1);
  }

  const detected = detectProjectCommands(packages);
  return { rootPath, ...detected };
}

/**
 * 包目录 → 分组显示名：根包返回 null（由渲染层用「根目录」本地化文案），子包返回目录路径。
 * @param {string} dir 相对根目录的 POSIX 路径（根包为 ""）
 * @returns {string|null}
 */
function nodeGroupLabel(dir) {
  return dir || null;
}

/**
 * 比较两个包目录：先比层级（父包在前），同层按字典序。
 * @description 多 package.json 时命令必须按包分组且父包先于子包；
 *   目录遍历顺序天然满足（父目录先访问），但缓存 / 后续合并不保证，故显式排序。
 * @param {string} a 包目录（根包 ""）
 * @param {string} b 包目录
 * @returns {number}
 */
function compareGroupDir(a, b) {
  const depthA = a ? a.split("/").length : 0;
  const depthB = b ? b.split("/").length : 0;
  if (depthA !== depthB) return depthA - depthB;
  return a < b ? -1 : a > b ? 1 : 0;
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
  const ordered = [...ecosystems].sort((x, y) => compareGroupDir(x.dir || "", y.dir || ""));
  for (const eco of ordered) {
    const dir = eco.dir || "";
    const group = nodeGroupLabel(dir);
    for (const command of eco.commands || []) {
      out.push({ ...command, ecosystem: eco.id, dir, group });
    }
  }
  return out;
}
