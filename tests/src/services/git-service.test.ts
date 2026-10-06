import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveGitStatus,
  resolveGitFolderStatus,
  partitionGitFiles,
  gitStatusMeta,
  splitGitPath,
  buildGitFileTree,
  countGitTreeFiles,
  collectGitTreeFiles,
  collectGitFolderPaths,
  flattenGitTree,
  gitStatusSignature,
  gitSyncCounts,
} from '../../../src/services/git-service.ts';
import type { GitFileStatus, GitStatusResult } from '../../../src/types/host/host-git.ts';
import type { GitTreeRow } from '../../../src/services/git-service.ts';

/**
 * GitFileStatus 桩（宿主契约五字段全必给）。
 * @description buildGitFileTree / collectGitFolderPaths / countGitTreeFiles / collectGitTreeFiles /
 *   flattenGitTree 都只读 path（和「file 是否存在」），indexStatus / workdirStatus / oldPath
 *   在本组用例里不影响任何断言，按「未暂存、工作区状态等于派生状态、无重命名」自洽填充。
 */
function gitFile(path: string, status: string): GitFileStatus {
  return { path, oldPath: null, indexStatus: ' ', workdirStatus: status, status };
}

/**
 * GitStatusResult 桩（宿主契约 10 个字段全必给）。
 * @description gitStatusSignature 只读 isRepo / currentBranch / ahead / behind 与 files 里的
 *   path + 三个状态字符；gitSyncCounts 只读 isRepo / ahead / behind。
 *   其余计数字段与 statusLimitHit 按「无变更、未截断」填充，不参与断言。
 */
function gitStatusResult(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    isRepo: true,
    currentBranch: 'main',
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    statusLimitHit: false,
    ...overrides,
  };
}

/**
 * 取展平结果里的目录行。
 * @description GitTreeRow 是目录行 / 文件行的联合，只有目录行带 isExpanded；
 *   用例断言的首行在本场景必为目录行，非目录行按断言失败处理，
 *   与原先直接读 .isExpanded 拿到 undefined 再比对失败同效。
 */
function folderRowOf(row: GitTreeRow): Extract<GitTreeRow, { kind: 'folder' }> {
  if (row.kind !== 'folder') {
    throw new assert.AssertionError({ message: '期望展平后的首行为目录行' });
  }
  return row;
}

// 宿主契约：gitStatus(rootPath) 返回 { files: [{ path(仓库相对), status }] }，
// 插件按「仓库相对路径」索引。文件路径来自 readDirectoryEntries（绝对路径），
// 根路径来自 metadata（projects.active.path）。两者分隔符风格由宿主决定，可能不一致。
test('git 状态: 根路径与文件路径分隔符一致时按相对路径匹配', () => {
  const map = { 'file-explorer/README.md': 'M', 'README.md': 'U' };
  assert.equal(resolveGitStatus('D:/repo/file-explorer/README.md', 'D:/repo', map), 'M');
  assert.equal(resolveGitStatus('D:/repo/README.md', 'D:/repo', map), 'U');
  assert.equal(resolveGitStatus('D:/repo/clean.js', 'D:/repo', map), null);
});

test('git 状态: 根路径与文件路径分隔符不一致时仍必须正确匹配', () => {
  // 仅含嵌套键（无 basename 兜底键）——复现真实工作区：改动全在子目录下
  const map = { 'file-explorer/README.md': 'M', 'file-explorer/src/index.js': 'M' };

  // 根用反斜杠，文件用正斜杠
  assert.equal(resolveGitStatus('D:/repo/file-explorer/README.md', 'D:\\repo', map), 'M');
  // 根用正斜杠，文件用反斜杠
  assert.equal(resolveGitStatus('D:\\repo\\file-explorer\\README.md', 'D:/repo', map), 'M');
  // 大小写不一致（Windows 路径大小写不敏感）
  assert.equal(resolveGitStatus('D:/repo/file-explorer/src/index.js', 'd:/REPO', map), 'M');
  // 干净文件不得误报
  assert.equal(resolveGitStatus('D:/repo/file-explorer/clean.js', 'D:\\repo', map), null);
});

