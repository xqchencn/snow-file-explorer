/**
 * 高亮块的同步入口。
 * @description 视图层不直接 import Prism。块加载完成前退回纯文本，加载后只刷新当前视口。
 */

import { shouldHighlight } from "./highlight-policy.ts";
import { loadChunk } from "../services/lazy-chunk.ts";

/** 懒加载高亮块（chunks/highlighter.js）暴露的接口，单测可直接注入同一形状。 */
export type HighlighterModule = {
  /** 把源码转成高亮 HTML；超阈值或语言未注册时退化为转义后的纯文本。 */
  highlightCodeHtml: (code: string, ext: string) => string;
  /** 块自带的熔断判定；缺省时由本模块用 highlight-policy 的 shouldHighlight 兜底。 */
  shouldHighlight?: (code: string) => boolean;
};

/** 正在消费的高亮块；null 表示尚未加载完成。 */
let installed: HighlighterModule | null = null;
/** 进行中的加载 Promise；null 表示当前没有并发加载，可用于去重。 */
let loading: Promise<HighlighterModule | null> | null = null;

/**
 * 登记已加载的高亮模块。单测可直接注入，避免走宿主文件读取。
 * @param mod 高亮模块；传入 null/undefined 表示清空登记
 */
export function installHighlighter(mod: HighlighterModule | null | undefined): void {
  installed = mod || null;
}

/** 高亮模块是否已可用。 */
export function highlighterReady(): boolean {
  return !!(installed && typeof installed.highlightCodeHtml === "function");
}

/**
 * 确保高亮模块已加载。
 * @returns 解析为已登记的高亮块；加载失败或宿主未提供块时为 null
 */
export function ensureHighlighter(): Promise<HighlighterModule | null> {
  if (highlighterReady()) return Promise.resolve(installed);
  if (!loading) {
    loading = loadChunk("highlighter")
      .then((mod) => {
        // loadChunk 已按块名窄化出高亮块的真实导出，这里不再需要断言；
        // typeof 探针保留：单测注入或宿主返回残缺块时，仍要确认 highlightCodeHtml 可调用。
        // 传回同一个块对象（不新建、不挑字段），installed 的引用与原块保持一致。
        if (mod && typeof mod.highlightCodeHtml === "function") installHighlighter(mod);
        return installed;
      })
      .finally(() => {
        loading = null;
      });
  }
  // 走到这里 loading 必为上面赋的 Promise：复位只发生在异步 finally 里。
  return loading!;
}

/**
 * 已加载时做语法高亮；否则返回空串，调用方改用纯文本。
 * @param code 源码
 * @param ext 扩展名
 * @returns 高亮 HTML；不可用时为空串
 */
export function highlightCodeHtml(code: string, ext: string): string {
  if (!highlighterReady()) return "";
  // 上面的 highlighterReady 已保证 installed 非空（类型层面无法由函数调用推导，故显式断言）。
  if (installed!.shouldHighlight && !installed!.shouldHighlight(code)) return "";
  if (!installed!.shouldHighlight && !shouldHighlight(code)) return "";
  return installed!.highlightCodeHtml(code, ext) || "";
}
