import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { TreeEntry, TreeSelectionChange, TreeViewOptions } from '../../../src/components/tree-view.ts';
import type { TranslateFn } from '../../../src/types/panel-state.ts';

// 建立最小 DOM 环境后再导入渲染模块（与 git-view.test.js 同法）。
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderTreeView } = await import('../../../src/components/tree-view.ts');

/** 翻译桩：只用到 key + 兜底文案两项，签名复用组件消费的 TranslateFn。 */
const t: TranslateFn = (_key, fallback) => fallback || _key;

/** onTreeKeyDown 的一次调用记录（键盘事件 + 事件发生时的可见行路径）。 */
type KeydownCall = {
  /** 原始键盘事件，用例只读取它是否被触发。 */
  e: KeyboardEvent;
  /** 触发时刻的可见行路径，顺序即视觉顺序（来自组件的 rows 映射）。 */
  visiblePaths: string[];
};

/** onContextMenu 的一次调用记录（被右键的条目 + 视口坐标）。 */
type ContextCall = {
  /** 被右键的树条目。 */
  e: TreeEntry;
  /** 右键位置的视口横坐标（组件传 event.clientX）。 */
  x: number;
  /** 右键位置的视口纵坐标（组件传 event.clientY）。 */
  y: number;
};

/** render() 收集的各回调调用记录，push 顺序即触发顺序。 */
type RenderCalls = {
  /** onSelectionChange 收到的选中态变化。 */
  selection: TreeSelectionChange[];
  /** onSelectFile 收到的文件条目。 */
  selectFile: TreeEntry[];
  /** onToggleDir 收到的目录条目。 */
  toggleDir: TreeEntry[];
  /** onOpenFileEdit 收到的双击文件条目。 */
  openEdit: TreeEntry[];
  /** onTreeKeyDown 的调用记录。 */
  keydown: KeydownCall[];
  /** onContextMenu 的调用记录。 */
  context: ContextCall[];
};

const ROOT = 'D:/repo';
/** 固定小树：一个已展开目录 + 一个文件；size 是宿主 DirectoryEntry 的必填字段（目录按 0 计）。 */
const NODES: TreeEntry[] = [
  {
    name: 'src',
    path: 'D:/repo/src',
    isDirectory: true,
    size: 0,
    children: [{ name: 'a.js', path: 'D:/repo/src/a.js', isDirectory: false, size: 10 }],
  },
  { name: 'README.md', path: 'D:/repo/README.md', isDirectory: false, size: 20 },
];
const EXPANDED = { 'D:/repo/src': true };

/** 渲染一棵固定的小树，返回容器与事件记录。 */
function render(overrides: Partial<TreeViewOptions> = {}): { pane: HTMLDivElement; calls: RenderCalls } {
  const pane = document.createElement('div');
  const calls: RenderCalls = {
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
    getSelected: () => new Set(),
    getGitStatusMap: () => ({}),
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

/**
 * 按条目路径取行元素。
 * !: 行缺失即组件未为该条目渲染（本文件每条用例都在随后直接解引用，运行时同样会抛 TypeError），
 *   故在唯一出口收窄一次非空，不改变任何运行时行为。
 */
function row(pane: Element, path: string): HTMLElement {
  return [...pane.querySelectorAll<HTMLElement>('.sfe-file-item')].find((el) => el.dataset.path === path)!;
}

const click = (el: Element, opts: MouseEventInit = {}) =>
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
  const { pane } = render({ getSelected: () => new Set(['D:/repo/src/a.js']) });
  assert.ok(row(pane, 'D:/repo/src/a.js').classList.contains('selected'));
  assert.ok(!row(pane, 'D:/repo/src').classList.contains('selected'));
});

// 行节点在滚动时才创建，所以选中集合与状态表必须是「建行时现取」的取值函数。
// 一旦有人把它们改回快照，就地 patch（不重建树）之后滚进来的行就会显示过期状态。
test('文件树虚拟行: 选中集合与 Git 状态表按行现取，不许捕获快照', () => {
  let selectedReads = 0;
  let statusReads = 0;
  const { pane } = render({
    getSelected: () => {
      selectedReads += 1;
      return new Set();
    },
    getGitStatusMap: () => {
      statusReads += 1;
      return {};
    },
  });
  const builtRows = pane.querySelectorAll('.sfe-file-item').length;
  assert.ok(builtRows > 0, '前置条件：应已建出可视行');
  assert.equal(selectedReads, builtRows, '每建一行须读一次选中集合');
  assert.equal(statusReads, builtRows, '每建一行须读一次 Git 状态表');
});

test('文件树多选: Ctrl+A 键盘事件带上当前可见路径', () => {
  const { pane, calls } = render();
  const list = pane.querySelector<HTMLElement>('.sfe-list')!;
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

/** 同级文件树：行数超过首屏窗口（估算行高 24 → 可视 25+16=41 行），滚动才会真的移动窗口。 */
function flatFileTree(count: number): TreeEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `f${i}.js`,
    path: `${ROOT}/f${i}.js`,
    isDirectory: false,
    size: i,
  }));
}

/** Node 无 requestAnimationFrame，虚拟列表的帧调度退化为 setTimeout(16)，30ms 即落帧。 */
const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

async function scrollTree(pane: HTMLElement, row: number): Promise<void> {
  pane.scrollTop = row * 24;
  pane.dispatchEvent(new dom.window.Event('scroll'));
  await nextFrame();
}

// 差集渲染（滚动只补/删滑入滑出的行）与「选中态就地 patch」是一对隐含契约：
// 复用行必须保住 patch 上去的类，滚出去再滚回来的行才按 getSelected() 重建。
test('文件树虚拟行: 滚动复用重叠行、就地 patch 的选中态不丢；滚回的行按当前选中集合重建', async () => {
  const pane = document.createElement('div');
  const selected = new Set<string>();
  renderTreeView(pane, {
    rootPath: ROOT,
    rootNodes: flatFileTree(60),
    expanded: {},
    getSelected: () => selected,
    getGitStatusMap: () => ({}),
    t,
  });
  const rowCount = () => pane.querySelectorAll('.sfe-file-item').length;

  assert.equal(rowCount(), 41, '首屏须在 renderTreeView 返回时就有行（调用方紧接着恢复 scrollTop）');
  assert.ok(pane.querySelector('.sfe-vlist-content.sfe-list'), '内容层须同时带虚拟列表类与调用方附加类');

  // 选中态就地 patch（不重建树）：集合与已有行节点同时更新，这是 index.ts 的做法。
  selected.add(`${ROOT}/f30.js`);
  const patched = row(pane, `${ROOT}/f30.js`);
  patched.classList.add('selected');

  await scrollTree(pane, 30); // 窗口从 [0,41) 移到 [22,60)
  assert.equal(rowCount(), 38, '尾段行数随窗口收敛');
  assert.equal(row(pane, `${ROOT}/f30.js`), patched, '重叠区的行必须复用同一节点');
  assert.ok(patched.classList.contains('selected'), '复用不得丢掉就地 patch 的选中态');
  assert.equal(pane.querySelector('[data-path="D:/repo/f5.js"]'), null, '滑出窗口的头行应被摘掉');

  selected.add(`${ROOT}/f5.js`);
  await scrollTree(pane, 0);
  assert.ok(row(pane, `${ROOT}/f5.js`).classList.contains('selected'), '重建的行须现取当前选中集合');
});