test('git 状态: 根路径带尾部分隔符时仍正确匹配', () => {
  const map = { 'src/a.js': 'A' };
  assert.equal(resolveGitStatus('D:/repo/src/a.js', 'D:/repo/', map), 'A');
  assert.equal(resolveGitStatus('D:/repo/src/a.js', 'D:\\repo\\', map), 'A');
});

test('git 状态: 文件夹聚合子孙状态，删除态不向父级传播', () => {
  const map = {
    'src/a.js': 'M',
    'src/b.js': 'U',
    'docs/readme.md': 'A',
    'only-deleted/old.js': 'D',
  };
  const root = 'D:/repo';
  // 含修改态子孙 → 聚合为 M（修改优先级最高）
  assert.equal(resolveGitFolderStatus('D:/repo/src', root, map), 'M');
  // 仅新增态子孙 → 聚合为 A
  assert.equal(resolveGitFolderStatus('D:/repo/docs', root, map), 'A');
  // 仅含删除态子孙 → 不聚合（删除态不向父级传播，对齐 VS Code propagate=false）
  assert.equal(resolveGitFolderStatus('D:/repo/only-deleted', root, map), null);
  // 仓库根 → 汇总所有非删除变更
  assert.equal(resolveGitFolderStatus('D:/repo', root, map), 'M');
  // 无变更目录 → null
  assert.equal(resolveGitFolderStatus('D:/repo/clean', root, map), null);
  // 分隔符与大小写不一致仍可匹配
  assert.equal(resolveGitFolderStatus('D:\\repo\\src', 'D:/REPO', map), 'M');
});

test('git 状态: 文件夹前缀须按路径段匹配，不误伤同前缀目录', () => {
  const map = { 'src2/x.js': 'M' };
  assert.equal(resolveGitFolderStatus('D:/repo/src', 'D:/repo', map), null);
  assert.equal(resolveGitFolderStatus('D:/repo/src2', 'D:/repo', map), 'M');
});
test('Git 变更: partitionGitFiles 按索引/工作区状态拆分', () => {
  // 本用例只锁分区判定，因此逐字段写出宿主契约要求的 oldPath（无重命名一律 null）。
  const files: GitFileStatus[] = [
    { path: 'a.js', oldPath: null, indexStatus: 'M', workdirStatus: ' ', status: 'M' }, // 仅暂存
    { path: 'b.js', oldPath: null, indexStatus: ' ', workdirStatus: 'M', status: 'M' }, // 仅工作区
    { path: 'c.js', oldPath: null, indexStatus: 'A', workdirStatus: 'M', status: 'M' }, // 两边都有
    { path: 'd.js', oldPath: null, indexStatus: ' ', workdirStatus: '?', status: 'U' }, // 未跟踪
    { path: 'e.js', oldPath: null, indexStatus: '?', workdirStatus: '?', status: 'U' }, // 未跟踪
  ];
  const { staged, unstaged } = partitionGitFiles(files);
  assert.deepEqual(staged.map((f) => f.path), ['a.js', 'c.js']);
  assert.deepEqual(unstaged.map((f) => f.path), ['b.js', 'c.js', 'd.js', 'e.js']);
  // 空输入安全
  assert.deepEqual(partitionGitFiles(null), { staged: [], unstaged: [] });
});

test('Git 变更: gitStatusMeta 状态字符映射', () => {
  assert.deepEqual(gitStatusMeta('A'), { letter: 'A', className: 'sfe-git-add' });
  assert.deepEqual(gitStatusMeta('m'), { letter: 'M', className: 'sfe-git-modify' });
  assert.equal(gitStatusMeta('D').className, 'sfe-git-delete');
  assert.equal(gitStatusMeta('U').className, 'sfe-git-untracked');
  assert.equal(gitStatusMeta('R').className, 'sfe-git-rename');
  assert.equal(gitStatusMeta('I').className, 'sfe-git-ignored');
  assert.equal(gitStatusMeta('').letter, '');
});

