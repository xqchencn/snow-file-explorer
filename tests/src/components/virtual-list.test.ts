import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { VirtualItems, VirtualListHandle } from '../../../src/components/virtual-list.ts';

// 建立最小 DOM 环境后再导入被测模块（与 tree-view.test.ts 同法）。
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { createVirtualList } = await import('../../../src/components/virtual-list.ts');

/** 用例统一的固定行高（px）。 */
const ROW_H = 20;
/** jsdom 的 clientHeight 恒为 0，列表按兜底高度 600 算窗口：ceil(600/20) + 8*2 = 46 行。 */
const WINDOW_ROWS = 46;

/** 一个挂了虚拟列表的容器 + 用于判断「复用还是重建」的观察面。 */
type Fixture = {
  /** 滚动容器。 */
  viewport: HTMLElement;
  /** 内容层（可视行的父节点）。 */
  content: HTMLElement;
  /** 撑总高度的占位层。 */
  spacer: HTMLElement;
  /** 每次 renderRow 的产出记录，长度即「累计建过的行数」。 */
  built: { index: number; node: HTMLElement }[];
  /** onRangeChange 的调用序列。 */
  ranges: [number, number][];
  /** 灌给列表的行数据。 */
  items: VirtualItems<string>;
  list: VirtualListHandle<string>;
};

/** 建容器与列表（尚未灌数据）；行文本为 `prefix+下标`，可直接断言 DOM 顺序与数据一致。 */
function fixture(total: number, prefix = 'row'): Fixture {
  const viewport = document.createElement('div');
  document.body.appendChild(viewport);
  const built: { index: number; node: HTMLElement }[] = [];
  const ranges: [number, number][] = [];
  const list = createVirtualList<string>({
    viewport,
    rowHeight: ROW_H,
    contentClassName: 'sfe-test-list',
    renderRow: (text, index) => {
      const node = document.createElement('div');
      node.className = 'sfe-test-row';
      node.textContent = text;
      node.dataset.index = String(index);
      built.push({ index, node });
      return node;
    },
    onRangeChange: (start, end) => {
      ranges.push([start, end]);
    },
  });
  const content = list.contentEl;
  // spacer 由列表内部创建并插在内容层之前，测试按类名取回。
  const spacer = viewport.querySelector<HTMLElement>('.sfe-vlist-spacer')!;
  const items = Array.from({ length: total }, (_, i) => `${prefix}${i}`);
  return { viewport, content, spacer, built, ranges, items, list };
}

/** 建列表并灌数据（首屏行须同步就位，这也是多数用例的前置）。 */
function mounted(total: number, prefix = 'row'): Fixture {
  const f = fixture(total, prefix);
  f.list.setItems(f.items);
  return f;
}

/** 内容层当前的下标序列（DOM 顺序）。 */
const indexes = (content: HTMLElement): string =>
  [...content.children].map((c) => (c as HTMLElement).dataset.index).join(',');

/** 期望的下标序列文本，与 indexes 同形便于比较。 */
const seq = (from: number, to: number): string =>
  Array.from({ length: to - from }, (_, i) => String(from + i)).join(',');

/** 下标 → 首次建出该行的节点，用于断言「留下的行没被重建」。 */
function nodeByIndex(f: Fixture): Map<number, HTMLElement> {
  const map = new Map<number, HTMLElement>();
  for (const { index, node } of f.built) map.set(index, node);
  return map;
}

/** Node 环境没有 requestAnimationFrame，被测模块的帧调度退化为 setTimeout(16)，30ms 即落帧。 */
const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

/** 把窗口滚到第 row 行顶部（模拟真实滚动：写 scrollTop 后派发 scroll），并等渲染落帧。 */
async function scrollTo(f: Fixture, row: number): Promise<void> {
  f.viewport.scrollTop = row * ROW_H;
  f.viewport.dispatchEvent(new dom.window.Event('scroll'));
  await nextFrame();
}

test('虚拟列表: setItems 返回即有首屏行，spacer / transform / 区间同步就位', () => {
  const f = mounted(1000);
  assert.equal(f.content.childElementCount, WINDOW_ROWS);
  assert.equal(indexes(f.content), seq(0, WINDOW_ROWS));
  assert.equal(f.spacer.style.height, `${1000 * ROW_H}px`);
  assert.equal(f.content.style.transform, 'translateY(0px)');
  assert.equal(f.content.className, 'sfe-vlist-content sfe-test-list');
  assert.deepEqual(f.list.getRange(), { startIndex: 0, endIndex: WINDOW_ROWS, rowHeight: ROW_H });
  assert.deepEqual(f.ranges, [[0, WINDOW_ROWS]]);
  f.list.destroy();
});

