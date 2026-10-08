import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { CodePreviewState, CodeTextPreview } from '../../../src/components/code-viewer.ts';
import type { FlatRunCommand } from '../../../src/services/project-commands.ts';
import type { DiffViewMode, TranslateFn } from '../../../src/types/panel-state.ts';

// 在导入渲染模块前建立最小 DOM 环境：DOMPurify 依赖 window/document 完成净化
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Prism 的浏览器插件初始化会访问 Element，Node 测试环境需显式接入 JSDOM 构造器。
globalThis.Element = dom.window.Element;

/**
 * 取容器内必然存在的元素。
 * !: 元素缺失即组件没渲染该控件（用例随后直接解引用，运行时同样会抛 TypeError），
 *   故在唯一的查询出口收窄一次非空，不改变运行时行为。
 */
const q = <T extends Element>(parent: ParentNode, selector: string): T => parent.querySelector<T>(selector)!;

/** 剪贴板桩的形状（组件只用到写文本与读文本两条通道）。 */
type ClipboardStub = {
  /** 把文本写入系统剪贴板。 */
  writeText: (text: string) => Promise<void>;
  /** 读取系统剪贴板文本；空剪贴板返回空串。 */
  readText: () => Promise<string>;
};

function setClipboard({ writeText = async (_text: string) => {}, readText = async () => "" }: Partial<ClipboardStub> = {}): ClipboardStub {
  const clipboard = { writeText, readText };
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
  return clipboard;
}

function dispatchContextMenu(target: Element): void {
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

/**
 * 在只读态虚拟行上构造真实 DOM Range 选区（选中第 fromLine 行到 toLine 行的正文），返回还原函数。
 * @description 只读态取选区走 Range 克隆（剔除行号节点），不再是 Selection.toString()；
 *   桩必须建真实 Range，才能同时覆盖「行号不入正文」这一契约。
 * @param host 已渲染代码查看器的容器
 * @param fromLine 起始行下标（0 基）
 * @param toLine 结束行下标（0 基，含）
 */
function mockSelectionRange(host: HTMLElement, fromLine: number, toLine: number): () => void {
  // jsdom 的 Range 只对已接入文档的节点生效：游离 host 上 addRange 会静默失败（rangeCount 归 0）。
  const attached = host.isConnected;
  if (!attached) document.body.appendChild(host);
  const rows = [...host.querySelectorAll<HTMLElement>('.sfe-file-viewer-line')];
  if (!rows.length) throw new Error('未渲染只读行，选区桩无法生效');
  const textEl = (i: number): HTMLElement => {
    const el = rows[i].querySelector<HTMLElement>('.sfe-file-viewer-line-text');
    if (!el) throw new Error(`第 ${i} 行无正文元素`);
    return el;
  };
  // 正文可能是单个 Text，也可能是高亮后的多个元素子节点：按元素边界取整段，不依赖子节点类型。
  const range = document.createRange();
  const startEl = textEl(fromLine);
  const endEl = textEl(toLine);
  range.setStart(startEl, 0);
  range.setEnd(endEl, endEl.childNodes.length);
  const selection = window.getSelection();
  if (!selection) throw new Error('jsdom 未提供 Selection 实例，选区桩无法生效');
  const originalGetSelection = window.getSelection;
  selection.removeAllRanges();
  selection.addRange(range);
  window.getSelection = () => selection;
  return () => {
    selection.removeAllRanges();
    window.getSelection = originalGetSelection;
    if (!attached) host.remove();
  };
}

const { renderMarkdownHtml } = await import('../../../src/components/markdown-renderer.ts');
const { renderCodeViewer } = await import('../../../src/components/code-viewer.ts');
const { parseUnifiedDiff } = await import('../../../src/services/diff.ts');
const { resolveProxiedImageSrc } = await import('../../../src/services/markdown-asset.ts');
const { highlightCodeHtml } = await import('../../../src/components/highlighter.ts');
const { ensureHighlighter, highlighterReady, installHighlighter } = await import('../../../src/components/highlight-client.ts');
installHighlighter({ highlightCodeHtml });

/** 翻译桩：只用到 key + 兜底文案，签名复用组件消费的 TranslateFn。 */
const t: TranslateFn = (_key, fallback) => fallback || _key;

test('预览组件: Markdown 默认预览模式，可切代码模式，仅本地图片转异步回填属性', () => {
  const host = document.createElement('div');
  const source = '# T\n\n![本地](./img/a.png)\n\n![外链](https://img.shields.io/badge/License-MIT-blue.svg)';
  const preview: CodeTextPreview = {
    kind: 'text',
    name: 'a.md',
    path: 'D:/repo/a.md',
    text: source,
    html: renderMarkdownHtml(source),
    isMarkdown: true,
    mode: 'preview',
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
  const localImg = q<HTMLImageElement>(host, '.sfe-markdown-body img[data-sfe-src]');
  assert.equal(localImg.getAttribute('data-sfe-src'), './img/a.png');
  assert.equal(localImg.getAttribute('src'), null);

  // 外链图片：必须改写为宿主 img-proxy 代理 URL。
  // 宿主渲染进程 CSP 的 img-src 不放行 https:，若原样保留会被浏览器拦截导致空白
  // （README 徽章不显示的根因）。这里断言最终 src 已是代理协议，才能被 CSP 放行显示。
  const remoteImg = q<HTMLImageElement>(host, '.sfe-markdown-body img[src]');
  const expectedProxy = 'img-proxy://localhost/' + encodeURIComponent('https://img.shields.io/badge/License-MIT-blue.svg');
  assert.equal(remoteImg.getAttribute('src'), expectedProxy);
  assert.equal(remoteImg.getAttribute('data-sfe-src'), null);
  assert.ok(!/^https?:/.test(remoteImg.getAttribute('src')!), '外链 src 不得保留 http(s)（会被 CSP 拦截）');
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
      isMarkdown: true,
      mode: 'code',
    },
    copied: false,
    onCopy: () => {},
    onSetMode: () => {},
    t,
  });

  assert.ok(host.querySelector('.sfe-file-viewer-code-scroll-virtual'), '代码模式应渲染代码视图（统一虚拟列表）');
  assert.equal(host.querySelector('.sfe-markdown-body'), null, '代码模式不应渲染 Markdown 正文');
  assert.equal(q<HTMLElement>(host, '.sfe-file-viewer-line-text').textContent, '# T', '代码模式按行渲染源码');
  const activeBtn = q<HTMLElement>(host, '.sfe-md-mode-btn.active');
  assert.equal(activeBtn.getAttribute('aria-pressed'), 'true', '代码按钮应处于激活态');
});


