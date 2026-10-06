/**
 * Git 变更视图组件 (src/components/git-view.ts)
 * 复刻宿主 Git 面板核心：提交信息输入框（含 AI 生成）+ 提交/提交并推送 split 按钮
 * +「已暂存的变更 / 变更」两个按目录分组的树形列表。纯 DOM 渲染，数据与回调由 index.js 注入。
 *
 * 结构复用约定（关键）：
 *  - renderGitCommitBar 首次调用创建结构并绑定事件，之后只做「就地更新」，
 *    绝不重建 textarea —— 宿主 git watcher 高频刷新时，重建会打断正在进行的
 *    输入、右键菜单与文本选区（见 index.js 的渲染分派）。
 *  - renderGitList 只重建列表滚动区的内部内容（滚动容器本身保留，滚动位置不丢）。
 */

import { el } from "../utils/dom.ts";
import { createActionIcon } from "../icons/action-icons.ts";
import { createFileIconNode } from "../icons/file-icons.ts";
import {
  partitionGitFiles,
  gitStatusMeta,
  splitGitPath,
  buildGitFileTree,
  flattenGitTree,
  countGitTreeFiles,
  collectGitTreeFiles,
} from "../services/git-service.ts";
import type { GitTreeNode, GitTreeRow } from "../services/git-service.ts";
import type { GitFileStatus, GitStatusResult } from "../types/host/host-git.ts";
import type { TranslateFn } from "../types/panel-state.ts";

/** 变更列表的分区标识：已暂存 / 工作区变更。 */
export type GitSection = "staged" | "unstaged";

/** 提交按钮的两种模式；下拉菜单按此分流。 */
export type GitCommitMode = "commit" | "commitAndPush";

/** 目录行数据：GitTreeRow 的目录分支。 */
export type GitFolderRow = Extract<GitTreeRow, { kind: "folder" }>;

/**
 * Git 视图共享选项对象（index.js 的 gitViewOptions() 一次构造，提交区与列表复用）。
 * @description 提交回调全部可缺：组件对每个回调都做了 typeof 判定，缺省时对应按钮不响应。
 */
export type GitViewOptions = {
  /** 工作区根目录绝对路径；本组件不消费，调用方与文件树共用同一选项对象时带上。 */
  rootPath?: string;
  /** 完整 Git 状态（GitStatusResult）；null 表示尚未取到。 */
  gitStatus?: GitStatusResult | null;
  /** 提交信息草稿；来自用户输入，非空才允许提交。 */
  commitMessage?: string;
  /** 已暂存文件数；为 0 时提交与 AI 生成按钮禁用。 */
  stagedCount?: number;
  /** 当前选中键（`section:path`）；未选中时为 null。 */
  selected?: string | null;
  /** 进行中的操作名（stage/commit/push…）；null 表示空闲。 */
  busy?: string | null;
  /** 是否正在生成提交信息；生成中输入框只读、按钮转为「停止」。 */
  generating: boolean;
  /** 提交按钮模式（提交 / 提交并推送）。 */
  commitMode?: GitCommitMode;
  /** 提交模式下拉是否展开。 */
  commitMenuOpen?: boolean;
  /** 已暂存区折叠的目录相对路径集合。 */
  collapsedStaged: Set<string>;
  /** 变更区折叠的目录相对路径集合。 */
  collapsedUnstaged: Set<string>;
  /** 提交回调 */
  onCommit?: () => void;
  /** 提交并推送回调 */
  onCommitAndPush?: () => void;
  /** 设置提交模式回调 (mode) */
  onSetCommitMode?: (mode: GitCommitMode) => void;
  /** 切换提交模式下拉 */
  onToggleCommitMenu?: () => void;
  /** 生成/中止提交信息回调 */
  onGenerate?: () => void;
  /** 提交信息输入回调 (value) */
  onCommitMessageInput?: (value: string) => void;
  /** 选中文件回调 (file, section) */
  onSelectFile?: (file: GitFileStatus, section: GitSection) => void;
  /** 选中文件夹回调 (node, section) */
  onSelectFolder?: (node: GitFolderRow["node"], section: GitSection) => void;
  /** 暂存/取消暂存回调 (files, section) */
  onStageToggle?: (files: GitFileStatus[], section: GitSection) => void;
  /** 全部暂存回调 */
  onStageAll?: () => void;
  /** 全部取消暂存回调 */
  onUnstageAll?: () => void;
  /** 丢弃改动回调 (files) */
  onDiscard?: (files: GitFileStatus[]) => void;
  /** 折叠/展开目录回调 (section, path) */
  onToggleCollapse?: (section: GitSection, path: string) => void;
  /** 单击文件行打开差异回调 (file, section) */
  onOpenFile?: (file: GitFileStatus, section: GitSection) => void;
  /** 在资源管理器中打开文件回调 (file) */
  onRevealFile?: (file: GitFileStatus) => void;
  /** 复制相对路径回调 (file) */
  onCopyRelativePath?: (file: GitFileStatus) => void;
  /** 复制绝对路径回调 (file) */
  onCopyAbsolutePath?: (file: GitFileStatus) => void;
  /** 重新拉取文件树与 Git 状态回调 */
  onRefresh?: () => void;
  /** 国际化翻译函数 */
  t: TranslateFn;
};

