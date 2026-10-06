/**
 * 代码预览组件模块 (src/components/code-viewer.ts)
 * 渲染对标 Snow App 官方 FileViewerContent 组件规范：行号槽、悬浮复制代码按钮、图片展示与异常提示；
 * 额外按 gitView 渲染 Git 变更文件的差异视图（「差异/内容」切换控件在工具栏，见 index.js；
 * 差异视图见 components/diff-view.js）。
 */

import { el, escapeHtml, copyToClipboard } from "../utils/dom.ts";
import { MAX_HIGHLIGHT_LINE_LEN, shouldHighlight, shouldVirtualize } from "./highlight-policy.ts";
import { ensureHighlighter, highlighterReady, highlightCodeHtml } from "./highlight-client.ts";
import { createVirtualList } from "./virtual-list.ts";
import { createActionIcon } from "../icons/action-icons.ts";
import { resolveMarkdownAssetPath, resolveProxiedImageSrc } from "../services/markdown-asset.ts";
import { extname, relativePath } from "../services/file-service.ts";
import { renderDiffView } from "./diff-view.ts";
import type { DiffViewMode, TranslateFn } from "../types/panel-state.ts";
import type { UnifiedDiffResult } from "../services/diff.ts";
import type { FlatRunCommand } from "../services/project-commands.ts";
import { isPackageManifestFile } from "../services/project-commands.ts";
import { findScriptLines } from "../services/package-scripts.ts";

const VIEWER_CONTEXT_MENU_BINDING = "__sfeViewerContextMenuBinding";
const VIEWER_CONTEXT_MENU_CLEANUP = "__sfeViewerContextMenuCleanup";

declare global {
  interface HTMLElement {
    /** 预览容器上的右键菜单绑定解绑句柄；重绘前调用，避免 contextmenu 监听逐次累积。 */
    __sfeViewerContextMenuBinding?: () => void;
    /** 预览容器上「当前已弹出菜单」的清理句柄；菜单关闭或容器重绘时调用。 */
    __sfeViewerContextMenuCleanup?: () => void;
  }
}

/**
 * 预览内容类别。
 * @description 取值出处是 `src/index.ts` 的 `state.preview` 与 `buildFilePreview()`：
 *   empty 未选中文件、loading 正在读取、error 读取失败、text 文本/代码、image 图片、binary 二进制。
 */
export type CodePreviewKind = "empty" | "loading" | "error" | "text" | "image" | "binary";

/** Markdown 的展示模式：渲染正文或显示源码；出处 index.js 的 setPreviewMode。 */
export type CodePreviewMode = "preview" | "code";

/** 文本保存状态；出处 index.js 的 handleSavePreview / setPreviewEditable / handlePreviewInput。 */
export type CodePreviewSaveState = "idle" | "saving" | "saved" | "failed";

/** Git 右侧查看器的子视图（差异 / 内容）；出处 index.js 的 setGitPreviewMode。 */
export type GitViewerMode = "diff" | "content";

/** Git 差异切片：index.js 的 `state.gitPreview.diff` 原样透传到预览对象上。 */
export type CodePreviewDiff = {
  /** parseUnifiedDiff 的解析结果；差异尚未取到时为 null（加载态写死 null）。 */
  result: UnifiedDiffResult | null;
  /** 新版本完整文件文本，用于把 hunk 之外的行补成全文差异；读不到文件时为 null，加载态整字段可缺。 */
  fullContent?: string | null;
  /** 差异是否正在拉取；可缺，加载态为 true。 */
  loading?: boolean;
  /** 差异读取失败文案；空串表示无错误，取值来自 t("git.diffUnavailable") 或宿主返回的 error。 */
  error?: string;
};

/** 所有预览态共用的字段（index.js 每个 `state.preview` 赋值都带齐这三项）。 */
type CodePreviewCommon = {
  /** 预览类别，决定本对象额外携带哪一组字段。 */
  kind: CodePreviewKind;
  /** 文件名（不含路径），用于「扩展名 → Prism 语言」映射与空态/图片文案。 */
  name: string;
  /** 文件绝对路径；空态为 ""，其余来自宿主条目或 Git 的 absPath。 */
  path: string;
  /** Git 差异切片；只有 Git 右侧查看器（index.js 的 gitPreviewView）注入，普通文件预览可缺。 */
  diff?: CodePreviewDiff;
  /** Git 子视图（差异 / 内容）；来自 `state.gitPreview.mode`，非 Git 预览可缺。 */
  gitView?: GitViewerMode;
  /** 差异展示模式（统一 / 分栏）；来自 settings 持久化的 `state.diffMode`，非 Git 预览可缺。 */
  diffMode?: DiffViewMode;
};

/** 文本类预览（text / empty）共用的渲染字段。 */
type CodePreviewTextBody = {
  /** 文件全文；buildFilePreview 写宿主内容，空态写 ""。 */
  text: string;
  /** 调用方预计算（或单测注入）的高亮 HTML；为空串时由本组件现算，可缺。 */
  highlightedHtml?: string;
  /** 是否 Markdown 路径；出处 services/markdown-asset.ts 的 isMarkdownPath，可缺按 false。 */
  isMarkdown?: boolean;
  /** Markdown 的预览/代码模式；非 Markdown 不参与渲染，可缺。 */
  mode?: CodePreviewMode;
  /** 已净化的 Markdown HTML（见 components/markdown-renderer.js）；尚未块加载时为 ""，可缺。 */
  html?: string;
  /** 保存状态；仅文本预览携带，index.js 初始与切换文件时重置为 idle。 */
  saveState?: CodePreviewSaveState;
  /** 保存失败原因文案；空闲/成功时为 ""，可缺。 */
  saveMessage?: string;
};

/** 文本 / 代码 / Markdown 预览（kind 为 text）。 */
export type CodeTextPreview = CodePreviewCommon & CodePreviewTextBody & { kind: "text" };

/** 未选中文件的空态（kind 为 empty）；index.js 初始化与切换工作区时构造。 */
export type CodeEmptyPreview = CodePreviewCommon & CodePreviewTextBody & { kind: "empty" };

/** 读取中占位（kind 为 loading），只带共用字段。 */
export type CodeLoadingPreview = CodePreviewCommon & { kind: "loading" };

/** 读取失败（kind 为 error）。 */
export type CodeErrorPreview = CodePreviewCommon & {
  /** 恒为 error；按其收窄后可读取 message。 */
  kind: "error";
  /** 失败原因：宿主未开放文件接口的文案，或异常对象的 message。 */
  message: string;
};

/** 图片预览（kind 为 image）；index.js 把宿主 base64 组装成 data URL。 */
export type CodeImagePreview = CodePreviewCommon & {
  /** 恒为 image；按其收窄后可读取 url。 */
  kind: "image";
  /** 直接赋给 `<img src>` 的地址（`data:<mime>;base64,` 形态）。 */
  url: string;
};