test('预览组件: 普通文本默认只读，笔/眼睛按钮切换真实编辑状态', () => {
  const host = document.createElement('div');
  let editable = false;
  let inputValue = '';
  const preview: CodeTextPreview = {
    kind: 'text',
    name: 'a.js',
    path: 'D:/repo/a.js',
    text: 'const value = 1;',
    isMarkdown: false,
    mode: 'preview',
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
  const editButton = host.querySelector<HTMLButtonElement>('.sfe-floating-edit-btn');
  assert.ok(editButton, '普通文本默认应显示编辑按钮');
  assert.equal(editButton.title, '编辑');
  assert.equal(host.querySelector('textarea'), null, '默认只读不能渲染 textarea');

  editButton.click();
  const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
  assert.ok(textarea, '点击笔图标后应进入真实编辑模式');
  assert.equal(q<HTMLButtonElement>(host, '.sfe-floating-edit-btn').title, '只读');
  const editHighlight = host.querySelector('.sfe-file-viewer-edit-highlight');
  assert.ok(editHighlight, '编辑模式应保留语法高亮层');
  assert.ok(editHighlight.classList.contains('sfe-file-viewer-code'), '编辑高亮层必须复用代码 token 配色作用域');
  assert.ok(editHighlight.querySelector('.token.keyword'), '编辑模式应显示关键字高亮');
  textarea.value = 'const value = 2;';
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(inputValue, 'const value = 2;');
  assert.ok(editHighlight.querySelector('.token.keyword'), '输入后高亮层应实时更新');

  q<HTMLButtonElement>(host, '.sfe-floating-edit-btn').click();
  assert.equal(host.querySelector('textarea'), null, '点击眼睛图标后应返回只读');
});

test('预览组件: Markdown 预览不显示编辑按钮，代码模式才显示笔图标', () => {
  const host = document.createElement('div');
  const preview: CodeTextPreview = {
    kind: 'text',
    name: 'README.md',
    path: 'D:/repo/README.md',
    text: '# title',
    html: '<h1>title</h1>',
    isMarkdown: true,
    mode: 'preview',
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
  q<HTMLButtonElement>(host, '.sfe-md-mode-btn:not(.active)').click();
  assert.ok(host.querySelector('.sfe-floating-edit-btn'), 'Markdown 代码模式应显示编辑按钮');
  assert.equal(q<HTMLButtonElement>(host, '.sfe-floating-edit-btn').title, '编辑');
});

test('Git 差异视图: 按文件语言高亮增删行正文并保持源码安全', () => {
  const host = document.createElement('div');
  const result = parseUnifiedDiff('@@ -1,2 +1,2 @@\n-const oldValue = 1;\n+const newValue = "<img src=x onerror=alert(1)>";');

  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'example.js',
      path: 'D:/repo/example.js',
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

  const deleted = q<HTMLSpanElement>(host, '.sfe-diff-line.del .sfe-diff-text');
  const added = q<HTMLSpanElement>(host, '.sfe-diff-line.add .sfe-diff-text');
  assert.ok(deleted.querySelector('.token.keyword'), '删除行也应按 JavaScript 语法高亮');
  assert.ok(added.querySelector('.token.keyword'), '新增行也应按 JavaScript 语法高亮');
  assert.ok(added.querySelector('.token.string'), '字符串 token 应保留');
  assert.equal(added.querySelector('img'), null, '源码中的 HTML 不得被当成 DOM 标签执行');
  assert.match(added.textContent, /onerror=alert\(1\)/, '源码文本必须完整保留');
  assert.equal(host.querySelector('.sfe-floating-edit-btn'), null, 'Git 差异视图不应出现编辑按钮');
});

test('Git 差异视图: 超大全文仍展开整份文件，可视行保留语法高亮', () => {
  const host = document.createElement('div');
  const fullContent = Array.from({ length: 4100 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const result = parseUnifiedDiff('@@ -1,1 +1,1 @@\n-const changed = 1;\n+const changed = 2;');

  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'big.js',
      path: 'D:/repo/big.js',
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

  const added = q<HTMLElement>(host, '.sfe-diff-line.add .sfe-diff-text');
  assert.ok(added, '大文件差异仍应渲染变更行');
  assert.equal(added.textContent, 'const changed = 2;', '变更行正文必须完整保留');
  assert.ok(added.querySelector('.token.keyword'), '大文件可视行应保留语法高亮');
  const rows = host.querySelectorAll('.sfe-diff-line');
  assert.ok(rows.length > 0 && rows.length < 80, `可视 DOM 行数应受限，实际 ${rows.length}`);
  const spacer = host.querySelector<HTMLElement>('.sfe-vlist-spacer');
  assert.ok(spacer && parseFloat(spacer.style.height) > 4000 * 18, '占位高度应按整份文件撑开');
});

test('预览组件: 大小文件只读态统一走虚拟滚动，逐行高亮且正文完整', () => {
  // 大文件（超过熔断阈值）：走窗口化虚拟列表，DOM 行数远小于总行数，内容不截断
  const bigHost = document.createElement('div');
  const bigText = Array.from({ length: 4200 }, (_, i) => `line ${i}`).join('\n');
  renderCodeViewer(bigHost, {
    preview: {
      kind: 'text',
      name: 'big.txt',
      path: 'D:/repo/big.txt',
      text: bigText,
      isMarkdown: false,
      mode: 'preview',
    },
    copied: false,
    onCopy: () => {},
    t,
  });
  // 虚拟化标记落在滚动容器上，不再使用整块高亮容器
  const scroll = q<HTMLElement>(bigHost, '.sfe-file-viewer-code-scroll');
  assert.ok(scroll.classList.contains('sfe-file-viewer-code-scroll-virtual'), '大文件应启用虚拟滚动容器');
  assert.equal(bigHost.querySelector('.sfe-file-viewer-code'), null, '虚拟化时不再使用整块 <pre> 高亮容器');
  const rows = scroll.querySelectorAll('.sfe-file-viewer-line');
  // 核心契约：只渲染可视区 + 缓冲，DOM 行数必须远小于总行数
  assert.ok(rows.length > 0, '应渲染初始可视窗口的行');
  assert.ok(rows.length < 4200, `DOM 行数应远小于总行数，实际 ${rows.length}`);
  assert.equal(q<HTMLSpanElement>(rows[0], '.sfe-file-viewer-line-no').textContent, '1', '首行号从 1 开始');
  assert.equal(q<HTMLSpanElement>(rows[0], '.sfe-file-viewer-line-text').textContent, 'line 0', '首行正文正确');

  const codeHost = document.createElement('div');
  const codeText = Array.from({ length: 4200 }, (_, i) => `const line${i} = ${i};`).join('\n');
  renderCodeViewer(codeHost, {
    preview: {
      kind: 'text',
      name: 'big.js',
      path: 'D:/repo/big.js',
      text: codeText,
      isMarkdown: false,
      mode: 'preview',
    },
    copied: false,
    onCopy: () => {},
    t,
  });
  const codeLine = q<HTMLSpanElement>(codeHost, '.sfe-file-viewer-line-text');
  assert.ok(codeLine.querySelector('.token.keyword'), '大文件可视行应保留语法高亮');
  assert.equal(codeLine.textContent, 'const line0 = 0;', '高亮后正文必须完整保留');
  // 滚动占位高度按总行数撑满，保证滚动条与总行数一致（内容未截断）
  const spacer = q<HTMLElement>(scroll, '.sfe-vlist-spacer');
  assert.ok(spacer, '应存在撑起总高度的占位元素');
  assert.ok(parseFloat(spacer.style.height) > 0, '占位高度应大于 0');

  // 小文件：同样走窗口化虚拟列表（统一懒加载管线，不再有整块 <pre> 分支）
  const smallHost = document.createElement('div');
  renderCodeViewer(smallHost, {
    preview: {
      kind: 'text',
      name: 'a.js',
      path: 'D:/repo/a.js',
      text: 'const value = 1;',
      isMarkdown: false,
      mode: 'preview',
    },
    copied: false,
    onCopy: () => {},
    t,
  });
  const smallScroll = q<HTMLElement>(smallHost, '.sfe-file-viewer-code-scroll');
  assert.ok(smallScroll.classList.contains('sfe-file-viewer-code-scroll-virtual'), '小文件与 大文件同走虚拟滚动');
  const smallRow = q<HTMLElement>(smallScroll, '.sfe-file-viewer-line-text');
  assert.ok(smallRow.querySelector('.token.keyword'), '小文件的单行也必须着色');
  assert.equal(smallRow.textContent, 'const value = 1;', '高亮后正文必须完整保留');
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
      path: 'D:/repo/example.js',
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

  const nav = q<HTMLElement>(host, '.sfe-diff-hunk-nav');
  assert.ok(nav, '多个差异块应显示导航控件');
  assert.equal(q<HTMLSpanElement>(nav, '.sfe-diff-hunk-position').textContent, '0/2');
  const previous = q<HTMLButtonElement>(nav, '.sfe-diff-nav-previous');
  const next = q<HTMLButtonElement>(nav, '.sfe-diff-nav-next');
  assert.equal(previous.title, '上一个差异');
  assert.equal(next.title, '下一个差异');
  assert.equal(previous.disabled, true, '尚未定位时不能回到上一个差异');
  assert.equal(next.disabled, false, '尚未定位时下一个按钮应可用');

  // hunk 跳转改为虚拟列表 scrollToIndex：断言滚动容器的 scrollTop 随行索引变化。
  // 注意第一个 hunk 位于文件第 1 行（items[0]），跳转后 scrollTop 天然为 0，
  // 因此滚动位置断言放在跳转到文件中部（第二个 hunk）之后。
  const scroll = q<HTMLElement>(host, '.sfe-diff-scroll');
  assert.equal(scroll.scrollTop, 0, '初始应停在顶部');
  next.click();
  assert.equal(q<HTMLSpanElement>(nav, '.sfe-diff-hunk-position').textContent, '1/2');
  assert.equal(next.disabled, false, '到达第一个差异后仍应可前往第二个差异');
  const afterFirst = scroll.scrollTop;
  next.click();
  assert.equal(q<HTMLSpanElement>(nav, '.sfe-diff-hunk-position').textContent, '2/2');
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
      path: 'D:/repo/example.js',
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

  const nav = q<HTMLElement>(host, '.sfe-diff-hunk-nav');
  const previous = q<HTMLButtonElement>(nav, '.sfe-diff-nav-previous');
  const next = q<HTMLButtonElement>(nav, '.sfe-diff-nav-next');
  assert.equal(q<HTMLSpanElement>(nav, '.sfe-diff-hunk-position').textContent, '0/1');
  assert.equal(previous.disabled, true, '单个 hunk 尚未定位时没有上一个差异');
  assert.equal(next.disabled, false, '单个 hunk 尚未定位时下一个按钮必须可用');

  // hunk 跳转改为虚拟列表 scrollToIndex：断言滚动容器的 scrollTop 随行索引变化
  const scroll = q<HTMLElement>(host, '.sfe-diff-scroll');
  assert.equal(scroll.scrollTop, 0, '初始应停在顶部');
  next.click();
  assert.ok(scroll.scrollTop > 0, '单个 hunk 点击下箭头应滚动到差异位置');
  assert.equal(q<HTMLSpanElement>(nav, '.sfe-diff-hunk-position').textContent, '1/1');
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
      isMarkdown: true,
      mode: 'code',
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
  let mode: DiffViewMode = 'unified';
  const render = () =>
    renderCodeViewer(host, {
      preview: {
        kind: 'text',
        name: 'example.js',
        path: 'D:/repo/example.js',
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
  assert.equal(host.querySelector('.sfe-diff-split-body'), null, '默认应为统一视图');

  const splitButton = Array.from(host.querySelectorAll<HTMLButtonElement>('.sfe-md-mode-btn')).find(
    (button) => button.title === '分栏视图'
  );
  assert.ok(splitButton, '应存在分栏视图按钮');
  splitButton.click();
  // 分栏是左右两个独立滚动容器（各自横向拖动，纵向互锁同步）
  const sides = host.querySelectorAll<HTMLElement>('.sfe-diff-scroll.side');
  assert.equal(sides.length, 2, '点击分栏视图后应出现左右两个独立滚动栏');
  assert.ok(host.querySelector('.sfe-diff-split-body'), '分栏容器应存在');
});

test('Git 差异视图: .vue 差异按 SFC 区块逐行高亮（与代码查看器同一条管线）', () => {
  const host = document.createElement('div');
  const fullContent = [
    '<template>',
    '  <div class="a">{{ msg }}</div>',
    '</template>',
    '<script setup lang="ts">',
    'const msg = 1;',
    '</script>',
  ].join('\n');
  const patch = [
    '@@ -1,6 +1,6 @@',
    ' <template>',
    '   <div class="a">{{ msg }}</div>',
    ' </template>',
    ' <script setup lang="ts">',
    '-const msg = 0;',
    '+const msg = 1;',
    ' </script>',
  ].join('\n');
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'a.vue',
      path: 'D:/repo/a.vue',
      text: fullContent,
      diff: { result: parseUnifiedDiff(patch), fullContent },
      gitView: 'diff',
      diffMode: 'unified',
    },
    copied: false,
    t,
  });
  const rows = [...host.querySelectorAll<HTMLElement>('.sfe-diff-line')];
  const added = rows.find((row) => row.classList.contains('add'));
  assert.ok(added, '应渲染出新增行');
  assert.ok(added!.querySelector('.token.keyword'), '新增行在 script 区块内，应按 TypeScript 着色（const → keyword）');
  const template = rows.find((row) => row.textContent!.includes('<div class="a">'));
  assert.ok(template, '应渲染出模板上下文行');
  assert.ok(template!.querySelector('.token.tag'), '模板行应按 HTML 着色（tag）');
});

test('Git 差异视图: 分栏是左右两个独立滚动栏，左旧行号/右新行号、两侧行数一致', () => {
  const host = document.createElement('div');
  const fullContent = 'new one\nboth';
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'a.js',
      path: 'D:/repo/a.js',
      text: fullContent,
      diff: { result: parseUnifiedDiff('@@ -1,2 +1,2 @@\n-old one\n+new one\n both'), fullContent },
      gitView: 'diff',
      diffMode: 'split',
    },
    copied: false,
    t,
  });
  const sides = host.querySelectorAll<HTMLElement>('.sfe-diff-scroll.side');
  assert.equal(sides.length, 2, '左右两个独立滚动容器（各自横向拖动）');
  const left = sides[0];
  const right = sides[1];
  assert.ok(right.classList.contains('right'), '右栏带 right 标记');
  const leftFirst = q<HTMLElement>(left, '.sfe-diff-split-cell');
  assert.ok(leftFirst.classList.contains('del'), '左栏首行是删除行');
  assert.equal(leftFirst.querySelector('.sfe-diff-no')!.textContent, '1', '左栏显示旧行号');
  const rightFirst = q<HTMLElement>(right, '.sfe-diff-split-cell');
  assert.ok(rightFirst.classList.contains('add'), '右栏首行是新增行');
  assert.equal(rightFirst.querySelector('.sfe-diff-no')!.textContent, '1', '右栏显示新行号');
  assert.equal(
    left.querySelectorAll('.sfe-diff-split-cell').length,
    right.querySelectorAll('.sfe-diff-split-cell').length,
    '两侧行数一致（无配对的一侧留占位格，行高对齐）'
  );
  assert.ok(left.querySelector('.sfe-vlist-content'), '左栏有自己的虚拟列表内容层');
  assert.ok(right.querySelector('.sfe-vlist-content'), '右栏有自己的虚拟列表内容层');
});

test('预览区右键菜单: 普通文件显示资源管理器、绝对路径和相对路径操作', () => {
  const host = document.createElement('div');
  const calls: string[] = [];
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'example.js',
      path: 'D:/repo/example.js',
      text: 'const value = 1;',
      isMarkdown: false,
    },
    copied: false,
    onCopy: () => {},
    onRevealFile: () => calls.push('reveal'),
    onCopyPath: () => calls.push('copy-path'),
    onCopyRelativePath: () => calls.push('copy-relative-path'),
    t,
  });

  dispatchContextMenu(q<HTMLElement>(host, '.sfe-file-viewer-line'));
  const menu = document.querySelector<HTMLElement>('.sfe-viewer-context-menu');
  assert.ok(menu, '右键打开文件内容区应显示菜单');
  assert.deepEqual(
    [...menu.querySelectorAll<HTMLButtonElement>('[data-menu-id]')].map((item) => item.dataset.menuId),
    ['reveal', 'copy-path', 'copy-relative-path']
  );

  for (const id of ['reveal', 'copy-path', 'copy-relative-path']) {
    dispatchContextMenu(q<HTMLElement>(host, '.sfe-file-viewer-line'));
    q<HTMLButtonElement>(document, `[data-menu-id="${id}"]`).click();
  }
  assert.deepEqual(calls, ['reveal', 'copy-path', 'copy-relative-path']);
});

