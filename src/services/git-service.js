/**
 * Git 状态服务模块 (src/services/git-service.js)
 * 封装与宿主 window.snow 的 Git 状态拉取、监听与徽章 DOM 渲染逻辑
 */

import { el } from "../utils/dom.js";

/**
 * 拉取指定仓库根目录的 Git 文件状态表
 * @param {string} rootPath 项目根目录路径
 * @returns {Promise<Record<string, string>>} 返回相对路径与文件名的状态映射表
 */
export async function fetchGitStatusMap(rootPath) {
  const snow = window.snow;
  if (!snow || typeof snow.gitStatus !== "function" || !rootPath) {
    return Object.create(null);
  }
  try {
    const res = await snow.gitStatus(rootPath);
    const map = Object.create(null);
    if (res && Array.isArray(res.files)) {
      for (const item of res.files) {
        if (!item || !item.path) continue;
        // 仅按相对路径索引：宿主 gitStatus 的 path 已是仓库相对路径。
        // 不再用 basename 索引，避免不同目录下的同名文件被错误染色。
        map[item.path.replace(/\\/g, "/")] = item.status;
      }
    }
    return map;
  } catch (err) {
    console.warn("[FileExplorer] 读取 Git 状态异常:", err);
    return Object.create(null);
  }
}

/**
 * 订阅 Git 状态全局变更通知
 * @param {Function} callback
 * @returns {Function} 取消订阅函数
 */
export function subscribeGitStatus(callback) {
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
 * @param {string} p 原始路径
 * @returns {string}
 */
export function normalizeForCompare(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 计算资源相对仓库根的路径（统一正斜杠）
 * @description 先归一化分隔符再剥离根前缀，避免根路径与资源路径分隔符风格不一致导致剥离失败。
 *   Windows 路径大小写不敏感：比较用小写，切片仍用原文以保留大小写。
 * @param {string} filePath 资源绝对路径
 * @param {string} rootPath 仓库根目录路径
 * @returns {string} 仓库相对路径；无法匹配根前缀时返回归一化后的原路径
 */
export function getRelativeGitPath(filePath, rootPath) {
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
 * @param {string} filePath 文件绝对路径
 * @param {string} fileName 文件名
 * @param {string} rootPath 仓库根目录路径
 * @param {Record<string, string>} gitStatusMap Git 状态表（键为仓库相对路径，正斜杠）
 * @returns {string|null}
 */
export function resolveGitStatus(filePath, fileName, rootPath, gitStatusMap) {
  if (!gitStatusMap) return null;
  const rel = getRelativeGitPath(filePath, rootPath);
  return gitStatusMap[rel] || gitStatusMap[fileName] || null;
}

/**
 * 解析文件夹的聚合 Git 状态（对齐 VS Code「Contains emphasized items」规则）
 * @description 文件夹自身不参与 git 状态计算，其标识来自子孙文件：
 *   存在任意一个「非删除」状态的子孙变更，即视为该文件夹有变更。
 *   删除态文件不向父级传播（文件已不存在），故删除态不计入聚合。
 * @param {string} folderPath 文件夹绝对路径
 * @param {string} rootPath 仓库根目录路径
 * @param {Record<string, string>} gitStatusMap Git 状态表（键为仓库相对路径，正斜杠）
 * @returns {string|null} 聚合状态字符（供染色/圆点使用）；无变更返回 null
 */
export function resolveGitFolderStatus(folderPath, rootPath, gitStatusMap) {
  if (!gitStatusMap) return null;
  const rel = getRelativeGitPath(folderPath, rootPath);
  // 仓库根（rel 为空）时前缀为空串，匹配全部键；子目录匹配 "rel/" 前缀的键
  const prefix = rel ? rel + "/" : "";
  let aggregate = null;
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
 * @param {string} gitStatus Git 状态字符
 * @returns {string|null}
 */
export function gitStatusClass(gitStatus) {
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
 * @param {string} rootPath 仓库根目录路径
 * @returns {Promise<Object|null>} GitStatusResult；接口不可用或异常时返回 null
 */
export async function getGitStatus(rootPath) {
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
 * @param {Object|null} status GitStatusResult
 * @returns {string} 稳定签名；status 为空时返回空串
 */
export function gitStatusSignature(status) {
  if (!status) return "";
  const files = Array.isArray(status.files) ? status.files : [];
  const parts = [
    status.isRepo ? "1" : "0",
    status.currentBranch || "",
    status.ahead || 0,
    status.behind || 0,
  ];
  const entries = [];
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
 * @param {Object|null} status GitStatusResult
 * @returns {{ahead: number, behind: number}}
 */
export function gitSyncCounts(status) {
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
 * @param {Array} files GitStatusResult.files
 * @returns {{staged: Array, unstaged: Array}}
 */
export function partitionGitFiles(files) {
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
 * @param {string} status 派生显示状态（A/M/D/U/R/C/I）
 * @returns {{letter: string, className: string}}
 */
export function gitStatusMeta(status) {
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
 * @param {string} p 仓库相对路径
 * @returns {{name: string, dir: string}}
 */
export function splitGitPath(p) {
  const s = String(p || "");
  const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (idx === -1) return { name: s, dir: "" };
  return { name: s.slice(idx + 1), dir: s.slice(0, idx + 1) };
}

/**
 * 将 Git 文件列表构建为目录树（文件夹在前，名称升序）
 * @param {Array} files GitFileStatus 列表
 * @returns {Array} 树节点数组（文件夹含 children，文件含 file）
 */
export function buildGitFileTree(files) {
  const root = { name: "", path: "", children: [] };
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
  const sortNodes = (nodes) => {
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
 * @param {Array} files GitFileStatus 列表
 * @returns {Set<string>} 目录路径集合
 */
export function collectGitFolderPaths(files) {
  const folders = new Set();
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
 * @param {Object} node 树节点
 * @returns {number}
 */
export function countGitTreeFiles(node) {
  if (!node) return 0;
  if (node.file) return 1;
  return (node.children || []).reduce((sum, child) => sum + countGitTreeFiles(child), 0);
}

/**
 * 收集树节点下的所有文件（供「暂存/取消暂存整个目录」使用）
 * @param {Object} node 树节点
 * @returns {Array} 文件对象数组
 */
export function collectGitTreeFiles(node) {
  if (!node) return [];
  if (node.file) return [node.file];
  return (node.children || []).reduce((acc, child) => acc.concat(collectGitTreeFiles(child)), []);
}

/**
 * 将目录树展平为行列表（跳过已折叠目录的子树）
 * @param {Array} nodes 树节点数组
 * @param {Set<string>} collapsedDirs 已折叠目录路径集合
 * @param {number} [depth=0] 当前深度
 * @returns {Array<{kind: 'folder'|'file', node?: Object, file?: Object, depth: number, isExpanded?: boolean}>}
 */
export function flattenGitTree(nodes, collapsedDirs, depth = 0) {
  const rows = [];
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
 * @param {HTMLElement} nameTextEl 文件名文本节点
 * @param {string} gitStatus Git 状态字符
 */
export function applyGitNameStyle(nameTextEl, gitStatus) {
  if (!nameTextEl || !gitStatus) return;
  const cls = gitStatusClass(gitStatus);
  if (cls) nameTextEl.classList.add(cls);
}

/**
 * 创建对标 GitFileList 的 Git 状态字母徽章节点
 * @param {string} gitStatus Git 状态字符
 * @returns {HTMLElement|null}
 */
export function createGitBadge(gitStatus) {
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