/** renderSection 的入参：共享选项 + 当前分区与其文件清单。 */
export type GitSectionOptions = GitViewOptions & {
  /** 当前分区（已暂存 / 变更）。 */
  section: GitSection;
  /** 该分区的文件清单。 */
  files: GitFileStatus[];
};

/** renderFolderRow 的入参：目录行数据 + 该行动作所需的回调子集。 */
type GitFolderRowOptions = Pick<
  GitViewOptions,
  | "t"
  | "selected"
  | "onSelectFolder"
  | "onToggleCollapse"
  | "onStageToggle"
  | "onDiscard"
  | "onRevealFile"
  | "onCopyRelativePath"
  | "onCopyAbsolutePath"
  | "onRefresh"
> & {
  /** 目录行数据（节点、深度、展开态）。 */
  row: GitFolderRow;
  /** 所属分区。 */
  section: GitSection;
};

/** renderFileRow 的入参：文件行数据 + 该行动作所需的回调子集。 */
type GitFileRowOptions = Pick<
  GitViewOptions,
  | "t"
  | "selected"
  | "onSelectFile"
  | "onStageToggle"
  | "onDiscard"
  | "onOpenFile"
  | "onRevealFile"
  | "onCopyRelativePath"
  | "onCopyAbsolutePath"
> & {
  /** 该行的 Git 文件状态。 */
  file: GitFileStatus;
  /** 缩进深度，顶层为 0。 */
  depth: number;
  /** 所属分区。 */
  section: GitSection;
};

/** 文件行 / 目录行右键菜单共用的动作集合（右键时从最新 opts 里取）。 */
type GitRowMenuOptions = Pick<
  GitViewOptions,
  | "t"
  | "onOpenFile"
  | "onRevealFile"
  | "onStageToggle"
  | "onDiscard"
  | "onCopyRelativePath"
  | "onCopyAbsolutePath"
  | "onRefresh"
> & {
  /** 该文件行是否位于已暂存区；菜单文案实际按 section 判定，此字段由调用方一并带上。 */
  isStaged?: boolean;
};

/** 菜单项的可选修饰项。 */
type GitMenuItemStyle = {
  /** 是否在该项之前插入分隔线。 */
  separator?: boolean;
  /** 该项是否禁用（置灰且点击无效）。 */
  disabled?: boolean;
  /** 该项是否用危险（红）配色。 */
  danger?: boolean;
};

/** createGitMenu 的返回：追加菜单项与挂载定位两个动作。 */
type GitMenuHandle = {
  /** 追加一个菜单项。 */
  addItem: (
    id: string,
    label: string,
    iconName: string,
    action: () => void,
    style?: GitMenuItemStyle,
  ) => void;
  /** 挂载菜单、绑定全局清理监听并按视口边界定位。 */
  open: () => void;
};

declare global {
  interface Element {
    /** Git 右键菜单的全局监听清理句柄；菜单关闭或列表重绘前调用。 */
    __sfeGitContextMenuCleanup?: () => void;
    /** 变更列表滚动容器上挂的最新选项对象，供空白区右键菜单读取（避免闭包过期）。 */
    __sfeGitListOpts?: GitViewOptions;
  }
}

/**
 * 渲染（或就地更新）Git 提交信息区
 * @param parentEl Git 面板容器（提交区会被置于最上方）
 * @param opts 与 renderGitList 共享的选项对象（字段说明见 GitViewOptions：
 *   commitMessage 提交信息草稿、busy 进行中的操作名、generating 是否正在生成提交信息、
 *   commitMode 提交按钮模式、commitMenuOpen 提交模式下拉是否展开、stagedCount 已暂存文件数、
 *   onCommit 提交回调、onCommitAndPush 提交并推送回调、onSetCommitMode 设置提交模式回调 (mode)、
 *   onToggleCommitMenu 切换提交模式下拉、onGenerate 生成/中止提交信息回调、
 *   onCommitMessageInput 提交信息输入回调 (value)、t 国际化翻译函数）
 */
export function renderGitCommitBar(parentEl: HTMLElement, opts: GitViewOptions): void {
  let bar = findDirectChild(parentEl, "sfe-git-commit");
  if (!bar) {
    bar = buildCommitBar(opts);
    parentEl.insertBefore(bar, parentEl.firstChild);
  }
  syncCommitBar(bar, opts);
}