test('预览区右键菜单: 只读态提供刷新，编辑态不提供', async () => {
  const calls: string[] = [];
  const host = document.createElement('div');
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'example.js',
      path: 'D:/repo/example.js',
      text: 'const value = 1;',
      isMarkdown: false,
    },
    copied: false,
    onCopy: () => {},
    onRefresh: () => calls.push('refresh'),
    t,
  });

  // 只读态：右键菜单含刷新项，点击触发 onRefresh
  dispatchContextMenu(q<HTMLElement>(host, '.sfe-file-viewer-line'));
  const menu = q<HTMLElement>(document, '.sfe-viewer-context-menu');
  const refreshItem = q<HTMLButtonElement>(menu, '[data-menu-id="refresh"]');
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
      isMarkdown: false,
    },
    copied: false,
    onCopy: () => {},
    onRefresh: () => calls.push('refresh-edit'),
    editable: true,
    onEditInput: () => {},
    t,
  });
  dispatchContextMenu(q<HTMLTextAreaElement>(editHost, 'textarea'));
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
      isMarkdown: false,
    },
    copied: false,
    onCopy: () => {},
    t,
  });

  const content = q<HTMLElement>(host, '.sfe-file-viewer-line');
  const restoreSelection = mockSelectionRange(host, 0, 0);
  dispatchContextMenu(content);

  const menu = q<HTMLElement>(document, '.sfe-viewer-context-menu');
  assert.ok(q<HTMLButtonElement>(menu, '[data-menu-id="copy"]'));
  assert.equal(menu.querySelector('[data-menu-id="cut"]'), null);
  assert.equal(menu.querySelector('[data-menu-id="paste"]'), null);
  q<HTMLButtonElement>(menu, '[data-menu-id="copy"]').click();
  await flushClipboardRead();
  assert.equal(copiedText, 'const value = 1;');
  restoreSelection();
});

test('预览区右键菜单: 发送到当前会话带工作区路径、行范围和原文，不带代码围栏', async () => {
  const sent: string[] = [];

  const codeHost = document.createElement('div');
  renderCodeViewer(codeHost, {
    preview: {
      kind: 'text',
      name: 'a.js',
      path: 'D:/repo/sub/a.js',
      text: 'const value = 1;',
      isMarkdown: false,
      mode: 'preview',
    },
    rootPath: 'D:/repo',
    copied: false,
    onSendToChat: (message) => sent.push(message),
    t,
  });
  const restoreCode = mockSelectionRange(codeHost, 0, 0);
  dispatchContextMenu(q<HTMLElement>(codeHost, '.sfe-file-viewer-line'));
  q<HTMLButtonElement>(q<HTMLElement>(document, '.sfe-viewer-context-menu'), '[data-menu-id="send-to-chat"]').click();
  restoreCode();
  assert.deepEqual(sent, ['repo\\sub\\a.js L1-L1\nconst value = 1;']);
  assert.equal(sent[0].includes('```'), false);
  assert.equal(sent[0].includes('1 const'), false);
  assert.equal(sent[0].includes('D:/repo'), false);

  const mdHost = document.createElement('div');
  renderCodeViewer(mdHost, {
    preview: {
      kind: 'text',
      name: 'a.md',
      path: 'D:/repo/a.md',
      text: '# 标题\n正文',
      isMarkdown: true,
      mode: 'code',
    },
    rootPath: 'D:/repo',
    copied: false,
    onSendToChat: (message) => sent.push(message),
    t,
  });
  const restoreMd = mockSelectionRange(mdHost, 0, 0);
  dispatchContextMenu(q<HTMLElement>(mdHost, '.sfe-file-viewer-line'));
  q<HTMLButtonElement>(q<HTMLElement>(document, '.sfe-viewer-context-menu'), '[data-menu-id="send-to-chat"]').click();
  restoreMd();
  assert.deepEqual(sent, ['repo\\sub\\a.js L1-L1\nconst value = 1;', 'repo\\a.md L1-L1\n# 标题']);
});

