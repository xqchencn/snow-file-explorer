import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { highlightCodeHtml } from '../../../src/components/highlighter.ts';
import { highlightCodeHtml as clientHighlight } from '../../../src/components/highlight-client.ts';
import { isBasicHighlightExt, highlightHttpLine } from '../../../src/components/syntax-basic.ts';

const CSS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/styles/syntax.css');

/**
 * 上游偶发传入 null 时的入参值。
 * as: 被测函数签名声明为 `code: string`，但实现按 falsy 兜底（highlighter.ts 的 highlightCode 与
 *   highlight-policy.ts 的 measureText 都先 `String(code || "")`），本用例验证的正是这条防御分支，
 *   故按运行时真实契约投喂 null，只在测试侧放宽形参类型。
 */
const NULL_INPUT = null as unknown as string;

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
  assert.equal(highlightCodeHtml(NULL_INPUT, 'js'), '');
});

test('语法高亮: 超长单行熔断保护（Prism 防灾难性回溯）', () => {
  // 压缩 JSON / minified 代码的一行可以有几万字符，Prism 会在其上灾难性卡死，
  // 超过单行上限时直接转义为纯文本，不进入 prismjs。
  const longLine = 'const x = 1; '.repeat(2000); // 单行 > 20000 字符
  assert.ok(longLine.length > 20000, '用例须越过单行上限');
  const html = highlightCodeHtml(longLine, 'js');
  assert.ok(!html.includes('class="token'), '超长单行不得产出 token');
  assert.ok(html.includes('const x = 1;'), '熔断时直接返回安全 escape 的纯文本');
  // 普通长度行照常着色
  assert.match(highlightCodeHtml('const a = 1;', 'js'), /class="token keyword"/);
});

