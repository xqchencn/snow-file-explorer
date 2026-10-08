import type { DirectoryEntry } from "../../../src/types/host/host-workspace.ts";

/** 统一的路径写法：桩里的盘用正斜杠、大小写不敏感地比对。 */
export function diskKey(path: string): string {
  return String(path).replace(/\\/g, "/");
}

/**
 * 列出一个目录的直接子条目，形状与宿主 `readDirectoryEntries` 一致。
 * @param disks 虚拟盘：文件绝对路径（正斜杠）→ 正文
 * @param dirPath 要列的目录绝对路径
 * @returns 只有这一层的条目；更深的路径由中间目录名代出来，`isDirectory: true`
 * @description 宿主的列目录把目录当一等条目返回，扫描与「这里有没有同名」都靠它。
 *   桩要是只回文件，嵌套目录在插件里就等于不存在——新建完的文件列不出来、
 *   同名的目录也拦不住，这类用例看着像通过，其实测的是另一个世界。
 */
export function listDiskChildren(disks: Map<string, string>, dirPath: string): DirectoryEntry[] {
  const dir = diskKey(dirPath).replace(/\/+$/, "");
  const prefix = `${dir}/`;
  const children = new Map<string, DirectoryEntry>();
  for (const path of disks.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const [head, ...deeper] = rest.split("/");
    if (!head) continue;
    if (deeper.length === 0) {
      if (children.has(head)) continue;
      children.set(head, { name: head, path, isDirectory: false, size: (disks.get(path) || "").length });
      continue;
    }
    children.set(head, { name: head, path: `${prefix}${head}`, isDirectory: true, size: 0 });
  }
  return [...children.values()];
}
