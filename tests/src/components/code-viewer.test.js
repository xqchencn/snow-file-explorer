import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// 在导入渲染模块前建立最小 DOM 环境：DOMPurify 依赖 window/document 完成净化
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Prism 的浏览器插件初始化会访问 Element，Node 测试环境需显式接入 JSDOM 构造器。
globalThis.Element = dom.window.Element;

function setClipboard({ writeText = async () => {}, readText = async () => "" } = {}) {
  const clipboard = { writeText, readText };
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
  return clipboard;
}

function dispatchContextMenu(target) {
  target.dispatchEvent(
    new dom.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 20,
    })
  );
}

function flushClipboardRead() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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


test('预览组件: 普通文本默认只读，笔/眼睛按钮切换真实编辑状态', () => {
  const host = document.createElement('div');
  let editable = false;
  let inputValue = '';
  const preview = {
    kind: 'text',
    name: 'a.js',
    path: 'D:/repo/a.js',
    text: 'const value = 1;',
    highlightedHtml: '<span>const value = 1;</span>',
    isMarkdown: false,
    mode: 'preview',
    truncated: false,
  };
  const render = () =>
    renderCodeViewer(host, {
      preview,
      copied: false,
      onCopy: () => {},
      onToggleEdit: (next) => {
        editable = next;
        render();
      },
      onEditInput: (value) => {
        inputValue = value;
      },
      onSave: () => {},
      editable,
      t,
    });

  render();
  const editButton = host.querySelector('.sfe-floating-edit-btn');
  assert.ok(editButton, '普通文本默认应显示编辑按钮');
  assert.equal(editButton.title, '编辑');
  assert.equal(host.querySelector('textarea'), null, '默认只读不能渲染 textarea');

  editButton.click();
  const textarea = host.querySelector('textarea');
  assert.ok(textarea, '点击笔图标后应进入真实编辑模式');
  assert.equal(host.querySelector('.sfe-floating-edit-btn').title, '只读');
  const editHighlight = host.querySelector('.sfe-file-viewer-edit-highlight');
  assert.ok(editHighlight, '编辑模式应保留语法高亮层');
  assert.ok(editHighlight.classList.contains('sfe-file-viewer-code'), '编辑高亮层必须复用代码 token 配色作用域');
  assert.ok(editHighlight.querySelector('.token.keyword'), '编辑模式应显示关键字高亮');
  textarea.value = 'const value = 2;';
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(inputValue, 'const value = 2;');
  assert.ok(editHighlight.querySelector('.token.keyword'), '输入后高亮层应实时更新');

  host.querySelector('.sfe-floating-edit-btn').click();
  assert.equal(host.querySelector('textarea'), null, '点击眼睛图标后应返回只读');
});

test('预览组件: Markdown 预览不显示编辑按钮，代码模式才显示笔图标', () => {
  const host = document.createElement('div');
  const preview = {
    kind: 'text',
    name: 'README.md',
    path: 'D:/repo/README.md',
    text: '# title',
    html: '<h1>title</h1>',
    highlightedHtml: '<span># title</span>',
    isMarkdown: true,
    mode: 'preview',
    truncated: false,
  };
  const render = () =>
    renderCodeViewer(host, {
      preview,
      copied: false,
      onCopy: () => {},
      onSetMode: (mode) => {
        preview.mode = mode;
        render();
      },
      onToggleEdit: () => {},
      onSave: () => {},
      t,
    });

  render();
  assert.equal(host.querySelector('.sfe-floating-edit-btn'), null);
  assert.equal(host.querySelector('textarea'), null);
  host.querySelector('.sfe-md-mode-btn:not(.active)').click();
  assert.ok(host.querySelector('.sfe-floating-edit-btn'), 'Markdown 代码模式应显示编辑按钮');
  assert.equal(host.querySelector('.sfe-floating-edit-btn').title, '编辑');
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
    },
    copied: false,
    onCopy: () => {},
    onSetMode: () => {},
    onSetDiffMode: () => {},
    t,
  });

  const deleted = host.querySelector('.sfe-diff-line.del .sfe-diff-text');
  const added = host.querySelector('.sfe-diff-line.add .sfe-diff-text');
  assert.ok(deleted.querySelector('.token.keyword'), '删除行也应按 JavaScript 语法高亮');
  assert.ok(added.querySelector('.token.keyword'), '新增行也应按 JavaScript 语法高亮');
  assert.ok(added.querySelector('.token.string'), '字符串 token 应保留');
  assert.equal(added.querySelector('img'), null, '源码中的 HTML 不得被当成 DOM 标签执行');
  assert.match(added.textContent, /onerror=alert\(1\)/, '源码文本必须完整保留');
  assert.equal(host.querySelector('.sfe-floating-edit-btn'), null, 'Git 差异视图不应出现编辑按钮');
});