test('预览区右键菜单: 只读态跨行选区不得把行号混进正文（发送到会话必须可定位）', () => {
  const sent: string[] = [];
  const host = document.createElement('div');
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'a.js',
      path: 'D:/repo/a.js',
      text: 'import fs from "fs";\nimport path from "path";\nimport os from "os";',
      isMarkdown: false,
      mode: 'preview',
    },
    rootPath: 'D:/repo',
    copied: false,
    onSendToChat: (message) => sent.push(message),
    t,
  });

  // 选中第 1-3 行正文；只读虚拟行的行号节点位于同一行内，必须被剔除。
  const restore = mockSelectionRange(host, 0, 2);
  dispatchContextMenu(q<HTMLElement>(host, '.sfe-file-viewer-line'));
  q<HTMLButtonElement>(q<HTMLElement>(document, '.sfe-viewer-context-menu'), '[data-menu-id="send-to-chat"]').click();
  restore();

  assert.equal(sent.length, 1, '跨行选区必须能生成消息，不得静默丢弃');
  const body = sent[0].slice(sent[0].indexOf('\n') + 1);
  assert.equal(body, 'import fs from "fs";\nimport path from "path";\nimport os from "os";');
  assert.ok(!/^\d+$/m.test(body), `正文不得含行号行：${JSON.stringify(body)}`);
  assert.equal(sent[0].includes(' L1-L3'), true);
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
      isMarkdown: false,
    },
    copied: false,
    onCopy: () => {},
    onEditInput: (value) => {
      inputValue = value;
    },
    editable: true,
    t,
  });

  const textarea = q<HTMLTextAreaElement>(host, 'textarea');
  textarea.setSelectionRange(0, 5);
  dispatchContextMenu(textarea);
  const menu = q<HTMLElement>(document, '.sfe-viewer-context-menu');
  assert.ok(menu.querySelector('[data-menu-id="copy"]'));
  assert.ok(menu.querySelector('[data-menu-id="cut"]'));
  assert.ok(menu.querySelector('[data-menu-id="paste"]'));
  await flushClipboardRead();
  q<HTMLButtonElement>(menu, '[data-menu-id="cut"]').click();
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
      isMarkdown: false,
    },
    copied: false,
    onCopy: () => {},
    onEditInput: (value) => {
      inputValue = value;
    },
    editable: true,
    t,
  });

  const textarea = q<HTMLTextAreaElement>(host, 'textarea');
  textarea.setSelectionRange(1, 2);
  dispatchContextMenu(textarea);
  const menu = q<HTMLElement>(document, '.sfe-viewer-context-menu');
  const paste = q<HTMLButtonElement>(menu, '[data-menu-id="paste"]');
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
      isMarkdown: false,
    },
    copied: false,
    onCopy: () => {},
    onEditInput: () => {},
    editable: true,
    t,
  });

  setClipboard({ readText: async () => '' });
  const textarea = q<HTMLTextAreaElement>(host, 'textarea');
  dispatchContextMenu(textarea);
  let menu = q<HTMLElement>(document, '.sfe-viewer-context-menu');
  await flushClipboardRead();
  assert.equal(q<HTMLButtonElement>(menu, '[data-menu-id="paste"]').disabled, true);
  document.body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(document.querySelector('.sfe-viewer-context-menu'), null);

  setClipboard({ readText: async () => { throw new Error('clipboard denied'); } });
  dispatchContextMenu(textarea);
  menu = q<HTMLElement>(document, '.sfe-viewer-context-menu');
  await flushClipboardRead();
  assert.equal(q<HTMLButtonElement>(menu, '[data-menu-id="paste"]').disabled, true);
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
      isMarkdown: false,
    },
    copied: false,
    onCopy: () => {},
    onEditInput: () => {
      inputCount += 1;
    },
    editable: true,
    t,
  });

  const textarea = q<HTMLTextAreaElement>(host, 'textarea');
  textarea.setSelectionRange(0, 2);
  dispatchContextMenu(textarea);
  const menu = q<HTMLElement>(document, '.sfe-viewer-context-menu');
  q<HTMLButtonElement>(menu, '[data-menu-id="cut"]').click();
  await flushClipboardRead();
  assert.equal(textarea.value, 'abc');
  assert.equal(inputCount, 0);
});

test('Git 右侧查看器: 未打开文件（空态）也能右键弹出「刷新」菜单', () => {
  const host = document.createElement('div');
  const calls: string[] = [];
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
  assert.equal(q<HTMLElement>(host, '.sfe-file-viewer-empty').textContent, '在左侧选择变更文件以查看差异。');
  // 空态右键：此前 bindViewerContextMenu 对 !preview 直接不绑，导致完全无反应——回归点
  dispatchContextMenu(q<HTMLElement>(host, '.sfe-file-viewer-empty'));
  const menu = document.querySelector<HTMLElement>('.sfe-viewer-context-menu');
  assert.ok(menu, '空态右键应显示菜单');
  assert.deepEqual(
    [...menu.querySelectorAll<HTMLButtonElement>('[data-menu-id]')].map((item) => item.dataset.menuId),
    ['refresh']
  );
  q<HTMLButtonElement>(menu, '[data-menu-id="refresh"]').click();
  assert.deepEqual(calls, ['refresh']);
});

test('Git 右侧查看器: 差异视图右键弹出文件操作菜单（只读）', () => {
  const host = document.createElement('div');
  const result = parseUnifiedDiff('@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;');
  const calls: string[] = [];
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
  dispatchContextMenu(q<HTMLElement>(host, '.sfe-diff-scroll'));
  const menu = document.querySelector<HTMLElement>('.sfe-viewer-context-menu');
  assert.ok(menu, '差异视图右键应显示菜单');
  assert.deepEqual(
    [...menu.querySelectorAll<HTMLButtonElement>('[data-menu-id]')].map((item) => item.dataset.menuId),
    ['reveal', 'refresh', 'copy-path', 'copy-relative-path']
  );
  q<HTMLButtonElement>(menu, '[data-menu-id="refresh"]').click();
  assert.deepEqual(calls, ['refresh']);
});

test('代码预览: 根目录 package.json 的 scripts 行显示运行按钮并复用对应命令', () => {
  const host = document.createElement('div');
  let received: FlatRunCommand | null = null;
  const command: FlatRunCommand = {
    id: 'npm:dev',
    labelKey: null,
    label: 'dev',
    labelFallback: 'dev',
    cmd: 'npm run dev',
    icon: 'package',
    ecosystem: 'node',
    dir: '',
    group: null,
  };

  renderCodeViewer(host, {
    rootPath: 'D:/repo',
    preview: {
      kind: 'text',
      name: 'package.json',
      path: 'D:/repo/package.json',
      text: '{\n  "scripts": {\n    "dev": "vite"\n  }\n}',
      isMarkdown: false,
    },
    copied: false,
    runCommands: () => [command],
    onRunCommand: (value) => {
      received = value;
    },
    onCopy: () => {},
    t,
  });

  const buttons = host.querySelectorAll<HTMLButtonElement>('.sfe-file-viewer-gutter-run');
  assert.equal(buttons.length, 1, '根目录 scripts.dev 应生成一个行内运行按钮');
  const icon = buttons[0].querySelector('svg');
  assert.ok(icon, '运行按钮内部应存在 SVG 图标');
  assert.equal(icon.getAttribute('width'), '14');
  assert.equal(icon.getAttribute('height'), '14');

  buttons[0].click();
  assert.equal(received, command, '点击按钮应传入对应的根目录命令');
});

test('代码预览: 二级 package.json 按所属包目录显示 pnpm 脚本运行按钮', () => {
  const host = document.createElement('div');
  let received: FlatRunCommand | null = null;
  const command: FlatRunCommand = {
    id: 'pnpm:apps/web:dev',
    labelKey: null,
    label: 'dev',
    labelFallback: 'apps/web/dev',
    cmd: 'pnpm run dev',
    icon: 'package',
    packageManager: 'pnpm',
    ecosystem: 'node:apps/web',
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
      isMarkdown: false,
    },
    copied: false,
    runCommands: () => [command],
    onRunCommand: (value) => {
      received = value;
    },
    onCopy: () => {},
    t,
  });

  const button = host.querySelector<HTMLButtonElement>('.sfe-file-viewer-gutter-run');
  assert.ok(button, '二级 package.json 的脚本行应显示运行按钮');
  button.click();
  assert.equal(received, command);
});

