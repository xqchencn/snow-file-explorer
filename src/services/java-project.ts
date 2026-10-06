/**
 * JVM 项目包视图服务。
 * @description 只负责把 Java/Kotlin 源码目录转换成「包节点」；节点始终保留真实 path，
 *   因此展开、预览、Git 状态和后续文件操作不需要理解虚拟 UI 名称。
 */

import { readDirectoryEntries, sortEntries } from "./file-service.ts";
import type { FileTreeEntry } from "./file-service.ts";
import { mapPool } from "../utils/async.ts";

/**
 * JVM 源码树与包树共用的节点形态。
 * @description 源码树节点就是带 children 的真实目录条目；包树节点在其上追加
 *   displayName / packageName / isVirtualPackage，path 始终是磁盘上的真实路径。
 *   这些字段全部已在 `FileTreeEntry` 上声明（树上只有一份节点形状），此处保留
 *   本模块自己的名字，让包树代码读起来是「JVM 树」而不是通用文件树。
 */
export type JvmTreeNode = FileTreeEntry;

/** 读取源码树时可注入的条目过滤器，用于按元数据与 .gitignore 规则隐藏条目。 */
export type JvmEntryFilter = (entries: FileTreeEntry[], dirPath: string) => FileTreeEntry[];

/**
 * 递归读取 Java/Kotlin 源码根目录，构造成普通嵌套文件树。
 * @param dirPath 源码根目录
 * @param filterEntries 可选过滤器
 * @returns 带 children 的嵌套条目列表
 */
async function readJvmSourceTree(dirPath: string, filterEntries?: JvmEntryFilter): Promise<JvmTreeNode[]> {
  const entries: FileTreeEntry[] = await readDirectoryEntries(dirPath);
  const visible = typeof filterEntries === "function" ? filterEntries(entries, dirPath) : entries;
  const sorted = sortEntries(visible);
  const directories = sorted.filter((entry) => entry && entry.isDirectory);
  const loaded = await mapPool(directories, 8, async (entry) => {
    const children = await readJvmSourceTree(entry.path, filterEntries);
    return { ...entry, children };
  });
  const byPath: Map<string, JvmTreeNode> = new Map(loaded.filter(Boolean).map((entry): [string, JvmTreeNode] => [entry.path, entry]));
  return sorted.map((entry) => (entry && entry.isDirectory ? byPath.get(entry.path) || entry : entry));
}

/**
 * 把目录节点转换成包节点，并压缩只有一个子包且没有文件的中间层。
 * @param entry 真实目录条目
 * @param parentPackageName 父包全名
 * @returns 带 packageName 与 isVirtualPackage 的包节点
 */
function buildPackageNode(entry: JvmTreeNode, parentPackageName: string): JvmTreeNode {
  const packageName = parentPackageName ? `${parentPackageName}.${entry.name}` : entry.name;
  const children: JvmTreeNode[] = Array.isArray(entry.children)
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
 * @param node 包节点
 * @returns 合并后的包节点；有不只一个子包或存在文件时原样返回
 */
function compactPackageNode(node: JvmTreeNode): JvmTreeNode {
  const children: JvmTreeNode[] = Array.isArray(node.children)
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
 * @param sourceEntries 源码根目录的嵌套条目
 * @returns 顶层包节点与默认包文件并列的包树
 */
export function buildJvmPackageTree(sourceEntries: JvmTreeNode[] | null): JvmTreeNode[] {
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
 * @param sourceRootPath 标准 Java/Kotlin 源码根目录
 * @param filterEntries 可选过滤器
 * @returns 该源码根目录下的包树；路径为空时为空数组
 */
export async function loadJvmPackageTree(
  sourceRootPath: string,
  filterEntries?: JvmEntryFilter
): Promise<JvmTreeNode[]> {
  if (!sourceRootPath) return [];
  const sourceTree = await readJvmSourceTree(sourceRootPath, filterEntries);
  return buildJvmPackageTree(sourceTree);
}

// 保留旧导出名，迁移后的测试仍经它调用同一套 JVM 包树实现。
export const buildJavaPackageTree = buildJvmPackageTree;
