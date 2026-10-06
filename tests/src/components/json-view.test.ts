/**
 * JSON 折叠视图与语义着色测试 (tests/src/components/json-view.test.ts)
 * @description 这里钉住 json-view 的两块非平凡逻辑：折叠区间算法（缩进配对）与
 *   JSON 语义分词。二者此前只被面板测试间接走到主路径，边界（EOF 未闭合、数组、
 *   行数上限、键与字符串值的区分）全无覆盖——而它们正是「折叠后藏了几行」「哪些字着色」
 *   这类用户可见结果的唯一来源。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { TranslateFn } from "../../../src/types/panel-state.ts";

// 建立最小 DOM 环境后再导入渲染模块
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { MAX_FOLD_LINES, canRenderJsonView, isJsonText, segmentJsonLine, renderJsonView, renderJsonFoldView } =
  await import("../../../src/components/json-view.ts");

/** 翻译桩：回兜底文案并补 `{{x}}` 插值。 */
const t = ((key: string, fallback?: string, values?: Record<string, string | number>) => {
  let text = fallback || key;
  for (const [name, value] of Object.entries(values || {})) text = text.replace(`{{${name}}}`, String(value));
  return text;
}) as TranslateFn;

/** 供 segmentJsonLine 使用的类名映射（测试只关心「哪一类」，不关心样式名）。 */
const CLASSES = {
  punct: "punct",
  key: "key",
  string: "string",
  boolean: "boolean",
  null: "null",
  number: "number",
};

/** 取一行里某个类别的文本，便于断言。 */
function textsOf(line: string, cls: string): string[] {
  return segmentJsonLine(line, CLASSES)
    .filter((segment) => segment.cls === cls)
    .map((segment) => segment.text);
}

test("JSON 分词: 键与字符串值分开，靠后面是否跟冒号判定", () => {
  const line = '{ "name": "alice", "note": "x" }';
  assert.deepEqual(textsOf(line, "key"), ['"name"', '"note"'], "后跟冒号的字符串是键");
  assert.deepEqual(textsOf(line, "string"), ['"alice"', '"x"'], "其余字符串是值");
});

test("JSON 分词: 数字 / 布尔 / null 各归各类，标点单独成类", () => {
  const line = '{ "n": 12.5e3, "b": true, "z": null, "f": false }';
  assert.deepEqual(textsOf(line, "number"), ["12.5e3"], "指数是数字的一部分");
  assert.deepEqual(textsOf(line, "boolean"), ["true", "false"]);
  assert.deepEqual(textsOf(line, "null"), ["null"]);
  // 结构符号逐字符成类：四个键各带一个冒号，键之间三个逗号，外加花括号。
  assert.deepEqual(textsOf(line, "punct"), ["{", ":", ",", ":", ",", ":", ",", ":", "}"]);
});

test("JSON 分词: 负数连负号一起成类，不被词边界切掉", () => {
  // 回归：正则曾写成 `\b-?\d`，而 `-` 是非词字符，`\b` 在它前面不成立，
  // 负号被排除在匹配之外——`-12` 只匹配到 `12`，负数整段落进未识别分支、一个色都上不了。
  // JSON 里负数很常见，这条覆盖「负号 + 整数 / 小数 / 指数」三种形态。
  assert.deepEqual(textsOf('{ "n": -12 }', "number"), ["-12"], "负整数要带上负号");
  assert.deepEqual(textsOf('{ "n": -0.5 }', "number"), ["-0.5"], "负小数要带上负号");
  assert.deepEqual(textsOf('{ "n": -1.5e-3 }', "number"), ["-1.5e-3"], "负指数要带上负号");
  // 数组里紧跟 `[` 或 `,`（非空白）时同样要匹配上。
  assert.deepEqual(textsOf("[1, -2, -3.5]", "number"), ["1", "-2", "-3.5"], "数组元素里的负数");
  // 负号不能被当成标点或未识别段：整行拼回必须无损。
  const line = '{ "a": -1, "b": 2 }';
  assert.equal(
    segmentJsonLine(line, CLASSES)
      .map((segment) => segment.text)
      .join(""),
    line,
    "含负数的一行分词后拼回原文"
  );
});

test("JSON 分词: 转义引号不截断字符串", () => {
  const line = '{ "k": "a\\"b" }';
  assert.deepEqual(textsOf(line, "string"), ['"a\\"b"'], '转义的 \\" 不能当成字符串结束');
});

test("JSON 分词: 中文与未识别字符原样保留（cls 为空串）", () => {
  const segments = segmentJsonLine("  发票 ", CLASSES);
  assert.equal(segments.every((segment) => segment.cls === ""), true, "纯文本不该被误染色");
  assert.equal(segments.map((segment) => segment.text).join(""), "  发票 ", "分词不能丢字符");
});

