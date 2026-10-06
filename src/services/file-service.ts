/**
 * 文件系统服务模块 (src/services/file-service.ts)
 * 统一封装与宿主 window.snow 的文件及目录读取 API，并提供排序与路径工具
 */

import { mapPool } from "../utils/async.ts";
import type {
  DirectoryEntry,
  FileContentResult,
} from "../types/host/host-workspace.ts";
import type { PluginWriteDenied } from "../types/host/plugin-writes-types.ts";
import type {
  FilesystemWriteActionName,
  FilesystemWriteData,
  FilesystemWriteParams,
  WriteActionId,
} from "../types/plugin-runtime.ts";

/**
 * 目录树条目的最小字段集合。
 * @description 排序与 JVM 证据判定只看名称与是否目录，不需要绝对路径，
 *   因此搜索结果、宿主目录条目、插件虚拟节点都能参与。
 */
export type FileTreeEntryBase = {
  /** 条目名称，不含任何路径分隔符。 */
  name: string;
  /** 是否目录；宿主脏数据可能缺失，一律按假值处理。 */
  isDirectory?: boolean;
};

/**
 * 目录树节点：树上唯一流转的形态。
 * @description 宿主 readDirectoryEntries 返回的 DirectoryEntry 是本类型的子集（宿主必给 size，
 *   插件自建节点可以缺）；插件在展开目录、按规则过滤、构造 JVM 包视图时会在同一对象上追加
 *   下面这些可选字段，所以它们必须在本类型上声明，否则写入侧（src/index.ts）与读取侧
 *   （components/tree-view.ts、services/java-project.ts）只能各自内联一份并靠断言对接。
 *   tree-view 的 `TreeEntry`、java-project 的 `JvmTreeNode` 都是本类型的别名。
 */
export type FileTreeEntry = FileTreeEntryBase & {
  /** 条目绝对路径；Git 状态、读写动作与懒加载子目录都以它为唯一键。 */
  path: string;
  /** 是否目录；宿主必给，插件侧对脏数据一律按真值判定。 */
  isDirectory: boolean;
  /** 字节数；宿主目录条目必给，插件自建节点（虚拟包、搜索结果）可以缺失。 */
  size?: number;
  /** 子节点列表；目录展开或包视图构建完成后由插件写入，未展开时缺失。 */
  children?: FileTreeEntry[];
  /** 展示名；JVM 包节点用紧凑包名代替目录名，缺省时回退 name。 */
  displayName?: string;
  /** 包全名（点号分隔）；仅 JVM 压缩包节点有，用作行 title。 */
  packageName?: string;
  /** 是否为 JVM 包视图合成的紧凑包节点；true 时 path 仍指向真实目录。 */
  isVirtualPackage?: boolean;
  /** 是否为 Java/Kotlin 源码根目录；detectJvmProject 判定后在展开时写入，渲染行样式用。 */
  isJavaSourceRoot?: boolean;
  /** 名称是否属于 .git 一类版本控制元数据项（file-filter.annotate 写入）。 */
  isMetaExcluded?: boolean;
  /** 是否被某条 .gitignore 规则命中（file-filter.annotate 写入）。 */
  isGitignored?: boolean;
  /** 两类排除任一命中：开关关闭时以浅色显示而非隐藏（file-filter.annotate 写入）。 */
  isSoftHidden?: boolean;
};

/**
 * 宿主运行时 API 中本模块真正依赖的子集。
 * @description 只用到 `write.run`；宿主版本差异下 write 或 run 可能整体缺失，
 *   因此全部字段可选，调用方拿到 ok:false 而不是抛异常。返回值按本模块的信封建模
 *   （action 可缺），宿主 PluginWriteApi.run 的响应可直接赋值过来。
 */
export type FileWriteRuntimeApi = {
  /** 受 privacy 门控的写通道；旧宿主可能完全不注入。 */
  write?: {
    /** 通用写入口，按 `domain.action` 执行一个写动作并返回宿主响应。 */
    run?: ((actionId: WriteActionId, params?: Record<string, unknown>) => Promise<FileWriteResult>) | null;
  } | null;
};

/**
 * 文件写动作的统一结果封装。
 * @description 本模块把「宿主没有该能力」「宿主返回 ok:false」「IPC 抛异常」三类失败
 *   全部收敛成 ok:false + error 文本，调用方不得再伪造成功。
 *   宿主侧的响应类型是快照里的 `PluginWriteResponse`（`action` 必填），本类型只在
 *   `action` 上放宽：前两类失败由本模块自己构造，没有宿主响应可填，与契约无关。
 * @template TData 该动作回传的数据形状；由 `FilesystemWriteData` 按动作 id 映射得出，
 *   默认 unknown 只用于确实说不清的场合，包装函数不应让调用点自己猜。
 */
