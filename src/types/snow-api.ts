/**
 * 宿主原始 API（`window.snow`）的插件可见子集。
 *
 * 真源是 Snow App 的 preload 出口：`src/preload/index.ts:55` 把 24 个模块对象展开成
 * `contextBridge.exposeInMainWorld("snow", api)`，`src/preload/index.ts:60` 导出
 * `export type SnowApi = typeof api`。宿主那份类型包含 ssh / conversation / updater /
 * pets 等与文件浏览器无关的能力，因此这里只声明插件**实际调用**的 34 个方法，
 * 逐个方法标注宿主出处（文件:行号），清单与签名对照见 docs/host-api.md。
 *
 * 之所以按「宿主一定提供」来声明而不是全方法可选：宿主进程内 `window.snow` 必然存在，
 * 整个对象不会缺，缺的只会是跨版本新增的个别方法。这类缺失目前**没有**集中的 capability 层，
 * 而是在各调用点就地探测（`typeof snow.xxx === "function"`，见 `src/services/git-actions.ts` 各动作的
 * 入口判空、`src/services/file-service.ts` 的读取守卫、`src/services/terminal-runner.ts` 的
 * `isTerminalAvailable()`），探测不通过就走「宿主未提供该能力」的降级分支。
 *
 * 文件改动只有「新建文件」走这条通道（`writeFileContent`）：受 privacy 门控的
 * `filesystem.writeFile` 动作还多一道「正文不许为空白」的入参检查，新建空文件会被它挡下来。
 * 改名与删除仍走 `api.write.run("filesystem.*")`，见 src/types/plugin-runtime.ts。
 */

import type { ResponsesApiResult, ResponsesApiStreamChunk } from "./host/host-api.ts";
import type {
  GitBranch,
  GitCheckoutResult,
  GitCommitResult,
  GitDiffResult,
  GitFileContentResult,
  GitPushPullResult,
  GitStageResult,
  GitStatusResult,
} from "./host/host-git.ts";
import type { DetectedTerminal } from "./host/host-settings.ts";
import type {
  DirectoryEntry,
  FileContentResult,
  FileSearchResult,
} from "./host/host-workspace.ts";

/**
 * `ptyCreate` 的入参，宿主以内联对象声明（`src/preload/modules/systemApi.ts:1266-1272`），此处具名以便复用。
 */
export type PtyCreateOptions = {
  /** 进程工作目录，必须是绝对路径；宿主不允许为空，否则创建失败。 */
  cwd: string;
  /** 初始终端列数，用于 xterm 与 PTY 的宽度对齐。 */
  cols: number;
  /** 初始终端行数。 */
  rows: number;
  /** 指定 shell 可执行文件路径；省略时宿主按终端设置解析默认 shell。 */
  shellPath?: string;
  /** 会话标识；宿主用它做跨面板保活与复用，省略时为一次性会话。 */
  sessionId?: string;
};

/** `onPtyOutput` 回调载荷：一条 PTY 输出。 */
export type PtyOutputPayload = {
  /** 产生输出的 PTY 进程 id（`ptyCreate` 的返回值）。 */
  id: string;
  /** 原始输出字节流文本，需直接喂给 xterm，不做行切分。 */
  data: string;
};

/** `onPtyExit` 回调载荷：PTY 进程退出。 */
export type PtyExitPayload = {
  /** 退出的 PTY 进程 id。 */
  id: string;
  /** 退出码；非阻塞信号等非正常结束由宿主归一为数字。 */
  exitCode: number;
};

/** 宿主事件订阅方法的统一返回：取消订阅函数，必须在面板卸载时调用。 */
export type Unsubscribe = () => void;

/**
 * 插件可见的宿主原始 API。
 *
 * 每一段的注释头是宿主 preload 中的定义位置，签名变动必须先重跑
 * `node tools/sync-host-api.mjs` 并同步 docs/host-api.md。
 */
