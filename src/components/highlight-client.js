/**
 * 高亮块的同步入口。
 * @description 视图层不直接 import Prism。块加载完成前退回纯文本，加载后只刷新当前视口。
 */

import { shouldHighlight } from "./highlight-policy.js";
import { loadChunk } from "../services/lazy-chunk.js";

let installed = null;
let loading = null;

/**
 * 登记已加载的高亮模块。单测可直接注入，避免走宿主文件读取。
 * @param {{highlightCodeHtml: Function, shouldHighlight?: Function}|null} mod 高亮模块
 */
export function installHighlighter(mod) {
  installed = mod || null;
}

/** 高亮模块是否已可用。 */
export function highlighterReady() {
  return !!(installed && typeof installed.highlightCodeHtml === "function");
}

/**
 * 确保高亮模块已加载。
 * @returns {Promise<Object|null>}
 */
export function ensureHighlighter() {
  if (highlighterReady()) return Promise.resolve(installed);
  if (!loading) {
    loading = loadChunk("highlighter")
      .then((mod) => {
        if (mod && typeof mod.highlightCodeHtml === "function") installHighlighter(mod);
        return installed;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/**
 * 已加载时做语法高亮；否则返回空串，调用方改用纯文本。
 * @param {string} code 源码
 * @param {string} ext 扩展名
 * @returns {string}
 */
export function highlightCodeHtml(code, ext) {
  if (!highlighterReady()) return "";
  if (installed.shouldHighlight && !installed.shouldHighlight(code)) return "";
  if (!installed.shouldHighlight && !shouldHighlight(code)) return "";
  return installed.highlightCodeHtml(code, ext) || "";
}