test('代码预览: Go 源文件 func main() 行显示运行按钮（module 根 go run .）', () => {
  const host = document.createElement('div');
  let received: FlatRunCommand | null = null;
  const command: FlatRunCommand = {
    id: 'go:run',
    labelKey: null,
    label: 'go run .',
    labelFallback: 'go run .',
    cmd: 'go run .',
    icon: 'go',
    ecosystem: 'go',
    dir: '',
    group: null,
  };
  renderCodeViewer(host, {
    rootPath: 'D:/go/demo',
    preview: {
      kind: 'text',
      name: 'main.go',
      path: 'D:/go/demo/main.go',
      text: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n',
      isMarkdown: false,
    },
    copied: false,
    runCommands: () => [command],
    onRunCommand: (value) => {
      received = value;
    },
    onCopy: () => {},
    t,
  });

  const button = host.querySelector<HTMLButtonElement>('.sfe-file-viewer-gutter-run');
  assert.ok(button, 'func main() 行应显示运行按钮');
  button.click();
  assert.equal(received, command);
});

test('代码预览: Go 的 cmd/<name>/main.go 匹配 go run ./cmd/<name>（非 go run .）', () => {
  const host = document.createElement('div');
  let received: FlatRunCommand | null = null;
  const runDot: FlatRunCommand = {
    id: 'go:run',
    labelKey: null,
    label: 'go run .',
    labelFallback: 'go run .',
    cmd: 'go run .',
    icon: 'go',
    ecosystem: 'go:server',
    dir: 'server',
    group: 'server',
  };
  const runCmd: FlatRunCommand = {
    id: 'go:cmd/server',
    labelKey: null,
    label: 'go run ./cmd/server',
    labelFallback: 'go run ./cmd/server',
    cmd: 'go run ./cmd/server',
    icon: 'go',
    ecosystem: 'go:server',
    dir: 'server',
    group: 'server',
  };
  renderCodeViewer(host, {
    rootPath: 'D:/go/liyong',
    preview: {
      kind: 'text',
      name: 'main.go',
      path: 'D:/go/liyong/server/cmd/server/main.go',
      text: 'package main\n\nfunc main() {}\n',
      isMarkdown: false,
    },
    copied: false,
    runCommands: () => [runDot, runCmd],
    onRunCommand: (value) => {
      received = value;
    },
    onCopy: () => {},
    t,
  });

  const button = host.querySelector<HTMLButtonElement>('.sfe-file-viewer-gutter-run');
  assert.ok(button, 'cmd/<name>/main.go 应显示运行按钮');
  button.click();
  assert.equal(received, runCmd, '应匹配 go run ./cmd/server 而非 go run .');
});

test('代码预览: Go 文件无 func main() 不显示运行按钮', () => {
  const host = document.createElement('div');
  renderCodeViewer(host, {
    rootPath: 'D:/go/demo',
    preview: {
      kind: 'text',
      name: 'util.go',
      path: 'D:/go/demo/util.go',
      text: 'package main\n\nfunc helper() {}\n',
      isMarkdown: false,
    },
    copied: false,
    runCommands: () => [
      {
        id: 'go:run',
        labelKey: null,
        label: 'go run .',
        labelFallback: 'go run .',
        cmd: 'go run .',
        icon: 'go',
        ecosystem: 'go',
        dir: '',
        group: null,
      },
    ],
    onRunCommand: () => {},
    onCopy: () => {},
    t,
  });
  assert.equal(host.querySelector('.sfe-file-viewer-gutter-run'), null);
});

test('预览区右键菜单: package.json 只列本包命令，不列其他包的运行项', () => {
  const host = document.createElement('div');
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'package.json',
      path: 'D:/repo/package.json',
      text: '{}',
      isMarkdown: false,
    },
    rootPath: 'D:/repo',
    copied: false,
    onCopy: () => {},
    runCommands: () => [
      {
        id: 'npm:dev',
        labelKey: null,
        labelFallback: 'dev',
        cmd: 'npm run dev',
        icon: 'package',
        ecosystem: 'node',
        dir: '',
        group: null,
      },
      {
        id: 'npm:api:start',
        labelKey: null,
        labelFallback: 'api/start',
        cmd: 'npm --prefix api run start',
        icon: 'package',
        ecosystem: 'node:api',
        dir: 'api',
        group: 'api',
      },
    ],
    onRunCommand: () => {},
    t,
  });

  dispatchContextMenu(q<HTMLElement>(host, '.sfe-file-viewer-line'));
  const menu = q<HTMLElement>(document, '.sfe-viewer-context-menu');
  assert.deepEqual(
    [...menu.querySelectorAll<HTMLButtonElement>('[data-menu-id]')].map((item) => item.dataset.menuId),
    ['run:npm:dev'],
    '根 package.json 的右键不得列出 api 子包的命令'
  );
  assert.deepEqual(
    [...menu.querySelectorAll<HTMLElement>('.sfe-context-menu-group')].map((node) => node.textContent),
    ['根目录'],
    '组标题只保留当前文件所属的包'
  );
  // 清理本用例菜单，避免影响后续用例
  renderCodeViewer(host, { preview: null, copied: false, onCopy: () => {}, t });
});

const ROOT_DEV_COMMAND: FlatRunCommand = {
  id: 'npm:dev',
  labelKey: null,
  label: 'dev',
  labelFallback: 'dev',
  cmd: 'npm run dev',
  icon: 'package',
  ecosystem: 'node',
  dir: '',
  group: null,
};

const GO_RUN_COMMAND: FlatRunCommand = {
  id: 'go:run',
  labelKey: null,
  label: 'go run .',
  labelFallback: 'go run .',
  cmd: 'go run .',
  icon: 'go',
  ecosystem: 'go',
  dir: '',
  group: null,
};

/**
 * 右键一次并取回菜单项 id 列表。
 * @description 右键目标直接用预览容器本身：监听绑在容器上，图片等非代码预览没有 `.sfe-file-viewer-code-content`。
 * @param preview 预览状态
 * @param commands 行内 ▶ 用的完整命令列表（含顶栏隐藏项）
 * @param options 额外注入项；`menuCommands` 对应顶栏运行下拉的同源列表（缺省表示不注入）
 * @param options.menuCommands 顶栏可见列表，用于验证右键不会列出顶栏没有的命令
 * @param options.path 覆盖预览文件路径（默认按 `D:/repo/<name>` 拼）
 */
function viewerMenuIds(
  preview: CodePreviewState,
  commands: FlatRunCommand[],
  options: { menuCommands?: FlatRunCommand[]; path?: string } = {}
): string[] {
  const host = document.createElement('div');
  renderCodeViewer(host, {
    preview: options.path ? { ...preview, path: options.path } : preview,
    rootPath: 'D:/repo',
    copied: false,
    onCopy: () => {},
    runCommands: () => commands,
    runMenuCommands: options.menuCommands ? () => options.menuCommands as FlatRunCommand[] : undefined,
    onRunCommand: () => {},
    t,
  });
  dispatchContextMenu(host);
  const menu = document.querySelector<HTMLElement>('.sfe-viewer-context-menu');
  const ids = menu
    ? [...menu.querySelectorAll<HTMLButtonElement>('[data-menu-id]')].map((item) => item.dataset.menuId || '')
    : [];
  // 卸载菜单监听并清掉残留节点，避免污染后续用例
  renderCodeViewer(host, { preview: null, copied: false, onCopy: () => {}, t });
  return ids;
}

const textPreview = (name: string, text: string): CodeTextPreview => ({
  kind: 'text',
  name,
  path: `D:/repo/${name}`,
  text,
  isMarkdown: false,
});

const API_GO_RUN_COMMAND: FlatRunCommand = {
  id: 'go:api:run',
  labelKey: null,
  label: 'go run .',
  labelFallback: 'api/go run .',
  cmd: 'go run .',
  icon: 'go',
  ecosystem: 'go:api',
  dir: 'api',
  group: 'api',
};

const API_MAVEN_BUILD_COMMAND: FlatRunCommand = {
  id: 'maven:api:build',
  labelKey: null,
  labelFallback: 'api/mvn verify',
  cmd: '../mvnw.cmd verify',
  icon: 'java',
  ecosystem: 'maven:api',
  dir: 'api',
  group: 'api',
};

test('预览区右键菜单: 包管理清单文件给出运行项（含无行内 ▶ 的 go.mod / 锁文件）', () => {
  for (const name of ['package.json', 'go.mod', 'pnpm-lock.yaml', 'pom.xml', 'requirements-dev.txt']) {
    const ids = viewerMenuIds(textPreview(name, '{}'), [ROOT_DEV_COMMAND]);
    assert.ok(ids.includes('run:npm:dev'), `${name} 是包管理文件，右键应给出运行项`);
  }
});

test('预览区右键菜单: 清单文件只列自己所在包的命令', () => {
  const all = [ROOT_DEV_COMMAND, GO_RUN_COMMAND, API_GO_RUN_COMMAND];
  const rootIds = viewerMenuIds(textPreview('go.mod', 'module demo\n'), all, { menuCommands: all });
  assert.deepEqual(rootIds.filter((id) => id.startsWith('run:')), ['run:npm:dev', 'run:go:run'], '根 go.mod 不含 api 包命令');
  const apiIds = viewerMenuIds(textPreview('go.mod', 'module api\n'), all, { menuCommands: all, path: 'D:/repo/api/go.mod' });
  assert.deepEqual(apiIds.filter((id) => id.startsWith('run:')), ['run:go:api:run'], 'api/go.mod 只含 api 包命令');
});

