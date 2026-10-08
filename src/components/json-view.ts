/**
 * 响应正文的 JSON 折叠视图 (src/components/json-view.ts)
 * @description 把美化后的 JSON 摊成可逐块折叠的行列表。折叠区间按**缩进配对**算：
 *   不依赖语法树，只看前导空格的增减，因此对象/数组嵌套都能正确配对。
 *   配对的前提是正文已经美化过——缩进是唯一的配对依据，没缩进的正文折不动，只能整摊着看。
 * @description 着色是 **JSON 语义着色**（键 / 字符串 / 数字 / 布尔 / null 各一色），
 *   类名用 Prism 的 token 体系（property / string / …），与 .json 文件、.http 正文、
 *   diff 里的 JSON 同一套配色（syntax.css 的 token 色板，作用域含本视图容器）。
 *   JSON 要的是结构化美化，不是代码分词；分词由 segmentJsonLine 的行级语义切分承担。
 */

import { el } from "../utils/dom.ts";
import { createActionIcon } from "../icons/action-icons.ts";
import type { TranslateFn } from "../types/panel-state.ts";

/**
 * 折叠视图处理的正文行数上限。
 * @description 每行都要建 DOM（可折叠时还多一个按钮），几千行以后渲染开销不可忽略；
 *   超限时调用方退回纯文本 + 语法高亮的 `<pre>`。
 */
export const MAX_FOLD_LINES = 3000;

/** 一段 JSON 片段及其语义类别，供逐段着色。 */
type JsonSegment = { text: string; cls: string };

/**
 * JSON 语义类别的类名映射；两处消费方各传自己那套（JSON 视图 / Prism token）。
 */
export type JsonClassMap = {
  /** 结构符号 `{ } [ ] , :`。 */
  punct: string;
  /** 对象键（后跟冒号的那个字符串）。 */
  key: string;
  /** 字符串值。 */
  string: string;
  /** true / false。 */
  boolean: string;
  /** null。 */
  null: string;
  /** 数字。 */
  number: string;
};

/**
 * Prism token 体系下的 JSON 语义类名：与 `.json` 文件（Prism json 语言）、
 * `.http` 正文（syntax-basic）、diff 共用同一套 token 色板。
 * 本视图的容器（.sfe-json-view / .sfe-json-hl）已加入 syntax.css 的 token 作用域。
 */
export const PRISM_JSON_CLASSES: JsonClassMap = {
  punct: "punctuation",
  key: "property",
  string: "string",
  boolean: "boolean",
  null: "null",
  number: "number",
};

/** 本模块视图渲染用的类名映射（= Prism token 体系，别名保留以示「JSON 视图」身份）。 */
const JSON_CLASSES = PRISM_JSON_CLASSES;


/**
 * 这段正文是否适合渲染成折叠视图。
 * @param text 已美化的正文
 * @returns 行数在 MAX_FOLD_LINES 以内时为 true
 */
export function canRenderJsonView(text: string): boolean {
  return String(text || "").split("\n").length <= MAX_FOLD_LINES;
}

