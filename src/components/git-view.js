/**
 * Git 变更视图组件 (src/components/git-view.js)
 * 复刻宿主 Git 面板核心：提交信息输入框（含 AI 生成）+ 提交/提交并推送 split 按钮
 * +「已暂存的变更 / 变更」两个按目录分组的树形列表。纯 DOM 渲染，数据与回调由 index.js 注入。
 *
 * 结构复用约定（关键）：
 *  - renderGitCommitBar 首次调用创建结构并绑定事件，之后只做「就地更新」，
 *    绝不重建 textarea —— 宿主 git watcher 高频刷新时，重建会打断正在进行的
 *    输入、右键菜单与文本选区（见 index.js 的渲染分派）。
 *  - renderGitList 只重建列表滚动区的内部内容（滚动容器本身保留，滚动位置不丢）。
 */

import { el } from "../utils/dom.js";
import { createActionIcon } from "../icons/action-icons.js";
import { createFileIconNode } from "../icons/file-icons.js";
import {
  partitionGitFiles,
  gitStatusMeta,
  splitGitPath,
  buildGitFileTree,
  flattenGitTree,
  countGitTreeFiles,
  collectGitTreeFiles,
} from "../services/git-service.js";

/**
 * 渲染（或就地更新）Git 提交信息区
 * @param {HTMLElement} parentEl Git 面板容器（提交区会被置于最上方）
 * @param {Object} opts 与 renderGitList 共享的选项对象（见下方字段说明）
 * @param {string} opts.commitMessage 提交信息草稿
 * @param {string|null} opts.busy 进行中的操作名
 * @param {boolean} opts.generating 是否正在生成提交信息
 * @param {'commit'|'commitAndPush'} opts.commitMode 提交按钮模式
 * @param {boolean} opts.commitMenuOpen 提交模式下拉是否展开
 * @param {number} opts.stagedCount 已暂存文件数
 * @param {Function} opts.onCommit 提交回调
 * @param {Function} opts.onCommitAndPush 提交并推送回调
 * @param {Function} opts.onSetCommitMode 设置提交模式回调 (mode)
 * @param {Function} opts.onToggleCommitMenu 切换提交模式下拉
 * @param {Function} opts.onGenerate 生成/中止提交信息回调
 * @param {Function} opts.onCommitMessageInput 提交信息输入回调 (value)
 * @param {Function} opts.t 国际化翻译函数
 */
export function renderGitCommitBar(parentEl, opts) {
  let bar = findDirectChild(parentEl, "sfe-git-commit");
  if (!bar) {
    bar = buildCommitBar(opts);
    parentEl.insertBefore(bar, parentEl.firstChild);
  }
  syncCommitBar(bar, opts);
}

/**
 * 渲染 Git 变更列表（已暂存 / 变更两个分区，按目录分组）
 * @param {HTMLElement} parentEl Git 面板容器
 * @param {Object} opts
 * @param {Object|null} opts.gitStatus 完整 Git 状态（GitStatusResult）
 * @param {string|null} opts.selected 当前选中键（`section:path`）
 * @param {string|null} opts.busy 进行中的操作名
 * @param {Set<string>} opts.collapsedStaged 已暂存区折叠目录
 * @param {Set<string>} opts.collapsedUnstaged 变更区折叠目录
 * @param {Function} opts.onSelectFile 选中文件回调 (file, section)
 * @param {Function} opts.onStageToggle 暂存/取消暂存回调 (files, section)
 * @param {Function} opts.onStageAll 全部暂存回调
 * @param {Function} opts.onUnstageAll 全部取消暂存回调
 * @param {Function} opts.onDiscard 丢弃改动回调 (files)
 * @param {Function} opts.onToggleCollapse 折叠/展开目录回调 (section, path)
 * @param {Function} opts.onOpenFile 单击文件行打开差异回调 (file, section)
 * @param {Function} opts.onRevealFile 在资源管理器中打开文件回调 (file)
 * @param {Function} opts.onCopyRelativePath 复制相对路径回调 (file)
 * @param {Function} opts.onCopyAbsolutePath 复制绝对路径回调 (file)
 * @param {Function} opts.t 国际化翻译函数
 */
