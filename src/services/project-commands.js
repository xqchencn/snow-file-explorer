/**
 * 项目识别与命令生成服务 (src/services/project-commands.js)
 *
 * 职责：
 *   1. 纯函数 detectProjectCommands：由目录条目（+ 已读取的标识文件内容）识别生态并生成命令。
 *   2. 异步扫描 ensureProjectCommands：只扫根目录 + 一级子目录（与现有 Java 检测同一范围），
 *      懒加载并缓存结果，避免重复 IO。
 *
 * 设计要点：
 *   - 检测流程与生态解耦，生态定义见 services/ecosystems.js 的 ECOSYSTEMS 注册表。
 *   - 纯函数不触碰 window/DOM，便于单测；异步扫描负责 IO 与缓存。
 */

import { readDirectoryEntries } from "./file-service.js";
import { ECOSYSTEMS } from "./ecosystems.js";

/**
 * 规范化根目录键：统一分隔符、小写、去尾部分隔符。
 * @param {string} p 路径
 * @returns {string}
 */
function rootKey(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
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
 * 从一批目录条目中提取「文件名 → 条目」映射（仅直接子文件，不含目录）。
 * @param {Array} entries 目录条目
 * @returns {Map<string, Object>}
 */
function indexFilesByName(entries) {
  const map = new Map();
  if (!Array.isArray(entries)) return map;
  for (const entry of entries) {
    if (!entry || typeof entry.name !== "string" || entry.isDirectory === true) continue;
    map.set(entry.name, entry);
  }
  return map;
}

/**
 * 纯函数：识别项目生态并生成可运行命令。
 * @description 只做判定与命令生成，不做 IO；marker 文件内容通过 fileContents 注入。
 * @param {Array<{name: string, path?: string, isDirectory?: boolean}>} rootEntries 根目录直接子条目
 * @param {Object} [options]
 * @param {Record<string, string>} [options.fileContents] 标识文件名 → 文本内容（如 package.json）
 * @returns {{ecosystems: Array<{id: string, label: string, markers: string[], entry: string|null, commands: Array}>, scannedAt: number}}
 */
export function detectProjectCommands(rootEntries, options = {}) {
  const entries = Array.isArray(rootEntries) ? rootEntries : [];
  const fileContents = options.fileContents && typeof options.fileContents === "object" ? options.fileContents : {};
  const filesByName = indexFilesByName(entries);

  const matched = [];
  for (const eco of ECOSYSTEMS) {
    const hitMarkers = eco.markers.filter((name) => filesByName.has(name));
    if (!hitMarkers.length) continue;

    // 解析该生态需要读取内容的标识文件（一期仅 node 的 package.json）。
    let packageJson = null;
    const readFile = (eco.readFiles || []).find((name) => filesByName.has(name));
    if (readFile && typeof fileContents[readFile] === "string") {
      try {
        packageJson = JSON.parse(fileContents[readFile]);
      } catch {
        packageJson = null; // 解析失败：仅保留生态标签，不产命令
      }
    }

    const entry =
      typeof eco.resolveEntry === "function"
        ? eco.resolveEntry(packageJson, entries)
        : null;

    const ctx = { packageJson, entries, entry };
    const commands = typeof eco.commands === "function" ? eco.commands(ctx) || [] : [];

    matched.push({
      id: eco.id,
      label: eco.label,
      markers: hitMarkers,
      entry,
      commands,
    });
  }

  return { ecosystems: matched, scannedAt: Date.now() };
}

/**
 * 异步扫描工作区，识别项目并生成命令。
 * @description 扫描范围：根目录 + 一级子目录（仅用于判断子目录是否存在，
 *   不递归），与现有 detectJavaProject 的边界一致，避免 node_modules 等导致卡顿。
 *   需要读取内容的标识文件（package.json）只读根目录那一份。
 * @param {string} rootPath 工作区根目录绝对路径
 * @returns {Promise<{rootPath: string, ecosystems: Array, scannedAt: number}>}
 */
export async function scanProjectCommands(rootPath) {
  const empty = { rootPath: rootPath || "", ecosystems: [], scannedAt: Date.now() };
  if (!rootPath) return empty;

  let rootEntries;
  try {
    rootEntries = await readDirectoryEntries(rootPath);
  } catch {
    return empty;
  }
  if (!Array.isArray(rootEntries)) return empty;

  // 读取根目录下所有被注册表声明为「需读内容」的标识文件。
  const readNames = new Set();
  for (const eco of ECOSYSTEMS) {
    for (const name of eco.readFiles || []) readNames.add(name);
  }
  const fileContents = {};
  const snow = typeof window !== "undefined" ? window.snow : null;
  const canRead = snow && typeof snow.readFileContent === "function";
  if (canRead) {
    for (const name of readNames) {
      const entry = rootEntries.find((e) => e && e.name === name && e.isDirectory !== true);
      if (!entry || !entry.path) continue;
      try {
        const result = await snow.readFileContent(entry.path);
        if (result && typeof result.content === "string" && !result.isBinary) {
          fileContents[name] = result.content;
        }
      } catch {
        // 读取失败不影响识别：退化为仅凭文件名判定
      }
    }
  }

  const detected = detectProjectCommands(rootEntries, { fileContents });
  return { rootPath, ...detected };
}

/**
 * 汇总所有生态的命令为扁平列表（供右键菜单直接渲染）。
 * @param {Object|null} projectCommands 识别结果
 * @returns {Array<{id: string, labelKey: string|null, labelFallback: string, cmd: string, ecosystem: string}>}
 */
export function flattenCommands(projectCommands) {
  const out = [];
  const ecosystems = projectCommands && Array.isArray(projectCommands.ecosystems) ? projectCommands.ecosystems : [];
  for (const eco of ecosystems) {
    for (const command of eco.commands || []) {
      out.push({ ...command, ecosystem: eco.id });
    }
  }
  return out;
}
