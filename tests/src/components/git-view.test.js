import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// 建立最小 DOM 环境后再导入渲染模块
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderGitCommitBar, renderGitList, renderGitSyncBar, resetGitSyncBar } = await import('../../../src/components/git-view.js');
const { createActionIcon } = await import('../../../src/icons/action-icons.js');

const t = (_key, fallback) => fallback || _key;

/** 构造一个最小可用选项对象 */
function makeOpts(overrides = {}) {
  return {
    gitStatus: { isRepo: true, files: [] },
    stagedCount: 0,
    selected: null,
    commitMessage: '',
    busy: null,
    generating: false,
    commitMode: 'commit',
    commitMenuOpen: false,
    collapsedStaged: new Set(),
    collapsedUnstaged: new Set(),
    onSelectFile: () => {},
    onSelectFolder: () => {},
    onStageToggle: () => {},
    onStageAll: () => {},
    onUnstageAll: () => {},
    onDiscard: () => {},
    onCommit: () => {},
    onCommitAndPush: () => {},
    onSetCommitMode: () => {},
    onToggleCommitMenu: () => {},
    onToggleCollapse: () => {},
    onGenerate: () => {},
    onCommitMessageInput: () => {},
    onOpenFile: () => {},
    onSync: () => {},
    onPull: () => {},
    onPush: () => {},
    syncBusy: null,
    branchBusy: null,
    loadBranches: async () => [],
    onCheckout: () => {},
    t,
    ...overrides,
  };
}

// 回归防护：宿主 git watcher 高频刷新时，提交输入框绝不能被重建。
// 早期实现每次 render() 都整体 replaceChildren 重建 DOM，导致输入框被反复抢焦点、
// 右键菜单/键盘操作被打断、文本选区被销毁（用户报的 bug 1 与 bug 4）。
test('Git 提交框: 重复渲染复用同一 textarea 节点（不重建，保住焦点与选区）', () => {
  const pane = document.createElement('div');
  renderGitCommitBar(pane, makeOpts({ commitMessage: 'first' }));
  const ta1 = pane.querySelector('.sfe-git-commit-input');
  assert.ok(ta1, '应渲染提交输入框');
  assert.equal(ta1.value, 'first');

  // 模拟一次 git 状态刷新触发的重绘
  renderGitCommitBar(pane, makeOpts({ commitMessage: 'first', busy: 'stage' }));
  const ta2 = pane.querySelector('.sfe-git-commit-input');
  assert.equal(ta1, ta2, '刷新后必须是同一个 DOM 节点（不得重建）');
  // 提交框应始终是面板的第一个子节点（列表在其后）
  assert.equal(pane.firstChild, pane.querySelector('.sfe-git-commit'));
});

test('Git 提交框: 输入框聚焦时外部状态值不覆盖用户正在编辑的内容', () => {
  const pane = document.createElement('div');
  document.body.appendChild(pane);
  renderGitCommitBar(pane, makeOpts({ commitMessage: 'user typing' }));
  const ta = pane.querySelector('.sfe-git-commit-input');
  ta.focus();
  ta.value = 'user editing now';

  // 外部 state 仍是旧值（流式生成期间会走到这里）
  renderGitCommitBar(pane, makeOpts({ commitMessage: 'user typing' }));
  assert.equal(ta.value, 'user editing now', '聚焦时不得覆盖用户输入');

  // 失焦后允许同步外部值
  ta.blur();
  renderGitCommitBar(pane, makeOpts({ commitMessage: 'synced' }));
  assert.equal(ta.value, 'synced', '失焦后应同步外部值');
  document.body.removeChild(pane);
});

test('Git 提交框: 按钮可用性随暂存数与忙碌态更新', () => {
  const pane = document.createElement('div');
  renderGitCommitBar(pane, makeOpts({ commitMessage: 'msg', stagedCount: 1, busy: null }));
  const primary = pane.querySelector('.sfe-git-commit-btn');
  const ai = pane.querySelector('.sfe-git-ai-btn');
  assert.equal(primary.disabled, false, '有暂存文件且有信息时应可提交');
  assert.equal(ai.disabled, false);

  // 无暂存文件 → 两个按钮都禁用
  renderGitCommitBar(pane, makeOpts({ commitMessage: 'msg', stagedCount: 0 }));
  assert.equal(primary.disabled, true);
  assert.equal(ai.disabled, true);

  // 忙碌态 → 禁用
  renderGitCommitBar(pane, makeOpts({ commitMessage: 'msg', stagedCount: 1, busy: 'commit' }));
  assert.equal(primary.disabled, true);
  assert.equal(ai.disabled, true);
});