test('Git 差异视图: 超大差异整体降级为纯文本，不再逐行调用 Prism', () => {
  const host = document.createElement('div');
  // 构造超过行数熔断阈值（4000 行）的全文件差异，触发整体降级
  const fullContent = Array.from({ length: 4100 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const result = parseUnifiedDiff('@@ -1,1 +1,1 @@\n-const changed = 1;\n+const changed = 2;');

  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'big.js',
      text: fullContent,
      diff: { result, fullContent },
      gitView: 'diff',
      diffMode: 'unified',
    },
    copied: false,
    onCopy: () => {},
    onSetDiffMode: () => {},
    t,
  });

  const added = host.querySelector('.sfe-diff-line.add .sfe-diff-text');
  assert.ok(added, '大 diff 仍应渲染差异行');
  assert.equal(added.textContent, 'const changed = 2;', '降级后正文必须完整保留');
  // 核心契约：大 diff 不产生任何 Prism token，避免数千次同步分词阻塞主线程
  assert.equal(host.querySelector('.sfe-diff-text .token'), null, '大 diff 不应产生语法 token');
});

test('预览组件: 大文件只读态走虚拟滚动，小文件保持整块高亮', () => {
  // 大文件（超过熔断阈值）：走窗口化虚拟列表，DOM 行数远小于总行数，内容不截断
  const bigHost = document.createElement('div');
  const bigText = Array.from({ length: 4200 }, (_, i) => `line ${i}`).join('\n');
  renderCodeViewer(bigHost, {
    preview: {
      kind: 'text',
      name: 'big.txt',
      path: 'D:/repo/big.txt',
      text: bigText,
      highlightedHtml: '',
      isMarkdown: false,
      mode: 'preview',
    },
    copied: false,
    onCopy: () => {},
    t,
  });
  // 虚拟化标记落在滚动容器上，不再使用整块高亮容器
  const scroll = bigHost.querySelector('.sfe-file-viewer-code-scroll');
  assert.ok(scroll.classList.contains('sfe-file-viewer-code-scroll-virtual'), '大文件应启用虚拟滚动容器');
  assert.equal(bigHost.querySelector('.sfe-file-viewer-code'), null, '虚拟化时不再使用整块 <pre> 高亮容器');
  const rows = scroll.querySelectorAll('.sfe-file-viewer-line');
  // 核心契约：只渲染可视区 + 缓冲，DOM 行数必须远小于总行数
  assert.ok(rows.length > 0, '应渲染初始可视窗口的行');
  assert.ok(rows.length < 4200, `DOM 行数应远小于总行数，实际 ${rows.length}`);
  assert.equal(rows[0].querySelector('.sfe-file-viewer-line-no').textContent, '1', '首行号从 1 开始');
  assert.equal(rows[0].querySelector('.sfe-file-viewer-line-text').textContent, 'line 0', '首行正文正确');
  // 滚动占位高度按总行数撑满，保证滚动条与总行数一致（内容未截断）
  const spacer = scroll.querySelector('.sfe-vlist-spacer');
  assert.ok(spacer, '应存在撑起总高度的占位元素');
  assert.ok(parseFloat(spacer.style.height) > 0, '占位高度应大于 0');

  // 小文件：保持整块高亮（避免把跨行注释/字符串 token 按行切碎）
  const smallHost = document.createElement('div');
  renderCodeViewer(smallHost, {
    preview: {
      kind: 'text',
      name: 'a.js',
      path: 'D:/repo/a.js',
      text: 'const value = 1;',
      highlightedHtml: '<span class="token keyword">const</span> value = 1;',
      isMarkdown: false,
      mode: 'preview',
    },
    copied: false,
    onCopy: () => {},
    t,
  });
  const smallScroll = smallHost.querySelector('.sfe-file-viewer-code-scroll');
  assert.ok(!smallScroll.classList.contains('sfe-file-viewer-code-scroll-virtual'), '小文件不启用虚拟滚动');
  assert.ok(smallScroll.querySelector('.sfe-file-viewer-code-content'), '小文件保留整块高亮容器');
  assert.equal(smallScroll.querySelector('.sfe-file-viewer-line'), null, '小文件不按行渲染');
});

