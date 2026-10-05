/**
 * 源码 / 单测里的懒加载兜底。
 * @description 宿主把入口打成 blob，相对 import 解析不到旁边的 chunk。
 *   构建 index.js 时这个文件会被替换成空实现，避免把 Prism、图标、xterm 打进入口。
 *   单测直接跑源码，仍从这里按需 import。
 * @param {string} name chunks 名称
 * @returns {Promise<Object|null>}
 */
export function loadSourceChunk(name) {
  switch (name) {
    case "icons":
      return import("../lazy/icons.js");
    case "highlighter":
      return import("../lazy/highlighter.js");
    case "terminal":
      return import("../lazy/terminal.js");
    case "markdown":
      return import("../lazy/markdown.js");
    default:
      return Promise.resolve(null);
  }
}