test('Git 提交框: 提交按钮按模式分流到 onCommit / onCommitAndPush', () => {
  const pane = document.createElement('div');
  const calls = [];
  const opts = makeOpts({
    commitMessage: 'msg',
    stagedCount: 1,
    onCommit: () => calls.push('commit'),
    onCommitAndPush: () => calls.push('push'),
  });
  renderGitCommitBar(pane, opts);
  pane.querySelector('.sfe-git-commit-btn').click();
  assert.deepEqual(calls, ['commit']);

  renderGitCommitBar(pane, { ...opts, commitMode: 'commitAndPush' });
  pane.querySelector('.sfe-git-commit-btn').click();
  assert.deepEqual(calls, ['commit', 'push']);
});

test('Git 变更列表: 分区渲染、目录树行与就地选中不重建', () => {
  const pane = document.createElement('div');
  renderGitCommitBar(pane, makeOpts());
  renderGitList(pane, makeOpts({
    gitStatus: {
      isRepo: true,
      files: [
        { path: 'src/a.js', status: 'M', indexStatus: 'M', workdirStatus: ' ' },
        { path: 'README.md', status: 'U', indexStatus: '?', workdirStatus: '?' },
      ],
    },
  }));

  const scroll1 = pane.querySelector('.sfe-git-scroll');
  assert.ok(scroll1, '应渲染列表滚动容器');
  const sections = pane.querySelectorAll('.sfe-git-section');
  assert.equal(sections.length, 2, '应渲染「已暂存」与「变更」两个分区');
  assert.ok(pane.querySelector('.sfe-git-row'), '应渲染文件行');
  assert.ok(pane.querySelector('.sfe-git-folder-row'), 'src/a.js 应渲染出目录行');

  // 再次渲染列表：滚动容器本身保留（滚动位置不丢），仅内部内容重建
  renderGitList(pane, makeOpts({
    gitStatus: { isRepo: true, files: [{ path: 'src/a.js', status: 'M', indexStatus: 'M', workdirStatus: ' ' }] },
  }));
  const scroll2 = pane.querySelector('.sfe-git-scroll');
  assert.equal(scroll1, scroll2, '列表刷新应复用滚动容器');
});

test('Git 变更列表: 非仓库/加载中显示空态', () => {
  const pane = document.createElement('div');
  renderGitList(pane, makeOpts({ gitStatus: null }));
  assert.match(pane.textContent, /加载中/);

  renderGitList(pane, makeOpts({ gitStatus: { isRepo: false, files: [] } }));
  assert.match(pane.textContent, /不是 Git 仓库/);
});

test('Git 变更列表: 单击文件行即打开差异，行内按钮不误触发', () => {
  const pane = document.createElement('div');
  document.body.appendChild(pane);
  const calls = [];
  renderGitList(pane, makeOpts({
    gitStatus: {
      isRepo: true,
      files: [{ path: 'a.js', status: 'M', indexStatus: ' ', workdirStatus: 'M' }],
    },
    onSelectFile: (file, section) => calls.push(['select', file.path, section]),
    onOpenFile: (file, section) => calls.push(['open', file.path, section]),
  }));

  const row = pane.querySelector('.sfe-git-row');
  row.click();
  assert.deepEqual(
    calls,
    [['select', 'a.js', 'unstaged'], ['open', 'a.js', 'unstaged']],
    '单击应同时选中并打开差异'
  );
  assert.ok(row.classList.contains('selected'), '单击后行应为选中态');

  // 行内暂存按钮 stopPropagation：不得连带触发行选中/打开
  calls.length = 0;
  pane.querySelector('.sfe-git-row-btn.stage-toggle').click();
  assert.deepEqual(calls, [], '行内按钮不得触发行打开');

  document.body.removeChild(pane);
});