test('Git 变更: splitGitPath 拆分文件名与目录', () => {
  assert.deepEqual(splitGitPath('src/components/a.js'), { name: 'a.js', dir: 'src/components/' });
  assert.deepEqual(splitGitPath('README.md'), { name: 'README.md', dir: '' });
  assert.deepEqual(splitGitPath('a\\b\\c.js'), { name: 'c.js', dir: 'a\\b\\' });
});

test('Git 变更: buildGitFileTree 构建目录树，文件夹在前', () => {
  const tree = buildGitFileTree([
    gitFile('src/b.js', 'M'),
    gitFile('README.md', 'M'),
    gitFile('src/a.js', 'A'),
    gitFile('src/deep/c.js', 'U'),
  ]);
  // 顶层：文件夹 src 在前，文件 README.md 在后
  assert.deepEqual(tree.map((n) => n.name), ['src', 'README.md']);
  // src 下：文件夹 deep 在前，文件 a/b 升序在后
  assert.deepEqual(tree[0].children.map((n) => n.name), ['deep', 'a.js', 'b.js']);
  assert.ok(tree[0].children[1].file);
  assert.equal(tree[0].children[1].file.path, 'src/a.js');
  // 计数：src 子树共 3 个文件
  assert.equal(countGitTreeFiles(tree[0]), 3);
  assert.equal(countGitTreeFiles(tree[1]), 1);
});

test('Git 变更: collectGitTreeFiles 收集子树全部文件（供目录级暂存）', () => {
  const tree = buildGitFileTree([
    gitFile('src/b.js', 'M'),
    gitFile('README.md', 'M'),
    gitFile('src/a.js', 'A'),
    gitFile('src/deep/c.js', 'U'),
  ]);
  // src 子树：deep/c.js + a.js + b.js
  assert.deepEqual(
    collectGitTreeFiles(tree[0]).map((f) => f.path).sort(),
    ['src/a.js', 'src/b.js', 'src/deep/c.js']
  );
  // 单文件节点返回自身（GitTreeNode 的目录三要素按空值给，被测函数只读 file）
  assert.deepEqual(
    collectGitTreeFiles({ name: 'x.js', path: 'x.js', children: [], file: gitFile('x.js', 'M') }).map((f) => f.path),
    ['x.js']
  );
  assert.deepEqual(collectGitTreeFiles(null), []);
});

test('Git 变更: 已暂存目录默认折叠路径可从文件列表稳定派生', () => {
  const files = [gitFile('src/a.js', 'M'), gitFile('src/deep/b.js', 'A'), gitFile('README.md', 'M')];
  assert.deepEqual([...collectGitFolderPaths(files)].sort(), ['src', 'src/deep']);

  const rows = flattenGitTree(buildGitFileTree(files), collectGitFolderPaths(files));
  assert.deepEqual(rows.map((row) => (row.kind === 'folder' ? `D:${row.node.path}` : `F:${row.file.path}`)), [
    'D:src',
    'F:README.md',
  ]);
});
test('Git 变更: flattenGitTree 折叠目录时跳过子树', () => {
  const tree = buildGitFileTree([
    gitFile('src/a.js', 'M'),
    gitFile('src/b.js', 'M'),
    gitFile('README.md', 'M'),
  ]);
  const expanded = flattenGitTree(tree, new Set());
  assert.deepEqual(expanded.map((r) => (r.kind === 'folder' ? `D:${r.node.name}` : `F:${r.file.path}`)), [
    'D:src',
    'F:src/a.js',
    'F:src/b.js',
    'F:README.md',
  ]);
  const collapsed = flattenGitTree(tree, new Set(['src']));
  assert.deepEqual(collapsed.map((r) => (r.kind === 'folder' ? `D:${r.node.name}` : `F:${r.file.path}`)), [
    'D:src',
    'F:README.md',
  ]);
  assert.equal(folderRowOf(collapsed[0]).isExpanded, false);
});

