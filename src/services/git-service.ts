/**
 * Git 状态服务模块 (src/services/git-service.ts)
 * 封装与宿主 window.snow 的 Git 状态拉取、监听与徽章 DOM 渲染逻辑
 */

import { el } from "../utils/dom.ts";
import type { GitFileStatus, GitStatusResult } from "../types/host/host-git.ts";
import type { Unsubscribe } from "../types/snow-api.ts";

/**
 * Git 状态映射表：键为仓库相对路径（统一正斜杠），值为派生显示状态字符（M/U/A/D/R 等）。
 * 由 src/index.ts 的 gitStatusToMap 产出（Object.create(null) 构造，无原型键），供文件树染色与徽章查询。
 */
export type GitStatusMap = Record<string, string>;

/**
 * Git 变更目录树节点：目录节点只有 children，文件节点额外带 file（二者互斥）。
 */
export type GitTreeNode = {
  /** 节点显示名（相对路径的最后一段）；根占位节点为空串。 */
  name: string;
  /** 自仓库根起算的相对路径（正斜杠拼接，不含尾斜杠）；用作折叠态的键。 */
  path: string;
  /** 子节点列表；文件叶子节点为空数组。 */
  children: GitTreeNode[];
  /** 该节点对应的 Git 文件状态；仅文件节点有，目录节点缺省（用 undefined 判定目录）。 */
  file?: GitFileStatus;
};

/**
 * 变更树展平后的列表行：目录行带节点与展开态，文件行只带状态。
 */
export type GitTreeRow =
  | /** 目录行 */ {
      /** 行类型判别字段，固定 'folder'。 */
      kind: "folder";
      /** 目录节点本身（含 children 与 path，供缩进与折叠交互取用）。 */
      node: GitTreeNode;
      /** 缩进深度，顶层为 0。 */
      depth: number;
      /** 是否展开；false 时其子树不出现在行列表中。 */
      isExpanded: boolean;
    }
  | /** 文件行 */ {
      /** 行类型判别字段，固定 'file'。 */
      kind: "file";
      /** 该行的 Git 文件状态。 */
      file: GitFileStatus;
      /** 缩进深度，顶层为 0。 */
      depth: number;
    };

/**
 * 仓库同步计数（对标 VS Code SCM 底部的 ↑N / ↓N）。
 */
export type GitSyncCounts = {
  /** 已提交但未推送的数量；非仓库、无上游或负数时归零。 */
  ahead: number;
  /** 远端已有但未拉取的数量；非仓库、无上游或负数时归零。 */
  behind: number;
};

/**
 * 仓库相对路径的「文件名 + 目录前缀」拆分结果。
 */
export type GitPathParts = {
  /** 文件名（最后一段）；入参为空串时为空串。 */
  name: string;
  /** 目录前缀，保留原始分隔符并含末尾分隔符；位于仓库根时为空串。 */
  dir: string;
};

/**
 * Git 状态字母徽章的展示元数据。
 */
export type GitStatusMeta = {
  /** 徽章字母（A/M/D/U/R/C/I；未知状态原样回显大写值）。 */
  letter: string;
  /** 字母对应的 CSS 类名。 */
  className: string;
};

/**
 * 变更文件按索引区/工作区拆分出的两组清单（对齐宿主 GitControl 的分区）。
 */
export type GitFilePartition = {
  /** 已暂存文件：indexStatus 非空且非 '?'。 */
  staged: GitFileStatus[];
  /** 工作区变更文件：workdirStatus 为 '?' 或非空。 */
  unstaged: GitFileStatus[];
};

/**
 * 订阅 Git 状态全局变更通知
 * @param callback
 * @returns 取消订阅函数
 */
export function subscribeGitStatus(callback: (repoPath: string) => void): Unsubscribe {
  const snow = window.snow;
  if (snow && typeof snow.onGitStatusChanged === "function") {
    try {
      const unsub = snow.onGitStatusChanged(callback);
      if (typeof unsub === "function") return unsub;
    } catch (err) {
      console.warn("[FileExplorer] 监听 onGitStatusChanged 异常:", err);
    }
  }
  return () => {};
}

/**
 * 将路径统一为正斜杠并去除尾部分隔符，用于路径比较
 * @description 宿主两处来源的路径分隔符风格可能不一致：
 *   文件/目录路径来自 readDirectoryEntries，根路径来自 metadata（projects.active.path），
 *   二者可能一正一反斜杠。比较前必须归一化，否则前缀剥离失败。
 * @param p 原始路径
 * @returns 归一化后的路径
 */
