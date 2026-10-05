/**
 * 按需加载 dist/chunks 下的自包含脚本。
 * @description 宿主通过 blob URL import 插件入口，入口内部的相对 import 无法定位同目录文件。
 *   因此 chunk 必须自身打全依赖，再用 window.snow.readPluginFile 读出文本后 blob import。
 */

import { loadSourceChunk } from "./lazy-chunk-source.js";

const cache = new Map();

/**
 * 读取宿主注入的插件 id。
 * @returns {string}
 */
function pluginId() {
  const scope = typeof window !== "undefined" ? window.SnowAppPlugin : null;
  const id = scope && scope.plugin && scope.plugin.id;
  return typeof id === "string" ? id : "";
}

/**
 * 从宿主插件目录加载一个 chunk。
 * @param {string} name 文件名（不含目录与扩展名）
 * @returns {Promise<Object|null>}
 */
async function loadHostChunk(name) {
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
 * @param {string} name icons | highlighter | terminal | markdown
 * @returns {Promise<Object|null>}
 */
export function loadChunk(name) {
  const cached = cache.get(name);
  if (cached) return cached;
  const pending = loadHostChunk(name)
    .then((mod) => mod || loadSourceChunk(name))
    .catch((err) => {
      cache.delete(name);
      throw err;
    });
  cache.set(name, pending);
  return pending;
}