test('虚拟列表: 向下滚动只删头补尾，窗口内的行保持同一 DOM 节点', async () => {
  const f = mounted(1000);
  const nodes = nodeByIndex(f);
  const builtBefore = f.built.length;
  await scrollTo(f, 10); // OVERSCAN 后窗口变为 [2, 48)
  const from = 2;
  const to = from + WINDOW_ROWS;
  assert.equal(indexes(f.content), seq(from, to), 'DOM 顺序须等于下标顺序');
  assert.equal(f.built.length, builtBefore + 2, '只应新建滑入的两行');
  assert.equal(f.content.firstElementChild, nodes.get(from), '留下的行须复用原节点');
  for (let i = from; i < WINDOW_ROWS; i++) assert.equal(f.content.children[i - from], nodes.get(i));
  assert.notEqual(f.content.lastElementChild, nodes.get(WINDOW_ROWS - 1));
  assert.equal(f.content.style.transform, `translateY(${from * ROW_H}px)`);
  assert.deepEqual(f.ranges.at(-1), [from, to]);
  f.list.destroy();
});

test('虚拟列表: 向上滚动把滑入行 prepend 到头部，DOM 顺序仍等于下标顺序', async () => {
  const f = mounted(1000);
  await scrollTo(f, 10);
  const nodes = nodeByIndex(f);
  const builtBefore = f.built.length;
  await scrollTo(f, 0);
  assert.equal(indexes(f.content), seq(0, WINDOW_ROWS));
  assert.equal(f.built.length, builtBefore + 2, '只应新建滑回头部的 0、1 两行');
  assert.equal(f.content.children[2], nodes.get(2), '留下的行不得重建');
  assert.equal(f.content.children[0], f.built.at(-2)!.node, '新行须插在头部且顺序正确');
  assert.equal(f.content.children[1], f.built.at(-1)!.node);
  assert.equal(f.content.style.transform, 'translateY(0px)');
  f.list.destroy();
});

test('虚拟列表: 滚动跨度大过整窗（新旧窗口无交集）时整窗重建', async () => {
  const f = mounted(1000);
  const builtBefore = f.built.length;
  await scrollTo(f, 200);
  const from = 192;
  assert.equal(indexes(f.content), seq(from, from + WINDOW_ROWS));
  assert.equal(f.built.length, builtBefore + WINDOW_ROWS, '无交集窗口没有一行可复用');
  assert.equal(f.content.style.transform, `translateY(${from * ROW_H}px)`);
  f.list.destroy();
});

test('虚拟列表: setItems 换数据后同下标不得复用旧行节点', () => {
  const f = mounted(100, 'row');
  const builtBefore = f.built.length;
  const oldNodes = [...f.content.children];
  f.list.setItems(Array.from({ length: 100 }, (_, i) => `next${i}`));
  assert.equal(f.built.length, builtBefore + WINDOW_ROWS, '换数据必须走整窗重建');
  assert.equal(
    [...f.content.children].map((c) => c.textContent).join(','),
    Array.from({ length: WINDOW_ROWS }, (_, i) => `next${i}`).join(','),
  );
  for (const node of [...f.content.children]) assert.ok(!oldNodes.includes(node), '旧行节点不得留在新窗口');
  f.list.destroy();
});

test('虚拟列表: refresh 整窗重建当前窗口（行内容依赖外部状态，如语法高亮到达）', () => {
  const f = mounted(1000);
  const builtBefore = f.built.length;
  const oldFirst = f.content.firstElementChild;
  f.list.refresh();
  assert.equal(f.built.length, builtBefore + WINDOW_ROWS);
  assert.notEqual(f.content.firstElementChild, oldFirst, '同区间也要重建，否则新的高亮上不了屏');
  assert.equal(indexes(f.content), seq(0, WINDOW_ROWS));
  assert.deepEqual(f.ranges, [[0, WINDOW_ROWS], [0, WINDOW_ROWS]]);
  f.list.destroy();
});

test('虚拟列表: scrollToIndex 同步滚到目标行，补行落到下一帧', async () => {
  const f = mounted(1000);
  const builtBefore = f.built.length;
  f.list.scrollToIndex(500);
  assert.equal(f.viewport.scrollTop, 500 * ROW_H, '滚动位置必须立即可读');
  assert.equal(f.built.length, builtBefore, '不得在写入的同一帧里回读布局并重建');
  assert.equal(indexes(f.content), seq(0, WINDOW_ROWS), '旧窗口原位保留，下一帧替换');
  await nextFrame();
  assert.equal(indexes(f.content), seq(492, 492 + WINDOW_ROWS));
  assert.equal(f.content.style.transform, `translateY(${492 * ROW_H}px)`);
  f.list.destroy();
});