export function normalizeForCompare(p: string): string {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 计算资源相对仓库根的路径（统一正斜杠）
 * @description 先归一化分隔符再剥离根前缀，避免根路径与资源路径分隔符风格不一致导致剥离失败。
 *   Windows 路径大小写不敏感：比较用小写，切片仍用原文以保留大小写。
 * @param filePath 资源绝对路径
 * @param rootPath 仓库根目录路径
 * @returns 仓库相对路径；无法匹配根前缀时返回归一化后的原路径
 */
export function getRelativeGitPath(filePath: string, rootPath: string): string {
  const normFile = normalizeForCompare(filePath);
  const normRoot = normalizeForCompare(rootPath);
  if (!normRoot) return normFile;
  const lowerFile = normFile.toLowerCase();
  const lowerRoot = normRoot.toLowerCase();
  if (lowerFile === lowerRoot) return "";
  if (lowerFile.startsWith(lowerRoot + "/")) return normFile.slice(normRoot.length + 1);
  return normFile;
}

/**
 * 解析具体文件的 Git 状态字符 (M / U / A / D / R 等)
 * @param filePath 文件绝对路径
 * @param rootPath 仓库根目录路径
 * @param gitStatusMap Git 状态表（键为仓库相对路径，正斜杠）
 * @returns 状态字符；状态表缺失或该文件无变更时为 null
 * @description 只按相对路径查：建表方（src/index.ts 的 gitStatusToMap）同样只用相对路径建键，
 *   原先追加的 `gitStatusMap[fileName]` 兜底永远查不到，且一旦将来有人写入 basename 键就会跨目录误染色。
 */
export function resolveGitStatus(
  filePath: string,
  rootPath: string,
  gitStatusMap: GitStatusMap | null | undefined
): string | null {
  if (!gitStatusMap) return null;
  const rel = getRelativeGitPath(filePath, rootPath);
  return gitStatusMap[rel] || null;
}

/**
 * 解析文件夹的聚合 Git 状态（对齐 VS Code「Contains emphasized items」规则）
 * @description 文件夹自身不参与 git 状态计算，其标识来自子孙文件：
 *   存在任意一个「非删除」状态的子孙变更，即视为该文件夹有变更。
 *   删除态文件不向父级传播（文件已不存在），故删除态不计入聚合。
 * @param folderPath 文件夹绝对路径
 * @param rootPath 仓库根目录路径
 * @param gitStatusMap Git 状态表（键为仓库相对路径，正斜杠）
 * @returns 聚合状态字符（供染色/圆点使用）；无变更返回 null
 */
export function resolveGitFolderStatus(
  folderPath: string,
  rootPath: string,
  gitStatusMap: GitStatusMap | null | undefined
): string | null {
  if (!gitStatusMap) return null;
  const rel = getRelativeGitPath(folderPath, rootPath);
  // 仓库根（rel 为空）时前缀为空串，匹配全部键；子目录匹配 "rel/" 前缀的键
  const prefix = rel ? rel + "/" : "";
  let aggregate: string | null = null;
  for (const key in gitStatusMap) {
    if (prefix && key.indexOf(prefix) !== 0) continue;
    const s = String(gitStatusMap[key] || "").toUpperCase();
    if (!s || s === "D") continue; // 删除态不向父级传播（对齐 VS Code propagate=false）
    aggregate = s;
    if (s === "M") break; // 修改态优先级最高，无需继续扫描
  }
  return aggregate;
}

/**
 * 将 Git 状态字符映射为文件名着色 Class
 * @param gitStatus Git 状态字符
 * @returns 文件名着色类名；空值或未识别状态返回 null
 */
export function gitStatusClass(gitStatus: string | null | undefined): string | null {
  if (!gitStatus) return null;
  const s = String(gitStatus).toUpperCase();
  if (s === "M") return "sfe-git-modify";
  if (s === "U") return "sfe-git-untracked";
  if (s === "A") return "sfe-git-add";
  if (s === "D") return "sfe-git-delete";
  if (s === "R") return "sfe-git-rename";
  return null;
}

/**
 * 拉取仓库完整 Git 状态（含文件分区所需字段）
 * @param rootPath 仓库根目录路径
 * @returns GitStatusResult；接口不可用或异常时返回 null
 */
export async function getGitStatus(rootPath: string): Promise<GitStatusResult | null> {
  const snow = window.snow;
  if (!snow || typeof snow.gitStatus !== "function" || !rootPath) return null;
  try {
    return (await snow.gitStatus(rootPath)) || null;
  } catch (err) {
    console.warn("[FileExplorer] 读取完整 Git 状态异常:", err);
    return null;
  }
}

/**
 * 计算 Git 状态的「内容签名」，用于判断两次拉取是否有实质变化。
 * @description 宿主 watcher 会因 git status 自身刷新索引等原因高频触发；若无条件重建
 *   变更列表，行节点会被反复销毁重建，表现为列表持续跳动、hover 出现的行内按钮闪烁。
 *   仅当签名变化时才重绘，可保住行节点、选中态与滚动位置。
 * @param status GitStatusResult
 * @returns 稳定签名；status 为空时返回空串
 */
export function gitStatusSignature(status: GitStatusResult | null | undefined): string {
  if (!status) return "";
  const files = Array.isArray(status.files) ? status.files : [];
  const parts = [
    status.isRepo ? "1" : "0",
    status.currentBranch || "",
    status.ahead || 0,
    status.behind || 0,
  ];
  const entries: string[] = [];
  for (const f of files) {
    if (!f) continue;
    entries.push(`${f.path}\u0000${f.indexStatus}\u0000${f.workdirStatus}\u0000${f.status}`);
  }
  // 顺序无关：git status 的文件输出顺序可能抖动，而最终渲染顺序由目录树重排决定，
  // 因此先排序再比较，避免「内容未变、仅顺序变化」触发无谓重建（列表跳动）。
  entries.sort();
  return parts.concat(entries).join("\u0001");
}

/**
 * 提取「未推送 / 未拉取」提交数（供底部同步区显示计数）
 * @description 对标 VS Code SCM 视图底部的 ↑N / ↓N：ahead = 已提交未推送，
 *   behind = 远端已有但未拉取。无上游或非仓库时均为 0。
 * @param status GitStatusResult
 * @returns 未推送与未拉取的提交数
 */
export function gitSyncCounts(status: GitStatusResult | null | undefined): GitSyncCounts {
  if (!status || !status.isRepo) return { ahead: 0, behind: 0 };
  return {
    ahead: Math.max(0, status.ahead || 0),
    behind: Math.max(0, status.behind || 0),
  };
}

/**
 * 将 Git 文件列表按索引/工作区状态拆分为「已暂存」与「变更」两组
 * @description 与宿主 GitControl 的划分完全一致：
 *   已暂存 = indexStatus 非空；变更 = workdirStatus 为 ? 或非空。
 * @param files GitStatusResult.files
 * @returns 已暂存与工作区变更两组文件
 */
export function partitionGitFiles(
  files: GitFileStatus[] | null | undefined
): GitFilePartition {
  const list = Array.isArray(files) ? files : [];
  const staged = list.filter(
    (f) => f && f.indexStatus !== " " && f.indexStatus !== "?" && f.indexStatus !== ""
  );
  const unstaged = list.filter(
    (f) =>
      f &&
      (f.workdirStatus === "?" ||
        (f.workdirStatus !== " " && f.workdirStatus !== ""))
  );
  return { staged, unstaged };
}

/**
 * Git 状态字符 → 展示元数据（字母 + 颜色类名）
 * @param status 派生显示状态（A/M/D/U/R/C/I）
 * @returns 字母与颜色类名
 */
export function gitStatusMeta(status: string | null | undefined): GitStatusMeta {
  const s = String(status || "").toUpperCase();
  switch (s) {
    case "A":
      return { letter: "A", className: "sfe-git-add" };
    case "M":
      return { letter: "M", className: "sfe-git-modify" };
    case "D":
      return { letter: "D", className: "sfe-git-delete" };
    case "U":
      return { letter: "U", className: "sfe-git-untracked" };
    case "R":
      return { letter: "R", className: "sfe-git-rename" };
    case "C":
      return { letter: "C", className: "sfe-git-add" };
    case "I":
      return { letter: "I", className: "sfe-git-ignored" };
    default:
      return { letter: s, className: "sfe-git-modify" };
  }
}

/**
 * 拆分仓库相对路径为文件名与目录前缀
 * @param p 仓库相对路径
 * @returns 文件名与目录前缀
 */
export function splitGitPath(p: string): GitPathParts {
  const s = String(p || "");
  const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (idx === -1) return { name: s, dir: "" };
  return { name: s.slice(idx + 1), dir: s.slice(0, idx + 1) };
}

/**
 * 将 Git 文件列表构建为目录树（文件夹在前，名称升序）
 * @param files GitFileStatus 列表
 * @returns 树节点数组（文件夹含 children，文件含 file）
 */
export function buildGitFileTree(
  files: GitFileStatus[] | null | undefined
): GitTreeNode[] {
  const root: GitTreeNode = { name: "", path: "", children: [] };
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || !file.path) continue;
    const segments = String(file.path).split(/[/\\]+/).filter(Boolean);
    let current = root;
    let acc = "";
    segments.forEach((segment, index) => {
      acc = acc ? `${acc}/${segment}` : segment;
      let child = current.children.find((node) => node.name === segment);
      if (!child) {
        child = { name: segment, path: acc, children: [] };
        current.children.push(child);
      }
      if (index === segments.length - 1) child.file = file;
      current = child;
    });
  }
  const sortNodes = (nodes: GitTreeNode[]) => {
    nodes.sort((a, b) => {
      const aFolder = a.file === undefined;
      const bFolder = b.file === undefined;
      if (aFolder !== bFolder) return aFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(root.children);
  return root.children;
}

/**
 * 收集 Git 文件列表中的所有目录路径，供分区默认折叠状态使用
 * @param files GitFileStatus 列表
 * @returns 目录路径集合
 */
export function collectGitFolderPaths(files: GitFileStatus[] | null | undefined): Set<string> {
  const folders: Set<string> = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || !file.path) continue;
    const segments = String(file.path).split(/[/\\]+/).filter(Boolean);
    let path = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      path = path ? `${path}/${segments[index]}` : segments[index];
      folders.add(path);
    }
  }
  return folders;
}