test('Git 差异视图: 多个 hunk 显示上下箭头并可跳到下一个差异', () => {
  const host = document.createElement('div');
  const result = parseUnifiedDiff(
    [
      '@@ -1,1 +1,1 @@',
      '-const first = 1;',
      '+const first = 2;',
      '@@ -10,1 +10,1 @@',
      '-const second = 1;',
      '+const second = 2;',
    ].join('\n')
  );

  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'example.js',
      text: ['const first = 2;', 'const second = 2;'].join('\n'),
      diff: { result, fullContent: ['const first = 2;', 'const second = 2;'].join('\n') },
      gitView: 'diff',
      diffMode: 'unified',
    },
    copied: false,
    onCopy: () => {},
    onSetDiffMode: () => {},
    t,
  });

  const nav = host.querySelector('.sfe-diff-hunk-nav');
  assert.ok(nav, '多个差异块应显示导航控件');
  assert.equal(nav.querySelector('.sfe-diff-hunk-position').textContent, '0/2');
  const previous = nav.querySelector('.sfe-diff-nav-previous');
  const next = nav.querySelector('.sfe-diff-nav-next');
  assert.equal(previous.title, '上一个差异');
  assert.equal(next.title, '下一个差异');
  assert.equal(previous.disabled, true, '尚未定位时不能回到上一个差异');
  assert.equal(next.disabled, false, '尚未定位时下一个按钮应可用');

  // hunk 跳转改为虚拟列表 scrollToIndex：断言滚动容器的 scrollTop 随行索引变化。
  // 注意第一个 hunk 位于文件第 1 行（items[0]），跳转后 scrollTop 天然为 0，
  // 因此滚动位置断言放在跳转到文件中部（第二个 hunk）之后。
  const scroll = host.querySelector('.sfe-diff-scroll');
  assert.equal(scroll.scrollTop, 0, '初始应停在顶部');
  next.click();
  assert.equal(nav.querySelector('.sfe-diff-hunk-position').textContent, '1/2');
  assert.equal(next.disabled, false, '到达第一个差异后仍应可前往第二个差异');
  const afterFirst = scroll.scrollTop;
  next.click();
  assert.equal(nav.querySelector('.sfe-diff-hunk-position').textContent, '2/2');
  assert.ok(scroll.scrollTop > afterFirst, '再次点击下一个应滚动到更靠后的第二个差异块');
  assert.equal(next.disabled, true, '到达最后一个差异后下一个按钮应禁用');
});

test('Git 差异视图: 单个 hunk 仍可通过下箭头定位', () => {
  const host = document.createElement('div');
  const result = parseUnifiedDiff(
    ['@@ -20,1 +20,1 @@', '-const oldValue = 1;', '+const newValue = 2;'].join('\n')
  );

  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'example.js',
      text: 'const newValue = 2;',
      diff: { result, fullContent: 'const newValue = 2;' },
      gitView: 'diff',
      diffMode: 'unified',
    },
    copied: false,
    onCopy: () => {},
    onSetDiffMode: () => {},
    t,
  });

  const nav = host.querySelector('.sfe-diff-hunk-nav');
  const previous = nav.querySelector('.sfe-diff-nav-previous');
  const next = nav.querySelector('.sfe-diff-nav-next');
  assert.equal(nav.querySelector('.sfe-diff-hunk-position').textContent, '0/1');
  assert.equal(previous.disabled, true, '单个 hunk 尚未定位时没有上一个差异');
  assert.equal(next.disabled, false, '单个 hunk 尚未定位时下一个按钮必须可用');

  // hunk 跳转改为虚拟列表 scrollToIndex：断言滚动容器的 scrollTop 随行索引变化
  const scroll = host.querySelector('.sfe-diff-scroll');
  assert.equal(scroll.scrollTop, 0, '初始应停在顶部');
  next.click();
  assert.ok(scroll.scrollTop > 0, '单个 hunk 点击下箭头应滚动到差异位置');
  assert.equal(nav.querySelector('.sfe-diff-hunk-position').textContent, '1/1');
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, true, '定位到唯一 hunk 后下一个按钮应禁用');
});

