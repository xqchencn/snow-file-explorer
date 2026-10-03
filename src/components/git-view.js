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
  gitSyncCounts,
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
 * @param {Function} opts.t 国际化翻译函数
 */
export function renderGitList(parentEl, opts) {
  const { gitStatus, t } = opts;
  let scroll = findDirectChild(parentEl, "sfe-git-scroll");
  if (!scroll) {
    scroll = el("div", "sfe-git-scroll");
    parentEl.appendChild(scroll);
  }
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
 * 渲染（或就地更新）底部同步栏（对标 VS Code SCM 视图底部）
 * @description 结构只创建一次，之后仅就地更新，避免重建导致闪烁。
 *   左侧：当前分支下拉 + 同步按钮；右侧：↓未拉取 / ↑未推送计数。
 *   同步按钮执行 pull → 刷新状态 → push，不是单纯重新读取本地状态。
 *   计数始终显示：为 0 时呈灰色且点击无效，>0 时上色（↓ 橙 / ↑ 蓝）且点击分别执行拉取/推送。
 * @param {HTMLElement} parentEl 底栏容器（文件树视图与 Git 变更视图共用同一条底栏）
 * @param {Object} opts 见 renderGitList 选项；额外使用
 *   rootPath / busy / syncBusy / onSync / onPull / onPush / loadBranches / onCheckout
 */
export function renderGitSyncBar(parentEl, opts) {
  const { gitStatus, busy, syncBusy, branchBusy, onSync, onPull, onPush, t } = opts;
  let bar = findDirectChild(parentEl, "sfe-git-sync");
  if (!bar) {
    bar = el("div", "sfe-git-sync");

    const left = el("div", "sfe-git-sync-left");
    // 分支下拉：显示当前分支，点击展开分支列表（内容由 syncBranchMenu 异步填充）
    const branchWrap = el("div", "sfe-git-branch");
    const branchBtn = el("button", "sfe-git-branch-btn");
    branchBtn.type = "button";
    branchBtn.setAttribute("aria-haspopup", "true");
    branchBtn.appendChild(createActionIcon("branch", 12));
    branchBtn.appendChild(el("span", "sfe-git-branch-name"));
    branchBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleBranchTrigger(branchWrap, opts);
    });
    branchWrap.appendChild(branchBtn);
    left.appendChild(branchWrap);

    const syncBtn = el("button", "sfe-git-sync-btn");
    syncBtn.type = "button";
    syncBtn.title = t("action.sync", "同步");
    syncBtn.appendChild(createActionIcon("sync", 13));
    syncBtn.addEventListener("click", () => {
      if (typeof onSync === "function") onSync();
    });
    left.appendChild(syncBtn);
    bar.appendChild(left);

    const counts = el("div", "sfe-git-sync-counts");
    // 顺序：先「未拉取」（↓，来自远端）后「未推送」（↑，发往远端），与 VS Code 一致
    counts.appendChild(
      makeSyncCount("behind", "pull", "arrowDown", "git.behindCount", "{{count}} 个提交待拉取", onPull)
    );
    counts.appendChild(
      makeSyncCount("ahead", "push", "arrowUp", "git.aheadCount", "{{count}} 个提交待推送", onPush)
    );
    bar.appendChild(counts);

    parentEl.appendChild(bar);
  }

  const isRepo = !!(gitStatus && gitStatus.isRepo);
  const busyNow = busy !== null;

  // 分支按钮：非仓库 / 忙碌时禁用；文案为当前分支名（分离 HEAD 或非仓库用占位文案）
  const branchBtn = bar.querySelector(".sfe-git-branch-btn");
  if (branchBtn) {
    const branch = isRepo ? String((gitStatus && gitStatus.currentBranch) || "").trim() : "";
    const label = branch || t("git.noBranch", "无分支");
    const nameEl = branchBtn.querySelector(".sfe-git-branch-name");
    if (nameEl.textContent !== label) nameEl.textContent = label;
    const title = branch
      ? `${t("git.switchBranch", "切换分支")}: ${branch}`
      : t("git.noBranch", "无分支");
    if (branchBtn.title !== title) branchBtn.title = title;
    branchBtn.disabled = !isRepo || busyNow || !!syncBusy || !!branchBusy;
  }

  const syncBtn = bar.querySelector(".sfe-git-sync-btn");
  if (syncBtn) {
    // 同步进行中按钮持续播放上下方向的双向箭头动画，并禁用避免重复触发。
    syncBtn.disabled = busyNow || !!syncBusy || !!branchBusy;
    syncBtn.classList.toggle("syncing", !!syncBusy);
  }

  const counts = bar.querySelector(".sfe-git-sync-counts");
  if (counts) counts.hidden = !isRepo;
  // 非仓库时隐藏整个计数区；仓库内计数始终显示，按数量切换灰色/彩色。
  if (isRepo) {
    const { ahead, behind } = gitSyncCounts(gitStatus);
    for (const [key, n] of [["behind", behind], ["ahead", ahead]]) {
      const item = bar.querySelector(`.sfe-git-sync-count[data-sync="${key}"]`);
      if (!item) continue;
      // 0 → .zero 呈灰色且点击无效；>0 上色可点。
      item.classList.toggle("zero", n <= 0);
      // <span> 没有 disabled IDL 属性（不会反射为 [disabled] 特性），
      // 忙碌态改用 class 标记，CSS 依据 .is-disabled 呈现禁用外观。
       if (item.classList.contains("clickable")) {
         item.classList.toggle("is-disabled", busyNow || !!syncBusy || !!branchBusy);
       }
       item.classList.toggle("pulling", key === "behind" && busy === "pull");
       item.classList.toggle("pushing", key === "ahead" && busy === "push");
       const value = item.querySelector(".sfe-git-sync-value");
      const text = String(n);
      if (value && value.textContent !== text) value.textContent = text;
      const title = t(item.dataset.titleKey, item.dataset.titleDefault, { count: n });
      if (item.title !== title) item.title = title;
    }
  }
}