/**
 * 统计树节点下的文件总数
 * @param node 树节点
 * @returns 该节点子树内的文件数；节点为空时为 0
 */
export function countGitTreeFiles(node: GitTreeNode | null | undefined): number {
  if (!node) return 0;
  if (node.file) return 1;
  return node.children.reduce((sum, child) => sum + countGitTreeFiles(child), 0);
}

/**
 * 收集树节点下的所有文件（供「暂存/取消暂存整个目录」使用）
 * @param node 树节点
 * @returns 文件对象数组；节点为空时为空数组
 */
export function collectGitTreeFiles(node: GitTreeNode | null | undefined): GitFileStatus[] {
  if (!node) return [];
  if (node.file) return [node.file];
  return node.children.reduce((acc: GitFileStatus[], child) => acc.concat(collectGitTreeFiles(child)), []);
}

/**
 * 将目录树展平为行列表（跳过已折叠目录的子树）
 * @param nodes 树节点数组
 * @param collapsedDirs 已折叠目录路径集合
 * @param depth 当前深度
 * @returns 可渲染的行列表（目录行/文件行）
 */
export function flattenGitTree(
  nodes: GitTreeNode[] | null | undefined,
  collapsedDirs: Set<string>,
  depth = 0
): GitTreeRow[] {
  const rows: GitTreeRow[] = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node.file) {
      rows.push({ kind: "file", file: node.file, depth });
      continue;
    }
    const isExpanded = !collapsedDirs.has(node.path);
    rows.push({ kind: "folder", node, depth, isExpanded });
    if (isExpanded) rows.push(...flattenGitTree(node.children, collapsedDirs, depth + 1));
  }
  return rows;
}

/**
 * 为文件名节点添加 Git 状态染色 Class
 * @param nameTextEl 文件名文本节点
 * @param gitStatus Git 状态字符
 */
export function applyGitNameStyle(
  nameTextEl: HTMLElement | null | undefined,
  gitStatus: string | null | undefined
): void {
  if (!nameTextEl || !gitStatus) return;
  const cls = gitStatusClass(gitStatus);
  if (cls) nameTextEl.classList.add(cls);
}

/**
 * 创建对标 GitFileList 的 Git 状态字母徽章节点
 * @param gitStatus Git 状态字符
 * @returns 徽章节点；状态为空时返回 null
 */
export function createGitBadge(gitStatus: string | null | undefined): HTMLElement | null {
  if (!gitStatus) return null;
  const s = String(gitStatus).toUpperCase();
  let colorClass = "git-status-modify";
  if (s === "U") colorClass = "git-status-untracked";
  else if (s === "A") colorClass = "git-status-add";
  else if (s === "D") colorClass = "git-status-delete";
  else if (s === "R") colorClass = "git-status-rename";

  const badge = el("span", "sfe-git-badge " + colorClass, s);
  badge.title = "Git: " + s;
  return badge;
}