test('预览组件: Markdown 代码模式的模式切换与复制/编辑按钮共用工具栏', () => {
  const host = document.createElement('div');
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'README.md',
      path: 'D:/repo/README.md',
      text: '# title',
      highlightedHtml: '<span># title</span>',
      isMarkdown: true,
      mode: 'code',
      truncated: false,
    },
    copied: false,
    onCopy: () => {},
    onSetMode: () => {},
    onToggleEdit: () => {},
    onSave: () => {},
    editable: true,
    t,
  });

  const toolbar = host.querySelector('.sfe-viewer-toolbar');
  assert.ok(toolbar, 'Markdown 代码模式应有统一的顶部工具栏');
  assert.equal(toolbar.querySelector('.sfe-md-mode-switch')?.parentElement, toolbar);
  assert.equal(toolbar.querySelector('.sfe-viewer-actions')?.parentElement, toolbar);
  assert.equal(toolbar.children.length, 2, '模式切换和操作按钮应作为同级控件排列');
});

test('Git 差异视图: 固定显示完整文件且统一/分栏切换生效', () => {
  const host = document.createElement('div');
  const result = parseUnifiedDiff('@@ -1,2 +1,2 @@\\n-const oldValue = 1;\\n+const newValue = 2;');
  let mode = 'unified';
  const render = () =>
    renderCodeViewer(host, {
      preview: {
        kind: 'text',
        name: 'example.js',
        text: 'const newValue = 2;\\nline two',
        diff: { result, fullContent: 'const newValue = 2;\\nline two' },
        gitView: 'diff',
        diffMode: mode,
      },
      copied: false,
      onCopy: () => {},
      onSetDiffMode: (next) => {
        mode = next;
        render();
      },
      t,
    });

  render();
  assert.equal(host.textContent.includes('完整文件'), false, '不应显示完整文件/仅差异切换');
  assert.equal(host.textContent.includes('仅差异'), false, '不应显示完整文件/仅差异切换');
  assert.equal(host.querySelectorAll('.sfe-diff-mode-switch').length, 1, '只保留统一/分栏切换');
  assert.equal(host.querySelector('.sfe-diff-scroll.split'), null, '默认应为统一视图');

  const splitButton = Array.from(host.querySelectorAll('.sfe-md-mode-btn')).find(
    (button) => button.title === '分栏视图'
  );
  assert.ok(splitButton, '应存在分栏视图按钮');
  splitButton.click();
  assert.ok(host.querySelector('.sfe-diff-scroll.split'), '点击分栏视图后应切换布局');
});

test('预览区右键菜单: 普通文件显示资源管理器、绝对路径和相对路径操作', () => {
  const host = document.createElement('div');
  const calls = [];
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'example.js',
      path: 'D:/repo/example.js',
      text: 'const value = 1;',
      highlightedHtml: '<span>const value = 1;</span>',
      isMarkdown: false,
      truncated: false,
    },
    copied: false,
    onCopy: () => {},
    onRevealFile: () => calls.push('reveal'),
    onCopyPath: () => calls.push('copy-path'),
    onCopyRelativePath: () => calls.push('copy-relative-path'),
    t,
  });

  dispatchContextMenu(host.querySelector('.sfe-file-viewer-code-content'));
  const menu = document.querySelector('.sfe-viewer-context-menu');
  assert.ok(menu, '右键打开文件内容区应显示菜单');
  assert.deepEqual(
    [...menu.querySelectorAll('[data-menu-id]')].map((item) => item.dataset.menuId),
    ['reveal', 'copy-path', 'copy-relative-path']
  );

  for (const id of ['reveal', 'copy-path', 'copy-relative-path']) {
    dispatchContextMenu(host.querySelector('.sfe-file-viewer-code-content'));
    document.querySelector(`[data-menu-id="${id}"]`).click();
  }
  assert.deepEqual(calls, ['reveal', 'copy-path', 'copy-relative-path']);
});