test('Git 变更列表: 文件右键菜单复刻宿主顺序并排除终端入口', () => {
  const pane = document.createElement('div');
  document.body.appendChild(pane);
  const calls = [];
  const file = { path: 'src/a.js', status: 'M', indexStatus: ' ', workdirStatus: 'M' };
  renderGitList(pane, makeOpts({
    gitStatus: { isRepo: true, files: [file] },
    onOpenFile: (entry, section) => calls.push(['open', entry.path, section]),
    onRevealFile: (entry) => calls.push(['reveal', entry.path]),
    onStageToggle: (entries, section) => calls.push(['stage', entries.map((entry) => entry.path), section]),
    onDiscard: (entries) => calls.push(['discard', entries.map((entry) => entry.path)]),
    onCopyRelativePath: (entry) => calls.push(['copy-relative', entry.path]),
    onCopyAbsolutePath: (entry) => calls.push(['copy-absolute', entry.path]),
  }));

  const row = pane.querySelector('.sfe-git-row:not(.sfe-git-folder-row)');
  row.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 24,
    clientY: 32,
  }));
  const menu = pane.querySelector('.sfe-git-context-menu');
  assert.ok(menu, '右键文件行应显示 Git 菜单');
  assert.deepEqual(
    [...menu.querySelectorAll('button')].map((item) => item.dataset.menuId),
    ['open', 'reveal', 'stage-toggle', 'discard', 'copy-relative', 'copy-absolute'],
    '菜单项顺序必须与宿主文件菜单一致（去除终端项）',
  );
  assert.equal(menu.querySelectorAll('.sfe-context-menu-separator').length, 2, '应保留宿主两条分隔线');
  assert.doesNotMatch(menu.textContent, /终端|Terminal/i, '菜单不得包含在终端打开');

  menu.querySelector('[data-menu-id="stage-toggle"]').click();
  assert.deepEqual(calls, [['stage', ['src/a.js'], 'unstaged']], '暂存项应传入当前文件和当前分区');

  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 32 }));
  pane.querySelector('[data-menu-id="discard"]').click();
  assert.deepEqual(calls.at(-1), ['discard', ['src/a.js']], '丢弃项应传入当前文件');

  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 32 }));
  pane.querySelector('[data-menu-id="open"]').click();
  assert.deepEqual(calls.at(-1), ['open', 'src/a.js', 'unstaged']);

  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 32 }));
  pane.querySelector('[data-menu-id="reveal"]').click();
  assert.deepEqual(calls.at(-1), ['reveal', 'src/a.js']);

  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 32 }));
  pane.querySelector('[data-menu-id="copy-relative"]').click();
  assert.deepEqual(calls.at(-1), ['copy-relative', 'src/a.js']);

  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 32 }));
  pane.querySelector('[data-menu-id="copy-absolute"]').click();
  assert.deepEqual(calls.at(-1), ['copy-absolute', 'src/a.js']);
  document.body.removeChild(pane);
});

test('Git 变更列表: 删除文件禁用打开和资源管理器菜单，但保留 Git 操作', () => {
  const pane = document.createElement('div');
  document.body.appendChild(pane);
  const file = { path: 'deleted.js', status: 'D', indexStatus: ' ', workdirStatus: 'D' };
  renderGitList(pane, makeOpts({
    gitStatus: { isRepo: true, files: [file] },
    onRevealFile: () => {},
    onCopyRelativePath: () => {},
    onCopyAbsolutePath: () => {},
  }));
  const row = pane.querySelector('.sfe-git-row');
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 32 }));
  assert.equal(pane.querySelector('[data-menu-id="open"]').disabled, true);
  assert.equal(pane.querySelector('[data-menu-id="reveal"]').disabled, true);
  assert.equal(pane.querySelector('[data-menu-id="stage-toggle"]').disabled, false);
  assert.equal(pane.querySelector('[data-menu-id="copy-relative"]').disabled, false);
  document.body.removeChild(pane);
});

test('Git 变更列表: 文件菜单支持点击外部和 Escape 关闭', () => {
  const pane = document.createElement('div');
  document.body.appendChild(pane);
  renderGitList(pane, makeOpts({
    gitStatus: { isRepo: true, files: [{ path: 'a.js', status: 'M', indexStatus: ' ', workdirStatus: 'M' }] },
  }));
  const row = pane.querySelector('.sfe-git-row');
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 32 }));
  assert.ok(pane.querySelector('.sfe-git-context-menu'));
  document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(pane.querySelector('.sfe-git-context-menu'), null, '点击菜单外部应关闭');

  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 32 }));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(pane.querySelector('.sfe-git-context-menu'), null, 'Escape 应关闭菜单');
  document.body.removeChild(pane);
});

