import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { GitSection, GitViewOptions } from '../../../src/components/git-view.ts';
import type { TranslateFn } from '../../../src/types/panel-state.ts';
import type { GitFileStatus, GitStatusResult } from '../../../src/types/host/host-git.ts';

// 建立最小 DOM 环境后再导入渲染模块
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderGitCommitBar, renderGitList } = await import('../../../src/components/git-view.ts');

/** 翻译桩：只用到 key + 兜底文案，签名复用组件消费的 TranslateFn。 */
const t: TranslateFn = (_key, fallback) => fallback || _key;

/** 变更文件桩入参：GitFileStatus 的五个字段里只有 oldPath 可缺。 */
type GitFileStubInput = {
  /** 相对仓库根的文件路径（正斜杠）。 */
  path: string;
  /** 综合状态字母（M / U / A / D / R…），宿主 git status 的 `status` 字段。 */
  status: string;
  /** 索引区状态字母；空格表示索引区无变更。 */
  indexStatus: string;
  /** 工作区状态字母；空格或 `?` 之外表示工作区有变更。 */
  workdirStatus: string;
  /** 重命名前的旧路径；非重命名恒为 null，缺省按 null 补。 */
  oldPath?: string | null;
};

/** 构造 GitFileStatus 桩（补齐宿主必填的 oldPath，其余字段原样透传）。 */
function gitFile(input: GitFileStubInput): GitFileStatus {
  return {
    path: input.path,
    oldPath: input.oldPath ?? null,
    indexStatus: input.indexStatus,
    workdirStatus: input.workdirStatus,
    status: input.status,
  };
}

/** 仓库状态桩入参：组件只读 isRepo 与 files（见 git-view.ts 的 renderGitList），其余字段给中性值。 */
type GitStatusStubInput = {
  /** 是否 git 仓库；缺省 true（用例大多在测有变更的仓库）。 */
  isRepo?: boolean;
  /** 变更文件清单；缺省空数组。 */
  files?: GitFileStatus[];
};

/** 构造 GitStatusResult 桩（宿主 `gitStatus()` 的返回形状，字段全部必填）。 */
function gitStatus({ isRepo = true, files = [] }: GitStatusStubInput = {}): GitStatusResult {
  return {
    isRepo,
    currentBranch: 'main',
    upstream: null,
    ahead: 0,
    behind: 0,
    files,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    statusLimitHit: false,
  };
}

/**
 * 构造一个最小可用选项对象。
 * @description 字段集严格按 GitViewOptions（= index.ts 的 gitViewOptions() 真实入参）。
 *   原桩里的 syncBusy / branchBusy / loadBranches / onCheckout / onSync / onPull / onPush
 *   既不在 GitViewOptions 里，也不被组件与 index.ts 消费（分支切换早已从 Git 面板移除），故删掉。
 */
function makeOpts(overrides: Partial<GitViewOptions> = {}): GitViewOptions {
  return {
    gitStatus: gitStatus(),
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
    t,
    ...overrides,
  };
}

/**
 * 取容器内必然存在的元素。
 * !: 元素缺失即组件没渲染该控件（用例随后直接解引用，运行时同样会抛 TypeError），
 *   故在唯一的查询出口收窄一次非空，不改变运行时行为。
 */
const q = <T extends Element>(parent: ParentNode, selector: string): T => parent.querySelector<T>(selector)!;

// 回归防护：宿主 git watcher 高频刷新时，提交输入框绝不能被重建。
// 早期实现每次 render() 都整体 replaceChildren 重建 DOM，导致输入框被反复抢焦点、
// 右键菜单/键盘操作被打断、文本选区被销毁（用户报的 bug 1 与 bug 4）。
test('Git 提交框: 重复渲染复用同一 textarea 节点（不重建，保住焦点与选区）', () => {
  const pane = document.createElement('div');
  renderGitCommitBar(pane, makeOpts({ commitMessage: 'first' }));
  const ta1 = pane.querySelector<HTMLTextAreaElement>('.sfe-git-commit-input');
  assert.ok(ta1, '应渲染提交输入框');
  assert.equal(ta1.value, 'first');

  // 模拟一次 git 状态刷新触发的重绘
  renderGitCommitBar(pane, makeOpts({ commitMessage: 'first', busy: 'stage' }));
  const ta2 = pane.querySelector<HTMLTextAreaElement>('.sfe-git-commit-input');
  assert.equal(ta1, ta2, '刷新后必须是同一个 DOM 节点（不得重建）');
  // 提交框应始终是面板的第一个子节点（列表在其后）
  assert.equal(pane.firstChild, pane.querySelector('.sfe-git-commit'));
});