test('预览区右键菜单: 只读态提供刷新，编辑态不提供', async () => {
  const calls = [];
  const host = document.createElement('div');
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'example.js',
      path: 'D:/repo/example.js',
      text: 'const value = 1;',
      highlightedHtml: '<span>const value = 1;</span>',
      isMarkdown: false,
    },
    copied: false,
    onCopy: () => {},
    onRefresh: () => calls.push('refresh'),
    t,
  });

  // 只读态：右键菜单含刷新项，点击触发 onRefresh
  dispatchContextMenu(host.querySelector('.sfe-file-viewer-code-content'));
  const menu = document.querySelector('.sfe-viewer-context-menu');
  const refreshItem = menu.querySelector('[data-menu-id="refresh"]');
  assert.ok(refreshItem, '只读态应提供刷新菜单项');
  refreshItem.click();
  assert.deepEqual(calls, ['refresh'], '刷新项应触发 onRefresh');

  // 编辑态：不提供刷新项（重新读取会丢弃未保存修改）
  const editHost = document.createElement('div');
  renderCodeViewer(editHost, {
    preview: {
      kind: 'text',
      name: 'example.js',
      path: 'D:/repo/example.js',
      text: 'const value = 1;',
      highlightedHtml: '<span>const value = 1;</span>',
      isMarkdown: false,
    },
    copied: false,
    onCopy: () => {},
    onRefresh: () => calls.push('refresh-edit'),
    editable: true,
    onEditInput: () => {},
    t,
  });
  dispatchContextMenu(editHost.querySelector('textarea'));
  const editMenu = document.querySelector('.sfe-viewer-context-menu');
  assert.ok(editMenu, '编辑态右键仍应出现菜单（粘贴等）');
  assert.equal(editMenu.querySelector('[data-menu-id="refresh"]'), null, '编辑态不得提供刷新项');
  assert.deepEqual(calls, ['refresh'], '编辑态刷新未被触发');
});

test('预览区右键菜单: 只读选中文本只能复制，不能剪切或粘贴', async () => {
  let copiedText = null;
  setClipboard({ writeText: async (text) => { copiedText = text; } });
  const host = document.createElement('div');
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'example.js',
      path: 'D:/repo/example.js',
      text: 'const value = 1;',
      highlightedHtml: '<span>const value = 1;</span>',
      isMarkdown: false,
      truncated: false,
    },
    copied: false,
    onCopy: () => {},
    t,
  });

  const content = host.querySelector('.sfe-file-viewer-code-content');
  const originalGetSelection = window.getSelection;
  window.getSelection = () => ({ toString: () => 'const value = 1;' });
  dispatchContextMenu(content);

  const menu = document.querySelector('.sfe-viewer-context-menu');
  assert.ok(menu.querySelector('[data-menu-id="copy"]'));
  assert.equal(menu.querySelector('[data-menu-id="cut"]'), null);
  assert.equal(menu.querySelector('[data-menu-id="paste"]'), null);
  menu.querySelector('[data-menu-id="copy"]').click();
  await flushClipboardRead();
  assert.equal(copiedText, 'const value = 1;');
  window.getSelection = originalGetSelection;
});

test('预览区右键菜单: 编辑态剪切先写剪贴板，再删除选区并触发输入', async () => {
  let copiedText = null;
  let inputValue = null;
  setClipboard({
    writeText: async (text) => {
      copiedText = text;
    },
    readText: async () => 'paste source',
  });
  const host = document.createElement('div');
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'example.js',
      path: 'D:/repo/example.js',
      text: 'const value = 1;',
      highlightedHtml: '<span>const value = 1;</span>',
      isMarkdown: false,
      truncated: false,
    },
    copied: false,
    onCopy: () => {},
    onEditInput: (value) => {
      inputValue = value;
    },
    editable: true,
    t,
  });

  const textarea = host.querySelector('textarea');
  textarea.setSelectionRange(0, 5);
  dispatchContextMenu(textarea);
  const menu = document.querySelector('.sfe-viewer-context-menu');
  assert.ok(menu.querySelector('[data-menu-id="copy"]'));
  assert.ok(menu.querySelector('[data-menu-id="cut"]'));
  assert.ok(menu.querySelector('[data-menu-id="paste"]'));
  await flushClipboardRead();
  menu.querySelector('[data-menu-id="cut"]').click();
  await flushClipboardRead();
  assert.equal(copiedText, 'const');
  assert.equal(textarea.value, ' value = 1;');
  assert.equal(inputValue, ' value = 1;');
});