/**
 * 重置同步栏骨架
 * @description 视图切换会清空主视图，缓存的分支下拉节点随之脱离文档；
 *   重建底栏前先移除旧节点，避免复用已脱离的 DOM。
 * @param {HTMLElement} parentEl 底栏容器
 */
export function resetGitSyncBar(parentEl) {
  const bar = parentEl && findDirectChild(parentEl, "sfe-git-sync");
  if (bar) bar.remove();
}

/**
 * 点击分支按钮：展开 / 收起分支下拉（每次展开都重新拉取，保证列表最新）
 */
function handleBranchTrigger(branchWrap, opts) {
  const existing = branchWrap.querySelector(".sfe-git-branch-menu");
  if (existing) {
    existing.remove();
    return;
  }
  const menu = el("div", "sfe-git-branch-menu");
  // 阻止冒泡，避免触发文档级「点击外部关闭」而立即收起
  menu.addEventListener("click", (e) => e.stopPropagation());
  menu.appendChild(el("div", "sfe-git-branch-empty", opts.t("status.loading", "加载中…")));
  branchWrap.appendChild(menu);
  void syncBranchMenu(branchWrap, opts);
}

/**
 * 拉取分支列表并填充下拉（当前分支置顶，已检出 / 已被其他工作区占用的分支禁用）
 */