test('Git 变更: gitStatusSignature 对内容相同的状态给出稳定签名', () => {
  const a = gitStatusResult({
    ahead: 1,
    behind: 0,
    files: [
      { path: 'src/a.js', oldPath: null, indexStatus: ' ', workdirStatus: 'M', status: 'M' },
      { path: 'README.md', oldPath: null, indexStatus: 'A', workdirStatus: ' ', status: 'A' },
    ],
  });
  // 文件顺序不同（宿主 git status 输出顺序可能抖动）→ 签名必须相同，
  // 否则会触发无谓的列表重建（表现为 hover 时列表持续跳动）。
  const reversed = { ...a, files: [...a.files].reverse() };
  assert.equal(gitStatusSignature(a), gitStatusSignature(reversed));
  assert.equal(gitStatusSignature(a), gitStatusSignature(a));
});

test('Git 变更: gitStatusSignature 对任何实质变化给出不同签名', () => {
  // isRepo / currentBranch / ahead / behind 取 gitStatusResult 的默认值（与原字面量一致）。
  const base = gitStatusResult({
    files: [{ path: 'a.js', oldPath: null, indexStatus: ' ', workdirStatus: 'M', status: 'M' }],
  });
  const sig = gitStatusSignature(base);
  // 文件新增
  assert.notEqual(
    sig,
    gitStatusSignature({
      ...base,
      files: [...base.files, { path: 'b.js', oldPath: null, indexStatus: ' ', workdirStatus: '?', status: 'U' }],
    })
  );
  // 文件清空（全部提交/撤销）
  assert.notEqual(sig, gitStatusSignature({ ...base, files: [] }));
  // 状态字符变化（工作区 → 暂存区）
  assert.notEqual(
    sig,
    gitStatusSignature({
      ...base,
      files: [{ path: 'a.js', oldPath: null, indexStatus: 'M', workdirStatus: ' ', status: 'M' }],
    })
  );
  // 分支 / 领先 / 落后变化
  assert.notEqual(sig, gitStatusSignature({ ...base, currentBranch: 'dev' }));
  assert.notEqual(sig, gitStatusSignature({ ...base, ahead: 1 }));
  assert.notEqual(sig, gitStatusSignature({ ...base, behind: 2 }));
});

test('Git 变更: gitStatusSignature 空值语义（未拉取与空仓库可区分）', () => {
  assert.equal(gitStatusSignature(null), '');
  assert.equal(gitStatusSignature(undefined), '');
  // 空文件列表（真实仓库但无变更）签名非空，可与「尚未拉取(null)」区分，
  // 保证首次拉取到空仓库时会真正重绘一次。
  const emptyRepo = gitStatusResult({ files: [] });
  assert.notEqual(gitStatusSignature(emptyRepo), '');
  assert.notEqual(gitStatusSignature(emptyRepo), gitStatusSignature(gitStatusResult({ isRepo: false })));
});

test('Git 状态: gitSyncCounts 提取未推送/未拉取计数', () => {
  const base = gitStatusResult({ upstream: 'origin/main', files: [] });
  assert.deepEqual(gitSyncCounts(base), { ahead: 0, behind: 0 });
  assert.deepEqual(gitSyncCounts({ ...base, ahead: 2, behind: 1 }), { ahead: 2, behind: 1 });
  // 无上游（从未推送）时 ahead/behind 均为 0，不应误报
  assert.deepEqual(gitSyncCounts({ ...base, upstream: null }), { ahead: 0, behind: 0 });
  // 非仓库 / 空值 / 负数兜底
  assert.deepEqual(gitSyncCounts({ ...base, isRepo: false, ahead: 3 }), { ahead: 0, behind: 0 });
  assert.deepEqual(gitSyncCounts({ ...base, ahead: -1 }), { ahead: 0, behind: 0 });
  assert.deepEqual(gitSyncCounts(null), { ahead: 0, behind: 0 });
  assert.deepEqual(gitSyncCounts(undefined), { ahead: 0, behind: 0 });
});