test('语法高亮: 真实多语言样本产出的所有 token 类别均有 CSS 配色覆盖', () => {
  // 容器类 token 包裹整段嵌入代码（如 markdown 代码块、php 混排 html），
  // 必须保持颜色继承、不可染色，因此排除在覆盖校验之外。
  const isContainer = (t: string) =>
    t === 'content' || t === 'php' || t === 'code-block' || t.startsWith('language-');

  const css = fs.readFileSync(CSS_PATH, 'utf8');
  assert.match(
    css,
    /:is\(\.sfe-file-viewer-code, \.sfe-file-viewer-code-scroll-virtual\) \.token/,
    '虚拟列表里的 token 必须命中与整块代码相同的配色'
  );
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

  const produced = new Set<string>();
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

test('语法高亮: .vue 整篇调用按 SFC 区块分节着色（兜底路径不得退纯文本）', () => {
  // Prism 没有 vue 语言、EXT_TO_PRISM_LANG 也不再映射——整篇调用必须在懒块内
  // 按 SFC 区块拆行着色，否则 diff 兜底等调用方拿到的是转义纯文本。
  const vue = [
    '<template>',
    '  <b class="a">{{ n }}</b>',
    '</template>',
    '<script lang="ts">',
    'const n = 1;',
    '</script>',
  ].join('\n');
  const html = highlightCodeHtml(vue, 'vue');
  assert.match(html, /class="token tag"/, '模板行按 HTML 着色');
  assert.match(html, /class="token keyword"/, '脚本体按 TS 着色');
  assert.match(html, /class="token attr-name"/, '模板属性按 HTML 着色');
  // svelte 同构
  assert.match(highlightCodeHtml('<style>\n.a{color:red}\n</style>', 'svelte'), /class="token selector"/);
});

test('语法高亮: .http 文件正文 JSON 着色（不写 Content-Type 也要着色）', () => {
  // 项目里的 .http 请求行不带 HTTP 版本号、也常不写 Content-Type 头，
  // 而 Prism 自带的 http 语法只认 Content-Type 才给正文上色 → 正文一片纯白。
  // 这里断言：无论有没有 Content-Type，正文里的 JSON 键都要着色。
  const withCt = ['POST https://a.test/users', 'Content-Type: application/json', '', '{ "name": "Ada" }'].join('\n');
  const withoutCt = ['POST https://a.test/users', '', '{ "name": "Ada", "age": 37 }'].join('\n');
  for (const [label, code] of [['有 Content-Type', withCt], ['无 Content-Type', withoutCt]] as const) {
    const html = highlightCodeHtml(code, 'http');
    // 正文里的键（转义后是 &quot;）必须包在 token property 里
    assert.match(html, /token property">&quot;/, `${label}: 正文键要着色`);
  }
  // 多分节：每节的正文键都着色（方法也是 property，故只数被引号包住的键）
  const multi = ['### 一', 'POST https://a.test/a', '', '{ "a": 1 }', '', '### 二', 'POST https://a.test/b', '', '{ "b": 2 }'].join('\n');
  const html = highlightCodeHtml(multi, 'http');
  assert.equal((html.match(/token property">&quot;/g) || []).length, 2, '两节正文各自着色');
});

test('语法高亮: .rest 文件也按 HTTP 请求着色，不走 reStructuredText', () => {
  const code = ['GET https://a.test/users', 'Accept: application/json', '', '{ "ok": true }'].join('\n');
  const html = highlightCodeHtml(code, 'rest');
  assert.match(html, /token property">&quot;/, '正文键要着色');
  assert.match(html, /class="token [^"]*\bkeyword\b/, '头部名要着色');
});

test('语法高亮: .http 与 .rest 同一输入输出逐字节一致（两种扩展名同构）', () => {
  // 用户诉求：`.http` 和 `.rest` 必须是同一套语法。扫描、解析、图标已共用一份实现，
  // 高亮也必须如此——同一份文本走两个扩展名，输出不能有任何差别。
  const sample = [
    '### 登录',
    '# 注释行',
    '@host = https://api.example.com',
    '',
    'POST {{host}}/login HTTP/1.1',
    'Content-Type: application/json',
    '',
    '{"user":"tom","age":18,"ok":true,"n":null}',
    '',
    'GET /plain',
  ].join('\n');
  assert.equal(
    highlightCodeHtml(sample, 'http'),
    highlightCodeHtml(sample, 'rest'),
    '.http 与 .rest 的高亮输出必须逐字节一致'
  );
});

test('语法高亮: 请求行认 {{变量}} 前缀地址，方法/变量/路径/版本各自着色且版本不被当 JSON 数字', () => {
  // rest-client 最主流的写法是 `{{host}}/login`：地址不是 http(s):// 也不是 / 开头，
  // 旧的请求行正则整行漏掉，方法/地址不着色、`HTTP/1.1` 还被当 JSON 数字染色。
  const html = highlightCodeHtml('POST {{host}}/login HTTP/1.1', 'http');
  assert.match(html, /token property">POST</, '方法要着色');
  assert.match(html, /token variable">\{\{host\}\}</, '地址里的变量段单独着色');
  assert.match(html, /token url">\/login</, '相对路径按 URL 着色');
  assert.match(html, /token keyword">HTTP\/1\.1</, 'HTTP 版本单独着色');
  assert.doesNotMatch(html, /token number/, 'HTTP 版本不该被当成 JSON 数字');
});

test('语法高亮: 熔断只剩单行长度上限，整篇体量阈值已随统一管线废除', () => {
  // 单行超长：压缩 JSON / minified 代码即便行数极少也必须熔断，
  // 否则 Prism 会在单行上灾难性卡死。
  assert.doesNotMatch(highlightCodeHtml('x'.repeat(20001), 'js'), /class="token/);
  // 单行未超阈值仍可高亮（边界：恰好 20000 字符）
  assert.match(highlightCodeHtml('const a = 1; '.padEnd(20000, 'x'), 'js'), /class="token keyword"/);
  // 「行数多但每行很短」的大文件由调用方逐行喂入，照常着色：
  // 整篇行数 / 字符数不再构成熔断条件（统一懒加载后不存在整篇高亮路径）。
  const lines = Array.from({ length: 5000 }, (_, i) => `const v${i} = ${i};`);
  for (const line of lines.slice(0, 50).concat(lines.slice(-50))) {
    assert.match(highlightCodeHtml(line, 'js'), /class="token keyword"/, '大文件的单行也必须着色');
  }
});

test('语法高亮: measureText 一次扫描得到行数与最长行（Markdown 水合门控消费）', async () => {
  const { measureText } = await import('../../../src/components/highlight-policy.ts');
  assert.deepEqual(measureText(''), { length: 0, lines: 0, maxLineLen: 0 });
  assert.equal(measureText(NULL_INPUT).lines, 0);
  assert.deepEqual(measureText('a\nbb\nccc'), { length: 8, lines: 3, maxLineLen: 3 });
});

test('语法高亮: http/rest 由首屏内置着色器同步上色，不依赖懒加载高亮块', () => {
  // 回归：着色逻辑曾只住在 575KB 的懒加载块里，块没就绪就整篇无色——
  // 表现为「http 文件里的 JSON 一片白」。http/rest 的着色只靠正则，必须能同步给出。
  assert.equal(isBasicHighlightExt('http'), true);
  assert.equal(isBasicHighlightExt('.REST'), true);
  assert.equal(isBasicHighlightExt('js'), false);

  // 不安装高亮块（等价于块从未到达），http 仍必须产出 token
  const http = clientHighlight('POST https://a.test/x\n\n{ "k": 1, "b": false }', 'http');
  assert.match(http, /token property">POST</, '请求方法要着色');
  assert.match(http, /token property">&quot;k&quot;/, 'JSON 键要着色');
  assert.match(http, /token number">1</, 'JSON 数字要着色');
  assert.match(http, /token boolean">false</, 'JSON 布尔要着色');

  // 对照：其它语言在块未就绪时仍返回空串（由调用方回退纯文本，块到了再上色）
  assert.equal(clientHighlight('const a = 1;', 'js'), '');

  // 行级自足：单行调用（大文件虚拟列表路径）与整篇调用结果一致
  const line = '{ "k": 1 }';
  assert.equal(highlightHttpLine(line), clientHighlight(line, 'http'));
});

test('语法高亮: http 文件含超长单行时，其余行仍照常着色（单行熔断不连累整篇）', () => {
  // 回归：真实文件里有一行 12 万字符的压缩 JSON，曾触发 `单行超长即熔断`，
  // 把整个文件拖成一片纯文本——用户看到的正是「http 里的 JSON 一片白」。
  // 单行熔断只该跳过那一行，其余行必须照常着色。
  const longLine = 'x'.repeat(30000);
  const code = ['### 一', 'POST https://a.test/x', '', '{ "k": 1, "b": false }', longLine, '', '### 二', '{ "n": 2 }'].join('\n');
  const html = clientHighlight(code, 'http');
  assert.match(html, /token property">&quot;k&quot;/, '超长行之前的 JSON 键要着色');
  assert.match(html, /token boolean">false</, '超长行之前的布尔要着色');
  assert.match(html, /token property">&quot;n&quot;/, '超长行之后的 JSON 键也要着色');
  assert.match(html, /token property">POST</, '请求方法要着色');
  // 超长行本身按纯文本处理，但不得以 token 形式出现
  assert.doesNotMatch(html, /token [^"]*">x{100}/, '超长行自身不着色');
});