async function syncBranchMenu(branchWrap, opts) {
  const { rootPath, onCheckout, loadBranches, t } = opts;
  const menu = branchWrap.querySelector(".sfe-git-branch-menu");
  if (!menu || typeof loadBranches !== "function") return;
  const branches = await loadBranches(rootPath);
  // 异步返回时用户可能已收起下拉或切换视图，节点脱离文档则直接放弃
  if (!menu.isConnected) return;
  menu.replaceChildren();
  if (!Array.isArray(branches) || branches.length === 0) {
    menu.appendChild(el("div", "sfe-git-branch-empty", t("git.noBranches", "无可用分支")));
    return;
  }
  const current = branches.find((b) => b && b.isCurrent && !b.isRemote);
  // 当前分支置顶；本地分支在前、远程分支在后；同组按名称排序
  const ordered = [...branches].sort((a, b) => {
    if (a === current) return -1;
    if (b === current) return 1;
    if (!!a.isRemote !== !!b.isRemote) return a.isRemote ? 1 : -1;
    return String(a.name).localeCompare(String(b.name));
  });
  for (const branch of ordered) {
    if (!branch || !branch.name) continue;
    // 当前分支、被其他 worktree 占用的分支不可切换；已有同名本地分支时隐藏对应远程条目（避免重复）
    const isDisabled =
      branch.isCurrent || !!branch.worktreePath || (!!branch.isRemote && !!current);
    const item = el("button", "sfe-git-branch-item" + (branch.isCurrent ? " current" : ""));
    item.type = "button";
    item.disabled = isDisabled;
    item.appendChild(el("span", "sfe-git-branch-item-name", branch.name));
    if (branch.isCurrent) {
      item.appendChild(el("span", "sfe-git-branch-tag", t("git.currentBranchTag", "当前")));
    } else if (branch.isRemote) {
      item.appendChild(el("span", "sfe-git-branch-tag", t("git.remoteBranchTag", "远程")));
    }
    if (!isDisabled) {
      item.addEventListener("click", () => {
        menu.remove();
        if (typeof onCheckout === "function") onCheckout(branch);
      });
    }
    menu.appendChild(item);
  }
}

/**
 * 创建一个同步计数项（图标 + 数字），数字与图标同色
 * @param {'ahead'|'behind'} key 计数键
 * @param {'push'|'pull'} dirClass 方向样式类（push=蓝 / pull=橙）
 * @param {'arrowUp'|'arrowDown'} icon 箭头方向
 * @param {string} titleKey i18n 键
 * @param {string} titleDefault i18n 默认文案
 * @param {Function} [onClick] 点击回调（↓ 拉取 / ↑ 推送）；为 0 时点击不触发
 */
function makeSyncCount(key, dirClass, icon, titleKey, titleDefault, onClick) {
  const item = el("span", `sfe-git-sync-count ${dirClass} zero`);
  item.setAttribute("data-sync", key);
  item.setAttribute("data-title-key", titleKey);
  item.setAttribute("data-title-default", titleDefault);
  const label = el("span", "sfe-git-sync-label");
  label.appendChild(createActionIcon(icon, 12));
  label.appendChild(el("span", "sfe-git-sync-value"));
  item.appendChild(label);
  if (typeof onClick === "function") {
    item.classList.add("clickable");
    item.addEventListener("click", () => {
      // 无待同步提交（灰色）或忙碌中时忽略，避免无意义的空拉/空推与并发操作。
      if (item.classList.contains("zero") || item.classList.contains("is-disabled")) return;
      onClick();
    });
  }
  return item;
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
    busy,
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
    actionBtn.disabled = busy !== null;
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
          ? renderFolderRow({ row, section, selected, onSelectFolder, onToggleCollapse, onStageToggle, busy, t })
          : renderFileRow({
              file: row.file,
              depth: row.depth,
              section,
              selected,
              busy,
              onSelectFile,
              onStageToggle,
              onDiscard,
              onOpenFile,
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
  const { row, section, selected, onSelectFolder, onToggleCollapse, onStageToggle, busy, t } = opts;
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

  // 目录级暂存/取消暂存：对整个子树生效，按钮恒在最右（与文件行一致）
  if (typeof onStageToggle === "function") {
    const btn = el("button", "sfe-git-row-btn stage-toggle");
    btn.type = "button";
    btn.title = isStaged ? t("git.unstageFolder", "取消暂存此目录") : t("git.stageFolder", "暂存此目录");
    btn.disabled = busy !== null;
    btn.appendChild(createActionIcon(isStaged ? "minus" : "plus", 13));
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onStageToggle(collectGitTreeFiles(node), section);
    });
    item.appendChild(btn);
  }

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
  const { file, depth, section, selected, busy, onSelectFile, onStageToggle, onDiscard, onOpenFile, t } = opts;
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

  const makeBtn = (cls, iconName, title, handler) => {
    const btn = el("button", "sfe-git-row-btn " + cls);
    btn.type = "button";
    btn.title = title;
    btn.disabled = busy !== null;
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
