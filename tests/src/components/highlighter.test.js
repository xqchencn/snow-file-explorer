import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { highlightCodeHtml, shouldHighlight, isLargeText } from '../../../src/components/highlighter.js';

const CSS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/styles/syntax.css');

test('语法高亮: JSON 结构分词', () => {
  const jsonCode = '{\n  "name": "snow",\n  "version": 1,\n  "ok": true\n}';
  const html = highlightCodeHtml(jsonCode, 'json');
  assert.match(html, /class="token property"/);
  assert.match(html, /class="token string"/);
  assert.match(html, /class="token number"/);
  assert.match(html, /class="token boolean"/);
});

test('语法高亮: JavaScript / TypeScript 关键字与函数', () => {
  const tsCode = 'export async function calculate(total: number): Promise<void> { return; }';
  const html = highlightCodeHtml(tsCode, 'ts');
  assert.match(html, /class="token keyword"/);
  assert.match(html, /class="token function"/);
});

test('语法高亮: Python 语法高亮', () => {
  const pyCode = 'def hello(name: str):\n    # 问候\n    print(f"Hi {name}")';
  const html = highlightCodeHtml(pyCode, 'py');
  assert.match(html, /class="token keyword"/);
  assert.match(html, /class="token comment"/);
});

test('语法高亮: 未知扩展名安全降级纯文本', () => {
  const unknownCode = '<raw_data key="val">';
  const html = highlightCodeHtml(unknownCode, 'xyz123');
  assert.equal(html, '&lt;raw_data key=&quot;val&quot;&gt;');
});

test('语法高亮: 空白输入安全返回', () => {
  assert.equal(highlightCodeHtml('', 'js'), '');
  assert.equal(highlightCodeHtml(null, 'js'), '');
});

test('语法高亮: 超大文本 (>250k) 熔断保护', () => {
  const bigCode = 'const x = 1;\n'.repeat(25000); // > 300,000 字符
  const html = highlightCodeHtml(bigCode, 'js');
  // 熔断时不调用 prismjs，直接返回安全 escape 的纯文本
  assert.ok(!html.includes('class="token keyword"'));
  assert.ok(html.includes('const x = 1;'));
});

test('语法高亮: 真实多语言样本产出的所有 token 类别均有 CSS 配色覆盖', () => {
  // 容器类 token 包裹整段嵌入代码（如 markdown 代码块、php 混排 html），
  // 必须保持颜色继承、不可染色，因此排除在覆盖校验之外。
  const isContainer = (t) =>
    t === 'content' || t === 'php' || t === 'code-block' || t.startsWith('language-');

  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const covered = new Set([...css.matchAll(/\.token\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]));

  // 覆盖高 token 种类语言的代表性样本
  const samples = [
    ['js', 'import x from "y"; /* c */ const a = `t${1}`; class A { async #m() { return /re/g; } } new Foo().bar?.();'],
    ['ts', 'interface I<T> { x: T } enum E { A = 1 } @dec class C implements I<number> {}'],
    ['py', 'import os\ndef f(x: int) -> str:\n    """doc"""\n    return f"{x}"  # c\nclass C(Base):\n    @dec\n    async def m(self):\n        pass\n'],
    ['json', '{"a":1,"b":[true,null],"c":{"d":"e"}}'],
    ['css', '@media (min-width:1px){.a:hover{color:#fff;background:url(x.png)}}'],
    ['html', '<!DOCTYPE html><div class="a"><!-- c --><script>var a=1</script><style>.b{}</style></div>'],
    ['yaml', 'key: value\nlist:\n  - a: 1\n# comment\nbool: true'],
    ['rs', 'use std::io; fn main() { let x: i32 = 1; println!("{}", x); } struct S { a: u8 }'],
    ['sql', "SELECT a, COUNT(*) FROM t WHERE x = 'y' GROUP BY a; -- c"],
    ['md', '# H\n**b** *i* [l](u) `c`\n> q\n```js\nx\n```\n'],
    ['diff', '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new'],
    ['sh', '#!/bin/bash\nfor f in *.txt; do echo "$f"; done\nif [ -f x ]; then cat x; fi'],
    ['go', 'package main\nfunc main(){ var x int = 1 }\ntype S struct{ A int }'],
    ['php', '<?php\nclass C { public function m() { echo "x"; } }\n$x = [1,2];'],
    ['kt', 'fun main() { val x: Int = 1; println("$x") }\nclass C(val a: Int)'],
    ['c', '#include <stdio.h>\nint main(void){ int *p = NULL; return 0; }'],
  ];

  const produced = new Set();
  for (const [ext, code] of samples) {
    const html = highlightCodeHtml(code, ext);
    for (const m of html.matchAll(/class="token ([^"]+)"/g)) {
      m[1]
        .trim()
        .split(/\s+/)
        .forEach((c) => produced.add(c));
    }
  }

  assert.ok(produced.size > 50, `样本应产出大量 token 类别，实际仅 ${produced.size}`);

  const missing = [...produced].filter((t) => !covered.has(t) && !isContainer(t)).sort();
  assert.deepEqual(missing, [], `以下 token 类别缺少 CSS 配色规则: ${missing.join(', ')}`);
});

test('语法高亮: shouldHighlight 熔断判定同时按字符数与行数', () => {
  // 小文本：高亮
  assert.equal(shouldHighlight('const a = 1;'), true);
  assert.equal(shouldHighlight(''), false);
  // 字符数超限：熔断
  assert.equal(shouldHighlight('x'.repeat(250001)), false);
  // 单行超长：压缩 JSON / minified 代码即便总字符数与行数都未超限，也必须熔断，
  // 否则 Prism 会在单行上灾难性卡死（行数熔断挡不住它）。
  assert.equal(shouldHighlight('x'.repeat(20001)), false, '单行超长应熔断');
  assert.equal(shouldHighlight('x'.repeat(20000)), true, '单行未超阈值仍可高亮');
  // 行数超限但字符数远未超限：这是本次修复的核心——大文件按行数熔断，
  // 逐行高亮不再被单行短文本绕过。
  assert.equal(shouldHighlight('a\n'.repeat(4000)), false, '4001 行应熔断');
  // 行数边界：恰好 4000 行仍可高亮
  assert.equal(shouldHighlight('a\n'.repeat(3999)), true, '4000 行应在阈值内');
});

test('语法高亮: isLargeText 判定大文件，空文本不算大', () => {
  // 空文本不应被当作「大文件」（否则空文件会被误导去走虚拟化渲染）
  assert.equal(isLargeText(''), false);
  assert.equal(isLargeText(null), false);
  // 普通文件不是大文件
  assert.equal(isLargeText('const a = 1;'), false);
  // 行数/字符数任一超限即大文件
  assert.equal(isLargeText('a\n'.repeat(4000)), true);
  assert.equal(isLargeText('x'.repeat(250001)), true);
  // 单行超长（行数远未超限）同样视为大文件，交由虚拟化渲染
  assert.equal(isLargeText('x'.repeat(20001)), true);
});
