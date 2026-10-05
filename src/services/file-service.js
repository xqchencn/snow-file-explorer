/**
 * 文件系统服务模块 (src/services/file-service.js)
 * 统一封装与宿主 window.snow 的文件及目录读取 API，并提供排序与路径工具
 */

import { mapPool } from "../utils/async.js";

/**
 * 获取文件或路径的基准名称 (basename)
 * @param {string} p 文件路径
 * @returns {string}
 */
export function basename(p) {
  const s = String(p || "").replace(/[/\\]+$/, "");
  const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return idx >= 0 ? s.slice(idx + 1) : s;
}

/**
 * 获取文件扩展名 (不含点，全部小写)
 * @param {string} fileNameOrPath 文件名或路径
 * @returns {string}
 */
export function extname(fileNameOrPath) {
  const base = basename(fileNameOrPath);
  const dot = base.lastIndexOf(".");
  if (dot > 0) return base.slice(dot + 1).toLowerCase();
  if (dot === 0 && base.length > 1) return base.slice(1).toLowerCase();
  return "";
}

/**
 * 规范化目录条目列表并按“文件夹在前、名称升序”规则排序
 * @param {Array<{name: string, isDirectory?: boolean, path: string}>} entries
 * @returns {Array} 排序后的条目列表
 */