test('预览区右键菜单: 编辑态只在剪贴板有文本时启用粘贴，并能插入文本', async () => {
  let inputValue = null;
  setClipboard({ readText: async () => 'pasted text' });
  const host = document.createElement('div');
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'example.txt',
      path: 'D:/repo/example.txt',
      text: 'abc',
      highlightedHtml: 'abc',
      isMarkdown: false,
      truncated: false,
    },
    copied: false,
    onCopy: () => {},
    onEditInput: (value) => {
      inputValue = value;
    },
    editable: true,
    t,
  });

  const textarea = host.querySelector('textarea');
  textarea.setSelectionRange(1, 2);
  dispatchContextMenu(textarea);
  const menu = document.querySelector('.sfe-viewer-context-menu');
  const paste = menu.querySelector('[data-menu-id="paste"]');
  assert.equal(paste.disabled, true, '异步读取完成前粘贴必须禁用');
  await flushClipboardRead();
  assert.equal(paste.disabled, false);
  paste.click();
  await flushClipboardRead();
  assert.equal(textarea.value, 'apasted textc');
  assert.equal(inputValue, 'apasted textc');
});

test('预览区右键菜单: 剪贴板为空或读取失败时粘贴保持禁用，菜单可清理', async () => {
  const host = document.createElement('div');
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'example.txt',
      path: 'D:/repo/example.txt',
      text: 'abc',
      highlightedHtml: 'abc',
      isMarkdown: false,
      truncated: false,
    },
    copied: false,
    onCopy: () => {},
    onEditInput: () => {},
    editable: true,
    t,
  });

  setClipboard({ readText: async () => '' });
  const textarea = host.querySelector('textarea');
  dispatchContextMenu(textarea);
  let menu = document.querySelector('.sfe-viewer-context-menu');
  await flushClipboardRead();
  assert.equal(menu.querySelector('[data-menu-id="paste"]').disabled, true);
  document.body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(document.querySelector('.sfe-viewer-context-menu'), null);

  setClipboard({ readText: async () => { throw new Error('clipboard denied'); } });
  dispatchContextMenu(textarea);
  menu = document.querySelector('.sfe-viewer-context-menu');
  await flushClipboardRead();
  assert.equal(menu.querySelector('[data-menu-id="paste"]').disabled, true);
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.querySelector('.sfe-viewer-context-menu'), null);

  dispatchContextMenu(textarea);
  assert.equal(document.querySelectorAll('.sfe-viewer-context-menu').length, 1);
  renderCodeViewer(host, {
    preview: null,
    copied: false,
    onCopy: () => {},
    t,
  });
  assert.equal(document.querySelector('.sfe-viewer-context-menu'), null, '预览重绘后不得残留旧菜单');
});

test('预览区右键菜单: 剪切写入剪贴板失败时保留原文', async () => {
  let inputCount = 0;
  setClipboard({
    writeText: async () => {
      throw new Error('clipboard denied');
    },
    readText: async () => '',
  });
  const host = document.createElement('div');
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'example.txt',
      path: 'D:/repo/example.txt',
      text: 'abc',
      highlightedHtml: 'abc',
      isMarkdown: false,
      truncated: false,
    },
    copied: false,
    onCopy: () => {},
    onEditInput: () => {
      inputCount += 1;
    },
    editable: true,
    t,
  });

  const textarea = host.querySelector('textarea');
  textarea.setSelectionRange(0, 2);
  dispatchContextMenu(textarea);
  const menu = document.querySelector('.sfe-viewer-context-menu');
  menu.querySelector('[data-menu-id="cut"]').click();
  await flushClipboardRead();
  assert.equal(textarea.value, 'abc');
  assert.equal(inputCount, 0);
});

test('Git 右侧查看器: 未打开文件（空态）也能右键弹出「刷新」菜单', () => {
  const host = document.createElement('div');
  const calls = [];
  // 与 index.js renderGitPreview 空态一致：不注入文件操作，只保留 onRefresh；自定义空态提示。
  renderCodeViewer(host, {
    preview: null,
    emptyHint: '在左侧选择变更文件以查看差异。',
    copied: false,
    onCopy: () => {},
    onRefresh: () => calls.push('refresh'),
    t,
  });

  // 空态提示用调用方文案
  assert.equal(host.querySelector('.sfe-file-viewer-empty').textContent, '在左侧选择变更文件以查看差异。');
  // 空态右键：此前 bindViewerContextMenu 对 !preview 直接不绑，导致完全无反应——回归点
  dispatchContextMenu(host.querySelector('.sfe-file-viewer-empty'));
  const menu = document.querySelector('.sfe-viewer-context-menu');
  assert.ok(menu, '空态右键应显示菜单');
  assert.deepEqual([...menu.querySelectorAll('[data-menu-id]')].map((item) => item.dataset.menuId), ['refresh']);
  menu.querySelector('[data-menu-id="refresh"]').click();
  assert.deepEqual(calls, ['refresh']);
});