/**
 * 渲染 Git 变更列表（已暂存 / 变更两个分区，按目录分组）
 * @param parentEl Git 面板容器
 * @param opts 与 renderGitCommitBar 共享的选项对象（字段说明见 GitViewOptions：
 *   gitStatus 完整 Git 状态、selected 当前选中键（`section:path`）、busy 进行中的操作名、
 *   collapsedStaged 已暂存区折叠目录、collapsedUnstaged 变更区折叠目录、
 *   onSelectFile 选中文件回调 (file, section)、onStageToggle 暂存/取消暂存回调 (files, section)、
 *   onStageAll 全部暂存回调、onUnstageAll 全部取消暂存回调、onDiscard 丢弃改动回调 (files)、
 *   onToggleCollapse 折叠/展开目录回调 (section, path)、onOpenFile 单击文件行打开差异回调 (file, section)、
 *   onRevealFile 在资源管理器中打开文件回调 (file)、onCopyRelativePath 复制相对路径回调 (file)、
 *   onCopyAbsolutePath 复制绝对路径回调 (file)、t 国际化翻译函数）
 */
export function renderGitList(parentEl: HTMLElement, opts: GitViewOptions): void {
  const { gitStatus, t } = opts;
  closeGitContextMenu(parentEl);
  let scroll = findDirectChild(parentEl, "sfe-git-scroll");
  if (!scroll) {
    scroll = el("div", "sfe-git-scroll");
    // 空白区右键：文件行自身处理并阻止冒泡，其余区域在此兜底弹出仓库级菜单。
    // 监听器只绑一次（scroll 复用），通过节点上的最新 opts 避免闭包过期。
    scroll.addEventListener("contextmenu", (event) => {
      // 事件目标在浏览器里必然是元素节点；closest 只在 Element 上存在。
      if ((event.target as Element | null)?.closest?.(".sfe-git-row")) return;
      event.preventDefault();
      // scroll 在注册本监听前已确定挂载，闭包里按结构约定断言非空。
      const latest = scroll!.__sfeGitListOpts;
      if (latest) openGitPaneContextMenu(scroll!.parentElement, event.clientX, event.clientY, latest);
    });
    parentEl.appendChild(scroll);
  }
  scroll.__sfeGitListOpts = opts;
  scroll.replaceChildren();

  if (!gitStatus) {
    scroll.appendChild(el("div", "sfe-git-empty", t("status.loading", "加载中…")));
    return;
  }
  if (!gitStatus.isRepo) {
    scroll.appendChild(el("div", "sfe-git-empty", t("git.notARepo", "当前目录不是 Git 仓库")));
    return;
  }

  const { staged, unstaged } = partitionGitFiles(gitStatus.files);
  scroll.appendChild(renderSection({ ...opts, section: "staged", files: staged }));
  scroll.appendChild(renderSection({ ...opts, section: "unstaged", files: unstaged }));
}

/**
 * 创建提交信息区结构并绑定事件（仅首次调用）
 */
function buildCommitBar(opts: GitViewOptions): HTMLDivElement {
  const { commitMessage, generating, t } = opts;
  const bar = el("div", "sfe-git-commit");

  // 第一行：输入框 + AI 生成按钮
  const inputWrap = el("div", "sfe-git-commit-input-wrap");
  const textarea = document.createElement("textarea");
  textarea.className = "sfe-git-commit-input";
  textarea.placeholder = t("git.commitMessagePlaceholder", "提交信息（Ctrl+Enter 提交）");
  textarea.rows = 1;
  textarea.value = commitMessage || "";
  textarea.readOnly = !!generating;
  // 输入直接写回 state，不触发整体重建，避免光标跳动与失焦
  textarea.addEventListener("input", () => {
    if (typeof opts.onCommitMessageInput === "function") opts.onCommitMessageInput(textarea.value);
  });
  textarea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (typeof opts.onCommit === "function") opts.onCommit();
    }
  });
  inputWrap.appendChild(textarea);

  const aiBtn = el("button", "sfe-git-ai-btn");
  aiBtn.type = "button";
  aiBtn.addEventListener("click", () => {
    if (typeof opts.onGenerate === "function") opts.onGenerate();
  });
  inputWrap.appendChild(aiBtn);
  bar.appendChild(inputWrap);

  // 第二行：提交 / 提交并推送 split 按钮
  const btnRow = el("div", "sfe-git-commit-actions");
  const split = el("div", "sfe-git-commit-split");

  const primary = el("button", "sfe-git-commit-btn");
  primary.type = "button";
  primary.appendChild(createActionIcon("gitCommit", 14));
  primary.appendChild(el("span", "sfe-git-commit-btn-label"));
  primary.addEventListener("click", () => {
    // 当前模式由 syncCommitBar 写入 dataset，事件据此分流
    if (bar.dataset.commitMode === "commitAndPush") {
      if (typeof opts.onCommitAndPush === "function") opts.onCommitAndPush();
    } else if (typeof opts.onCommit === "function") {
      opts.onCommit();
    }
  });
  split.appendChild(primary);

  const caret = el("button", "sfe-git-commit-caret");
  caret.type = "button";
  caret.title = t("git.commitMode", "提交模式");
  caret.appendChild(createActionIcon("chevronDown", 13));
  caret.addEventListener("click", (e) => {
    e.stopPropagation();
    if (typeof opts.onToggleCommitMenu === "function") opts.onToggleCommitMenu();
  });
  split.appendChild(caret);

  btnRow.appendChild(split);
  bar.appendChild(btnRow);
  return bar;
}

