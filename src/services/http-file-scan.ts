/**
 * HTTP REST 请求文件扫描服务 (src/services/http-file-scan.ts)
 * @description 在工作区内发现 `.http` / `.rest` 请求文件，供「HTTP 请求」主视图按目录排布。
 *   忽略语义与文件树一致：逐层读 `.gitignore`、深层规则覆盖浅层，并在已忽略目录处剪枝；
 *   「按 .gitignore 过滤」开关关闭时不丢弃命中项，全部列出。
 * @description 整仓遍历没有文件树那样的懒展开兜底，因此设两条硬闸：目录数预算（超了立刻停，
 *   由 `truncated` 如实回报结果不完整）与取消回调（切项目 / 重新扫描时旧任务自行退场）。
 */

import type { DirectoryEntry } from "../types/host/host-workspace.ts";
import type { GitignoreRule } from "./file-filter.ts";
import { extname, readDirectoryEntries, readFileContent, relativePath } from "./file-service.ts";
import { getRelativeGitPath } from "./git-service.ts";
import { isExcludedMeta, isIgnoredByRules, parseGitignore } from "./file-filter.ts";
import { mapPool } from "../utils/async.ts";

/**
 * rest-client 生态认定的请求文件扩展名（不含点、小写）。
 * @description `.http` 与 `.rest` 在上游属同一语言（VS Code REST Client 的 fileAssociations
 *   把两者都映射到 http 语法），故这里一并收录。
 */
export const HTTP_REST_EXTENSIONS: ReadonlySet<string> = Object.freeze(new Set(["http", "rest"]));

/** 单层目录子项的并发读取度，与整仓 .gitignore 收集（tree-controller）同一档。 */
const SCAN_CONCURRENCY = 8;

/**
 * 全局在途列目录调用的上限。
 * @description `mapPool` 是「每调用一个池」：递归里每层目录各起 8 个 worker，
 *   在途 IPC 会随分支因子相乘（宽而深且没被 .gitignore 剪枝的仓库能同时打出成百上千个）。
 *   目录预算只限「已访问数」，不限在途数，所以这里另加一道全局闸。
 */
const MAX_IN_FLIGHT_READS = 16;

/**
 * 一次扫描允许访问的目录数上限。
 * @description 取「够装下正常单仓目录数、又挡得住无 .gitignore 却含 node_modules 的仓库」之间的值；
 *   触顶即停并在结果里回报 truncated，而不是继续跑到几十秒。
 */
export const MAX_SCAN_DIRECTORIES = 5000;

/** 一条命中的请求文件。 */
export type HttpRestFile = {
  /** 文件名（含扩展名），取宿主 DirectoryEntry.name。 */
  name: string;
  /** 绝对路径，读文件与「在资源管理器中打开」都以它为键；取宿主 DirectoryEntry.path。 */
  path: string;
  /** 相对工作区根的路径（正斜杠、无首尾分隔符），分组排布与排序都以它为准。 */
  relPath: string;
  /** 字节数；宿主必给，宿主脏数据缺失时按 0 处理。 */
  size: number;
};

/** scanHttpRestFiles 的入参。 */
export type HttpRestScanOptions = {
  /** 工作区根绝对路径；空串直接返回空结果。 */
  rootPath: string;
  /** 是否应用 .gitignore；出处 state.viewSettings.respectGitignore，缺省按应用处理。 */
  respectGitignore?: boolean;
  /**
   * 调用方已备好的全仓规则（浅到深、含各自 base）。
   * @description 提供时本次扫描直接复用它，不再逐层读 .gitignore —— 整仓规则已在文件树
   *   刷新时收集过（state.gitignoreFullyLoaded），重复读盘纯属浪费。
   */
  gitignoreRules?: GitignoreRule[] | null;
  /** 取消判定；每次进目录前调用，返回 true 即中止。缺省按不取消处理。 */
  isCancelled?: () => boolean;
  /** 目录访问预算；缺省取 MAX_SCAN_DIRECTORIES，单测用它来触发截断分支。 */
  maxDirectories?: number;
};

/** scanHttpRestFiles 的返回。 */
export type HttpRestScanResult = {
  /** 命中的请求文件，已按 relPath 升序（数字感知、忽略大小写差异）。 */
  files: HttpRestFile[];
  /** 本次实际访问过的目录数。 */
  directoriesVisited: number;
  /** 是否因预算触顶而停下；true 时 files 只是前缀，界面必须如实说明结果不完整。 */
  truncated: boolean;
  /** 列目录失败的目录数；这些目录下的请求文件不在结果里，界面要另行说明。 */
  failedDirectories: number;
  /** 是否被 isCancelled 中止；true 时 files 同样只是中途结果。 */
  cancelled: boolean;
  /** 本次逐层新读到的规则；复用调用方规则或未开忽略开关时为空数组。 */
  gitignoreRules: GitignoreRule[];
};

