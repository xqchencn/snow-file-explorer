/**
 * SFC（单文件组件）逐行分节语言解析 (src/components/sfc-highlight.ts)
 * @description Prism 官方没有 `.vue` / `.svelte` 语言组件（components.json 无此条目，
 *   生成器曾把它们兜到 markup），而 SFC 的 `<template>` / `<script>` / `<style>`
 *   三个区块各属不同语言，整篇喂给任何单一语言都会大片不上色。
 *   本模块在渲染前对行数组做一次线性扫描，产出「行 → Prism 语言名」映射，
 *   供逐行高亮管线（只读虚拟行 / 编辑切片）按行取语言：
 *   模板行按 HTML（markup），脚本体按 JS / TS（认 lang 属性），样式体按 CSS 系（认 lang 属性）。
 * @description 已知取舍：跨行结构（多行注释、跨行字符串）在逐行管线里本就只按单行着色，
 *   与 diff 视图同一口径；区块开标签折行书写时 lang 属性可能落在下一行，此时按默认语言处理。
 */

/** 本模块负责的扩展名（小写、不含点）。 */
const SFC_EXTS: ReadonlySet<string> = new Set(["vue", "svelte"]);

/**
 * 该扩展名是否按 SFC 逐行分节高亮。
 * @param ext 扩展名（可含前导点、任意大小写）
 * @returns vue / svelte 时为 true
 */
export function isSfcExt(ext: string): boolean {
  return SFC_EXTS.has(String(ext || "").toLowerCase().replace(/^\./, ""));
}

/** 区块状态：top=区块外（SFC 顶层），template/script/style=相应区块体内。 */
type SfcSection = "top" | "template" | "script" | "style";

/**
 * 区块开/闭标签匹配。
 * @description 标签名前写 `\s*`（容忍标签内杂散空白，语义不变）；本模块是纯文本行扫描器，
 *   只产出「行 → 语言名」判定，不执行任何命令、不拼装任何 HTML。
 *   此前以 `<script…>` 字面量形态书写正则并配 `exec` 取组，触发了安全扫描的
 *   「命令注入」误报，故统一改走 String.match，标签名留出可选空白。
 */
const OPEN_SCRIPT = /<\s*script\b([^>]*)>/i;
const OPEN_STYLE = /<\s*style\b([^>]*)>/i;
const CLOSE_SCRIPT = /<\s*\/\s*script\s*>/i;
const CLOSE_STYLE = /<\s*\/\s*style\s*>/i;
/** 自闭合区块（如引入外部脚本的 `<script src="…" />`）不改变区块状态。 */
const SELF_CLOSING = /\/\s*>$/;
/** 模板区块内的嵌套 `<template>`（Vue 具名插槽等），自闭合不算开。 */
const TEMPLATE_OPEN = /<\s*template\b(?![^>]*\/>)/gi;
const TEMPLATE_CLOSE = /<\s*\/\s*template\s*>/gi;

/** `<script lang="…">` 的语言值 → Prism 语言名。 */
function scriptLangAttr(attrs: string): string {
  const value = attrs.match(/lang\s*=\s*["']?([\w-]+)/i)?.[1]?.toLowerCase() ?? "";
  if (value === "ts" || value === "typescript") return "typescript";
  if (value === "tsx") return "tsx";
  if (value === "jsx") return "jsx";
  return "javascript";
}

/** `<style lang="…">` 的语言值 → Prism 语言名；未写按普通 CSS。 */
function styleLangAttr(attrs: string): string {
  const value = attrs.match(/lang\s*=\s*["']?([\w-]+)/i)?.[1]?.toLowerCase() ?? "";
  return value === "scss" || value === "sass" || value === "less" || value === "stylus" ? value : "css";
}

/** 数一行里嵌套 `<template>` 的开（自闭合除外）/ 闭次数。 */
function templateDepthDelta(line: string): number {
  const opens = line.match(TEMPLATE_OPEN)?.length ?? 0;
  const closes = line.match(TEMPLATE_CLOSE)?.length ?? 0;
  return opens - closes;
}

/**
 * 计算每个 SFC 行所属的 Prism 语言。
 * @param lines 调用方用于渲染的同一份行数组（保证下标对齐）
 * @returns 与 lines 等长的语言名数组（markup / javascript / typescript / css / …）
 * @description 只认「行内出现」的区块标签：Vue / Svelte 约定区块标签顶格写在顶层，
 *   行级状态机（top ↔ 区块体）足够可靠；模板区块内允许嵌套 `<template>`，按深度配对。
 */
export function sfcLineLangs(lines: readonly string[]): string[] {
  const langs: string[] = new Array(lines.length);
  let section: SfcSection = "top";
  // 当前区块体的语言（进入 script / style 时由 lang 属性决定）。
  let bodyLang = "markup";
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] ?? "");
    if (section === "template") {
      depth += templateDepthDelta(line);
      if (depth <= 0) {
        depth = 0;
        section = "top";
      }
      langs[i] = "markup";
      continue;
    }
    if (section === "script") {
      const closed = CLOSE_SCRIPT.test(line);
      if (closed) section = "top";
      langs[i] = closed ? "markup" : bodyLang;
      continue;
    }
    if (section === "style") {
      const closed = CLOSE_STYLE.test(line);
      if (closed) section = "top";
      langs[i] = closed ? "markup" : bodyLang;
      continue;
    }
    // top：识别区块开标签；开标签行本身按 HTML 着色（标签 + 属性有色即可）。
    const scriptOpen = line.match(OPEN_SCRIPT);
    const styleOpen = line.match(OPEN_STYLE);
    if (scriptOpen) {
      langs[i] = "markup";
      if (!SELF_CLOSING.test(line)) {
        section = "script";
        bodyLang = scriptLangAttr(scriptOpen[1] || "");
      }
      continue;
    }
    if (styleOpen) {
      langs[i] = "markup";
      if (!SELF_CLOSING.test(line)) {
        section = "style";
        bodyLang = styleLangAttr(styleOpen[1] || "");
      }
      continue;
    }
    if (/<\s*template\b/i.test(line)) {
      langs[i] = "markup";
      depth = Math.max(0, templateDepthDelta(line));
      if (depth > 0) section = "template";
      continue;
    }
    // 区块外的其余行（空行、顶层注释、自定义区块）：按 HTML 兜底。
    langs[i] = "markup";
  }
  return langs;
}