test('虚拟列表: setRowHeight 同步撑开总高，窗口收敛落到下一帧', async () => {
  const f = mounted(1000);
  const builtBefore = f.built.length;
  f.list.setRowHeight(40);
  assert.equal(f.spacer.style.height, `${1000 * 40}px`, '总高度须立刻按新行高撑开');
  assert.equal(f.content.childElementCount, WINDOW_ROWS, '校准不得同步重建首屏行');
  await nextFrame();
  const rows = Math.ceil(600 / 40) + 8 * 2; // 行高 40 → 窗口 31 行
  assert.equal(indexes(f.content), seq(0, rows));
  assert.equal(f.built.length, builtBefore + rows, '行高变化时步长与跨度同时变，走整窗重建');
  assert.deepEqual(f.list.getRange(), { startIndex: 0, endIndex: rows, rowHeight: 40 });
  f.list.destroy();
});

test('虚拟列表: 区间未变的重复滚动早退，不新建也不改动 DOM', async () => {
  const f = mounted(1000);
  await scrollTo(f, 10);
  const builtBefore = f.built.length;
  const snapshot = [...f.content.children];
  f.viewport.dispatchEvent(new dom.window.Event('scroll'));
  await nextFrame();
  assert.equal(f.built.length, builtBefore, '同区间不得再建行');
  assert.deepEqual([...f.content.children], snapshot, '同区间不得改动 DOM');
  assert.equal(f.ranges.length, 2, 'onRangeChange 只在区间真变化时上报（首屏 + 一次滚动）');
  f.list.destroy();
});

test('虚拟列表: destroy 摘掉监听并移除内部节点，未落帧的滚动不再渲染', async () => {
  const f = mounted(1000);
  f.list.scrollToIndex(500); // 排了一帧待渲染
  f.list.destroy();
  assert.equal(f.viewport.childElementCount, 0, 'spacer 与 content 都应被移除');
  const builtBefore = f.built.length;
  f.viewport.dispatchEvent(new dom.window.Event('scroll'));
  await nextFrame();
  assert.equal(f.built.length, builtBefore, '销毁后监听与帧回调都不该再建行');
});

/** 记录元素上的 style 赋值（只记账，真实写入照常），用于检查读写先后顺序。 */
function watchStyleWrites(elem: HTMLElement, log: string[]): void {
  const wrapped = new Proxy(elem.style, {
    set: (target, prop, value) => {
      if (typeof prop === 'string') log.push('W');
      return Reflect.set(target, prop, value);
    },
  });
  Object.defineProperty(elem, 'style', { configurable: true, get: () => wrapped });
}

test('虚拟列表: 布局读数早于样式写入，不留「写完即读」的强制同步布局', async () => {
  const viewport = document.createElement('div');
  document.body.appendChild(viewport);
  const log: string[] = [];
  // clientHeight / scrollTop 定义在 Element.prototype 上，实例访问器遮住它们即可记录读数。
  const scrollDesc = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'scrollTop');
  const heightDesc = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'clientHeight');
  assert.ok(scrollDesc?.get && scrollDesc.set && heightDesc?.get, '前置条件：jsdom 以访问器提供布局读数');
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => {
      log.push('R');
      return (scrollDesc.get as () => number).call(viewport);
    },
    set: (value: number) => {
      log.push('W');
      (scrollDesc.set as (v: number) => void).call(viewport, value);
    },
  });
  Object.defineProperty(viewport, 'clientHeight', {
    configurable: true,
    get: () => {
      log.push('R');
      return (heightDesc.get as () => number).call(viewport);
    },
  });

  const list = createVirtualList<string>({
    viewport,
    rowHeight: ROW_H,
    renderRow: () => document.createElement('div'),
  });
  watchStyleWrites(viewport.querySelector<HTMLElement>('.sfe-vlist-spacer')!, log);
  watchStyleWrites(list.contentEl, log);

  list.setItems(Array.from({ length: 1000 }, (_, i) => String(i)));
  const firstWrite = log.indexOf('W');
  assert.ok(firstWrite > 0, 'setItems 应记录到读数与写入');
  // 首屏仍是同步出行的（下面两行节点），只是读数全部发生在写入之前。
  assert.ok(list.contentEl.childElementCount > 0, 'setItems 仍须同步渲染首屏行');
  assert.ok(!log.slice(firstWrite).includes('R'), '写完样式后不得再读布局');

  log.length = 0;
  list.scrollToIndex(500);
  assert.deepEqual(log, ['W'], 'scrollToIndex 写入后必须把渲染合到下一帧，不同帧回读');
  await nextFrame();
  // 落帧的那次渲染同样是「先读满、再写」，整帧只有一次布局失效。
  assert.deepEqual(log, ['W', 'R', 'R', 'W']);
  list.destroy();
});