/**
 * 判断文件名是否为请求文件
 * @param name 文件名（不含路径）
 * @returns 扩展名命中 HTTP_REST_EXTENSIONS 时为 true
 */
export function isHttpRestFileName(name: string): boolean {
  return HTTP_REST_EXTENSIONS.has(extname(String(name || "")));
}

/** 逐层扫描的共享上下文（一次调用一份，递归过程中只改不改形）。 */
type ScanContext = {
  /** 工作区根绝对路径，算相对路径与规则 base 都用它。 */
  rootPath: string;
  /** 是否应用 .gitignore；归一后的布尔值，来自 HttpRestScanOptions.respectGitignore。 */
  respect: boolean;
  /** 调用方给定的全仓规则；未给定时为 null，此时逐层自采。 */
  shared: GitignoreRule[] | null;
  /** 本次自采到的规则累加器（浅层在前），最终随结果返回。 */
  collected: GitignoreRule[];
  /** 命中文件累加器。 */
  files: HttpRestFile[];
  /** 已访问目录计数；与 budget 比较决定是否截断。 */
  visited: number;
  /** 目录访问预算；取自选项或 MAX_SCAN_DIRECTORIES。 */
  budget: number;
  /** 是否真的因预算停下（visited 恰好等于预算、且目录已访问完时不算截断）。 */
  budgetHit: boolean;
  /** 列目录失败的目录数；失败不等于空目录，界面要如实说明结果不完整。 */
  failedDirectories: number;
  /** 在途列目录调用数；与 MAX_IN_FLIGHT_READS 比较。 */
  inFlight: number;
  /** 在途数满时的等待队列，按先来后到唤醒。 */
  waiters: Array<() => void>;
  /** 取消判定回调；调用方未提供时恒返回 false。 */
  isCancelled: () => boolean;
  /** 是否已被取消；一旦置真，所有在途分支都立即返回。 */
  cancelled: boolean;
};

/**
 * 取一个列目录名额；在途数满就排队等。
 * @param ctx 共享扫描上下文
 * @returns 拿到名额后 resolve
 */
function acquireReadSlot(ctx: ScanContext): Promise<void> {
  if (ctx.inFlight < MAX_IN_FLIGHT_READS) {
    ctx.inFlight += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    ctx.waiters.push(() => {
      ctx.inFlight += 1;
      resolve();
    });
  });
}

/**
 * 归还名额并唤醒下一个等待者。
 * @param ctx 共享扫描上下文
 */
function releaseReadSlot(ctx: ScanContext): void {
  ctx.inFlight -= 1;
  const next = ctx.waiters.shift();
  if (next) next();
}

/**
 * 读某一层的 .gitignore 并解析成规则。
 * @param dir 目录绝对路径
 * @param rootPath 工作区根绝对路径，用于算规则 base
 * @param entries 本层已列出的子条目（用来确认这一层到底有没有 .gitignore）
 * @returns 该层自身的规则（base 已填），无规则时为空数组
 * @description 根目录自身的 base 是空串，不能用「相对路径为假值」判越界：
 *   那样最该读的根上 .gitignore 会被跳过。越界一律由 relativePath 回 null 表示。
 *   先查列目录结果再决定读不读，与文件树的补读逻辑同一手法：无脑读每个目录的
 *   .gitignore 会让整仓扫描多付出一倍 IPC。
 */
async function readLayerRules(
  dir: string,
  rootPath: string,
  entries: DirectoryEntry[]
): Promise<GitignoreRule[]> {
  const rel = relativePath(rootPath, dir);
  if (rel === null) return [];
  const ignoreEntry = entries.find((entry) => entry && !entry.isDirectory && entry.name === ".gitignore");
  if (!ignoreEntry) return [];
  let res;
  try {
    res = await readFileContent(ignoreEntry.path);
  } catch {
    return [];
  }
  if (!res || res.isBinary || typeof res.content !== "string") return [];
  return parseGitignore(res.content, rel === "." ? "" : rel);
}

/**
 * 判断某条目路径是否被当前可用规则忽略；无相对路径或无规则时一律不忽略。
 * @param entry 宿主目录条目
 * @param relPath 条目相对工作区根的路径
 * @param rules 当前生效的规则集
 * @returns 命中忽略时为 true
 */
function isEntryIgnored(entry: DirectoryEntry, relPath: string, rules: GitignoreRule[]): boolean {
  if (!relPath || !rules.length) return false;
  return isIgnoredByRules(relPath, !!entry.isDirectory, rules);
}

/**
 * 访问一个目录：收下其中的请求文件，并对可进入的子目录继续递归。
 * @param dir 目录绝对路径
 * @param inherited 由浅到深累积的规则（复用调用方规则时始终是那份全仓规则）
 * @param ctx 共享扫描上下文
 */