/**
 * 就地更新提交信息区（不重建任何节点）
 */
function syncCommitBar(bar: HTMLElement, opts: GitViewOptions): void {
  const { commitMessage, busy, generating, commitMode, commitMenuOpen, stagedCount, t } = opts;
  // 以下节点都由 buildCommitBar 一次性建好，同步路径上必然存在，故按结构约定断言非空。
  const textarea: HTMLTextAreaElement = bar.querySelector(".sfe-git-commit-input")!;
  const aiBtn: HTMLButtonElement = bar.querySelector(".sfe-git-ai-btn")!;
  const primary: HTMLButtonElement = bar.querySelector(".sfe-git-commit-btn")!;
  const caret: HTMLButtonElement = bar.querySelector(".sfe-git-commit-caret")!;
  const split: HTMLDivElement = bar.querySelector(".sfe-git-commit-split")!;

  bar.dataset.commitMode = commitMode === "commitAndPush" ? "commitAndPush" : "commit";

  // 输入框：仅当失焦且外部值与当前值不同才回写。
  // 聚焦时绝不覆盖 —— 用户正在输入/选中/右键操作，覆盖会打断并破坏光标与选区。
  const msg = commitMessage || "";
  if (document.activeElement !== textarea && textarea.value !== msg) {
    textarea.value = msg;
  }
  const readOnly = !!generating;
  if (textarea.readOnly !== readOnly) textarea.readOnly = readOnly;
  textarea.classList.toggle("is-generating", readOnly);

  // AI 生成按钮
  const aiTitle = generating
    ? t("git.abortGenerate", "停止生成")
    : t("git.generateMessage", "AI 生成提交信息");
  if (aiBtn.title !== aiTitle) aiBtn.title = aiTitle;
  const aiDisabled = !generating && (busy !== null || stagedCount === 0);
  if (aiBtn.disabled !== aiDisabled) aiBtn.disabled = aiDisabled;
  setButtonIcon(aiBtn, generating ? "square" : "sparkles", 14);

  // 提交按钮
  const isPush = bar.dataset.commitMode === "commitAndPush";
  const label: HTMLSpanElement = primary.querySelector(".sfe-git-commit-btn-label")!;
  const nextLabel = isPush ? t("git.commitAndPush", "提交并推送") : t("git.commit", "提交");
  if (label.textContent !== nextLabel) label.textContent = nextLabel;
  const primaryDisabled =
    busy !== null || generating || !String(msg).trim() || stagedCount === 0;
  if (primary.disabled !== primaryDisabled) primary.disabled = primaryDisabled;

  const caretDisabled = busy !== null || generating;
  if (caret.disabled !== caretDisabled) caret.disabled = caretDisabled;

  // 提交模式下拉
  let menu = findDirectChild(split, "sfe-git-commit-menu");
  if (commitMenuOpen) {
    if (!menu) {
      menu = buildCommitMenu(opts);
      split.appendChild(menu);
    }
    for (const item of menu.querySelectorAll(".sfe-git-commit-menu-item")) {
      item.classList.toggle("active", item.getAttribute("data-mode") === bar.dataset.commitMode);
    }
  } else if (menu) {
    menu.remove();
  }
}

/**
 * 构建提交模式下拉菜单
 */
function buildCommitMenu(opts: GitViewOptions): HTMLDivElement {
  const { commitMode, t } = opts;
  const menu = el("div", "sfe-git-commit-menu");
  const option = (mode: GitCommitMode, label: string) => {
    const item = el("button", "sfe-git-commit-menu-item" + (commitMode === mode ? " active" : ""));
    item.type = "button";
    item.setAttribute("data-mode", mode);
    item.appendChild(el("span", "sfe-git-commit-menu-label", label));
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      if (typeof opts.onSetCommitMode === "function") opts.onSetCommitMode(mode);
    });
    return item;
  };
  menu.appendChild(option("commit", t("git.commit", "提交")));
  menu.appendChild(option("commitAndPush", t("git.commitAndPush", "提交并推送")));
  return menu;
}

/**
 * 渲染一个分区（已暂存 / 变更），文件按目录分组成树
 */
