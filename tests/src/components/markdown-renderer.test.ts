import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// 在导入渲染模块前建立最小 DOM 环境：DOMPurify 依赖 window/document 完成净化
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderMarkdownHtml } = await import('../../../src/components/markdown-renderer.ts');

/**
 * 宿主/上游偶发传入 null 时的入参值。
 * as: 被测函数签名声明为 `markdownText: string`，但实现按 falsy 兜底
 *   （markdown-renderer.ts 的 renderMarkdownHtml 里 `String(markdownText || "")`），本用例验证的正是这条防御分支，
 *   故按运行时真实契约投喂 null，只在测试侧放宽形参类型。
 */
const NULL_INPUT = null as unknown as string;

test('Markdown 渲染: 基础结构（标题/强调/列表/代码块）', () => {
  const html = renderMarkdownHtml('# 标题\n\n**粗体** 与 `code`\n\n- 甲\n- 乙\n\n```js\nconst a = 1;\n```');
  assert.match(html, /<h1[^>]*>标题<\/h1>/);
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<li>甲<\/li>/);
  assert.match(html, /<pre><code class="language-js">/);
});

test('Markdown 渲染: 空输入返回空串', () => {
  assert.equal(renderMarkdownHtml(''), '');
  assert.equal(renderMarkdownHtml('   \n  '), '');
  assert.equal(renderMarkdownHtml(NULL_INPUT), '');
});

test('Markdown 渲染: 净化脚本标签与内联事件处理器（XSS 防御）', () => {
  const html = renderMarkdownHtml('<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">\n\n<div onclick="alert(3)">文本</div>');
  assert.ok(!/<script/i.test(html), `不得保留 <script>：${html}`);
  assert.ok(!/onerror/i.test(html), `不得保留 onerror 事件属性：${html}`);
  assert.ok(!/onclick/i.test(html), `不得保留 onclick 事件属性：${html}`);
  // 正常文本内容保留
  assert.match(html, /文本/);
});

test('Markdown 渲染: 危险标签与危险协议链接被移除', () => {
  const html = renderMarkdownHtml('[x](javascript:alert(1))\n\n<iframe src="https://evil.com"></iframe>\n\n<style>body{display:none}</style>');
  assert.ok(!/javascript:/i.test(html), `不得保留 javascript: 协议：${html}`);
  assert.ok(!/<iframe/i.test(html), `不得保留 <iframe>：${html}`);
  assert.ok(!/<style/i.test(html), `不得保留 <style>：${html}`);
});

test('Markdown 渲染: 外链新标签打开，data:image 图片源放行', () => {
  const html = renderMarkdownHtml('[外链](https://example.com/a)\n\n![图](data:image/png;base64,AAAA)');
  assert.match(html, /<a[^>]*href="https:\/\/example\.com\/a"[^>]*target="_blank"[^>]*>/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /<img[^>]*src="data:image\/png;base64,AAAA"/);
});