test('Git 提交框: 输入框聚焦时外部状态值不覆盖用户正在编辑的内容', () => {
  const pane = document.createElement('div');
  document.body.appendChild(pane);
  renderGitCommitBar(pane, makeOpts({ commitMessage: 'user typing' }));
  const ta = q<HTMLTextAreaElement>(pane, '.sfe-git-commit-input');
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
  const primary = q<HTMLButtonElement>(pane, '.sfe-git-commit-btn');
  const ai = q<HTMLButtonElement>(pane, '.sfe-git-ai-btn');
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
  const calls: string[] = [];
  const opts = makeOpts({
    commitMessage: 'msg',
    stagedCount: 1,
    onCommit: () => calls.push('commit'),
    onCommitAndPush: () => calls.push('push'),
  });
  renderGitCommitBar(pane, opts);
  q<HTMLButtonElement>(pane, '.sfe-git-commit-btn').click();
  assert.deepEqual(calls, ['commit']);

  renderGitCommitBar(pane, { ...opts, commitMode: 'commitAndPush' });
  q<HTMLButtonElement>(pane, '.sfe-git-commit-btn').click();
  assert.deepEqual(calls, ['commit', 'push']);
});

test('Git 变更列表: 分区渲染、目录树行与就地选中不重建', () => {
  const pane = document.createElement('div');
  renderGitCommitBar(pane, makeOpts());
  renderGitList(pane, makeOpts({
    gitStatus: gitStatus({
      isRepo: true,
      files: [
        gitFile({ path: 'src/a.js', status: 'M', indexStatus: 'M', workdirStatus: ' ' }),
        gitFile({ path: 'README.md', status: 'U', indexStatus: '?', workdirStatus: '?' }),
      ],
    }),
  }));

  const scroll1 = pane.querySelector('.sfe-git-scroll');
  assert.ok(scroll1, '应渲染列表滚动容器');
  const sections = pane.querySelectorAll('.sfe-git-section');
  assert.equal(sections.length, 2, '应渲染「已暂存」与「变更」两个分区');
  assert.ok(pane.querySelector('.sfe-git-row'), '应渲染文件行');
  assert.ok(pane.querySelector('.sfe-git-folder-row'), 'src/a.js 应渲染出目录行');

  // 再次渲染列表：滚动容器本身保留（滚动位置不丢），仅内部内容重建
  renderGitList(pane, makeOpts({
    gitStatus: gitStatus({ isRepo: true, files: [gitFile({ path: 'src/a.js', status: 'M', indexStatus: 'M', workdirStatus: ' ' })] }),
  }));
  const scroll2 = pane.querySelector('.sfe-git-scroll');
  assert.equal(scroll1, scroll2, '列表刷新应复用滚动容器');
});

test('Git 变更列表: 非仓库/加载中显示空态', () => {
  const pane = document.createElement('div');
  renderGitList(pane, makeOpts({ gitStatus: null }));
  assert.match(pane.textContent, /加载中/);

  renderGitList(pane, makeOpts({ gitStatus: gitStatus({ isRepo: false, files: [] }) }));
  assert.match(pane.textContent, /不是 Git 仓库/);
});

/** 文件行单击记录：`[动作, 文件路径, 分区]`（select 与 open 同形）。 */
type RowClickCall = ["select", string, GitSection] | ["open", string, GitSection];