function renderSection(opts: GitSectionOptions): HTMLDivElement {
  const {
    section,
    files,
    selected,
    collapsedStaged,
    collapsedUnstaged,
    onSelectFile,
    onSelectFolder,
    onStageToggle,
    onStageAll,
    onUnstageAll,
    onDiscard,
    onToggleCollapse,
    onOpenFile,
    onRevealFile,
    onCopyRelativePath,
    onCopyAbsolutePath,
    onRefresh,
    t,
  } = opts;

  const isStaged = section === "staged";
  const collapsedDirs = isStaged ? collapsedStaged : collapsedUnstaged;
  const wrap = el("div", "sfe-git-section");

  const head = el("div", "sfe-git-section-head");
  const title = el("div", "sfe-git-section-title");
  title.appendChild(
    el("span", "sfe-git-section-label", isStaged ? t("git.stagedChanges", "已暂存的变更") : t("git.changes", "变更"))
  );
  if (files.length > 0) title.appendChild(el("span", "sfe-git-count", String(files.length)));
  head.appendChild(title);

  if (files.length > 0) {
    const actionBtn = el("button", "sfe-git-section-action");
    actionBtn.type = "button";
    actionBtn.title = isStaged ? t("git.unstageAll", "全部取消暂存") : t("git.stageAll", "全部暂存");
    // 不做 busy 禁用：Git 写操作由 index.js 串行排队，点击不会丢；禁用反而在
    // 「busy 期间重建列表」时被写死成 disabled（finally 不再重建列表 → 永久点不动）。
    actionBtn.appendChild(createActionIcon(isStaged ? "minus" : "plus", 14));
    actionBtn.addEventListener("click", () => {
      if (isStaged) {
        if (typeof onUnstageAll === "function") onUnstageAll();
      } else if (typeof onStageAll === "function") onStageAll();
    });
    head.appendChild(actionBtn);
  }
  wrap.appendChild(head);

  const body = el("div", "sfe-git-items");
  if (files.length === 0) {
    body.appendChild(
      el(
        "div",
        "sfe-git-empty",
        isStaged ? t("git.noStagedChanges", "暂无已暂存的变更") : t("git.noChanges", "暂无变更")
      )
    );
  } else {
    const rows = flattenGitTree(buildGitFileTree(files), collapsedDirs);
    for (const row of rows) {
      body.appendChild(
        row.kind === "folder"
          ? renderFolderRow({
              row,
              section,
              selected,
              onSelectFolder,
              onToggleCollapse,
              onStageToggle,
              onDiscard,
              onRevealFile,
              onCopyRelativePath,
              onCopyAbsolutePath,
              onRefresh,
              t,
            })
          : renderFileRow({
              file: row.file,
              depth: row.depth,
              section,
              selected,
              onSelectFile,
              onStageToggle,
              onDiscard,
              onOpenFile,
              onRevealFile,
              onCopyRelativePath,
              onCopyAbsolutePath,
              t,
            })
      );
    }
  }
  wrap.appendChild(body);
  return wrap;
}

/**
 * 渲染目录行
 */
function renderFolderRow(opts: GitFolderRowOptions): HTMLDivElement {
  const {
    row,
    section,
    selected,
    onSelectFolder,
    onToggleCollapse,
    onStageToggle,
    onDiscard,
    onRevealFile,
    onCopyRelativePath,
    onCopyAbsolutePath,
    onRefresh,
    t,
  } = opts;
  const { node, depth, isExpanded } = row;
  const isStaged = section === "staged";
  const isSelected = selected === `${section}:${node.path}`;
  const item = el("div", "sfe-git-row sfe-git-folder-row" + (isSelected ? " selected" : ""));
  item.style.paddingLeft = 12 + depth * 14 + "px";
  item.title = node.path;
  item.appendChild(
    el("span", "sfe-git-chevron" + (isExpanded ? " expanded" : ""))
  );
  item.lastChild!.appendChild(createActionIcon(isExpanded ? "chevronDown" : "chevronRight", 13));
  item.appendChild(createFileIconNode(node.name, true, isExpanded));
  item.appendChild(el("span", "sfe-git-name-text", node.name));
  item.appendChild(el("span", "sfe-git-folder-count", String(countGitTreeFiles(node))));

  // 目录级暂存/取消暂存：对整个子树生效，按钮恒在最右（与文件行一致）。
  // 不做 busy 禁用（见 renderSection.actionBtn 注释：禁用会在列表重建后写死）。
  if (typeof onStageToggle === "function") {
    const btn = el("button", "sfe-git-row-btn stage-toggle");
    btn.type = "button";
    btn.title = isStaged ? t("git.unstageFolder", "取消暂存此目录") : t("git.stageFolder", "暂存此目录");
    btn.appendChild(createActionIcon(isStaged ? "minus" : "plus", 13));
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onStageToggle(collectGitTreeFiles(node), section);
    });
    item.appendChild(btn);
  }

  // 目录行右键菜单：暂存此目录 / 取消暂存 / 丢弃 / 复制路径 / 资源管理器 / 刷新
  item.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openGitFolderContextMenu(
      item.closest(".sfe-git-pane") || item.parentElement,
      event.clientX,
      event.clientY,
      node,
      section,
      { onStageToggle, onDiscard, onRevealFile, onCopyRelativePath, onCopyAbsolutePath, onRefresh, t },
    );
  });

  // 单击文件夹行：切换折叠 + 选中该文件夹（使行内加号常显，不再仅 hover 可见）。
  // 先写选中态再折叠，折叠触发的重建会按 selected 恢复高亮；两者互不干扰。
  item.addEventListener("click", () => {
    const scope = item.closest(".sfe-git-view, .sfe-git-scroll");
    if (scope) {
      for (const prev of scope.querySelectorAll(".sfe-git-row.selected")) {
        prev.classList.remove("selected");
      }
    }
    item.classList.add("selected");
    if (typeof onSelectFolder === "function") onSelectFolder(node, section);
    if (typeof onToggleCollapse === "function") onToggleCollapse(section, node.path);
  });
  return item;
}