// 选中常显的前提：列表即便被重建，也要按 state.gitSelected 恢复 .selected，
// 否则 watcher 触发重建后行内按钮会退回「仅 hover 可见」。
test('Git 变更列表: 重建后按 selected 恢复选中行与行内按钮', () => {
  const pane = document.createElement('div');
  const files = [{ path: 'a.js', status: 'M', indexStatus: ' ', workdirStatus: 'M' }];

  renderGitList(pane, makeOpts({ gitStatus: { isRepo: true, files } }));
  assert.equal(pane.querySelector('.sfe-git-row.selected'), null, '未选中时不应有选中行');

  // 用户已点击该文件（state.gitSelected 记录为 `unstaged:a.js`），列表重建
  renderGitList(pane, makeOpts({ gitStatus: { isRepo: true, files }, selected: 'unstaged:a.js' }));
  const row = pane.querySelector('.sfe-git-row.selected');
  assert.ok(row, '重建后必须按 selected 恢复选中态');
  assert.ok(row.querySelector('.sfe-git-row-btn.stage-toggle'), '选中行须含行内操作按钮（CSS 依据 .selected 使其常显）');
});

// 目录行此前只 hover 才显示加号（点击只折叠、不选中）。点击后应同时选中并折叠，
// 选中态经 .selected 使加号常显。
test('Git 变更列表: 单击文件夹行即选中并折叠，加号随之常显', () => {
  const pane = document.createElement('div');
  document.body.appendChild(pane);
  const calls = [];
  renderGitList(pane, makeOpts({
    gitStatus: { isRepo: true, files: [{ path: 'src/a.js', status: 'M', indexStatus: ' ', workdirStatus: 'M' }] },
    onSelectFolder: (node, section) => calls.push(['selectFolder', node.path, section]),
    onToggleCollapse: (section, path) => calls.push(['collapse', section, path]),
  }));

  const folder = pane.querySelector('.sfe-git-folder-row');
  assert.ok(folder, '应渲染目录行');
  assert.ok(folder.querySelector('.sfe-git-row-btn.stage-toggle'), '目录行须含暂存按钮');
  folder.click();
  assert.deepEqual(
    calls,
    [['selectFolder', 'src', 'unstaged'], ['collapse', 'unstaged', 'src']],
    '单击应同时选中目录并触发折叠'
  );
  assert.ok(folder.classList.contains('selected'), '单击后目录行应为选中态（CSS 使其加号常显）');
  document.body.removeChild(pane);
});

test('Git 变更列表: 重建后按 selected 恢复文件夹行选中', () => {
  const pane = document.createElement('div');
  const files = [{ path: 'src/a.js', status: 'M', indexStatus: ' ', workdirStatus: 'M' }];
  renderGitList(pane, makeOpts({ gitStatus: { isRepo: true, files }, selected: 'unstaged:src' }));
  const folder = pane.querySelector('.sfe-git-folder-row.selected');
  assert.ok(folder, '重建后必须按 selected 恢复目录行选中态');
  assert.ok(folder.querySelector('.sfe-git-row-btn.stage-toggle'), '选中目录行须含加号按钮');
});

