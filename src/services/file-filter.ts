/**
 * 文件过滤服务模块 (src/services/file-filter.ts)
 * 提供「元数据目录排除」与「多层 .gitignore 规则过滤」两类能力，
 * 用于文件树的可选隐藏。核心匹配逻辑为纯函数，便于单元测试。
 *
 * .gitignore 语义：仓库内每层目录都可以有自己的 .gitignore，规则相对于
 * 该 .gitignore 所在目录生效，且越深（越靠近文件）的规则优先级越高。
 * 调用方需按「浅层在前、深层在后」拼接规则数组。
 */

import { getRelativeGitPath } from "./git-service.ts";
import type { FileTreeEntry } from "./file-service.ts";

/** 一条已解析的 .gitignore 规则。 */
export type GitignoreRule = {
  /** 规则所在 .gitignore 相对仓库根的目录，已归一为正斜杠；仓库根为空串。 */
  base: string;
  /** 是否为 `!` 取反规则（取消忽略）。 */
  negated: boolean;
  /** 规则是否只作用于目录（pattern 以 `/` 结尾）。 */
  dirOnly: boolean;
  /** 由 pattern 编译出的匹配器，已按 anchored 决定是否锚定 base 目录。 */
  regex: RegExp;
};

/** 命中过滤规则后追加到条目上的浅色标记。 */
export type ExcludedEntryMarks = {
  /** 名称是否属于 .git 一类版本控制元数据项。 */
  isMetaExcluded: boolean;
  /** 是否被某条 .gitignore 规则命中。 */
  isGitignored: boolean;
  /** 两者任一命中：开关关闭时仍以浅色显示而非隐藏。 */
  isSoftHidden: boolean;
};

/** 只带 .gitignore 规则的选项（annotate 单条条目时使用）。 */
export type GitignoreRulesOption = {
  /** 由浅到深拼接的 .gitignore 规则；缺失按空数组处理。 */
  gitignoreRules?: GitignoreRule[];
};

/** 过滤目录条目的完整开关。 */
export type ExclusionFilterOptions = GitignoreRulesOption & {
  /** 是否排除 .git/.svn/.hg/CVS/.DS_Store/Thumbs.db；缺省排除。 */
  excludeMeta?: boolean;
  /** 是否应用 .gitignore 过滤；缺省应用。 */
  useGitignore?: boolean;
};

/**
 * VS Code 默认 files.exclude 中的版本控制/系统元数据目录与文件
 */
export const EXCLUDED_META_NAMES: ReadonlySet<string> = Object.freeze(
  new Set([".git", ".svn", ".hg", "CVS", ".DS_Store", "Thumbs.db"])
);

/**
 * 判断条目名是否属于需排除的元数据项
 * @param name 条目名称（不含路径）
 * @returns 命中元数据名单时为 true
 */
export function isExcludedMeta(name: string): boolean {
  return EXCLUDED_META_NAMES.has(String(name || ""));
}

/**
 * 拼接目录与子项路径，保持与传入目录一致的分隔符风格
 * @param dir 目录绝对路径
 * @param name 子项名称
 * @returns 拼接后的路径
 */
export function joinPath(dir: string, name: string): string {
  const d = String(dir || "").replace(/[\\/]+$/, "");
  const sep = d.includes("\\") && !d.includes("/") ? "\\" : "/";
  return d + sep + name;
}

/**
 * 将路径归一化为「正斜杠、无前导/尾随斜杠」的仓库相对形式
 * @param p 原始路径
 * @returns 归一化后的相对路径
 */
