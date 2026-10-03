/**
 * 文件过滤服务模块 (src/services/file-filter.js)
 * 提供「元数据目录排除」与「多层 .gitignore 规则过滤」两类能力，
 * 用于文件树的可选隐藏。核心匹配逻辑为纯函数，便于单元测试。
 *
 * .gitignore 语义：仓库内每层目录都可以有自己的 .gitignore，规则相对于
 * 该 .gitignore 所在目录生效，且越深（越靠近文件）的规则优先级越高。
 * 调用方需按「浅层在前、深层在后」拼接规则数组。
 */

import { getRelativeGitPath } from "./git-service.js";

/**
 * VS Code 默认 files.exclude 中的版本控制/系统元数据目录与文件
 * @type {ReadonlySet<string>}
 */
export const EXCLUDED_META_NAMES = Object.freeze(
  new Set([".git", ".svn", ".hg", "CVS", ".DS_Store", "Thumbs.db"])
);

/**
 * 判断条目名是否属于需排除的元数据项
 * @param {string} name 条目名称（不含路径）
 * @returns {boolean}
 */
export function isExcludedMeta(name) {
  return EXCLUDED_META_NAMES.has(String(name || ""));
}

/**
 * 拼接目录与子项路径，保持与传入目录一致的分隔符风格
 * @param {string} dir 目录绝对路径
 * @param {string} name 子项名称
 * @returns {string}
 */
export function joinPath(dir, name) {
  const d = String(dir || "").replace(/[\\/]+$/, "");
  const sep = d.includes("\\") && !d.includes("/") ? "\\" : "/";
  return d + sep + name;
}

/**
 * 将路径归一化为「正斜杠、无前导/尾随斜杠」的仓库相对形式
 * @param {string} p 原始路径
 * @returns {string}
 */
function normalizeRel(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * 将 .gitignore 的单个 glob 片段编译为正则表达式
 * @description 支持 `*`、`?` 与双星号；双星号加斜杠匹配任意层级（含 0 层）。
 * @param {string} glob 相对 pattern（已去除首尾 `/`）
 * @param {boolean} anchored 是否锚定所在目录（pattern 含 `/` 时为 true）
 * @returns {RegExp}
 */
export function globToRegExp(glob, anchored) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // 双星号加斜杠 → 任意层级（含 0 层）
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  const prefix = anchored ? "^" : "(?:^|/)";
  return new RegExp(prefix + re + "$");
}

/**
 * 解析 .gitignore 文本为规则列表
 * @param {string} text .gitignore 原始文本
 * @param {string} [base=""] 该 .gitignore 所在目录相对仓库根的路径（'' 表示仓库根）
 * @returns {Array<{base: string, negated: boolean, dirOnly: boolean, regex: RegExp}>}
 */
export function parseGitignore(text, base = "") {
  const b = normalizeRel(base);
  const rules = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line[0] === "#") continue;
    let negated = false;
    if (line[0] === "!") {
      negated = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) continue;
    // 前导 `/` 表示锚定所在目录；pattern 中间含 `/` 同样锚定
    let anchored = false;
    if (line.startsWith("/")) {
      anchored = true;
      line = line.slice(1);
    }
    if (line.includes("/")) anchored = true;
    rules.push({ base: b, negated, dirOnly, regex: globToRegExp(line, anchored) });
  }
  return rules;
}

/**
 * 判断某路径是否被规则集忽略（支持多层 .gitignore，后出现的规则覆盖先出现的）
 * @param {string} relPath 相对仓库根的路径
 * @param {boolean} isDir 是否目录
 * @param {Array<{base: string, negated: boolean, dirOnly: boolean, regex: RegExp}>} rules 规则列表
 * @returns {boolean}
 */
export function isIgnoredByRules(relPath, isDir, rules) {
  if (!rules || !rules.length) return false;
  const p = normalizeRel(relPath);
  if (!p) return false;
  let ignored = false;
  for (const r of rules) {
    let sub = p;
    if (r.base) {
      // 规则只作用于其所在目录的子树
      if (p === r.base || !p.startsWith(r.base + "/")) continue;
      sub = p.slice(r.base.length + 1);
    }
    if (!sub) continue;
    if (r.dirOnly && !isDir) continue;
    if (r.regex.test(sub)) ignored = !r.negated;
  }
  return ignored;
}

/**
 * 计算条目命中的过滤原因，但不根据开关丢弃条目。
 * @param {Object} entry 文件树条目
 * @param {string} rootPath 仓库根目录路径
 * @param {Object} [opts] 过滤规则选项
 * @returns {Object} 保留原字段并附加命中标记
 */
export function annotateExcludedEntry(entry, rootPath, opts = {}) {
  if (!entry) return entry;
  const { gitignoreRules = [] } = opts;
  const metaExcluded = isExcludedMeta(entry.name);
  const rel = getRelativeGitPath(entry.path, rootPath);
  const gitignored =
    !!rel && isIgnoredByRules(rel, !!entry.isDirectory, gitignoreRules);
  return {
    ...entry,
    isMetaExcluded: metaExcluded,
    isGitignored: gitignored,
    isSoftHidden: metaExcluded || gitignored,
  };
}

/**
 * 按开关过滤目录条目；关闭开关时保留命中项并以 isSoftHidden 标记。
 * @param {Array} entries 目录条目列表
 * @param {string} rootPath 仓库根目录路径
 * @param {Object} [opts]
 * @param {boolean} [opts.excludeMeta=true] 是否排除 .git 等元数据项
 * @param {boolean} [opts.useGitignore=true] 是否应用 .gitignore 过滤
 * @param {Array} [opts.gitignoreRules=[]] 由浅到深拼接的 .gitignore 规则
 * @returns {Array} 过滤后的条目列表
 */
export function filterExcludedEntries(entries, rootPath, opts = {}) {
  if (!Array.isArray(entries)) return entries;
  const { excludeMeta = true, useGitignore = true, gitignoreRules = [] } = opts;
  return entries
    .map((entry) => annotateExcludedEntry(entry, rootPath, { gitignoreRules }))
    .filter((entry) => {
      if (!entry) return false;
      if (excludeMeta && entry.isMetaExcluded) return false;
      if (useGitignore && entry.isGitignored) return false;
      return true;
    });
}
