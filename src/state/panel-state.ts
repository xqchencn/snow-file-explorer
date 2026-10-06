/**
 * 面板状态模块 (src/state/panel-state.ts)
 * @description index.ts mount 闭包里的私有类型与初始状态，独立成单一真源：
 *   控制器（src/controllers/*）与渲染层都从这里取类型，避免再互相 import 对方内部形状。
 *   本模块只放类型与纯工厂，不含任何行为。
 */

import type { FileSearchResult } from "../types/host/host-workspace.ts";
import type { GitStatusResult } from "../types/host/host-git.ts";
import type { FileTreeEntry, JvmProjectDetection } from "../services/file-service.ts";
import type { GitStatusMap } from "../services/git-service.ts";
import type { GitignoreRule } from "../services/file-filter.ts";
import type { HttpRestFile } from "../services/http-file-scan.ts";
import type { HttpParsedFile } from "../services/http-request-parser.ts";
import type { HttpRunResult } from "../services/http-runner.ts";
import type { HttpFormValues } from "../services/http-serialize.ts";
import type { ViewSettings } from "../services/settings.ts";
import type { ProjectCommandsResult, FlatRunCommand } from "../services/project-commands.ts";
import type { PtySessionResult } from "../services/terminal-runner.ts";
import type {
  CodePreviewState,
  CodeTextPreview,
  CodePreviewDiff,
  GitViewerMode,
} from "../components/code-viewer.ts";
import type { ToolWindowMode, ToolWindowDock } from "../components/tool-window.ts";
import type { GitCommitMode, GitSection } from "../components/git-view.ts";
import type { GitOperation, DiffViewMode, HttpViewerMode } from "../types/panel-state.ts";
import { normalizePath } from "../services/markdown-asset.ts";

/**
 * 当前面板根目录的规范化键（小写 + 去尾部分隔符）
 * @description 宿主在 Windows 可能返回反斜杠路径，比较前统一大小写与分隔符。
 * @param p 路径；`data-*` 之类属性可能缺省（DOMStringMap 的索引类型是 `string | undefined`），
 *   实现按假值兜成空串，故接受 undefined。
 * @returns {string}
 */
export function pathKey(p: string | undefined): string {
  return normalizePath(p || "").toLowerCase().replace(/[/\\]+$/, "");
}

/**
 * 一个终端 / 运行 tab 的记录（`state.terminals` 的元素）。
 * @description 组件层经 ToolWindowTerminal 只读其中一部分；pty 会话、阶段令牌与防抖定时器
 *   只有终端控制器用，故不写进组件层类型。
 */
export type TerminalTab = {
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
  /** 最近一次 fit 出来的尺寸，但当时还没有 pty session 可发；session 建好后补发一次，发完置 null。 */
  pendingResize?: { cols: number; rows: number } | null;
  /** 所属项目展示名；仅 syncRetainedRuns 给模式 A 写入，交互终端可缺。 */
  projectLabel?: string;
  /** 是否属于其他项目且未打开「显示其他项目任务」开关；可缺，true 时不画 tab。 */
  hiddenRun?: boolean;
  /** onResize 的 120ms 尾沿防抖定时器；未排程时为 null，创建前可缺。 */
  resizeTimer?: ReturnType<typeof setTimeout> | null;
  /** 「命令尚未敲入」的 800ms 兜底定时器；未排程时为 null，创建前可缺。 */
  commandTimer?: ReturnType<typeof setTimeout> | null;
};

/**
 * handleNewTerminal 的入参（也接受命令原文字符串，内部先归一成本类型）。
 * @description 全部可缺：模式 B 只带 cwd/mode，模式 A 带 command/commandId/title/scriptPath。
 */