/** 这段文本是不是可解析的 JSON 对象 / 数组。 */
export function isJsonText(text: string): boolean {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * 计算每个可折叠行的区间。
 * @param lines 正文行（已美化）
 * @returns 起始行下标（0 基）→ 结束行下标（0 基，含）
 * @description 缩进变深的那一行是块的开始（它的下一行更深），缩进回落时配对结束。
 *   只认前导空白：空白行量不出缩进（找不到第一个非空白字符），拿不到配对的依据，故不参与。
 */
function foldingRanges(lines: readonly string[]): Map<number, number> {
  const leading: Array<[number, number]> = [];
  lines.forEach((line, index) => {
    const indent = line.search(/\S/);
    if (indent !== -1) leading.push([index, indent]);
  });
  const ranges = new Map<number, number>();
  const stack: Array<[number, number]> = [];
  for (let at = 1; at < leading.length; at += 1) {
    const [lineIndex, indent] = leading[at];
    const [prevIndex, prevIndent] = leading[at - 1];
    if (prevIndent < indent) {
      stack.push([prevIndex, prevIndent]);
      continue;
    }
    while (stack.length && stack[stack.length - 1][1] >= indent) {
      const [start] = stack.pop()!;
      // 结束行就是当前这一行（`}` / `],` 那行），闭区间收在这里。
      ranges.set(start, lineIndex);
    }
  }
  // 收尾：文件结束时还没闭合的块，结束行就是最后一行。
  const last = lines.length - 1;
  while (stack.length) {
    const [start] = stack.pop()!;
    if (start < last) ranges.set(start, last);
  }
  return ranges;
}

/**
 * 把一行（已美化的）JSON 文本切成带语义类别的片段。
 * @param line 单行 JSON 文本
 * @param classes 类别名映射；两处消费方的类名体系不同，故由调用方给
 * @returns 片段列表：键 / 字符串 / 数字 / 布尔 / null / 标点 / 空白（空白与未识别段 cls 为空串）
 * @description 只按 JSON 语法着色，不做代码分词：
 *   - `"key":`（后跟冒号）= 键；其余字符串 = 字符串值；
 *   - 数字、true/false、null 各成一类；
 *   - 结构符号 `{ } [ ] , :` = 标点；缩进与空格 = 原样空白。
 * @description 本函数是 JSON 语义着色的**唯一实现**：json-view 的折叠视图与
 *   syntax-basic 的 `.http` 正文着色都走这里，两边共用 PRISM_JSON_CLASSES（Prism token 类名），
 *   与 .json 文件、diff 里的 JSON 同一套配色。同一套切分写两份必然漂移，改一处必漏另一处，
 *   所以这份切分逻辑只留一处。
 */
export function segmentJsonLine(line: string, classes: JsonClassMap): JsonSegment[] {
  const out: JsonSegment[] = [];
  // 数字分支的 `-?` 必须写在 `\b` **之前**：`\b` 是词边界，而 `-` 是非词字符，
  // 写成 `\b-?\d` 时 `-` 前不构成边界，负号会被排除在匹配之外（`-12` 只匹配到 `12`），
  // 负数于是整段落进未识别分支、一个色都上不了。JSON 里负数很常见，这条不能少。
  const re = /"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false)\b|\bnull\b|[{},[\]:]|[ \t]+/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    if (match.index > last) out.push({ text: line.slice(last, match.index), cls: "" });
    const token = match[0];
    let cls = classes.punct;
    if (token[0] === '"') {
      // 后面紧跟（可带空白的）冒号就是键，否则是字符串值。
      cls = /^\s*:/.test(line.slice(match.index + token.length)) ? classes.key : classes.string;
    } else if (token === "true" || token === "false") cls = classes.boolean;
    else if (token === "null") cls = classes.null;
    else if (/^[ \t]+$/.test(token)) cls = "";
    else if (/^-?\d/.test(token)) cls = classes.number;
    out.push({ text: token, cls });
    last = match.index + token.length;
  }
  if (last < line.length) out.push({ text: line.slice(last), cls: "" });
  return out;
}

/** 渲染一行：折叠按钮（或占位）+ 该行的 JSON 语义着色文本。 */
function renderLine(text: string, collapsible: boolean, label: string): HTMLElement {
  const row = el("div", "sfe-json-line");
  if (collapsible) {
    const toggle = el("button", "sfe-json-toggle");
    toggle.type = "button";
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("aria-expanded", "true");
    toggle.appendChild(createActionIcon("chevronDown", 12));
    row.appendChild(toggle);
  } else {
    // 占位保持缩进对齐：没有按钮的行也要留出同样的槽位。
    row.appendChild(el("span", "sfe-json-toggle-spacer"));
  }
  const code = el("span", "sfe-json-code");
  for (const segment of segmentJsonLine(text, JSON_CLASSES)) {
    if (!segment.cls) code.appendChild(document.createTextNode(segment.text));
    else code.appendChild(el("span", "token " + segment.cls, segment.text));
  }
  row.appendChild(code);
  return row;
}

