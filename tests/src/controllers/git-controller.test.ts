import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitController, type GitControllerDeps } from '../../../src/controllers/git-controller.ts';
import { createPanelState } from '../../../src/state/panel-state.ts';
import type { GitFileStatus, GitStatusResult } from '../../../src/types/host/host-git.ts';

/** 构造最小 Git 文件状态；测试只关心 indexStatus 对 staged 分区的影响。 */
function gitFile(path: string, indexStatus: string, workdirStatus = ' '): GitFileStatus {
  return {
    path,
    oldPath: null,
    indexStatus,
    workdirStatus,
    status: indexStatus === ' ' ? 'M' : 'A',
  };
}

/** 构造控制器状态桩；resetStagedCollapse 与折叠切换不依赖 DOM 或宿主 IPC。 */
function gitStatus(files: GitFileStatus[], isRepo = true): GitStatusResult {
  return {
    isRepo,
    currentBranch: 'main',
    upstream: null,
    ahead: 0,
    behind: 0,
    files,
    stagedCount: files.filter((file) => file.indexStatus !== ' ').length,
    unstagedCount: 0,
    untrackedCount: 0,
    statusLimitHit: false,
  };
}

function createController(state = createPanelState()) {
  const deps = {
    state,
    t: ((_key: string, fallback?: string) => fallback || _key) as GitControllerDeps['t'],
    api: {} as GitControllerDeps['api'],
    isDisposed: () => false,
    getLayout: () => null,
    getContainer: () => null as unknown as HTMLElement,
    renderGitPane: () => {},
    renderGitPaneCommit: () => {},
    renderGitPreview: () => {},
    syncGitIndicator: () => {},
    openConfirmDialog: () => true,
    loadRoot: async () => {},
    buildFilePreview: () => ({ kind: 'empty' as const, name: '', path: '', text: '' }),
    inlineMarkdownImages: async () => {},
    yieldRightDockToCode: () => {},
    copyPathText: async () => true,
    handleRevealInExplorer: async () => {},
  } satisfies GitControllerDeps;
  return createGitController(deps);
}

test('Git 控制器: 进入视图时已暂存目录默认折叠，手动展开后仅在当前视图保留', () => {
  const state = createPanelState();
  state.rootPath = 'D:/repo';
  state.gitStatus = gitStatus([
    gitFile('src/a.js', 'M'),
    gitFile('src/deep/b.js', 'M'),
  ]);
  const controller = createController(state);

  controller.resetStagedCollapse();
  assert.deepEqual([...state.collapsedStaged!].sort(), ['src', 'src/deep']);

  controller.handleToggleGitCollapse('staged', 'src');
  assert.equal(state.collapsedStaged!.has('src'), false, '当前视图手动展开后应保持展开');

  controller.resetStagedCollapse();
  assert.deepEqual([...state.collapsedStaged!].sort(), ['src', 'src/deep'], '重新进入视图必须恢复默认折叠');
});

test('Git 控制器: 没有 Git 状态或没有 staged 文件时使用空集合且不崩溃', () => {
  const state = createPanelState();
  const controller = createController(state);

  controller.resetStagedCollapse();
  assert.ok(state.collapsedStaged instanceof Set);
  assert.equal(state.collapsedStaged!.size, 0);
  controller.handleToggleGitCollapse('staged', 'src');

  state.gitStatus = gitStatus([gitFile('src/a.js', ' ', 'M')]);
  controller.resetStagedCollapse();
  assert.equal(state.collapsedStaged!.size, 0);
  controller.handleToggleGitCollapse('staged', 'src');
});
