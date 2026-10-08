/**
 * Markdown 资源服务模块 (src/services/markdown-asset.ts)
 * 负责 Markdown 文档识别、相对图片引用到本地绝对路径的解析，以及本地图片读取为 data URL。
 */

import { measureText } from "../components/highlight-policy.ts";

/**
 * 判断文件是否为 Markdown 文档
 * @param filePath 文件路径或文件名
 * @returns 扩展名属于 md / markdown / mdx / mkd 时为 true
 */
export function isMarkdownPath(filePath: string | null): boolean {
  const name = String(filePath || "").toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    name.endsWith(".mdx") ||
    name.endsWith(".mkd")
  );
}

/**
 * Markdown 正文是否大到不该渲染成 HTML（应直接展示源码）。
 * @param text 正文
 * @returns 超过任一体量上限时为 true
 * @description marked 解析 + DOMPurify 净化按全文一次性付费，超大正文渲染会把面板卡死。
 *   阈值沿用旧「虚拟化」判定（25 万字符 / 400 行 / 单行 2 万），行为与统一前一致；
 *   它属于 Markdown 水合策略，与代码高亮管线无关（高亮已统一为逐行懒加载，无整篇体量熔断）。
 */
export function isOversizeMarkdown(text: string | null | undefined): boolean {
  const measured = measureText(text);
  if (!measured.length) return false;
  return measured.length > 250000 || measured.lines > 400 || measured.maxLineLen > 20000;
}

/**
 * 安全解码 URI 片段（非法百分号编码时原样返回）
 * @param value 原始片段
 * @returns 解码后的片段，解码失败时为原串
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 归一化路径中的 "." 与 ".." 段，保留盘符与根前缀（兼容 Windows / POSIX）
 * @param p 待归一化路径
 * @returns 归一化后的路径，分隔符风格与输入一致
 */
export function normalizePath(p: string): string {
  const raw = String(p || "");
  const isWin = /^[a-zA-Z]:([/\\]|$)/.test(raw);
  const sep = raw.includes("\\") ? "\\" : "/";
  const unified = raw.replace(/[/\\]+/g, "/");
  const isAbsolute = unified.startsWith("/") || isWin;

  const stack: string[] = [];
  for (const part of unified.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      const top = stack[stack.length - 1];
      if (stack.length && top !== ".." && !/^[a-zA-Z]:$/.test(top)) {
        stack.pop();
      } else if (!isAbsolute) {
        // 仅相对路径保留向上的 ".."；绝对路径越过根时忽略
        stack.push("..");
      }
      continue;
    }
    stack.push(part);
  }

  let out = stack.join("/");
  if (isWin) {
    out = out.replace(/^([a-zA-Z]:)\/?/, "$1/");
  } else if (isAbsolute) {
    out = "/" + out;
  }
  return sep === "\\" ? out.replace(/\//g, "\\") : out;
}

/**
 * 将 Markdown 图片引用解析为本地绝对路径
 * @description 仅处理相对路径引用；外链（http/https/data/file/mailto 等任意 scheme）、
 *   协议相对路径（//）与纯锚点（#）一律返回 null，交由 <img> 原样处理或忽略。
 * @param ref 图片原始引用
 * @param docPath 当前 Markdown 文档的绝对路径
 * @returns 本地绝对路径；无需本地解析时返回 null
 */
export function resolveMarkdownAssetPath(ref: string, docPath: string): string | null {
  const value = String(ref || "").trim();
  if (!value) return null;
  // 任意 scheme（http:、data:、file:、mailto: 等）与协议相对路径不视为本地资源
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return null;
  if (value.startsWith("//") || value.startsWith("#")) return null;

  const cutIdx = value.search(/[?#]/);
  const clean = cutIdx >= 0 ? value.slice(0, cutIdx) : value;
  if (!clean) return null;

  const dir = String(docPath || "").replace(/[/\\][^/\\]*$/, "");
  if (!dir) return null;

  return normalizePath(dir + "/" + safeDecode(clean));
}

/**
 * 将外链 http(s) 图片引用解析为宿主 img-proxy 代理 URL
 * @description 宿主渲染进程 CSP 的 img-src 仅放行 `'self' data: blob: theme-bg: img-proxy:`，
 *   直接使用 `https://` 外链会被 CSP 拦截（表现为图片空白，如 README 徽章）。
 *   宿主注册了 img-proxy:// 协议代理外部图片，契约格式为
 *   `img-proxy://localhost/<encodeURIComponent(原始URL)>`（见宿主
 *   src/renderer/utils/imageProxyUrl.ts 与 src/main/app/imageProxyProtocol.ts）。
 *   此处按同一契约构造；插件无法 import 宿主源码，故协议字面量在此集中定义。
 * @param ref 图片原始引用；宿主 markdown 解析器可能给出 null，按空串处理
 * @returns 代理 URL；非 http(s) 外链返回 null（交回本地解析或原样保留）
 */
export function resolveProxiedImageSrc(ref: string | null): string | null {
  const value = String(ref || "").trim();
  if (!/^https?:\/\//i.test(value)) return null;
  return "img-proxy://localhost/" + encodeURIComponent(value);
}

// 图片读取结果缓存：render 会整体重建 DOM，缓存避免同一张图被反复走宿主 IPC。
// 缓存值是完整 base64 data URL（约为原图字节 1.33 倍），必须限长：按插入序 LRU 淘汰，
// 长会话浏览多图文档时内存不再无界增长（被淘汰的图重新访问时再走一次 IPC）。
const IMAGE_CACHE_LIMIT = 40;
const imageCache: Map<string, Promise<string | null>> = new Map();

/**
 * 读取本地图片文件为 data URL（带进程内 LRU 缓存）
 * @param absPath 图片绝对路径
 * @returns data URL；不可用或失败时返回 null
 */
export function readImageAsDataUrl(absPath: string): Promise<string | null> {
  if (!absPath) return Promise.resolve(null);
  const cached = imageCache.get(absPath);
  if (cached) {
    // 刷新访问序（LRU）。
    imageCache.delete(absPath);
    imageCache.set(absPath, cached);
    return cached;
  }

  const task = (async () => {
    const snow = window.snow;
    if (!snow || typeof snow.readFileContent !== "function") return null;
    try {
      const result = await snow.readFileContent(absPath);
      if (!result || !result.isImage || !result.content) return null;
      return "data:" + (result.mimeType || "image/png") + ";base64," + result.content;
    } catch {
      return null;
    }
  })();

  imageCache.set(absPath, task);
  if (imageCache.size > IMAGE_CACHE_LIMIT) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined) imageCache.delete(oldest);
  }
  return task;
}