/**
 * 渲染 JSON 折叠视图。
 * @param parent 宿主容器；每次调用整体重建
 * @param text 已美化的 JSON 正文
 * @param t 翻译函数
 * @param options.open 外层是否默认展开；响应正文要「发完就摊开看结果」，故默认 true
 * @description 两层折叠：外层整段像「响应头」一样是一块 `<details>`（可整体收起），
 *   内层每个 `{}` / `[]` 各自带一个折叠按钮，可单独收起——这才是看 JSON 该有的样子。
 *   不做「全部折叠 / 全部展开」这种粗粒度按钮。
 */
export function renderJsonView(
  parent: HTMLElement,
  text: string,
  t: TranslateFn,
  options: { open?: boolean } = {}
): void {
  const lines = String(text || "").split("\n");

  parent.replaceChildren();
  // 外层：整段响应正文是一块可折叠的 <details>。这是「请求完成后的结果」，默认摊开。
  const details = el("details", "sfe-json-details");
  details.open = options.open !== false;
  const summary = el("summary");
  summary.appendChild(el("span", null, t("http.responseBody", "响应正文")));
  summary.appendChild(el("span", "sfe-http-count", String(lines.length)));
  details.appendChild(summary);

  const root = el("div", "sfe-json-view");
  root.appendChild(buildFoldBody(lines, t));
  details.appendChild(root);
  parent.appendChild(details);
}

/**
 * 把整段 JSON 文本渲染成带语义着色的高亮层（不做折叠、不带行号）。
 * @param host 高亮层容器；每次调用整体重建
 * @param text JSON 文本（请求体原文或响应正文）
 * @description 供「请求体编辑器」的透明 textarea 叠层使用：请求体同样是 JSON 最常出现的地方，
 *   不能只有响应有颜色。文本非合法 JSON 时也照原样着色（键/值/标点按语法近似切分），不报错。
 */
export function renderJsonHighlight(host: HTMLElement, text: string): void {
  host.replaceChildren();
  for (const line of String(text || "").split("\n")) {
    const row = el("div", "sfe-json-hl-line");
    for (const segment of segmentJsonLine(line, JSON_CLASSES)) {
      if (!segment.cls) row.appendChild(document.createTextNode(segment.text));
      else row.appendChild(el("span", "token " + segment.cls, segment.text));
    }
    host.appendChild(row);
  }
}

/**
 * 请求体编辑器：JSON 正文 → 「可折叠的着色视图」（只读）+ 一个可切到的编辑态。
 * @param host 宿主容器；每次调用整体重建
 * @param text 请求体原文
 * @param t 翻译函数
 * @param options.onEdit 点「编辑」时切到编辑态（由装配层负责重绘成 textarea 编辑器）
 * @returns 渲染出的根元素
 * @description 请求体与响应正文一视同仁：都是「外层可整体折叠 + 内部每个 `{}` / `[]` 单独折叠」，
 *   并且同样有 JSON 语义着色。编辑入口只留一个「编辑」按钮，不再把裸 textarea 直接摊在面板上。
 */
export function renderJsonFoldView(
  host: HTMLElement,
  text: string,
  t: TranslateFn,
  options: { onEdit?: () => void } = {}
): HTMLElement {
  host.replaceChildren();
  const raw = String(text || "");
  const isJson = isJsonText(raw);
  const pretty = isJson ? prettyJsonText(raw) : raw;
  const lines = pretty.split("\n");

  // 请求体是「要编辑 / 发出去」的操作型区块：默认展开（可折叠）；响应头 / 响应正文 / 实际发出的请求才默认折叠。
  const details = el("details", "sfe-json-details");
  details.open = true;
  const summary = el("summary");
  summary.appendChild(el("span", null, t("http.body", "请求体")));
  summary.appendChild(el("span", "sfe-http-count", String(lines.length)));
  details.appendChild(summary);

  if (typeof options.onEdit === "function") {
    const edit = el("button", "sfe-json-edit-btn");
    edit.type = "button";
    edit.title = t("http.editBody", "编辑请求体");
    edit.appendChild(createActionIcon("pencil", 12));
    edit.appendChild(el("span", null, t("http.edit", "编辑")));
    // 摘要里的按钮默认不会切换 details，但各浏览器对 summary 内可交互元素的处理并不一致；
    // 明确挡住冒泡，保证「点编辑」只切编辑态，绝不连带把这块折叠掉。
    edit.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onEdit?.();
    });
    summary.appendChild(edit);
  }

  if (isJson) {
    const root = el("div", "sfe-json-view");
    root.appendChild(buildFoldBody(lines, t));
    details.appendChild(root);
  } else {
    const hl = el("div", "sfe-json-hl");
    renderJsonHighlight(hl, raw);
    details.appendChild(hl);
  }

  host.appendChild(details);
  return details;
}