// 底部同步栏（对标 VS Code SCM 视图底部）：Git 同步按钮 + ↓未拉取 / ↑未推送。
// 同步按钮执行远端 pull / 本地 push；计数为 0 时灰显且点击无效，非仓库时隐藏计数区。
test('Git 同步栏: 计数始终显示，0 加 .zero、>0 去 .zero，非仓库隐藏计数区', () => {
  const pane = document.createElement('div');
  renderGitSyncBar(pane, makeOpts({
    gitStatus: { isRepo: true, ahead: 2, behind: 1, files: [] },
  }));
  const bar = pane.querySelector('.sfe-git-sync');
  assert.ok(bar, '应渲染底部同步栏');
  const ahead = bar.querySelector('.sfe-git-sync-count[data-sync="ahead"]');
  const behind = bar.querySelector('.sfe-git-sync-count[data-sync="behind"]');
  assert.equal(ahead.hidden, false, '↑ 计数始终显示');
  assert.equal(ahead.querySelector('.sfe-git-sync-value').textContent, '2');
  assert.ok(!ahead.classList.contains('zero'), '有未推送时 ↑ 不应为灰色');
  assert.equal(behind.hidden, false, '↓ 计数始终显示');
  assert.equal(behind.querySelector('.sfe-git-sync-value').textContent, '1');
  assert.ok(!behind.classList.contains('zero'), '有未拉取时 ↓ 不应为灰色');

  // 全部归零 → 计数仍显示（数字 0），但标记为灰色
  renderGitSyncBar(pane, makeOpts({ gitStatus: { isRepo: true, ahead: 0, behind: 0, files: [] } }));
  assert.equal(ahead.hidden, false, '为 0 时 ↑ 仍显示');
  assert.equal(ahead.querySelector('.sfe-git-sync-value').textContent, '0', '为 0 时显示 0');
  assert.ok(ahead.classList.contains('zero'), '为 0 时 ↑ 应为灰色');
  assert.ok(behind.classList.contains('zero'), '为 0 时 ↓ 应为灰色');
  assert.ok(pane.querySelector('.sfe-git-sync-btn'), '同步按钮始终存在');

  // 非仓库 → 计数区整块隐藏
  renderGitSyncBar(pane, makeOpts({ gitStatus: { isRepo: false, files: [] } }));
  assert.equal(pane.querySelector('.sfe-git-sync-counts').hidden, true, '非仓库时隐藏计数区');
});

test('Git 同步栏: 结构复用不重建，计数就地更新', () => {
  const pane = document.createElement('div');
  renderGitSyncBar(pane, makeOpts({ gitStatus: { isRepo: true, ahead: 1, behind: 0, files: [] } }));
  const bar1 = pane.querySelector('.sfe-git-sync');
  const ahead1 = pane.querySelector('.sfe-git-sync-count[data-sync="ahead"]');
  renderGitSyncBar(pane, makeOpts({ gitStatus: { isRepo: true, ahead: 3, behind: 0, files: [] } }));
  assert.equal(pane.querySelector('.sfe-git-sync'), bar1, '重复渲染必须复用同一同步栏节点');
  assert.equal(pane.querySelector('.sfe-git-sync-count[data-sync="ahead"]'), ahead1, '计数项节点不重建');
  assert.equal(ahead1.querySelector('.sfe-git-sync-value').textContent, '3', '计数就地更新');
});

test('Git 同步栏: 点击 ↓ 拉取、↑ 推送，为 0 时不触发', () => {
  const pane = document.createElement('div');
  document.body.appendChild(pane);
  const calls = [];
  const opts = makeOpts({
    gitStatus: { isRepo: true, ahead: 1, behind: 2, files: [] },
    onPull: () => calls.push('pull'),
    onPush: () => calls.push('push'),
  });
  renderGitSyncBar(pane, opts);
  const behind = pane.querySelector('.sfe-git-sync-count[data-sync="behind"]');
  const ahead = pane.querySelector('.sfe-git-sync-count[data-sync="ahead"]');
  behind.click();
  ahead.click();
  assert.deepEqual(calls, ['pull', 'push'], '有待同步提交时点击 ↓/↑ 应分别触发拉取/推送');

  // 归零后（灰色）点击不应触发，避免无意义的空拉/空推
  calls.length = 0;
  renderGitSyncBar(pane, { ...opts, gitStatus: { isRepo: true, ahead: 0, behind: 0, files: [] } });
  behind.click();
  ahead.click();
  assert.deepEqual(calls, [], '为 0 时点击 ↓/↑ 不应触发');
  document.body.removeChild(pane);
});