test('Git 右侧查看器: 差异视图右键弹出文件操作菜单（只读）', () => {
  const host = document.createElement('div');
  const result = parseUnifiedDiff('@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;');
  const calls = [];
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'a.js',
      path: 'D:/repo/a.js',
      text: 'const a = 2;',
      diff: { result, fullContent: 'const a = 2;' },
      gitView: 'diff',
      diffMode: 'unified',
    },
    copied: false,
    onCopy: () => {},
    onSetDiffMode: () => {},
    onRefresh: () => calls.push('refresh'),
    onRevealFile: () => calls.push('reveal'),
    onCopyPath: () => calls.push('copy-path'),
    onCopyRelativePath: () => calls.push('copy-relative-path'),
    t,
  });

  // 差异正文区右键：与文件管理器预览区一致的只读菜单（文件操作 + 刷新，不含文本编辑）
  dispatchContextMenu(host.querySelector('.sfe-diff-scroll'));
  const menu = document.querySelector('.sfe-viewer-context-menu');
  assert.ok(menu, '差异视图右键应显示菜单');
  assert.deepEqual(
    [...menu.querySelectorAll('[data-menu-id]')].map((item) => item.dataset.menuId),
    ['reveal', 'copy-path', 'copy-relative-path', 'refresh']
  );
  menu.querySelector('[data-menu-id="refresh"]').click();
  assert.deepEqual(calls, ['refresh']);
});

test('代码预览: 二级 package.json 按所属包目录显示 pnpm 脚本运行按钮', () => {
  const host = document.createElement('div');
  let received = null;
  const command = {
    id: 'pnpm:apps/web:dev',
    label: 'dev',
    labelFallback: 'apps/web/dev',
    cmd: 'pnpm run dev',
    packageManager: 'pnpm',
    dir: 'apps/web',
    group: 'apps/web',
  };
  renderCodeViewer(host, {
    rootPath: 'D:/repo',
    preview: {
      kind: 'text',
      name: 'package.json',
      path: 'D:/repo/apps/web/package.json',
      text: '{\n  "scripts": {\n    "dev": "vite"\n  }\n}',
      highlightedHtml: '{}',
      isMarkdown: false,
      truncated: false,
    },
    copied: false,
    runCommands: () => [command],
    onRunCommand: (value) => {
      received = value;
    },
    onCopy: () => {},
    t,
  });

  const button = host.querySelector('.sfe-file-viewer-gutter-run');
  assert.ok(button, '二级 package.json 的脚本行应显示运行按钮');
  button.click();
  assert.equal(received, command);
});

test('预览区右键菜单: 运行分组按包显示组标题（根目录 / 子包路径，父包在前）', () => {
  const host = document.createElement('div');
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'package.json',
      path: 'D:/repo/package.json',
      text: '{}',
      highlightedHtml: '{}',
      isMarkdown: false,
      truncated: false,
    },
    copied: false,
    onCopy: () => {},
    runCommands: () => [
      { id: 'npm:dev', labelKey: null, labelFallback: 'dev', cmd: 'npm run dev', group: null },
      { id: 'npm:api:start', labelKey: null, labelFallback: 'api/start', cmd: 'npm --prefix api run start', group: 'api' },
    ],
    onRunCommand: () => {},
    t,
  });

  dispatchContextMenu(host.querySelector('.sfe-file-viewer-code-content'));
  const menu = document.querySelector('.sfe-viewer-context-menu');
  assert.deepEqual(
    [...menu.querySelectorAll('.sfe-context-menu-group')].map((node) => node.textContent),
    ['根目录', 'api']
  );
  // 清理本用例菜单，避免影响后续用例
  renderCodeViewer(host, { preview: null, copied: false, onCopy: () => {}, t });
});