test('Git 变更列表: 单击文件行即打开差异，行内按钮不误触发', () => {
  const pane = document.createElement('div');
  document.body.appendChild(pane);
  const calls: RowClickCall[] = [];
  renderGitList(pane, makeOpts({
    gitStatus: gitStatus({
      isRepo: true,
      files: [gitFile({ path: 'a.js', status: 'M', indexStatus: ' ', workdirStatus: 'M' })],
    }),
    onSelectFile: (file, section) => calls.push(['select', file.path, section]),
    onOpenFile: (file, section) => calls.push(['open', file.path, section]),
  }));

  const row = q<HTMLElement>(pane, '.sfe-git-row');
  row.click();
  assert.deepEqual(
    calls,
    [['select', 'a.js', 'unstaged'], ['open', 'a.js', 'unstaged']],
    '单击应同时选中并打开差异'
  );
  assert.ok(row.classList.contains('selected'), '单击后行应为选中态');

  // 行内暂存按钮 stopPropagation：不得连带触发行选中/打开
  calls.length = 0;
  q<HTMLButtonElement>(pane, '.sfe-git-row-btn.stage-toggle').click();
  assert.deepEqual(calls, [], '行内按钮不得触发行打开');

  document.body.removeChild(pane);
});

/** 文件行右键菜单记录的动作；元组首项是动作名，其余是该动作的入参。 */
type RowMenuCall =
  | ["open", string, GitSection] /** 打开差异：路径 + 分区 */
  | ["reveal", string] /** 在资源管理器中打开：路径 */
  | ["stage", string[], GitSection] /** 暂存/取消暂存：路径清单 + 分区 */
  | ["discard", string[]] /** 丢弃：路径清单 */
  | ["copy-relative", string] /** 复制相对路径：路径 */
  | ["copy-absolute", string]; /** 复制绝对路径：路径 */

test('Git 变更列表: 文件右键菜单复刻宿主顺序并排除终端入口', () => {
  const pane = document.createElement('div');
  document.body.appendChild(pane);
  const calls: RowMenuCall[] = [];
  const file = gitFile({ path: 'src/a.js', status: 'M', indexStatus: ' ', workdirStatus: 'M' });
  renderGitList(pane, makeOpts({
    gitStatus: gitStatus({ isRepo: true, files: [file] }),
    onOpenFile: (entry, section) => calls.push(['open', entry.path, section]),
    onRevealFile: (entry) => calls.push(['reveal', entry.path]),
    onStageToggle: (entries, section) => calls.push(['stage', entries.map((entry) => entry.path), section]),
    onDiscard: (entries) => calls.push(['discard', entries.map((entry) => entry.path)]),
    onCopyRelativePath: (entry) => calls.push(['copy-relative', entry.path]),
    onCopyAbsolutePath: (entry) => calls.push(['copy-absolute', entry.path]),
  }));

  const row = q<HTMLElement>(pane, '.sfe-git-row:not(.sfe-git-folder-row)');
  row.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 24,
    clientY: 32,
  }));
  const menu = pane.querySelector('.sfe-git-context-menu');
  assert.ok(menu, '右键文件行应显示 Git 菜单');
  assert.deepEqual(
    [...menu.querySelectorAll<HTMLButtonElement>('button')].map((item) => item.dataset.menuId),
    ['open', 'reveal', 'stage-toggle', 'discard', 'refresh', 'copy-relative', 'copy-absolute'],
    '菜单项顺序：危险操作单独隔离，刷新位于复制路径之前',
  );
  assert.equal(menu.querySelectorAll('.sfe-context-menu-separator').length, 3, '应保留宿主两条分隔线并新增刷新前的分隔线');
  assert.doesNotMatch(menu.textContent, /终端|Terminal/i, '菜单不得包含在终端打开');

  q<HTMLButtonElement>(menu, '[data-menu-id="stage-toggle"]').click();
  assert.deepEqual(calls, [['stage', ['src/a.js'], 'unstaged']], '暂存项应传入当前文件和当前分区');

  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 32 }));
  q<HTMLButtonElement>(pane, '[data-menu-id="discard"]').click();
  assert.deepEqual(calls.at(-1), ['discard', ['src/a.js']], '丢弃项应传入当前文件');

  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 32 }));
  q<HTMLButtonElement>(pane, '[data-menu-id="open"]').click();
  assert.deepEqual(calls.at(-1), ['open', 'src/a.js', 'unstaged']);

  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 32 }));
  q<HTMLButtonElement>(pane, '[data-menu-id="reveal"]').click();
  assert.deepEqual(calls.at(-1), ['reveal', 'src/a.js']);

  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 32 }));
  q<HTMLButtonElement>(pane, '[data-menu-id="copy-relative"]').click();
  assert.deepEqual(calls.at(-1), ['copy-relative', 'src/a.js']);

  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 32 }));
  q<HTMLButtonElement>(pane, '[data-menu-id="copy-absolute"]').click();
  assert.deepEqual(calls.at(-1), ['copy-absolute', 'src/a.js']);
  document.body.removeChild(pane);
});

