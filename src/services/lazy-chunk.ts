/**
 * 按需加载 dist/chunks 下的自包含脚本。
 * @description 宿主通过 blob URL import 插件入口，入口内部的相对 import 无法定位同目录文件。
 *   因此 chunk 必须自身打全依赖，再用 window.snow.readPluginFile 读出文本后 blob import。
 */

import { loadSourceChunk } from "./lazy-chunk-source.ts";
import type { LazyChunkModule, LazyChunkName } from "./lazy-chunk-source.ts";

/**
 * 各懒加载块的模块形状。
 * @description 键与 `LazyChunkName`、构建产物 `dist/chunks/<name>.js` 一一对应。
 *   用 `typeof import()` 直接取块入口的真实导出：不在 services 层重述组件类型，
 *   块内容变化时这里自动跟随，消费方也无需再对返回值做断言。
 */
export type ChunkModuleMap = {
  /** 文件图标数据块：EXT_ICONS / NAME_ICONS / ICON_SVGS / FILE / FOLDER / FOLDER_OPEN。 */
  icons: typeof import("../lazy/icons.ts");
  /** Prism 高亮块：highlightCodeHtml / shouldHighlight。 */
  highlighter: typeof import("../lazy/highlighter.ts");
  /** xterm 视图块：createXtermView。 */
  terminal: typeof import("../lazy/terminal.ts");
  /** Markdown 渲染块：renderMarkdownHtml。 */
  markdown: typeof import("../lazy/markdown.ts");
};

const cache: Map<string, Promise<LazyChunkModule | null>> = new Map();

/**
 * 读取宿主注入的插件 id。
 * @returns 插件 id；宿主未注入全局作用域时为空串
 */
function pluginId(): string {
  const scope = typeof window !== "undefined" ? window.SnowAppPlugin : null;
  const id = scope && scope.plugin && scope.plugin.id;
  return typeof id === "string" ? id : "";
}

/**
 * 从宿主插件目录加载一个 chunk。
 * @param name 文件名（不含目录与扩展名）
 * @returns chunk 模块；宿主没有该能力或文件为空时返回 null
 */
async function loadHostChunk(name: LazyChunkName): Promise<LazyChunkModule | null> {
  const snow = typeof window !== "undefined" ? window.snow : null;
  const id = pluginId();
  if (!snow || typeof snow.readPluginFile !== "function" || !id) return null;
  const code = await snow.readPluginFile(id, `chunks/${name}.js`);
  if (!code) return null;
  const blob = new Blob([code], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 加载并缓存一个懒加载块。同一名称只解析一次。
 * @param name icons | highlighter | terminal | markdown
 * @returns 块模块，按名称窄化成对应块的真实导出；宿主与源码兜底都拿不到时为 null
 * @description 缓存里存的是 blob import 回来的模块命名空间（`Record<string, unknown>`），
 *   它与 `ChunkModuleMap` 的对应关系由本文件的名称联合保证。跨这个边界只能断言，
 *   所以集中在出口一处，而不是让每个消费方各自断言。
 */
export function loadChunk<K extends LazyChunkName>(
  name: K,
): Promise<ChunkModuleMap[K] | null> {
  const cached = cache.get(name);
  if (cached) return cached as Promise<ChunkModuleMap[K] | null>;
  const pending = loadHostChunk(name)
    .then((mod) => mod || loadSourceChunk(name))
    .catch((err) => {
      cache.delete(name);
      throw err;
    });
  cache.set(name, pending);
  return pending as Promise<ChunkModuleMap[K] | null>;
}