test('预览区右键菜单: 顶栏没有的命令不得出现在右键运行项里', () => {
  // 顶栏可见列表只给了 api 的 go run；mvn verify 属于 flattenCommands 隐藏的模块内部命令。
  const ids = viewerMenuIds(textPreview('pom.xml', '<project/>'), [ROOT_DEV_COMMAND, API_MAVEN_BUILD_COMMAND], {
    menuCommands: [API_GO_RUN_COMMAND],
    path: 'D:/repo/api/pom.xml',
  });
  assert.deepEqual(ids, ['run:go:api:run'], '只出现顶栏同源列表里的命令');
  assert.ok(!ids.includes('run:maven:api:build'), '顶栏没有的模块内部命令不能出现在右键');
});

test('预览区右键菜单: 有行内 ▶ 运行入口的文件只列该文件自己的入口', () => {
  const ids = viewerMenuIds(textPreview('main.go', 'package main\n\nfunc main() {}\n'), [ROOT_DEV_COMMAND, GO_RUN_COMMAND]);
  assert.deepEqual(ids.filter((id) => id.startsWith('run:')), ['run:go:run'], 'main.go 只给 func main 对应的那条命令');
});

test('预览区右键菜单: 普通源码与图片预览不再出现运行项', () => {
  for (const name of ['README.md', 'utils.ts', 'notes.txt', 'AppHelper.java', 'index.css']) {
    const ids = viewerMenuIds(textPreview(name, 'hello'), [ROOT_DEV_COMMAND, GO_RUN_COMMAND]);
    assert.ok(!ids.some((id) => id.startsWith('run:')), `${name} 不该出现运行项，实际 ${JSON.stringify(ids)}`);
  }
  const imageIds = viewerMenuIds({ kind: 'image', name: 'logo.png', path: 'D:/repo/logo.png', url: 'data:image/png;base64,AA' }, [ROOT_DEV_COMMAND]);
  assert.ok(!imageIds.some((id) => id.startsWith('run:')), '图片预览不该出现运行项');
});

test('代码预览: Java/Kotlin main sourcePath + mainLine 显示 14x14 运行按钮并回传命令', () => {
  const host = document.createElement('div');
  const command: FlatRunCommand = {
    id: 'maven:app:main:demo-App',
    labelKey: null,
    labelFallback: 'app/run demo.App',
    cmd: '..\\mvnw.cmd spring-boot:run -Dspring-boot.run.main-class=demo.App',
    icon: 'java',
    ecosystem: 'maven:app',
    dir: 'app',
    group: 'app',
    sourcePath: 'D:/repo/app/src/main/java/demo/App.java',
    mainLine: 3,
    mainClass: 'demo.App',
    runKind: 'spring-boot',
  };
  const calls: FlatRunCommand[] = [];
  renderCodeViewer(host, {
    preview: {
      kind: 'text',
      name: 'App.java',
      path: 'd:\\repo\\app\\src\\main\\java\\demo\\App.java',
      text: ['package demo;', 'public class App {', '  public static void main(String[] args) {}', '}'].join('\n'),
      isMarkdown: false,
      mode: 'preview',
    },
    copied: false,
    onCopy: () => {},
    runCommands: () => [command],
    onRunCommand: (value) => calls.push(value),
    t,
  });
  const buttons = host.querySelectorAll<HTMLButtonElement>('.sfe-file-viewer-gutter-run');
  assert.equal(buttons.length, 1);
  const svg = q<SVGSVGElement>(buttons[0], 'svg');
  assert.equal(svg.getAttribute('width'), '14');
  assert.equal(svg.getAttribute('height'), '14');
  buttons[0].click();
  assert.deepEqual(calls, [command]);
});

// 编辑态与只读态走同一条逐行切片管线，体量不再是高亮的门槛：
// 再大的文件进编辑态也必须保有 token 配色，不得退化为纯文本底色。
// （旧的「编辑态专用阈值」已随统一管线废除，这里越过当年那条 60K 字符线作回归钉。）
test('预览组件: 越过旧的整篇熔断阈值的大文件，进编辑态仍保留语法高亮', () => {
  const host = document.createElement('div');
  const line = 'const value = 1; // padding padding';
  const text = Array.from({ length: 2000 }, () => line).join('\n');
  assert.ok(text.length > 60000, '用例须越过旧的编辑态专用字符上限');

  const preview: CodeTextPreview = {
    kind: 'text',
    name: 'big.js',
    path: 'D:/repo/big.js',
    text,
    isMarkdown: false,
    mode: 'preview',
  };
  renderCodeViewer(host, {
    preview,
    copied: false,
    onCopy: () => {},
    onEditInput: () => {},
    onSave: () => {},
    editable: true,
    t,
  });

  const editHighlight = host.querySelector('.sfe-file-viewer-edit-highlight');
  assert.ok(editHighlight, '编辑模式应渲染高亮层');
  assert.ok(
    editHighlight!.querySelector('.token.keyword'),
    '只读态能上色的文件进编辑态必须仍有 token 配色，不得退化为纯文本底色'
  );
});

test('预览组件: 编辑态行号槽按差额增删，已有行号节点原地复用', () => {
  const host = document.createElement('div');
  const preview: CodeTextPreview = {
    kind: 'text',
    name: 'gutter.js',
    path: 'D:/repo/gutter.js',
    text: 'const a = 1;\nconst b = 2;',
    isMarkdown: false,
  };
  renderCodeViewer(host, {
    preview,
    copied: false,
    onCopy: () => {},
    onEditInput: () => {},
    onSave: () => {},
    editable: true,
    t,
  });

  const textarea = q<HTMLTextAreaElement>(host, 'textarea');
  const gutter = q<HTMLElement>(host, '.sfe-file-viewer-edit-gutter');
  assert.equal(gutter.childElementCount, 2, '首建按行数全量生成');
  const firstRow = gutter.firstElementChild;

  const type = (value: string) => {
    textarea.value = value;
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };

  type('const a = 1;\nconst b = 2;\nconst c = 3;');
  assert.equal(gutter.childElementCount, 3, '多一行应只在尾部补一行');
  assert.equal(gutter.firstElementChild, firstRow, '增量补差不整槽重建，已有行号节点必须原地复用');
  assert.equal(gutter.lastElementChild?.textContent, '3', '补出的尾部行号连续');

  type('const a = 1;');
  assert.equal(gutter.childElementCount, 1, '少两行应只删尾部节点');
  assert.equal(gutter.firstElementChild, firstRow, '删尾部不触碰已有节点');
  assert.equal(gutter.textContent, '1', '删尾后无残留行号');
});

test('预览组件: 编辑态切片高亮在文本变化后重绘，行号与显示内容保持对应', async () => {
  const host = document.createElement('div');
  const text = Array.from({ length: 600 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const preview: CodeTextPreview = {
    kind: 'text',
    name: 'slice.js',
    path: 'D:/repo/slice.js',
    text,
    isMarkdown: false,
  };

  // 切片偏移按真实行高换算；jsdom 量到的是 line-height:normal，退回整篇高亮就走不进切片分支，
  // 故把行高固定为 20px（textarea 的 12.5px × 1.6 即此值）。
  const originalComputedStyle = dom.window.getComputedStyle;
  dom.window.getComputedStyle = (() => ({ lineHeight: '20px' })) as unknown as typeof originalComputedStyle;

  try {
    renderCodeViewer(host, {
      preview,
      copied: false,
      onCopy: () => {},
      onEditInput: () => {},
      onSave: () => {},
      editable: true,
      t,
    });

    const textarea = q<HTMLTextAreaElement>(host, 'textarea');
    const editHighlight = q<HTMLElement>(host, '.sfe-file-viewer-edit-highlight');
    const gutter = q<HTMLElement>(host, '.sfe-file-viewer-edit-gutter');

    // 前置：切片只铺可视窗口，末行不在高亮层内；否则本用例测不到切片行为。
    assert.ok(!editHighlight.textContent!.includes('const v599'), '用例须落在切片窗口之外');

    textarea.value = `const inserted = 1;\n${text}`;
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(gutter.childElementCount, 601, '行号槽应随新增行立刻多出一行');

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(
      editHighlight.textContent!.startsWith('const inserted'),
      '文本变化后切片必须重绘：显示内容落后一行即行号与内容错位'
    );
  } finally {
    dom.window.getComputedStyle = originalComputedStyle;
  }
});

test('预览组件: 编辑态 textarea 的贴合高度必须在元素入文档后测量', () => {
  const host = document.createElement('div');
  const preview: CodeTextPreview = {
    kind: 'text',
    name: 'height.js',
    path: 'D:/repo/height.js',
    text: Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join('\n'),
    isMarkdown: false,
  };

  // jsdom 没有布局引擎，scrollHeight 恒为 0，量不出「挂载前后」的差别。
  // 这里按「已连接才有布局」造一个假内容高度：元素真挂进文档才读得到，
  // 用来钉住 syncEditHeight 必须晚于 bodyEl.appendChild 这条顺序。
  // jsdom 把 scrollHeight 实现成 Element.prototype 上的访问器，故在 Element 一层打桩，
  // 且只改写 textarea 的读数，其余元素原样转调，避免波及同一次渲染里的其他测量。
  const proto = dom.window.Element.prototype;
  const originalDescriptor = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
  if (!originalDescriptor || typeof originalDescriptor.get !== 'function') {
    throw new Error('jsdom 未提供 Element#scrollHeight 访问器，无法构造布局桩');
  }
  const readRealScrollHeight = originalDescriptor.get;
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: Element) {
      if (!(this instanceof dom.window.HTMLTextAreaElement)) {
        return readRealScrollHeight.call(this);
      }
      return this.isConnected ? 4321 : 0;
    },
  });

  try {
    // 宿主必须真的在文档里：桩按 isConnected 决定读得到内容高度还是 0，
    // 这正是「入文档后才能量高」这条被测不变量在真机上的语义。
    document.body.appendChild(host);
    renderCodeViewer(host, {
      preview,
      copied: false,
      onCopy: () => {},
      onEditInput: () => {},
      onSave: () => {},
      editable: true,
      t,
    });
    const textarea = q<HTMLTextAreaElement>(host, 'textarea');
    assert.equal(
      textarea.style.height,
      '4321px',
      'textarea 高度必须在进入文档后测量：挂载前读 scrollHeight 恒为 0，' +
        '会把编辑区压成一屏高，光标与选区改按 textarea 自己的内层滚动定位，行号与内容全部错位'
    );
  } finally {
    Object.defineProperty(proto, 'scrollHeight', originalDescriptor);
    host.remove();
  }
});

