import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// 建立最小 DOM 环境后再导入渲染模块（与 git-view.test.js 同法）。
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderTreeView } = await import('../../../src/components/tree-view.js');

const t = (_key, fallback) => fallback || _key;

const ROOT = 'D:/repo';
const NODES = [
  {
    name: 'src',
    path: 'D:/repo/src',
    isDirectory: true,
    children: [{ name: 'a.js', path: 'D:/repo/src/a.js', isDirectory: false, size: 10 }],
  },
  { name: 'README.md', path: 'D:/repo/README.md', isDirectory: false, size: 20 },
];
const EXPANDED = { 'D:/repo/src': true };

/** 渲染一棵固定的小树，返回容器与事件记录。 */
function render(overrides = {}) {
  const pane = document.createElement('div');
  const calls = {
    selection: [],
    selectFile: [],
    toggleDir: [],
    openEdit: [],
    keydown: [],
    context: [],
  };
  renderTreeView(pane, {
    rootPath: ROOT,
    rootNodes: NODES,
    expanded: EXPANDED,
    selected: new Set(),
    gitStatusMap: {},
    canList: true,
    canRead: true,
    onSelectionChange: (e) => calls.selection.push(e),
    onSelectFile: (e) => calls.selectFile.push(e),
    onToggleDir: (e) => calls.toggleDir.push(e),
    onOpenFileEdit: (e) => calls.openEdit.push(e),
    onTreeKeyDown: (e, visiblePaths) => calls.keydown.push({ e, visiblePaths }),
    onContextMenu: (e, x, y) => calls.context.push({ e, x, y }),
    t,
    ...overrides,
  });
  return { pane, calls };
}

/** 按条目路径取行元素。 */
function row(pane, path) {
  return [...pane.querySelectorAll('.sfe-file-item')].find((el) => el.dataset.path === path);
}

const click = (el, opts = {}) =>
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ...opts }));

test('文件树多选: ctrl 点击只改选中，不打开文件也不展开目录', () => {
  const { pane, calls } = render();
  click(row(pane, 'D:/repo/README.md'), { ctrlKey: true });
  assert.equal(calls.selection.length, 1);
  assert.deepEqual(
    { path: calls.selection[0].path, additive: calls.selection[0].additive, range: calls.selection[0].range },
    { path: 'D:/repo/README.md', additive: true, range: false },
  );
  assert.equal(calls.selectFile.length, 0, 'ctrl 点击不得打开文件');
  assert.equal(calls.toggleDir.length, 0, 'ctrl 点击不得展开目录');
});

test('文件树多选: shift 点击只做范围选择', () => {
  const { pane, calls } = render();
  click(row(pane, 'D:/repo/src'), { shiftKey: true });
  assert.equal(calls.selection.length, 1);
  assert.equal(calls.selection[0].range, true);
  assert.equal(calls.selectFile.length, 0);
  assert.equal(calls.toggleDir.length, 0);
});

test('文件树多选: 普通点击文件先单选再打开', () => {
  const { pane, calls } = render();
  click(row(pane, 'D:/repo/README.md'));
  assert.equal(calls.selection.length, 1);
  assert.equal(calls.selection[0].additive, false);
  assert.equal(calls.selection[0].range, false);
  assert.equal(calls.selectFile.length, 1);
  assert.equal(calls.selectFile[0].path, 'D:/repo/README.md');
});

test('文件树多选: 普通点击目录只展开不打开文件', () => {
  const { pane, calls } = render();
  click(row(pane, 'D:/repo/src'));
  assert.equal(calls.toggleDir.length, 1);
  assert.equal(calls.selectFile.length, 0);
});

test('文件树多选: selected 集合命中的行带 selected 类', () => {
  const { pane } = render({ selected: new Set(['D:/repo/src/a.js']) });
  assert.ok(row(pane, 'D:/repo/src/a.js').classList.contains('selected'));
  assert.ok(!row(pane, 'D:/repo/src').classList.contains('selected'));
});

test('文件树多选: Ctrl+A 键盘事件带上当前可见路径', () => {
  const { pane, calls } = render();
  const list = pane.querySelector('.sfe-list');
  list.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
  assert.equal(calls.keydown.length, 1);
  assert.deepEqual(calls.keydown[0].visiblePaths, [
    'D:/repo/src',
    'D:/repo/src/a.js',
    'D:/repo/README.md',
  ]);
});

test('文件树双击: 双击文件触发快速编辑，双击目录不触发', () => {
  const { pane, calls } = render();
  row(pane, 'D:/repo/README.md').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(calls.openEdit.length, 1);
  assert.equal(calls.openEdit[0].path, 'D:/repo/README.md');
  row(pane, 'D:/repo/src').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(calls.openEdit.length, 1, '目录双击不应触发文件快速编辑');
});
