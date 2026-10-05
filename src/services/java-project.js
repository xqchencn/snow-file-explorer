/**
 * JVM 项目包视图服务。
 * @description 只负责把 Java/Kotlin 源码目录转换成「包节点」；节点始终保留真实 path，
 *   因此展开、预览、Git 状态和后续文件操作不需要理解虚拟 UI 名称。
 */

import { readDirectoryEntries, sortEntries } from "./file-service.js";

/**
 * 递归读取 Java/Kotlin 源码根目录，构造成普通嵌套文件树。
 * @param {string} dirPath 源码根目录
 * @param {(entries: Array, dirPath: string) => Array} filterEntries 可选过滤器
 * @returns {Promise<Array>}
 */
async function readJvmSourceTree(dirPath, filterEntries) {
  const entries = await readDirectoryEntries(dirPath);
  const visible = typeof filterEntries === "function" ? filterEntries(entries, dirPath) : entries;
  const result = [];

  for (const entry of sortEntries(visible)) {
    if (!entry || !entry.isDirectory) {
      result.push(entry);
      continue;
    }
    const children = await readJvmSourceTree(entry.path, filterEntries);
    result.push({ ...entry, children });
  }

  return result;
}

/**
 * 把目录节点转换成包节点，并压缩只有一个子包且没有文件的中间层。
 * @param {Object} entry 真实目录条目
 * @param {string} parentPackageName 父包全名
 * @returns {Object}
 */
function buildPackageNode(entry, parentPackageName) {
  const packageName = parentPackageName ? `${parentPackageName}.${entry.name}` : entry.name;
  const children = Array.isArray(entry.children)
    ? sortEntries(entry.children).map((child) =>
        child.isDirectory ? buildPackageNode(child, packageName) : { ...child }
      )
    : [];

  return {
    ...entry,
    name: entry.name,
    displayName: entry.name,
    packageName,
    isVirtualPackage: true,
    children,
  };
}

/**
 * 压缩空的中间包，例如 com/example/demo → com.example.demo。
 * @param {Object} node 包节点
 * @returns {Object}
 */
function compactPackageNode(node) {
  const children = Array.isArray(node.children)
    ? node.children.map((child) => (child.isVirtualPackage ? compactPackageNode(child) : child))
    : [];
  const directories = children.filter((child) => child && child.isVirtualPackage);
  const files = children.filter((child) => !child || !child.isVirtualPackage);

  if (!files.length && directories.length === 1) {
    const child = directories[0];
    return {
      ...node,
      ...child,
      name: `${node.name}.${child.name}`,
      displayName: `${node.name}.${child.name}`,
      packageName: child.packageName,
      path: child.path,
      children: child.children,
      isVirtualPackage: true,
    };
  }

  return {
    ...node,
    displayName: node.name,
    children: sortEntries(children),
  };
}

/**
 * 将已读取的源码树转换成 JVM 包树。
 * @param {Array} sourceEntries 源码根目录的嵌套条目
 * @returns {Array}
 */
export function buildJvmPackageTree(sourceEntries) {
  if (!Array.isArray(sourceEntries)) return [];

  const packageNodes = sourceEntries
    .filter((entry) => entry && entry.isDirectory)
    .map((entry) => compactPackageNode(buildPackageNode(entry, "")));
  const rootFiles = sourceEntries.filter((entry) => entry && !entry.isDirectory);

  // 默认包中的文件与顶层包并列，避免凭空创建一个不可操作的“默认包”节点。
  return sortEntries([...packageNodes, ...rootFiles]);
}

/**
 * 读取并构建一个 Java/Kotlin 源码根目录的包树。
 * @param {string} sourceRootPath 标准 Java/Kotlin 源码根目录
 * @param {(entries: Array, dirPath: string) => Array} filterEntries 可选过滤器
 * @returns {Promise<Array>}
 */
export async function loadJvmPackageTree(sourceRootPath, filterEntries) {
  if (!sourceRootPath) return [];
  const sourceTree = await readJvmSourceTree(sourceRootPath, filterEntries);
  return buildJvmPackageTree(sourceTree);
}

// 保留旧导出名，已有调用方和测试继续复用同一套 JVM 包树实现。
export const buildJavaPackageTree = buildJvmPackageTree;
export const loadJavaPackageTree = loadJvmPackageTree;