async function scanDirectory(dir: string, inherited: GitignoreRule[], ctx: ScanContext): Promise<void> {
  if (ctx.cancelled) return;
  if (ctx.isCancelled()) {
    ctx.cancelled = true;
    return;
  }
  if (ctx.visited >= ctx.budget) {
    // 只有走到这一步才叫「被预算截断」：访问数恰好等于预算而目录已访问完时不该报不完整。
    ctx.budgetHit = true;
    return;
  }
  ctx.visited += 1;

  let entries: DirectoryEntry[];
  await acquireReadSlot(ctx);
  try {
    entries = await readDirectoryEntries(dir);
  } catch {
    // 失败不等于空目录：少了整棵子树却自称「扫完了」，用户只会觉得文件凭空消失。
    ctx.failedDirectories += 1;
    return;
  } finally {
    releaseReadSlot(ctx);
  }
  if (!Array.isArray(entries) || !entries.length) return;

  // 复用调用方规则时不再读盘；自采时把本层规则同时挂到继承链与累加器上。
  let rules = inherited;
  if (ctx.respect && !ctx.shared) {
    const own = await readLayerRules(dir, ctx.rootPath, entries);
    if (own.length) {
      rules = inherited.concat(own);
      ctx.collected.push(...own);
    }
  }
  if (ctx.cancelled || ctx.isCancelled()) {
    ctx.cancelled = true;
    return;
  }

  const dirs: DirectoryEntry[] = [];
  for (const entry of entries) {
    if (!entry || !entry.path) continue;
    if (!entry.isDirectory) {
      if (!isHttpRestFileName(entry.name)) continue;
      // 忽略开关关闭时命中项照样列出，与文件树「浅色显示而非隐藏」同一语义。
      if (ctx.respect && isEntryIgnored(entry, getRelativeGitPath(entry.path, ctx.rootPath), rules)) continue;
      ctx.files.push({
        name: String(entry.name || ""),
        path: entry.path,
        relPath: getRelativeGitPath(entry.path, ctx.rootPath) || String(entry.name || ""),
        size: typeof entry.size === "number" ? entry.size : 0,
      });
      continue;
    }
    // 元数据目录恒剪枝：整仓扫描没有懒展开兜底，进 .git/objects 会白跑海量目录。
    if (isExcludedMeta(entry.name)) continue;
    if (ctx.respect && isEntryIgnored(entry, getRelativeGitPath(entry.path, ctx.rootPath), rules)) continue;
    dirs.push(entry);
  }

  await mapPool(dirs, SCAN_CONCURRENCY, (child) => scanDirectory(child.path, rules, ctx));
}

/** 目录层级路径比较用的 Collator：数字感知 + 忽略大小写差异，与文件树排序同一档规则。 */
const REL_PATH_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * 在工作区根下扫描全部请求文件。
 * @description 深度优先 + 每层并发 8；规则随递归由浅到深传递，深层 .gitignore 覆盖浅层，
 *   与 git 语义一致。宿主列目录能力缺失时 readDirectoryEntries 回空数组，本函数即得空结果。
 * @param options 扫描入参（根目录、忽略开关、可复用规则、取消回调、目录预算）
 * @returns 命中清单与截断/取消标记；`files` 已按相对路径升序
 */
export async function scanHttpRestFiles(options: HttpRestScanOptions): Promise<HttpRestScanResult> {
  const rootPath = String(options?.rootPath || "");
  const ctx: ScanContext = {
    rootPath,
    respect: options?.respectGitignore !== false,
    shared: Array.isArray(options?.gitignoreRules) ? options.gitignoreRules : null,
    collected: [],
    files: [],
    visited: 0,
    budget:
      typeof options?.maxDirectories === "number" && options.maxDirectories > 0
        ? options.maxDirectories
        : MAX_SCAN_DIRECTORIES,
    budgetHit: false,
    failedDirectories: 0,
    inFlight: 0,
    waiters: [],
    isCancelled: typeof options?.isCancelled === "function" ? options.isCancelled : () => false,
    cancelled: false,
  };
  if (!rootPath) {
    return { files: [], directoriesVisited: 0, truncated: false, failedDirectories: 0, cancelled: false, gitignoreRules: [] };
  }
  await scanDirectory(rootPath, ctx.shared || [], ctx);
  ctx.files.sort((a, b) => REL_PATH_COLLATOR.compare(a.relPath, b.relPath));
  return {
    files: ctx.files,
    directoriesVisited: ctx.visited,
    truncated: ctx.budgetHit && !ctx.cancelled,
    failedDirectories: ctx.failedDirectories,
    cancelled: ctx.cancelled,
    gitignoreRules: ctx.collected,
  };
}
