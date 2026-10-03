import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// 在导入渲染模块前建立最小 DOM 环境：DOMPurify 依赖 window/document 完成净化
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Prism 的浏览器插件初始化会访问 Element，Node 测试环境需显式接入 JSDOM 构造器。
globalThis.Element = dom.window.Element;

const { renderMarkdownHtml } = await import('../../../src/components/markdown-renderer.js');
const { renderCodeViewer } = await import('../../../src/components/code-viewer.js');
const { parseUnifiedDiff } = await import('../../../src/services/diff.js');
const { resolveProxiedImageSrc } = await import('../../../src/services/markdown-asset.js');

const t = (_key, fallback) => fallback || _key;
test('预览组件: Markdown 默认预览模式，可切代码模式，仅本地图片转异步回填属性', () => {
  const host = document.createElement('div');
  const source = '# T\n\n![本地](./img/a.png)\n\n![外链](https://img.shields.io/badge/License-MIT-blue.svg)';
  const preview = {
    kind: 'text',
    name: 'a.md',
    path: 'D:/repo/a.md',
    text: source,
    html: renderMarkdownHtml(source),
    isMarkdown: true,
    mode: 'preview',
    truncated: false,
  };

  renderCodeViewer(host, { preview, copied: false, onCopy: () => {}, onSetMode: () => {}, t });

  // 模式切换控件存在，且默认激活“预览”
  const buttons = host.querySelectorAll('.sfe-md-mode-btn');
  assert.equal(buttons.length, 2, '应渲染预览/代码两个模式按钮');
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true', '默认应为预览模式');
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'false');
  // 默认渲染 Markdown 正文，而非代码块
  assert.ok(host.querySelector('.sfe-markdown-body'), '默认应渲染 Markdown 正文容器');
  assert.equal(host.querySelector('.sfe-file-viewer-code'), null, '预览模式不应渲染代码视图');

  // 本地相对图片：src 转为 data-sfe-src 并移除 src，交由宿主异步读取回填
  const localImg = host.querySelector('.sfe-markdown-body img[data-sfe-src]');
  assert.equal(localImg.getAttribute('data-sfe-src'), './img/a.png');
  assert.equal(localImg.getAttribute('src'), null);

  // 外链图片：必须改写为宿主 img-proxy 代理 URL。
  // 宿主渲染进程 CSP 的 img-src 不放行 https:，若原样保留会被浏览器拦截导致空白
  // （README 徽章不显示的根因）。这里断言最终 src 已是代理协议，才能被 CSP 放行显示。
  const remoteImg = host.querySelector('.sfe-markdown-body img[src]');
  const expectedProxy = 'img-proxy://localhost/' + encodeURIComponent('https://img.shields.io/badge/License-MIT-blue.svg');
  assert.equal(remoteImg.getAttribute('src'), expectedProxy);
  assert.equal(remoteImg.getAttribute('data-sfe-src'), null);
  assert.ok(!/^https?:/.test(remoteImg.getAttribute('src')), '外链 src 不得保留 http(s)（会被 CSP 拦截）');
});

test('Markdown 外链图片: 解析为宿主 img-proxy 代理 URL（CSP 放行 img-proxy:）', () => {
  // 纯函数契约：与宿主 src/renderer/utils/imageProxyUrl.ts 的 imageProxyUrl 一致
  assert.equal(
    resolveProxiedImageSrc('https://img.shields.io/badge/License-MIT-blue.svg'),
    'img-proxy://localhost/' + encodeURIComponent('https://img.shields.io/badge/License-MIT-blue.svg')
  );
  assert.equal(
    resolveProxiedImageSrc('http://example.com/a.png?x=1&y=2'),
    'img-proxy://localhost/' + encodeURIComponent('http://example.com/a.png?x=1&y=2')
  );
  // 非外链一律返回 null：本地相对路径、data:、空值、协议相对路径
  assert.equal(resolveProxiedImageSrc('./img/a.png'), null);
  assert.equal(resolveProxiedImageSrc('/abs/a.png'), null);
  assert.equal(resolveProxiedImageSrc('data:image/png;base64,AAAA'), null);
  assert.equal(resolveProxiedImageSrc('//cdn.example.com/a.png'), null);
  assert.equal(resolveProxiedImageSrc(''), null);
  assert.equal(resolveProxiedImageSrc(null), null);
});

test('预览组件: Markdown 代码模式渲染语法高亮视图', () => {
  const host = document.createElement('div');
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'a.md',
      path: 'D:/repo/a.md',
      text: '# T',
      highlightedHtml: '<span class="token title"># T</span>',
      isMarkdown: true,
      mode: 'code',
      truncated: false,
    },
    copied: false,
    onCopy: () => {},
    onSetMode: () => {},
    t,
  });

  assert.ok(host.querySelector('.sfe-file-viewer-code'), '代码模式应渲染代码视图');
  assert.equal(host.querySelector('.sfe-markdown-body'), null, '代码模式不应渲染 Markdown 正文');
  const activeBtn = host.querySelector('.sfe-md-mode-btn.active');
  assert.equal(activeBtn.getAttribute('aria-pressed'), 'true', '代码按钮应处于激活态');
});

test('Git 差异视图: 按文件语言高亮增删行正文并保持源码安全', () => {
  const host = document.createElement('div');
  const result = parseUnifiedDiff('@@ -1,2 +1,2 @@\n-const oldValue = 1;\n+const newValue = "<img src=x onerror=alert(1)>";');

  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'example.js',
      text: 'const newValue = "<img src=x onerror=alert(1)>";',
      diff: { result, fullContent: 'const newValue = "<img src=x onerror=alert(1)>";' },
      gitView: 'diff',
      diffMode: 'unified',
      diffScopeMode: 'hunks',
    },
    copied: false,
    onCopy: () => {},
    onSetMode: () => {},
    onSetDiffMode: () => {},
    onSetScopeMode: () => {},
    t,
  });

  const deleted = host.querySelector('.sfe-diff-line.del .sfe-diff-text');
  const added = host.querySelector('.sfe-diff-line.add .sfe-diff-text');
  assert.ok(deleted.querySelector('.token.keyword'), '删除行也应按 JavaScript 语法高亮');
  assert.ok(added.querySelector('.token.keyword'), '新增行也应按 JavaScript 语法高亮');
  assert.ok(added.querySelector('.token.string'), '字符串 token 应保留');
  assert.equal(added.querySelector('img'), null, '源码中的 HTML 不得被当成 DOM 标签执行');
  assert.match(added.textContent, /onerror=alert\(1\)/, '源码文本必须完整保留');
});

