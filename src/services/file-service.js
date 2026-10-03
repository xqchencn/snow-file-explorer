/**
 * 文件系统服务模块 (src/services/file-service.js)
 * 统一封装与宿主 window.snow 的文件及目录读取 API，并提供排序与路径工具
 */

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
 * 从 api.metadata.get 的响应中解析当前激活项目目录
 * @description 宿主契约：api.metadata.get(domain | domain[]) 返回包裹对象
 *   { generatedAt, domains, denied, withheld, unknown }，数据位于 response.domains[domainId]。
 *   domains.projects.active 即激活项目记录（{ directoryId, name, path, kind, isActive, pathState, ... }），
 *   与 domains.runtime.activeDirectory 等价；两者均可能为 null。
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
