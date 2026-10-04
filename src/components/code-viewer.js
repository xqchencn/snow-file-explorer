/**
 * 代码预览组件模块 (src/components/code-viewer.js)
 * 渲染对标 Snow App 官方 FileViewerContent 组件规范：行号槽、悬浮复制代码按钮、图片展示与异常提示；
 * 额外按 gitView 渲染 Git 变更文件的差异视图（「差异/内容」切换控件在工具栏，见 index.js；
 * 差异视图见 components/diff-view.js）。
 */

import { el, escapeHtml, copyToClipboard } from "../utils/dom.js";
import { highlightCodeHtml, shouldHighlight, isLargeText } from "./highlighter.js";
import { createVirtualList } from "./virtual-list.js";
import { createActionIcon } from "../icons/action-icons.js";
import { resolveMarkdownAssetPath, resolveProxiedImageSrc } from "../services/markdown-asset.js";
import { extname, relativePath } from "../services/file-service.js";
import { renderDiffView } from "./diff-view.js";
import { findScriptLines } from "../services/package-scripts.js";

const VIEWER_CONTEXT_MENU_BINDING = "__sfeViewerContextMenuBinding";
const VIEWER_CONTEXT_MENU_CLEANUP = "__sfeViewerContextMenuCleanup";

/**
 * 构造行内「运行」按钮（对标 IDEA editor gutter 的 npm script 运行图标）。
 * @param {Object} command 命令对象（{ id, cmd, labelFallback }）
 * @param {Function} onRunCommand 运行回调 (command) => void
 * @param {Function} t 翻译函数
 * @returns {HTMLElement}
 */
function createGutterRunButton(command, onRunCommand, t) {
  const btn = el("button", "sfe-file-viewer-gutter-run");
  btn.type = "button";
  btn.title = `${t("run.gutterRun", "运行")}: ${command.cmd || command.labelFallback || ""}`;
  btn.setAttribute("aria-label", btn.title);
  btn.appendChild(createActionIcon("play", 10));
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (typeof onRunCommand === "function") onRunCommand(command);
  });
  return btn;
}

/**
 * 若当前预览是 package.json，返回「行号（1 基）→ 命令」映射，供行号槽渲染 ▶。
 * @description 先按 package.json 所在目录筛选命令，再按 script 名匹配，避免把子包命令误判为根包命令。
 * @param {Object|null} preview 预览状态
 * @param {Function} [runCommands] 读取扁平命令列表
 * @param {string} [rootPath] 工作区根目录路径
 * @returns {Map<number, Object>}
 */