/** 二进制预览（kind 为 binary）；只显示提示文案，不渲染内容。 */
export type CodeBinaryPreview = CodePreviewCommon & {
  /** 恒为 binary；按其收窄后可读取 mime。 */
  kind: "binary";
  /** 宿主返回的 MIME，用于「二进制文件（{{mime}}）」插值；缺省时 index.js 写 application/octet-stream。 */
  mime: string;
};

/** 代码预览面板消费的预览状态（index.js 的 `state.preview` 与 `gitPreviewView()` 结果）。 */
export type CodePreviewState =
  | CodeTextPreview
  | CodeEmptyPreview
  | CodeLoadingPreview
  | CodeErrorPreview
  | CodeImagePreview
  | CodeBinaryPreview;

/** 文本预览命中运行入口的行号映射：1 基行号 → 该行的可运行命令。 */
export type RunLineMap = Map<number, FlatRunCommand>;

/** Markdown 工具栏分段控件的一项（「预览 / 代码」切换按钮的数据）。 */
type ModeSegment = {
  /** 点击后要切换到的模式；取值出处 CodePreviewMode。 */
  key: CodePreviewMode;
  /** 按钮图标名；取值出处 icons/action-icons.ts 的 lucide 图标 key。 */
  icon: string;
  /** 按钮标题与文案，已由 t 翻译，故无缺省。 */
  label: string;
};

/** 右键菜单读取的文本选区。 */
export type ViewerSelection = {
  /** 选中文本；编辑态取 textarea 选区切片，只读态取 window.getSelection 的字符串。 */
  text: string;
  /** 选区所属编辑框；只读态（目标不是 TEXTAREA）为 null。 */
  target: HTMLTextAreaElement | null;
  /** 选区起点（0 基）；只读态恒为 0。 */
  start: number;
  /** 选区终点（0 基，不含）；只读态恒为 0。 */
  end: number;
};

/** bindViewerContextMenu / openViewerContextMenu 消费的菜单动作集合。 */
export type ViewerContextMenuOptions = {
  /** 当前预览状态；菜单据此判定「运行」分组资格（清单文件 / 有行内 ▶ 的文件才可运行）。可缺按无文件处理。 */
  preview?: CodePreviewState | null;
  /** 工作区根目录绝对路径，用于把预览文件对应到命令所属包；缺省时按根目录处理。 */
  rootPath?: string;
  /** 是否处于编辑态；true 时禁用「刷新」并启用剪切/粘贴。可缺按非编辑处理。 */
  editable?: boolean;
  /** 编辑文本变化回调 (value)；随选项一并透传，菜单不读取（textarea 的 input 事件直接触发）。可缺。 */
  onEditInput?: (value: string) => void;
  /** 重新读取当前文件回调；缺省不渲染「刷新」项。 */
  onRefresh?: () => void;
  /** 在资源管理器中打开当前文件回调；缺省不渲染该项。 */
  onRevealFile?: () => void;
  /** 复制当前文件绝对路径回调；缺省不渲染该项。 */
  onCopyPath?: () => void;
  /** 复制当前文件相对路径回调；缺省不渲染该项。 */
  onCopyRelativePath?: () => void;
  /** 读取扁平运行命令列表；与 onRunCommand 同时具备才出现「运行」分组。 */
  runCommands?: () => FlatRunCommand[];
  /** 顶栏运行下拉的同源列表（可见命令 + 手动运行过的脚本）；右键运行项不得超过它。缺省时退回 runCommands。 */
  runMenuCommands?: () => FlatRunCommand[];
  /** 运行命令回调 (command)。 */
  onRunCommand?: (command: FlatRunCommand) => void;
  /** 国际化翻译函数。 */
  t: TranslateFn;
};

/** renderCodeViewer 的选项对象（第二参数）。 */
export type CodeViewerOptions = {
  /** 预览状态对象；null 表示未选中文件（Git 右侧查看器无变更文件时即为 null），渲染空态。 */
  preview: CodePreviewState | null;
  /** 工作区根目录绝对路径，用于匹配 package.json 所属包；缺省时按根目录 package.json 处理。 */
  rootPath?: string;
  /** 是否刚点击过复制按钮（来自 index.js 的 state.copied），用于按钮短暂显示「已复制」。 */
  copied: boolean;
  /** 点击复制代码回调；缺省时按钮不响应。 */
  onCopy?: () => void;
  /** 切换 Markdown 预览/代码模式回调 (mode)。 */
  onSetMode?: (mode: CodePreviewMode) => void;
  /** 切换差异展示模式回调 (mode)。 */
  onSetDiffMode?: (mode: DiffViewMode) => void;
  /** 切换只读/编辑状态回调 (next)。缺省时文本预览不提供编辑入口。 */
  onToggleEdit?: (next: boolean) => void;
  /** 编辑文本变化回调 (value)。 */
  onEditInput?: (value: string) => void;
  /** 保存当前文本回调；缺省时编辑态不渲染保存按钮。 */
  onSave?: () => void;
  /** 在资源管理器中打开当前文件回调。 */
  onRevealFile?: () => void;
  /** 复制当前文件绝对路径回调。 */
  onCopyPath?: () => void;
  /** 复制当前文件相对路径回调。 */
  onCopyRelativePath?: () => void;
  /** 重新读取当前文件回调（仅只读态显示，编辑态不显示）。 */
  onRefresh?: () => void;
  /** 读取扁平运行命令列表（含隐藏命令），供行内 ▶ 与右键「运行」分组匹配。 */
  runCommands?: () => FlatRunCommand[];
  /** 顶栏运行下拉的同源列表；右键「运行」分组在清单文件上只取该列表里属于本包的命令。缺省时退回 runCommands。 */
  runMenuCommands?: () => FlatRunCommand[];
  /** 运行命令回调 (command)。 */
  onRunCommand?: (command: FlatRunCommand) => void;
  /** 当前是否处于编辑状态；出处 index.js 的 `state.preview.editable`，默认 false。 */
  editable?: boolean;
  /** 是否正在保存；出处 index.js 的 `state.preview.saveState === "saving"`，默认 false。 */
  saving?: boolean;
  /** 无文件时空态提示文案（默认 t("preview.hint")）；Git 右侧查看器传入「选择左侧变更文件查看差异」。 */
  emptyHint?: string;
  /** 本地化翻译函数。 */
  t: TranslateFn;
};

/**
 * 构造行内「运行」按钮（对标 IDEA editor gutter 的 npm script 运行图标）。
 * @param command 命令对象（id / cmd / labelFallback 等，见 FlatRunCommand）
 * @param onRunCommand 运行回调 (command) => void
 * @param t 翻译函数
 * @returns 行内运行按钮
 */
function createGutterRunButton(
  command: FlatRunCommand,
  onRunCommand: ((command: FlatRunCommand) => void) | undefined,
  t: TranslateFn,
): HTMLButtonElement {
  const btn = el("button", "sfe-file-viewer-gutter-run");
  btn.type = "button";
  btn.title = `${t("run.gutterRun", "运行")}: ${command.cmd || command.labelFallback || ""}`;
  btn.setAttribute("aria-label", btn.title);
  btn.appendChild(createActionIcon("play", 14));
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (typeof onRunCommand === "function") onRunCommand(command);
  });
  return btn;
}