test('Git 变更列表: 状态字母排在整行最后（与文件树一致，不在名称容器内）', () => {
  const pane = document.createElement('div');
  document.body.appendChild(pane);
  const file = gitFile({ path: 'src/a.js', status: 'M', indexStatus: ' ', workdirStatus: 'M' });
  renderGitList(pane, makeOpts({ gitStatus: gitStatus({ isRepo: true, files: [file] }) }));

  const row = q<HTMLElement>(pane, '.sfe-git-row:not(.sfe-git-folder-row)');
  const nameWrap = q<HTMLElement>(row, '.sfe-git-name');
  // !: 徽章缺失即为改动未生效，后续解引用同样会抛 TypeError，故只在唯一查询出口收窄一次。
  const status = row.querySelector<HTMLElement>('.sfe-git-status')!;
  assert.ok(status, '状态字母应渲染');
  assert.equal(row.lastElementChild, status, '状态字母应是整行最后一个元素（在暂存/丢弃按钮之后）');
  assert.equal(nameWrap.querySelector('.sfe-git-status'), null, '状态字母不再跟在文件名右侧');
  // 行内顺序：名称容器 → 撤销 → 暂存 → 状态字母
  assert.match(status.previousElementSibling!.className, /stage-toggle/, '状态字母前面应是暂存按钮');
  assert.equal(row.firstElementChild, nameWrap, '行首仍是名称容器');
  document.body.removeChild(pane);
});

test('Git 变更列表: 删除文件禁用打开和资源管理器菜单，但保留 Git 操作', () => {
  const pane = document.createElement('div');
  document.body.appendChild(pane);
  const file = gitFile({ path: 'deleted.js', status: 'D', indexStatus: ' ', workdirStatus: 'D' });
  renderGitList(pane, makeOpts({
    gitStatus: gitStatus({ isRepo: true, files: [file] }),
    onRevealFile: () => {},
    onCopyRelativePath: () => {},
    onCopyAbsolutePath: () => {},
  }));
  const row = q<HTMLElement>(pane, '.sfe-git-row');
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 32 }));
  assert.equal(q<HTMLButtonElement>(pane, '[data-menu-id="open"]').disabled, true);
  assert.equal(q<HTMLButtonElement>(pane, '[data-menu-id="reveal"]').disabled, true);
  assert.equal(q<HTMLButtonElement>(pane, '[data-menu-id="stage-toggle"]').disabled, false);
  assert.equal(q<HTMLButtonElement>(pane, '[data-menu-id="copy-relative"]').disabled, false);
  document.body.removeChild(pane);
});