export function renderGitList(parentEl, opts) {
  const { gitStatus, t } = opts;
  closeGitContextMenu(parentEl);
  let scroll = findDirectChild(parentEl, "sfe-git-scroll");
  if (!scroll) {
    scroll = el("div", "sfe-git-scroll");
    // 空白区右键：文件行自身处理并阻止冒泡，其余区域在此兜底弹出仓库级菜单。
    // 监听器只绑一次（scroll 复用），通过节点上的最新 opts 避免闭包过期。
    scroll.addEventListener("contextmenu", (event) => {
      if (event.target?.closest?.(".sfe-git-row")) return;
      event.preventDefault();
      const latest = scroll.__sfeGitListOpts;
      if (latest) openGitPaneContextMenu(scroll.parentElement, event.clientX, event.clientY, latest);
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
function buildCommitBar(opts) {
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
function syncCommitBar(bar, opts) {
  const { commitMessage, busy, generating, commitMode, commitMenuOpen, stagedCount, t } = opts;
  const textarea = bar.querySelector(".sfe-git-commit-input");
  const aiBtn = bar.querySelector(".sfe-git-ai-btn");
  const primary = bar.querySelector(".sfe-git-commit-btn");
  const caret = bar.querySelector(".sfe-git-commit-caret");
  const split = bar.querySelector(".sfe-git-commit-split");

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
  const label = primary.querySelector(".sfe-git-commit-btn-label");
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
function buildCommitMenu(opts) {
  const { commitMode, t } = opts;
  const menu = el("div", "sfe-git-commit-menu");
  const option = (mode, label) => {
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
function renderSection(opts) {
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
function renderFolderRow(opts) {
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
  item.lastChild.appendChild(createActionIcon(isExpanded ? "chevronDown" : "chevronRight", 13));
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
function renderFileRow(opts) {
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

  const meta = gitStatusMeta(file.status);
  row.appendChild(el("span", "sfe-git-status " + meta.className, meta.letter));

  const { name } = splitGitPath(file.path);
  const nameWrap = el("span", "sfe-git-name");
  nameWrap.appendChild(createFileIconNode(name, false, false));
  nameWrap.appendChild(el("span", "sfe-git-name-text" + (file.status === "D" ? " deleted" : ""), name));
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

  const makeBtn = (cls, iconName, title, handler) => {
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

  // 行内按钮顺序（从左到右）：撤销 → 暂存/取消暂存（加号/减号恒在最右）
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

  return row;
}

const GIT_CONTEXT_MENU_CLEANUP = "__sfeGitContextMenuCleanup";

/** 关闭 Git 文件行菜单，并移除其全局事件监听，避免列表刷新后残留监听器。 */
export function closeGitContextMenu(parentEl) {
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
 * @param {HTMLElement} parentEl 菜单挂载容器（同时作为清理句柄的宿主）
 * @param {number} x 视口坐标 X
 * @param {number} y 视口坐标 Y
 * @returns {{addItem: Function, open: Function}} addItem 追加菜单项；open 挂载并定位
 */
function createGitMenu(parentEl, x, y) {
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
  const handleOutsideClick = (event) => {
    if (!menu.contains(event.target)) cleanup();
  };
  const handleEscape = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cleanup();
    }
  };
  const addItem = (id, label, iconName, action, { separator = false, disabled = false, danger = false } = {}) => {
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
function openGitContextMenu(parentEl, x, y, file, section, opts) {
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
    menu.addItem("discard", opts.t("git.discardFile", "丢弃更改"), "undo", () => opts.onDiscard([file]), {
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
function openGitFolderContextMenu(parentEl, x, y, node, section, opts) {
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
    menu.addItem("discard", opts.t("git.discardFolder", "丢弃此目录更改"), "undo", () => opts.onDiscard(files), {
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
function openGitPaneContextMenu(parentEl, x, y, opts) {
  if (!parentEl) return;
  closeGitContextMenu(parentEl);

  const menu = createGitMenu(parentEl, x, y);
  const busy = opts.busy !== null && opts.busy !== undefined;
  const isRepo = !!(opts.gitStatus && opts.gitStatus.isRepo);
  const { staged, unstaged } = isRepo
    ? partitionGitFiles(opts.gitStatus.files)
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
function findDirectChild(parent, cls) {
  if (!parent) return null;
  for (const child of parent.children) {
    if (child.classList && child.classList.contains(cls)) return child;
  }
  return null;
}

/**
 * 仅在图标变化时替换按钮内的图标（图标为按钮唯一子节点时使用）
 */
function setButtonIcon(btn, name, size) {
  if (btn.getAttribute("data-sfe-icon") === name) return;
  btn.setAttribute("data-sfe-icon", name);
  btn.replaceChildren(createActionIcon(name, size));
}