/**
 * 渲染文件行
 */
function renderFileRow(opts: GitFileRowOptions): HTMLDivElement {
  const {
    file,
    depth,
    section,
    selected,
    onSelectFile,
    onStageToggle,
    onDiscard,
    onOpenFile,
    onRevealFile,
    onCopyRelativePath,
    onCopyAbsolutePath,
    t,
  } = opts;
  const isStaged = section === "staged";
  const key = `${section}:${file.path}`;
  const isSelected = selected === key;

  const row = el("div", "sfe-git-row" + (isSelected ? " selected" : ""));
  row.style.paddingLeft = 12 + depth * 14 + "px";
  row.title = file.path + " · " + t("git.clickHint", "单击查看差异");

  const { name } = splitGitPath(file.path);
  const nameWrap = el("span", "sfe-git-name");
  nameWrap.appendChild(createFileIconNode(name, false, false));
  nameWrap.appendChild(el("span", "sfe-git-name-text" + (file.status === "D" ? " deleted" : ""), name));
  // 状态字母徽章排在整行最后（撤销/暂存按钮之后），对齐文件树里徽章在行尾的做法。
  // 徽章不放进 flex:1 的名称容器，避免长文件名把徽章挤到文件名右侧、也避免按钮浮在它左边。
  const meta = gitStatusMeta(file.status);
  row.appendChild(nameWrap);

  // 单击：就地更新选中样式并打开该文件的 Git 差异（不重建本列表 DOM）。
  // 关键：onOpenFile → openGitDiff 只重绘右侧查看器，不会重建列表，因此选中态与
  // 滚动位置不受影响；行内按钮一律 stopPropagation，避免误触发行打开。
  row.addEventListener("click", () => {
    const scope = row.closest(".sfe-git-view, .sfe-git-scroll");
    if (scope) {
      for (const prev of scope.querySelectorAll(".sfe-git-row.selected")) {
        prev.classList.remove("selected");
      }
    }
    row.classList.add("selected");
    if (typeof onSelectFile === "function") onSelectFile(file, section);
    if (typeof onOpenFile === "function") onOpenFile(file, section);
  });

  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openGitContextMenu(row.closest(".sfe-git-pane") || row.parentElement, event.clientX, event.clientY, file, section, {
      isStaged,
      onOpenFile,
      onRevealFile,
      onStageToggle,
      onDiscard,
      onCopyRelativePath,
      onCopyAbsolutePath,
      t,
    });
  });

  const makeBtn = (cls: string, iconName: string, title: string, handler: () => void): HTMLButtonElement => {
    const btn = el("button", "sfe-git-row-btn " + cls);
    btn.type = "button";
    btn.title = title;
    // 不做 busy 禁用（见 renderSection.actionBtn 注释：禁用会在列表重建后写死）。
    btn.appendChild(createActionIcon(iconName, 13));
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      handler();
    });
    return btn;
  };

  // 行内按钮顺序（从左到右）：撤销 → 暂存/取消暂存 → 状态字母（恒在最右）
  if (!isStaged && typeof onDiscard === "function") {
    row.appendChild(makeBtn("discard", "undo", t("git.discardFile", "丢弃更改"), () => onDiscard([file])));
  }

  row.appendChild(
    makeBtn(
      "stage-toggle",
      isStaged ? "minus" : "plus",
      isStaged ? t("git.unstageFile", "取消暂存") : t("git.stageFile", "暂存"),
      () => {
        if (typeof onStageToggle === "function") onStageToggle([file], section);
      }
    )
  );

  row.appendChild(el("span", "sfe-git-status " + meta.className, meta.letter));

  return row;
}

const GIT_CONTEXT_MENU_CLEANUP = "__sfeGitContextMenuCleanup";

/** 关闭 Git 文件行菜单，并移除其全局事件监听，避免列表刷新后残留监听器。 */
export function closeGitContextMenu(parentEl: Element | null | undefined): void {
  const cleanup = parentEl && parentEl[GIT_CONTEXT_MENU_CLEANUP];
  if (typeof cleanup === "function") {
    cleanup();
    return;
  }
  const menu = parentEl && parentEl.querySelector(".sfe-git-context-menu");
  const menuCleanup = menu && menu[GIT_CONTEXT_MENU_CLEANUP];
  if (typeof menuCleanup === "function") {
    menuCleanup();
  } else if (menu) {
    menu.remove();
  }
}

