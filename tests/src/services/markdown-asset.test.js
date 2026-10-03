import test from 'node:test';
import assert from 'node:assert/strict';
import { isMarkdownPath, normalizePath, resolveMarkdownAssetPath } from '../../../src/services/markdown-asset.js';

test('Markdown: isMarkdownPath 识别文档扩展名', () => {
  assert.equal(isMarkdownPath('README.md'), true);
  assert.equal(isMarkdownPath('docs/guide.MARKDOWN'), true);
  assert.equal(isMarkdownPath('page.mdx'), true);
  assert.equal(isMarkdownPath('note.mkd'), true);
  assert.equal(isMarkdownPath('main.js'), false);
  assert.equal(isMarkdownPath('markdown'), false);
  assert.equal(isMarkdownPath(''), false);
  assert.equal(isMarkdownPath(null), false);
});

test('Markdown: normalizePath 归一化 Windows / POSIX 路径', () => {
  // 保留输入路径的分隔符风格（正斜杠输入 → 正斜杠输出，反斜杠同理）
  assert.equal(normalizePath('D:/repo/docs/../img/a.png'), 'D:/repo/img/a.png');
  assert.equal(normalizePath('D:/repo/./img/a.png'), 'D:/repo/img/a.png');
  assert.equal(normalizePath('D:\\repo\\docs\\..\\img\\a.png'), 'D:\\repo\\img\\a.png');
  assert.equal(normalizePath('/home/u/docs/../a.png'), '/home/u/a.png');
  // 绝对路径越过根时忽略多余 ".."，避免逃逸
  assert.equal(normalizePath('/a/../../b'), '/b');
  // 相对路径保留向上的 ".."
  assert.equal(normalizePath('docs/../../x'), '../x');
});

test('Markdown: resolveMarkdownAssetPath 仅解析本地相对引用', () => {
  const doc = 'D:/repo/docs/guide.md';

  // 相对路径 → 基于文档目录解析为绝对路径
  assert.equal(resolveMarkdownAssetPath('./img/a.png', doc), 'D:/repo/docs/img/a.png');
  assert.equal(resolveMarkdownAssetPath('img/a.png', doc), 'D:/repo/docs/img/a.png');
  assert.equal(resolveMarkdownAssetPath('../assets/b.png', doc), 'D:/repo/assets/b.png');
  // query / fragment 剥离，含空格文件名保持原样
  assert.equal(resolveMarkdownAssetPath('img/a.png?raw=1', doc), 'D:/repo/docs/img/a.png');
  assert.equal(resolveMarkdownAssetPath('img/a.png#frag', doc), 'D:/repo/docs/img/a.png');
  assert.equal(resolveMarkdownAssetPath('img/my file.png', doc), 'D:/repo/docs/img/my file.png');
  assert.equal(resolveMarkdownAssetPath('img/a%20b.png', doc), 'D:/repo/docs/img/a b.png');

  // 外链 / 协议相对 / 纯锚点 / 任意 scheme 一律不本地解析
  assert.equal(resolveMarkdownAssetPath('https://x.com/a.png', doc), null);
  assert.equal(resolveMarkdownAssetPath('//cdn.com/a.png', doc), null);
  assert.equal(resolveMarkdownAssetPath('data:image/png;base64,AAAA', doc), null);
  assert.equal(resolveMarkdownAssetPath('file:///c:/a.png', doc), null);
  assert.equal(resolveMarkdownAssetPath('mailto:a@b.com', doc), null);
  assert.equal(resolveMarkdownAssetPath('#anchor', doc), null);
  assert.equal(resolveMarkdownAssetPath('', doc), null);
  assert.equal(resolveMarkdownAssetPath('a.png', ''), null);
});