/** 请求体编辑态：着色高亮层 + 透明 textarea（可编辑），随键入重画、随滚动同步。 */
export function renderJsonBodyEditor(
  host: HTMLElement,
  text: string,
  t: TranslateFn,
  onChange: (value: string) => void
): HTMLTextAreaElement {
  host.replaceChildren();
  const editor = el("div", "sfe-http-body-editor");
  const highlight = el("div", "sfe-http-body-highlight");
  highlight.setAttribute("aria-hidden", "true");
  const body = el("textarea", "sfe-http-body");
  body.value = text;
  body.spellcheck = false;
  body.placeholder = t("http.bodyPlaceholder", "没有请求体就留空");
  const rows = () => Math.min(40, Math.max(3, String(body.value || "").split("\n").length));
  body.rows = rows();
  const paint = () => {
    renderJsonHighlight(highlight, body.value || "");
    highlight.scrollTop = body.scrollTop;
    highlight.scrollLeft = body.scrollLeft;
  };
  paint();
  body.addEventListener("input", () => {
    paint();
    body.rows = rows();
    onChange(body.value);
  });
  body.addEventListener("scroll", () => {
    highlight.scrollTop = body.scrollTop;
    highlight.scrollLeft = body.scrollLeft;
  });
  editor.appendChild(highlight);
  editor.appendChild(body);
  host.appendChild(editor);
  return body;
}

/**
 * 构建可逐块折叠的 JSON 行视图（不带外层 details，供响应正文与请求体共用）。
 * @param lines 已美化的 JSON 行
 * @param t 翻译函数
 * @returns 行视图根元素
 */
function buildFoldBody(lines: readonly string[], t: TranslateFn): HTMLElement {
  const ranges = foldingRanges(lines);
  const renderRange = (from: number, to: number): HTMLElement => {
    const container = el("div", "sfe-json-block");
    let index = from;
    while (index <= to) {
      const end = ranges.get(index);
      if (end !== undefined && end > index && end <= to) {
        const node = el("div", "sfe-json-node");
        const head = renderLine(lines[index], true, t("http.collapse", "折叠"));
        const ellipsis = el("span", "sfe-json-ellipsis", ` … ${end - index} ${t("http.jsonLines", "行")}`);
        head.querySelector(".sfe-json-code")?.appendChild(ellipsis);
        const children = el("div", "sfe-json-children");
        if (index + 1 <= end - 1) children.appendChild(renderRange(index + 1, end - 1));
        node.appendChild(head);
        node.appendChild(children);
        node.appendChild(renderLine(lines[end], false, ""));
        const toggle = head.querySelector<HTMLButtonElement>(".sfe-json-toggle")!;
        toggle.addEventListener("click", () => {
          const collapsed = node.classList.toggle("collapsed");
          toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
          toggle.title = collapsed ? t("http.expand", "展开") : t("http.collapse", "折叠");
          toggle.replaceChildren(createActionIcon(collapsed ? "chevronRight" : "chevronDown", 12));
        });
        container.appendChild(node);
        index = end + 1;
        continue;
      }
      container.appendChild(renderLine(lines[index], false, ""));
      index += 1;
    }
    return container;
  };
  return renderRange(0, lines.length - 1);
}

/** JSON 美化：合法时两空格缩进，否则原样返回。 */
function prettyJsonText(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