/**
 * 规范化「相对工作区的包目录」：POSIX 分隔符、去首 `./` 与尾 `/`、转小写；根目录为 `""`。
 * @param dir 包目录（可能是 Windows 分隔符或带前导 `./`）
 * @returns 可直接比较的目录键
 */
function normalizePackageDir(dir: string | null | undefined): string {
  return String(dir || "").replace(/\\/g, "/").replace(/^\.\/+|\/+$/g, "").toLowerCase();
}

/**
 * 命令所属包目录（`dir` 缺省时退回分组标签 `group`）。
 * @param command 扁平命令
 * @returns 规范化后的目录键
 */
function commandPackageDir(command: FlatRunCommand): string {
  return normalizePackageDir(typeof command?.dir === "string" ? command.dir : command?.group || "");
}

/**
 * 取预览文件所在的包目录（相对工作区，根目录为 `""`）。
 * @description preview.path 是绝对路径、命令 dir 是相对路径，必须先用路径服务转换再比较。
 * @param preview 预览状态
 * @param rootPath 工作区根目录绝对路径
 * @returns 规范化后的目录键
 */
function previewFileDir(preview: CodePreviewState, rootPath: string | undefined): string {
  if (!rootPath) return "";
  const rel = String(relativePath(rootPath, preview.path) || "").replace(/\\/g, "/");
  const slash = rel.lastIndexOf("/");
  return slash < 0 ? "" : normalizePackageDir(rel.slice(0, slash));
}

/**
 * 过滤出属于某个包目录的命令（即「这个包」的可运行命令）。
 * @param commands 扁平命令列表
 * @param dir 目标包目录键
 * @returns 该包目录下的命令，保持入参顺序
 */
function commandsInPackageDir(commands: FlatRunCommand[], dir: string): FlatRunCommand[] {
  return commands.filter((command) => command && commandPackageDir(command) === dir);
}

/**
 * 若当前预览是 package.json，返回「行号（1 基）→ 命令」映射，供行号槽渲染 ▶。
 * @description 先按 package.json 所在目录筛选命令，再按 script 名匹配，避免把子包命令误判为根包命令。
 * @param preview 预览状态
 * @param runCommands 读取扁平命令列表
 * @param rootPath 工作区根目录路径
 * @returns 行号 → 命令映射
 */
function buildScriptCommandMap(
  preview: CodePreviewState | null,
  runCommands: (() => FlatRunCommand[]) | undefined,
  rootPath: string | undefined,
): RunLineMap {
  const map: RunLineMap = new Map();
  if (!preview || preview.kind !== "text" || preview.name !== "package.json") return map;
  if (typeof runCommands !== "function") return map;
  const commands = runCommands();
  if (!Array.isArray(commands) || !commands.length) return map;

  // preview.path 是绝对路径，命令 dir 是相对工作区路径；统一通过现有路径服务转换后再比较。
  const relativePackagePath = rootPath ? relativePath(rootPath, preview.path) : "package.json";
  const normalizedPackagePath = String(relativePackagePath || "").replace(/\\/g, "/");
  if (!normalizedPackagePath || !/package\.json$/i.test(normalizedPackagePath)) return map;
  // 同时覆盖根目录 `package.json`（无前置 `/`）和子包 `dir/package.json`，否则根命令的空 dir 永远无法命中。
  const packageDirKey = normalizePackageDir(normalizedPackagePath.replace(/(?:^|\/)package\.json$/i, ""));
  const packageCommands = commandsInPackageDir(commands, packageDirKey);

  for (const { name, line } of findScriptLines(preview.text)) {
    const command = packageCommands.find((candidate) => {
      const label =
        typeof candidate?.label === "string" && candidate.label
          ? candidate.label
          : String(candidate?.labelFallback || "").split("/").pop();
      return label === name;
    });
    if (command) map.set(line, command);
  }
  return map;
}

/**
 * 找出 Go 源文件中 `func main()` 所在行（1 基）。
 * @description 只认「函数名恰为 main 且无接收者」的顶层函数定义；忽略注释行，避免误判 `// func main()`。
 * @param text Go 源文件文本
 * @returns 行号；未找到返回 null
 */
function findGoMainLine(text?: string | null): number | null {
  const lines = String(text == null ? "" : text).split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const code = lines[i].replace(/\/\/.*$/, "").trim();
    if (/^func\s+main\s*\(\s*\)/.test(code)) return i + 1;
  }
  return null;
}

/**
 * 由 `go run` 命令反推其入口包目录（相对工作区，POSIX）。
 * @description `go run .` → 命令自身 dir；`go run ./cmd/<name>` → `<dir>/cmd/<name>`。
 *   用于把「命令 dir 是 module 根、而 main.go 在 cmd/<name>/ 下」的情况对应起来。
 * @param command 命令对象
 * @returns 入口包目录（相对工作区）；非 go run 命令返回 null
 */
