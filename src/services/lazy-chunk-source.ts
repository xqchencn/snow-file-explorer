/**
 * 懒加载块名称。
 * @description 与 src/lazy 下的四个块入口、构建产出的 dist/chunks/<name>.js 一一对应，
 *   本文件的 switch 是该清单的唯一来源。
 */
export type LazyChunkName = "icons" | "highlighter" | "terminal" | "markdown";

/**
 * 懒加载块的导出集合。
 * @description 每个块导出的符号各不相同（图标表 / 高亮函数 / 终端构造器 / Markdown 渲染器），
 *   经 blob import 拿回来的只能是动态模块命名空间，消费方按块名自行取用。
 */
export type LazyChunkModule = Record<string, unknown>;

/**
 * 源码 / 单测里的懒加载兜底。
 * @description 宿主把入口打成 blob，相对 import 解析不到旁边的 chunk。
 *   构建 index.js 时这个文件会被替换成空实现，避免把 Prism、图标、xterm 打进入口。
 *   单测直接跑源码，仍从这里按需 import。
 * @param name chunks 名称
 * @returns 块模块；名称不在清单内时返回 null
 */
export function loadSourceChunk(name: LazyChunkName): Promise<LazyChunkModule | null> {
  switch (name) {
    case "icons":
      return import("../lazy/icons.ts");
    case "highlighter":
      return import("../lazy/highlighter.ts");
    case "terminal":
      return import("../lazy/terminal.ts");
    case "markdown":
      return import("../lazy/markdown.ts");
    default:
      return Promise.resolve(null);
  }
}