test('Git 变更列表: 空白区右键菜单提供仓库级操作，且与文件行菜单互斥', () => {
  const pane = document.createElement('div');
  document.body.appendChild(pane);
  const calls: string[] = [];
  renderGitList(pane, makeOpts({
    gitStatus: gitStatus({
      isRepo: true,
      files: [
        gitFile({ path: 'src/a.js', status: 'M', indexStatus: ' ', workdirStatus: 'M' }),
        gitFile({ path: 'src/b.js', status: 'M', indexStatus: 'M', workdirStatus: ' ' }),
      ],
    }),
    onRefresh: () => calls.push('refresh'),
    onStageAll: () => calls.push('stage-all'),
    onUnstageAll: () => calls.push('unstage-all'),
  }));

  // 空白区（滚动容器本身，非文件行）右键 → 仓库级菜单
  const scroll = q<HTMLElement>(pane, '.sfe-git-scroll');
  scroll.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 20,
    clientY: 20,
  }));
  const menu = pane.querySelector('.sfe-git-context-menu');
  assert.ok(menu, '空白区右键应显示仓库级菜单');
  assert.deepEqual(
    [...menu.querySelectorAll<HTMLButtonElement>('button')].map((item) => item.dataset.menuId),
    ['refresh', 'stage-all', 'unstage-all'],
    '空白区菜单只提供仓库级操作',
  );

  q<HTMLButtonElement>(menu, '[data-menu-id="refresh"]').click();
  assert.deepEqual(calls, ['refresh'], '刷新项应触发 onRefresh');

  // 文件行右键 → 只出现文件级菜单，且行内 stopPropagation 不触发空白菜单
  const row = q<HTMLElement>(pane, '.sfe-git-row:not(.sfe-git-folder-row)');
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 32 }));
  const menus = pane.querySelectorAll('.sfe-git-context-menu');
  assert.equal(menus.length, 1, '同一时刻只应存在一个 Git 菜单');
  assert.ok(menus[0].querySelector('[data-menu-id="open"]'), '文件行菜单应含文件级项');
  assert.equal(menus[0].querySelector('[data-menu-id="stage-all"]'), null, '文件行菜单不应含仓库级项');

  document.body.removeChild(pane);
});

test('Git 变更列表: 文件菜单支持点击外部和 Escape 关闭', () => {
  const pane = document.createElement('div');
  document.body.appendChild(pane);
  renderGitList(pane, makeOpts({
    gitStatus: gitStatus({ isRepo: true, files: [gitFile({ path: 'a.js', status: 'M', indexStatus: ' ', workdirStatus: 'M' })] }),
  }));
  const row = q<HTMLElement>(pane, '.sfe-git-row');
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
  const files = [gitFile({ path: 'a.js', status: 'M', indexStatus: ' ', workdirStatus: 'M' })];

  renderGitList(pane, makeOpts({ gitStatus: gitStatus({ isRepo: true, files }) }));
  assert.equal(pane.querySelector('.sfe-git-row.selected'), null, '未选中时不应有选中行');

  // 用户已点击该文件（state.gitSelected 记录为 `unstaged:a.js`），列表重建
  renderGitList(pane, makeOpts({ gitStatus: gitStatus({ isRepo: true, files }), selected: 'unstaged:a.js' }));
  const row = pane.querySelector('.sfe-git-row.selected');
  assert.ok(row, '重建后必须按 selected 恢复选中态');
  assert.ok(row.querySelector('.sfe-git-row-btn.stage-toggle'), '选中行须含行内操作按钮（CSS 依据 .selected 使其常显）');
});

// 目录行此前只 hover 才显示加号（点击只折叠、不选中）。点击后应同时选中并折叠，
// 选中态经 .selected 使加号常显。
/** 目录行单击记录：`[动作, 路径/分区, 分区/路径]`。 */
type FolderClickCall = ["selectFolder", string, GitSection] | ["collapse", GitSection, string];

test('Git 变更列表: 单击文件夹行即选中并折叠，加号随之常显', () => {
  const pane = document.createElement('div');
  document.body.appendChild(pane);
  const calls: FolderClickCall[] = [];
  renderGitList(pane, makeOpts({
    gitStatus: gitStatus({ isRepo: true, files: [gitFile({ path: 'src/a.js', status: 'M', indexStatus: ' ', workdirStatus: 'M' })] }),
    onSelectFolder: (node, section) => calls.push(['selectFolder', node.path, section]),
    onToggleCollapse: (section, path) => calls.push(['collapse', section, path]),
  }));

  const folder = q<HTMLElement>(pane, '.sfe-git-folder-row');
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
  const files = [gitFile({ path: 'src/a.js', status: 'M', indexStatus: ' ', workdirStatus: 'M' })];
  renderGitList(pane, makeOpts({ gitStatus: gitStatus({ isRepo: true, files }), selected: 'unstaged:src' }));
  const folder = pane.querySelector('.sfe-git-folder-row.selected');
  assert.ok(folder, '重建后必须按 selected 恢复目录行选中态');
  assert.ok(folder.querySelector('.sfe-git-row-btn.stage-toggle'), '选中目录行须含加号按钮');
});