// <span> 没有 disabled IDL 属性，忙碌态须用 class 标记（此前误用 item.disabled 导致永不生效）。
test('Git 同步栏: 忙碌态禁用同步按钮并标记 ↓ 计数，空闲后恢复', () => {
  const pane = document.createElement('div');
  renderGitSyncBar(pane, makeOpts({
    gitStatus: { isRepo: true, ahead: 1, behind: 1, files: [] },
    busy: 'pull',
  }));
  assert.equal(pane.querySelector('.sfe-git-sync-btn').disabled, true, '忙碌时同步按钮应禁用');
  const behind = pane.querySelector('.sfe-git-sync-count[data-sync="behind"]');
  assert.ok(behind.classList.contains('is-disabled'), '忙碌时 ↓ 计数应标记禁用');
  assert.ok(behind.classList.contains('pulling'), '拉取时 ↓ 箭头应播放向下动效');
  const ahead = pane.querySelector('.sfe-git-sync-count[data-sync="ahead"]');
  assert.ok(!ahead.classList.contains('pushing'), '拉取时 ↑ 箭头不应播放推送动效');

  renderGitSyncBar(pane, makeOpts({
    gitStatus: { isRepo: true, ahead: 1, behind: 1, files: [] },
    busy: 'push',
  }));
  assert.ok(ahead.classList.contains('pushing'), '推送时 ↑ 箭头应播放向上动效');
  assert.ok(!behind.classList.contains('pulling'), '推送时 ↓ 箭头不应播放拉取动效');

  renderGitSyncBar(pane, makeOpts({ gitStatus: { isRepo: true, ahead: 1, behind: 1, files: [] }, busy: null }));
  assert.equal(pane.querySelector('.sfe-git-sync-btn').disabled, false, '空闲后同步按钮恢复');
  assert.ok(!behind.classList.contains('is-disabled'), '空闲后 ↓ 计数移除禁用标记');
  assert.ok(!behind.classList.contains('pulling'), '空闲后移除 ↓ 动效');
  assert.ok(!ahead.classList.contains('pushing'), '空闲后移除 ↑ 动效');
});

test('Git 同步栏: 同步进行中按钮播放上下方向动画，结束后停止', () => {
  const pane = document.createElement('div');
  const btn = () => pane.querySelector('.sfe-git-sync-btn');
  renderGitSyncBar(pane, makeOpts({ gitStatus: { isRepo: true, files: [] }, syncBusy: null }));
  const sync = btn();
  assert.equal(sync.title, '同步', '按钮标题必须表达同步而不是刷新');
  assert.equal(sync.querySelector('svg').outerHTML, createActionIcon('sync', 13).outerHTML, '按钮必须使用双向同步图标');

  renderGitSyncBar(pane, makeOpts({ gitStatus: { isRepo: true, files: [] }, syncBusy: true }));
  assert.ok(btn().classList.contains('syncing'), '同步进行中应加 .syncing');
  assert.equal(btn().disabled, true, '同步进行中按钮禁用');

  renderGitSyncBar(pane, makeOpts({ gitStatus: { isRepo: true, files: [] }, syncBusy: null }));
  assert.ok(!btn().classList.contains('syncing'), '同步结束后移除 .syncing');
  assert.equal(btn().disabled, false, '同步结束后恢复可用');
});

// 分支下拉：显示当前分支，点击展开列表（当前分支置顶、禁用，远程分支标注）
test('Git 同步栏: 显示当前分支，点击展开分支列表并可切换', async () => {
  const pane = document.createElement('div');
  document.body.appendChild(pane);
  const checked = [];
  renderGitSyncBar(pane, makeOpts({
    gitStatus: { isRepo: true, currentBranch: 'main', files: [] },
    loadBranches: async () => [
      { name: 'main', isCurrent: true, isRemote: false, remoteName: null },
      { name: 'feature', isCurrent: false, isRemote: false, remoteName: null },
      { name: 'origin/dev', isCurrent: false, isRemote: true, remoteName: 'origin' },
    ],
    onCheckout: (b) => checked.push(b.name),
  }));

  const branchBtn = pane.querySelector('.sfe-git-branch-btn');
  assert.ok(branchBtn, '应渲染分支按钮');
  assert.equal(branchBtn.querySelector('.sfe-git-branch-name').textContent, 'main', '显示当前分支名');

  // 点击展开：异步填充分支列表
  branchBtn.click();
  await new Promise((r) => setTimeout(r, 0));
  const items = pane.querySelectorAll('.sfe-git-branch-item');
  assert.equal(items.length, 3, '应列出全部分支');
  const current = pane.querySelector('.sfe-git-branch-item.current');
  assert.ok(current, '当前分支应有 current 标记');
  assert.equal(current.disabled, true, '当前分支不可点击切换');

  // 点击其它分支 → 触发 onCheckout 并收起下拉
  const feature = [...items].find((el) => el.textContent.includes('feature'));
  feature.click();
  assert.deepEqual(checked, ['feature'], '点击分支应触发 onCheckout');
  assert.equal(pane.querySelector('.sfe-git-branch-menu'), null, '选择后应收起下拉');
  document.body.removeChild(pane);
});

