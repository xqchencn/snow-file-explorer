/**
 * 代码预览组件模块 (src/components/code-viewer.js)
 * 渲染对标 Snow App 官方 FileViewerContent 组件规范：行号槽、悬浮复制代码按钮、图片展示与异常提示；
 * 额外按 gitView 渲染 Git 变更文件的差异视图（「差异/内容」切换控件在工具栏，见 index.js；
 * 差异视图见 components/diff-view.js）。
 */

import { el, escapeHtml } from "../utils/dom.js";
import { createActionIcon } from "../icons/action-icons.js";
import { resolveMarkdownAssetPath, resolveProxiedImageSrc } from "../services/markdown-asset.js";
import { extname } from "../services/file-service.js";
import { renderDiffView } from "./diff-view.js";

const NL = String.fromCharCode(10);

/**
 * 渲染代码/文件预览面板
 * @param {HTMLElement} bodyEl 承载预览内容的容器 DOM
 * @param {Object} options
 * @param {Object} options.preview 预览状态对象 { kind, text, highlightedHtml, url, name, mime, message, truncated, diff?, gitView? }
 * @param {boolean} options.copied 是否刚点击过复制按钮
 * @param {Function} options.onCopy 点击复制回调
 * @param {Function} options.onSetMode 切换预览/代码模式回调 (mode: 'preview' | 'code')
 * @param {Function} options.onSetDiffMode 切换差异展示模式回调 (mode: 'unified' | 'split')
 * @param {Function} [options.onSetScopeMode] 切换差异范围模式回调 (scopeMode: 'full' | 'hunks')
 * @param {Function} options.t 本地化翻译函数
 */
export function renderCodeViewer(bodyEl, { preview, copied, onCopy, onSetMode, onSetDiffMode, onSetScopeMode, t }) {
  bodyEl.replaceChildren();

  if (!preview) {
    const empty = el("div", "sfe-file-viewer-empty");
    empty.appendChild(el("div", null, t("preview.hint", "选择一个文件即可预览。")));
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
        // 全文件差异：透传工作区新版本完整文本与视图范围控制
        fullContent: preview.diff.fullContent ?? preview.text ?? null,
        loading: preview.diff.loading,
        error: preview.diff.error,
        // 使用文件扩展名选择 Prism 语言，确保差异正文与普通代码预览使用同一套高亮规则
        extension: extname(preview.name),
        onSetMode: onSetDiffMode,
        onSetScopeMode,
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
      bodyEl.appendChild(switcher);
    }

    // 悬浮复制按钮：复制的是原始 Markdown / 代码文本
    const copyBtn = el("button", "sfe-floating-copy-btn" + (copied ? " copied" : ""));
    copyBtn.type = "button";
    copyBtn.title = copied ? t("action.copied", "已复制") : t("action.copy", "复制代码");
    copyBtn.appendChild(createActionIcon(copied ? "check" : "copy", 14));
    if (typeof onCopy === "function") {
      copyBtn.addEventListener("click", onCopy);
    }
    bodyEl.appendChild(copyBtn);

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
      if (preview.truncated) {
        bodyEl.appendChild(el("div", "sfe-pv-note", t("preview.truncated", "内容过长，仅显示前 20 万字符。")));
      }
      return;
    }

    // 代码模式（含普通文本文件）：语法高亮 + 行号
    const scroll = el("div", "sfe-file-viewer-code-scroll");
    const pre = el("pre", "sfe-file-viewer-code");

    // 行号槽
    const gutter = el("div", "sfe-file-viewer-line-numbers");
    const linesArray = String(preview.text || "").split(/\r\n|\r|\n/);
    const total = linesArray.length;
    let gutterText = "";
    for (let i = 1; i <= total; i++) {
      gutterText += i + (i < total ? NL : "");
    }
    gutter.textContent = gutterText;
    pre.appendChild(gutter);

    // 代码高亮内容
    const content = el("div", "sfe-file-viewer-code-content");
    content.innerHTML = preview.highlightedHtml || escapeHtml(preview.text || "");
    pre.appendChild(content);

    scroll.appendChild(pre);
    bodyEl.appendChild(scroll);

    // 截断提示
    if (preview.truncated) {
      bodyEl.appendChild(el("div", "sfe-pv-note", t("preview.truncated", "内容过长，仅显示前 20 万字符。")));
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