/**
 * 创建 Git 右键菜单骨架：统一清理、定位与菜单项构建，供文件行菜单与空白区菜单复用。
 * @param parentEl 菜单挂载容器（同时作为清理句柄的宿主）
 * @param x 视口坐标 X
 * @param y 视口坐标 Y
 * @returns addItem 追加菜单项；open 挂载并定位
 */
function createGitMenu(parentEl: Element, x: number, y: number): GitMenuHandle {
  const menu = el("div", "sfe-context-menu sfe-git-context-menu");
  menu.setAttribute("role", "menu");
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("click", handleOutsideClick, true);
    document.removeEventListener("keydown", handleEscape, true);
    menu.remove();
    if (parentEl[GIT_CONTEXT_MENU_CLEANUP] === cleanup) {
      delete parentEl[GIT_CONTEXT_MENU_CLEANUP];
    }
  };
  const handleOutsideClick = (event: MouseEvent) => {
    // 事件目标在浏览器里必然是节点；contains 只接受 Node。
    if (!menu.contains(event.target as Node | null)) cleanup();
  };
  const handleEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cleanup();
    }
  };
  const addItem = (
    id: string,
    label: string,
    iconName: string,
    action: () => void,
    { separator = false, disabled = false, danger = false }: GitMenuItemStyle = {},
  ) => {
    if (separator) menu.appendChild(el("div", "sfe-context-menu-separator"));
    const item = el("button", "sfe-context-menu-item sfe-git-context-menu-item" + (danger ? " danger" : ""));
    item.type = "button";
    item.disabled = disabled;
    item.setAttribute("role", "menuitem");
    item.dataset.menuId = id;
    item.appendChild(createActionIcon(iconName, 13));
    item.appendChild(el("span", "sfe-git-context-menu-label", label));
    item.addEventListener("click", () => {
      if (disabled) return;
      cleanup();
      action();
    });
    menu.appendChild(item);
  };
  const open = () => {
    menu[GIT_CONTEXT_MENU_CLEANUP] = cleanup;
    parentEl[GIT_CONTEXT_MENU_CLEANUP] = cleanup;
    parentEl.appendChild(menu);
    document.addEventListener("click", handleOutsideClick, true);
    document.addEventListener("keydown", handleEscape, true);
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, viewportWidth ? viewportWidth - rect.width - 4 : x));
    const top = Math.max(4, Math.min(y, viewportHeight ? viewportHeight - rect.height - 4 : y));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };
  return { addItem, open };
}

/**
 * 构建宿主 Git 文件行菜单：保持宿主项目顺序和分隔线，但明确不提供终端入口。
 */
function openGitContextMenu(
  parentEl: Element | null,
  x: number,
  y: number,
  file: GitFileStatus,
  section: GitSection,
  opts: GitRowMenuOptions,
): void {
  if (!parentEl) return;
  closeGitContextMenu(parentEl);

  const menu = createGitMenu(parentEl, x, y);
  const isDeleted = file.status === "D";
  menu.addItem("open", opts.t("git.openFile", "打开文件"), "fileText", () => {
    if (typeof opts.onOpenFile === "function") opts.onOpenFile(file, section);
  }, { disabled: isDeleted });
  menu.addItem("reveal", opts.t("git.revealInExplorer", "在资源管理器中打开"), "folderOpen", () => {
    if (typeof opts.onRevealFile === "function") opts.onRevealFile(file);
  }, { disabled: isDeleted });
  menu.addItem(
    "stage-toggle",
    section === "staged" ? opts.t("git.unstageFile", "取消暂存") : opts.t("git.stageFile", "暂存"),
    section === "staged" ? "minus" : "plus",
    () => {
      if (typeof opts.onStageToggle === "function") opts.onStageToggle([file], section);
    },
    { separator: true },
  );
  if (section !== "staged" && typeof opts.onDiscard === "function") {
    // 上面的 typeof 判定已保证可调用；闭包内类型层面无法沿用该判定。
    menu.addItem("discard", opts.t("git.discardFile", "丢弃更改"), "undo", () => opts.onDiscard!([file]), {
      danger: true,
    });
  }
  menu.addItem("copy-relative", opts.t("git.copyRelativePath", "复制相对路径"), "copy", () => {
    if (typeof opts.onCopyRelativePath === "function") opts.onCopyRelativePath(file);
  }, { separator: true });
  menu.addItem("copy-absolute", opts.t("git.copyAbsolutePath", "复制绝对路径"), "copy", () => {
    if (typeof opts.onCopyAbsolutePath === "function") opts.onCopyAbsolutePath(file);
  });
  // 刷新：重新拉取文件树与 Git 状态（与文件树右键菜单保持一致）
  menu.addItem("refresh", opts.t("action.refresh", "刷新"), "refresh", () => {
    if (typeof opts.onRefresh === "function") opts.onRefresh();
  }, { separator: true });
  menu.open();
}