test('Git 同步栏: 非仓库或忙碌时分支按钮禁用', () => {
  const pane = document.createElement('div');
  const btn = () => pane.querySelector('.sfe-git-branch-btn');
  renderGitSyncBar(pane, makeOpts({ gitStatus: { isRepo: false, files: [] } }));
  assert.equal(btn().disabled, true, '非仓库时分支按钮禁用');
  renderGitSyncBar(pane, makeOpts({ gitStatus: { isRepo: true, currentBranch: 'main', files: [] }, busy: 'commit' }));
  assert.equal(btn().disabled, true, '忙碌时分支按钮禁用');
  renderGitSyncBar(pane, makeOpts({ gitStatus: { isRepo: true, currentBranch: 'main', files: [] }, branchBusy: 'dev' }));
  assert.equal(btn().disabled, true, '切换分支进行中分支按钮禁用');
});

// 视图切换会清空主视图，底栏虽常驻但需重置骨架，避免复用已脱离文档的分支下拉节点
test('Git 同步栏: resetGitSyncBar 移除旧骨架，再次渲染重建', () => {
  const pane = document.createElement('div');
  renderGitSyncBar(pane, makeOpts({ gitStatus: { isRepo: true, currentBranch: 'main', files: [] } }));
  const first = pane.querySelector('.sfe-git-sync');
  resetGitSyncBar(pane);
  assert.equal(pane.querySelector('.sfe-git-sync'), null, '重置后应移除同步栏');
  renderGitSyncBar(pane, makeOpts({ gitStatus: { isRepo: true, currentBranch: 'main', files: [] } }));
  assert.notEqual(pane.querySelector('.sfe-git-sync'), first, '应重建为新的同步栏节点');
});

// 契约：计数区显隐由 gitStatus 驱动，且结构复用时必须能双向切换。
// 底栏常驻 layout、节点只建一次，若 hidden 只能置 true 不能置 false，
// 一旦先以「非仓库」渲染过，之后回到仓库就再也看不到计数（用户报的「0 没显示」）。
test('Git 同步栏: 计数区从隐藏（非仓库）恢复为显示（仓库 0）', () => {
  const pane = document.createElement('div');
  const counts = () => pane.querySelector('.sfe-git-sync-counts');
  const value = (key) => pane.querySelector(`.sfe-git-sync-count[data-sync="${key}"] .sfe-git-sync-value`).textContent;

  renderGitSyncBar(pane, makeOpts({ gitStatus: null }));
  assert.equal(counts().hidden, true, 'gitStatus 为空时隐藏计数区');

  renderGitSyncBar(pane, makeOpts({ gitStatus: { isRepo: false, files: [] } }));
  assert.equal(counts().hidden, true, '非仓库时隐藏计数区');

  renderGitSyncBar(pane, makeOpts({ gitStatus: { isRepo: true, currentBranch: 'main', ahead: 0, behind: 0, files: [] } }));
  assert.equal(counts().hidden, false, '回到仓库后计数区必须恢复显示');
  assert.equal(value('ahead'), '0', '↑ 计数写入 0');
  assert.equal(value('behind'), '0', '↓ 计数写入 0');
  assert.equal(pane.querySelector('.sfe-git-branch-name').textContent, 'main', '分支名同步为当前分支');
});

// 契约：同步计数箭头必须与「未拉取=↓ / 未推送=↑」一致。
// createActionIcon 对未注册的图标键会静默回退成 ChevronRight，曾导致「上下箭头」
// 实际渲染成向右的 chevron（用户报的「箭头不是上下是左右」）。这里用运行时生成的
// 参考图标比对，而非硬编码 path，升级 lucide 后断言依然有效。
test('Git 同步栏: 未拉取用向下箭头、未推送用向上箭头（防止图标键回退）', () => {
  const pane = document.createElement('div');
  renderGitSyncBar(pane, makeOpts({ gitStatus: { isRepo: true, ahead: 1, behind: 1, files: [] } }));

  const svgOf = (key) => pane.querySelector(`.sfe-git-sync-count[data-sync="${key}"] svg`);
  const expect = (icon) => createActionIcon(icon, 12).outerHTML;

  assert.equal(svgOf('behind').outerHTML, expect('arrowDown'), '未拉取（↓）必须使用 ArrowDown');
  assert.equal(svgOf('ahead').outerHTML, expect('arrowUp'), '未推送（↑）必须使用 ArrowUp');
});