function normalizeRel(p: string): string {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * 将 .gitignore 的单个 glob 片段编译为正则表达式
 * @description 支持 `*`、`?` 与双星号；双星号加斜杠匹配任意层级（含 0 层）。
 * @param glob 相对 pattern（已去除首尾 `/`）
 * @param anchored 是否锚定所在目录（pattern 含 `/` 时为 true）
 * @returns 匹配仓库相对路径的正则
 */
export function globToRegExp(glob: string, anchored: boolean): RegExp {
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
 * @param text .gitignore 原始文本
 * @param base 该 .gitignore 所在目录相对仓库根的路径（'' 表示仓库根）
 * @returns 由浅到深顺序无关的规则列表，注释与空行已剔除
 */
export function parseGitignore(text: string, base = ""): GitignoreRule[] {
  const b = normalizeRel(base);
  const rules: GitignoreRule[] = [];
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
 * @param relPath 相对仓库根的路径
 * @param isDir 是否目录
 * @param rules 规则列表
 * @returns 最终被忽略时为 true；取反规则会把已命中的忽略改回不忽略
 */
export function isIgnoredByRules(relPath: string, isDir: boolean, rules: GitignoreRule[]): boolean {
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
 * @param entry 文件树条目
 * @param rootPath 仓库根目录路径
 * @param opts 过滤规则选项
 * @returns 保留原字段并附加命中标记
 */
export function annotateExcludedEntry<T extends FileTreeEntry>(
  entry: T,
  rootPath: string,
  opts: GitignoreRulesOption = {}
): T & ExcludedEntryMarks {
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
 * 目录级过滤判定缓存：键为目录路径（归一化小写），值为该目录的判定上下文。
 * @description 同一目录每次刷新 / 重新展开都会从宿主拿到全新条目数组，按数组引用缓存永远打不中；
 *   真正稳定的是「目录 + 规则集」下的逐条目命中判定（正则测试是大头）。规则数组以引用相等判定：
 *   调用方（index.ts）在规则变化时总是整体替换数组，引用变了自然重算。
 */
type DirFilterCacheEntry = {
  /** 构建缓存时的规则数组引用；引用不同即视为规则已变化。 */
  rules: GitignoreRule[];
  /** 缓存键（条目路径 + 目录标记）→ 命中标记。 */
  marks: Map<string, ExcludedEntryMarks>;
};

const dirFilterCache = new Map<string, DirFilterCacheEntry>();
/** 缓存的目录数上限；超出后按插入序淘汰最旧的目录（目录数量与会话内浏览过的目录数同阶）。 */
const DIR_FILTER_CACHE_LIMIT = 512;

/**
 * 取条目所属目录的缓存键（父目录路径归一化小写）
 * @param entryPath 条目绝对路径
 * @returns 目录缓存键；无法解析时为空串（不参与缓存）
 */
function dirFilterCacheKey(entryPath: string): string {
  const normalized = String(entryPath || "").replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) return "";
  return normalized.slice(0, slash).toLowerCase();
}

/**
 * 按开关过滤目录条目；关闭开关时保留命中项并以 isSoftHidden 标记。
 * @param entries 目录条目列表
 * @param rootPath 仓库根目录路径
 * @param opts 过滤开关与规则
 * @returns 过滤后的条目列表，每项都带浅色命中标记
 * @description 命中判定按目录缓存（见 DirFilterCacheEntry）：同目录刷新 / 重新展开时
 *   复用逐条目的正则判定结果，只重做轻量的对象展开。
 */
export function filterExcludedEntries<T extends FileTreeEntry>(
  entries: T[],
  rootPath: string,
  opts: ExclusionFilterOptions = {}
): Array<T & ExcludedEntryMarks> {
  if (!Array.isArray(entries)) return entries;
  const { excludeMeta = true, useGitignore = true, gitignoreRules = [] } = opts;
  if (!entries.length) return [];
  // 宿主透传的列表（搜索结果）可能含 null 元素：首条目缺失时放弃缓存（键为空串即不读写），
  // 逐条目回退到无缓存判定，与原实现对 null 条目的容忍一致。
  const firstEntry = entries[0] as FileTreeEntry | null | undefined;
  const cacheKey = firstEntry ? dirFilterCacheKey(firstEntry.path) : "";
  let cached = cacheKey ? dirFilterCache.get(cacheKey) : undefined;
  if (!cached || cached.rules !== gitignoreRules) {
    cached = { rules: gitignoreRules, marks: new Map() };
    if (cacheKey) {
      dirFilterCache.set(cacheKey, cached);
      if (dirFilterCache.size > DIR_FILTER_CACHE_LIMIT) {
        const oldest = dirFilterCache.keys().next().value;
        if (oldest !== undefined) dirFilterCache.delete(oldest);
      }
    }
  }
  const marksByKey = cached.marks;
  return entries
    .map((entry) => {
      if (!entry) return entry;
      // 缓存键带 isDirectory：同名路径可能从文件变成目录，dirOnly 规则的判定会随之不同。
      const marksKey = cacheKey ? entry.path + (entry.isDirectory ? "\u0000d" : "") : "";
      let marks = marksKey ? marksByKey.get(marksKey) : undefined;
      if (!marks) {
        const metaExcluded = isExcludedMeta(entry.name);
        const rel = getRelativeGitPath(entry.path, rootPath);
        const gitignored =
          !!rel && isIgnoredByRules(rel, !!entry.isDirectory, gitignoreRules);
        marks = {
          isMetaExcluded: metaExcluded,
          isGitignored: gitignored,
          isSoftHidden: metaExcluded || gitignored,
        };
        if (marksKey) marksByKey.set(marksKey, marks);
      }
      return { ...entry, ...marks };
    })
    .filter((entry) => {
      if (!entry) return false;
      if (excludeMeta && entry.isMetaExcluded) return false;
      if (useGitignore && entry.isGitignored) return false;
      return true;
    });
}
