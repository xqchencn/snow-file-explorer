/**
 * Markdown 渲染模块 (src/components/markdown-renderer.ts)
 * 基于 marked 解析 + DOMPurify 白名单净化，输出安全的预览 HTML。
 * 安全策略：剥离脚本/样式/表单等危险标签与全部 on* 事件属性；仅放行图片的 data:image 内联源。
 */

import { marked } from "marked";
import createDOMPurify from "dompurify";
import type { Config, DOMPurify } from "dompurify";

// 惰性创建 DOMPurify 实例：避免模块被导入时（宿主构建校验 / 非 DOM 环境）即访问 window 而报错
let purify: DOMPurify | null = null;

function getPurify(): DOMPurify {
  if (purify) return purify;
  purify = createDOMPurify(window);

  // 净化后处理：外链在新标签打开（避免插件面板内导航），
  // 并剥离 <a> 上的 data: 协议（防 data:text/html、data:image/svg+xml 被点击执行脚本）。
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName !== "A") return;
    const href = node.getAttribute("href") || "";
    if (/^data:/i.test(href)) {
      node.removeAttribute("href");
    } else if (/^https?:/i.test(href)) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });

  return purify;
}

const SANITIZE_OPTIONS: Config = {
  FORBID_TAGS: [
    "style",
    "form",
    "input",
    "button",
    "textarea",
    "select",
    "option",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "link",
    "meta",
    "base",
  ],
  FORBID_ATTR: ["style"],
  ALLOW_DATA_ATTR: false,
  // 放行 https/mailto/tel 与 data:image/（本地图片经宿主读取后转为内联源），其余 scheme 一律拒绝
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data:image\/)|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};

/**
 * 将 Markdown 文本渲染为已净化的 HTML
 * @param markdownText Markdown 源文本
 * @returns 安全的 HTML 字符串（解析失败或空输入返回空串）
 */
export function renderMarkdownHtml(markdownText: string): string {
  const src = String(markdownText || "");
  if (!src.trim()) return "";

  // marked 的返回形态随 async 选项变化，先按 unknown 收下，再用 typeof 收窄成字符串
  let rawHtml: unknown;
  try {
    rawHtml = marked.parse(src, { async: false, gfm: true, breaks: false });
  } catch {
    return "";
  }
  if (typeof rawHtml !== "string") return "";

  return getPurify().sanitize(rawHtml, SANITIZE_OPTIONS);
}
