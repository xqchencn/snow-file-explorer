/**
 * Snow App 文件浏览器插件 (renderMode: "esm")
 * 模块化顶层入口：协调文件服务、Git 状态、目录树视图与代码预览器
 */

import type { PluginRuntimeApi, SystemWriteActionName } from "./types/plugin-runtime.ts";
import type { GitSyncIndicatorHandle } from "./components/git-sync-indicator.ts";
import type { TranslateFn, GitOperation, DiffViewMode } from "./types/panel-state.ts";
import type { Unsubscribe } from "./types/snow-api.ts";
import type {
  BatchWorkspaceDeleteResult,
  FileSearchResult,
  FileContentResult,
  DirectoryEntry,
} from "./types/host/host-workspace.ts";
import type { GitStatusResult, GitFileStatus } from "./types/host/host-git.ts";
import type {
  ErrorLike,
  FileTreeEntry,
  FileWriteResult,
  JvmProjectDetection,
} from "./services/file-service.ts";
import type { GitStatusMap, GitTreeNode } from "./services/git-service.ts";
import type { GitignoreRule, ExclusionFilterOptions } from "./services/file-filter.ts";
import type { ViewSettings } from "./services/settings.ts";
import type { ProjectCommandsResult, FlatRunCommand } from "./services/project-commands.ts";
import type { RunCommand } from "./services/ecosystems.ts";
import type { PtySessionResult, ResolvedRunShell } from "./services/terminal-runner.ts";
import type {
  CodePreviewState,
  CodeTextPreview,
  CodePreviewDiff,
  CodePreviewMode,
  GitViewerMode,
} from "./components/code-viewer.ts";
import type {
  ToolWindowOptions,
  ToolWindowHandle,
  ToolWindowMode,
  ToolWindowDock,
} from "./components/tool-window.ts";
import type { XtermViewOptions, XtermView } from "./components/terminal-view.ts";
import type { RunToolbarHandle } from "./components/run-toolbar.ts";
import type { GitCommitMode, GitSection, GitViewOptions } from "./components/git-view.ts";
import type { TreeSelectionChange } from "./components/tree-view.ts";

import { el, copyToClipboard, humanSize } from "./utils/dom.ts";
import { createActionIcon } from "./icons/action-icons.ts";
import {
  basename,
  sortEntries,
  readDirectoryEntries,
  readFileContent,
  writeFileContent,
  renameFileSystemEntry,
  deleteFileSystemEntry,
  deleteFileSystemEntries,
  relativePath,
  resolveActiveDirectoryPath,
  detectJvmProject,
} from "./services/file-service.ts";
import {
  subscribeGitStatus,
  getRelativeGitPath,
  getGitStatus,
  partitionGitFiles,
  gitFilesSignature,
  collectGitFolderPaths,
} from "./services/git-service.ts";
import { shouldVirtualize } from "./components/highlight-policy.ts";
import { loadChunk, releaseChunkStyles } from "./services/lazy-chunk.ts";
import { installFileIcons, refreshInstalledIcons, createFileIconNode } from "./icons/file-icons.ts";
import { mapPool } from "./utils/async.ts";
import { renderTreeView, paintTreeGitStatus, destroyTreeView } from "./components/tree-view.ts";
import { loadJvmPackageTree } from "./services/java-project.ts";
import { renderCodeViewer, syncViewerChrome, disposeViewerViewport } from "./components/code-viewer.ts";
import { renderGitCommitBar, renderGitList, closeGitContextMenu } from "./components/git-view.ts";
import { renderGitSyncIndicator } from "./components/git-sync-indicator.ts";
import {
  isMarkdownPath,
  normalizePath,
  resolveMarkdownAssetPath,
  readImageAsDataUrl,
} from "./services/markdown-asset.ts";
import {
  filterExcludedEntries,
  parseGitignore,
  isExcludedMeta,
  isIgnoredByRules,
  joinPath,
} from "./services/file-filter.ts";
import {
  loadViewSettings,
  saveViewSettings,
  loadDiffViewMode,
  saveDiffViewMode,
} from "./services/settings.ts";
import {
  gitStage,
  gitUnstage,
  gitStageAll,
  gitUnstageAll,
  gitCommit,
  gitPush,
  gitSync,
  gitDiscardChanges,
  gitFileDiff,
  generateCommitMessage,
  abortCommitMessage,
} from "./services/git-actions.ts";
import { parseUnifiedDiff } from "./services/diff.ts";
import { ensureProjectCommands, flattenCommands } from "./services/project-commands.ts";
import {
  createPtySession,
  isTerminalAvailable,
  resolveRunShell,
  resolveScriptShell,
  DEFAULT_COLS,
  DEFAULT_ROWS,
} from "./services/terminal-runner.ts";
import { renderToolWindow } from "./components/tool-window.ts";
import { renderRunToolbar } from "./components/run-toolbar.ts";

// ---------------------------------------------------------------------------
// 面板内部类型（src/index.ts 私有，不导出）
// 这些形状的真源就是本文件的 state 对象与终端记录；组件层只消费其中切片。
// 跨层已有的形状一律 import 复用（见上方 import type），此处只声明确实新增的部分。
// ---------------------------------------------------------------------------

/**
 * 一个终端 / 运行 tab 的记录（`state.terminals` 的元素）。
 * @description 组件层经 ToolWindowTerminal 只读其中一部分；pty 会话、阶段令牌与防抖定时器
 *   只有本文件用，故不写进组件层类型。
 */
type TerminalTab = {
  /** tab 唯一 id：`term-<时间戳36进制>-<terminalToken>`，两种模式同格式。 */
  id: string;
  /** 归属命令 id（模式 A 供 Run/Stop 按命令二态判定）；模式 B（交互终端）为 null。 */
  commandId: string | null;
  /** tab 标题：模式 A 用命令原文，模式 B 用 t("run.terminal", "终端")。 */
  title: string;
  /** 双模式标记："run" 一次性运行 / "terminal" 常驻交互，词汇复用 ToolWindowMode；由 handleNewTerminal 建 tab 时定。 */
  mode: ToolWindowMode;
  /** pty 会话；创建前与进程退出后置 null。 */
  session: PtySessionResult | null;
  /** 进程是否已退出（模式 A 的 ✓/✗ 与工具栏 Run/Stop 判定依据）；初值 false，onExit 置 true。 */
  exited: boolean;
  /** 退出码；未退出或宿主未回传时为 null。 */
  exitCode: number | null;
  /** 键盘输入回调（xterm → shell）；pty 建好之前为 null。 */
  onInput: ((data: string) => void) | null;
  /** 尺寸变化回调（xterm → pty）；pty 建好之前为 null。 */
  onResize: ((cols: number, rows: number) => void) | null;
  /** 待敲入 shell 的命令原文；初值由 handleNewTerminal 给定，敲入成功后在 createTerminalForId 清空，重跑时由 handleRerunTerminal 回填。 */
  pendingCommand: string;
  /** 脚本文件绝对路径；非空时按脚本扩展名选解释器，非脚本命令为 ""。 */
  scriptPath: string;
  /** 会话工作目录：命令所属包目录或项目根。 */
  cwd: string;
  /** 任务所属项目根；切换项目后据此判定是否「其他项目」的后台任务。 */
  projectPath: string;
  /** pty 启动阶段令牌：每次（重）启动 +1，用于丢弃旧 pty 迟到的 onData/onExit。 */
  phase: number;
  /** 所属项目展示名；仅 syncRetainedRuns 给模式 A 写入，交互终端可缺。 */
  projectLabel?: string;
  /** 是否属于其他项目且未打开「显示其他项目任务」开关；可缺，true 时不画 tab。 */
  hiddenRun?: boolean;
  /** onResize 的 120ms 尾沿防抖定时器；未排程时为 null，创建前可缺。 */
  resizeTimer?: ReturnType<typeof setTimeout> | null;
  /** 最近一次 fit 出来的尺寸，但当时还没有 pty session 可发；session 建好后补发一次，发完置 null。 */
  pendingResize?: { cols: number; rows: number } | null;
  /** 「命令尚未敲入」的 800ms 兜底定时器；未排程时为 null，创建前可缺。 */
  commandTimer?: ReturnType<typeof setTimeout> | null;
};

/**
 * handleNewTerminal 的入参（也接受命令原文字符串，内部先归一成本类型）。
 * @description 全部可缺：模式 B 只带 cwd/mode，模式 A 带 command/commandId/title/scriptPath。
 */
type NewTerminalOptions = {
  /** 交给 shell 执行的命令原文；缺省按空串处理。 */
  command?: string;
  /** 归属命令 id；模式 B 不传。 */
  commandId?: string | null;
  /** 展示标题；缺省时模式 A 用命令原文、模式 B 用「终端」文案。 */
  title?: string;
  /** 双模式；缺省按 "terminal"。 */
  mode?: ToolWindowMode;
  /** 会话工作目录；缺省回落到当前项目根。 */
  cwd?: string;
  /** 脚本文件绝对路径；非脚本命令不传。 */
  scriptPath?: string;
};

/**
 * 代码预览状态：组件层的可辨联合 `CodePreviewState`，叠加 index 侧自用的两个缺口。
 * @description ① `editable` 是内联编辑开关，只由本文件读写，
 *   code-viewer 把它当作 CodeViewerOptions 的独立入参、没有放进预览联合；
 *   ② 本文件多处不先判 `kind` 就读写 `text` / `html` / `mode` / `saveState`（如
 * ），故把这些文本类字段按 `Partial` 交叉进来，
 *   让它们在每个 kind 分支上都可见。可辨性仍由 `kind` 保持，判过 kind 后照旧收窄。
 */
type PanelPreviewState = CodePreviewState &
  Partial<Omit<CodeTextPreview, "kind">> & {
    /** 预览区是否处于内联编辑态；初值 false，切换文件与保存后重置。 */
    editable?: boolean;
  };

/**
 * Git 变更视图右侧文件查看器的状态（`state.gitPreview`）。
 * @description 由 openGitDiff 建立，之后各处只做「展开 + 覆盖单个字段」的不可更新新。
 */
type GitPreviewState = {
  /** 选中键 `` `${section}:${relPath}` ``，与 state.gitSelected 同格式，用于丢弃过期异步结果。 */
  key: string;
  /** 文件名（不含路径），由 basename(relPath) 得到。 */
  name: string;
  /** 仓库相对路径，取 gitFileDiff 的入参。 */
  relPath: string;
  /** 绝对路径，读文件与「在资源管理器中打开」用。 */
  absPath: string;
  /** 所属分区（已暂存 / 变更），决定取 --cached 还是工作区差异。 */
  section: GitSection;
  /** 是否暂存区，与 section 同源但已归一为布尔。 */
  isStaged: boolean;
  /** 右侧子视图（差异 / 内容）；初值 "diff"，setGitPreviewMode 切换。 */
  mode: GitViewerMode;
  /** 差异切片（加载态 / 解析结果 / 工作区全文 / 错误文案），直接透传给预览。 */
  diff: CodePreviewDiff;
  /** 「内容」子视图的文件预览；未加载与差异态为 null。 */
  file: PanelPreviewState | null;
};

/**
 * 文件树 / 空白区右键菜单的状态（`state.contextMenu`）。
 * @description 菜单内容由 renderContextMenu 现成 DOM，本对象只携带定位与目标条目。
 */
type ContextMenuState = {
  /** 菜单目标条目；空白区右键时为 null（空白分支见）。 */
  entry: FileTreeEntry | null;
  /** 菜单左上角视口 x 坐标（clientX），。 */
  x: number;
  /** 菜单左上角视口 y 坐标（clientY），。 */
  y: number;
  /** 是否处于内联重命名输入态；只由 beginRename 置 true，重渲染时保留。 */
  renaming?: boolean;
};

/**
 * 插件内确认弹窗的状态（`state.confirmDialog`）。
 * @description 由 openConfirmDialog 建立；同时只允许一个，故存在即代表弹窗打开。
 */
type ConfirmDialogState = {
  /** 弹窗标题（已由 t 翻译），同时用作 aria-label。 */
  title: string;
  /** 弹窗正文，可含 `` {{count}} `` 已插值后的文本。 */
  message: string;
  /** 确认按钮文案；缺失时 renderConfirmDialog 回退「确认」。 */
  confirmLabel?: string;
  /** 是否按危险动作渲染（红色样式）；openConfirmDialog 默认 true。 */
  danger?: boolean;
  /** 点击确认后的动作；可为异步函数，异常由 confirmDialogAction 捕获。 */
  onConfirm: () => void | Promise<void>;
};

/**
 * 一次 Git 写操作在串行队列里的槽位（`gitActionQueue` 的元素）。
 * @description busy 只用于按钮忙碌态文案与互斥，fn 才是真正的写操作。
 */
type GitActionQueueItem = {
  /** 进行中的操作名，写入 state.gitBusy；取值出处 GitOperation。 */
  busy: GitOperation;
  /** 实际写操作（内部自行 refresh），由 drainGitActions 串行 await。 */
  fn: () => Promise<void>;
};

/**
 * loadGitPreviewDiff 的入参（拉取单个文件的差异与工作区全文）。
 * @description 从 state.gitPreview 里取出后传入，回写时凭 key 丢弃过期结果。
 */
/**
 * 单个文件的预览上限（字节）。
 * @description 宿主 readFileContent 不接受长度参数，超过这个量的文本会整份进内存再分行，
 *   面板表现为假死；宁可明说「太大」，也不让点击一个日志文件卡住整个应用。
 */
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;

type LoadGitPreviewDiffArgs = {
  /** 选中键 `` `${section}:${relPath}` ``，用于判断异步结果是否已过期。 */
  key: string;
  /** 仓库相对路径，作为 gitFileDiff 的入参。 */
  relPath: string;
  /** 绝对路径，用于读工作区全文。 */
  absPath: string;
  /** 是否取暂存区差异。 */
  isStaged: boolean;
  /** 显式刷新：绕过差异缓存重取一份。 */
  force?: boolean;
};

/**
 * 骨架 DOM 引用集合（`layoutEls`）。
 * @description ensureLayout 只建一次；treePane/previewPane/gitPane/gitPreviewPane 随主视图
 *   重建后置 null 再回填；treeBody/searchInput/searchClear 只有对应视图构建后才存在。
 */
type LayoutEls = {
  /** 插件挂载根节点（.sfe-root），弹窗与右键菜单都挂在它下面。 */
  root: HTMLElement;
  /** 横排外层容器（.sfe-container）。 */
  layout: HTMLElement;
  /** 左侧竖排入口栏。 */
  sidebar: HTMLElement;
  /** 入口栏顶部组（文件 / Git 主视图切换）。 */
  sidebarTop: HTMLElement;
  /** 入口栏底部组（运行 / 终端工具窗口）。 */
  sidebarBottom: HTMLElement;
  /** 「文件」主视图按钮；可缺（旧骨架残留时可能尚未取到）。 */
  fileViewBtn?: HTMLButtonElement;
  /** 「Git 变更」主视图按钮；可缺。 */
  gitViewBtn?: HTMLButtonElement;
  /** 入口栏「运行」按钮；可缺。 */
  runSideBtn?: HTMLButtonElement;
  /** 入口栏「运行」按钮上的运行中圆点；可缺。 */
  runSideDot?: HTMLElement;
  /** 入口栏「终端」按钮；可缺。 */
  terminalSideBtn?: HTMLButtonElement;
  /** 主体纵排容器（工具栏 + 主视图 + 底栏）。 */
  body: HTMLElement;
  /** 主视图与工具窗口的横排容器。 */
  bodyMain: HTMLElement;
  /** 主视图容器（文件树 / Git 列表都建在它里面）。 */
  mainView: HTMLElement;
  /** 运行工具窗口宿主。 */
  runWindowEl: HTMLElement;
  /** 终端工具窗口宿主。 */
  terminalWindowEl: HTMLElement;
  /** 工具栏当前项目名文本节点。 */
  pathText: HTMLElement;
  /** 工具栏同步指示器宿主。 */
  syncIndicatorWrap: HTMLElement;
  /** 工具栏操作状态条。 */
  statusEl: HTMLElement;
  /** 工具栏「差异 / 内容」切换宿主。 */
  gitViewSwitchWrap: HTMLElement;
  /** 工具栏运行控件宿主。 */
  runToolbarWrap: HTMLElement;
  /** 文件树面板；主视图切到 Git 或未构建时为 null。 */
  treePane: HTMLElement | null;
  /** 普通预览面板；未构建文件视图时为 null。 */
  previewPane: HTMLElement | null;
  /** Git 变更列表面板；未构建 Git 视图时为 null。 */
  gitPane: HTMLElement | null;
  /** Git 右侧查看器面板；未构建 Git 视图时为 null。 */
  gitPreviewPane: HTMLElement | null;
  /** 文件树滚动容器，仅文件视图存在。 */
  treeBody?: HTMLElement | null;
  /** 搜索输入框，仅文件视图存在。 */
  searchInput?: HTMLInputElement | null;
  /** 搜索清除按钮，仅文件视图存在。 */
  searchClear?: HTMLButtonElement | null;
};

/**
 * 面板状态对象（`state`）的完整形状。
 * @description 字段初值集中在 ；每个字段的可缺性与取值出处见逐条注释。
 *   以 null 初始化的字段必须在此显式给出真类型，否则 TS 会把它们推成 null 类型，
 *   后续每次赋值都报错。
 */
type PanelState = {
  /** 当前工作区根目录绝对路径；未取到宿主激活项目时为 ""。 */
  rootPath: string;
  /** 根目录已排序、已过滤的树节点；null 表示尚未加载或已切换项目（切换时置 null，loadRoot 写真实条目、读盘失败置 []）。 */
  rootNodes: FileTreeEntry[] | null;
  /** JVM 项目识别结论；null 表示未识别或已切换项目（切换时置 null，refreshJavaProject 写 detectJvmProject 结果）。 */
  javaProject: JvmProjectDetection | null;
  /** 项目运行命令识别结果（含 rootPath 缓存键）；null 表示尚未扫描（置 null，由 ensureProjectCommands 就地写入）。 */
  projectCommands: ProjectCommandsResult | null;
  /** 用户手动点过文件行内 ▶ 的脚本命令，临时并入顶栏 Run 下拉；切换项目清空。 */
  manualScriptCommands: FlatRunCommand[];
  /** 终端集合（IDEA 式多 tab，两种模式混存、按 mode 分给对应窗口）；初值 。 */
  terminals: TerminalTab[];
  /** 终端窗口（模式 B）的激活 tab id；无激活项为 null。 */
  activeTerminalId: string | null;
  /** 运行窗口（模式 A）的激活 tab id，与 activeTerminalId 各自维护；无激活项为 null。 */
  activeRunTerminalId: string | null;
  /** 底部当前显示哪个工具窗口：null 收起 / "terminal" / "run"。 */
  bottomView: ToolWindowMode | null;
  /** 是否把其他项目尚未结束的启动任务也显示出来；默认 false。 */
  showOtherProjectRuns: boolean;
  /** 工具窗口停靠：bottom 底栏 / right 右侧，两窗口共用。 */
  toolDock: ToolWindowDock;
  /** 主视图二选一：files 文件树 / git 变更列表。 */
  mainView: "files" | "git";
  /** 目录展开态表，键为绝对路径；初值与切换项目、切包视图时重置为空表。 */
  expanded: Record<string, boolean>;
  /** 文件树选中集合（多选，绝对路径）；空集表示无选中。初值在 state 初始化，切换项目、路径迁移、删除裁剪与框选处整体替换。 */
  selected: Set<string>;
  /** shift 范围选择的锚点路径（最近一次普通/ctrl 点击）；无锚点为 null。 */
  selectionAnchor: string | null;
  /** 文件搜索查询词；空串表示不在搜索态。 */
  searchQuery: string;
  /** 宿主 searchFiles 的结果（已按视图开关过滤）；初值 写入宿主返回。 */
  searchResults: FileSearchResult[];
  /** 搜索是否进行中。 */
  searching: boolean;
  /** 搜索结果点击「跳行」的目标行号（1 基，一次性消费后回 null）；初值 写入。 */
  pendingRevealLine: number | null;
  /** 工具栏状态条文本（操作成功/失败或加载提示）；空串表示不显示。 */
  status: string;
  /** 是否刚复制过代码（驱动复制按钮反馈，1600ms 后回 false）； 初值， 写入。 */
  copied: boolean;
  /** 文件树染色用的 Git 状态表，键为仓库相对路径（正斜杠）；初值 写入。 */
  gitStatusMap: GitStatusMap;
  /** 视图开关（排除元数据 / 按 .gitignore 过滤 / JVM 包视图）；初值 写宿主读取值。 */
  viewSettings: ViewSettings;
  /** 递归收集的 .gitignore 规则；初值 写入。 */
  gitignoreRules: GitignoreRule[];
  /** 是否已全仓扫过一遍 .gitignore（显式刷新置 true，切项目回 false）； 初值， 写入。 */
  gitignoreFullyLoaded: boolean;
  /** 已补读过 .gitignore 的目录键（pathKey 归一），避免重复读盘；初值 重置。 */
  gitignoreLoadedDirs: Set<string>;
  /** 右键菜单状态；null 表示未打开。 */
  contextMenu: ContextMenuState | null;
  /** 确认弹窗状态；null 表示未打开。 */
  confirmDialog: ConfirmDialogState | null;
  /** 是否有文件写操作进行中（期间禁用右键菜单与删除）； 初值， 写入。 */
  operationBusy: boolean;
  /** 最近一次宿主 gitStatus 快照；null 表示未加载、非仓库或已切换项目。 */
  gitStatus: GitStatusResult | null;
  /** 提交信息草稿；提交成功与切换项目时清空。 */
  gitCommitMessage: string;
  /** Git 写操作队列当前执行中的动作；空闲为 null。 */
  gitBusy: GitOperation | null;
  /** 顶栏「同步」（先 pull 后 push）整链路的进行态；与 gitBusy 分开，空闲为 null。 */
  gitSyncBusy: GitOperation | null;
  /** 是否正在由 AI 生成提交信息（输入框只读、按钮转「停止」）； 初值， 写入。 */
  gitGenerating: boolean;
  /** 宿主生成提交信息的流 id，用于中止；未在生成时为 null。 */
  gitStreamId: string | null;
  /** Git 变更列表当前选中键 `` `${section}:${path}` ``；未选中为 null。 */
  gitSelected: string | null;
  /** Git 右侧文件查看器状态；null 表示未打开差异文件。 */
  gitPreview: GitPreviewState | null;
  /** 差异展示模式（unified 行内 / split 分栏）；类型取 `types/panel-state.ts` 的 DiffViewMode，与 settings.ts 的持久化开关同一真源。初值 写入。 */
  diffMode: DiffViewMode;
  /** 提交按钮模式（提交 / 提交并推送）；初值 写入。 */
  gitCommitMode: GitCommitMode;
  /** 提交模式下拉是否展开；初值 写入。 */
  gitCommitMenuOpen: boolean;
  /** 已暂存区折叠的目录相对路径集合；null 表示尚未按首次仓库状态初始化默认折叠（初值 null，applyActiveProject 重置，applyGitStatus 首次写入）。 */
  collapsedStaged: Set<string> | null;
  /** 变更区折叠的目录相对路径集合（用户自己的折叠操作，不随 watcher 覆盖）；初值 重置。 */
  collapsedUnstaged: Set<string>;
  /** 右侧代码预览状态（可辨联合，见 PanelPreviewState）；初值 为空态。 */
  preview: PanelPreviewState;
};

/**
 * 当前面板根目录的规范化键（小写 + 去尾部分隔符）
 * @description 宿主在 Windows 可能返回反斜杠路径，比较前统一大小写与分隔符。
 * @param p 路径；`data-*` 之类属性可能缺省（DOMStringMap 的索引类型是 `string | undefined`），
 *   实现按假值兜成空串，故接受 undefined。
 * @returns {string}
 */
function pathKey(p: string | undefined): string {
  return normalizePath(p || "").toLowerCase().replace(/[/\\]+$/, "");
}
/**
 * 触发宿主右面板全屏模式切换
 * @description 宿主全屏按钮 className 恒为 "icon-btn ghost right-panel-fullscreen-btn"，
 *   全屏状态由 .right-panel.fullscreen / .app-shell.right-panel-fullscreen 承载。
 * @returns 是否成功触发
 */
function requestRightPanelFullscreen(): boolean {
  const btn = document.querySelector<HTMLElement>(".right-panel-fullscreen-btn");
  if (btn && typeof btn.click === "function") {
    btn.click();
    return true;
  }
  return false;
}

/**
 * 判断宿主右侧面板是否处于全屏态
 * @description 宿主全屏状态由 .right-panel.fullscreen / .app-shell.right-panel-fullscreen 承载。
 * @returns 是否全屏
 */
function isRightPanelFullscreen(): boolean {
  return !!document.querySelector(".right-panel.fullscreen, .app-shell.right-panel-fullscreen");
}

/**
 * 等待浏览器完成下一帧渲染。
 * @returns 下一帧回调完成
 */
function waitForNextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function"
    ) {
      // 断言只用于对齐 Promise executor 的 resolve 与 DOM 回调形状：
      // FrameRequestCallback 声明入参 time:number，本实现忽略入参，故先落成零参函数。
      window.requestAnimationFrame(resolve as () => void);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * 确保宿主右侧面板进入全屏。
 * @description 宿主全屏状态由 React 异步更新，点击按钮后必须等待 DOM class 更新并确认结果。
 * @returns 是否已进入全屏
 */
async function ensureRightPanelFullscreen(): Promise<boolean> {
  if (isRightPanelFullscreen()) return true;
  if (!requestRightPanelFullscreen()) return false;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await waitForNextFrame();
    if (isRightPanelFullscreen()) return true;
  }

  return false;
}

/**
 * 插件主挂载入口
 * @param container 挂载目标容器
 * @param api Snow App 注入的插件运行时 API
 * @param [_options] 额外宿主挂载参数（保留签名兼容，插件不自建多项目会话）
 * @returns 清理卸载函数
 */
export function mount(
  container: HTMLElement,
  api: PluginRuntimeApi,
  _options: Record<string, unknown> = {},
): () => void {
  let disposed = false;
  // 三个延时器都是 setTimeout 返回值：标注取 ReturnType，DOM 与 Node 两种全局签名下都成立。
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  let operationTimer: ReturnType<typeof setTimeout> | null = null;
  let gitDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let previewRequestId = 0;
  let saveRequestId = 0;
  // 终端创建令牌：终端在 pty 建好前被关闭时，用它作废「迟到」的创建结果，避免泄漏孤儿进程。
  let terminalToken = 0;
  // 底部工具窗口控制器（renderToolWindow 的返回值）。两个窗口各自常驻、互斥显示：
  //   terminalWindow = 交互终端窗口；runWindow = 运行窗口。各自持有自己的 xterm 实例，切换不丢输出。
  let terminalWindow: ToolWindowHandle | null = null;
  let runWindow: ToolWindowHandle | null = null;
  // 工具栏运行控件控制器（renderRunToolbar 的返回值）。
  let runToolbar: RunToolbarHandle | null = null;
  // 顶栏同步指示器控制器（renderGitSyncIndicator 的返回值）。
  let gitSyncIndicator: GitSyncIndicatorHandle | null = null;
  // 图标块、运行 shell、Git 状态在一次面板生命周期内复用，避免重复解析和重复请求。
  let iconsPromise: Promise<void> | null = null;
  let runShellPromise: Promise<ResolvedRunShell> | null = null;
  let gitInflight: Promise<GitStatusResult | null> | null = null;
  let gitInflightRoot = "";

  /** 加载全部文件图标。与列目录并行，树的第一帧就使用完整图标集。 */
  function ensureIcons() {
    if (!iconsPromise) {
      iconsPromise = loadChunk("icons")
        .then((mod) => {
          if (mod) installFileIcons(mod);
          if (!disposed && runToolbar) renderRunToolbarView();
        })
        .catch((err) => {
          console.warn("[FileExplorer] 图标加载失败", err);
        });
    }
    return iconsPromise;
  }

  let startupToken = 0;

  /**
   * 树出现之后再做图标回填、终端块与运行 shell 预取、JVM 识别和 Git 状态。
   * @param {Array} rootEntries 刚刚列到的根目录条目
   */
  function scheduleStartupFollowups(rootEntries: FileTreeEntry[]) {
    const token = ++startupToken;
    const root = state.rootPath;
    const rootToken = pathKey(root);
    void (async () => {
      try {
        await Promise.all([
          ensureIcons().then(() => {
            if (disposed || token !== startupToken) return;
            refreshInstalledIcons(container);
          }),
          // 终端块（480KB）与 shell 探测都排在全仓识别之后，首屏后马上点「终端 / 运行」的人
          // 就得在点击链路上等它们。两件事都与识别互不依赖，提到同一批并发预取。
          loadChunk("terminal").catch((err) => {
            console.warn("[FileExplorer] 终端组件预载失败", err);
          }),
          cachedRunShell().catch(() => undefined),
          refreshJavaProject(root, rootEntries),
          refreshGitAll(),
        ]);
      } catch (err) {
        console.warn("[FileExplorer] 启动后续任务失败", err);
      }
      if (disposed || token !== startupToken || pathKey(state.rootPath) !== rootToken) return;
      try {
        await ensureCommands(rootEntries);
      } catch (err) {
        console.warn("[FileExplorer] 项目命令识别失败", err);
      }
    })();
  }

  /** xterm 在终端块里。工具窗口允许工厂返回 Promise，输出会先暂存。 */
  function createLazyTerminalView(
    host: HTMLElement,
    opts: XtermViewOptions,
  ): Promise<XtermView> {
    return loadChunk("terminal").then((mod) => {
      if (!mod || typeof mod.createXtermView !== "function") {
        throw new Error("终端组件加载失败");
      }
      return mod.createXtermView(host, opts);
    });
  }

  /** 同一项目内复用 shell 解析结果，运行命令不再每次 detectTerminals。 */
  function cachedRunShell() {
    if (!runShellPromise) runShellPromise = resolveRunShell();
    return runShellPromise;
  }

  // 翻译：api.t 不可用时回退到 defaultValue
  // 迁移期偏离（有意，已登记）：防御分支由 `return fallback` 改为 `return fallback ?? key`。
  //   原写法在「宿主没注入 api.t」时返回 undefined，与声明的 string 返回不符，调用点全靠下游兜底；
  //   改后与宿主 api.t 自身的回退链一致（词条缺失 → defaultValue → 插件名 → key）。
  //   该分支在 Snow App 内不会命中，只影响无宿主环境（如构建校验、单测直接调用）。
  const t: TranslateFn = (key, fallback, values) => {
    if (api && typeof api.t === "function") {
      return api.t(key, { defaultValue: fallback, values });
    }
    return fallback ?? key;
  };

  const state: PanelState = {
    rootPath: "",
    rootNodes: null,
    javaProject: null,
    // 项目识别与终端：projectCommands 为懒加载的识别结果（含 rootPath 缓存键）；
    // terminals 为终端集合（IDEA 式多 tab：一个终端一个 tab），activeTerminalId 标记当前 tab。
    projectCommands: null,
    // 脚本命令（bat/sh/ps1）默认不进顶栏 Run 下拉；只有用户手动点过文件行内 ▶ 才临时登记在此。
    manualScriptCommands: [],
    terminals: [],
    // 终端窗口（mode B）的激活 tab。
    activeTerminalId: null,
    // 运行窗口（mode A）的激活 tab（与 activeTerminalId 分开：两个窗口各自维护激活项）。
    activeRunTerminalId: null,
    // 底部当前显示哪个工具窗口：null=收起 | "terminal" | "run"；由左侧竖排入口栏切换。
    bottomView: null,
    // 启动窗口右键开关：是否把其他项目里尚未结束的任务显示出来。默认不显示。
    showOtherProjectRuns: false,
    // 终端 / 运行窗口的停靠：bottom 底栏 | right 右侧（与代码预览同侧）。两个窗口共用。
    toolDock: "bottom",
    // 主视图：始终二选一 —— "files"（文件树）/ "git"（Git 变更）；由左侧入口栏顶部切换，不可都关。
    mainView: "files",
    expanded: Object.create(null),
    // 文件树选中集合（多选）：Set<绝对路径>。空集=无选中；size>1 时右键菜单切批量操作。
    selected: new Set(),
    // shift 范围选择的锚点（最近一次普通/ctrl 点击的路径）。
    selectionAnchor: null,
    // 文件搜索：查询词、结果（宿主 searchFiles 返回）、进行中标志。
    searchQuery: "",
    searchResults: [],
    searching: false,
    // 搜索结果点击「跳行」：预览渲染后要滚动到的目标行（一次性消费）。
    pendingRevealLine: null,
    status: "",
    copied: false,
    gitStatusMap: Object.create(null),
    // 视图开关（默认开启）与多层 .gitignore 规则
    viewSettings: {
      excludeMeta: true,
      respectGitignore: true,
      javaPackageView: true,
    },
    gitignoreRules: [],
    gitignoreFullyLoaded: false,
    gitignoreLoadedDirs: new Set(),
    contextMenu: null,
    confirmDialog: null,
    operationBusy: false,
    // Git 变更视图状态
    gitStatus: null,
    gitCommitMessage: "",
    gitBusy: null,
    // 同步按钮的进行态：与 gitBusy 区分，负责远端 pull / 本地 push 的完整同步链路
    gitSyncBusy: null,
    gitGenerating: false,
    gitStreamId: null,
    gitSelected: null,
    // Git 变更视图右侧文件查看器状态（双击文件行后加载）
    gitPreview: null,
    // 差异展示模式（unified / split）；差异范围固定显示完整文件
    diffMode: "unified",
    gitCommitMode: "commit",
    gitCommitMenuOpen: false,
    // 首次加载仓库时，已暂存目录默认折叠；null 表示尚未初始化默认状态。
    // 初始化后只响应用户自己的折叠/展开操作，不因 Git watcher 刷新而覆盖。
    collapsedStaged: null,
    collapsedUnstaged: new Set(),
    preview: {
      kind: "empty",
      name: "",
      path: "",
      text: "",
      highlightedHtml: "",
      // Markdown 专用字段
      isMarkdown: false,
      mode: "preview", // 预览模式（默认）| code 模式
      html: "", // 已净化的 Markdown HTML
      editable: false,
      saveState: "idle",
      saveMessage: "",
    },
  };

  // 1. 获取当前工作区目录（宿主当前激活项目）
  // 面板槽位固定为 plugin:<pluginId>:<panelId>，由宿主保证「同一面板唯一」；
  // 插件不自建多项目会话、不提供目录选择入口，只跟随宿主项目。
  async function resolveRoot() {
    try {
      if (api && api.metadata && typeof api.metadata.get === "function") {
        const response = await api.metadata.get(["projects", "runtime"]);
        return resolveActiveDirectoryPath(response);
      }
    } catch (err) {
      console.warn("[FileExplorer] 读取激活项目目录失败", err);
    }
    return "";
  }

  // 应用宿主当前激活项目为面板根目录：目录未变则短路，变化则清理旧状态并全量刷新
  async function applyActiveProject(nextPath: string, { force = false }: { force?: boolean } = {}) {
    if (disposed) return;
    const next = nextPath || "";
    if (!force && pathKey(next) === pathKey(state.rootPath)) return;
    const previousRoot = state.rootPath;
    state.rootPath = next;
    state.rootNodes = null;
    state.javaProject = null;
    // 切换项目：交互终端和已经结束的启动任务关掉。
    // 还在跑的启动任务留在原项目目录里，默认不出现在新项目的启动列表中。
    retainUnfinishedRuns(previousRoot);
    if (terminalWindow && typeof terminalWindow.dispose === "function") terminalWindow.dispose();
    terminalWindow = null;
    state.projectCommands = null;
    state.manualScriptCommands = [];
    runShellPromise = null;
    state.activeTerminalId = null;
    if (state.bottomView === "terminal") state.bottomView = null;
    syncRetainedRuns();
    rebuildTerminalWindows();
    // 运行控件随新项目重建（命令集合必然变化）。
    if (runToolbar && typeof runToolbar.dispose === "function") runToolbar.dispose();
    runToolbar = null;
    // 同步指示器状态随新项目刷新（getState 读 state，控制器可复用，无需销毁）。
    state.expanded = Object.create(null);
    state.selected = new Set();
    state.selectionAnchor = null;
    state.searchQuery = "";
    state.searchResults = [];
    state.searching = false;
    state.pendingRevealLine = null;
    state.contextMenu = null;
    state.confirmDialog = null;
    state.operationBusy = false;
    state.gitStatus = null;
    state.collapsedStaged = null;
    state.collapsedUnstaged = new Set();
    state.gitStatusMap = Object.create(null);
    state.gitignoreRules = [];
    state.gitignoreFullyLoaded = false;
    state.gitignoreLoadedDirs = new Set();
    state.gitPreview = null;
    state.gitSelected = null;
    previewRequestId++;
    saveRequestId++;
    state.preview = {
      kind: "empty",
      name: "",
      path: "",
      text: "",
      highlightedHtml: "",
      isMarkdown: false,
      mode: "preview",
      html: "",
      editable: false,
      saveState: "idle",
      saveMessage: "",
    };
    render();
    if (!state.rootPath) {
      stopDirectoryWatch();
      state.status = "";
      renderToolbar();
      return;
    }
    // 先列出根目录。图标、JVM 和 Git 在树出现之后补；运行识别再等它们结束。
    await loadRoot({ followups: true });
    startDirectoryWatch();
  }

  // ------------------------------------------------------------------
  // 目录实时监听：文件系统变化时静默刷新「已加载」目录，保留展开态与滚动位置
  // （对标 snow-app 资源管理器；数据源为宿主 preload 的 startDirectoryWatch / onDirectoryChanged）
  // ------------------------------------------------------------------
  let dirWatchPath = "";        // 当前已 startDirectoryWatch 的根路径
  let unsubDirChanged: Unsubscribe | null = null;   // onDirectoryChanged 取消订阅句柄
  let dirRefreshTimer: ReturnType<typeof setTimeout> | null = null;   // 变化事件防抖定时器（一次写盘可能连发多次）
  // 防抖窗口内累积的变更路径键；null 表示出现过「范围未知」的事件，必须全量刷。
  let dirChangeKeys: string[] | null = [];

  /** 停止目录监听并解绑事件。 */
  function stopDirectoryWatch() {
    if (dirRefreshTimer) {
      clearTimeout(dirRefreshTimer);
      dirRefreshTimer = null;
    }
    // 攒着没消费的变更路径随监听一起作废，下次启动不带旧范围。
    dirChangeKeys = [];
    if (typeof unsubDirChanged === "function") {
      unsubDirChanged();
      unsubDirChanged = null;
    }
    if (dirWatchPath) {
      const snow = snowApi();
      if (snow && typeof snow.stopDirectoryWatch === "function") {
        void snow.stopDirectoryWatch(dirWatchPath).catch(() => undefined);
      }
      dirWatchPath = "";
    }
  }

  /**
   * 启动目录监听：仅监听工作区根目录，事件到达后刷新「已加载」目录（含根）。
   * @description 只刷新已经展开过、已读盘过的目录，未加载目录不主动读盘（惰性展开语义不变）；
   *   变更事件做 250ms 防抖，避免一次写盘触发的连发事件反复读盘。宿主未提供能力时静默降级。
   */
  function startDirectoryWatch() {
    stopDirectoryWatch();
    if (disposed || !state.rootPath) return;
    const snow = snowApi();
    if (!snow || typeof snow.startDirectoryWatch !== "function" || typeof snow.onDirectoryChanged !== "function") {
      return;
    }
    dirWatchPath = state.rootPath;
    void snow.startDirectoryWatch(dirWatchPath).catch(() => undefined);
    unsubDirChanged = snow.onDirectoryChanged((changedPath) => {
      if (disposed) return;
      const root = state.rootPath;
      if (!root) return;
      const changedKey = pathKey(changedPath);
      // 只关心当前工作区内的变化（宿主 watcher 可能推送其它项目的路径）。
      if (changedPath && changedKey !== pathKey(root) && !changedKey.startsWith(pathKey(root) + "/")) {
        return;
      }
      if (dirRefreshTimer) clearTimeout(dirRefreshTimer);
      // 防抖窗口内累积变更路径；收到「无路径」的事件就退回全量刷新（范围未知，不敢猜）。
      if (changedPath) {
        if (dirChangeKeys) dirChangeKeys.push(changedKey);
        else dirChangeKeys = [changedKey];
      } else {
        dirChangeKeys = null;
      }
      dirRefreshTimer = setTimeout(() => {
        dirRefreshTimer = null;
        const keys = dirChangeKeys;
        dirChangeKeys = [];
        void refreshLoadedDirectories(keys);
      }, 250);
    });
  }

  /** 收集所有「已加载」目录路径：根 + 每个已展开且已加载子项的目录（前序，浅层在前）。 */
  function collectLoadedDirPaths() {
    const paths: string[] = [];
    if (state.rootPath) paths.push(state.rootPath);
    const walk = (nodes: FileTreeEntry[] | null) => {
      if (!Array.isArray(nodes)) return;
      for (const entry of nodes) {
        if (entry && entry.isDirectory && state.expanded[entry.path] && Array.isArray(entry.children)) {
          paths.push(entry.path);
          walk(entry.children);
        }
      }
    };
    walk(state.rootNodes);
    return paths;
  }

  /**
   * 用新读取的直接子项替换目录 children，但保留同名子目录已加载的更深层 children。
   * @description 刷新根目录时新节点是全新对象；若不迁移旧 children，所有已展开子目录会丢展开态。
   * @param newNodes 新读取并排序过滤后的条目
   * @param oldNodes 旧的同级条目（用于迁移已加载 children）
   * @returns 合并后的条目
   */
  function mergeLoadedChildren(
    newNodes: FileTreeEntry[],
    oldNodes: FileTreeEntry[] | null | undefined,
  ): FileTreeEntry[] {
    const oldByKey = new Map<string, FileTreeEntry>();
    if (Array.isArray(oldNodes)) {
      for (const node of oldNodes) {
        if (node && node.path) oldByKey.set(pathKey(node.path), node);
      }
    }
    return newNodes.map((node) => {
      const previous = oldByKey.get(pathKey(node.path));
      if (previous && node.isDirectory && Array.isArray(previous.children)) {
        return { ...node, children: previous.children };
      }
      return node;
    });
  }

  /**
   * 静默刷新所有已加载目录：重新读取直接子项，就地替换 children。
   * @description 不重建整棵树，只重渲染列表（renderTree 自身保留 scrollTop）；保留展开态与选中态。
   *   目录读取按 mapPool 并行（watcher 一次防抖可能涉及多层目录，串行 IPC 等待累加）；
   *   读到后的应用阶段保持串行，保证 gitignore 追加与 children 替换按稳定顺序执行。
   */
  async function refreshLoadedDirectories(changedKeys?: string[] | null) {
    if (disposed || !state.rootPath) return;
    const root = state.rootPath;
    const dirPaths = collectLoadedDirPaths();
    // 只刷「包含该变更的最深已加载目录」。重读所有已展开目录会让一次构建写盘变成几十趟 IPC，
    // 而且变更落在没展开的层级时树上根本看不见，读了也是白读。
    let scoped = dirPaths;
    if (changedKeys && changedKeys.length) {
      const targets = new Set<string>();
      for (const changedKey of changedKeys) {
        let deepest = "";
        for (const dirPath of dirPaths) {
          const dirKey = pathKey(dirPath);
          if ((changedKey === dirKey || changedKey.startsWith(dirKey + "/")) && dirKey.length > deepest.length) {
            deepest = dirKey;
          }
        }
        if (deepest) targets.add(deepest);
      }
      if (!targets.size) return;
      scoped = dirPaths.filter((dirPath) => targets.has(pathKey(dirPath)));
    }
    const readResults = await mapPool(scoped, 6, async (dirPath) => {
      try {
        const entries = await readDirectoryEntries(dirPath);
        if (disposed || pathKey(root) !== pathKey(state.rootPath)) return null;
        return { dirPath, entries };
      } catch {
        // 目录可能已被删除或暂时不可读：跳过，不打断其它目录的刷新。
        return null;
      }
    });
    if (disposed || pathKey(root) !== pathKey(state.rootPath)) return;
    for (const read of readResults) {
      if (!read) continue;
      const { dirPath, entries } = read;
      if (pathKey(dirPath) === pathKey(root)) {
        await appendGitignoreFromEntries(dirPath, entries);
        if (disposed || pathKey(root) !== pathKey(state.rootPath)) return;
        const nextNodes = sortEntries(filterExcludedEntries(entries, root, viewFilterOpts()));
        state.rootNodes = mergeLoadedChildren(nextNodes, state.rootNodes);
      } else {
        const node = findTreeEntry(state.rootNodes, dirPath);
        if (!node || !node.isDirectory) continue;
        await appendGitignoreFromEntries(dirPath, entries);
        const nextChildren = sortEntries(filterExcludedEntries(entries, root, viewFilterOpts()));
        node.children = mergeLoadedChildren(nextChildren, node.children);
      }
    }
    if (disposed) return;
    renderTree();
    // 已展开目录的 .gitignore 可能变化：刷新后重算 Git 染色（轻量，不重建树）。
    paintTreeGitStatus(layoutEls && layoutEls.treePane, {
      rootPath: state.rootPath,
      gitStatusMap: state.gitStatusMap,
      t,
    });
  }

  // 刷新 JVM 项目识别结果：与目录树并行，避免阻塞 Git 状态刷新。
  // 结果保存在状态中，后续 JVM 包视图直接复用，不在渲染层重复扫描。
  async function refreshJavaProject(projectPath?: string | null, knownEntries?: FileTreeEntry[]) {
    if (disposed || !state.rootPath) return;
    const path = projectPath || state.rootPath;
    const detected = await detectJvmProject(path, knownEntries);
    // 异步检测期间可能已切换项目，过期结果不能写回当前状态。
    if (disposed || pathKey(path) !== pathKey(state.rootPath)) return;
    state.javaProject = detected;
  }

  // 刷新当前面板：显式刷新会重扫忽略规则；打开面板和窗口聚焦不走这里。
  async function refreshAll() {
    if (disposed || !state.rootPath) return;
    await reloadGitignore();
    if (disposed) return;
    await Promise.all([loadRoot(), refreshJavaProject(), refreshGitAll()]);
  }

  // 2. 拉取 Git 状态（文件树染色与变更列表共用同一次 gitStatus）
  // 同源短路：内容未变化时跳过 render。render 会整体 replaceChildren 重建 DOM，
  // 从而销毁滚动位置与文本选区（表现为「一滑就弹回顶部 / 无法选中复制」）。
  function isSameGitMap(a: GitStatusMap, b: GitStatusMap): boolean {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (a[key] !== b[key]) return false;
    }
    return true;
  }

  async function refreshGitViewStatus() {
    await refreshGitAll();
  }

  function gitStatusToMap(status: GitStatusResult | null): GitStatusMap {
    const map: GitStatusMap = Object.create(null);
    if (status && Array.isArray(status.files)) {
      for (const item of status.files) {
        if (!item || !item.path) continue;
        map[item.path.replace(/\\/g, "/")] = item.status;
      }
    }
    return map;
  }

  function applyGitStatus(status: GitStatusResult | null) {
    const map = gitStatusToMap(status);
    const prev = state.gitStatus;
    const prevFiles = gitFilesSignature(prev);
    const nextFiles = gitFilesSignature(status);
    state.gitStatus = status;
    if (state.collapsedStaged === null && status && status.isRepo) {
      const { staged } = partitionGitFiles(status.files);
      state.collapsedStaged = collectGitFolderPaths(staged);
    }
    const mapChanged = !isSameGitMap(state.gitStatusMap, map);
    if (mapChanged) {
      state.gitStatusMap = map;
      // 变更集合一变，之前缓存的差异与工作区全文都可能过期（同一 key 指向的内容已被改写）。
      gitDiffCache.clear();
    }
    // 列表重建只看「文件集合 / 分支 / 仓库状态」；ahead/behind 只喂同步指示器（顶栏 ↑/↓），
    // 一次 fetch 更新计数不该把整张变更列表重建一遍（滚动位置与选区跟着丢）。
    const repoChanged =
      (!!prev !== !!status) || (!!prev?.isRepo) !== (!!status?.isRepo);
    const branchChanged = (prev?.currentBranch || "") !== (status?.currentBranch || "");
    const listChanged = prevFiles !== nextFiles || repoChanged || branchChanged;
    const countsChanged =
      (prev?.ahead || 0) !== (status?.ahead || 0) ||
      (prev?.behind || 0) !== (status?.behind || 0);
    if (!listChanged && !countsChanged && !mapChanged) return;
    if (mapChanged && state.mainView === "files") {
      paintTreeGitStatus(layoutEls && layoutEls.treePane, {
        rootPath: state.rootPath,
        gitStatusMap: state.gitStatusMap,
        t,
      });
    }
    syncGitIndicator();
    if (state.mainView === "git" && listChanged) renderGitPane();
  }

  // 统一的 Git 刷新：同一次 snow.gitStatus 同时更新染色、变更列表和同步栏。
  async function refreshGitAll() {
    if (!state.rootPath || disposed) return;
    const root = state.rootPath;
    const rootToken = pathKey(root);
    if (!gitInflight || gitInflightRoot !== rootToken) {
      gitInflightRoot = rootToken;
      const request = getGitStatus(root).finally(() => {
        if (gitInflight === request) gitInflight = null;
      });
      gitInflight = request;
    }
    const status = await gitInflight;
    if (disposed || pathKey(state.rootPath) !== rootToken) return;
    applyGitStatus(status);
  }

  // 窗口切回与宿主 watcher 常在几百毫秒内连打，每次都发一趟全仓 status。
  // 统一走同一个尾沿防抖；不做「最小间隔抑制」，避免给用户看过期状态。
  function scheduleGitRefresh(wait = 250): void {
    if (disposed) return;
    if (gitDebounceTimer) clearTimeout(gitDebounceTimer);
    gitDebounceTimer = setTimeout(() => {
      gitDebounceTimer = null;
      void refreshGitAll();
    }, wait);
  }

  // ------------------------------------------------------------------
  // Git 变更视图操作
  // ------------------------------------------------------------------
  // Git 写操作队列：串行执行，忙时入队而非丢弃。
  // 旧实现 `if (state.gitBusy) return null` 会静默吞掉忙碌期的点击（表现为「点了没反应 /
  // 要等一会 / 得先点别处」）；排队后连点会依次执行，且不会并发写同一仓库。
  const gitActionQueue: GitActionQueueItem[] = [];
  let gitActionRunning = false;
  // 写操作只登记刷新需求，由 drainGitActions 在排空后一次付清（见其中注释）。
  let gitRefreshRequested = false;
  function requestGitRefresh(): void {
    gitRefreshRequested = true;
  }

  /** 串行排空队列；每个操作执行前后同步提交栏 / 底栏的忙碌态。 */
  async function drainGitActions() {
    if (gitActionRunning) return;
    gitActionRunning = true;
    try {
      while (gitActionQueue.length && !disposed) {
        const { busy, fn } = gitActionQueue.shift() as GitActionQueueItem;
        state.gitBusy = busy;
        renderGitPaneCommit();
        syncGitIndicator();
        try {
          await fn();
        } catch (err) {
          console.warn("[FileExplorer] Git 操作失败:", err);
        }
      }
      // 队列排空后统一刷一次：原本每个写操作自带一次全仓 status + 整表重建，
      // 连点 N 个文件暂存就要等 N 轮 status（大仓单轮可达秒级）。
      if (!disposed && gitRefreshRequested) {
        gitRefreshRequested = false;
        await refreshGitAll();
      }
    } finally {
      gitActionRunning = false;
      if (!disposed) {
        state.gitBusy = null;
        renderGitPaneCommit();
        syncGitIndicator();
      }
    }
  }

  /**
   * 执行一个 Git 写操作（忙时入队，串行执行，不丢用户点击）。
   * @param busy 进行中的操作名（用于提交栏 / 底栏忙碌态）
   * @param fn 实际写操作（内部自行 refresh）
   * @returns 队列排空完成
   */
  function runGitAction(busy: GitOperation, fn: () => Promise<void>): Promise<void> {
    gitActionQueue.push({ busy, fn });
    return drainGitActions();
  }

  function handleStageToggle(files: GitFileStatus[], section: GitSection) {
    if (!state.rootPath || !Array.isArray(files) || files.length === 0) return;
    const paths = files.map((f) => f.path);
    const isStaged = section === "staged";
    void runGitAction(isStaged ? "unstage" : "stage", async () => {
      const res = isStaged
        ? await gitUnstage(state.rootPath, paths)
        : await gitStage(state.rootPath, paths);
      if (res && res.success) state.gitSelected = null;
      requestGitRefresh();
    });
  }

  function handleStageAll() {
    if (!state.rootPath) return;
    void runGitAction("stageAll", async () => {
      await gitStageAll(state.rootPath);
      state.gitSelected = null;
      requestGitRefresh();
    });
  }

  function handleUnstageAll() {
    if (!state.rootPath) return;
    void runGitAction("unstageAll", async () => {
      await gitUnstageAll(state.rootPath);
      state.gitSelected = null;
      requestGitRefresh();
    });
  }

  function handleCommit() {
    const message = String(state.gitCommitMessage || "").trim();
    if (!state.rootPath || !message) return;
    state.gitCommitMenuOpen = false;
    void runGitAction("commit", async () => {
      const res = await gitCommit(state.rootPath, message);
      if (res && res.success) state.gitCommitMessage = "";
      requestGitRefresh();
    });
  }

  // 提交并推送：提交成功后按当前上游/分支推送
  function handleCommitAndPush() {
    const message = String(state.gitCommitMessage || "").trim();
    if (!state.rootPath || !message) return;
    state.gitCommitMenuOpen = false;
    const upstream = state.gitStatus?.upstream;
    const branch = state.gitStatus?.currentBranch || "";
    const remote = upstream ? String(upstream).split("/")[0] : undefined;
    void runGitAction("commitAndPush", async () => {
      const res = await gitCommit(state.rootPath, message);
      if (!res || !res.success) return;
      state.gitCommitMessage = "";
      state.gitBusy = "push";
      renderGitPaneCommit();
      syncGitIndicator();
      await gitPush(state.rootPath, remote, branch || undefined, !upstream);
      requestGitRefresh();
    });
  }

  // 同步：顶栏文件夹名右侧的同步指示器点击触发（pull → 刷新 → push）。
  // 切换分支 / 逐条拉取推送已移除（宿主内置 Git 面板已提供，插件不再重复）。
  async function handleSync() {
    if (state.gitSyncBusy || state.gitBusy || disposed || !state.rootPath) return;
    state.gitSyncBusy = "sync";
    syncGitIndicator();
    try {
      // 走 refreshGitAll（带在途去重）取基准状态；原先的 `state.gitStatus || await getGitStatus`
      // 绕开了去重，会和并发刷新各发一趟全仓 status。
      await refreshGitAll();
      const status = state.gitStatus;
      const result = await gitSync(state.rootPath, status, async () => {
        await refreshGitAll();
        return state.gitStatus;
      });
      if (!result.success) {
        console.warn("[FileExplorer] Git 同步失败:", result.message);
        return;
      }
      await refreshGitAll();
      // 只有真的可能拉到新提交才重载文件树：树里没有别的同步会改到的内容。
      if ((status?.behind || 0) > 0) await loadRoot();
    } catch (err) {
      console.warn("[FileExplorer] Git 同步异常:", err);
    } finally {
      if (!disposed) {
        state.gitSyncBusy = null;
        syncGitIndicator();
      }
    }
  }

  // 设置提交按钮模式（提交 / 提交并推送），并持久化
  function handleSetCommitMode(mode: GitCommitMode) {
    state.gitCommitMode = mode === "commitAndPush" ? "commitAndPush" : "commit";
    state.gitCommitMenuOpen = false;
    if (api && api.storage && typeof api.storage.setJson === "function") {
      // 偏离（已登记）：宿主 setJson 返回 Promise，原先包它的那个同步 try/catch 挡不住它的拒绝，
      // 写失败会逃逸成 unhandled rejection。改挂 .catch，保持原 catch「静默忽略持久化失败」的语义。
      api.storage.setJson("gitCommitMode", state.gitCommitMode).catch(() => {
        // 忽略持久化失败
      });
    }
    renderGitPaneCommit();
  }

  // 折叠/展开 Git 树的目录
  function handleToggleGitCollapse(section: GitSection, path: string) {
    // collapsedStaged 的初值是 null（还没按首次仓库状态建默认折叠），建表发生在 applyGitStatus，
    // 而折叠 caret 只随 Git 树一起渲染；这里为 null 就是「没有可折叠的树」，直接返回而不是抛 TypeError。
    const set = section === "staged" ? state.collapsedStaged : state.collapsedUnstaged;
    if (!set) return;
    if (set.has(path)) set.delete(path);
    else set.add(path);
    renderGitPane();
  }

  // 丢弃改动：需用户确认（破坏性操作）
  function handleDiscard(files: GitFileStatus[]) {
    if (!state.rootPath || !Array.isArray(files) || files.length === 0) return;
    const label =
      files.length === 1
        ? files[0].path
        : t("git.discardCount", "{{count}} 个文件", { count: files.length });
    openConfirmDialog({
      title: t("git.discardFile", "丢弃更改"),
      message: t("git.discardConfirm", "确定丢弃这些文件的更改？此操作不可撤销。\n{{label}}", { label }),
      confirmLabel: t("git.discardFile", "丢弃更改"),
      onConfirm: async () => {
        const paths = files.map((f) => f.path);
        await runGitAction("discard", async () => {
          await gitDiscardChanges(state.rootPath, paths);
          state.gitSelected = null;
          requestGitRefresh();
        });
      },
    });
  }

  /**
   * 打开 Git 变更文件的差异视图（右侧面板）
   * @description 数据层完全复用宿主 gitFileDiff（内部执行 git diff），插件只负责渲染；
   *   section 决定取暂存区（--cached）还是工作区差异，与宿主 Git 面板双击行为一致。
   * @param file GitFileStatus
   * @param section 文件所在分区
   */
  async function openGitDiff(file: GitFileStatus, section: GitSection) {
    if (!file || !state.rootPath) return;
    const isStaged = section === "staged";
    const relPath = file.path;
    const absPath = joinPath(state.rootPath, relPath);
    const key = `${section}:${relPath}`;

    // 终端占着右侧时先让回底栏，差异才能画到代码那一列。
    yieldRightDockToCode();
    // 与文件管理器（previewFile）一致：非全屏时自动全屏，右侧才能展开查看器
    if (!isRightPanelFullscreen()) {
      requestRightPanelFullscreen();
    }

    // 先渲染加载态，避免右侧空白（「差异 / 内容」切换在工具栏，见 renderGitViewSwitchInToolbar）
    state.gitPreview = {
      key,
      name: basename(relPath),
      relPath,
      absPath,
      section,
      isStaged,
      mode: "diff",
      diff: { loading: true, result: null, error: "" },
      file: null,
    };
    renderGitPreview();

    await loadGitPreviewDiff({ key, relPath, absPath, isStaged });
  }

  // 差异取数缓存：key → 已解析的 diff（含工作区全文）。一次点击 = 一个 git 进程 + 整份文件跨 IPC，
  // 来回点同一文件、在「差异↔内容」之间切换都会重复这笔开销。失效只有两处：
  // 变更集合变化（applyGitStatus）、文件被保存，以及显式刷新（force）绕过读取。
  const gitDiffCache = new Map<string, CodePreviewDiff>();
  const GIT_DIFF_CACHE_LIMIT = 24;

  function rememberGitDiff(key: string, diff: CodePreviewDiff): void {
    gitDiffCache.set(key, diff);
    if (gitDiffCache.size > GIT_DIFF_CACHE_LIMIT) {
      const oldest = gitDiffCache.keys().next().value;
      if (oldest !== undefined) gitDiffCache.delete(oldest);
    }
  }

  // 拉取并解析指定文件的 Git 差异（含工作区完整内容），供打开与右键刷新复用。
  // 过期结果（切换了文件 / 已卸载）在内部丢弃，调用方无需重复校验。
  async function loadGitPreviewDiff({ key, relPath, absPath, isStaged, force }: LoadGitPreviewDiffArgs) {
    if (!force) {
      const cached = gitDiffCache.get(key);
      if (cached) {
        if (disposed || !state.gitPreview || state.gitPreview.key !== key) return;
        state.gitPreview = { ...state.gitPreview, diff: cached };
        renderGitPreview();
        return;
      }
    }
    const [diffRes, fileRes] = await Promise.all([
      gitFileDiff(state.rootPath, relPath, isStaged),
      readFileContent(absPath),
    ]);
    if (disposed || !state.gitPreview || state.gitPreview.key !== key) return;

    // 工作区全文用来把未改动行补回差异视图，打开后看到的是整份文件。
    const fullContent = typeof fileRes?.content === "string" && !fileRes.isBinary && !fileRes.isImage
      ? fileRes.content
      : null;
    const diff: CodePreviewDiff = { loading: false, result: null, fullContent, error: "" };
    if (!diffRes) {
      diff.error = t("git.diffUnavailable", "无法读取差异");
    } else if (diffRes.error) {
      diff.error = String(diffRes.error);
    } else {
      diff.result = parseUnifiedDiff(diffRes.content);
      if (diffRes.isBinary) diff.result.isBinary = true;
    }

    state.gitPreview = {
      ...state.gitPreview,
      diff,
    };
    rememberGitDiff(key, diff);
    renderGitPreview();
  }

  // Git 差异查看器右键「刷新」：重新拉取差异与工作区完整内容（该视图天然只读）。
  async function handleGitPreviewRefresh() {
    const gp = state.gitPreview;
    // 空态（未打开文件）没有具体差异可刷：回落到刷新左侧变更列表与状态，而不是空操作。
    if (!gp || !gp.absPath) {
      await refreshGitAll();
      return;
    }
    state.gitPreview = { ...gp, diff: { loading: true, result: null, error: "" } };
    renderGitPreview();
    await loadGitPreviewDiff({ ...gp, force: true });
  }

  // 切换右侧文件查看器的「差异 / 内容」子视图
  function setGitPreviewMode(mode: GitViewerMode) {
    if (!state.gitPreview) return;
    const next = mode === "content" ? "content" : "diff";
    if (state.gitPreview.mode === next) return;
    const key = state.gitPreview.key;
    state.gitPreview = { ...state.gitPreview, mode: next };
    renderGitPreview();
    if (next !== "content") return;
    const existing = state.gitPreview.file;
    if (existing && existing.kind === "text") {
      if (existing.isMarkdown && existing.mode === "preview") void hydrateGitMarkdown(key);
      return;
    }
    void loadGitPreviewFile(key);
  }

  async function loadGitPreviewFile(key: string) {
    const gp = state.gitPreview;
    if (!gp || gp.key !== key || !gp.absPath) return;
    state.gitPreview = {
      ...gp,
      file: { kind: "loading", name: gp.name, path: gp.absPath },
    };
    renderGitPreview();
    const fileRes = await readFileContent(gp.absPath);
    if (disposed || !state.gitPreview || state.gitPreview.key !== key) return;
    const file = buildFilePreview({ name: gp.name, path: gp.absPath }, fileRes);
    state.gitPreview = { ...state.gitPreview, file };
    renderGitPreview();
    if (file.kind === "text" && file.isMarkdown && file.mode === "preview") {
      await hydrateGitMarkdown(key);
    }
  }

  async function hydrateGitMarkdown(key: string) {
    // state.gitPreview 在挂载初值与切换项目时为 null；为 null 时下面的判空直接返回，
    // 不再伪造一个「有预览」的对象出来。
    const gp = state.gitPreview;
    const file = gp?.file;
    if (!gp || !file || gp.key !== key || !file.isMarkdown || file.mode !== "preview") return;
    if (shouldVirtualize(file.text)) {
      state.gitPreview = { ...gp, file: { ...file, mode: "code" } };
      renderGitPreview();
      return;
    }
    // 已渲染过就复用：marked + DOMPurify 全文解析只为新文本付一次。
    if (file.html) {
      void inlineMarkdownImages(file.path);
      return;
    }
    // 块加载失败（宿主取不到插件文件 / blob import 抛错）与「宿主没挂出渲染器」是同一降级：
    // 归一成 null 后走下面的 return，预览保持无 html 态；不让拒绝从 void 调用点逃成 unhandled rejection。
    const mod = await loadChunk("markdown").catch(() => null);
    if (disposed || !state.gitPreview || state.gitPreview.key !== key || !state.gitPreview.file) return;
    if (!mod || typeof mod.renderMarkdownHtml !== "function") return;
    // 下面三处断言是承重的：await 之后必须重读 state.gitPreview（期间可能被别处换成另一个预览），
    // 而 TS 不会把 `!state.gitPreview.file` 的收窄穿过紧接着对 state.gitPreview 的赋值，
    // 去掉就会退化成 spread 可空类型（key 变可选）。
    state.gitPreview = {
      ...(state.gitPreview as GitPreviewState),
      file: {
        ...(state.gitPreview.file as PanelPreviewState),
        html: mod.renderMarkdownHtml(state.gitPreview.file.text || ""),
      },
    };
    renderGitPreview();
    void inlineMarkdownImages(state.gitPreview.file!.path);
  }

  // 切换差异展示模式（unified / split），持久化偏好并仅重绘右侧查看器
  function setDiffMode(mode: DiffViewMode) {
    const next = mode === "split" ? "split" : "unified";
    if (state.diffMode === next) return;
    state.diffMode = next;
    saveDiffViewMode(api, next);
    renderGitPreview();
  }

  // 差异范围固定为完整文件，不提供范围切换。


  // 将 Git 变更视图的文件状态映射为 code-viewer 的 preview 结构
  function gitPreviewView(): PanelPreviewState | null {
    const gp = state.gitPreview;
    if (!gp) return null;
    const base = gp.file || { kind: "loading", name: gp.name, path: gp.absPath };
    return {
      ...base,
      diff: gp.diff,
      // base 为 loading 分支时没有 text，故 `?? base.text` 的类型是 string | undefined；
      // 而展开后的 kind 仍是 base 的那一支，TS 不会按分支重算 text。断言只把「与 base 同 kind」
      // 这一事实补回类型，运行时不变（loading 分支的渲染不读 text）。
      text: (gp.diff?.fullContent ?? base.text) as string,
      gitView: gp.mode,
      diffMode: state.diffMode,
    };
  }

  // 生成 / 中止提交信息
  function handleGenerateCommitMessage() {
    if (!state.rootPath) return;
    if (state.gitGenerating) {
      if (state.gitStreamId) abortCommitMessage(state.gitStreamId);
      return;
    }
    state.gitGenerating = true;
    state.gitCommitMessage = "";
    renderGitPaneCommit();
    const repo = state.rootPath;
    generateCommitMessage(
      repo,
      (chunk) => {
        if (disposed) return;
        if (chunk && chunk.contentDelta) {
          state.gitCommitMessage += chunk.contentDelta;
          updateCommitInput();
        }
      },
      (streamId) => {
        state.gitStreamId = streamId;
      }
    )
      .then((result) => {
        if (disposed) return;
        if (result && result.status !== "error" && result.content) {
          state.gitCommitMessage = result.content;
        }
      })
      .catch(() => {
        // 出错/取消：保留已流式生成的内容
      })
      .finally(() => {
        if (disposed) return;
        state.gitGenerating = false;
        state.gitStreamId = null;
        renderGitPaneCommit();
      });
  }

  // 仅更新提交输入框内容，避免整体重建打断输入
  function updateCommitInput() {
    const ta = container.querySelector<HTMLTextAreaElement>(".sfe-git-commit-input");
    if (ta) ta.value = state.gitCommitMessage;
  }

  // 过滤选项：同一个 .gitignore 开关同时控制 Git 元数据与 .gitignore 命中项
  function viewFilterOpts(): ExclusionFilterOptions {
    const filterEnabled = state.viewSettings.respectGitignore;
    return {
      excludeMeta: filterEnabled,
      useGitignore: filterEnabled,
      gitignoreRules: state.gitignoreRules,
    };
  }

  /**
   * 加载目录的直接子节点；JVM 源码根目录只在用户展开时构造包树。
   * @param entry 要展开的真实目录条目
   */
  async function loadDirectoryChildren(entry: FileTreeEntry) {
    // 只声明用到的入参：JvmEntryFilter 的 dirPath 在本回调里没用，写进形参会改变产物（arrow 长度）。
    const filtered = (entries: FileTreeEntry[]): FileTreeEntry[] =>
      sortEntries(filterExcludedEntries(entries, state.rootPath, viewFilterOpts()));
    const isJvmSourceRoot =
      state.viewSettings.javaPackageView &&
      state.javaProject &&
      Array.isArray(state.javaProject.sourceRoots) &&
      state.javaProject.sourceRoots.some((root) => pathKey(root) === pathKey(entry.path));

    // 展开同样只等一趟 IPC：这一层的 .gitignore 与列目录并发读。
    const ignorePromise = needsGitignoreLayer(entry.path) ? readGitignoreText(entry.path) : null;
    if (isJvmSourceRoot) {
      const sub = await readDirectoryEntries(entry.path);
      await appendGitignoreFromEntries(entry.path, sub, ignorePromise ? await ignorePromise : undefined);
      entry.children = await loadJvmPackageTree(entry.path, filtered);
      entry.isJavaSourceRoot = true;
      return;
    }

    const sub = await readDirectoryEntries(entry.path);
    await appendGitignoreFromEntries(entry.path, sub, ignorePromise ? await ignorePromise : undefined);
    entry.children = filtered(sub);
  }

  /**
   * 递归收集仓库内所有 .gitignore 规则（浅层在前、深层在后，深层覆盖浅层）
   * @description 与 git 语义一致：每层目录的 .gitignore 相对于自身生效。
   *   扫描时对已被忽略 / 元数据目录剪枝，避免进入 node_modules 等海量目录。
   * @param dir 当前扫描目录绝对路径
   * @param inherited 父层已收集的规则（由浅到深拼接）
   * @returns 本目录及其子目录的 .gitignore 规则清单
   */
  async function collectGitignoreRules(dir: string, inherited: GitignoreRule[]): Promise<GitignoreRule[]> {
    if (disposed) return [];
    let entries: DirectoryEntry[];
    try {
      entries = await readDirectoryEntries(dir);
    } catch {
      return [];
    }
    const own: GitignoreRule[] = [];
    const base = getRelativeGitPath(dir, state.rootPath);
    const gitignoreEntry = entries.find((e) => e && e.name === ".gitignore" && !e.isDirectory);
    if (gitignoreEntry) {
      const res = await readFileContent(gitignoreEntry.path);
      if (res && !res.isBinary && typeof res.content === "string") {
        own.push(...parseGitignore(res.content, base));
      }
    }
    const rulesHere = inherited.concat(own);
    const children = entries.filter((e) => {
      if (!e || !e.isDirectory) return false;
      if (isExcludedMeta(e.name)) return false;
      const rel = getRelativeGitPath(e.path, state.rootPath);
      return !(rel && isIgnoredByRules(rel, true, rulesHere));
    });
    const nested = await mapPool(children, 8, (child) => collectGitignoreRules(child.path, rulesHere));
    const rules = own.slice();
    for (const list of nested) {
      if (Array.isArray(list)) rules.push(...list);
    }
    return rules;
  }

  // 读某一层的 .gitignore 文本；该层没有这个文件 / 读失败一律返回 null（不抛给调用方）。
  async function readGitignoreText(dir: string): Promise<string | null> {
    try {
      const res = await readFileContent(joinPath(dir, ".gitignore"));
      if (!res || res.isBinary || typeof res.content !== "string") return null;
      return res.content;
    } catch {
      return null;
    }
  }

  /** 这一层的 .gitignore 还需不需要读（全仓已扫完 / 该层已读过就不再发 IPC）。 */
  function needsGitignoreLayer(dir: string): boolean {
    return !state.gitignoreFullyLoaded && !state.gitignoreLoadedDirs.has(pathKey(dir));
  }

  // 把某一层的 .gitignore 文本并入规则表。
  function applyGitignoreText(dir: string, text: string | null): void {
    if (!text) return;
    const own = parseGitignore(text, getRelativeGitPath(dir, state.rootPath));
    if (own.length) state.gitignoreRules = state.gitignoreRules.concat(own);
  }

  // 打开目录时补上这一层的 .gitignore。父目录的规则已经在更早的展开里读过。
  // prefetchedText 是「已与列目录并发读好」的文本（null 表示该层没有 .gitignore），
  // 传了就不再排队第二次 IPC；不传（undefined）时按列目录结果决定要不要读。
  async function appendGitignoreFromEntries(
    dir: string,
    entries: DirectoryEntry[],
    prefetchedText?: string | null
  ) {
    if (state.gitignoreFullyLoaded) return;
    const key = pathKey(dir);
    if (state.gitignoreLoadedDirs.has(key)) return;
    state.gitignoreLoadedDirs.add(key);
    const root = state.rootPath;
    if (prefetchedText !== undefined) {
      if (disposed || state.gitignoreFullyLoaded || pathKey(root) !== pathKey(state.rootPath)) return;
      applyGitignoreText(dir, prefetchedText);
      return;
    }
    if (!Array.isArray(entries)) return;
    const gitignoreEntry = entries.find((entry) => entry && entry.name === ".gitignore" && !entry.isDirectory);
    if (!gitignoreEntry) return;
    let res;
    try {
      res = await readFileContent(gitignoreEntry.path);
    } catch {
      return;
    }
    if (disposed || state.gitignoreFullyLoaded || pathKey(root) !== pathKey(state.rootPath)) return;
    if (!res || res.isBinary || typeof res.content !== "string") return;
    applyGitignoreText(dir, res.content);
  }

  // 显式刷新时重走整仓 .gitignore。打开面板只读根上的那一个文件。
  async function reloadGitignore() {
    if (!state.rootPath) {
      state.gitignoreRules = [];
      state.gitignoreFullyLoaded = false;
      return;
    }
    const root = state.rootPath;
    const rules = await collectGitignoreRules(root, []);
    if (disposed || pathKey(root) !== pathKey(state.rootPath)) return;
    state.gitignoreRules = rules;
    state.gitignoreFullyLoaded = true;
  }

  // 切换视图开关：持久化后重新加载数据（入口：文件树右键菜单的勾选项）
  async function toggleViewSetting(key: keyof ViewSettings) {
    state.viewSettings = { ...state.viewSettings, [key]: !state.viewSettings[key] };
    saveViewSettings(api, state.viewSettings);
    if (key === "respectGitignore") await reloadGitignore();
    if (key === "javaPackageView") {
      // 普通目录树与 Java 虚拟包树的 children 结构不同，必须从根重新加载。
      state.expanded = Object.create(null);
      await loadRoot();
      return;
    }
    await loadRoot();
  }

  // 3. 加载根目录
  async function loadRoot({ followups = false }: { followups?: boolean } = {}) {
    if (!state.rootPath) {
      state.status = "";
      renderToolbar();
      renderTree();
      return;
    }
    const root = state.rootPath;
    state.status = t("status.loading", "加载中…");
    renderToolbar();
    try {
      // 首屏只等一趟 IPC：根层 .gitignore 与列目录并发投机读（该层没这个文件时读失败即当作无规则）。
      const gitignorePromise = needsGitignoreLayer(root) ? readGitignoreText(root) : null;
      // 图标块在挂载时已并行发起：这里只给「列目录先完成而图标未到」的情况一个有限到账窗口，
      // 让树的第一帧就带完整图标集（消除占位图标回填的闪现）。超时兜底：极端慢盘下首屏
      // 不被图标拖死，图标到齐后由 scheduleStartupFollowups 里的 refreshInstalledIcons 就地回填。
      // iconsPromise 会话内记忆化：首次之后的 loadRoot 该 race 立即返回。
      const iconsReady = Promise.race([
        ensureIcons(),
        new Promise<void>((resolve) => setTimeout(resolve, 120)),
      ]);
      const [entries] = await Promise.all([readDirectoryEntries(root), iconsReady]);
      if (disposed || pathKey(root) !== pathKey(state.rootPath)) return;
      const prefetched = gitignorePromise ? await gitignorePromise : undefined;
      if (disposed || pathKey(root) !== pathKey(state.rootPath)) return;
      await appendGitignoreFromEntries(root, entries, prefetched);
      if (disposed || pathKey(root) !== pathKey(state.rootPath)) return;
      state.rootNodes = sortEntries(filterExcludedEntries(entries, root, viewFilterOpts()));
      state.status = "";
      renderToolbar();
      renderTree();
      if (followups) scheduleStartupFollowups(entries);
    } catch {
      if (disposed || pathKey(root) !== pathKey(state.rootPath)) return;
      state.rootNodes = [];
      state.status = t("error.readRoot", "无法读取根目录");
      renderToolbar();
      renderTree();
    }
  }

  // 4. 切换文件夹展开与收起
  async function toggleDir(entry: FileTreeEntry) {
    const next = !state.expanded[entry.path];
    state.expanded[entry.path] = next;
    if (next && !Array.isArray(entry.children)) {
      try {
        await loadDirectoryChildren(entry);
      } catch {
        // JVM 包树失败时保持普通目录可用，当前节点显示为空而不是冒泡到 UI。
        entry.children = [];
      }
    }
    renderTree();
  }

  // 目录打开只负责展开，不把已经展开的目录误切换回收起状态。
  async function openDirectory(entry: FileTreeEntry | null) {
    if (!entry || !entry.isDirectory || state.operationBusy) return;
    if (!state.expanded[entry.path]) {
      state.expanded[entry.path] = true;
      if (!Array.isArray(entry.children)) {
        try {
          await loadDirectoryChildren(entry);
        } catch {
          entry.children = [];
        }
      }
      renderTree();
    }
    closeContextMenu();
  }

  function parentDirectoryPath(filePath: string): string {
    const normalized = String(filePath || "").replace(/[\\/]+$/, "");
    const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
    if (index < 0) return "";
    if (index === 2 && /^[A-Za-z]:/.test(normalized)) return normalized.slice(0, 3);
    return normalized.slice(0, index) || normalized.slice(0, 1);
  }

  function findTreeEntry(nodes: FileTreeEntry[] | null | undefined, targetPath: string): FileTreeEntry | null {
    if (!Array.isArray(nodes)) return null;
    for (const entry of nodes) {
      if (entry && pathKey(entry.path) === pathKey(targetPath)) return entry;
      const nested = entry && findTreeEntry(entry.children, targetPath);
      if (nested) return nested;
    }
    return null;
  }

  async function refreshFileTreeAfterMutation(affectedDirs?: string[] | null) {
    // 改名 / 删除只影响父目录本身：定向重读那几个目录，绘树一次。
    // 不给范围时退回原全量路径（重载根 + 重读每个已展开目录），供范围未知的调用使用。
    if (affectedDirs && affectedDirs.length) {
      await refreshLoadedDirectories(affectedDirs.map((dir) => pathKey(dir)));
      return;
    }
    const expandedPaths = Object.keys(state.expanded).filter((path) => state.expanded[path]);
    await loadRoot();
    for (const path of expandedPaths) {
      const entry = findTreeEntry(state.rootNodes, path);
      if (!entry || !entry.isDirectory) {
        delete state.expanded[path];
        continue;
      }
      try {
        await loadDirectoryChildren(entry);
      } catch {
        entry.children = [];
      }
    }
    renderTree();
  }

  function remapPath(path: string, oldPath: string, newPath: string): string {
    if (!path) return path;
    const currentKey = pathKey(path);
    const oldKey = pathKey(oldPath);
    if (currentKey === oldKey) return newPath;
    const normalizedPath = normalizePath(path);
    const normalizedOld = normalizePath(oldPath).replace(/[/\\]+$/, "");
    if (!normalizedPath.toLowerCase().startsWith(oldKey + "/")) return path;
    return newPath + normalizedPath.slice(normalizedOld.length);
  }

  function remapStatePaths(oldPath: string, newPath: string) {
    const expanded: Record<string, boolean> = Object.create(null);
    for (const path of Object.keys(state.expanded)) {
      expanded[remapPath(path, oldPath, newPath)] = state.expanded[path];
    }
    state.expanded = expanded;
    const nextSelected = new Set<string>();
    for (const path of state.selected) nextSelected.add(remapPath(path, oldPath, newPath));
    state.selected = nextSelected;
    if (state.selectionAnchor) state.selectionAnchor = remapPath(state.selectionAnchor, oldPath, newPath);
    if (state.preview && state.preview.path) {
      state.preview.path = remapPath(state.preview.path, oldPath, newPath);
      state.preview.name = basename(state.preview.path);
    }
  }

  function setOperationStatus(ok: boolean, error = "") {
    state.status = ok
      ? t("action.operationSuccess", "操作成功")
      : `${t("action.operationFailed", "操作失败")}: ${error || t("action.operationFailed", "操作失败")}`;
    renderToolbar();
    if (operationTimer) clearTimeout(operationTimer);
    operationTimer = setTimeout(() => {
      if (disposed) return;
      state.status = "";
      operationTimer = null;
      renderToolbar();
    }, 3200);
  }

  async function runSystemWriteAction(
    actionId: SystemWriteActionName,
    params?: Record<string, unknown>,
  ): Promise<FileWriteResult> {
    const run = api && api.write && api.write.run;
    if (typeof run !== "function") {
      return { ok: false, error: "当前宿主未提供系统操作能力" };
    }
    try {
      const result = await run(`system.${actionId}`, params);
      if (result && result.ok === true) return result;
      return { ok: false, error: result && result.error ? String(result.error) : "系统操作失败" };
    } catch (err) {
      return { ok: false, error: err && (err as ErrorLike).message ? (err as ErrorLike).message : String(err) };
    }
  }

  async function copyPathText(text: string) {
    closeContextMenu();
    const result = await runSystemWriteAction("writeClipboardText", { text });
    if (result.ok === true) return true;
    const fallbackOk = await copyToClipboard(text);
    if (fallbackOk) return true;
    setOperationStatus(false, result.error);
    return false;
  }

  async function handleRevealInExplorer(entry: Pick<FileTreeEntry, "path"> | null) {
    if (!entry || state.operationBusy) return;
    closeContextMenu();
    const result = await runSystemWriteAction("showItemInFolder", { path: entry.path });
    if (result.ok !== true) setOperationStatus(false, result.error);
  }

  /** 读取宿主 preload API（window.snow）；插件沙箱内完整可用。 */
  function snowApi() {
    return typeof window !== "undefined" ? window.snow : null;
  }

  /** 在终端中打开：目录→该目录；文件→其所在目录（与系统「在此处打开终端」一致）。 */
  function handleOpenInTerminal(entry: FileTreeEntry | null) {
    if (!entry || state.operationBusy) return;
    closeContextMenu();
    const target = entry.isDirectory ? entry.path : parentDirectoryPath(entry.path);
    handleNewTerminal({ cwd: target || state.rootPath, mode: "terminal" });
  }

  async function handleGitRevealFile(file: GitFileStatus | null) {
    if (!file || !state.rootPath) return;
    await handleRevealInExplorer({ path: joinPath(state.rootPath, file.path) });
  }

  function handleGitCopyRelativePath(file: GitFileStatus | null) {
    if (!file) return;
    void copyPathText(file.path);
  }

  // Git 右侧查看器右键：按当前打开的差异文件（state.gitPreview.relPath/absPath）。
  async function handleGitPreviewRevealFile() {
    const gp = state.gitPreview;
    if (!gp || !gp.absPath) return;
    await handleRevealInExplorer({ path: gp.absPath });
  }

  function handleGitPreviewCopyPath() {
    const gp = state.gitPreview;
    if (!gp || !gp.absPath) return;
    void copyPathText(gp.absPath);
  }

  function handleGitPreviewCopyRelativePath() {
    const gp = state.gitPreview;
    if (!gp || !gp.relPath) return;
    void copyPathText(gp.relPath);
  }

  function handleGitCopyAbsolutePath(file: GitFileStatus | null) {
    if (!file || !state.rootPath) return;
    void copyPathText(joinPath(state.rootPath, file.path));
  }

  // 普通预览区的文件操作只针对当前打开文件，不污染文件树菜单或 Git 差异查看器。
  function handlePreviewRevealFile() {
    const filePath = state.preview && state.preview.path;
    if (!filePath) return;
    void handleRevealInExplorer({ path: filePath });
  }

  function handlePreviewCopyPath() {
    const filePath = state.preview && state.preview.path;
    if (!filePath) return;
    void copyPathText(filePath);
  }

  function handlePreviewCopyRelativePath() {
    const filePath = state.preview && state.preview.path;
    if (!filePath || !state.rootPath) return;

    const value = relativePath(state.rootPath, filePath);
    if (value == null) {
      setOperationStatus(false, "目标路径不在当前工作区内");
      return;
    }

    void copyPathText(value);
  }

  // 只读态右键「刷新」：重新从磁盘读取当前文件（编辑态不显示该项，避免丢弃未保存修改）。
  async function handlePreviewRefresh() {
    const current = state.preview;
    if (!current || !current.path) return;
    const filePath = current.path;
    const name = current.name;
    // 先回到加载态给即时反馈，再用最新磁盘内容重建预览
    state.preview = { kind: "loading", name, path: filePath };
    renderPreview();
    const result = await readFileContent(filePath);
    if (disposed || !state.preview || pathKey(state.preview.path) !== pathKey(filePath)) return;
    state.preview = buildFilePreview({ name, path: filePath }, result);
    renderPreview();
  }

  /**
   * 删除工作区文件或目录。
   * @description 删除是破坏性操作，必须先确认；成功后刷新文件树和 Git 状态。
   * @param {Object} entry 要删除的文件或目录条目
   */
  function handleDelete(entry: FileTreeEntry | null) {
    if (!entry || state.operationBusy || state.confirmDialog) return;

    // 多选（选中集合含该条目且不止一个）：右键菜单切批量删除。
    const isMulti = state.selected.size > 1 && state.selected.has(entry.path);
    // 菜单先同步移除，再显示插件内的异步确认弹窗，避免阻塞宿主渲染线程。
    closeContextMenu();
    if (isMulti) {
      const count = state.selected.size;
      openConfirmDialog({
        title: t("action.delete", "删除"),
        message: t("action.deleteSelectedConfirm", "确定删除选中的 {{count}} 项吗？此操作不可撤销。", { count }),
        confirmLabel: t("action.delete", "删除"),
        onConfirm: () => deleteSelectedEntries(),
      });
      return;
    }
    openConfirmDialog({
      title: t("action.delete", "删除"),
      message: t("action.deleteConfirm", "确定删除“{{name}}”吗？此操作不可撤销。", {
        name: entry.name || entry.path,
      }),
      confirmLabel: t("action.delete", "删除"),
      onConfirm: () => deleteEntry(entry),
    });
  }

  function openConfirmDialog({ title, message, confirmLabel, danger = true, onConfirm }: ConfirmDialogState) {
    if (state.confirmDialog) return false;
    state.confirmDialog = { title, message, confirmLabel, danger, onConfirm };
    renderConfirmDialog();
    return true;
  }

  function closeConfirmDialog() {
    if (!state.confirmDialog) return;
    state.confirmDialog = null;
    renderConfirmDialog();
  }

  async function confirmDialogAction() {
    const dialog = state.confirmDialog;
    if (!dialog) return;

    state.confirmDialog = null;
    renderConfirmDialog();
    try {
      await dialog.onConfirm();
    } catch (err) {
      if (!disposed) setOperationStatus(false, err && (err as ErrorLike).message ? (err as ErrorLike).message : String(err));
    }
  }

  /** 若当前预览文件位于被删除路径之下，则清空预览（避免继续显示已不存在的内容）。 */
  function resetPreviewForDeletedPaths(deletedPaths: string[]) {
    const currentPath = state.preview && state.preview.path;
    if (!currentPath) return false;
    const currentKey = pathKey(currentPath);
    const hit = deletedPaths.some((p) => {
      const dk = pathKey(p);
      return currentKey === dk || currentKey.startsWith(dk + "/");
    });
    if (!hit) return false;
    state.preview = {
      kind: "empty",
      name: "",
      path: "",
      text: "",
      highlightedHtml: "",
      isMarkdown: false,
      mode: "preview",
      html: "",
      editable: false,
      saveState: "idle",
      saveMessage: "",
    };
    renderPreview();
    return true;
  }

  /** 从选中集合与 shift 锚点中移除被删除路径及其子路径。 */
  function pruneSelectionForDeletedPaths(deletedPaths: string[]) {
    const keys = deletedPaths.map(pathKey);
    const hit = (p: string) => {
      const pk = pathKey(p);
      return keys.some((dk: string) => pk === dk || pk.startsWith(dk + "/"));
    };
    const next = new Set<string>();
    for (const p of state.selected) {
      if (!hit(p)) next.add(p);
    }
    state.selected = next;
    if (state.selectionAnchor && hit(state.selectionAnchor)) state.selectionAnchor = null;
  }

  async function deleteEntry(entry: FileTreeEntry | null) {
    if (!entry || state.operationBusy) return;

    state.operationBusy = true;
    renderToolbar();
    renderTree();

    try {
      const result = await deleteFileSystemEntry(api, state.rootPath, entry.path);
      if (disposed) return;

      if (result.ok !== true) {
        setOperationStatus(false, result.error);
        return;
      }

      resetPreviewForDeletedPaths([entry.path]);
      pruneSelectionForDeletedPaths([entry.path]);

      await refreshFileTreeAfterMutation([parentDirectoryPath(entry.path)]);
      await refreshGitAll();
      setOperationStatus(true);
    } catch (err) {
      if (!disposed) {
        setOperationStatus(false, err && (err as ErrorLike).message ? (err as ErrorLike).message : String(err));
      }
    } finally {
      if (!disposed) {
        state.operationBusy = false;
        renderToolbar();
        renderTree();
      }
    }
  }

  /** 批量删除当前选中条目：单次 IPC 调宿主批量接口，部分失败时提示失败数量。 */
  async function deleteSelectedEntries() {
    if (state.operationBusy) return;
    const paths = Array.from(state.selected);
    if (!paths.length) return;

    state.operationBusy = true;
    renderToolbar();
    renderTree();

    try {
      const result = await deleteFileSystemEntries(api, state.rootPath, paths);
      if (disposed) return;

      if (result.ok !== true) {
        setOperationStatus(false, result.error);
        return;
      }

      // Partial 承接「宿主没回传 data」这一支：不必断言，也不新增语句
      const data: Partial<BatchWorkspaceDeleteResult> = result.data || {};
      const deleted = Array.isArray(data.deleted) ? data.deleted : [];
      const failed = Array.isArray(data.failed) ? data.failed : [];
      if (deleted.length) {
        resetPreviewForDeletedPaths(deleted);
        pruneSelectionForDeletedPaths(deleted);
      }

      await refreshFileTreeAfterMutation();
      await refreshGitAll();
      if (failed.length) {
        setOperationStatus(false, t("action.batchDeletePartial", "{{count}} 项删除失败", { count: failed.length }));
      } else {
        setOperationStatus(true);
      }
    } catch (err) {
      if (!disposed) {
        setOperationStatus(false, err && (err as ErrorLike).message ? (err as ErrorLike).message : String(err));
      }
    } finally {
      if (!disposed) {
        state.operationBusy = false;
        renderToolbar();
        renderTree();
      }
    }
  }

  function renderConfirmDialog() {
    const root = layoutEls && layoutEls.root;
    if (!root) return;

    const oldOverlay = root.querySelector(".sfe-confirm-overlay");
    if (oldOverlay) oldOverlay.remove();

    const confirmState = state.confirmDialog;
    if (!confirmState) return;

    const overlay = el("div", "sfe-confirm-overlay");
    overlay.setAttribute("role", "presentation");
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeConfirmDialog();
    });

    const dialog = el("div", "sfe-confirm-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", confirmState.title);
    dialog.tabIndex = -1;
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeConfirmDialog();
      } else if (event.key === "Enter" && event.target === dialog) {
        event.preventDefault();
        void confirmDialogAction();
      }
    });

    const title = el("h2", "sfe-confirm-title", confirmState.title);
    const message = el("p", "sfe-confirm-message", confirmState.message);
    const actions = el("div", "sfe-confirm-actions");
    const cancelButton = el("button", "sfe-confirm-button", t("action.cancel", "取消"));
    cancelButton.type = "button";
    cancelButton.addEventListener("click", closeConfirmDialog);
    const confirmButtonClass = confirmState.danger ? "sfe-confirm-button danger" : "sfe-confirm-button";
    const confirmButton = el(
      "button",
      confirmButtonClass,
      confirmState.confirmLabel || t("action.confirm", "确认")
    );
    confirmButton.type = "button";
    confirmButton.addEventListener("click", () => void confirmDialogAction());

    // 统一保持“取消 → 确认动作”的顺序，危险动作通过 danger 样式强调。
    actions.appendChild(cancelButton);
    actions.appendChild(confirmButton);
    dialog.appendChild(title);
    dialog.appendChild(message);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    root.appendChild(overlay);

    setTimeout(() => {
      if (!disposed && dialog.isConnected) {
        dialog.focus();
      }
    }, 0);
  }

  async function submitRename(newName: string) {
    const context = state.contextMenu;
    if (!context || state.operationBusy) return;
    // entry 非空是重命名流程的不变量：renaming 只由 beginRename 置真，而 beginRename 先判过 entry。
    const entry = context.entry!;
    const trimmed = String(newName || "").trim();
    if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed)) {
      setOperationStatus(false, "名称不能为空，且不能包含路径分隔符");
      return;
    }
    if (trimmed.toLowerCase() === String(entry.name || "").toLowerCase()) {
      setOperationStatus(false, "新名称与原名称相同");
      return;
    }

    const oldPath = entry.path;
    const newPath = joinPath(parentDirectoryPath(oldPath), trimmed);
    state.operationBusy = true;
    renderContextMenu();
    const result = await renameFileSystemEntry(api, state.rootPath, oldPath, trimmed);
    if (disposed) return;
    if (result.ok !== true) {
      state.operationBusy = false;
      renderContextMenu();
      setOperationStatus(false, result.error);
      return;
    }

    remapStatePaths(oldPath, newPath);
    state.operationBusy = false;
    closeContextMenu();
    await refreshFileTreeAfterMutation([parentDirectoryPath(oldPath)]);
    await refreshGitAll();
    setOperationStatus(true);
  }

  function closeContextMenu() {
    if (!state.contextMenu) return;
    state.contextMenu = null;
    renderContextMenu();
  }

  async function handleContextOpen(entry: FileTreeEntry | null) {
    if (!entry || state.operationBusy) return;

    closeContextMenu();

    if (entry.isDirectory) {
      await openDirectory(entry);
      return;
    }

    await previewFile(entry);
  }

  function beginRename(entry: FileTreeEntry | null) {
    if (!entry || state.operationBusy) return;
    // beginRename 只由已打开的右键菜单项调用，state.contextMenu 此刻必非空（x/y 由展开带出）。
    state.contextMenu = { ...state.contextMenu!, entry, renaming: true };
    renderContextMenu();
  }

  function renderContextMenu() {
    const root = layoutEls && layoutEls.root;
    if (!root) return;
    const oldMenu = root.querySelector(".sfe-context-menu");
    if (oldMenu) oldMenu.remove();
    const context = state.contextMenu;
    if (!context) return;

    const menu = el("div", "sfe-context-menu");
    menu.setAttribute("role", "menu");
    menu.style.left = `${Math.max(4, context.x)}px`;
    menu.style.top = `${Math.max(4, context.y)}px`;
    menu.addEventListener("click", (event) => event.stopPropagation());
    const entry = context.entry;
    const disabled = state.operationBusy;

    const addItem = (label: string, action: () => void, isDisabled = false) => {
      const item = el("button", "sfe-context-menu-item" + (isDisabled ? " disabled" : ""), label);
      item.type = "button";
      item.disabled = isDisabled;
      item.setAttribute("role", "menuitem");
      item.addEventListener("click", () => {
        if (!isDisabled && !state.operationBusy) action();
      });
      menu.appendChild(item);
    };
    const separator = () => menu.appendChild(el("div", "sfe-context-menu-separator"));

    // 勾选型菜单项（视图开关）：右侧用 ✓ 标记勾选态（与常见菜单一致），未勾选留空位保持对齐。
    const addToggleItem = (label: string, checked: boolean, action: () => void, isDisabled = false) => {
      const item = el("button", "sfe-context-menu-item sfe-context-toggle" + (isDisabled ? " disabled" : ""));
      item.type = "button";
      item.disabled = isDisabled;
      item.setAttribute("role", "menuitemcheckbox");
      item.setAttribute("aria-checked", checked ? "true" : "false");
      item.appendChild(el("span", "sfe-context-toggle-label", label));
      const mark = el("span", "sfe-context-toggle-check");
      if (checked) mark.appendChild(createActionIcon("check", 13));
      item.appendChild(mark);
      item.addEventListener("click", () => {
        if (!isDisabled && !state.operationBusy) action();
      });
      menu.appendChild(item);
    };
    // 视图开关分组（工作区级，原三点菜单设置项）：按 .gitignore 过滤（默认勾选，再点取消）；
    // JVM 包结构视图仅 JVM 项目显示。切换后关闭菜单并重载文件树。
    const appendViewToggles = (isDisabled: boolean) => {
      addToggleItem(
        t("settings.respectGitignore", "按 .gitignore 过滤"),
        state.viewSettings.respectGitignore !== false,
        () => {
          closeContextMenu();
          void toggleViewSetting("respectGitignore");
        },
        isDisabled,
      );
      if (
        state.javaProject &&
        Array.isArray(state.javaProject.sourceRoots) &&
        state.javaProject.sourceRoots.length
      ) {
        addToggleItem(
          t("settings.javaPackageView", "JVM 包结构视图"),
          state.viewSettings.javaPackageView !== false,
          () => {
            closeContextMenu();
            void toggleViewSetting("javaPackageView");
          },
          isDisabled,
        );
      }
    };

    if (context.renaming) {
      const input = el("input", "sfe-context-menu-input");
      input.type = "text";
      // renaming 为真只可能来自 beginRename，该分支下 entry 必非空（见 beginRename）。
      input.value = entry!.name || "";
      input.setAttribute("aria-label", t("action.renamePrompt", "请输入新名称"));
      input.disabled = disabled;
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void submitRename(input.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          closeContextMenu();
        }
      });
      menu.appendChild(input);
      setTimeout(() => {
        if (!disposed && input.isConnected) {
          input.focus();
          input.select();
        }
      }, 0);
    } else if (entry && state.selected.size > 1 && state.selected.has(entry.path)) {
      // 多选批量操作模式：复制 N 条路径（换行分隔）/ 删除 N 项（单次 IPC 批量删除）。
      const count = state.selected.size;
      addItem(
        t("action.copySelectedPaths", "复制 {{count}} 条路径", { count }),
        () => {
          closeContextMenu();
          void copyPathText(Array.from(state.selected).join("\n"));
        },
        disabled,
      );
      separator();
      addItem(
        t("action.deleteSelected", "删除 {{count}} 项", { count }),
        () => handleDelete(entry),
        disabled,
      );
    } else if (!entry) {
      // 空白区右键：无具体条目，仅提供工作区级操作（刷新 / 打开工作区 / 复制工作区路径）
      addItem(t("action.refresh", "刷新"), () => handleRefresh(), disabled);
      separator();
      addItem(
        t("action.revealInExplorer", "在资源管理器中打开"),
        () => handleRevealInExplorer({ path: state.rootPath }),
        disabled || !state.rootPath,
      );
      addItem(
        t("action.copyPath", "复制路径"),
        () => copyPathText(state.rootPath),
        disabled || !state.rootPath,
      );
      separator();
      appendViewToggles(disabled);
    } else {
      addItem(
        entry.isDirectory
          ? t("action.openFolder", "展开文件夹")
          : t("action.openFile", "打开文件"),
        () => handleContextOpen(entry),
        disabled,
      );
      separator();
      addItem(t("action.openInTerminal", "在终端中打开"), () => handleOpenInTerminal(entry), disabled);
      addItem(t("action.revealInExplorer", "在资源管理器中打开"), () => handleRevealInExplorer(entry), disabled);
      separator();
      addItem(t("action.copyPath", "复制路径"), () => copyPathText(entry.path), disabled);
      addItem(
        t("action.copyRelativePath", "复制相对路径"),
        () => {
          const value = relativePath(state.rootPath, entry.path);
          if (value == null) setOperationStatus(false, "目标路径不在当前工作区内");
          else void copyPathText(value);
        },
        disabled,
      );
      separator();
      addItem(t("action.rename", "重命名"), () => beginRename(entry), disabled);
      addItem(t("action.delete", "删除"), () => handleDelete(entry), disabled);
      separator();
      addItem(t("action.refresh", "刷新"), () => handleRefresh(), disabled);
      separator();
      appendViewToggles(disabled);
    }

    root.appendChild(menu);
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(4, Math.min(context.x, viewportWidth ? viewportWidth - rect.width - 4 : context.x));
    const top = Math.max(4, Math.min(context.y, viewportHeight ? viewportHeight - rect.height - 4 : context.y));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  /** 文件树多选：普通=单选并置锚点；ctrl/cmd=切换；shift=从锚点按可见顺序范围选择。 */
  function handleTreeSelectionChange({ path, additive, range, visiblePaths }: TreeSelectionChange) {
    if (range) {
      const anchor = state.selectionAnchor;
      const anchorIndex = anchor ? visiblePaths.indexOf(anchor) : -1;
      const currentIndex = visiblePaths.indexOf(path);
      if (anchorIndex >= 0 && currentIndex >= 0) {
        const from = Math.min(anchorIndex, currentIndex);
        const to = Math.max(anchorIndex, currentIndex);
        state.selected = new Set(visiblePaths.slice(from, to + 1));
      } else {
        state.selected = new Set([path]);
        state.selectionAnchor = path;
      }
      applyTreeSelectionHighlight();
      return;
    }
    if (additive) {
      const next = new Set(state.selected);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      state.selected = next;
      state.selectionAnchor = path;
      applyTreeSelectionHighlight();
      return;
    }
    state.selected = new Set([path]);
    state.selectionAnchor = path;
    applyTreeSelectionHighlight();
  }

  /** 文件树键盘：Ctrl/Cmd+A 全选可见行、Escape 清空选择。 */
  function handleTreeKeyDown(event: KeyboardEvent, visiblePaths: string[]) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      state.selected = new Set(Array.isArray(visiblePaths) ? visiblePaths : []);
      state.selectionAnchor =
        visiblePaths && visiblePaths.length ? visiblePaths[visiblePaths.length - 1] : null;
      applyTreeSelectionHighlight();
      return;
    }
    if (event.key === "Escape") {
      state.selected = new Set();
      state.selectionAnchor = null;
      applyTreeSelectionHighlight();
    }
  }

  function handleContextMenu(entry: FileTreeEntry | null, x: number, y: number) {
    if (state.operationBusy || state.confirmDialog) return;
    // 右键多选区域中的条目时保留整个选中集合；右键未选中条目则单选它。
    if (entry) {
      const next = state.selected.has(entry.path) ? state.selected : new Set([entry.path]);
      state.selected = next;
      state.selectionAnchor = entry.path;
      applyTreeSelectionHighlight();
    }
    state.contextMenu = { entry, x, y };
    renderContextMenu();
  }

  /** 刷新文件树与 Git 状态（工具栏刷新按钮与右键菜单「刷新」共用同一入口）。 */
  function handleRefresh() {
    closeContextMenu();
    void refreshAll();
  }

  /**
   * Git 视图的「刷新」：只重拉变更状态与当前打开的差异。
   * @description 不能复用 refreshAll —— 它会重走全仓 .gitignore 递归扫描（每个目录一次
   *   宿主 IPC）并整树重载，那属于文件树的事；混进来后大仓点一次刷新要等几十秒，
   *   而且刷新的从来不是 Git 面板。
   */
  function handleGitRefresh() {
    void (async () => {
      await refreshGitAll();
      if (disposed) return;
      const gp = state.gitPreview;
      if (gp && gp.absPath) await handleGitPreviewRefresh();
    })();
  }

  // ------------------------------------------------------------------
  // 5.0 项目终端：识别（懒加载）→ 右键 / 工具栏运行 → IDEA 式多 tab 交互终端
  // ------------------------------------------------------------------

  /**
   * 仍在运行的一次性任务数量（模式 A 且未结束）。
   * @description 只统计模式 A：模式 B 是常驻交互终端，永远不会「退出」，若计入会把
   *   工具栏按钮永久钉在 Stop。模式 B 的会话状态由 tab 自身表达（存在即开着），
   *   不参与 Run/Stop 判定。仅用于底栏小圆点（提示后台仍在跑）。
   */
  function runningCount() {
    return state.terminals.filter((term) => term && term.mode === "run" && term.exited !== true).length;
  }

  /** 交互终端窗口（mode B）的终端集合。 */
  function terminalModeTerminals() {
    return state.terminals.filter((term) => term && term.mode === "terminal");
  }

  /** 运行窗口（mode A）的终端集合。 */
  function runModeTerminals() {
    return state.terminals.filter((term) => term && term.mode === "run");
  }

  /** 按 id 查终端（两个窗口共用）。 */
  function findTerminal(id: string | null) {
    return state.terminals.find((term) => term && term.id === id) || null;
  }

  /**
   * 关闭终端后修正两个窗口的激活项：被移除的是激活项（或激活项已不存在）时回退到
   *   同窗口首条；否则保持不动（不误改另一窗口的激活项）。
   * @param {Iterable<string>} removedIds 被移除的终端 id
   */
  function reconcileActiveTerminals(removedIds: Iterable<string | null>) {
    const removed = new Set(removedIds);
    if (removed.has(state.activeTerminalId) || !findTerminal(state.activeTerminalId)) {
      const list = terminalModeTerminals();
      state.activeTerminalId = list.length ? list[0].id : null;
    }
    if (removed.has(state.activeRunTerminalId) || !findTerminal(state.activeRunTerminalId)) {
      const list = runModeTerminals();
      state.activeRunTerminalId = list.length ? list[0].id : null;
    }
  }

  /**
   * 切换项目时留下未结束的启动任务，其余终端关掉。
   * @param {string} previousRoot 切换前的项目根目录
   */
  function retainUnfinishedRuns(previousRoot: string) {
    const kept: TerminalTab[] = [];
    for (const term of state.terminals) {
      const keep = term && term.mode === "run" && term.exited !== true;
      if (!keep) {
        try {
          if (term && term.session && typeof term.session.kill === "function") term.session.kill();
        } catch {
          // 忽略：进程可能已自然退出
        }
        continue;
      }
      if (!term.projectPath) term.projectPath = previousRoot;
      kept.push(term);
    }
    state.terminals = kept;
  }

  /**
   * 标记哪些启动任务属于其他项目，并按开关决定是否出现在 tab 上。
   * 进程和 xterm 都留着，只是默认不画 tab。
   */
  function syncRetainedRuns() {
    const root = pathKey(state.rootPath);
    for (const term of state.terminals) {
      if (!term || term.mode !== "run") continue;
      const other = !!(term.projectPath && pathKey(term.projectPath) !== root);
      term.projectLabel = other ? basename(term.projectPath) : "";
      term.hiddenRun = other && !state.showOtherProjectRuns;
    }
    const active = findTerminal(state.activeRunTerminalId);
    if (!active || active.hiddenRun || active.mode !== "run") {
      const visible = state.terminals.find((term) => term && term.mode === "run" && !term.hiddenRun);
      state.activeRunTerminalId = visible ? visible.id : null;
    }
  }

  /** 右键开关：显示或藏起其他项目里尚未结束的启动任务。 */
  function toggleShowOtherProjectRuns() {
    if (disposed) return;
    state.showOtherProjectRuns = !state.showOtherProjectRuns;
    rebuildTerminalWindows();
    syncSidebar();
    const fit = () => fitTerminalPanel();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fit);
    else fit();
  }

  /** 终端集合变化后重建两个窗口的 tab 列表（xterm 实例由组件内部增量维护，不丢失）。 */
  function rebuildTerminalWindows() {
    syncRetainedRuns();
    if (terminalWindow && typeof terminalWindow.rebuild === "function") terminalWindow.rebuild();
    if (runWindow && typeof runWindow.rebuild === "function") runWindow.rebuild();
  }

  /**
   * 只重建运行窗口那一侧。
   * @description 模式 A（运行）记录的增删不影响交互终端窗口的 tab 集合，
   *   进程每退出一次就把两个窗口都重画一遍是白付一轮 DOM 与 fit。
   */
  function rebuildRunWindow() {
    syncRetainedRuns();
    if (runWindow && typeof runWindow.rebuild === "function") runWindow.rebuild();
  }

  /**
   * 某条命令仍在运行的终端集合（模式 A 且未结束，按 commandId 归属）。
   * @description 工具栏 Run/Stop 二态与「同一命令要么运行要么停止」的判定依据；
   *   commandId 是终端记录上稳定的命令标识（不是命令文本，避免同 cmd 不同配置误判）。
   * @param {{id?: string}|null} command 命令对象
   * @returns {Array<Object>}
   */
  function runningTerminalsForCommand(command: RunCommand | { id?: string } | null): TerminalTab[] {
    const commandId = command && command.id ? command.id : null;
    if (!commandId) return [];
    return state.terminals.filter(
      (term) => term && term.mode === "run" && term.exited !== true && term.commandId === commandId,
    );
  }

  /** 某条命令当前是否运行中（驱动工具栏主按钮的 Run/Stop 二态）。 */
  function runCountForCommand(command: RunCommand | { id?: string } | null) {
    return runningTerminalsForCommand(command).length;
  }

  /**
   * 关闭一个终端会话（终止 pty + 从集合移除）。切换项目 / 卸载 / 关闭 tab 共用。
   * @param {string} id 终端 id
   * @returns {boolean} 是否确实移除了会话
   */
  function killTerminalById(id: string) {
    const index = state.terminals.findIndex((term) => term && term.id === id);
    if (index < 0) return false;
    const term = state.terminals[index];
    state.terminals.splice(index, 1);
    try {
      if (term.session && typeof term.session.kill === "function") term.session.kill();
    } catch {
      // 忽略：进程可能已自然退出
    }
    reconcileActiveTerminals([id]);
    return true;
  }

  /** 终止并移除全部终端（切换项目 / 卸载）。 */
  function killAllTerminals() {
    for (const term of state.terminals) {
      try {
        if (term && term.session && typeof term.session.kill === "function") term.session.kill();
      } catch {
        // 忽略：进程可能已自然退出
      }
    }
    state.terminals = [];
    state.activeTerminalId = null;
    state.activeRunTerminalId = null;
  }

  /**
   * 终止并移除某条命令的运行终端（模式 A）——工具栏 Stop 按钮的语义。
   * @description 只停「当前这条命令」的终端（用户诉求：点一个 Stop 不能把别的也停了）；
   *   只处理模式 A：模式 B 是常驻交互终端，Stop 不应误杀用户正在交互的会话，
   *   关闭模式 B 只能通过它自己的 tab ×（用户明确操作）。
   * @param {{id?: string}|null} command 命令对象
   */
  function killRunTerminalsForCommand(command: RunCommand | { id?: string } | null) {
    const commandId = command && command.id ? command.id : null;
    if (!commandId) return;
    const victims = runningTerminalsForCommand(command);
    if (!victims.length) return;
    for (const term of victims) {
      try {
        if (term.session && typeof term.session.kill === "function") term.session.kill();
      } catch {
        // 忽略：进程可能已自然退出
      }
    }
    const removed = new Set(victims.map((term) => term.id));
    state.terminals = state.terminals.filter((term) => !removed.has(term.id));
    reconcileActiveTerminals(removed);
  }

  /**
   * 停止某条命令的运行终端，并同步面板 / 底栏 / 工具栏。
   * @description killRunTerminalsForCommand 只改状态、不重绘：这里补 UI 同步，界面才会立即清空。
   *   工具栏 Stop、⋮ 菜单的逐条停止、Rerun 的「先停」都复用它（DRY）。
   * @param {{id?: string}|null} command 命令对象
   */
  function stopCommandAndSync(command: RunCommand | { id?: string }) {
    killRunTerminalsForCommand(command);
    rebuildTerminalWindows();
    syncSidebar();
    syncSidebar();
    syncRunToolbar();
  }

  /**
   * 停止全部运行中的命令（模式 A）——工具栏 ⋮ 菜单「停止全部 N 个」的语义。
   * @description 只有用户**显式**选择「全部停止」时才走这里（不是 Stop 的默认行为，这正是本轮修复点）；
   *   模式 B 常驻交互终端不参与，只能由各自的 tab × 关闭。
   */
  function stopAllRunTerminals() {
    for (const term of state.terminals) {
      if (!term || term.mode !== "run" || term.hiddenRun) continue;
      try {
        if (term.session && typeof term.session.kill === "function") term.session.kill();
      } catch {
        // 忽略：进程可能已自然退出
      }
    }
    state.terminals = state.terminals.filter((term) => term && (term.mode !== "run" || term.hiddenRun));
    reconcileActiveTerminals([state.activeRunTerminalId]);
    rebuildTerminalWindows();
    syncSidebar();
    syncRunToolbar();
  }

  /**
   * 收起底部工具窗口（IDEA：关闭工具窗口不终止进程，仅隐藏；会话与输出保留，侧栏入口可随时拉回）。
   */
  function handleMinimizeRunPanel() {
    state.bottomView = null;
    refreshBottomVisibility();
    syncSidebar();
  }

  /** 左侧竖排入口栏点击：切到指定工具窗口；再次点击同一入口则收起回文件视图。 */
  function selectBottomView(view: ToolWindowMode) {
    const next = state.bottomView === view ? null : view;
    state.bottomView = next;
    if (next) ensureBottomWindows();
    refreshBottomVisibility();
    syncSidebar();
    if (!next) return;
    if (state.toolDock === "right") {
      void ensureRightDock();
      const win = next === "run" ? runWindow : terminalWindow;
      if (win && typeof win.focus === "function") win.focus();
      return;
    }
    // 窗口可见后让终端适配尺寸并聚焦，打开即可直接输入。
    const win = next === "run" ? runWindow : terminalWindow;
    if (win && typeof win.fit === "function") win.fit();
    if (win && typeof win.focus === "function") win.focus();
  }

  /** 切换终端窗口激活 tab（点 tab）。 */
  function handleSelectTerminal(id: string) {
    if (disposed || state.activeTerminalId === id) return;
    if (!findTerminal(id)) return;
    state.activeTerminalId = id;
    if (terminalWindow && typeof terminalWindow.syncActive === "function") terminalWindow.syncActive();
  }

  /** 切换运行窗口激活 tab（点 tab）。 */
  function handleSelectRunTerminal(id: string) {
    if (disposed || state.activeRunTerminalId === id) return;
    if (!findTerminal(id)) return;
    state.activeRunTerminalId = id;
    if (runWindow && typeof runWindow.syncActive === "function") runWindow.syncActive();
  }

  /** 关闭某个终端 tab（终止会话 + 移除），并同步两个工具窗口与底栏/工具栏。 */
  function handleCloseTerminal(id: string) {
    if (!killTerminalById(id)) return;
    rebuildTerminalWindows();
    syncSidebar();
    syncRunToolbar();
  }

  /** 关闭某窗口内除指定 tab 之外的其它 tab（同 mode）。 */
  function closeOtherTerminals(id: string) {
    const target = findTerminal(id);
    if (!target) return;
    const victims = state.terminals.filter((term) => term.mode === target.mode && term.id !== id && !term.hiddenRun);
    for (const term of victims) {
      try {
        if (term.session && typeof term.session.kill === "function") term.session.kill();
      } catch {
        // 忽略：进程可能已自然退出
      }
    }
    const removed = new Set(victims.map((term) => term.id));
    state.terminals = state.terminals.filter((term) => !removed.has(term.id));
    reconcileActiveTerminals(removed);
    rebuildTerminalWindows();
    syncSidebar();
    syncRunToolbar();
  }

  /** 关闭某窗口内的全部 tab（按 mode 区分，不动另一窗口）。 */
  function closeAllTerminalsOfMode(mode: ToolWindowMode) {
    const victims = state.terminals.filter((term) => term && term.mode === mode && !term.hiddenRun);
    for (const term of victims) {
      try {
        if (term.session && typeof term.session.kill === "function") term.session.kill();
      } catch {
        // 忽略：进程可能已自然退出
      }
    }
    const removed = new Set(victims.map((term) => term.id));
    state.terminals = state.terminals.filter((term) => !removed.has(term.id));
    reconcileActiveTerminals(removed);
    rebuildTerminalWindows();
    syncSidebar();
    syncRunToolbar();
  }

  /**
   * 懒加载项目识别：结果缓存进 state.projectCommands。
   * @description 首次在项目加载时触发（与 IDEA 一致：项目一打开就能 Run）。
   *   扫描完成后同步运行控件；识别结果不影响运行面板（面板只展示运行，不展示命令）。
   * @returns {Promise<Object|null>}
   */
  async function ensureCommands(rootEntries?: FileTreeEntry[]) {
    if (disposed || !state.rootPath) return null;
    const rootPath = state.rootPath;
    const before = state.projectCommands;
    const result = await ensureProjectCommands(state, rootPath, {
      // 首屏已经列过一次根目录，把那份条目交给扫描，别再发一趟重复的列目录 IPC。
      rootEntries: rootEntries ?? null,
      // 切项目 / 卸载后这次扫描就没有意义了：让它在层与层之间自己退出。
      shouldAbort: () => disposed || pathKey(rootPath) !== pathKey(state.rootPath),
    });
    if (disposed || pathKey(rootPath) !== pathKey(state.rootPath)) return result;
    // 命中缓存（引用未变）：不重渲染，避免打断右键菜单重命名等交互。
    if (result === before) return result;
    renderRunToolbarView();
    // package.json 预览：命令就绪后重渲染，补上 gutter ▶（首次打开时命令可能尚未扫完）。
    if (state.preview && state.preview.name === "package.json") renderPreview();
    // 菜单仍打开且未处于重命名输入态时才重渲染（重命名中重建会清空输入框）。
    if (state.contextMenu && state.contextMenu.entry && !state.contextMenu.renaming) renderContextMenu();
    return result;
  }

  /** 底部工具窗口可见性：按 bottomView 互斥显示「终端」/「运行」窗口，null 时全部收起。 */
  function refreshBottomVisibility() {
    if (!layoutEls) return;
    if (layoutEls.terminalWindowEl) layoutEls.terminalWindowEl.hidden = state.bottomView !== "terminal";
    if (layoutEls.runWindowEl) layoutEls.runWindowEl.hidden = state.bottomView !== "run";
    applyToolDock();
  }

  /** 工具窗口是否正打开（终端或运行，二者互斥）。 */
  function toolWindowOpen() {
    return state.bottomView === "terminal" || state.bottomView === "run";
  }

  function saveToolDock() {
    if (api && api.storage && typeof api.storage.setJson === "function") {
      // 偏离（已登记）：同步 try/catch 挡不住 setJson 的拒绝，失败原本会逃逸成 unhandled rejection；
      // 改挂 .catch，沿用原 catch「偏好写失败不影响这次切换」的静默语义。
      api.storage.setJson("toolDock", state.toolDock).catch(() => {
        // 忽略：偏好写失败不影响这次切换
      });
    }
  }

  /**
   * 把停靠写到主体上。窗口收起时仍按底栏布局，避免主视图被右侧空列挤窄。
   * 偏好本身留在 state.toolDock，下次打开继续用。
   */
  function applyToolDock() {
    if (!layoutEls || !layoutEls.body) return;
    layoutEls.body.dataset.toolDock = toolWindowOpen() && state.toolDock === "right" ? "right" : "bottom";
    if (terminalWindow && typeof terminalWindow.syncDock === "function") terminalWindow.syncDock();
    if (runWindow && typeof runWindow.syncDock === "function") runWindow.syncDock();
    renderGitViewSwitchInToolbar();
  }

  /**
   * 右侧停靠跟代码预览一样：必须先进入宿主全屏，左侧才是侧栏宽度、右侧才铺满。
   * 代码预览由样式让出，不会和终端并排。
   */
  async function ensureRightDock() {
    if (disposed || state.toolDock !== "right" || !toolWindowOpen()) return;
    applyToolDock();
    if (!isRightPanelFullscreen()) {
      const ok = await ensureRightPanelFullscreen();
      if (disposed) return;
      if (!ok) setOperationStatus(false, "无法进入右侧面板全屏");
    }
    fitTerminalPanel();
  }

  /**
   * 代码要占右侧时，把正在右侧的终端/运行窗口放回底栏。
   * 窗口没开着时不动偏好，下次打开仍停在右侧。
   */
  function yieldRightDockToCode() {
    if (state.toolDock !== "right" || !toolWindowOpen()) return;
    state.toolDock = "bottom";
    saveToolDock();
    applyToolDock();
    const fit = () => fitTerminalPanel();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fit);
    else fit();
  }

  /** 在底栏与右侧之间切换，终端和运行窗口一起换位置。 */
  function toggleToolDock() {
    if (disposed) return;
    state.toolDock = state.toolDock === "right" ? "bottom" : "right";
    saveToolDock();
    applyToolDock();
    if (state.toolDock === "right") {
      void ensureRightDock();
      return;
    }
    const fit = () => fitTerminalPanel();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fit);
    else fit();
  }

  /** 按需首次渲染两个工具窗口（渲染后各自常驻，靠 hidden 切换，xterm 实例不销毁）。 */
  function ensureBottomWindows() {
    if (!layoutEls || !layoutEls.terminalWindowEl || !layoutEls.runWindowEl) return;
    if (!terminalWindow) terminalWindow = renderToolWindow(layoutEls.terminalWindowEl, terminalWindowOptions());
    if (!runWindow) runWindow = renderToolWindow(layoutEls.runWindowEl, runWindowOptions());
  }

  /** 同步工具栏运行控件（Run/Stop 按钮、命令下拉与运行计数）。 */
  function syncRunToolbar() {
    if (runToolbar && typeof runToolbar.sync === "function") runToolbar.sync();
  }

  /**
   * 合并顶栏命令与「手动登记」的脚本命令（同 id 去重，顶栏命令在前）。
   * @param {Array} commands flattenCommands 结果
   * @param {Array} extra 手动登记的脚本命令
   * @returns {Array}
   */
  function mergeRunCommands(commands: FlatRunCommand[], extra: FlatRunCommand[]): FlatRunCommand[] {
    const base = Array.isArray(commands) ? commands : [];
    const list = Array.isArray(extra) ? extra : [];
    if (!list.length) return base;
    const ids = new Set(base.map((command) => command && command.id));
    return [...base, ...list.filter((command) => command && !ids.has(command.id))];
  }

  /**
   * 渲染 / 同步工具栏运行控件。
   * @description 控制器只创建一次并复用（避免重复注册 document 监听）；骨架重建后自动重建。
   */
  function renderRunToolbarView() {
    if (disposed || !layoutEls || !layoutEls.runToolbarWrap) return;
    const wrap = layoutEls.runToolbarWrap;
    // 骨架被重建（wrap 变空）时，旧控制器绑定的 DOM 已脱离文档，需重建。
    if (runToolbar && wrap.childElementCount > 0) {
      runToolbar.sync();
      return;
    }
    if (runToolbar && typeof runToolbar.dispose === "function") runToolbar.dispose();
    runToolbar = renderRunToolbar(wrap, {
      t,
      getState: () => {
        const commands = mergeRunCommands(flattenCommands(state.projectCommands), state.manualScriptCommands);
        return {
          commands,
          // 识别完成（无论是否命中生态）才算 ready，避免未扫描时误显示按钮。
          ready: state.projectCommands !== null,
          isCommandRunning: (command) => runCountForCommand(command) > 0,
        };
      },
      onRun: handleRunCommand,
      // Rerun：先停该命令的运行终端，再重新运行（IDEA 的 Rerun 语义）。
      onRerun: (command) => {
        stopCommandAndSync(command);
        handleRunCommand(command);
      },
      // Stop：只停「当前选中命令」，不波及其它命令（修复「点一个 Stop 全停」）。
      // 逐条 / 全部停止已移到「运行」工具窗口工具栏，顶栏不再提供 ⋮。
      onStop: stopCommandAndSync,
    });
  }

  /**
   * 让底部工具窗口里的激活终端重新适配容器尺寸。
   * @description 窗口从隐藏变为可见、或尺寸变化时，xterm 的 fit 需要重算；
   *   不可见时 fit 会算出极小尺寸并触发 ConPTY 破坏性重绘，因此只在可见时调用。
   */
  function fitTerminalPanel() {
    const win = state.bottomView === "run" ? runWindow : state.bottomView === "terminal" ? terminalWindow : null;
    if (win && typeof win.fit === "function") win.fit();
  }

  /** 停止某个运行 tab（运行窗口工具栏 ■ / tab 右键）——停该 tab 所属命令。 */
  function handleStopTerminal(id: string) {
    const term = findTerminal(id);
    if (term && term.commandId) stopCommandAndSync({ id: term.commandId });
    else handleCloseTerminal(id);
  }

  /**
   * 重新运行某个运行 tab（运行窗口工具栏 ⟳ / tab 右键）——**复用原 tab / 原 xterm 面板**重跑，
   * 无论该进程当前是运行中还是已结束，都绝不新建 tab（用户诉求：重启在当前面板重启）。
   * @description 若仍在运行：先终止旧进程（保留 tab 记录，仅 session 置空）；
   *   随后清空该 tab 的旧输出，再用同一条 term 记录重新拉起 pty。
   */
  function handleRerunTerminal(id: string) {
    const term = findTerminal(id);
    if (!term || !term.commandId) return;
    // 含隐藏命令：脚本命令不在顶栏下拉里，但 rerun 仍要能找到它。
    const command = flattenCommands(state.projectCommands, { includeHidden: true }).find((c) => c.id === term.commandId);
    if (!command) return;
    // 运行中才需要杀旧进程；已结束的会话 session 已为 null，不动。
    if (term.exited !== true && term.session && typeof term.session.kill === "function") {
      try {
        term.session.kill();
      } catch {
        // 忽略：进程可能已自然退出
      }
    }
    term.session = null;
    // 复用原 tab：重置退出态（tab 上 ✓/✗ 消失、状态点复位、工具栏停止恢复可用）。
    term.exited = false;
    term.exitCode = null;
    term.pendingCommand = command.cmd;
    state.activeRunTerminalId = term.id;
    state.bottomView = "run";
    ensureBottomWindows();
    // 清掉上一轮的输出，重跑从干净屏幕开始（清的是显示，不销毁 xterm 实例）。
    if (runWindow && typeof runWindow.clear === "function") runWindow.clear(id);
    rebuildTerminalWindows();
    syncRunToolbar();
    syncSidebar();
    void createTerminalForId(term);
  }

  /** 复制某 tab 的标识（运行=命令原文，终端=标题）到系统剪贴板。 */
  function copyTerminalTab(id: string) {
    const term = findTerminal(id);
    if (!term) return;
    void copyToClipboard(term.title || "");
  }

  /** 复制某 tab 终端的选中文本到系统剪贴板（运行窗口工具栏「复制选中文本」用）。 */
  function copyTerminalSelection(id: string, text: string) {
    if (!findTerminal(id)) return;
    void copyToClipboard(text || "");
  }

  /**
   * 读取系统剪贴板文本（终端右键「粘贴」用）。
   * @description 优先宿主 IPC `window.snow.readClipboardText`（走主进程，渲染进程无权限限制；
   *   宿主终端自身的粘贴即用此 API），否则退回标准 Clipboard API。之前只用 navigator.clipboard，
   *   在插件沙箱中常不可用，导致「粘贴」拿不到内容——这是右键粘贴失效的根因。
   */
  async function readClipboardText() {
    const snow = typeof window !== "undefined" ? window.snow : null;
    if (snow && typeof snow.readClipboardText === "function") {
      try {
        return String((await snow.readClipboardText()) || "");
      } catch {
        return "";
      }
    }
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.readText === "function") {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return "";
      }
    }
    return "";
  }

  /** 终端窗口（mode B）组件配置。 */
  function terminalWindowOptions(): ToolWindowOptions {
    return {
      t,
      kind: "terminal",
      getTerminals: terminalModeTerminals,
      getActiveId: () => state.activeTerminalId,
      createTerminal: createLazyTerminalView,
      onSelectTab: handleSelectTerminal,
      onNewTerminal: () => handleNewTerminal({ mode: "terminal" }),
      onCloseTerminal: handleCloseTerminal,
      onMinimize: handleMinimizeRunPanel,
      getDock: () => state.toolDock,
      onToggleDock: toggleToolDock,
      onClear: (id) => terminalWindow && typeof terminalWindow.clear === "function" && terminalWindow.clear(id),
      onScrollToBottom: (id) =>
        terminalWindow && typeof terminalWindow.scrollToBottom === "function" && terminalWindow.scrollToBottom(id),
      onCloseOthers: closeOtherTerminals,
      onCloseAll: () => closeAllTerminalsOfMode("terminal"),
      onCopyTab: copyTerminalTab,
      onPasteText: readClipboardText,
    };
  }

  /** 运行窗口（mode A）组件配置。 */
  function runWindowOptions(): ToolWindowOptions {
    return {
      t,
      kind: "run",
      getTerminals: runModeTerminals,
      getActiveId: () => state.activeRunTerminalId,
      createTerminal: createLazyTerminalView,
      onSelectTab: handleSelectRunTerminal,
      onCloseTerminal: handleCloseTerminal,
      onMinimize: handleMinimizeRunPanel,
      getDock: () => state.toolDock,
      onToggleDock: toggleToolDock,
      onRerun: handleRerunTerminal,
      onStop: handleStopTerminal,
      onClear: (id) => runWindow && typeof runWindow.clear === "function" && runWindow.clear(id),
      onScrollToBottom: (id) =>
        runWindow && typeof runWindow.scrollToBottom === "function" && runWindow.scrollToBottom(id),
      onStopAll: stopAllRunTerminals,
      onCloseOthers: closeOtherTerminals,
      onCloseAll: () => closeAllTerminalsOfMode("run"),
      onCopyTab: copyTerminalTab,
      onCopySelection: copyTerminalSelection,
      onPasteText: readClipboardText,
      getShowOtherRuns: () => state.showOtherProjectRuns,
      onToggleShowOtherRuns: toggleShowOtherProjectRuns,
    };
  }

  /**
   * 新建一个终端。
   * @description 两种模式（用户已确认的双模式设计）：
   *   - mode="run"（模式 A）：一次性运行，跑完 shell 退出并回传退出码，tab 显示 ✓/✗；只读。
   *   - mode="terminal"（模式 B）：常驻交互终端，可连续敲命令，不要求状态回传。
   *   入口约定：工具栏 Run / 右键「运行」/ 代码行 ▶ → 模式 A；面板 ＋ → 模式 B。
   * @param {{command?: string, commandId?: string|null, cwd?: string, mode?: "run"|"terminal", title?: string}|string} [options] 命令、工作目录与模式
   */
  function handleNewTerminal(options?: NewTerminalOptions | string) {
    if (disposed) return;
    if (!isTerminalAvailable()) {
      setOperationStatus(false, t("run.terminalUnavailable", "当前宿主未提供终端能力"));
      return;
    }
    const opts: NewTerminalOptions = typeof options === "string" ? { command: options } : options || {};
    const command = typeof opts.command === "string" ? opts.command : "";
    const mode = opts.mode === "run" ? "run" : "terminal";
    const id = `term-${Date.now().toString(36)}-${(terminalToken += 1)}`;
    const term: TerminalTab = {
      id,
      // 命令归属 id（模式 A 用于 Run/Stop 按命令二态判定）；模式 B 为 null。
      commandId: mode === "run" && typeof opts.commandId === "string" ? opts.commandId : null,
      // 模式 A 用命令原文作标题（退出后追加 ✓/✗ + 退出码）；模式 B 统一叫「终端」。
      title: opts.title || (mode === "run" ? command : t("run.terminal", "终端")),
      mode,
      session: null,
      exited: false,
      exitCode: null,
      onInput: null,
      onResize: null,
      pendingCommand: command,
      // 脚本文件路径：非空时本 tab 用「脚本对应解释器」跑（见 createTerminalForId）。
      scriptPath: typeof opts.scriptPath === "string" ? opts.scriptPath : "",
      // 运行命令使用所属 package.json 目录；交互式终端默认使用项目根目录。
      cwd: typeof opts.cwd === "string" && opts.cwd ? opts.cwd : state.rootPath,
      // 任务所属项目。切走之后用来判断它是不是「其他项目」的后台任务。
      projectPath: state.rootPath,
      // pty 启动阶段令牌：重跑复用同一 tab 时用于作废旧 pty 的迟到 onData/onExit。
      phase: 0,
    };
    state.terminals.push(term);
    // 按 mode 打开对应工具窗口并激活新 tab：
    //   模式 A（一次性运行）→ 运行窗口；模式 B（交互终端）→ 终端窗口。
    if (mode === "run") {
      state.activeRunTerminalId = id;
      state.bottomView = "run";
    } else {
      state.activeTerminalId = id;
      state.bottomView = "terminal";
    }
    // 确保两个工具窗口已渲染（各自常驻、靠 hidden 切换），再让 tab 列表与新终端对齐。
    ensureBottomWindows();
    rebuildTerminalWindows();
    refreshBottomVisibility();
    // 窗口由隐藏（收起）变为可见后，xterm 需按真实尺寸重算（隐藏期 fit 会得到 0 尺寸）。
    // 右侧停靠先等宿主全屏，再按代码预览那一列的宽度适配。
    if (state.toolDock === "right") void ensureRightDock();
    else fitTerminalPanel();
    syncSidebar();
    syncRunToolbar();
    void createTerminalForId(term);
  }

  /** 为一条终端记录创建 pty 会话，并接好输入 / 尺寸 / 输出 / 退出。 */
  async function createTerminalForId(term: TerminalTab) {
    if (!term || disposed) return;
    // 本终端所属工具窗口的控制器（模式 A→运行窗口；模式 B→终端窗口），用其读写 xterm。
    const win = term.mode === "run" ? runWindow : terminalWindow;
    const sizes = win && typeof win.getSizes === "function" ? win.getSizes(term.id) : null;
    const cols = sizes && sizes.cols > 0 ? sizes.cols : DEFAULT_COLS;
    const rows = sizes && sizes.rows > 0 ? sizes.rows : DEFAULT_ROWS;

    // 阶段令牌：每次（重新）启动本 tab 的 pty 时 +1 并捕获；旧 pty 迟到的 onData/onExit
    //   令牌不匹配 → 丢弃。保证「重跑复用同一 tab」时上一轮的迟到输出不会污染新一轮。
    term.phase = (term.phase || 0) + 1;
    const phase = term.phase;

    // 终端视图 → shell：键盘输入与尺寸变化
    term.onInput = (data: string) => {
      // PtySessionResult 把 ok 与 write/resize/kill 平铺成可选字段（未做成可辨联合），
      // 而 term.session 只在 result.ok 为真时写入（见下方 `if (!result.ok) return`），方法必在。
      if (term.session) term.session.write!(data);
    };
    term.onResize = (nextCols: number, nextRows: number) => {
      if (term.resizeTimer) clearTimeout(term.resizeTimer);
      // 尺寸先记账：pty 还没建好时这次 fit 不能丢，否则会话会一直按 80×24 排版，
      // 构建日志的换行全是错的（原实现在 !term.session 时直接 return，这一尺寸就永久消失了）。
      term.pendingResize = { cols: nextCols, rows: nextRows };
      // 面板刚展开时 fit 会连着触发几次。尾沿防抖，避免 ConPTY 每次都整屏重绘。
      term.resizeTimer = setTimeout(() => {
        term.resizeTimer = null;
        const pending = term.pendingResize;
        if (!pending || term.phase !== phase || !term.session) return;
        term.pendingResize = null;
        term.session.resize!(pending.cols, pending.rows);
      }, 120);
    };

    if (term.mode === "run" && term.pendingCommand && win && typeof win.write === "function") {
      win.write(term.id, `\r\n\x1b[90m$ ${term.pendingCommand}\x1b[0m\r\n`);
    }

    // 模式 A：shell 走宿主同源解析链（终端设置 shellPath > detectTerminals()[0]），
    // 不写死 shell——跨 Windows / macOS / Linux 跟随宿主配置；退出写法按 shell 家族选择
    // （powershell 需 `exit $LASTEXITCODE`，cmd / posix / wsl 用裸 `exit` 继承退出码）。
    // 模式 B 不指定 shellPath，走宿主默认检测，保持交互能力。
    // 脚本命令（term.scriptPath）：改用**脚本对应类型的解释器**（bat→cmd / ps1→powershell /
    // sh→POSIX），系统里找不到该类型 shell 时提示「不支持」，不再用默认 shell 硬跑。
    let runShell: ResolvedRunShell | null = null;
    let runCommand = "";
    let exitCommand = "";
    if (term.mode === "run") {
      if (term.scriptPath) {
        const scriptShell = await resolveScriptShell(term.scriptPath);
        if (!scriptShell.supported) {
          const ext = scriptShell.extension ? `.${scriptShell.extension}` : "";
          const need = scriptShell.requiredLabel ? `（需要 ${scriptShell.requiredLabel}）` : "";
          setOperationStatus(false, t("run.scriptUnsupported", "当前终端不支持运行 {{ext}} 脚本{{need}}", { ext, need }));
          return;
        }
        // ScriptShellResolution 声明 supported 为 false 时这些字段缺失；上面已按 !supported 提前 return，
        // 但类型没把 supported 做成可辨别的标记，故此处只能断言。
        runShell = { shellPath: scriptShell.shellPath, exitCommand: scriptShell.exitCommand! };
        runCommand = scriptShell.runCommand!;
      } else {
        runShell = await cachedRunShell();
      }
      exitCommand = runShell.exitCommand;
    }

    const commandText = term.pendingCommand
      ? (term.scriptPath && runCommand ? runCommand : term.pendingCommand)
      : "";
    // 进程刚 spawn 就写入会堵住 PowerShell 的第一屏输出。等它先吐出内容再敲命令。
    let shellSpoke = false;
    let commandSent = false;
    let session: PtySessionResult | null = null;
    const sendCommand = () => {
      if (commandSent || !session || !commandText) return;
      if (disposed || term.phase !== phase || !state.terminals.includes(term)) return;
      commandSent = true;
      if (term.commandTimer) {
        clearTimeout(term.commandTimer);
        term.commandTimer = null;
      }
      term.pendingCommand = "";
      // 同 term.session：session 只在 result.ok 为真时被赋值，write 必在（PtySessionResult 未做成可辨联合）。
      session.write!(`${commandText}\r`);
      if (term.mode === "run" && exitCommand) session.write!(`${exitCommand}\r`);
    };

    const result = await createPtySession({
      cwd: term.cwd || state.rootPath,
      cols,
      rows,
      // 仅模式 A 指定 shellPath；模式 B 传 undefined，走宿主默认检测。
      shellPath: runShell ? runShell.shellPath : undefined,
      onData: (data) => {
        if (disposed || term.phase !== phase) return;
        shellSpoke = true;
        if (win && typeof win.write === "function") win.write(term.id, data);
        sendCommand();
      },
      onExit: (exitCode) => {
        // 重跑已启动新一轮（phase 变化）：旧 pty 的退出事件作废，避免清掉新一轮的运行态。
        if (term.phase !== phase) return;
        term.exited = true;
        term.exitCode = typeof exitCode === "number" ? exitCode : null;
        term.session = null;
        // 其他项目的后台任务结束且当前没打开开关：直接拿走，不留一个看不见的已结束 tab。
        if (term.mode === "run" && term.projectPath && pathKey(term.projectPath) !== pathKey(state.rootPath) && !state.showOtherProjectRuns) {
          state.terminals = state.terminals.filter((item) => item !== term);
          rebuildRunWindow();
          syncRunToolbar();
          syncSidebar();
          return;
        }
        // 模式 A 退出后刷新运行窗口 tab（✓/✗ + 退出码 + 状态点/工具栏态）。
        if (term.mode === "run") rebuildRunWindow();
        syncRunToolbar();
        syncSidebar();
      },
    });

    // 终端在创建期间被关闭 / 项目已切换：回收本次会话，避免孤儿进程。
    if (disposed || !state.terminals.includes(term)) {
      if (result.ok && typeof result.kill === "function") result.kill();
      return;
    }
    if (!result.ok) {
      setOperationStatus(false, result.error || t("run.startFailed", "启动失败"));
      return;
    }
    term.session = result;
    session = result;
    // 补发 session 建立前攒下的尺寸（见 onResize）；不补就停留在宿主默认的 80×24。
    if (term.pendingResize && typeof result.resize === "function") {
      const pending = term.pendingResize;
      term.pendingResize = null;
      result.resize(pending.cols, pending.rows);
    }
    if (commandText) {
      if (shellSpoke) sendCommand();
      else {
        term.commandTimer = setTimeout(() => {
          term.commandTimer = null;
          if (term.phase !== phase) return;
          sendCommand();
        }, 800);
      }
    }
    syncRunToolbar();
    syncSidebar();
  }

  /**
   * 运行一条命令（模式 A）：新建一个终端 tab 并把命令敲进去执行。
   * @description 「同一命令要么运行要么停止」：该命令已有运行中的终端时**不再新建**
   *   （按钮此时应为 Stop，正常不会走到这里；此守卫兜底右键「运行」与代码行 ▶ 的并发触发，
   *   替代原先的 300ms 时间窗口去重——按真实运行状态判定更准，且不误伤快速重跑）。
   * @param {{id?: string, cmd: string, labelFallback?: string, labelKey?: string|null}} command 命令对象
   */
  function handleRunCommand(command: FlatRunCommand) {
    if (disposed || !command || !command.cmd) return;
    // 脚本命令（bat/sh/ps1）默认不进顶栏 Run 下拉：手动点过文件行内 ▶ 后才登记进下拉。
    rememberManualScriptCommand(command);
    // 运行中拦截：同一命令已有未结束的运行终端 → 忽略（要么运行，要么停止）。
    if (runCountForCommand(command) > 0) return;
    // 模式 A：一次性运行，跑完 shell 退出 → onPtyExit 回传退出码 → 工具栏回到 Run。
    // `command.dir` 是显示/源码归属目录；Gradle 根项目任务可显式提供 `runDir` 覆盖实际工作目录。
    // 没有 `runDir` 的 Node、Go、Maven 等命令继续在所属包目录执行。
    const commandDir = typeof command.runDir === "string" ? command.runDir : command.dir;
    const cwd = commandDir ? joinPath(state.rootPath, commandDir) : state.rootPath;
    handleNewTerminal({
      command: command.cmd,
      commandId: command.id || null,
      cwd,
      mode: "run",
      title: command.cmd,
      // 脚本命令：带上源文件路径，createTerminalForId 会按扩展名选对应解释器。
      scriptPath: command.runKind === "script" ? command.sourcePath : "",
    });
  }

  /**
   * 手动登记脚本命令：脚本命令（bat/sh/ps1）默认只出现在文件行内 ▶，不进顶栏 Run 下拉；
   *   用户点过一次 ▶ 后，把它临时并入下拉（本会话有效，切换项目时清空）。
   * @param {{runKind?: string, id?: string}} command 命令对象
   */
  function rememberManualScriptCommand(command: FlatRunCommand | null) {
    if (!command || command.runKind !== "script" || !command.id) return;
    if (state.manualScriptCommands.some((item) => item.id === command.id)) return;
    state.manualScriptCommands.push(command);
    renderRunToolbarView();
  }

  // 文件树空白区右键：命中具体条目时由行自身处理并 stopPropagation（见 tree-view.js），
  // 只有落在空白处才冒泡到这里，弹出工作区级菜单（刷新 / 打开工作区 / 复制工作区路径）。
  function handleTreePaneContextMenu(event: MouseEvent) {
    // DOM 把 MouseEvent.target 声明为 EventTarget，而 closest 属于 Element；
    // 冒泡到容器的事件目标必然是节点本身，故只在类型层补回这一事实（原有可选调用不变）。
    if ((event.target as Element | null)?.closest?.(".sfe-file-item")) return;
    event.preventDefault();
    handleContextMenu(null, event.clientX, event.clientY);
  }

  // 5.1.1 右键菜单动作实现结束：所有实体变更都经过宿主 filesystem 写动作。

  /**
   * 由宿主文件读取结果构造预览状态对象。
   * @description 同时供 Git 变更视图的内容模式复用，避免重复构造预览状态。
   */
  function buildFilePreview(
    entry: Pick<FileTreeEntry, "name" | "path">,
    result: FileContentResult | null,
  ): PanelPreviewState {
    // 宿主接口不可用（返回 null）
    if (!result) {
      return {
        kind: "error",
        name: entry.name,
        path: entry.path,
        message: t("error.noApi", "当前版本未开放本地文件接口。"),
      };
    }

    // 图片：宿主返回 base64 内容 + mimeType，组装 data URL 交给 <img>
    if (result.isImage) {
      return {
        kind: "image",
        name: entry.name,
        path: entry.path,
        url: "data:" + (result.mimeType || "image/png") + ";base64," + result.content,
      };
    }

    // 二进制：不提供内联预览
    if (result.isBinary) {
      return {
        kind: "binary",
        name: entry.name,
        path: entry.path,
        mime: result.mimeType || "application/octet-stream",
      };
    }

    const text = String(result.content || "");
    const isMarkdown = isMarkdownPath(entry.name);
    const virtual = shouldVirtualize(text);

    return {
      kind: "text",
      name: entry.name,
      path: entry.path,
      text,
      highlightedHtml: "",
      isMarkdown,
      // 大 Markdown 先显示源码。小 Markdown 的 HTML 由后续的块加载补上。
      mode: isMarkdown && virtual ? "code" : "preview",
      html: "",
      editable: false,
      saveState: "idle",
      saveMessage: "",
    };
  }

  /**
   * 双击文件：打开该文件并直接进入快速编辑（复用右侧预览的内联编辑态）。
   * @description 单击已负责打开预览；双击在此之上叠加「进入编辑」，避免新增独立弹窗组件。
   *   二进制 / 图片 / 非文本预览不支持编辑，setPreviewEditable 内部会拒绝。
   */
  async function handleOpenFileEdit(entry: FileTreeEntry | null) {
    if (!entry || entry.isDirectory || state.operationBusy) return;
    await previewFile(entry);
    if (disposed || !state.preview || pathKey(state.preview.path) !== pathKey(entry.path)) return;
    if (state.preview.kind !== "text") return;
    setPreviewEditable(true);
  }

  // ------------------------------------------------------------------
  // 文件搜索：宿主 searchFiles 同时搜索文件名与文件内容，300ms 防抖 + 序列号防过期
  // （对标 snow-app 资源管理器；搜索模式下文件树替换为结果列表）
  // ------------------------------------------------------------------
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let searchSeq = 0;

  /** 搜索框输入：防抖调用宿主 searchFiles；空查询即退出搜索模式。 */
  function handleSearchInput(value: string) {
    state.searchQuery = String(value ?? "");
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    const query = state.searchQuery.trim();
    if (!query || !state.rootPath) {
      state.searching = false;
      state.searchResults = [];
      renderTree();
      return;
    }
    state.searching = true;
    renderTree();
    const seq = ++searchSeq;
    const root = state.rootPath;
    searchTimer = setTimeout(async () => {
      searchTimer = null;
      const snow = snowApi();
      let results: FileSearchResult[] = [];
      if (snow && typeof snow.searchFiles === "function") {
        try {
          results = await snow.searchFiles(root, query);
        } catch {
          results = [];
        }
      }
      if (disposed || seq !== searchSeq || pathKey(root) !== pathKey(state.rootPath)) return;
      // 开启「按 .gitignore 过滤」时，搜索结果同样排除元数据项（.git 等）与被 .gitignore 命中的项。
      // 说明：宿主 searchFiles 无排除参数、且其遍历不读 .gitignore，插件只能在结果上过滤；
      // 这不会减少宿主的磁盘扫描量（搜索前的剪枝需要改宿主 Rust 侧）。
      let list = Array.isArray(results) ? results : [];
      if (state.viewSettings.respectGitignore) {
        list = filterExcludedEntries(list, root, viewFilterOpts());
      }
      state.searchResults = list;
      state.searching = false;
      renderTree();
    }, 300);
  }

  /** 退出搜索模式：清空查询、结果与防抖计时器，恢复文件树。 */
  function clearSearch() {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    searchSeq++;
    state.searchQuery = "";
    state.searchResults = [];
    state.searching = false;
    // 必须同步清空输入框：否则框里仍留着关键词，看上去像「点了没反应」。
    if (layoutEls && layoutEls.searchInput) layoutEls.searchInput.value = "";
    renderTree();
  }

  /** 点击搜索结果：选中该文件、退出搜索、打开预览，并把侧边栏与代码都定位到目标（行）。 */
  async function handleSearchResultOpen(result: FileSearchResult | null, line?: number) {
    if (!result || !result.path) return;
    state.selected = new Set([result.path]);
    state.selectionAnchor = result.path;
    const target = {
      name: result.name || basename(result.path),
      path: result.path,
      isDirectory: !!result.isDirectory,
    };
    // 必须先 await 展开祖先目录：否则下面重建的树里没有该行，侧边栏无法定位。
    await expandTreeToPath(target.path);
    if (disposed) return;
    clearSearch();
    // 文件树已重建且目标行已存在：把侧边栏滚动到该行（选中高亮由 .selected 承担）。
    scrollTreeToSelected();
    if (target.isDirectory) return;
    if (typeof line === "number") state.pendingRevealLine = line;
    void previewFile(target);
  }

  /**
   * 展开目标文件的所有祖先目录，使其在文件树中可见。
   * @description 从根逐级在真实树里找到对应目录条目并 loadDirectoryChildren（写回 entry.children），
   *   再置 expanded；只处理缺失的层级，某级不可读时静默中止，不影响预览打开。
   */
  async function expandTreeToPath(targetPath: string) {
    if (!state.rootPath) return;
    const rootKey = pathKey(state.rootPath);
    const rootNorm = normalizePath(state.rootPath);
    const rel = normalizePath(targetPath).slice(rootNorm.length).replace(/^[/\\]+/, "");
    if (!rel) return;
    const segments = rel.split(/[/\\]+/).filter(Boolean);
    if (segments.length <= 1) return; // 目标就在根目录下，无需展开
    let currentPath = state.rootPath;
    for (let i = 0; i < segments.length - 1; i++) {
      currentPath = joinPath(currentPath, segments[i]);
      if (state.expanded[currentPath]) continue;
      const entry = findTreeEntry(state.rootNodes, currentPath);
      if (!entry || !entry.isDirectory) return;
      if (!Array.isArray(entry.children)) {
        try {
          await loadDirectoryChildren(entry);
        } catch {
          entry.children = [];
        }
      }
      if (disposed || pathKey(rootKey) !== pathKey(state.rootPath)) return;
      state.expanded[currentPath] = true;
    }
  }

  /** 把文件树滚动到当前选中行并高亮（搜索定位用；树未渲染该行时忽略）。 */
  function scrollTreeToSelected() {
    if (disposed || !layoutEls) return;
    const body = layoutEls.treeBody || layoutEls.treePane;
    if (!body || !state.selected || state.selected.size === 0) return;
    const [selectedPath] = state.selected;
    const row = [...body.querySelectorAll<HTMLElement>(".sfe-file-item")].find(
      (node) => pathKey(node.dataset.path) === pathKey(selectedPath)
    );
    if (!row) return;
    // 用 rect 换算相对滚动容器的偏移，避免 offsetParent 不是 treeBody 时 offsetTop 失真。
    const bodyRect = body.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const rowTop = rowRect.top - bodyRect.top + body.scrollTop;
    const rowBottom = rowTop + rowRect.height;
    if (rowTop < body.scrollTop) body.scrollTop = rowTop;
    else if (rowBottom > body.scrollTop + body.clientHeight) body.scrollTop = rowBottom - body.clientHeight;
  }

  /** 预览渲染后把代码滚动容器定位到目标行（按可视行元素精确测量，兼容虚拟列表）。 */
  function revealPreviewLine(line: number) {
    if (disposed || !layoutEls || !layoutEls.previewPane) return;
    const pane = layoutEls.previewPane;
    const scroller = pane.querySelector(".sfe-file-viewer-code-scroll, .sfe-file-viewer-edit-scroll");
    if (!scroller) return;
    // 大文件走虚拟列表：只有 scrollToIndex 能定位到未渲染行。
    const vlist = pane.__sfeVList;
    if (vlist && typeof vlist.scrollToIndex === "function") {
      vlist.scrollToIndex(line - 1);
      return;
    }
    // 整块高亮态：行号槽逐行有元素，按行号取真实元素定位最准。
    const gutterRow = pane.querySelector<HTMLElement>(`.sfe-file-viewer-gutter-row:nth-child(${line})`);
    if (gutterRow) {
      scroller.scrollTop = Math.max(0, gutterRow.offsetTop - 4);
      return;
    }
    // 编辑态：按 textarea 行高换算（textarea 高度贴合内容）。
    const textarea = pane.querySelector(".sfe-file-viewer-textarea");
    if (textarea) {
      let lh = 20;
      try {
        const parsed = parseFloat(window.getComputedStyle(textarea).lineHeight);
        if (parsed > 0) lh = parsed;
      } catch {
        /* 测试环境可能无 getComputedStyle */
      }
      scroller.scrollTop = Math.max(0, (line - 1) * lh);
      return;
    }
    let lineHeight = 20;
    try {
      const probe = pane.querySelector(".sfe-file-viewer-code-content");
      const parsed = probe ? parseFloat(window.getComputedStyle(probe).lineHeight) : NaN;
      if (parsed > 0) lineHeight = parsed;
    } catch {
      /* 测试环境可能无 getComputedStyle：沿用默认行高 */
    }
    scroller.scrollTop = Math.max(0, (line - 1) * lineHeight);
  }

  // 5. 选中并预览文件
  async function previewFile(entry: FileTreeEntry) {
    const requestId = ++previewRequestId;
    saveRequestId++;
    // 单选打开：选中集合收敛为当前文件。
    state.selected = new Set([entry.path]);
    state.selectionAnchor = entry.path;
    // 终端占着右侧时先让回底栏，这次点击的文件才能显示在代码预览里。
    yieldRightDockToCode();

    // 先立刻切到「正在读取」并渲染，保证点击后马上看到反馈。
    // 全屏联动可能等待宿主 React 更新数帧（见 ensureRightPanelFullscreen），
    // 若排在 loading 之前，用户会先看到界面无响应，误以为卡死——这是体验倒退的根因。
    state.preview = {
      kind: "loading",
      name: entry.name,
      path: entry.path,
    };
    // 仅就地切换文件树选中高亮与重绘右侧预览：不重建整棵树，大目录下点文件不再卡顿
    applyTreeSelectionHighlight();
    renderPreview();

    // 让出当前任务，使浏览器先把「正在读取」绘制出来，再执行可能阻塞的全屏联动；
    // 否则全屏触发与 loading 渲染同处一个同步任务，绘制被推迟，点击后仍会先卡一下。
    await waitForNextFrame();

    // 智能联动全屏：非全屏模式下点击具体文件自动全屏展开代码大视野
    if (!isRightPanelFullscreen()) {
      const fullscreenReady = await ensureRightPanelFullscreen();
      if (!fullscreenReady) {
        setOperationStatus(false, "无法进入右侧面板全屏");
      }
    }

    try {
      // 巨型文件先挡在读取之前：宿主 readFileContent 没有长度参数，一旦发起就是整份文件
      // 跨 IPC 进内存，再叠上分行与文本扫描，表现为整个面板假死。
      if (typeof entry.size === "number" && entry.size > MAX_PREVIEW_BYTES) {
        state.preview = {
          kind: "error",
          name: entry.name,
          path: entry.path,
          message: t("preview.fileTooLarge", "文件（{{size}}）过大，无法预览，请改用外部编辑器打开", {
            size: humanSize(entry.size),
          }),
        };
        renderPreview();
        return;
      }
      const result = await readFileContent(entry.path);
      if (disposed || requestId !== previewRequestId || !state.selected.has(entry.path)) return;
      // 列目录没给尺寸时（size 缺省）按宿主回传的 size 兜底，判定同一阈值。
      if (typeof result?.size === "number" && result.size > MAX_PREVIEW_BYTES) {
        state.preview = {
          kind: "error",
          name: entry.name,
          path: entry.path,
          message: t("preview.fileTooLarge", "文件（{{size}}）过大，无法预览，请改用外部编辑器打开", {
            size: humanSize(result.size),
          }),
        };
        renderPreview();
        return;
      }
      state.preview = buildFilePreview(entry, result);
      renderPreview();
      if (state.pendingRevealLine) {
        const line = state.pendingRevealLine;
        state.pendingRevealLine = null;
        if (state.preview.kind === "text") {
          requestAnimationFrame(() => {
            if (!disposed) revealPreviewLine(line);
          });
        }
      }
      if (state.preview.kind === "text" && state.preview.isMarkdown && state.preview.mode === "preview") {
        void hydrateFileMarkdown(requestId);
      }
      return;
    } catch (err) {
      if (disposed || requestId !== previewRequestId || !state.selected.has(entry.path)) return;
      state.preview = {
        kind: "error",
        name: entry.name,
        path: entry.path,
        // 条件分支已对同一表达式判真，但 TS 不跨两次 cast 复用收窄，故断言 message 非空。
        message: err && (err as ErrorLike).message ? (err as ErrorLike).message! : String(err),
      };
    }
    renderPreview();
  }

  // 5.1 将 Markdown 预览中的本地相对图片读取为 data URL 后回填
  // 只改预览 DOM，不触发整体重渲染，避免打断滚动与选区
  async function inlineMarkdownImages(docPath: string) {
    const holder = container.querySelector(".sfe-markdown-body");
    if (!holder) return;
    const images = Array.from(holder.querySelectorAll("img[data-sfe-src]"));
    if (!images.length) return;

    await Promise.all(
      images.map(async (img) => {
        const ref = img.getAttribute("data-sfe-src") || "";
        const absPath = resolveMarkdownAssetPath(ref, docPath);
        if (!absPath) return;
        const dataUrl = await readImageAsDataUrl(absPath);
        // 异步期间可能已卸载或切换到其他文档
        if (disposed || !dataUrl || !holder.isConnected) return;
        img.setAttribute("src", dataUrl);
      })
    );
  }

  async function hydrateFileMarkdown(requestId: number) {
    const preview = state.preview;
    if (!preview || preview.kind !== "text" || !preview.isMarkdown || preview.mode !== "preview") return;
    if (shouldVirtualize(preview.text)) {
      if (disposed || requestId !== previewRequestId) return;
      state.preview = { ...state.preview, mode: "code" };
      renderPreview();
      return;
    }
    // 已有与当前文本同源的渲染结果就复用：marked 解析 + DOMPurify 全文净化只在首次
    // 或文本变化后付一次（html 在文本改动与保存时都会清空）。
    if (state.preview.html) {
      void inlineMarkdownImages(state.preview.path);
      return;
    }
    // 块加载失败与「宿主没挂出渲染器」同一降级：归一成 null 走下面的 return，
    // 预览保持无 html 态；不让拒绝从 void 调用点逃成 unhandled rejection。
    const mod = await loadChunk("markdown").catch(() => null);
    if (disposed || requestId !== previewRequestId || !state.preview || state.preview.mode !== "preview") return;
    if (!mod || typeof mod.renderMarkdownHtml !== "function") return;
    state.preview = { ...state.preview, html: mod.renderMarkdownHtml(state.preview.text || "") };
    renderPreview();
    void inlineMarkdownImages(state.preview.path);
  }

  // 5.2 切换 Markdown 的预览 / 代码模式
  function setPreviewMode(mode: CodePreviewMode) {
    const next = mode === "code" ? "code" : "preview";
    if (state.preview.mode === next) return;
    const requestId = previewRequestId;
    state.preview = {
      ...state.preview,
      mode: next,
      editable: false,
      saveState: "idle",
      saveMessage: "",
    };
    renderPreview();
    if (next === "preview" && state.preview.kind === "text" && state.preview.isMarkdown) {
      void hydrateFileMarkdown(requestId);
    }
  }

  // 5.3 编辑状态只属于当前文件；输入时不重建 DOM，避免光标跳动。
  function setPreviewEditable(next?: boolean) {
    if (!state.preview || state.preview.kind !== "text") return;
    if (state.preview.isMarkdown && state.preview.mode !== "code") return;
    state.preview = {
      ...state.preview,
      editable: next === true,
      saveState: "idle",
      saveMessage: "",
    };
    renderPreview();
  }

  function handlePreviewInput(value: string) {
    if (!state.preview || !state.preview.editable) return;
    state.preview.text = String(value ?? "");
    state.preview.saveState = "idle";
    state.preview.saveMessage = "";
    // 整篇高亮 HTML 与 text 同源才可用；文本一改立即作废，避免编辑态复用到过期配色。
    state.preview.highlightedHtml = "";
    state.preview.html = "";
  }

  // 保存只接受当前文件的完整文本；写入完成后再更新高亮和 Git 状态。
  async function handleSavePreview() {
    if (
      !state.preview ||
      state.preview.kind !== "text" ||
      !state.preview.editable ||
      !state.preview.path
    ) return;

    const saveId = ++saveRequestId;
    const filePath = state.preview.path;
    const content = state.preview.text;
    state.preview.saveState = "saving";
    state.preview.saveMessage = "";
    // 就地同步保存中态：不重建编辑区，textarea 的光标与滚动得以保留。
    if (!syncPreviewChrome()) renderPreview();

    const result = await writeFileContent(api, filePath, content);
    if (
      disposed ||
      saveId !== saveRequestId ||
      !state.preview ||
      pathKey(state.preview.path) !== pathKey(filePath)
    ) return;

    if (result && result.ok === true) {
      state.preview.highlightedHtml = "";
      state.preview.html = "";
      // 磁盘内容已变，Git 预览里缓存的 diff / 工作区全文随之过期。
      gitDiffCache.clear();
      state.preview.saveState = "saved";
      state.preview.saveMessage = "";
      if (!syncPreviewChrome()) renderPreview();
      if (state.preview.isMarkdown && state.preview.mode === "preview") {
        void hydrateFileMarkdown(previewRequestId);
      }
      await refreshGitAll();
    } else {
      state.preview.saveState = "failed";
      state.preview.saveMessage =
        result && result.error === "当前宿主未提供文件写入能力"
          ? t("preview.editUnavailable", "当前宿主未提供文件写入能力")
          : result && result.error
            ? String(result.error)
            : t("action.saveFailed", "保存失败");
      if (!syncPreviewChrome()) renderPreview();
    }
  }

  // 复制 / 保存等微状态变化：优先走查看器注册的就地同步通道（只翻转按钮与提示条），
  // 不为翻转一个按钮销毁重建整个预览（那会连带虚拟列表与可视行高亮全部重来）。
  // 容器上没有同步句柄（非文本预览 / 尚未渲染）时退回整体重渲染。
  function syncPreviewChrome(): boolean {
    if (!layoutEls) return false;
    const pane = state.mainView === "git" ? layoutEls.gitPreviewPane : layoutEls.previewPane;
    if (!pane) return false;
    // 保存状态只属于 files 面板的预览（state.preview）；Git 查看器内容来自 gitPreviewView
    // 的新对象，不得消费 files 的保存态，否则会在 Git 面板画出无关的「已保存」提示条。
    const ownsSaveState = state.mainView !== "git";
    return syncViewerChrome(pane, {
      copied: state.copied,
      saving: ownsSaveState && state.preview.saveState === "saving",
      saveState: ownsSaveState ? state.preview.saveState || "idle" : "idle",
      saveMessage: ownsSaveState ? state.preview.saveMessage || "" : "",
    });
  }

  // 6. 复制当前代码
  async function handleCopyCode() {
    if (!state.preview || state.preview.kind !== "text" || !state.preview.text) return;
    const ok = await copyToClipboard(state.preview.text);
    if (!ok) return;

    state.copied = true;
    if (!syncPreviewChrome()) renderActiveViewer();
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      if (disposed) return;
      state.copied = false;
      if (!syncPreviewChrome()) renderActiveViewer();
    }, 1600);
  }

  // 视图开关菜单已拆除：视图选项（按 .gitignore 过滤 / Java 包结构视图）迁移到文件树右键菜单，
  // 主视图切换（文件 / Git）迁移到左侧入口栏，故工具栏不再有三点菜单。

  // ------------------------------------------------------------------
  // 7. 渲染：骨架只构建一次，之后按分区局部更新
  // ------------------------------------------------------------------
  // 关键设计：早期实现每次 render() 都 container.replaceChildren() 整体重建，
  // 宿主 git watcher 高频刷新时会反复重建 DOM —— 表现为提交输入框被反复抢焦点、
  // 右键菜单与键盘操作被打断、文本选区被销毁而无法选中。现改为：
  //   - 骨架（工具栏 + 主视图容器）只在首次构建；
  //   - 视图切换（文件树 / Git 变更）才重建主视图；
  //   - 数据刷新只更新对应分区（文件树 / Git 列表 / 提交框 / 查看器），
  //     提交输入框与列表滚动容器永不因数据刷新而销毁。

  let layoutEls: LayoutEls | null = null;

  // 构建骨架（幂等：仅在缺失或已脱离文档时重建）
  function ensureLayout() {
    if (layoutEls && layoutEls.root.isConnected) return layoutEls;

    container.replaceChildren();
    const root = el("div", "sfe-root");
    // layout 为横排：最左「竖排入口栏」+ 右侧主体（工具栏 / 主视图 / 底部工具窗口 / 底栏）。
    const layout = el("div", "sfe-container");

    // ── 最左侧竖排入口栏（IDEA tool window 语义）：文件在【顶部】，运行 / 终端【贴底】 ──
    const sidebar = el("div", "sfe-sidebar");
    /** 侧栏按钮：图标 + title（选中态由 syncSidebar 就地切换 .active），追加到指定父节点。 */
    const sidebarBtn = (
      parent: HTMLElement,
      iconName: string,
      label: string,
      onClick: () => void,
    ): HTMLButtonElement => {
      const btn = el("button", "sfe-sidebar-btn");
      btn.type = "button";
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.appendChild(createActionIcon(iconName, 16));
      btn.addEventListener("click", onClick);
      parent.appendChild(btn);
      return btn;
    };
    // 顶部主视图二选一：文件 / Git 变更（必有其一激活，不可都关）。
    const sidebarTop = el("div", "sfe-sidebar-top");
    sidebar.appendChild(sidebarTop);
    const fileViewBtn = sidebarBtn(sidebarTop, "folderOpen", t("sidebar.files", "文件"), () => switchMainView("files"));
    const gitViewBtn = sidebarBtn(sidebarTop, "folderGit2", t("sidebar.git", "Git 变更"), () => switchMainView("git"));
    // 底部按钮组（运行 / 终端）：靠 margin-top:auto 推到底部，与顶部主视图入口分开。
    const sidebarBottom = el("div", "sfe-sidebar-bottom");
    sidebar.appendChild(sidebarBottom);
    // 运行：切到「运行」工具窗口；运行中叠加小圆点（与底栏一致）。
    const runSideBtn = sidebarBtn(sidebarBottom, "play", t("sidebar.run", "运行"), () => selectBottomView("run"));
    const runSideDot = el("span", "sfe-sidebar-dot");
    runSideDot.hidden = true;
    runSideBtn.appendChild(runSideDot);
    // 终端：切到「终端」工具窗口。
    const terminalSideBtn = sidebarBtn(
      sidebarBottom,
      "terminal",
      t("sidebar.terminal", "终端"),
      () => selectBottomView("terminal"),
    );
    layout.appendChild(sidebar);

    // ── 主体：工具栏 / 主视图 / 底部工具窗口 / 底栏（纵排）──
    const body = el("div", "sfe-body");

    const toolbar = el("div", "sfe-toolbar");
    const pathText = el("div", "sfe-toolbar-path");
    // 同步指示器：紧跟文件夹名（pathText）之后的上下箭头，无数字，有未同步则着色、同步中动画。
    const syncIndicatorWrap = el("div", "sfe-toolbar-sync");
    const actions = el("div", "sfe-toolbar-actions");
    const statusEl = el("span", "sfe-toolbar-status");
    statusEl.hidden = true;
    actions.appendChild(statusEl);

    // 运行控件：对标 IDEA 右上角 Run（▶ Run / ■ Stop 二态 + 命令下拉）。
    // 容器固定常驻，内容由 renderRunToolbar 按识别结果与运行状态同步，避免重建工具栏。
    const runToolbarWrap = el("div", "sfe-run-toolbar-wrap");
    runToolbarWrap.hidden = true;
    actions.appendChild(runToolbarWrap);

    // 「差异 / 内容」切换容器：紧邻刷新按钮，仅在 Git 变更视图且已打开文件时显示
    // （容器固定，内容由 renderGitViewSwitchInToolbar 按需同步，避免重建工具栏）
    const gitViewSwitchWrap = el("div", "sfe-toolbar-git-view");
    gitViewSwitchWrap.hidden = true;
    actions.appendChild(gitViewSwitchWrap);

    toolbar.appendChild(pathText);
    toolbar.appendChild(syncIndicatorWrap);
    toolbar.appendChild(actions);
    body.appendChild(toolbar);
    // 工具栏以下单独成行：底栏时纵排，右侧停靠时主视图与工具窗口横排。
    const bodyMain = el("div", "sfe-body-main");
    const mainView = el("div", "sfe-main-view");
    bodyMain.appendChild(mainView);
    // 工具窗口：两个独立窗口（终端 / 运行），随主视图重建而不消失；
    // 默认隐藏，由 refreshBottomVisibility 按 state.bottomView 互斥显隐（内容在首次打开时按需渲染）。
    const runWindowEl = el("div", "sfe-tool-window sfe-run-window");
    runWindowEl.hidden = true;
    bodyMain.appendChild(runWindowEl);
    const terminalWindowEl = el("div", "sfe-tool-window sfe-terminal-window");
    terminalWindowEl.hidden = true;
    bodyMain.appendChild(terminalWindowEl);
    body.appendChild(bodyMain);
    layout.appendChild(body);
    root.appendChild(layout);
    container.appendChild(root);

    layoutEls = {
      root,
      layout,
      sidebar,
      sidebarTop,
      sidebarBottom,
      fileViewBtn,
      gitViewBtn,
      runSideBtn,
      runSideDot,
      terminalSideBtn,
      body,
      bodyMain,
      mainView,
      runWindowEl,
      terminalWindowEl,
      pathText,
      syncIndicatorWrap,
      statusEl,
      gitViewSwitchWrap,
      runToolbarWrap,
      treePane: null,
      previewPane: null,
      gitPane: null,
      gitPreviewPane: null,
    };
    return layoutEls;
  }

  /**
   * 切换主视图（文件 / Git 变更）——二选一，必有其一激活，不可都关。
   * @description 手动切换后仅改 state.mainView 并重建主视图；mainView 不持久化，
   *   每次重新打开面板从「文件」开始。
   * @param {"files"|"git"} view 目标主视图
   */
  async function switchMainView(view: PanelState["mainView"]) {
    if (disposed || (view !== "files" && view !== "git")) return;
    if (state.mainView === view) return;
    state.mainView = view;
    if (view === "files") {
      // 离开 Git 变更视图：清空查看器状态，否则再切回时会残留上次打开的比对。
      state.gitPreview = null;
      state.gitSelected = null;
    }
    render();
    // 首次进入 Git 变更视图且尚未拉取过状态时补齐数据。
    if (view === "git" && !state.gitStatus) await refreshGitViewStatus();
  }

  /** 同步左侧入口栏选中态与运行中圆点。 */
  function syncSidebar() {
    if (!layoutEls) return;
    if (layoutEls.fileViewBtn) layoutEls.fileViewBtn.classList.toggle("active", state.mainView === "files");
    if (layoutEls.gitViewBtn) layoutEls.gitViewBtn.classList.toggle("active", state.mainView === "git");
    if (layoutEls.runSideBtn) layoutEls.runSideBtn.classList.toggle("active", state.bottomView === "run");
    if (layoutEls.terminalSideBtn) layoutEls.terminalSideBtn.classList.toggle("active", state.bottomView === "terminal");
    if (layoutEls.runSideDot) layoutEls.runSideDot.hidden = runningCount() <= 0;
  }

  // 同步工具栏（路径、状态）
  function renderToolbar() {
    if (!layoutEls) return;
    const { pathText, statusEl } = layoutEls;
    const name = state.rootPath ? basename(state.rootPath) : "-";
    if (pathText.textContent !== name) pathText.textContent = name;
    if (pathText.title !== (state.rootPath || "")) pathText.title = state.rootPath || "";
    if (state.status) {
      if (statusEl.textContent !== state.status) statusEl.textContent = state.status;
      statusEl.hidden = false;
    } else {
      statusEl.hidden = true;
    }
  }

  // 构建「差异 / 内容」分段控件（工具栏用，复用查看器分段控件的样式类）
  function buildGitViewSwitch(current: GitViewerMode) {
    const switcher = el("div", "sfe-md-mode-switch-inline");
    switcher.setAttribute("role", "group");
    // as const 只把 key 的字面量类型留给 setGitPreviewMode（GitViewerMode），数组本身不变。
    const segments = [
      { key: "diff", icon: "diff", label: t("action.diff", "差异") },
      { key: "content", icon: "code", label: t("action.content", "内容") },
    ] as const;
    for (const seg of segments) {
      const isActive = seg.key === current;
      const btn = el("button", "sfe-md-mode-btn" + (isActive ? " active" : ""));
      btn.type = "button";
      btn.title = seg.label;
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      btn.appendChild(createActionIcon(seg.icon, 13));
      btn.appendChild(el("span", "sfe-md-mode-label", seg.label));
      if (!isActive) btn.addEventListener("click", () => setGitPreviewMode(seg.key));
      switcher.appendChild(btn);
    }
    return switcher;
  }

  // 同步工具栏中的「差异 / 内容」切换：仅全屏 + Git 变更视图 + 已打开文件时显示
  function renderGitViewSwitchInToolbar() {
    if (!layoutEls || !layoutEls.gitViewSwitchWrap) return;
    const wrap = layoutEls.gitViewSwitchWrap;
    const gp = state.gitPreview;
    const terminalOwnsRight = state.toolDock === "right" && (state.bottomView === "run" || state.bottomView === "terminal");
    if (state.mainView !== "git" || !gp || !isRightPanelFullscreen() || terminalOwnsRight) {
      if (wrap.firstChild) wrap.replaceChildren();
      wrap.hidden = true;
      return;
    }
    const current = gp.mode === "content" ? "content" : "diff";
    wrap.replaceChildren(buildGitViewSwitch(current));
    wrap.hidden = false;
  }

  // 全量渲染：重建主视图（用于初始化与文件树 / Git 变更视图切换）
  // 局部：骨架与常驻控件（不重建主视图内容）。挂载期先铺这层，数据到位再 render。
  function renderChrome() {
    ensureLayout();
    renderToolbar();
    renderConfirmDialog();
    // 运行控件（常驻工具栏，按识别结果与运行状态同步）。
    renderRunToolbarView();
    // 底部工具窗口 / 左侧入口栏挂在主体上（不随 mainView 重建），此处同步显隐与选中态。
    refreshBottomVisibility();
    syncSidebar();
    // 窗口可见时让终端适配尺寸（视图切换可能改变容器宽度）。
    fitTerminalPanel();
  }

  function render() {
    if (disposed) return;
    renderChrome();
    // 上面 ensureLayout() 已建好骨架并写回 layoutEls；ensureLayout 只在
    // 「已存在且仍挂在文档上」时提前返回，故此后 layoutEls 必非空（断言只补回这条不变量）。
    const { mainView } = layoutEls!;
    mainView.replaceChildren();
    renderGitViewSwitchInToolbar();
    layoutEls!.treePane = null;
    layoutEls!.previewPane = null;
    layoutEls!.gitPane = null;
    layoutEls!.gitPreviewPane = null;

    if (state.mainView === "git") {
      buildGitView(mainView);
      renderGitPane();
      renderGitPreview();
      syncGitIndicator();
      return;
    }
    buildFileView(mainView);
    renderTree();
    renderPreview();
    syncGitIndicator();
  }

  // 构建文件树视图骨架（左树 + 右预览）
  function buildFileView(mainView: HTMLElement) {
    const treePane = el("div", "sfe-tree-pane");
    // 空白区右键：行内条目自行处理并阻止冒泡，其余区域在此兜底弹出工作区级菜单
    treePane.addEventListener("contextmenu", handleTreePaneContextMenu);

    // 文件搜索栏（仅工作区已就绪时显示）：同时搜索文件名与文件内容。
    const searchBar = el("div", "sfe-search-bar");
    searchBar.hidden = !state.rootPath;
    const searchIcon = el("span", "sfe-search-icon");
    searchIcon.appendChild(createActionIcon("search", 13));
    const searchInput = el("input", "sfe-search-input");
    searchInput.type = "text";
    searchInput.spellcheck = false;
    searchInput.value = state.searchQuery;
    searchInput.placeholder = t("search.placeholder", "搜索文件名或内容");
    searchInput.setAttribute("aria-label", t("search.placeholder", "搜索文件名或内容"));
    searchInput.addEventListener("input", () => handleSearchInput(searchInput.value));
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        clearSearch();
      }
    });
    const searchClear = el("button", "sfe-search-clear");
    searchClear.type = "button";
    searchClear.title = t("search.clear", "清除搜索");
    searchClear.setAttribute("aria-label", t("search.clear", "清除搜索"));
    searchClear.appendChild(createActionIcon("close", 13));
    searchClear.hidden = !state.searchQuery;
    searchClear.addEventListener("click", () => clearSearch());
    searchBar.appendChild(searchIcon);
    searchBar.appendChild(searchInput);
    searchBar.appendChild(searchClear);
    treePane.appendChild(searchBar);

    const treeBody = el("div", "sfe-tree-body");
    treePane.appendChild(treeBody);
    // buildFileView 只在 render() 里 ensureLayout() 之后调用，layoutEls 必非空（同 render 的说明）。
    layoutEls!.treeBody = treeBody;
    layoutEls!.searchInput = searchInput;
    layoutEls!.searchClear = searchClear;

    mainView.appendChild(treePane);
    layoutEls!.treePane = treePane;

    const previewPane = el("div", "sfe-preview-pane");
    mainView.appendChild(previewPane);
    layoutEls!.previewPane = previewPane;
  }

  // 构建 Git 变更视图骨架（左列表 + 右查看器）
  function buildGitView(mainView: HTMLElement) {
    const gitPane = el("div", "sfe-git-pane");
    mainView.appendChild(gitPane);
    layoutEls!.gitPane = gitPane;

    const gitPreviewPane = el("div", "sfe-git-preview-pane");
    mainView.appendChild(gitPreviewPane);
    // 同 buildFileView：这两个函数只在 render() 的 ensureLayout() 之后被调用。
    layoutEls!.gitPreviewPane = gitPreviewPane;
  }

  // 局部：仅切换文件树的选中行高亮，不重建 DOM
  // @description previewFile / 多选点击只改 state.selected（Set），不重建整棵树：大目录下整树重建是卡顿根因。
  //   选中态对行只是 .selected class（纯背景色），就地切换与重建后的渲染结果完全等价，
  //   同时天然保住滚动位置、展开态与行内事件。
  function applyTreeSelectionHighlight() {
    if (disposed || !layoutEls || !layoutEls.treePane) return;
    const pane = layoutEls.treePane;
    const selectedKeys = new Set(Array.from(state.selected, pathKey));
    for (const node of pane.querySelectorAll<HTMLElement>(".sfe-file-item")) {
      node.classList.toggle("selected", selectedKeys.has(pathKey(node.dataset.path)));
    }
  }

  // 局部：文件树 / 搜索结果（保留滚动位置）
  function renderTree() {
    if (disposed || !layoutEls || !layoutEls.treePane) return;
    const body = layoutEls.treeBody || layoutEls.treePane;
    if (layoutEls.searchClear) layoutEls.searchClear.hidden = !state.searchQuery;
    const scroll = body.scrollTop;
    if (state.searchQuery.trim()) {
      // 搜索结果接管树容器：先销毁树的虚拟列表（scroll 监听挂在 body 上，仅替换子节点清不掉）。
      destroyTreeView(body);
      renderSearchResults(body);
    } else {
      renderTreeView(body, {
        rootPath: state.rootPath,
        rootNodes: state.rootNodes,
        expanded: state.expanded,
        getSelected: () => state.selected,
        getGitStatusMap: () => state.gitStatusMap,
        canList: true,
        canRead: true,
        onToggleDir: toggleDir,
        onSelectFile: previewFile,
        onContextMenu: handleContextMenu,
        onOpenFileEdit: handleOpenFileEdit,
        onSelectionChange: handleTreeSelectionChange,
        onTreeKeyDown: handleTreeKeyDown,
        t,
      });
    }
    body.scrollTop = scroll;
  }

  // 局部：搜索结果列表（文件名 + 内容行匹配；点击打开并跳行）
  function renderSearchResults(parent: HTMLElement) {
    parent.replaceChildren();
    if (state.searching && !state.searchResults.length) {
      parent.appendChild(el("div", "sfe-empty", t("search.searching", "搜索中…")));
      return;
    }
    if (!state.searchResults.length) {
      parent.appendChild(el("div", "sfe-empty", t("search.noResults", "没有匹配结果")));
      return;
    }
    const count = el(
      "div",
      "sfe-search-count",
      t("search.resultCount", "{{count}} 个文件", { count: state.searchResults.length })
    );
    parent.appendChild(count);
    const list = el("div", "sfe-search-results");
    for (const result of state.searchResults) {
      const row = el("div", "sfe-search-result");
      row.title = result.path;
      row.dataset.path = result.path;
      const head = el("div", "sfe-search-result-head");
      const iconEl = createFileIconNode(result.name, !!result.isDirectory, false);
      head.appendChild(iconEl);
      const info = el("div", "sfe-search-result-info");
      info.appendChild(el("span", "sfe-search-result-name", result.name));
      info.appendChild(el("span", "sfe-search-result-path", result.relativePath || ""));
      head.appendChild(info);
      head.addEventListener("click", () => handleSearchResultOpen(result));
      row.appendChild(head);
      // 内容匹配行：点击直接跳转到对应行号。
      for (const match of result.lineMatches || []) {
        const lineEl = el("div", "sfe-search-result-line");
        lineEl.title = `${result.path}:${match.line}`;
        lineEl.appendChild(el("span", "sfe-search-line-no", String(match.line)));
        lineEl.appendChild(el("span", "sfe-search-line-text", match.text || ""));
        lineEl.addEventListener("click", () => handleSearchResultOpen(result, match.line));
        row.appendChild(lineEl);
      }
      list.appendChild(row);
    }
    parent.appendChild(list);
  }

  // 局部：普通文件预览
  function renderPreview() {
    if (disposed || !layoutEls || !layoutEls.previewPane) return;
    renderCodeViewer(layoutEls.previewPane, {
      preview: state.preview,
      rootPath: state.rootPath,
      copied: state.copied,
      onCopy: handleCopyCode,
      onSetMode: setPreviewMode,
      onToggleEdit: setPreviewEditable,
      onEditInput: handlePreviewInput,
      onSave: handleSavePreview,
      onRevealFile: handlePreviewRevealFile,
      onCopyPath: handlePreviewCopyPath,
      onCopyRelativePath: handlePreviewCopyRelativePath,
      onRefresh: handlePreviewRefresh,
      // 运行入口：代码查看器需要完整源码 main 列表，顶栏仍使用过滤后的可见命令列表。
      runCommands: () => flattenCommands(state.projectCommands, { includeHidden: true }),
      // 右键「运行」分组的上限：与顶栏下拉同一份列表，菜单不得多出顶栏没有的命令。
      runMenuCommands: () => mergeRunCommands(flattenCommands(state.projectCommands), state.manualScriptCommands),
      onRunCommand: handleRunCommand,
      editable: state.preview.editable === true,
      saving: state.preview.saveState === "saving",
      t,
    });
  }

  // Git 变更视图选项（提交框与列表共用）
  function gitViewOptions(): GitViewOptions {
    // 已暂存文件数：AI 生成与提交按钮的可用性依赖它
    const stagedCount = partitionGitFiles(state.gitStatus && state.gitStatus.files).staged.length;
    return {
      rootPath: state.rootPath,
      gitStatus: state.gitStatus,
      stagedCount,
      selected: state.gitSelected,
      commitMessage: state.gitCommitMessage,
      busy: state.gitBusy,
      generating: state.gitGenerating,
      commitMode: state.gitCommitMode,
      commitMenuOpen: state.gitCommitMenuOpen,
      // collapsedStaged 的初值是 null（表示「还没按首次仓库状态建默认折叠」），
      // 而 applyGitStatus 在有仓库状态时必先建表，renderGitPane 又只在有文件时才走折叠查询，
      // 故组件侧（flattenGitTree 直接 .has）拿到的必是 Set；null 这一态在类型上无法表达其时序保证。
      collapsedStaged: state.collapsedStaged!,
      collapsedUnstaged: state.collapsedUnstaged,
      // 单击仅更新选中态（就地改样式，不重建 DOM）
      onSelectFile: (file: GitFileStatus, section: GitSection) => {
        state.gitSelected = `${section}:${file.path}`;
      },
      // 单击文件夹行：同样记录选中态（与文件选中共用 gitSelected，天然互斥），
      // 使目录行的行内加号/减号常显，而非仅 hover 时可见。
      onSelectFolder: (node: GitTreeNode, section: GitSection) => {
        state.gitSelected = `${section}:${node.path}`;
      },
      onStageToggle: handleStageToggle,
      onStageAll: handleStageAll,
      onUnstageAll: handleUnstageAll,
      onDiscard: handleDiscard,
      onCommit: handleCommit,
      onCommitAndPush: handleCommitAndPush,
      onSetCommitMode: handleSetCommitMode,
      onToggleCommitMenu: () => {
        state.gitCommitMenuOpen = !state.gitCommitMenuOpen;
        renderGitPaneCommit();
      },
      onToggleCollapse: handleToggleGitCollapse,
      onGenerate: handleGenerateCommitMessage,
      // 输入只写回 state，不触发重建（重建会销毁节点、打断输入与光标）
      onCommitMessageInput: (value: string) => {
        state.gitCommitMessage = value;
      },
       // 单击文件行：右侧加载该文件的 Git 差异
       onOpenFile: openGitDiff,
       // 右键菜单复用普通文件树已有系统能力，不新增复制/移动等文件 API。
       onRevealFile: handleGitRevealFile,
       onCopyRelativePath: handleGitCopyRelativePath,
       onCopyAbsolutePath: handleGitCopyAbsolutePath,
       // 右键菜单「刷新」：只刷 Git 自己的东西（变更状态 + 当前差异），不触发全仓忽略规则重扫
       onRefresh: handleGitRefresh,
       t,
     };
   }

  // 局部：Git 提交框 + 变更列表
  function renderGitPane() {
    if (disposed || !layoutEls || !layoutEls.gitPane) return;
    const opts = gitViewOptions();
    renderGitCommitBar(layoutEls.gitPane, opts);
    renderGitList(layoutEls.gitPane, opts);
  }

  // 局部：仅 Git 提交框（busy / 生成态变化，列表不变）
  function renderGitPaneCommit() {
    if (disposed || !layoutEls || !layoutEls.gitPane) return;
    renderGitCommitBar(layoutEls.gitPane, gitViewOptions());
  }

  // 同步顶栏的 Git 同步指示器（文件夹名右侧的上下箭头，无数字）。
  // 控制器只创建一次并复用；骨架重建（wrap 变空）后自动重建。
  function syncGitIndicator() {
    if (disposed || !layoutEls || !layoutEls.syncIndicatorWrap) return;
    const wrap = layoutEls.syncIndicatorWrap;
    if (gitSyncIndicator && wrap.childElementCount > 0) {
      gitSyncIndicator.sync();
      return;
    }
    if (gitSyncIndicator && typeof gitSyncIndicator.dispose === "function") gitSyncIndicator.dispose();
    gitSyncIndicator = renderGitSyncIndicator(wrap, {
      t,
      getState: () => ({ gitStatus: state.gitStatus, gitBusy: state.gitBusy, gitSyncBusy: state.gitSyncBusy }),
      onSync: handleSync,
    });
  }

  // 局部：Git 右侧文件查看器（差异 / 内容）
  function renderGitPreview() {
    if (disposed || !layoutEls || !layoutEls.gitPreviewPane) return;
    const preview = gitPreviewView();
    // 有文件时提供文件操作（资源管理器 / 复制路径）；无文件（空态）时不注入，
    // 但保留 onRefresh —— 空态右键也能弹出「刷新」，刷新左侧变更列表与当前差异。
    const hasFile = preview && state.gitPreview;
    renderCodeViewer(layoutEls.gitPreviewPane, {
      preview,
      emptyHint: t("git.previewHint", "在左侧选择变更文件以查看差异。"),
      copied: state.copied,
      onCopy: handleCopyCode,
      onSetMode: setPreviewMode,
      onSetDiffMode: setDiffMode,
      onRefresh: handleGitPreviewRefresh,
      // 右侧差异查看器的右键菜单：与文件管理器预览区一致的文件操作（仅打开文件时注入）
      onRevealFile: hasFile ? handleGitPreviewRevealFile : undefined,
      onCopyPath: hasFile ? handleGitPreviewCopyPath : undefined,
      onCopyRelativePath: hasFile ? handleGitPreviewCopyRelativePath : undefined,
      t,
    });
    // 「差异 / 内容」切换位于工具栏，需随查看器同步（打开/切换文件、切换子视图）
    renderGitViewSwitchInToolbar();
  }

  // 局部：按当前视图刷新「正在使用的」查看器（复制按钮反馈用）
  function renderActiveViewer() {
    if (state.mainView === "git") renderGitPreview();
    else renderPreview();
  }


  // 8. 启动与初始化生命周期（先只铺骨架，数据到位后再 render 主视图，避免空态闪一屏再全量重建）
  renderChrome();

  // 拖宿主分栏 / 改窗口大小此前没有任何监听会经过 fitTerminalPanel，cols/rows 于是陈旧，
  // 输出按旧列数换行。只对当前可见的那个工具窗口重算（fitTerminalPanel 自己按 bottomView 选窗）。
  let terminalSizeObserver: ResizeObserver | null = null;
  let terminalSizeScheduled = false;
  // renderChrome 里的 ensureLayout 已把骨架写回 layoutEls（与 render() 里同一条例）。
  const dockEls = layoutEls!;
  if (typeof ResizeObserver === "function") {
    terminalSizeObserver = new ResizeObserver(() => {
      if (disposed || terminalSizeScheduled) return;
      terminalSizeScheduled = true;
      const run = () => {
        terminalSizeScheduled = false;
        if (!disposed) fitTerminalPanel();
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
      else setTimeout(run, 16);
    });
    if (dockEls.terminalWindowEl) terminalSizeObserver.observe(dockEls.terminalWindowEl);
    if (dockEls.runWindowEl) terminalSizeObserver.observe(dockEls.runWindowEl);
  }

  // 点击插件外部区域关闭三点菜单（capture 阶段，避免被内部 stopPropagation 拦截）
  // MouseEvent.target 在 DOM 类型里是 EventTarget，而 Node.contains 只收 Node；
  // click 事件的目标必是节点，故两处入参各做一次类型层断言。
  const closeMenuOnOutside = (e: MouseEvent) => {
    // 提交模式下拉：点击 split 区域外时关闭
    if (state.gitCommitMenuOpen) {
      const split = container.querySelector(".sfe-git-commit-split");
      if (split && !split.contains(e.target as Node | null)) {
        state.gitCommitMenuOpen = false;
        renderGitPaneCommit();
        return;
      }
    }
    if (state.contextMenu) {
      const contextMenu = container.querySelector(".sfe-context-menu");
      if (contextMenu && !contextMenu.contains(e.target as Node | null)) {
        closeContextMenu();
      }
    }
  };
  document.addEventListener("click", closeMenuOnOutside, true);

  const closeContextMenuOnEscape = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !state.contextMenu) return;
    e.preventDefault();
    closeContextMenu();
  };
  document.addEventListener("keydown", closeContextMenuOnEscape, true);

  // 宿主全屏态变化（用户点全屏按钮）时同步工具栏「差异 / 内容」切换的显隐。
  // MutationObserver / document.body 在真实宿主必然存在；此处做防御以兼容极简测试环境。
  let fullscreenObserver: MutationObserver | null = null;
  if (typeof MutationObserver === "function" && document.body) {
    let lastFullscreen = isRightPanelFullscreen();
    fullscreenObserver = new MutationObserver(() => {
      const now = isRightPanelFullscreen();
      if (now === lastFullscreen) return;
      lastFullscreen = now;
      // 右侧布局依赖全屏。用户退出全屏时终端回到底栏，避免和代码预览抢同一列。
      if (!now && state.toolDock === "right" && (state.bottomView === "run" || state.bottomView === "terminal")) {
        state.toolDock = "bottom";
        saveToolDock();
        applyToolDock();
        fitTerminalPanel();
      }
      renderGitViewSwitchInToolbar();
    });
    // 全屏类只可能落在这两个宿主元素自己身上，观察它们即可；观察 document.body+subtree
    // 会让宿主每一次 class 抖动（AI 流式渲染尤甚）都排一批回调给本插件。
    const fullscreenTargets = [
      document.querySelector(".right-panel"),
      document.querySelector(".app-shell"),
    ].filter((node): node is Element => !!node);
    if (fullscreenTargets.length) {
      for (const target of fullscreenTargets) {
        fullscreenObserver.observe(target, { attributes: true, attributeFilter: ["class"] });
      }
    } else {
      // 宿主标记结构变了（两个元素都不存在）：退回整文档观察，宁慢不误。
      fullscreenObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ["class"],
        subtree: true,
      });
    }
  }

  // 宿主 Tab 切换感知：当从宿主其他面板（如 Git、终端、代码库）切回当前文件浏览器时，
  // 宿主 .right-panel-tab-pane 获得 .active 类，此时必须执行刷新（重新拉取目录树与 Git 状态）
  let tabPaneObserver: MutationObserver | null = null;
  const tabPaneEl = typeof container.closest === "function" ? container.closest(".right-panel-tab-pane") : null;
  if (tabPaneEl && typeof MutationObserver === "function") {
    let wasActive = tabPaneEl.classList.contains("active");
    tabPaneObserver = new MutationObserver(() => {
      if (disposed) return;
      const isActiveNow = tabPaneEl.classList.contains("active");
      if (isActiveNow && !wasActive) {
        // 从其他面板切回文件浏览器：自动触发全量刷新
        void refreshGitAll();
      }
      wasActive = isActiveNow;
    });
    tabPaneObserver.observe(tabPaneEl, { attributes: true, attributeFilter: ["class"] });
  }

  // 宿主窗口切回感知（用户从外部应用切回 Snow App 时刷新）
  const handleWindowFocus = () => {
    if (disposed) return;
    if (!tabPaneEl || tabPaneEl.classList.contains("active")) {
      scheduleGitRefresh();
    }
  };
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("focus", handleWindowFocus);
  }

  let unsubGit: Unsubscribe | null = null;
  let unsubProjects: Unsubscribe | null = null;
  // 图标块挂载即并行发起：与首屏元数据 / 列目录并发，占位图标闪现窗口压缩到最小。
  // 首帧绘树前另有 120ms 的限时到账窗口（见 loadRoot）；到不齐时由 followups 就地回填，
  // 首屏不被 585KB 的块拖死。
  void ensureIcons();
  void (async () => {
    const [initialRoot, viewSettings, diffMode, commitMode, toolDock] = await Promise.all([
      resolveRoot(),
      loadViewSettings(api),
      loadDiffViewMode(api),
      (async () => {
        try {
          if (api.storage && typeof api.storage.getJson === "function") {
            return await api.storage.getJson<unknown>("gitCommitMode", null);
          }
        } catch {
          // 忽略读取失败，使用默认模式
        }
        return null;
      })(),
      (async () => {
        try {
          if (api.storage && typeof api.storage.getJson === "function") {
            return await api.storage.getJson<unknown>("toolDock", null);
          }
        } catch {
          // 忽略读取失败，默认底栏
        }
        return null;
      })(),
    ]);
    if (disposed) return;
    state.rootPath = initialRoot || "";
    state.viewSettings = viewSettings;
    if (commitMode === "commitAndPush") state.gitCommitMode = "commitAndPush";
    if (toolDock === "right") state.toolDock = "right";
    state.diffMode = diffMode;
    render();
    if (state.rootPath) {
      await loadRoot({ followups: true });
      if (disposed) return;
    }
    // 跟随宿主项目切换：订阅 projects 域（live），activeDirectory 变化时全量切换到新项目。
    // 与宿主「打开文件夹」按钮天然一致，插件不自建多开与目录选择。
    if (api && api.metadata && typeof api.metadata.subscribe === "function") {
      try {
        // 偏离（已登记）：宿主 subscribe 委派给 async 的 subscribeMetadata（snow-app
        // src/renderer/plugins/pluginApi.ts:199、src/renderer/plugins/metadata/index.ts:176），返回 Promise<MetadataSubscription>。
        // 原写法同步读 sub.unsubscribe 只会拿到 undefined，unsubProjects 恒为 null、
        // 卸载时这条订阅从不取消。subscribeMetadata 建好定时器后即返回（首次采集是 void emit()，
        // 不在返回链上），所以这里 await 只让出一个微任务，不会推迟后面的 git 订阅。
        const sub = await api.metadata.subscribe("projects", (response) => {
          if (disposed) return;
          const nextPath = resolveActiveDirectoryPath(response);
          if (pathKey(nextPath) === pathKey(state.rootPath)) return;
          void applyActiveProject(nextPath);
        });
        unsubProjects = sub && typeof sub.unsubscribe === "function" ? sub.unsubscribe : null;
      } catch (err) {
        console.warn("[FileExplorer] 订阅宿主项目变化失败", err);
      }
    }
    // 宿主 Git watcher 在文件变化时会高频触发（一次 checkout/写盘可能连续触发多次），
    // 因此必须做「路径过滤 + 防抖」，与宿主官方 useGitStatus 的处理保持一致，
    // 否则会不断重建整棵树，导致滚动位置与文本选区被反复打断。
    unsubGit = subscribeGitStatus((changedPath) => {
      if (
        changedPath &&
        state.rootPath &&
        changedPath !== state.rootPath &&
        !state.rootPath.startsWith(changedPath)
      ) {
        return;
      }
      scheduleGitRefresh(300);
    });
  })();

  return () => {
    disposed = true;
    // AI 生成提交信息是宿主里的流式任务；不中止它，卸载后宿主仍在往回调里灌分片。
    if (state.gitStreamId) abortCommitMessage(state.gitStreamId);
    if (copiedTimer) clearTimeout(copiedTimer);
    if (operationTimer) clearTimeout(operationTimer);
    if (gitDebounceTimer) clearTimeout(gitDebounceTimer);
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    if (typeof unsubGit === "function") unsubGit();
    if (typeof unsubProjects === "function") unsubProjects();
    stopDirectoryWatch();
    if (runToolbar && typeof runToolbar.dispose === "function") runToolbar.dispose();
    runToolbar = null;
    if (gitSyncIndicator && typeof gitSyncIndicator.dispose === "function") gitSyncIndicator.dispose();
    gitSyncIndicator = null;
    if (terminalWindow && typeof terminalWindow.dispose === "function") terminalWindow.dispose();
    terminalWindow = null;
    if (runWindow && typeof runWindow.dispose === "function") runWindow.dispose();
    runWindow = null;
    if (fullscreenObserver) fullscreenObserver.disconnect();
    if (terminalSizeObserver) {
      terminalSizeObserver.disconnect();
      terminalSizeObserver = null;
    }
    if (tabPaneObserver) tabPaneObserver.disconnect();
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("focus", handleWindowFocus);
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("click", closeMenuOnOutside, true);
      document.removeEventListener("keydown", closeContextMenuOnEscape, true);
    }
    state.contextMenu = null;
    state.operationBusy = false;
    // 卸载：终止仍在运行的全部终端进程，避免留下孤儿进程。
    killAllTerminals();
    closeGitContextMenu(layoutEls && layoutEls.gitPane);
    // 查看器的虚拟列表与视口观察器挂在面板上：面板即将随容器一起摘掉，
    // 不断开就会拖住整块可视行与闭包里的全文（宿主多次重载插件时线性累积）。
    disposeViewerViewport(layoutEls && layoutEls.previewPane);
    disposeViewerViewport(layoutEls && layoutEls.gitPreviewPane);
    // 随懒块注入的样式随插件一起摘除，不在宿主 head 里留残留（重挂载时 loadChunk 会重新注入）。
    releaseChunkStyles();
    container.replaceChildren();
  };
}

// 默认导出与命名导出双重兼容
export default { mount };