/**
 * 构建 Git 目录行菜单：对该目录子树批量操作（暂存/取消暂存 / 丢弃 / 复制路径 / 资源管理器 / 刷新）。
 * @description 目录不是具体文件：资源管理器/复制路径/丢弃按「子树的第一个文件」定位其所在目录，
 *   与文件行菜单保持一致的条目集合。
 */
function openGitFolderContextMenu(
  parentEl: Element | null,
  x: number,
  y: number,
  node: GitTreeNode | null | undefined,
  section: GitSection,
  opts: GitRowMenuOptions,
): void {
  if (!parentEl || !node) return;
  closeGitContextMenu(parentEl);

  const files = collectGitTreeFiles(node);
  const first = files[0] || null;
  const isStaged = section === "staged";
  const menu = createGitMenu(parentEl, x, y);

  menu.addItem(
    "stage-toggle",
    isStaged ? opts.t("git.unstageFolder", "取消暂存此目录") : opts.t("git.stageFolder", "暂存此目录"),
    isStaged ? "minus" : "plus",
    () => {
      if (typeof opts.onStageToggle === "function") opts.onStageToggle(files, section);
    },
  );
  if (!isStaged && first && typeof opts.onDiscard === "function") {
    // 上面的 typeof 判定已保证可调用；闭包内类型层面无法沿用该判定。
    menu.addItem("discard", opts.t("git.discardFolder", "丢弃此目录更改"), "undo", () => opts.onDiscard!(files), {
      danger: true,
    });
  }
  menu.addItem("reveal", opts.t("git.revealInExplorer", "在资源管理器中打开"), "folderOpen", () => {
    if (first && typeof opts.onRevealFile === "function") opts.onRevealFile(first);
  }, { separator: true });
  menu.addItem("copy-relative", opts.t("git.copyRelativePath", "复制相对路径"), "copy", () => {
    if (first && typeof opts.onCopyRelativePath === "function") opts.onCopyRelativePath(first);
  });
  menu.addItem("copy-absolute", opts.t("git.copyAbsolutePath", "复制绝对路径"), "copy", () => {
    if (first && typeof opts.onCopyAbsolutePath === "function") opts.onCopyAbsolutePath(first);
  });
  menu.addItem("refresh", opts.t("action.refresh", "刷新"), "refresh", () => {
    if (typeof opts.onRefresh === "function") opts.onRefresh();
  }, { separator: true });
  menu.open();
}

/**
 * 构建 Git 空白区（非文件行）菜单：仓库级操作（刷新 / 全部暂存 / 全部取消暂存）。
 * @description 复用文件行菜单的清理约定，使 closeGitContextMenu 与列表重建能统一回收。
 */
function openGitPaneContextMenu(
  parentEl: Element | null,
  x: number,
  y: number,
  opts: GitViewOptions,
): void {
  if (!parentEl) return;
  closeGitContextMenu(parentEl);

  const menu = createGitMenu(parentEl, x, y);
  const busy = opts.busy !== null && opts.busy !== undefined;
  const isRepo = !!(opts.gitStatus && opts.gitStatus.isRepo);
  const { staged, unstaged } = isRepo
    ? partitionGitFiles(opts.gitStatus!.files)
    : { staged: [], unstaged: [] };

  menu.addItem("refresh", opts.t("action.refresh", "刷新"), "refresh", () => {
    if (typeof opts.onRefresh === "function") opts.onRefresh();
  });
  // 仅当对应分区存在文件时才提供批量操作，避免空白区出现无效菜单项
  if (unstaged.length) {
    menu.addItem("stage-all", opts.t("git.stageAll", "全部暂存"), "plus", () => {
      if (typeof opts.onStageAll === "function") opts.onStageAll();
    }, { separator: true, disabled: busy });
  }
  if (staged.length) {
    menu.addItem("unstage-all", opts.t("git.unstageAll", "全部取消暂存"), "minus", () => {
      if (typeof opts.onUnstageAll === "function") opts.onUnstageAll();
    }, { separator: unstaged.length === 0, disabled: busy });
  }
  menu.open();
}

/**
 * 在直接子节点中查找带指定类名的元素（避免 querySelector 递归误匹配）
 */
function findDirectChild(parent: Element | null | undefined, cls: string): HTMLElement | null {
  if (!parent) return null;
  for (const child of parent.children) {
    if (child.classList && child.classList.contains(cls)) {
      // 本函数只用于查找插件自建的 div/button 容器（类名均为 div/button），故为 HTMLElement。
      return child as HTMLElement;
    }
  }
  return null;
}

/**
 * 仅在图标变化时替换按钮内的图标（图标为按钮唯一子节点时使用）
 */
function setButtonIcon(btn: HTMLElement, name: string, size: number): void {
  if (btn.getAttribute("data-sfe-icon") === name) return;
  btn.setAttribute("data-sfe-icon", name);
  btn.replaceChildren(createActionIcon(name, size));
}