export function sortEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return [...entries].sort((a, b) => {
    const aDir = !!a.isDirectory;
    const bDir = !!b.isDirectory;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return String(a.name || "").localeCompare(String(b.name || ""), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

/**
 * 读取指定目录的直接子条目列表
 * @param {string} dirPath 目录绝对路径
 * @returns {Promise<Array>}
 */
export async function readDirectoryEntries(dirPath) {
  const snow = window.snow;
  if (!snow || typeof snow.readDirectoryEntries !== "function" || !dirPath) {
    return [];
  }
  return await snow.readDirectoryEntries(dirPath);
}

/**
 * 读取文件内容（文本 / 图片 / 二进制）
 * @description 宿主真实 preload API 为 window.snow.readFileContent，返回 FileContentResult：
 *   { content, isBinary, isImage, isSvg, mimeType, encoding, size }。
 *   文本文件的 content 为文本；图片与二进制的 content 为 base64。
 * @param {string} filePath 文件绝对路径
 * @returns {Promise<Object|null>} FileContentResult；接口不可用时返回 null
 */
export async function readFileContent(filePath) {
  const snow = window.snow;
  if (!snow || typeof snow.readFileContent !== "function" || !filePath) {
    return null;
  }
  return await snow.readFileContent(filePath);
}

/**
 * 执行插件文件系统写动作，并把宿主的失败响应统一转换为 ok:false。
 * @param {Object|null} api Snow App 插件运行时 API
 * @param {string} actionId filesystem 写动作名称
 * @param {Object} params 动作参数
 * @param {string} unavailableMessage 宿主未提供动作时的错误文案
 * @returns {Promise<{ok: boolean, data?: unknown, denied?: Object, error?: string}>}
 */
export async function runWriteAction(
  api,
  actionId,
  params,
  unavailableMessage = "当前宿主未提供文件操作能力"
) {
  const run = api && api.write && api.write.run;
  if (typeof run !== "function") {
    return { ok: false, error: unavailableMessage };
  }
  try {
    const result = await run(`filesystem.${actionId}`, params);
    if (result && result.ok === true) return result;
    return {
      ...(result && typeof result === "object" ? result : {}),
      ok: false,
      error: result && result.error ? String(result.error) : "文件操作失败",
    };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * 重命名工作区文件或目录。
 * @param {Object|null} api Snow App 插件运行时 API
 * @param {string} rootPath 工作区根目录
 * @param {string} entryPath 条目路径
 * @param {string} newName 新名称
 * @returns {Promise<{ok: boolean, data?: unknown, error?: string}>}
 */
export function renameFileSystemEntry(api, rootPath, entryPath, newName) {
  return runWriteAction(
    api,
    "rename",
    { rootPath, entryPath, newName },
    "当前宿主未提供文件重命名能力"
  );
}

/**
 * 删除工作区文件或目录。
 * @param {Object|null} api Snow App 插件运行时 API
 * @param {string} rootPath 工作区根目录
 * @param {string} entryPath 要删除的条目路径
 * @returns {Promise<{ok: boolean, data?: unknown, error?: string}>}
 */
export function deleteFileSystemEntry(api, rootPath, entryPath) {
  return runWriteAction(
    api,
    "delete",
    { rootPath, entryPath },
    "当前宿主未提供文件删除能力"
  );
}

/**
 * 计算工作区内路径的相对路径。
 * @description 使用 Windows 分隔符做大小写不敏感的边界比较，避免把 `repo2` 误判为 `repo` 子路径。
 * @param {string} fromRoot 工作区根路径
 * @param {string} targetPath 目标路径
 * @returns {string|null} 统一使用 `/` 的相对路径；越界或路径无效时返回 null
 */
export function relativePath(fromRoot, targetPath) {
  const normalize = (value) => {
    const text = String(value || "").trim().replace(/\//g, "\\");
    if (!text || !/^(?:[A-Za-z]:\\|\\\\|\\)/.test(text)) return null;
    const isDriveRoot = /^[A-Za-z]:\\$/.test(text);
    return text.length > 1 && !isDriveRoot ? text.replace(/\\+$/, "") : text;
  };
  const root = normalize(fromRoot);
  const target = normalize(targetPath);
  if (!root || !target) return null;

  const rootKey = root.toLowerCase();
  const targetKey = target.toLowerCase();
  if (targetKey === rootKey) return ".";
  const prefix = root.endsWith("\\") ? root : root + "\\";
  if (!targetKey.startsWith(prefix.toLowerCase())) return null;

  const relative = target.slice(prefix.length).replace(/\\+/g, "/");
  if (!relative || relative.split("/").some((segment) => segment === "..")) return null;
  return relative;
}

/**
 * 写入文本文件内容
 * @description 插件 ESM 运行时通过 api.write.run("filesystem.writeFile", params) 执行真实写入，宿主参数名为 filePath。
 *   宿主未提供能力或动作失败时统一返回 ok:false，调用方不得伪造保存成功。
 * @param {Object|null} api Snow App 插件运行时 API
 * @param {string} filePath 文件绝对路径
 * @param {string} content 要写入的完整文本
 * @returns {Promise<{ok: boolean, data?: unknown, denied?: Object, error?: string}>}
 */
export function writeFileContent(api, filePath, content) {
  return runWriteAction(
    api,
    "writeFile",
    { filePath, content: String(content ?? "") },
    "当前宿主未提供文件写入能力"
  );
}

/* JVM 项目检测服务定义如下。 */

/**
 * JVM 项目根目录中可作为构建系统证据的文件名。
 * @description 这些文件只说明项目属于 Java/Kotlin JVM 生态；真正的包视图仍只对
 *   `sourceRoots` 下的 Java/Kotlin 文件生效，避免把普通目录误判为 JVM 项目。
 * @type {ReadonlyMap<string, string>}
 */
export const JVM_BUILD_FILES = Object.freeze(
  new Map([
    ["pom.xml", "maven"],
    ["build.gradle", "gradle"],
    ["build.gradle.kts", "gradle"],
    ["settings.gradle", "gradle"],
    ["settings.gradle.kts", "gradle"],
    ["gradlew", "gradle"],
    ["gradlew.bat", "gradle"],
  ])
);

// 保留旧导出名，已有调用方继续复用同一套 JVM 构建文件判定。
export const JAVA_BUILD_FILES = JVM_BUILD_FILES;

/**
 * 读取条目名称，忽略宿主 API 可能返回的脏数据。
 * @param {Array} entries 目录直接子条目
 * @returns {Array<{name: string, isDirectory: boolean}>}
 */
function normalizeProjectEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => entry && typeof entry.name === "string");
}

/**
 * 从已读取的目录信息判断其是否具备 Java/Kotlin JVM 项目证据。
 * @param {Array} entries 项目根目录直接子条目
 * @param {Array<string>} sourceRoots 已发现的标准 Java/Kotlin 源码根目录
 * @returns {{isJavaProject: boolean, isJvmProject: boolean, confidence: "strong"|"weak"|"none", buildSystem: string|null, buildFiles: string[], sourceRoots: string[], javaFileCount: number, kotlinFileCount: number, jvmFileCount: number, evidence: string[]}}
 */
export function detectJvmProjectFromEntries(entries, sourceRoots = []) {
  const items = normalizeProjectEntries(entries);
  const buildFiles = [];
  const buildSystems = new Set();
  let javaFileCount = 0;
  let kotlinFileCount = 0;

  for (const entry of items) {
    const name = entry.name.toLowerCase();
    const buildSystem = JVM_BUILD_FILES.get(name);
    if (buildSystem) {
      buildFiles.push(entry.name);
      buildSystems.add(buildSystem);
    }
    if (!entry.isDirectory && entry.name !== ".java" && /\.java$/i.test(entry.name)) {
      javaFileCount++;
    }
    if (!entry.isDirectory && entry.name !== ".kt" && /\.kt$/i.test(entry.name)) {
      kotlinFileCount++;
    }
  }

  const roots = Array.isArray(sourceRoots) ? [...new Set(sourceRoots.filter(Boolean))] : [];
  const evidence = [];
  if (buildFiles.length) evidence.push("build-file");
  if (roots.length) evidence.push("standard-source-root");
  if (javaFileCount >= 2) evidence.push("multiple-java-files");
  if (kotlinFileCount >= 2) evidence.push("multiple-kotlin-files");

  // 构建文件或标准源码根目录是强信号；单个 Java/Kotlin 文件不足以判定项目类型。
  const jvmFileCount = javaFileCount + kotlinFileCount;
  const isJavaProject = buildFiles.length > 0 || roots.length > 0 || jvmFileCount >= 2;
  return {
    isJavaProject,
    isJvmProject: isJavaProject,
    confidence: buildFiles.length || roots.length ? "strong" : jvmFileCount >= 2 ? "weak" : "none",
    buildSystem: buildSystems.size === 1 ? [...buildSystems][0] : buildSystems.size > 1 ? "mixed" : null,
    buildFiles,
    sourceRoots: roots,
    javaFileCount,
    kotlinFileCount,
    jvmFileCount,
    evidence,
  };
}

/**
 * 根目录列表里是否已经能看出 JVM 工程（构建文件或根上的 Java/Kotlin 源文件）。
 * @param {Array} entries 根目录直接子条目
 * @returns {boolean}
 */
export function hasJvmRootMarker(entries) {
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    if (!entry || entry.isDirectory) continue;
    const name = String(entry.name || "");
    if (JVM_BUILD_FILES.has(name)) return true;
    if (/\.(java|kt)$/i.test(name)) return true;
  }
  return false;
}

/**
 * 在有限范围内检测 Java/Kotlin JVM 项目。
 * @description 根目录没有构建文件或 Java/Kotlin 源文件时直接返回，不再列子目录。
 *   调用方已经列过根目录时传入 knownRootEntries，避免再读一次。
 * @param {string} rootPath 项目根目录绝对路径
 * @param {Array} [knownRootEntries] 已经读到的根目录条目
 * @returns {Promise<ReturnType<typeof detectJvmProjectFromEntries>>}
 */
export async function detectJvmProject(rootPath, knownRootEntries) {
  const empty = detectJvmProjectFromEntries([]);
  if (!rootPath) return empty;

  let rootEntries = knownRootEntries;
  if (!Array.isArray(rootEntries)) {
    try {
      rootEntries = await readDirectoryEntries(rootPath);
    } catch {
      return empty;
    }
  }

  const rootItems = normalizeProjectEntries(rootEntries);
  if (!hasJvmRootMarker(rootItems)) return detectJvmProjectFromEntries(rootItems, []);

  const roots = [];
  const seenPaths = new Set();

  async function addSourceRoot(basePath, baseEntries, segments) {
    const sourcePath = await findDirectoryFromEntries(basePath, baseEntries, segments);
    if (sourcePath && !seenPaths.has(sourcePath)) {
      seenPaths.add(sourcePath);
      roots.push(sourcePath);
    }
  }

  async function findDirectoryFromEntries(basePath, baseEntries, segments) {
    let currentPath = basePath;
    let entries = baseEntries;
    for (const segment of segments) {
      const match = entries.find((entry) => entry.isDirectory && entry.name === segment);
      if (!match || !match.path) return null;
      currentPath = match.path;
      try {
        entries = normalizeProjectEntries(await readDirectoryEntries(currentPath));
      } catch {
        return null;
      }
    }
    return currentPath;
  }

  // 根模块与一级子模块均检查标准源码根目录，不递归探测任意深度目录。
  const moduleDirs = rootItems.filter(
    (entry) =>
      entry.isDirectory &&
      !entry.name.startsWith(".") &&
      !["node_modules", "target", "build", "out", "dist"].includes(entry.name)
  );
  const nestedModules = await mapPool(moduleDirs, 8, async (entry) => {
    try {
      return { path: entry.path, entries: normalizeProjectEntries(await readDirectoryEntries(entry.path)) };
    } catch {
      return null;
    }
  });
  const moduleBases = [{ path: rootPath, entries: rootItems }];
  for (const module of nestedModules) {
    if (module) moduleBases.push(module);
  }
  for (const module of moduleBases) {
    await addSourceRoot(module.path, module.entries, ["src", "main", "java"]);
    await addSourceRoot(module.path, module.entries, ["src", "main", "kotlin"]);
    await addSourceRoot(module.path, module.entries, ["src", "test", "java"]);
    await addSourceRoot(module.path, module.entries, ["src", "test", "kotlin"]);
  }

  return detectJvmProjectFromEntries(rootItems, roots);
}

// 保留旧导出名，已有调用方和测试继续复用同一套 JVM 检测实现。
export const detectJavaProjectFromEntries = detectJvmProjectFromEntries;
export const detectJavaProject = detectJvmProject;

/**
 * 从 api.metadata.get 的响应中解析当前激活项目目录
 * @description 宿主契约：api.metadata.get(domain | domain[]) 返回包裹对象
 *   { generatedAt, domains, denied, withheld, unknown }，数据位于 response.domains[domainId]。
 *   domains.projects.active 即激活项目记录；与 domains.runtime.activeDirectory 等价。
 * @param {Object|null} response api.metadata.get 的返回对象
 * @returns {string} 激活项目绝对路径；未找到时返回空字符串
 */
export function resolveActiveDirectoryPath(response) {
  const domains = (response && response.domains) || {};
  const candidates = [
    domains.projects && domains.projects.active,
    domains.runtime && domains.runtime.activeDirectory,
  ];
  for (const directory of candidates) {
    if (directory && typeof directory.path === "string" && directory.path) {
      return directory.path;
    }
  }
  return "";
}