export type FileWriteResult<TData = unknown> = {
  /** 是否执行成功；未授权、动作失败与异常都为 false，且不会 reject。 */
  ok: boolean;
  /** 实际执行的 `domain.action` 标识；宿主回传时必填，本模块自造的失败对象里没有。 */
  action?: string;
  /** 宿主回传数据；结构随动作不同，由 TData 指定，缺失时为 undefined。 */
  data?: TData;
  /** 未授权时的拒绝原因；隐私 scope 未声明或动作不存在时由宿主给出。 */
  denied?: PluginWriteDenied;
  /** 失败原因文本；成功时缺失。 */
  error?: string;
};

/** 捕获到的异常在本模块视角下的形态：只读 message 一个字段。 */
export type ErrorLike = {
  /** 错误描述文本；宿主与 Node 抛出的非 Error 对象可以缺失。 */
  message?: string;
};

/**
 * 获取文件或路径的基准名称 (basename)
 * @param p 文件路径
 * @returns 末段名称
 */
export function basename(p: string): string {
  const s = String(p || "").replace(/[/\\]+$/, "");
  const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return idx >= 0 ? s.slice(idx + 1) : s;
}

/**
 * 获取文件扩展名 (不含点，全部小写)
 * @param fileNameOrPath 文件名或路径
 * @returns 扩展名，无扩展名时为空串
 */
export function extname(fileNameOrPath: string): string {
  const base = basename(fileNameOrPath);
  const dot = base.lastIndexOf(".");
  if (dot > 0) return base.slice(dot + 1).toLowerCase();
  if (dot === 0 && base.length > 1) return base.slice(1).toLowerCase();
  return "";
}

/**
 * 规范化目录条目列表并按“文件夹在前、名称升序”规则排序
 * @param entries 待排序的条目（宿主目录条目或树上的任意派生节点）
 * @returns 排序后的条目列表，元素类型与入参一致
 */