export type SnowApi = {
  // ---- 文件系统与目录监听：宿主 src/preload/modules/workspaceApi.ts ----

  /**
   * 读取目录的直接子条目（不递归）。
   * @param dirPath 目录绝对路径
   * @returns 子条目列表；目录不存在时宿主抛错，调用方需捕获
   */
  readDirectoryEntries: (dirPath: string) => Promise<DirectoryEntry[]>;

  /**
   * 读取单个文件内容。
   * @param filePath 文件绝对路径
   * @returns `FileContentResult`：文本文件 `content` 为正文，图片与二进制为 base64，
   *          由 `isImage` / `isBinary` / `isSvg` 与 `mimeType` 区分渲染方式
   */
  readFileContent: (filePath: string) => Promise<FileContentResult>;

  /**
   * 写入单个文件的完整正文（覆盖写，父目录不存在时由宿主一并建出来）。
   * @param filePath 文件绝对路径；宿主只要求它是非空白字符串，**不校验是否在工作区以内**
   * @param content 完整文本；空串也收（新建的空文件本来就没有正文）
   * @returns 写入完成即 resolve，没有回传数据；写失败时 reject，错误文本由宿主给出
   */
  writeFileContent: (filePath: string, content: string) => Promise<void>;

  /**
   * 按名称与工作区行内容搜索文件。
   * @param dirPath 搜索根目录绝对路径
   * @param query 关键词
   * @returns 命中文件列表，含 `relativePath` 与行级命中 `lineMatches`
   */
  searchFiles: (dirPath: string, query: string) => Promise<FileSearchResult[]>;

  /**
   * 开始监听目录变化（宿主侧 fs.watch，带防抖）。
   * @param dirPath 目录绝对路径；同一目录重复调用由宿主去重
   */
  startDirectoryWatch: (dirPath: string) => Promise<void>;

  /**
   * 结束目录监听，与 `startDirectoryWatch` 成对使用。
   * @param dirPath 之前注册的目录绝对路径
   */
  stopDirectoryWatch: (dirPath: string) => Promise<void>;

  /**
   * 订阅目录变化事件。
   * @param callback 收到变化的目录绝对路径；只告知「变了」，不带变更清单，需回读目录
   * @returns 取消订阅函数
   */
  onDirectoryChanged: (callback: (dirPath: string) => void) => Unsubscribe;

  // ---- Git：宿主 src/preload/modules/gitApi.ts ----

  /**
   * 拉取仓库状态（分支、领先/落后、变更文件清单）。
   * @param repoPath 仓库根绝对路径
   * @returns `GitStatusResult`；`isRepo` 为 false 表示该路径不是 git 仓库，
   *          `statusLimitHit` 为 true 表示变更清单被宿主上限截断
   */
  gitStatus: (repoPath: string) => Promise<GitStatusResult>;

  /**
   * 订阅 git 状态变化事件（宿主在仓库目录上监听后推送）。
   * @param callback 收到变化的仓库根绝对路径
   * @returns 取消订阅函数
   */
  onGitStatusChanged: (callback: (repoPath: string) => void) => Unsubscribe;

  /**
   * 列出本地与远程分支。
   * @param repoPath 仓库根绝对路径
   * @returns `GitBranch[]`，`isCurrent` 标记当前分支，`isRemote` 区分远端分支
   */
  gitBranches: (repoPath: string) => Promise<GitBranch[]>;

  /**
   * 暂存指定文件（git add）。
   * @param repoPath 仓库根绝对路径
   * @param filePaths 相对仓库根的文件路径列表
   * @returns `success` + `message`（失败原因文本）
   */
  gitStage: (repoPath: string, filePaths: string[]) => Promise<GitStageResult>;

  /**
   * 取消暂存指定文件。
   * @param repoPath 仓库根绝对路径
   * @param filePaths 相对仓库根的文件路径列表
   */
  gitUnstage: (repoPath: string, filePaths: string[]) => Promise<GitStageResult>;

  /**
   * 暂存全部变更（git add -A）。
   * @param repoPath 仓库根绝对路径
   */
  gitStageAll: (repoPath: string) => Promise<GitStageResult>;

  /**
   * 取消暂存全部变更。
   * @param repoPath 仓库根绝对路径
   */
  gitUnstageAll: (repoPath: string) => Promise<GitStageResult>;

  /**
   * 提交已暂存内容。
   * @param repoPath 仓库根绝对路径
   * @param message 提交信息
   * @returns `hash` 为新生成的提交号，失败时为 null
   */
  gitCommit: (repoPath: string, message: string) => Promise<GitCommitResult>;

  /**
   * 推送到远端。
   * @param repoPath 仓库根绝对路径
   * @param remote 远端名，省略时宿主按当前分支跟踪关系解析
   * @param branch 分支名，省略时为当前分支
   * @param setUpstream 是否附带 -u 建立跟踪关系
   * @returns `success` + `message`（git 的 stderr 摘要）
   */
  gitPush: (
    repoPath: string,
    remote?: string,
    branch?: string,
    setUpstream?: boolean,
  ) => Promise<GitPushPullResult>;

  /**
   * 从远端拉取。
   * @param repoPath 仓库根绝对路径
   * @param remote 远端名，省略时按跟踪关系解析
   * @param branch 分支名，省略时为当前分支
   */
  gitPull: (
    repoPath: string,
    remote?: string,
    branch?: string,
  ) => Promise<GitPushPullResult>;

  /**
   * 切换分支。
   * @param repoPath 仓库根绝对路径
   * @param branchName 目标分支名
   */
  gitCheckout: (repoPath: string, branchName: string) => Promise<GitCheckoutResult>;

  /**
   * 取单个文件的 diff 文本。
   * @param repoPath 仓库根绝对路径
   * @param filePath 相对仓库根的文件路径
   * @param staged true 取已暂存区 diff，false 取工作区 diff
   * @returns `content` 为 unified diff 文本，`isBinary` 标记二进制，
   *          `error` 非空表示 git 命令失败
   */
  gitFileDiff: (
    repoPath: string,
    filePath: string,
    staged: boolean,
  ) => Promise<GitDiffResult>;

  /**
   * 取某版本下某文件的内容，用于 diff 左右两侧对比。
   * @param repoPath 仓库根绝对路径
   * @param filePath 相对仓库根的文件路径
   * @param revision 版本标识；null 表示取工作区当前内容
   */
  gitFileContent: (
    repoPath: string,
    filePath: string,
    revision: string | null,
  ) => Promise<GitFileContentResult>;

  /**
   * 丢弃工作区改动（危险操作，宿主不做二次确认，确认交互归插件）。
   * @param repoPath 仓库根绝对路径
   * @param filePaths 相对仓库根的文件路径列表
   */
  gitDiscardChanges: (
    repoPath: string,
    filePaths: string[],
  ) => Promise<GitStageResult>;

  /**
   * 由宿主调用当前 AI 配置生成提交信息（流式）。
   * @param repoPath 仓库根绝对路径
   * @param onChunk 流式增量回调，用于边生成边填输入框
   * @param onStreamId 同步回传本次流 id，需在弹窗关闭时用 `abortCommitMessage` 中止
   * @returns 生成完毕的 `ResponsesApiResult`，`content` 即提交信息正文
   */
  generateCommitMessage: (
    repoPath: string,
    onChunk?: (chunk: ResponsesApiStreamChunk) => void,
    onStreamId?: (streamId: string) => void,
  ) => Promise<ResponsesApiResult>;

  /**
   * 中止正在进行的提交信息生成。
   * @param streamId `generateCommitMessage` 的 onStreamId 回传值
   * @returns 是否命中在跑的任务（已完成或从未启动为 false）
   */
  abortCommitMessage: (streamId: string) => Promise<boolean>;

  // ---- 终端 PTY 与剪贴板：宿主 src/preload/modules/systemApi.ts ----

  /**
   * 创建无头 PTY 进程。
   * @param options 工作目录、初始行列与 shell 选择
   * @returns PTY 进程 id，后续 write/resize/kill 与输出事件都以它为键
   */
  ptyCreate: (options: PtyCreateOptions) => Promise<string>;

  /**
   * 向 PTY 写入输入（键盘输入、命令均走这里）。
   * @param id `ptyCreate` 返回的进程 id
   * @param data 待写入文本，需自带换行才会执行
   */
  ptyWrite: (id: string, data: string) => Promise<void>;

  /**
   * 调整 PTY 尺寸，必须与 xterm 的 fit 结果同步，否则 TUI 程序排版错乱。
   * @param id PTY 进程 id
   * @param cols 列数
   * @param rows 行数
   */
  ptyResize: (id: string, cols: number, rows: number) => Promise<void>;

  /**
   * 结束 PTY 进程（连同宿主侧的进程树）。
   * @param id PTY 进程 id
   */
  ptyKill: (id: string) => Promise<void>;

  /**
   * 订阅 PTY 输出。事件按进程 id 分发，插件侧需自行按 id 过滤后再写入对应终端。
   * @param callback 输出载荷回调
   * @returns 取消订阅函数
   */
  onPtyOutput: (callback: (data: PtyOutputPayload) => void) => Unsubscribe;

  /**
   * 订阅 PTY 退出事件。
   * @param callback 退出载荷回调
   * @returns 取消订阅函数
   */
  onPtyExit: (callback: (data: PtyExitPayload) => void) => Unsubscribe;

  /**
   * 读系统剪贴板文本。走主进程，不受渲染进程剪贴板权限与焦点限制。
   * @returns 剪贴板文本；为空时返回空串
   */
  readClipboardText: () => Promise<string>;

  /**
   * 写系统剪贴板文本。
   * @param text 待写入文本
   */
  writeClipboardText: (text: string) => Promise<void>;

  // ---- 系统设置与终端探测：宿主 src/preload/modules/apiConfigApi.ts ----

  /**
   * 按设置码读宿主系统设置的值。
   * @param settingCode 设置码（如终端 shell、字号等宿主设置项）
   * @returns 设置值文本；未设置或不存在时为 null，调用方需自备默认值
   */
  getSystemSettingValue: (settingCode: string) => Promise<string | null>;

  /**
   * 探测系统上可用的终端 shell。
   * @returns 候选 shell 列表，`family` 决定命令拼接与引号规则
   */
  detectTerminals: () => Promise<DetectedTerminal[]>;

  // ---- 插件包文件读取：宿主 src/preload/modules/pluginsApi.ts ----

  /**
   * 读取插件自身安装目录内的文本文件，供懒加载 chunk 做 blob import。
   * @param pluginId 插件 id（取 `api.id`）
   * @param relativePath 相对插件安装根的路径，如 `chunks/highlighter.js`
   * @returns 文件文本内容；读取失败宿主抛错
   */
  readPluginFile: (pluginId: string, relativePath: string) => Promise<string>;
};

declare global {
  interface Window {
    /** 宿主 preload 注入的原始 API；插件只在 Snow App 进程内运行，故声明为必然存在。 */
    snow: SnowApi;
  }
}

export {};