export type NewTerminalOptions = {
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
 * 代码预览状态：组件层的可辨联合 `CodePreviewState`，叠加预览侧自用的两个缺口。
 * @description ① `editable` 是内联编辑开关，只由预览控制器读写，
 *   code-viewer 把它当作 CodeViewerOptions 的独立入参、没有放进预览联合；
 *   ② 控制器多处不先判 `kind` 就读写 `text` / `html` / `mode` / `saveState`，
 *   故把这些文本类字段按 `Partial` 交叉进来，让它们在每个 kind 分支上都可见。
 *   可辨性仍由 `kind` 保持，判过 kind 后照旧收窄。
 */
export type PanelPreviewState = CodePreviewState &
  Partial<Omit<CodeTextPreview, "kind">> & {
    /** 预览区是否处于内联编辑态；初值 false，切换文件与保存后重置。 */
    editable?: boolean;
  };

/**
 * Git 变更视图右侧文件查看器的状态（`state.gitPreview`）。
 * @description 由 openGitDiff 建立，之后各处只做「展开 + 覆盖单个字段」的不可变更新。
 */
export type GitPreviewState = {
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
export type ContextMenuState = {
  /** 菜单目标条目；空白区右键时为 null。 */
  entry: FileTreeEntry | null;
  /**
   * HTTP 请求文件行右键时的目标。
   * @description 请求文件不在文件树里（树只列工作区真实目录树，扫描结果另有一份），
   *   菜单项也不能复用「打开文件」那条分支——那会在文件视图里打开它，与当前主视图对不上。
   */
  httpFile?: HttpRestFile | null;
  /** 菜单左上角视口 x 坐标（clientX）。 */
  x: number;
  /** 菜单左上角视口 y 坐标（clientY）。 */
  y: number;
  /** 是否处于内联重命名输入态；只由 beginRename 置 true，重渲染时保留。 */
  renaming?: boolean;
};

/**
 * 插件内确认弹窗的状态（`state.confirmDialog`）。
 * @description 由 openConfirmDialog 建立；同时只允许一个，故存在即代表弹窗打开。
 */
export type ConfirmDialogState = {
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
  /**
   * 取消 / 关闭（取消按钮、遮罩点击、Escape）时的回调。
   * @description 「问一句再继续」的流程要能被 await，就得在取消这条路上也给出答复，
   *   否则等待方永远悬着，后续动作既不执行也不收场。
   */
  onCancel?: () => void;
};

/**
 * 一次 Git 写操作在串行队列里的槽位（gitActionQueue 的元素）。
 * @description busy 只用于按钮忙碌态文案与互斥，fn 才是真正的写操作。
 */
export type GitActionQueueItem = {
  /** 进行中的操作名，写入 state.gitBusy；取值出处 GitOperation。 */
  busy: GitOperation;
  /** 实际写操作（内部自行 refresh），由 drainGitActions 串行 await。 */
  fn: () => Promise<void>;
};

/** loadGitPreviewDiff 的入参（拉取单个文件的差异与工作区全文）。 */
export type LoadGitPreviewDiffArgs = {
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

/** 单个文件的预览上限（字节）：宿主 readFileContent 不接受长度参数，超限直接拒绝预览。 */
export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;

/**
 * 骨架 DOM 引用集合（layoutEls）。
 * @description ensureLayout 只建一次；treePane/previewPane/gitPane/gitPreviewPane/httpPane/httpPreviewPane
 *   随主视图重建后置 null 再回填；treeBody/searchInput/searchClear 只有对应视图构建后才存在。
 */
export type LayoutEls = {
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
  /** 「HTTP 请求」主视图按钮；可缺。 */
  httpViewBtn?: HTMLButtonElement;
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
  /** HTTP 请求文件列表面板；未构建 HTTP 视图时为 null。 */
  httpPane: HTMLElement | null;
  /** HTTP 右侧查看器面板；未构建 HTTP 视图时为 null。 */
  httpPreviewPane: HTMLElement | null;
  /** 文件树滚动容器，仅文件视图存在。 */
  treeBody?: HTMLElement | null;
  /** 搜索输入框，仅文件视图存在。 */
  searchInput?: HTMLInputElement | null;
  /** 搜索清除按钮，仅文件视图存在。 */
  searchClear?: HTMLButtonElement | null;
};

/**
 * 面板状态对象（`state`）的完整形状。
 * @description 字段初值集中在 createPanelState；每个字段的可缺性与取值出处见逐条注释。
 *   以 null 初始化的字段必须在此显式给出真类型，否则 TS 会把它们推成 null 类型，
 *   后续每次赋值都报错。
 */
export type PanelState = {
  /** 当前工作区根目录绝对路径；未取到宿主激活项目时为 ""。 */
  rootPath: string;
  /** 根目录已排序、已过滤的树节点；null 表示尚未加载或已切换项目。 */
  rootNodes: FileTreeEntry[] | null;
  /** JVM 项目识别结论；null 表示未识别或已切换项目。 */
  javaProject: JvmProjectDetection | null;
  /** 项目运行命令识别结果（含 rootPath 缓存键）；null 表示尚未扫描。 */
  projectCommands: ProjectCommandsResult | null;
  /** 用户手动点过文件行内 ▶ 的脚本命令，临时并入顶栏 Run 下拉；切换项目清空。 */
  manualScriptCommands: FlatRunCommand[];
  /** 终端集合（IDEA 式多 tab，两种模式混存、按 mode 分给对应窗口）。 */
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
  /** 主视图三选一：files 文件树 / git 变更列表 / http 请求文件列表。 */
  mainView: "files" | "git" | "http";
  /** 目录展开态表，键为绝对路径；初值与切换项目、切包视图时重置为空表。 */
  expanded: Record<string, boolean>;
  /** 文件树选中集合（多选，绝对路径）；空集表示无选中。 */
  selected: Set<string>;
  /** shift 范围选择的锚点路径（最近一次普通/ctrl 点击）；无锚点为 null。 */
  selectionAnchor: string | null;
  /** 文件搜索查询词；空串表示不在搜索态。 */
  searchQuery: string;
  /** 宿主 searchFiles 的结果（已按视图开关过滤）。 */
  searchResults: FileSearchResult[];
  /** 搜索是否进行中。 */
  searching: boolean;
  /** 搜索结果点击「跳行」的目标行号（1 基，一次性消费后回 null）。 */
  pendingRevealLine: number | null;
  /** 工具栏状态条文本（操作成功/失败或加载提示）；空串表示不显示。 */
  status: string;
  /** 是否刚复制过代码（驱动复制按钮反馈，1600ms 后回 false）。 */
  copied: boolean;
  /** 文件树染色用的 Git 状态表，键为仓库相对路径（正斜杠）。 */
  gitStatusMap: GitStatusMap;
  /** 视图开关（排除元数据 / 按 .gitignore 过滤 / JVM 包视图）。 */
  viewSettings: ViewSettings;
  /** 递归收集的 .gitignore 规则。 */
  gitignoreRules: GitignoreRule[];
  /** 是否已全仓扫过一遍 .gitignore（显式刷新置 true，切项目回 false）。 */
  gitignoreFullyLoaded: boolean;
  /** 已补读过 .gitignore 的目录键（pathKey 归一），避免重复读盘。 */
  gitignoreLoadedDirs: Set<string>;
  /** 「HTTP 请求」主视图扫描到的请求文件清单（按相对路径升序）；空数组表示还没扫或确实没有。 */
  httpFiles: HttpRestFile[];
  /** HTTP 请求文件扫描是否进行中；用于列表进行态文案与重复触发去抖。 */
  httpScanning: boolean;
  /** 最近一次 HTTP 扫描是否因目录预算触顶而未扫完；true 时列表要说明结果不完整。 */
  httpTruncated: boolean;
  /** 最近一次 HTTP 扫描里列目录失败的目录数；>0 时列表要说明结果不完整。 */
  httpScanFailed: number;
  /** HTTP 视图折叠中的目录相对路径集合；不在集合内的目录默认展开。 */
  httpCollapsed: Set<string>;
  /** HTTP 视图当前打开的请求文件绝对路径；未打开为 null。 */
  httpSelected: string | null;
  /** HTTP 右侧查看器的形态：GUI 表单或文本；偏好经 settings 持久化。 */
  httpMode: HttpViewerMode;
  /** 当前打开文件的解析结果；与 httpSelected 同一次读取的产物，未打开为 null。 */
  httpFile: HttpParsedFile | null;
  /** GUI 表单的当前值，键为请求下标；换文件时整体重建。 */
  httpForms: Map<number, HttpFormValues>;
  /** 每条请求最近一次的执行结果，键为请求下标；换文件时清空。 */
  httpResponses: Map<number, HttpRunResult>;
  /** 正在发送的请求下标；空闲为 null（同一时刻只发一条，避免变量互相踩）。 */
  httpRunning: number | null;
  /** 文本态右分栏显示的是哪一条请求的结果（最近一次发送的那条）；没发过为 null。 */
  httpResultIndex: number | null;
  /** `# @prompt` 由用户填进来的值，键为 `` `${请求下标}:${变量名}` ``。 */
  httpPrompts: Map<string, string>;
  /** 展开的卡片 / 文本块键（请求块 `r<下标>`，其余 `o<下标>`）；默认空集即全部折叠，换文件时清空。 */
  httpExpanded: Set<string>;
  /**
   * 「请求构建区（请求头 / 提示变量 / 请求体）已收起」的请求下标集合。
   * @description 构建区的开合由「这条请求发过没有」派生，不靠一个全局开关记：
   *   没发过的请求默认摊开供编辑；发过响应的请求默认收起、把结果让到眼前。
   *   本集合只记「用户手动收起过」这一种偏离（发送完成也会自动计入），
   *   因此折叠卡片再展开、切来切去，看到的都是该请求此刻该有的默认态，不会被别的请求带偏。
   */
  httpBodyCollapsed: Set<number>;
  /** HTTP 正文缓冲里有还没写盘的改动；写盘成功由保存通道清掉。 */
  httpDirty: boolean;
  /** 右键菜单状态；null 表示未打开。 */
  contextMenu: ContextMenuState | null;
  /** 确认弹窗状态；null 表示未打开。 */
  confirmDialog: ConfirmDialogState | null;
  /** 是否有文件写操作进行中（期间禁用右键菜单与删除）。 */
  operationBusy: boolean;
  /** 最近一次宿主 gitStatus 快照；null 表示未加载、非仓库或已切换项目。 */
  gitStatus: GitStatusResult | null;
  /** 提交信息草稿；提交成功与切换项目时清空。 */
  gitCommitMessage: string;
  /** Git 写操作队列当前执行中的动作；空闲为 null。 */
  gitBusy: GitOperation | null;
  /** 顶栏「同步」（先 pull 后 push）整链路的进行态；与 gitBusy 分开，空闲为 null。 */
  gitSyncBusy: GitOperation | null;
  /** 是否正在由 AI 生成提交信息（输入框只读、按钮转「停止」）。 */
  gitGenerating: boolean;
  /** 宿主生成提交信息的流 id，用于中止；未在生成时为 null。 */
  gitStreamId: string | null;
  /** Git 变更列表当前选中键 `` `${section}:${path}` ``；未选中为 null。 */
  gitSelected: string | null;
  /** Git 右侧文件查看器状态；null 表示未打开差异文件。 */
  gitPreview: GitPreviewState | null;
  /** 差异展示模式（unified 行内 / split 分栏）；与 settings.ts 的持久化开关同一真源。 */
  diffMode: DiffViewMode;
  /** 提交按钮模式（提交 / 提交并推送）。 */
  gitCommitMode: GitCommitMode;
  /** 提交模式下拉是否展开。 */
  gitCommitMenuOpen: boolean;
  /** 已暂存区折叠的目录相对路径集合；null 表示尚未按首次仓库状态初始化默认折叠。 */
  collapsedStaged: Set<string> | null;
  /** 变更区折叠的目录相对路径集合（用户自己的折叠操作，不随 watcher 覆盖）。 */
  collapsedUnstaged: Set<string>;
  /** 右侧代码预览状态（可辨联合，见 PanelPreviewState）。 */
  preview: PanelPreviewState;
};

/**
 * 构造面板状态的初始值。
 * @description 与原 index.ts 内联字面量逐字段一致；viewSettings / diffMode 等
 *   持久化偏好由启动流程读回后覆盖。
 */
export function createPanelState(): PanelState {
  return {
    rootPath: "",
    rootNodes: null,
    javaProject: null,
    projectCommands: null,
    manualScriptCommands: [],
    terminals: [],
    activeTerminalId: null,
    activeRunTerminalId: null,
    bottomView: null,
    showOtherProjectRuns: false,
    toolDock: "bottom",
    mainView: "files",
    expanded: Object.create(null),
    selected: new Set(),
    selectionAnchor: null,
    searchQuery: "",
    searchResults: [],
    searching: false,
    pendingRevealLine: null,
    status: "",
    copied: false,
    gitStatusMap: Object.create(null),
    viewSettings: {
      excludeMeta: true,
      respectGitignore: true,
      javaPackageView: true,
    },
    gitignoreRules: [],
    gitignoreFullyLoaded: false,
    gitignoreLoadedDirs: new Set(),
    httpFiles: [],
    httpScanning: false,
    httpTruncated: false,
    httpScanFailed: 0,
    httpCollapsed: new Set(),
    httpSelected: null,
    httpMode: "gui",
    httpFile: null,
    httpForms: new Map(),
    httpResponses: new Map(),
    httpRunning: null,
    httpResultIndex: null,
    httpPrompts: new Map(),
    httpExpanded: new Set(),
    httpBodyCollapsed: new Set(),
    httpDirty: false,
    contextMenu: null,
    confirmDialog: null,
    operationBusy: false,
    gitStatus: null,
    gitCommitMessage: "",
    gitBusy: null,
    gitSyncBusy: null,
    gitGenerating: false,
    gitStreamId: null,
    gitSelected: null,
    gitPreview: null,
    diffMode: "unified",
    gitCommitMode: "commit",
    gitCommitMenuOpen: false,
    collapsedStaged: null,
    collapsedUnstaged: new Set(),
    preview: {
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
    },
  };
}