function goRunEntryDir(command: FlatRunCommand | null | undefined): string | null {
  const matched = /^go run\s+(\S+)\s*$/.exec(String(command?.cmd || "").trim());
  if (!matched) return null;
  const dir = String(command?.dir || "").replace(/\\/g, "/").replace(/^\.\/+|\/+$/g, "");
  const target = matched[1];
  if (target === ".") return dir;
  const rel = target.replace(/^\.\//, "").replace(/\/+$/, "");
  return dir ? `${dir}/${rel}` : rel;
}

/**
 * 若当前预览是 Go 的 main 包文件（含 `func main()`），返回「行号 → 运行命令」映射。
 * @description 对标 IDEA：`func main()` 旁给出 ▶，运行该文件所属 Go module 的入口。
 *   入口命令由数据层按目录生成（`go run .` 或 `go run ./cmd/<name>`）；此处按命令的入口包目录
 *   与文件所在目录匹配（module 根 main.go → `go run .`；cmd/<name>/main.go → `go run ./cmd/<name>`）。
 * @param preview 预览状态
 * @param runCommands 读取扁平命令列表
 * @param rootPath 工作区根目录路径
 * @returns 行号 → 命令映射
 */
function buildGoMainCommandMap(
  preview: CodePreviewState | null,
  runCommands: (() => FlatRunCommand[]) | undefined,
  rootPath: string | undefined,
): RunLineMap {
  const map: RunLineMap = new Map();
  if (!preview || preview.kind !== "text" || !/\.go$/i.test(preview.name || "")) return map;
  if (typeof runCommands !== "function") return map;
  const line = findGoMainLine(preview.text);
  if (!line) return map;

  const commands = runCommands();
  if (!Array.isArray(commands) || !commands.length) return map;

  // preview.path 绝对路径 → 相对工作区；命令 dir / 入口目录都是相对工作区路径。
  const relPath = rootPath ? relativePath(rootPath, preview.path) : preview.name;
  const normalized = String(relPath || "").replace(/\\/g, "/");
  const fileDir = (normalized.includes("/") ? normalized.replace(/\/[^/]*$/, "") : "")
    .replace(/^\.\/+|\/+$/g, "")
    .toLowerCase();

  const runCommand = commands.find((command) => {
    const entryDir = goRunEntryDir(command);
    return entryDir != null && entryDir.toLowerCase() === fileDir;
  });
  if (runCommand) map.set(line, runCommand);
  return map;
}

function normalizeMainSourcePath(path?: string | null): string {
  return String(path || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * 若当前预览是 Java/Kotlin main 源文件，按 sourcePath + mainLine 映射行内运行命令。
 * @description sourcePath 比较统一大小写和分隔符；命令元数据来自 JVM 扫描器，避免查看器重复解析源码。
 * @param preview 预览状态
 * @param runCommands 读取扁平命令列表
 * @returns 行号 → 命令映射
 */
function buildJvmMainCommandMap(
  preview: CodePreviewState | null,
  runCommands: (() => FlatRunCommand[]) | undefined,
): RunLineMap {
  const map: RunLineMap = new Map();
  if (!preview || preview.kind !== "text" || !/\.(?:java|kt)$/i.test(preview.name || "")) return map;
  if (typeof runCommands !== "function") return map;
  const sourcePath = normalizeMainSourcePath(preview.path);
  if (!sourcePath) return map;
  for (const command of runCommands() || []) {
    const commandPath = normalizeMainSourcePath(command?.sourcePath);
    const line = Number(command?.mainLine);
    if (commandPath && commandPath === sourcePath && Number.isInteger(line) && line > 0) {
      map.set(line, command);
    }
  }
  return map;
}

/**
 * 若当前预览是 bat / PowerShell / sh 脚本，把第一行作为脚本级运行入口。
 * @description 脚本命令已经由项目扫描器绑定真实 sourcePath；不解析脚本正文，也不把普通文本行误判成多个入口。
 */
function buildScriptFileCommandMap(
  preview: CodePreviewState | null,
  runCommands: (() => FlatRunCommand[]) | undefined,
): RunLineMap {
  const map: RunLineMap = new Map();
  if (!preview || preview.kind !== "text" || !/\.(?:bat|ps1|sh)$/i.test(preview.name || "")) return map;
  if (typeof runCommands !== "function") return map;
  const sourcePath = normalizeMainSourcePath(preview.path);
  if (!sourcePath) return map;
  const command = (runCommands() || []).find(
    (item) => item?.runKind === "script" && normalizeMainSourcePath(item.sourcePath) === sourcePath
  );
  if (command) map.set(1, command);
  return map;
}

/**
 * 汇总当前预览文件的行内运行入口（行号 → 命令）。
 * @description 行号槽 ▶ 与右键「运行」分组共用这一份判定，避免两处各写一套文件筛选规则。
 * @param preview 预览状态
 * @param runCommands 读取扁平命令列表
 * @param rootPath 工作区根目录绝对路径
 * @returns 行号 → 命令映射；无入口时为空 Map
 */
function buildRunLineMap(
  preview: CodePreviewState | null | undefined,
  runCommands: (() => FlatRunCommand[]) | undefined,
  rootPath: string | undefined,
): RunLineMap {
  if (!preview || typeof runCommands !== "function") return new Map();
  return new Map([
    ...buildScriptCommandMap(preview, runCommands, rootPath),
    ...buildScriptFileCommandMap(preview, runCommands),
    ...buildGoMainCommandMap(preview, runCommands, rootPath),
    ...buildJvmMainCommandMap(preview, runCommands),
  ]);
}

/**
 * 右键「运行」分组要列出的命令：只允许是**这个文件**或**这个包**的，不得超过顶栏运行下拉。
 * @description 两条来源，互斥且按优先级取一条：
 *   1. 文件自己有行内 ▶ 入口（package.json scripts、Go/JVM main、bat/ps1/sh）→ 就是这些 ▶ 对应的命令；
 *   2. 包管理/构建清单文件（go.mod、pom.xml、pyproject.toml、锁文件…）→ 该清单所在包目录、且在顶栏可见列表
 *      （runMenuCommands）里的命令。顶栏不可见的模块内部命令（子模块 test/package/build、脚本命令等）
 *      不在候选内，菜单不会凭空多出顶栏没有的项。
 *   其余文件（README、普通源码、图片、二进制、Git 差异视图、空态）返回空数组，菜单不给运行项。
 * @param preview 预览状态
 * @param options.runCommands 行内 ▶ 用的完整命令列表（含顶栏隐藏项）
 * @param options.runMenuCommands 顶栏运行下拉同源列表；缺省时退回 runCommands
 * @param options.rootPath 工作区根目录绝对路径
 * @returns 命令列表：走 ▶ 时按行号顺序，走清单时按顶栏列表顺序
 */
function buildPreviewRunCommands(
  preview: CodePreviewState | null | undefined,
  options: {
    runCommands?: () => FlatRunCommand[];
    runMenuCommands?: () => FlatRunCommand[];
    rootPath?: string;
  },
): FlatRunCommand[] {
  const { runCommands, runMenuCommands, rootPath } = options;
  if (!preview || preview.kind !== "text" || preview.diff) return [];
  const own = Array.from(buildRunLineMap(preview, runCommands, rootPath).values());
  if (own.length) return own;
  if (!isPackageManifestFile(preview.name)) return [];
  const packageCommands = typeof runMenuCommands === "function" ? runMenuCommands() : runCommands?.();
  if (!Array.isArray(packageCommands)) return [];
  return commandsInPackageDir(packageCommands, previewFileDir(preview, rootPath)).filter(Boolean);
}

/** 关闭预览区右键菜单及 document 级监听，避免预览重绘后菜单残留。 */
function closeViewerContextMenu(bodyEl: HTMLElement | null | undefined): void {
  const bindingCleanup = bodyEl && bodyEl[VIEWER_CONTEXT_MENU_BINDING];
  if (typeof bindingCleanup === "function") {
    bindingCleanup();
    return;
  }
  const menuCleanup = bodyEl && bodyEl[VIEWER_CONTEXT_MENU_CLEANUP];
  if (typeof menuCleanup === "function") menuCleanup();
  else bodyEl?.ownerDocument?.querySelector(".sfe-viewer-context-menu")?.remove();
}

function clearViewerContextMenu(bodyEl: HTMLElement | null | undefined): void {
  const menuCleanup = bodyEl && bodyEl[VIEWER_CONTEXT_MENU_CLEANUP];
  if (typeof menuCleanup === "function") {
    menuCleanup();
    return;
  }
  bodyEl?.ownerDocument?.querySelector(".sfe-viewer-context-menu")?.remove();
}

/** 绑定打开文件内容区的菜单；文件操作与文本编辑动作共用一个菜单。 */
function bindViewerContextMenu(bodyEl: HTMLElement | null | undefined, opts: ViewerContextMenuOptions): void {
  if (!bodyEl) return;
  const handleContextMenu = (event: MouseEvent) => {
    // 事件目标在浏览器里必然是元素节点；closest 只在 Element 上存在。
    if ((event.target as Element | null)?.closest?.(".sfe-viewer-context-menu")) return;
    event.preventDefault();
    event.stopPropagation();
    // 即使当前无文件（空态）也弹菜单：仓库级操作（如刷新）不依赖已打开文件；
    //   具体哪些菜单项可用由 openViewerContextMenu 按已注入的回调决定。
    // 事件目标在浏览器里必然是元素节点；菜单只按元素读取坐标与选区。
    openViewerContextMenu(bodyEl, event.clientX, event.clientY, event.target as HTMLElement | null, opts);
  };
  bodyEl.addEventListener("contextmenu", handleContextMenu);
  const cleanup = () => {
    bodyEl.removeEventListener("contextmenu", handleContextMenu);
    clearViewerContextMenu(bodyEl);
    if (bodyEl[VIEWER_CONTEXT_MENU_BINDING] === cleanup) {
      delete bodyEl[VIEWER_CONTEXT_MENU_BINDING];
    }
  };
  bodyEl[VIEWER_CONTEXT_MENU_BINDING] = cleanup;
}

function readViewerClipboardText() {
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard ||
    typeof navigator.clipboard.readText !== "function"
  ) {
    return Promise.resolve("");
  }
  return navigator.clipboard.readText().then((text) => String(text || "")).catch(() => "");
}

function getViewerSelection(target?: HTMLTextAreaElement | null): ViewerSelection {
  if (target && target.tagName === "TEXTAREA") {
    const start = Math.min(target.selectionStart, target.selectionEnd);
    const end = Math.max(target.selectionStart, target.selectionEnd);
    return {
      text: target.value.slice(start, end),
      target,
      start,
      end,
    };
  }
  const selection = typeof window !== "undefined" && typeof window.getSelection === "function"
    ? window.getSelection()
    : null;
  return {
    text: selection ? selection.toString() : "",
    target: null,
    start: 0,
    end: 0,
  };
}

/** 在编辑 textarea 的原选区插入文本，并通过 input 事件走现有编辑状态链路。 */
function replaceViewerSelection(selection: ViewerSelection, text: string): void {
  const target = selection && selection.target;
  if (!target) return;
  const value = target.value;
  const next = value.slice(0, selection.start) + text + value.slice(selection.end);
  const caret = selection.start + text.length;
  target.focus();
  target.value = next;
  target.setSelectionRange(caret, caret);
  // 使用 textarea 所属窗口的 Event 构造器，避免嵌入宿主或测试 DOM 时跨 realm 事件被拒绝。
  const EventCtor = target.ownerDocument?.defaultView?.Event || Event;
  target.dispatchEvent(new EventCtor("input", { bubbles: true }));
}

/** 构建预览区菜单；粘贴项只有剪贴板确实有文本时才启用。 */
function openViewerContextMenu(
  bodyEl: HTMLElement,
  x: number,
  y: number,
  target: HTMLElement | null,
  opts: ViewerContextMenuOptions,
): void {
  clearViewerContextMenu(bodyEl);
  const { preview, rootPath, editable, onRefresh, onRevealFile, onCopyPath, onCopyRelativePath, runCommands, runMenuCommands, onRunCommand, t } = opts;
  // 原 JS 用 tagName 判定是否编辑框，类型系统无法据此收窄，故此处按 getViewerSelection 实际读取的形态断言。
  const selection = getViewerSelection(target as HTMLTextAreaElement | null);
  const hasFileActions =
    typeof onRevealFile === "function" ||
    typeof onCopyPath === "function" ||
    typeof onCopyRelativePath === "function";
  const isEditableText = editable === true && !!selection.target;
  // 刷新：重新从磁盘读取当前文件，仅只读态提供（编辑态会丢弃未保存修改，必须禁用）。
  const canRefresh = editable !== true && typeof onRefresh === "function";
  // 运行分组：只列「这个文件 / 这个包」的命令，其他文件一律不给（详见 buildPreviewRunCommands）。
  const fileRunCommands = buildPreviewRunCommands(preview, { runCommands, runMenuCommands, rootPath });
  const canRun = typeof onRunCommand === "function" && fileRunCommands.length > 0;
  if (!selection.text && !hasFileActions && !isEditableText && !canRefresh && !canRun) return;

  const doc = bodyEl.ownerDocument;
  const menu = el("div", "sfe-context-menu sfe-viewer-context-menu");
  menu.setAttribute("role", "menu");
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    doc.removeEventListener("click", handleOutsideClick, true);
    doc.removeEventListener("keydown", handleEscape, true);
    menu.remove();
    if (bodyEl[VIEWER_CONTEXT_MENU_CLEANUP] === cleanup) {
      delete bodyEl[VIEWER_CONTEXT_MENU_CLEANUP];
    }
  };
  const handleOutsideClick = (event: MouseEvent) => {
    // 事件目标在浏览器里必然是节点；contains 只接受 Node。
    if (!menu.contains(event.target as Node | null)) cleanup();
  };
  const handleEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    cleanup();
  };
  const addSeparator = () => {
    if (menu.childElementCount > 0) menu.appendChild(el("div", "sfe-context-menu-separator"));
  };
  const addItem = (
    id: string,
    label: string,
    icon: string,
    action: () => unknown,
    disabled = false,
  ): HTMLButtonElement => {
    const item = el("button", "sfe-context-menu-item sfe-viewer-context-menu-item", label);
    item.type = "button";
    item.disabled = disabled;
    item.dataset.menuId = id;
    item.setAttribute("role", "menuitem");
    item.insertBefore(createActionIcon(icon, 13), item.firstChild);
    item.addEventListener("click", async () => {
      if (item.disabled) return;
      cleanup();
      await action();
    });
    menu.appendChild(item);
    return item;
  };

  if (selection.text) {
    addItem("copy", t("action.copySelection", "复制"), "copy", () => copyToClipboard(selection.text));
    if (isEditableText) {
      addItem("cut", t("action.cut", "剪切"), "scissors", async () => {
        if (await copyToClipboard(selection.text)) replaceViewerSelection(selection, "");
      });
    }
  }

  // 闭包里的 pasteItem 会被重置为声明类型；两处回调都在 pasteItem 赋值之后才可能执行，故按非空断言。
  let pasteItem: HTMLButtonElement | null = null;
  if (isEditableText) {
    if (selection.text) addSeparator();
    pasteItem = addItem("paste", t("action.paste", "粘贴"), "clipboardPaste", async () => {
      const text = pasteItem!.dataset.clipboardText || (await readViewerClipboardText());
      if (text) replaceViewerSelection(selection, text);
    }, true);
    void readViewerClipboardText().then((text) => {
      if (!pasteItem!.isConnected) return;
      pasteItem!.dataset.clipboardText = text;
      pasteItem!.disabled = !text;
    });
  }

  if ((selection.text || isEditableText) && hasFileActions) addSeparator();
  if (typeof onRevealFile === "function") {
    addItem("reveal", t("action.revealInExplorer", "在资源管理器中打开"), "folderOpen", onRevealFile);
  }
  if (typeof onCopyPath === "function") {
    addItem("copy-path", t("action.copyPath", "复制路径"), "copy", onCopyPath);
  }
  if (typeof onCopyRelativePath === "function") {
    addItem("copy-relative-path", t("action.copyRelativePath", "复制相对路径"), "copy", onCopyRelativePath);
  }
  // 刷新置于文件操作之后：只读态重新读取磁盘内容（编辑态 canRefresh 为 false，不显示）
  if (canRefresh) {
    addSeparator();
    addItem("refresh", t("action.refresh", "刷新"), "refresh", onRefresh);
  }
  // 运行分组：命中几条渲染几条（对齐 IDEA 右键 Run），候选项已限定为当前文件或其所属包。
  // 多包仓库里同组只剩本包命令，组标题用于标明是哪个包。
  if (canRun) {
    addSeparator();
    let lastGroup;
    for (const command of fileRunCommands) {
      const group = command.group || null;
      if (group !== lastGroup) {
        menu.appendChild(el("div", "sfe-context-menu-group", group || t("run.groupRoot", "根目录")));
        lastGroup = group;
      }
      const label = command.labelKey ? t(command.labelKey, command.labelFallback) : command.labelFallback;
      addItem(`run:${command.id}`, `${t("run.menuRun", "运行")} · ${label}`, "play", () => onRunCommand(command));
    }
  }

  if (!menu.childElementCount) return;
  bodyEl[VIEWER_CONTEXT_MENU_CLEANUP] = cleanup;
  doc.body.appendChild(menu);
  doc.addEventListener("click", handleOutsideClick, true);
  doc.addEventListener("keydown", handleEscape, true);

  const viewportWidth = window.innerWidth || doc.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || doc.documentElement.clientHeight || 0;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, viewportWidth ? viewportWidth - rect.width - 4 : x))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, viewportHeight ? viewportHeight - rect.height - 4 : y))}px`;
}

/**
 * 渲染代码/文件预览面板
 * @param bodyEl 承载预览内容的容器 DOM
 * @param options 预览状态与各类回调（字段说明见 CodeViewerOptions）
 * @param options.preview 预览状态对象（kind / text / highlightedHtml / url / name / mime / message / diff / gitView）
 * @param options.rootPath 工作区根目录路径，用于匹配 package.json 所属包
 * @param options.copied 是否刚点击过复制按钮
 * @param options.onCopy 点击复制回调
 * @param options.onSetMode 切换预览/代码模式回调 (mode: 'preview' | 'code')
 * @param options.onSetDiffMode 切换差异展示模式回调 (mode: 'unified' | 'split')
 * @param options.onToggleEdit 切换只读/编辑状态回调
 * @param options.onEditInput 编辑文本变化回调
 * @param options.onSave 保存当前文本回调
 * @param options.onRevealFile 在资源管理器中打开当前文件回调
 * @param options.onCopyPath 复制当前文件绝对路径回调
 * @param options.onCopyRelativePath 复制当前文件相对路径回调
 * @param options.onRefresh 重新读取当前文件回调（仅只读态显示，编辑态不显示）
 * @param options.editable 当前是否处于编辑状态
 * @param options.saving 是否正在保存
 * @param options.emptyHint 无文件时空态提示文案（默认「选择一个文件即可预览。」）
 * @param options.t 本地化翻译函数
 */
export function renderCodeViewer(
  bodyEl: HTMLElement,
  {
    preview,
    rootPath,
    copied,
    onCopy,
    onSetMode,
    onSetDiffMode,
    onToggleEdit,
    onEditInput,
    onSave,
    onRevealFile,
    onCopyPath,
    onCopyRelativePath,
    onRefresh,
    runCommands,
    runMenuCommands,
    onRunCommand,
    editable = false,
    saving = false,
    emptyHint,
    t,
  }: CodeViewerOptions,
): void {
  closeViewerContextMenu(bodyEl);
  // 释放上一次预览可能残留的虚拟列表（滚动监听 / 内部节点），避免重绘后泄漏
  if (bodyEl.__sfeVList && typeof bodyEl.__sfeVList.destroy === "function") {
    bodyEl.__sfeVList.destroy();
    bodyEl.__sfeVList = null;
  }
  // 解绑上一次预览绑定的 contextmenu 监听：bodyEl 是同一个容器，重复渲染若不先解绑，
  //   监听会逐次累积（每次打开 package.json 都会再加一层），右键一次会弹出多个菜单。
  const prevBinding = bodyEl[VIEWER_CONTEXT_MENU_BINDING];
  if (typeof prevBinding === "function") prevBinding();
  bodyEl.replaceChildren();
  bindViewerContextMenu(bodyEl, {
    preview,
    rootPath,
    editable,
    onEditInput,
    onRefresh,
    onRevealFile,
    onCopyPath,
    onCopyRelativePath,
    runCommands,
    runMenuCommands,
    onRunCommand,
    t,
  });

  if (!preview) {
    const empty = el("div", "sfe-file-viewer-empty");
    // 允许调用方覆盖空态提示（如 Git 右侧查看器：「选择左侧变更文件查看差异」）。
    // el 的类名位只接受 string|undefined；null 表示不设类名，与原 JS 语义一致（同 diff-view 的处理）。
    empty.appendChild(el("div", null, emptyHint || t("preview.hint", "选择一个文件即可预览。")));
    bodyEl.appendChild(empty);
    return;
  }

  // 0. Git 变更文件：「差异 / 内容」切换已上移到工具栏（见 index.js），
  //    此处仅按当前子视图渲染；默认差异。
  if (preview.diff) {
    const gitView = preview.gitView === "content" ? "content" : "diff";
    if (gitView === "diff") {
      const diffPane = el("div", "sfe-diff-pane");
      renderDiffView(diffPane, {
        result: preview.diff.result,
        // 全文件差异：透传工作区新版本完整文本
        fullContent: typeof preview.diff.fullContent === "string" ? preview.diff.fullContent : null,
        loading: preview.diff.loading,
        error: preview.diff.error,
        // 使用文件扩展名选择 Prism 语言，确保差异正文与普通代码预览使用同一套高亮规则
        extension: extname(preview.name),
        mode: preview.diffMode,
        onSetMode: onSetDiffMode,
        t,
      });
      bodyEl.appendChild(diffPane);
      return;
    }
    // 内容模式：继续向下按普通文本/图片/二进制渲染
  }

  // 1. 文本与代码模式
  if (preview.kind === "text") {
    // Markdown 默认进入预览模式；预览/代码双模式可切换
    const mode = preview.isMarkdown && preview.mode === "code" ? "code" : "preview";
    // 模式切换与复制/编辑/保存按钮共用一个工具栏，避免多个绝对定位层相互覆盖。
    const viewerToolbar = el("div", "sfe-viewer-toolbar");

    // Markdown 专属：模式切换分段控件
    if (preview.isMarkdown) {
      const switcher = el("div", "sfe-md-mode-switch");
      switcher.setAttribute("role", "group");
      const segments: ModeSegment[] = [
        { key: "preview", icon: "eye", label: t("action.preview", "预览") },
        { key: "code", icon: "code", label: t("action.code", "代码") },
      ];
      for (const seg of segments) {
        const isActive = seg.key === mode;
        const btn = el("button", "sfe-md-mode-btn" + (isActive ? " active" : ""));
        btn.type = "button";
        btn.title = seg.label;
        btn.setAttribute("aria-pressed", isActive ? "true" : "false");
        btn.appendChild(createActionIcon(seg.icon, 13));
        btn.appendChild(el("span", "sfe-md-mode-label", seg.label));
        if (!isActive && typeof onSetMode === "function") {
          btn.addEventListener("click", () => onSetMode(seg.key));
        }
        switcher.appendChild(btn);
      }
      viewerToolbar.appendChild(switcher);
    }

    // 编辑能力只属于普通文本或 Markdown 代码模式。
    const canEdit =
      preview.kind === "text" &&
      (!preview.isMarkdown || mode === "code") &&
      typeof onToggleEdit === "function";

    // 复制与编辑控制集中在同一工具组，避免两个绝对定位按钮互相覆盖。
    const actions = el("div", "sfe-viewer-actions");
    const copyBtn = el("button", "sfe-floating-copy-btn" + (copied ? " copied" : ""));
    copyBtn.type = "button";
    copyBtn.title = copied ? t("action.copied", "已复制") : t("action.copy", "复制代码");
    copyBtn.appendChild(createActionIcon(copied ? "check" : "copy", 14));
    if (typeof onCopy === "function") copyBtn.addEventListener("click", onCopy);
    actions.appendChild(copyBtn);

    if (canEdit) {
      const editBtn = el("button", "sfe-floating-edit-btn" + (editable ? " editing" : ""));
      editBtn.type = "button";
      editBtn.title = editable ? t("action.readOnly", "只读") : t("action.edit", "编辑");
      editBtn.setAttribute("aria-pressed", editable ? "true" : "false");
      editBtn.appendChild(createActionIcon(editable ? "eye" : "pencil", 14));
      editBtn.addEventListener("click", () => onToggleEdit(!editable));
      actions.appendChild(editBtn);

      if (editable && typeof onSave === "function") {
        const saveBtn = el("button", "sfe-floating-save-btn");
        saveBtn.type = "button";
        saveBtn.title = saving ? t("action.saving", "保存中…") : t("action.save", "保存");
        saveBtn.disabled = saving;
        saveBtn.appendChild(createActionIcon("check", 14));
        saveBtn.addEventListener("click", onSave);
        actions.appendChild(saveBtn);
      }
    }
    viewerToolbar.appendChild(actions);
    bodyEl.appendChild(viewerToolbar);

    // Markdown 预览模式：渲染已净化的 HTML
    if (preview.isMarkdown && mode === "preview") {
      const scroll = el("div", "sfe-md-preview-scroll");
      const article = el("div", "sfe-markdown-body");
      // preview.html 已由 DOMPurify 白名单净化（见 components/markdown-renderer.js）
      article.innerHTML = preview.html || "";
      // 图片分两类处理：
      //  1) 本地相对路径：转为 data-sfe-src 并移除 src，交由宿主异步读取后回填（见 index.js inlineMarkdownImages）；
      //  2) 外链 http(s)：改写为宿主 img-proxy 代理 URL —— 宿主 CSP 的 img-src 不放行 https:，
      //     原样保留会被浏览器拦截导致空白（如 README 徽章），必须走代理协议才能显示。
      //  data: 等其它内联源保持原 src 不动。
      for (const img of article.querySelectorAll("img[src]")) {
        const ref = img.getAttribute("src") || "";
        if (resolveMarkdownAssetPath(ref, preview.path)) {
          img.setAttribute("data-sfe-src", ref);
          img.removeAttribute("src");
          continue;
        }
        const proxied = resolveProxiedImageSrc(ref);
        if (proxied) img.setAttribute("src", proxied);
      }
      scroll.appendChild(article);
      bodyEl.appendChild(scroll);
      return;
    }

    if (editable) {
      // 编辑态结构（对标只读态）：
      //   editScroll（唯一滚动容器，flex 横排）
      //     ├─ 行号槽（sticky left，按行数生成，输入时同步刷新）
      //     └─ editArea（relative）
      //          ├─ editHighlight（absolute 铺满，语法高亮，只负责显示）
      //          └─ textarea（透明文字，高度贴合内容，负责真实输入）
      const editScroll = el("div", "sfe-file-viewer-edit-scroll");

      // 行号槽：与只读态共用 .sfe-file-viewer-gutter-row / -gutter-no，保证行高与对齐一致。
      // sfe-file-viewer-edit-gutter 只补顶部 12px 内边距，抵消 textarea 的 padding-top，使行号与代码行对齐。
      const gutter = el("div", "sfe-file-viewer-line-numbers sfe-file-viewer-edit-gutter");
      const buildGutter = (lineCount: number): void => {
        const frag = document.createDocumentFragment();
        for (let i = 1; i <= lineCount; i++) {
          const row = el("div", "sfe-file-viewer-gutter-row");
          row.appendChild(el("span", "sfe-file-viewer-gutter-no", String(i)));
          frag.appendChild(row);
        }
        gutter.replaceChildren(frag);
      };
      const countLines = (value?: string | null): number => String(value ?? "").split(/\r\n|\r|\n/).length;

      const editArea = el("div", "sfe-file-viewer-edit-area");
      const editHighlight = el("pre", "sfe-file-viewer-edit-highlight sfe-file-viewer-code");
      editHighlight.setAttribute("aria-hidden", "true");
      let editHighlightTimer: ReturnType<typeof setTimeout> | 0 = 0;
      const paintEditHighlight = (source: string): void => {
        // 超过整篇熔断的文件不再随按键重跑全文分词。只读态仍按可视行高亮。
        if (!shouldHighlight(source) || !highlighterReady()) {
          editHighlight.textContent = source;
        } else {
          const html = highlightCodeHtml(source, extname(preview.name));
          editHighlight.innerHTML = html || escapeHtml(source);
        }
        if (source.endsWith("\n")) editHighlight.appendChild(document.createTextNode(" "));
      };
      const updateEditHighlight = (value?: string | null, immediate?: boolean): void => {
        const source = String(value ?? "");
        if (editHighlightTimer) clearTimeout(editHighlightTimer);
        if (immediate || !shouldHighlight(source)) {
          paintEditHighlight(source);
          return;
        }
        editHighlightTimer = setTimeout(() => {
          editHighlightTimer = 0;
          paintEditHighlight(source);
        }, 80);
      };
      updateEditHighlight(preview.text, true);
      if (!highlighterReady() && shouldHighlight(preview.text)) {
        void ensureHighlighter().then(() => {
          if (!editHighlight.isConnected) return;
          paintEditHighlight(String(preview.text || ""));
        });
      }

      const textarea = document.createElement("textarea");
      textarea.className = "sfe-file-viewer-textarea";
      textarea.value = String(preview.text || "");
      textarea.wrap = "off";
      textarea.spellcheck = false;
      textarea.setAttribute("aria-label", t("action.edit", "编辑文件"));
      // 高度贴合内容：textarea 自身不滚动，滚动条只由外层 editScroll 提供，
      // 否则 Chromium 会把 overflow:visible 的 textarea 当 auto，出现「双滚动条」且内层那条滚不动高亮层。
      const syncEditHeight = () => {
        textarea.style.height = "auto";
        textarea.style.height = `${textarea.scrollHeight}px`;
      };
      buildGutter(countLines(textarea.value));
      if (typeof onEditInput === "function") {
        textarea.addEventListener("input", () => {
          syncEditHeight();
          buildGutter(countLines(textarea.value));
          updateEditHighlight(textarea.value);
          onEditInput(textarea.value);
        });
      }
      editArea.appendChild(editHighlight);
      editArea.appendChild(textarea);
      editScroll.appendChild(gutter);
      editScroll.appendChild(editArea);
      syncEditHeight();
      bodyEl.appendChild(editScroll);
    } else {
      // 只读态：小文件整块高亮；大文件用窗口化虚拟列表，只渲染可视行。
      const scroll = el("div", "sfe-file-viewer-code-scroll");
      const rawText = String(preview.text || "");
      const linesArray = rawText.split(/\r\n|\r|\n/);
      // 运行入口 ▶ 的行号映射（行号槽 / 虚拟行内渲染，两分支共用）：
      //   - package.json：scripts 各行 → 对应 npm/pnpm… 命令；
      //   - Go 源文件：`func main()` 行 → 该 module 的 go run 入口。
      // Java/Kotlin 源文件：扫描器已提供 sourcePath/mainLine，按绝对路径映射到 main 行。
      const runLineMap = buildRunLineMap(preview, runCommands, rootPath);

      // 约 400 行以上只渲染可视行。小文件仍整块高亮，避免把跨行 token 按行切碎。
      // 大文件同样给可视行上色；只有超长单行跳过，避免压缩文件把分词拖死。
      if (shouldVirtualize(rawText)) {
        scroll.classList.add("sfe-file-viewer-code-scroll-virtual");
        bodyEl.appendChild(scroll);
        const ext = extname(preview.name);
        const list = createVirtualList<string>({
          viewport: scroll,
          renderRow: (lineText, index) => {
            const row = el("div", "sfe-file-viewer-line");
            row.appendChild(el("span", "sfe-file-viewer-line-no", String(index + 1)));
            const command = runLineMap.get(index + 1);
            if (command) row.appendChild(createGutterRunButton(command, onRunCommand, t));
            const text = el("span", "sfe-file-viewer-line-text");
            const source = String(lineText ?? "");
            const html = source.length > 0 && source.length <= MAX_HIGHLIGHT_LINE_LEN && highlighterReady()
              ? highlightCodeHtml(source, ext)
              : "";
            if (html) text.innerHTML = html;
            else text.textContent = source;
            row.appendChild(text);
            return row;
          },
        });
        bodyEl.__sfeVList = list;
        list.setItems(linesArray);
        if (!highlighterReady()) {
          void ensureHighlighter().then(() => {
            if (!scroll.isConnected || !highlighterReady()) return;
            list.refresh();
          });
        }
      } else {
        const pre = el("pre", "sfe-file-viewer-code");
        const total = linesArray.length;

        // 行号槽（整列 sticky 于横向滚动时为代码让位）。
        // 命中运行入口的行（package.json scripts / Go func main）在行号后追加 ▶（对标 IDEA editor gutter）；
        //   行号槽由整块文本改为逐行元素，代码正文仍整块高亮（不切碎跨行 Prism token）。
        const gutter = el("div", "sfe-file-viewer-line-numbers");
        for (let i = 1; i <= total; i++) {
          const row = el("div", "sfe-file-viewer-gutter-row");
          row.appendChild(el("span", "sfe-file-viewer-gutter-no", String(i)));
          const command = runLineMap.get(i);
          if (command) row.appendChild(createGutterRunButton(command, onRunCommand, t));
          gutter.appendChild(row);
        }
        pre.appendChild(gutter);

        // 已有高亮 HTML（调用方预计算或单测注入）直接用。否则先出纯文本，高亮块到达后再替换。
        const content = el("div", "sfe-file-viewer-code-content");
        if (preview.highlightedHtml) {
          content.innerHTML = preview.highlightedHtml;
        } else {
          content.innerHTML = escapeHtml(rawText);
          if (shouldHighlight(rawText)) {
            const ext = extname(preview.name);
            void ensureHighlighter().then(() => {
              if (!content.isConnected || !highlighterReady()) return;
              const html = highlightCodeHtml(rawText, ext);
              if (html) content.innerHTML = html;
            });
          }
        }
        pre.appendChild(content);

        scroll.appendChild(pre);
        bodyEl.appendChild(scroll);
      }
    }

    if (preview.saveState && preview.saveState !== "idle") {
      const saveText =
        preview.saveState === "saving"
          ? t("action.saving", "保存中…")
          : preview.saveState === "saved"
            ? t("action.saveSuccess", "已保存")
            : preview.saveMessage || t("action.saveFailed", "保存失败");
      bodyEl.appendChild(el("div", "sfe-pv-note", saveText));
    }

    return;
  }

  // 2. 图片预览模式
  if (preview.kind === "image") {
    const container = el("div", "sfe-file-viewer-image-container");
    const img = document.createElement("img");
    img.className = "sfe-file-viewer-image";
    img.src = preview.url;
    img.alt = preview.name || "";
    container.appendChild(img);
    bodyEl.appendChild(container);
    return;
  }

  // 3. 二进制文件模式
  if (preview.kind === "binary") {
    const empty = el("div", "sfe-file-viewer-empty");
    empty.appendChild(createActionIcon("check", 24));
    empty.appendChild(
      el("div", null, t("preview.binary", "二进制文件（{{mime}}），不提供预览。", { mime: preview.mime }))
    );
    bodyEl.appendChild(empty);
    return;
  }

  // 4. 加载中状态
  if (preview.kind === "loading") {
    const empty = el("div", "sfe-file-viewer-empty");
    empty.appendChild(el("div", null, t("preview.loading", "正在读取…")));
    bodyEl.appendChild(empty);
    return;
  }

  // 5. 错误提示
  if (preview.kind === "error") {
    const empty = el("div", "sfe-file-viewer-empty error");
    empty.appendChild(el("div", null, t("preview.error", "无法读取：") + (preview.message || "")));
    bodyEl.appendChild(empty);
    return;
  }

  // 6. 默认空状态
  const empty = el("div", "sfe-file-viewer-empty");
  empty.appendChild(el("div", null, t("preview.hint", "选择一个文件即可预览。")));
  bodyEl.appendChild(empty);
}