export function sortEntries<T extends FileTreeEntryBase>(entries: readonly T[]): T[] {
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
 * @param dirPath 目录绝对路径
 * @returns 宿主目录条目列表；能力不可用或路径为空时为空数组
 */
export async function readDirectoryEntries(dirPath: string): Promise<DirectoryEntry[]> {
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
 * @param filePath 文件绝对路径
 * @returns FileContentResult；接口不可用时返回 null
 */
export async function readFileContent(filePath: string): Promise<FileContentResult | null> {
  const snow = window.snow;
  if (!snow || typeof snow.readFileContent !== "function" || !filePath) {
    return null;
  }
  return await snow.readFileContent(filePath);
}

/**
 * 执行插件文件系统写动作，并把宿主的失败响应统一转换为 ok:false。
 * @param api Snow App 插件运行时 API
 * @param actionId filesystem 写动作名称（不含 `filesystem.` 前缀）
 * @param params 该动作的入参；形状由 `FilesystemWriteParams` 按动作 id 映射
 * @param unavailableMessage 宿主未提供动作时的错误文案
 * @returns 统一的 ok/data/denied/error 结果，`data` 按动作 id 收窄
 */
export async function runWriteAction<TName extends FilesystemWriteActionName>(
  api: FileWriteRuntimeApi | null,
  actionId: TName,
  params: FilesystemWriteParams[`filesystem.${TName}`],
  unavailableMessage = "当前宿主未提供文件操作能力"
): Promise<FileWriteResult<FilesystemWriteData[`filesystem.${TName}`]>> {
  const run = api && api.write && api.write.run;
  if (typeof run !== "function") {
    return { ok: false, error: unavailableMessage };
  }
  try {
    // 通用入口 `run` 把 data 交成 unknown（宿主响应本就是 unknown），而动作 id 唯一决定形状：
    // 宿主 writes/domains/admin.ts 里每个 filesystem 动作各自 return。整个模块只在这一处断言，
    // 包装函数据此把具体形状带给调用点，调用侧不再需要自己猜字段。
    const result = (await run(`filesystem.${actionId}`, params)) as FileWriteResult<FilesystemWriteData[`filesystem.${TName}`]>;
    if (result && result.ok === true) return result;
    return {
      ...(result && typeof result === "object" ? result : {}),
      ok: false,
      error: result && result.error ? String(result.error) : "文件操作失败",
    };
  } catch (err) {
    return { ok: false, error: err && (err as ErrorLike).message ? (err as ErrorLike).message : String(err) };
  }
}

/**
 * 重命名工作区文件或目录。
 * @param api Snow App 插件运行时 API
 * @param rootPath 工作区根目录
 * @param entryPath 条目路径
 * @param newName 新名称
 * @returns 统一的 ok/data/error 结果，data 为宿主回传的改名三要素
 */
export function renameFileSystemEntry(
  api: FileWriteRuntimeApi | null,
  rootPath: string,
  entryPath: string,
  newName: string
) {
  return runWriteAction(
    api,
    "rename",
    { rootPath, entryPath, newName },
    "当前宿主未提供文件重命名能力"
  );
}

/**
 * 删除工作区文件或目录。
 * @param api Snow App 插件运行时 API
 * @param rootPath 工作区根目录
 * @param entryPath 要删除的条目路径
 * @returns 统一的 ok/data/error 结果，data 为宿主回传的删除目标
 */
export function deleteFileSystemEntry(
  api: FileWriteRuntimeApi | null,
  rootPath: string,
  entryPath: string
) {
  return runWriteAction(
    api,
    "delete",
    { rootPath, entryPath },
    "当前宿主未提供文件删除能力"
  );
}

/**
 * 批量删除工作区文件或目录（单次 IPC，避免 N+1 次往返）。
 * @param api Snow App 插件运行时 API
 * @param rootPath 工作区根目录
 * @param entryPaths 要删除的条目路径数组
 * @returns 统一的 ok/data/error 结果；
 *   data 为宿主 BatchWorkspaceDeleteResult：`{ deleted: string[], failed: Array<{path, error}> }`
 * @description data 的形状由 `runWriteAction` 按动作 id `filesystem.deleteBatch` 从
 *   `FilesystemWriteData` 映射出来（宿主 src/renderer/plugins/writes/domains/admin.ts:915 直接透传
 *   deleteWorkspaceEntries 的结果）；建模成 unknown 会让调用点读不到字段——index.ts 原先就因此踩空。
 */
export function deleteFileSystemEntries(
  api: FileWriteRuntimeApi | null,
  rootPath: string,
  entryPaths: string[]
) {
  return runWriteAction(
    api,
    "deleteBatch",
    { rootPath, entryPaths: Array.isArray(entryPaths) ? entryPaths : [] },
    "当前宿主未提供批量删除能力"
  );
}

/**
 * 计算工作区内路径的相对路径。
 * @description 使用 Windows 分隔符做大小写不敏感的边界比较，避免把 `repo2` 误判为 `repo` 子路径。
 * @param fromRoot 工作区根路径
 * @param targetPath 目标路径
 * @returns 统一使用 `/` 的相对路径；越界或路径无效时返回 null
 */
export function relativePath(fromRoot: string, targetPath: string): string | null {
  const normalize = (value: string): string | null => {
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
 * @param api Snow App 插件运行时 API
 * @param filePath 文件绝对路径
 * @param content 要写入的完整文本
 * @returns 统一的 ok/data/denied/error 结果，成功时 data 为宿主回传的 filePath
 */
export function writeFileContent(
  api: FileWriteRuntimeApi | null,
  filePath: string,
  content: string
) {
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
 */
export const JVM_BUILD_FILES: ReadonlyMap<string, string> = Object.freeze(
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

/** JVM 项目判定强度。 */
export type JvmProjectConfidence = "strong" | "weak" | "none";

/** JVM 项目检测结论。 */
export type JvmProjectDetection = {
  /** 是否判定为 Java/JVM 项目：有构建文件、有标准源码根目录，或至少两个 Java/Kotlin 源文件。 */
  isJavaProject: boolean;
  /** 与 isJavaProject 同义的别名结论，保留给旧调用方读取。 */
  isJvmProject: boolean;
  /** 判定强度：构建文件/标准源码根目录为 strong，仅靠多个源文件为 weak，其余 none。 */
  confidence: JvmProjectConfidence;
  /** 构建系统：maven 或 gradle；两者都命中为 mixed；没有任何构建文件时为 null。 */
  buildSystem: string | null;
  /** 命中的构建文件名清单，保留宿主返回的原始大小写。 */
  buildFiles: string[];
  /** 已发现的标准 Java/Kotlin 源码根目录绝对路径，已去重。 */
  sourceRoots: string[];
  /** 根目录直接子条目里的 .java 文件数（不含同名目录）。 */
  javaFileCount: number;
  /** 根目录直接子条目里的 .kt 文件数（不含同名目录）。 */
  kotlinFileCount: number;
  /** Java 与 Kotlin 源文件总数，弱信号判定用。 */
  jvmFileCount: number;
  /** 命中的证据标签清单（build-file / standard-source-root / multiple-java-files / multiple-kotlin-files）。 */
  evidence: string[];
};

/**
 * 读取条目名称，忽略宿主 API 可能返回的脏数据。
 * @param entries 目录直接子条目
 * @returns 只保留 name 为字符串的条目，元素类型与入参一致
 */
function normalizeProjectEntries<T extends FileTreeEntryBase>(entries: T[]): T[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => entry && typeof entry.name === "string");
}

/**
 * 从已读取的目录信息判断其是否具备 Java/Kotlin JVM 项目证据。
 * @param entries 项目根目录直接子条目
 * @param sourceRoots 已发现的标准 Java/Kotlin 源码根目录
 * @returns 判定结论，含强度、构建系统与证据清单
 */
export function detectJvmProjectFromEntries(
  entries: FileTreeEntryBase[],
  sourceRoots: string[] = []
): JvmProjectDetection {
  const items = normalizeProjectEntries(entries);
  const buildFiles: string[] = [];
  const buildSystems: Set<string> = new Set();
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
  const evidence: string[] = [];
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
 * @param entries 根目录直接子条目
 * @returns 命中构建文件或 Java/Kotlin 源文件时为 true
 */
export function hasJvmRootMarker(entries: FileTreeEntryBase[]): boolean {
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
 * @param rootPath 项目根目录绝对路径
 * @param knownRootEntries 已经读到的根目录条目
 * @returns 判定结论，sourceRoots 为探测到的标准源码根目录
 */
export async function detectJvmProject(
  rootPath: string,
  knownRootEntries?: FileTreeEntry[]
): Promise<JvmProjectDetection> {
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

  const roots: string[] = [];
  const seenPaths: Set<string> = new Set();

  async function addSourceRoot(
    basePath: string,
    baseEntries: FileTreeEntry[],
    segments: string[]
  ): Promise<void> {
    const sourcePath = await findDirectoryFromEntries(basePath, baseEntries, segments);
    if (sourcePath && !seenPaths.has(sourcePath)) {
      seenPaths.add(sourcePath);
      roots.push(sourcePath);
    }
  }

  async function findDirectoryFromEntries(
    basePath: string,
    baseEntries: FileTreeEntry[],
    segments: string[]
  ): Promise<string | null> {
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

// 保留旧导出名，迁移后的测试仍经它调用同一套 JVM 检测实现。
export const detectJavaProjectFromEntries = detectJvmProjectFromEntries;

/** 元数据域里指向单个目录的记录，宿主只在其中放插件需要的路径信息。 */
export type MetadataDirectoryRecord = {
  /** 目录绝对路径；宿主未选定项目时缺失或为空串。 */
  path?: string;
  /** 宿主记录上的其余字段（directoryId / name / pathState 等），本模块只透传不解读。 */
  [key: string]: unknown;
};

/** 本模块会从 api.metadata.get 响应里读取的那部分结构。 */
export type ActiveDirectoryMetadata = {
  /** projects / runtime 等域的载荷表；宿主把它声明为 Record<string, unknown>，这里只窄化到本模块消费的字段。 */
  domains?: {
    /** projects 域载荷；当前不在项目上下文时缺失。 */
    projects?: {
      /** 激活项目记录；宿主在无激活项目时给 null。 */
      active?: MetadataDirectoryRecord | null;
    } | null;
    /** runtime 域载荷；旧宿主没有该域时缺失。 */
    runtime?: {
      /** 激活目录记录，语义与 projects.active 等价。 */
      activeDirectory?: MetadataDirectoryRecord | null;
    } | null;
    /** 其余元数据域的原始载荷，本模块不消费。 */
    [key: string]: unknown;
  };
  /** 响应上的其余字段（generatedAt / denied / withheld / unknown）本模块不消费。 */
  [key: string]: unknown;
};

/**
 * 从 api.metadata.get 的响应中解析当前激活项目目录
 * @description 宿主契约：api.metadata.get(domain | domain[]) 返回包裹对象
 *   { generatedAt, domains, denied, withheld, unknown }，数据位于 response.domains[domainId]。
 *   domains.projects.active 即激活项目记录；与 domains.runtime.activeDirectory 等价。
 * @param response api.metadata.get 的返回对象
 * @returns 激活项目绝对路径；未找到时返回空字符串
 */
export function resolveActiveDirectoryPath(response: ActiveDirectoryMetadata | null): string {
  const domains: NonNullable<ActiveDirectoryMetadata["domains"]> = (response && response.domains) || {};
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
