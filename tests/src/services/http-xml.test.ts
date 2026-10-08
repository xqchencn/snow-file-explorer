import test from "node:test";
import assert from "node:assert/strict";
import { parseXml, selectFirstByXPath } from "../../../src/services/http-xml.ts";
import type { XmlNode } from "../../../src/services/http-xml.ts";

const XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  "<root>",
  "  <!-- 注释不该变成值 -->",
  "  <replies>",
  '    <reply id="a1" lang="zh">第一</reply>',
  '    <reply id="b2" lang="en">Second &amp; more</reply>',
  "  </replies>",
  '  <Catalog><Book id="b1" category="REF"><title>实价</title></Book></Catalog>',
  "  <empty/>",
  "  <cdata><![CDATA[<not-xml> & raw]]></cdata>",
  "</root>",
].join("\n");

/** 只取元素子节点（文本节点也在 children 里，断言树形时先滤掉）。 */
function elementChildren(node: XmlNode | null | undefined): XmlNode[] {
  return (node?.children || []).filter((child) => child.kind === "element");
}

function elements(node: XmlNode | null | undefined): string[] {
  return elementChildren(node).map((child) => child.name);
}

test("HTTP XML: 解析元素、属性、自闭合、CDATA 与实体", () => {
  const root = parseXml(XML);
  assert.notEqual(root, null);
  assert.deepEqual(elements(root), ["root"], "处理指令与注释都不进元素树");
  const doc = elementChildren(root)[0];
  assert.deepEqual(elements(doc), ["replies", "Catalog", "empty", "cdata"]);
  assert.equal(elementChildren(doc)[2].children.length, 0, "自闭合标签不压栈");
  // 实体还原与 CDATA 原文都从取值这一层验，绕开树里的空白文本节点。
  assert.equal(selectFirstByXPath(XML, "//reply[2]")?.value, "Second & more", "&amp; 还原");
  assert.equal(selectFirstByXPath(XML, "//cdata")?.value, "<not-xml> & raw", "CDATA 里不解析标签也不解实体");
});

test("HTTP XML: 没有任何元素时按「不是 XML」处理", () => {
  assert.equal(parseXml("plain text"), null);
  assert.equal(parseXml(""), null);
  assert.equal(parseXml("<"), null);
});

test("HTTP XML: XPath 取属性、按位置取元素、按属性过滤", () => {
  assert.equal(selectFirstByXPath(XML, "//reply[1]/@id")?.value, "a1");
  assert.equal(selectFirstByXPath(XML, "//reply[2]/@id")?.value, "b2", "谓词里的位置下标从 1 开始");
  assert.equal(selectFirstByXPath(XML, "//reply/@id")?.value, "a1", "只取第一个命中");
  assert.equal(selectFirstByXPath(XML, "/root/replies/reply[1]/@lang")?.value, "zh");
  assert.equal(selectFirstByXPath(XML, "//Book[@category='REF']/title/text()")?.value, "实价");
  assert.equal(selectFirstByXPath(XML, "//Book[@category='NOPE']/title")?.kind, undefined, "属性对不上就没命中");
  assert.equal(selectFirstByXPath(XML, "//Book/@id")?.value, "b1");
  assert.equal(selectFirstByXPath(XML, "//empty")?.value, "");
});

test("HTTP XML: 超出子集或没命中都报「没命中」，不猜一个值出去", () => {
  assert.equal(selectFirstByXPath(XML, "//nope[1]/@id"), null);
  assert.equal(selectFirstByXPath(XML, "//reply/text()/@id"), null, "属性步之后不能再有步");
  assert.equal(selectFirstByXPath("plain text", "//a"), null, "不是 XML 就解不出东西");
  assert.equal(selectFirstByXPath(XML, ""), null);
  assert.equal(selectFirstByXPath(XML, "//reply[")?.kind, "element", "谓词写坏了按名字取第一个");
});

test("HTTP XML: 元素命中给拼接文本，嵌套元素的文字一起收", () => {
  const nested = '<root><a>一<b>二</b>三</a></root>';
  assert.equal(selectFirstByXPath(nested, "//a")?.value, "一二三");
  assert.equal(selectFirstByXPath(nested, "//b")?.value, "二");
});