function buildScriptCommandMap(preview, runCommands, rootPath) {
  const map = new Map();
  if (!preview || preview.kind !== "text" || preview.name !== "package.json") return map;
  if (typeof runCommands !== "function") return map;
  const commands = runCommands();
  if (!Array.isArray(commands) || !commands.length) return map;

  // preview.path 是绝对路径，命令 dir 是相对工作区路径；统一通过现有路径服务转换后再比较。
  const relativePackagePath = rootPath ? relativePath(rootPath, preview.path) : "package.json";
  const normalizedPackagePath = String(relativePackagePath || "").replace(/\\/g, "/");
  if (!normalizedPackagePath || !/package\.json$/i.test(normalizedPackagePath)) return map;
  const packageDir = normalizedPackagePath.replace(/\/package\.json$/i, "").replace(/^\.\/+/, "");
  const packageDirKey = packageDir.toLowerCase();
  const packageCommands = commands.filter((command) => {
    const commandDir = typeof command?.dir === "string" ? command.dir : command?.group || "";
    return commandDir.replace(/\\/g, "/").replace(/^\.\/+|\/+$/g, "").toLowerCase() === packageDirKey;
  });

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

/** 关闭预览区右键菜单及 document 级监听，避免预览重绘后菜单残留。 */
function closeViewerContextMenu(bodyEl) {
  const bindingCleanup = bodyEl && bodyEl[VIEWER_CONTEXT_MENU_BINDING];
  if (typeof bindingCleanup === "function") {
    bindingCleanup();
    return;
  }
  const menuCleanup = bodyEl && bodyEl[VIEWER_CONTEXT_MENU_CLEANUP];
  if (typeof menuCleanup === "function") menuCleanup();
  else bodyEl?.ownerDocument?.querySelector(".sfe-viewer-context-menu")?.remove();
}

function clearViewerContextMenu(bodyEl) {
  const menuCleanup = bodyEl && bodyEl[VIEWER_CONTEXT_MENU_CLEANUP];
  if (typeof menuCleanup === "function") {
    menuCleanup();
    return;
  }
  bodyEl?.ownerDocument?.querySelector(".sfe-viewer-context-menu")?.remove();
}

/** 绑定打开文件内容区的菜单；文件操作与文本编辑动作共用一个菜单。 */
function bindViewerContextMenu(bodyEl, opts) {
  if (!bodyEl) return;
  const handleContextMenu = (event) => {
    if (event.target?.closest?.(".sfe-viewer-context-menu")) return;
    event.preventDefault();
    event.stopPropagation();
    // 即使当前无文件（空态）也弹菜单：仓库级操作（如刷新）不依赖已打开文件；
    //   具体哪些菜单项可用由 openViewerContextMenu 按已注入的回调决定。
    openViewerContextMenu(bodyEl, event.clientX, event.clientY, event.target, opts);
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

function getViewerSelection(target) {
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
function replaceViewerSelection(selection, text) {
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
function openViewerContextMenu(bodyEl, x, y, target, opts) {
  clearViewerContextMenu(bodyEl);
  const { editable, onRefresh, onRevealFile, onCopyPath, onCopyRelativePath, runCommands, onRunCommand, t } = opts;
  const selection = getViewerSelection(target);
  const hasFileActions =
    typeof onRevealFile === "function" ||
    typeof onCopyPath === "function" ||
    typeof onCopyRelativePath === "function";
  const isEditableText = editable === true && !!selection.target;
  // 刷新：重新从磁盘读取当前文件，仅只读态提供（编辑态会丢弃未保存修改，必须禁用）。
  const canRefresh = editable !== true && typeof onRefresh === "function";
  // 运行分组：注入命令来源后才出现（预览 package.json 等场景）。
  const canRun = typeof runCommands === "function" && typeof onRunCommand === "function";
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
  const handleOutsideClick = (event) => {
    if (!menu.contains(event.target)) cleanup();
  };
  const handleEscape = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    cleanup();
  };
  const addSeparator = () => {
    if (menu.childElementCount > 0) menu.appendChild(el("div", "sfe-context-menu-separator"));
  };
  const addItem = (id, label, icon, action, disabled = false) => {
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

  let pasteItem = null;
  if (isEditableText) {
    if (selection.text) addSeparator();
    pasteItem = addItem("paste", t("action.paste", "粘贴"), "clipboardPaste", async () => {
      const text = pasteItem.dataset.clipboardText || (await readViewerClipboardText());
      if (text) replaceViewerSelection(selection, text);
    }, true);
    void readViewerClipboardText().then((text) => {
      if (!pasteItem.isConnected) return;
      pasteItem.dataset.clipboardText = text;
      pasteItem.disabled = !text;
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
  // 运行分组：列出该项目全部可运行命令（npm scripts），命中几条渲染几条（对齐 IDEA 右键 Run）。
  // 多 package.json：按包（文件夹）分组并加组标题，父包由数据层排在前。
  if (canRun) {
    const commands = runCommands();
    if (Array.isArray(commands) && commands.length) {
      addSeparator();
      let lastGroup;
      for (const command of commands) {
        const group = command.group || null;
        if (group !== lastGroup) {
          menu.appendChild(el("div", "sfe-context-menu-group", group || t("run.groupRoot", "根目录")));
          lastGroup = group;
        }
        const label = command.labelKey ? t(command.labelKey, command.labelFallback) : command.labelFallback;
        addItem(`run:${command.id}`, `${t("run.menuRun", "运行")} · ${label}`, "play", () =>
          onRunCommand(command)
        );
      }
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
 * @param {HTMLElement} bodyEl 承载预览内容的容器 DOM
 * @param {Object} options
 * @param {Object} options.preview 预览状态对象 { kind, text, highlightedHtml, url, name, mime, message, diff?, gitView? }
 * @param {string} [options.rootPath] 工作区根目录路径，用于匹配 package.json 所属包
 * @param {boolean} options.copied 是否刚点击过复制按钮
 * @param {Function} options.onCopy 点击复制回调
 * @param {Function} options.onSetMode 切换预览/代码模式回调 (mode: 'preview' | 'code')
 * @param {Function} options.onSetDiffMode 切换差异展示模式回调 (mode: 'unified' | 'split')
 * @param {Function} [options.onToggleEdit] 切换只读/编辑状态回调
 * @param {Function} [options.onEditInput] 编辑文本变化回调
 * @param {Function} [options.onSave] 保存当前文本回调
 * @param {Function} [options.onRevealFile] 在资源管理器中打开当前文件回调
 * @param {Function} [options.onCopyPath] 复制当前文件绝对路径回调
 * @param {Function} [options.onCopyRelativePath] 复制当前文件相对路径回调
 * @param {Function} [options.onRefresh] 重新读取当前文件回调（仅只读态显示，编辑态不显示）
 * @param {boolean} [options.editable=false] 当前是否处于编辑状态
 * @param {boolean} [options.saving=false] 是否正在保存
 * @param {string} [options.emptyHint] 无文件时空态提示文案（默认「选择一个文件即可预览。」）
 * @param {Function} options.t 本地化翻译函数
 */
export function renderCodeViewer(
  bodyEl,
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
    onRunCommand,
    editable = false,
    saving = false,
    emptyHint,
    t,
  }
) {
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
    editable,
    onEditInput,
    onRefresh,
    onRevealFile,
    onCopyPath,
    onCopyRelativePath,
    runCommands,
    onRunCommand,
    t,
  });

  if (!preview) {
    const empty = el("div", "sfe-file-viewer-empty");
    // 允许调用方覆盖空态提示（如 Git 右侧查看器：「选择左侧变更文件查看差异」）。
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
        fullContent: preview.diff.fullContent ?? preview.text ?? null,
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
      const segments = [
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
      // 编辑态使用高亮层 + 透明文字 textarea：textarea 负责真实输入，高亮层只负责显示。
      // 同时复用 sfe-file-viewer-code 作用域，使现有语法 token 配色覆盖编辑层。
      const editScroll = el("div", "sfe-file-viewer-edit-scroll");
      const editHighlight = el("pre", "sfe-file-viewer-edit-highlight sfe-file-viewer-code");
      editHighlight.setAttribute("aria-hidden", "true");
      const updateEditHighlight = (value) => {
        const source = String(value ?? "");
        // 编辑态每次输入都会重建高亮层：超大文件逐次全量 Prism 会随按键持续阻塞主线程。
        // 超过熔断阈值时编辑层退化为纯文本转义，真实输入仍由 textarea 承载。
        editHighlight.innerHTML = shouldHighlight(source)
          ? highlightCodeHtml(source, extname(preview.name)) || escapeHtml(source)
          : escapeHtml(source);
        // 保留末尾空行的高度，避免输入换行后高亮层比 textarea 少一行。
        if (source.endsWith("\n")) editHighlight.appendChild(document.createTextNode(" "));
      };
      updateEditHighlight(preview.text);

      const textarea = document.createElement("textarea");
      textarea.className = "sfe-file-viewer-textarea";
      textarea.value = String(preview.text || "");
      textarea.wrap = "off";
      textarea.spellcheck = false;
      textarea.setAttribute("aria-label", t("action.edit", "编辑文件"));
      if (typeof onEditInput === "function") {
        textarea.addEventListener("input", () => {
          updateEditHighlight(textarea.value);
          onEditInput(textarea.value);
        });
      }
      editScroll.appendChild(editHighlight);
      editScroll.appendChild(textarea);
      bodyEl.appendChild(editScroll);
    } else {
      // 只读态：小文件整块高亮；大文件用窗口化虚拟列表，只渲染可视行。
      const scroll = el("div", "sfe-file-viewer-code-scroll");
      const rawText = String(preview.text || "");
      const linesArray = rawText.split(/\r\n|\r|\n/);
      // package.json 的 scripts 行 → 命令映射（行号槽 / 虚拟行内渲染 ▶，两分支共用）
      const scriptCommandMap = buildScriptCommandMap(preview, runCommands, rootPath);

      // 大文件已被高亮熔断降级为纯文本，逐行渲染不会切坏跨行 token；
      // 虚拟列表只渲染「可视区 + 缓冲」的行，DOM 数量与总行数解耦，因此无需截断内容。
      // 小文件仍整块高亮，避免把多行注释 / 字符串的跨行 token 按行切碎。
      if (isLargeText(rawText)) {
        scroll.classList.add("sfe-file-viewer-code-scroll-virtual");
        bodyEl.appendChild(scroll);
        const list = createVirtualList({
          viewport: scroll,
          renderRow: (lineText, index) => {
            const row = el("div", "sfe-file-viewer-line");
            row.appendChild(el("span", "sfe-file-viewer-line-no", String(index + 1)));
            // package.json 的 scripts 行内追加 ▶（与整块高亮模式一致的 gutter 运行入口）
            const command = scriptCommandMap.get(index + 1);
            if (command) row.appendChild(createGutterRunButton(command, onRunCommand, t));
            row.appendChild(el("span", "sfe-file-viewer-line-text", lineText));
            return row;
          },
        });
        bodyEl.__sfeVList = list;
        list.setItems(linesArray);
      } else {
        const pre = el("pre", "sfe-file-viewer-code");
        const total = linesArray.length;

        // 行号槽（整列 sticky 于横向滚动时为代码让位）。
        // package.json：命中 scripts 的行在行号后追加 ▶（对标 IDEA editor gutter 的运行图标）；
        //   行号槽由整块文本改为逐行元素，代码正文仍整块高亮（不切碎跨行 Prism token）。
        const gutter = el("div", "sfe-file-viewer-line-numbers");
        for (let i = 1; i <= total; i++) {
          const row = el("div", "sfe-file-viewer-gutter-row");
          row.appendChild(el("span", "sfe-file-viewer-gutter-no", String(i)));
          const command = scriptCommandMap.get(i);
          if (command) row.appendChild(createGutterRunButton(command, onRunCommand, t));
          gutter.appendChild(row);
        }
        pre.appendChild(gutter);

        // 代码高亮内容
        const content = el("div", "sfe-file-viewer-code-content");
        content.innerHTML = preview.highlightedHtml || escapeHtml(rawText);
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