test("JSON 分词: 任意一行拼回原文都不丢字符", () => {
  const lines = [
    '{ "a": [1, 2, { "b": null }], "c": "x" }',
    '  "key": "值 with spaces"  ',
    "[]",
    "",
    "\t\t{",
  ];
  for (const line of lines) {
    const rebuilt = segmentJsonLine(line, CLASSES)
      .map((segment) => segment.text)
      .join("");
    assert.equal(rebuilt, line, `分词必须无损：${JSON.stringify(line)}`);
  }
});

test("JSON 视图: 行数上限决定走折叠视图还是退回纯文本", () => {
  assert.equal(canRenderJsonView("{\n}"), true, "小正文可折叠");
  const atLimit = Array.from({ length: MAX_FOLD_LINES }, () => "x").join("\n");
  assert.equal(canRenderJsonView(atLimit), true, "恰好到上限仍可折叠");
  const overLimit = Array.from({ length: MAX_FOLD_LINES + 1 }, () => "x").join("\n");
  assert.equal(canRenderJsonView(overLimit), false, "超一行即退回纯文本");
});

test("JSON 视图: 只有对象与数组开头且能解析才算 JSON", () => {
  assert.equal(isJsonText('{ "a": 1 }'), true);
  assert.equal(isJsonText("[1, 2]"), true);
  assert.equal(isJsonText('  { "a": 1 }  '), true, "首尾空白不影响判定");
  assert.equal(isJsonText('{ "a": }'), false, "语法错误不算 JSON");
  assert.equal(isJsonText('"just a string"'), false, "标量字符串不是可折叠的 JSON");
  assert.equal(isJsonText("plain text"), false);
  assert.equal(isJsonText(""), false);
});

test("JSON 折叠: 嵌套对象产出可折叠块，省略号如实报出藏了几行", () => {
  const host = document.createElement("div");
  renderJsonView(host, '{\n  "a": {\n    "b": 1\n  }\n}', t);
  const nodes = host.querySelectorAll(".sfe-json-node");
  assert.ok(nodes.length >= 1, "嵌套对象应产出可折叠块");
  // 折叠时省略号文案报出被藏起来的行数（口径是「结束行 - 起始行」，含结束行本身）。
  // 这份 5 行正文的外层块从 `{` 到 `}`，报 4 行。
  const ellipsis = host.querySelector(".sfe-json-ellipsis");
  assert.ok(ellipsis, "可折叠块的头行应带省略号");
  assert.match(ellipsis!.textContent || "", /…\s*4\s*行/, "外层对象收起后如实报出藏起来的行数");
});

test("JSON 折叠: 数组同样可折叠，收尾的 ] 行归属正确", () => {
  const host = document.createElement("div");
  renderJsonView(host, "[\n  1,\n  2,\n  3\n]", t);
  const nodes = host.querySelectorAll(".sfe-json-node");
  assert.equal(nodes.length, 1, "整个数组是一个可折叠块");
  const head = nodes[0].querySelector(".sfe-json-toggle") as HTMLButtonElement;
  assert.ok(head, "数组块应有折叠按钮");
  head.click();
  assert.equal(nodes[0].classList.contains("collapsed"), true, "点一下收起");
  assert.equal(head.getAttribute("aria-expanded"), "false", "收起态要如实反映给读屏");
  head.click();
  assert.equal(nodes[0].classList.contains("collapsed"), false, "再点一下展开");
});

test("JSON 折叠: 未闭合的块在文件结束时仍能配对（不会漏掉最后一个折叠点）", () => {
  const host = document.createElement("div");
  // 外层 { 一直没有对应的 }：收尾逻辑必须把最后一行当作它的结束行。
  renderJsonView(host, '{\n  "a": {\n    "b": 1\n  }', t);
  assert.ok(host.querySelector(".sfe-json-toggle"), "未闭合的外层仍应产出折叠按钮");
});

test("JSON 折叠: 请求体视图默认展开并带编辑入口，非 JSON 退回语义着色层", () => {
  const jsonHost = document.createElement("div");
  let edited = 0;
  renderJsonFoldView(jsonHost, '{ "a": 1 }', t, { onEdit: () => (edited += 1) });
  const jsonDetails = jsonHost.querySelector<HTMLDetailsElement>(".sfe-json-details")!;
  assert.equal(jsonDetails.open, true, "请求体是要编辑/发出的操作型区块，默认展开");
  const editBtn = jsonHost.querySelector<HTMLButtonElement>(".sfe-json-edit-btn");
  assert.ok(editBtn, "给了 onEdit 就该有编辑按钮");
  editBtn!.click();
  assert.equal(edited, 1, "点编辑只切编辑态");

  // 非 JSON 正文：不给折叠视图，退回逐行语义着色，且不报错。
  const plainHost = document.createElement("div");
  renderJsonFoldView(plainHost, "not json at all", t);
  assert.equal(plainHost.querySelector(".sfe-json-view"), null, "非 JSON 不该画折叠块");
  assert.ok(plainHost.querySelector(".sfe-json-hl"), "非 JSON 退回语义着色层");
});