test('预览组件: 虚拟列表视口尺寸变化后按新高度重算窗口，重绘不叠加观察者', async () => {
  type Entry = { contentRect: { height: number } };
  type Stub = {
    fire: (entries: Entry[]) => void;
    observed: Element[];
    disconnected: boolean;
  };
  const created: Stub[] = [];
  globalThis.ResizeObserver = class {
    fire: (entries: Entry[]) => void = () => {};
    observed: Element[] = [];
    disconnected = false;
    constructor(callback: (entries: Entry[]) => void) {
      this.fire = callback;
      created.push(this);
    }
    observe(target: Element) {
      this.observed.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
  } as unknown as typeof ResizeObserver;
  const live = () => created.filter((observer) => !observer.disconnected);

  try {
    const host = document.createElement('div');
    const text = Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n');
    const options = {
      preview: {
        kind: 'text' as const,
        name: 'big.txt',
        path: 'D:/repo/big.txt',
        text,
        isMarkdown: false,
      },
      copied: false,
      onCopy: () => {},
      t,
    };
    renderCodeViewer(host, options);

    const scroll = q<HTMLElement>(host, '.sfe-file-viewer-code-scroll');
    assert.equal(created.length, 1, '虚拟列表应挂且只挂一个视口观察者');
    assert.deepEqual(created[0].observed, [scroll], '观察者监听的是滚动视口本身');
    const rowsBefore = scroll.querySelectorAll('.sfe-file-viewer-line').length;

    // jsdom 不布局：把视口高度改成 1200 后按新尺寸通知，窗口行数必须跟着变大
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 1200 });
    created[0].fire([{ contentRect: { height: 1200 } }]);
    const rowsAfter = scroll.querySelectorAll('.sfe-file-viewer-line').length;
    assert.ok(rowsAfter > rowsBefore, `高度变大后窗口应重算，实际 ${rowsBefore} → ${rowsAfter}`);

    const firstRow = scroll.querySelector('.sfe-file-viewer-line');
    created[0].fire([{ contentRect: { height: 1200 } }]);
    assert.equal(scroll.querySelector('.sfe-file-viewer-line'), firstRow, '同一高度重复通知不得重建可视行');
    created[0].fire([{ contentRect: { height: 0 } }]);
    assert.equal(scroll.querySelector('.sfe-file-viewer-line'), firstRow, '零高度（面板隐藏）通知应忽略');

    // 同一容器重绘：旧观察者断开，容器上始终只存活一个
    renderCodeViewer(host, options);
    assert.equal(created[0].disconnected, true, '重绘必须断开上一次视口观察者');
    assert.equal(created.length, 2);
    assert.equal(live().length, 1, '同一容器多次渲染不得叠加观察者');

    renderCodeViewer(host, { ...options, preview: null });
    assert.equal(created[1].disconnected, true, '切到非虚拟预览时同样要断开');
    assert.equal(live().length, 0, '离开虚拟列表后不应留下任何观察者');
  } finally {
    Reflect.deleteProperty(globalThis, 'ResizeObserver');
  }
});

test('预览组件: 文本预览一律走窗口化虚拟列表（小文件不再整块渲染，双管线已统一）', () => {
  const jsLine = (length: number) => `const v = "${'x'.repeat(Math.max(0, length - 12))}";`;
  const cases = [
    { name: '空文本', text: '' },
    { name: '小文件', text: 'const a = 1;' },
    { name: '400 行', text: Array.from({ length: 400 }, (_, i) => `const v${i} = 1;`).join('\n') },
    { name: '单行 20000 字符', text: jsLine(20000) },
    { name: '单行 20001 字符', text: jsLine(20001) },
    { name: '400 行共 28 万字符', text: Array.from({ length: 400 }, () => jsLine(700)).join('\n') },
  ];

  for (const { name, text } of cases) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    try {
      renderCodeViewer(host, {
        preview: {
          kind: 'text',
          name: 'a.js',
          path: 'D:/repo/a.js',
          text,
          isMarkdown: false,
        },
        copied: false,
        onCopy: () => {},
        t,
      });
      assert.ok(
        !!host.querySelector('.sfe-file-viewer-code-scroll-virtual'),
        `${name}：只读态应统一走窗口化虚拟列表`
      );
      assert.ok(!host.querySelector('.sfe-file-viewer-code-content'), `${name}：整块 <pre> 渲染分支应已移除`);
    } finally {
      host.remove();
    }
  }
});


test('预览组件: 行号槽标记只钉在指定行，点击交回它自己的回调', () => {
  const host = document.createElement('div');
  const runs: string[] = [];
  const preview: CodeTextPreview = {
    kind: 'text',
    name: 'a.http',
    path: 'D:/repo/a.http',
    text: '@host = a.test\n\n### 登录\nGET https://{{host}}/users',
    isMarkdown: false,
    mode: 'preview',
  };
  renderCodeViewer(host, {
    preview,
    copied: false,
    onCopy: () => {},
    gutterMarkers: () => [{ line: 3, title: '发送此请求: 登录', onRun: () => runs.push('登录') }],
    t,
  });
  const rows = host.querySelectorAll('.sfe-file-viewer-line');
  assert.equal(rows.length, 4, '虚拟行按行数渲染出可视窗口');
  assert.equal(rows[0].querySelector('.sfe-file-viewer-gutter-run'), null, '没标记的行不该有箭头');
  const button = q<HTMLButtonElement>(rows[2], '.sfe-file-viewer-gutter-run');
  assert.equal(button.title, '发送此请求: 登录');
  assert.equal(button.getAttribute('aria-label'), '发送此请求: 登录');
  button.click();
  assert.deepEqual(runs, ['登录']);
});

test('预览组件: 编辑态行号槽同样带标记，失焦只通报一次', () => {
  const host = document.createElement('div');
  let blurred = 0;
  const preview: CodeTextPreview = {
    kind: 'text',
    name: 'a.http',
    path: 'D:/repo/a.http',
    text: '### 登录\nGET https://a.test/users',
    isMarkdown: false,
    mode: 'preview',
  };
  renderCodeViewer(host, {
    preview,
    copied: false,
    onCopy: () => {},
    onEditInput: () => {},
    onSave: () => {},
    editable: true,
    onEditBlur: () => (blurred += 1),
    gutterMarkers: () => [{ line: 1, title: '发送此请求: 登录', onRun: () => blurred += 100 }],
    t,
  });
  const area = q<HTMLTextAreaElement>(host, 'textarea');
  assert.ok(host.querySelector('.sfe-file-viewer-edit-gutter .sfe-file-viewer-gutter-run'), '编辑态的行号槽也该挂上 ▶');
  area.dispatchEvent(new dom.window.Event('blur', { bubbles: false }));
  assert.equal(blurred, 1, '失焦通报与发送是两件事');
});

test('代码查看器: .vue 文件预览按 SFC 区块逐行着色（模板 HTML / 脚本 TS）', () => {
  const host = document.createElement('div');
  const text = [
    '<template>',
    '  <b class="a">{{ n }}</b>',
    '</template>',
    '<script lang="ts">',
    'const n = 1;',
    '</script>',
  ].join('\n');
  renderCodeViewer(host, {
    preview: { kind: 'text', name: 'a.vue', path: 'D:/repo/a.vue', text, isMarkdown: false, mode: 'preview' },
    copied: false,
    t,
  });
  const rows = [...host.querySelectorAll<HTMLElement>('.sfe-file-viewer-line-text')];
  assert.ok(rows.some((row) => row.querySelector('.token.tag')), '模板行要有 HTML tag 着色');
  assert.ok(rows.some((row) => row.querySelector('.token.keyword')), '脚本体行要有 keyword 着色');
});

test('代码查看器: 首帧未加载高亮块时，懒块完成后刷新可视行', async () => {
  // 回归：首帧允许先显示纯文本，但高亮块完成后必须刷新仍挂载的虚拟列表；
  // 只检查最终公开行为，不把“是否调用 refresh”这种内部实现当成契约。
  installHighlighter(null);
  const host = document.createElement('div');
  document.body.appendChild(host);
  try {
    renderCodeViewer(host, {
      preview: {
        kind: 'text',
        name: 'a.js',
        path: 'D:/repo/a.js',
        text: 'const value = 1;',
        isMarkdown: false,
        mode: 'preview',
      },
      copied: false,
      t,
    });

    // 懒块完成前允许退回纯文本，但查看器必须已经挂出首屏行。
    const row = q<HTMLElement>(host, '.sfe-file-viewer-line-text');
    assert.equal(row.querySelector('.token.keyword'), null, '高亮块未完成前应先显示纯文本');

    // loadChunk 的源码兜底是异步 import；给生产 blob import 留出有限窗口，
    // 不能用固定的单个 setTimeout 伪造“已加载”，否则测不到真正的异步结果。
    const loaded = await ensureHighlighter();
    assert.ok(loaded && highlighterReady(), '高亮懒块必须能够完成加载');
    // refresh 会按虚拟列表契约重建当前窗口，不能拿刷新前已脱离 DOM 的行节点判定。
    const refreshedRow = q<HTMLElement>(host, '.sfe-file-viewer-line-text');
    assert.ok(refreshedRow.querySelector('.token.keyword'), '高亮块完成后已挂载的行必须刷新为 token HTML');
  } finally {
    host.remove();
    installHighlighter({ highlightCodeHtml });
  }
});

test('代码查看器: http 文件在未注入高亮块时仍上色（只读 + 编辑态）', () => {
  // 回归：着色逻辑曾只住在懒加载高亮块里，块没就绪就整篇无色——用户看到的正是「http 里的 JSON 一片白」。
  // 这里清空注入（等价于块从未到达），渲染 http 文件必须仍产出 token。
  installHighlighter(null);
  try {
    const text = '### 登录\nPOST https://a.test/x\nContent-Type: application/json\n\n{ "k": 1, "b": false }';
    const base: CodeTextPreview = {
      kind: 'text',
      name: 'a.http',
      path: 'D:/repo/a.http',
      text,
      isMarkdown: false,
      mode: 'preview',
    };

    // 只读态：逐行高亮（统一虚拟列表），http 由首屏着色器同步上色
    const ro = document.createElement('div');
    renderCodeViewer(ro, { preview: base, copied: false, onCopy: () => {}, onSetMode: () => {}, t });
    const rowTexts = [...ro.querySelectorAll<HTMLElement>('.sfe-file-viewer-line-text')];
    assert.ok(rowTexts.some((row) => row.querySelector('.token.property')), '只读态：方法 / JSON 键要着色');
    assert.ok(rowTexts.some((row) => row.querySelector('.token.string')), '只读态：字符串要着色');
    assert.ok(rowTexts.some((row) => row.querySelector('.token.boolean')), '只读态：布尔要着色');
    assert.ok(rowTexts.some((row) => row.querySelector('.token.number')), '只读态：数字要着色');

    // 编辑态：高亮层（textarea 文字透明，颜色全出自这一层）
    const ed = document.createElement('div');
    renderCodeViewer(ed, {
      preview: base,
      copied: false,
      onCopy: () => {},
      onEditInput: () => {},
      editable: true,
      t,
    });
    const hl = q<HTMLElement>(ed, '.sfe-file-viewer-edit-highlight');
    assert.ok(hl.querySelector('.token.property'), '编辑态：方法 / JSON 键要着色');
    assert.ok(hl.querySelector('.token.boolean'), '编辑态：布尔要着色');
  } finally {
    installHighlighter({ highlightCodeHtml });
  }
});

test('代码查看器: http 文件含超长单行时，只读与编辑态仍整篇上色（单行熔断不连累）', () => {
  // 用户真实场景：docs/test.http 第 23 行是 12 万字符的压缩 JSON / URL 编码串。
  // 旧判定把「单行超长」当整篇熔断（那是给 Prism 防正则回溯的），结果整个文件零 token。
  // http/rest 是行级自足的纯正则着色，超长行只该跳过那一行，绝不能连累整篇。
  installHighlighter(null); // 块未加载也不影响 http
  try {
    const longLine = '"long": "' + 'a'.repeat(25000) + '"';
    const text = [
      '### 一',
      'POST https://a.test/x',
      'Content-Type: application/json',
      '',
      '{ "k": 1, "b": false }',
      longLine,
    ].join('\n');
    const base: CodeTextPreview = {
      kind: 'text',
      name: 'a.http',
      path: 'D:/repo/a.http',
      text,
      isMarkdown: false,
      mode: 'preview',
    };

    // 只读态：统一虚拟列表；超长行只该让那一行退纯文本，其余行照常着色
    const ro = document.createElement('div');
    renderCodeViewer(ro, { preview: base, copied: false, onCopy: () => {}, t });
    const rowTexts = [...ro.querySelectorAll<HTMLElement>('.sfe-file-viewer-line-text')];
    assert.ok(rowTexts.some((row) => row.querySelector('.token.property')), '只读态：方法 / JSON 键要着色');
    assert.ok(rowTexts.some((row) => row.querySelector('.token.boolean')), '只读态：布尔要着色');
    // 超长行自身不着色，但正文必须完整保留（不得被裁掉）
    const longRow = rowTexts.find((row) => row.textContent && row.textContent.includes('"long"'));
    assert.ok(longRow, '超长行的正文仍要渲染');
    assert.ok(longRow!.textContent!.includes('a'.repeat(100)), '超长行内容完整');
    assert.equal(longRow!.querySelector('.token'), null, '超长行自身退化为纯文本');

    // 编辑态：高亮层同样不能被超长单行熔断成纯文本
    const ed = document.createElement('div');
    renderCodeViewer(ed, {
      preview: base,
      copied: false,
      onCopy: () => {},
      onEditInput: () => {},
      editable: true,
      t,
    });
    const hl = q<HTMLElement>(ed, '.sfe-file-viewer-edit-highlight');
    assert.ok(hl.querySelector('.token.property'), '编辑态：方法 / JSON 键要着色');
    assert.ok(hl.querySelector('.token.boolean'), '编辑态：布尔要着色');
  } finally {
    installHighlighter({ highlightCodeHtml });
  }
});

test('代码查看器: http 文件字符数超整篇上限但不足 400 行时，编辑态仍按切片上色', () => {
  // 用户真实场景：docs/test2.http（440KB / 159 行）、docs/landscape.http（392KB / 386 行）。
  // 旧判定编辑态只看行数（> 400 才切片），这类文件行数不够、退回整篇，又被整篇字符熔断
  // 写成纯文本——表现即「其他场景都有色、只有代码模式一片白」。
  // 判定必须与只读态的 shouldVirtualizeMeasured 同一套，才不会再分叉出这种只有某一路没色的缺口。
  installHighlighter(null); // http 不依赖懒加载块
  // 切片偏移按真实行高换算；jsdom 量到的是 line-height:normal，量不出行高会退回整篇纯文本，
  // 故把行高固定为 20px（textarea 的 12.5px × 1.6 即此值），与同文件既有的切片用例同一手法。
  const originalComputedStyle = dom.window.getComputedStyle;
  dom.window.getComputedStyle = (() => ({ lineHeight: '20px' })) as unknown as typeof originalComputedStyle;
  try {
    // 总字符数越过 MAX_HIGHLIGHT_LEN（25 万），行数留在 400 以内：两个条件必须分开构造。
    const filler = Array.from({ length: 180 }, () => 'x'.repeat(1500));
    const text = [
      '### 请求一',
      'POST https://a.test/x',
      'Content-Type: application/json',
      '',
      '{ "k": 1, "b": false }',
      ...filler,
    ].join('\n');
    assert.ok(text.length > 250000, '前置：文本须越过整篇字符熔断上限');
    assert.ok(text.split('\n').length <= 400, '前置：行数须留在切片阈值以内');

    const preview: CodeTextPreview = {
      kind: 'text',
      name: 'a.http',
      path: 'D:/repo/a.http',
      text,
      isMarkdown: false,
      mode: 'preview',
    };
    const ed = document.createElement('div');
    renderCodeViewer(ed, {
      preview,
      copied: false,
      onCopy: () => {},
      onEditInput: () => {},
      editable: true,
      t,
    });
    const hl = q<HTMLElement>(ed, '.sfe-file-viewer-edit-highlight');
    assert.ok(hl.querySelector('.token.property'), '编辑态：方法 / JSON 键要着色');
    assert.ok(hl.querySelector('.token.boolean'), '编辑态：布尔要着色');
  } finally {
    dom.window.getComputedStyle = originalComputedStyle;
    installHighlighter({ highlightCodeHtml });
  }
});
