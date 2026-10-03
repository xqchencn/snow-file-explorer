import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGitignore,
  isIgnoredByRules,
  isExcludedMeta,
  filterExcludedEntries,
} from '../../../src/services/file-filter.js';

test('文件过滤: 元数据项精确匹配，且不误伤 .gitignore 本身', () => {
  for (const n of ['.git', '.svn', '.hg', 'CVS', '.DS_Store', 'Thumbs.db']) {
    assert.equal(isExcludedMeta(n), true, n + ' 应被排除');
  }
  // .gitignore 是普通隐藏文件，不应被元数据排除
  assert.equal(isExcludedMeta('.gitignore'), false);
  assert.equal(isExcludedMeta('src'), false);
});

test('文件过滤: .gitignore 解析忽略注释与空行', () => {
  const rules = parseGitignore('# comment\n\n  \n*.log\n!keep.log\nnode_modules/\n/dist');
  assert.equal(rules.length, 4);
  assert.equal(rules[0].negated, false);
  assert.equal(rules[1].negated, true);
  assert.equal(rules[2].dirOnly, true);
});

test('文件过滤: .gitignore 匹配器覆盖通配、目录、锚定与取反', () => {
  const rules = parseGitignore('*.log\n!important.log\nnode_modules/\n/dist\n**/temp');
  // 无斜杠 pattern 匹配任意层级
  assert.equal(isIgnoredByRules('a.log', false, rules), true);
  assert.equal(isIgnoredByRules('sub/deep/a.log', false, rules), true);
  // 取反覆盖
  assert.equal(isIgnoredByRules('important.log', false, rules), false);
  // 目录专用规则只匹配目录
  assert.equal(isIgnoredByRules('node_modules', true, rules), true);
  assert.equal(isIgnoredByRules('node_modules', false, rules), false);
  // 含斜杠 → 锚定所在目录
  assert.equal(isIgnoredByRules('dist', true, rules), true);
  assert.equal(isIgnoredByRules('src/dist', true, rules), false);
  // 双星号加斜杠匹配任意层级（含 0 层）
  assert.equal(isIgnoredByRules('temp', true, rules), true);
  assert.equal(isIgnoredByRules('a/b/temp', true, rules), true);
  // 未命中
  assert.equal(isIgnoredByRules('src/index.js', false, rules), false);
});

test('文件过滤: 多层 .gitignore 按 base 相对生效且深层覆盖浅层', () => {
  // 根 .gitignore 忽略所有 *.log；子目录 src/.gitignore 取反允许 src 下的 *.log
  const rules = [
    ...parseGitignore('*.log', ''),
    ...parseGitignore('!keep.log', 'src'),
  ];
  assert.equal(isIgnoredByRules('a.log', false, rules), true);
  assert.equal(isIgnoredByRules('src/keep.log', false, rules), false); // 深层取反
  assert.equal(isIgnoredByRules('other/keep.log', false, rules), true); // 深层规则不影响别处

  // 子目录规则仅作用于自身子树
  const subOnly = parseGitignore('*.tmp', 'src');
  assert.equal(isIgnoredByRules('src/a.tmp', false, subOnly), true);
  assert.equal(isIgnoredByRules('a.tmp', false, subOnly), false);
  assert.equal(isIgnoredByRules('other/a.tmp', false, subOnly), false);
});


test('文件过滤: 空 .gitignore 返回空规则', () => {
  assert.equal(parseGitignore('').length, 0);
  assert.equal(parseGitignore('# only comments\n\n').length, 0);
  assert.equal(isIgnoredByRules('a.log', false, []), false);
});

test('文件过滤: 关闭元数据开关时保留条目并增加浅色标记', () => {
  const entry = { name: '.git', path: 'D:/repo/.git', isDirectory: true, size: 12 };
  const result = filterExcludedEntries([entry], 'D:/repo', {
    excludeMeta: false,
    useGitignore: true,
    gitignoreRules: [],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].isSoftHidden, true);
  assert.equal(result[0].isMetaExcluded, true);
  assert.equal(result[0].path, entry.path);
  assert.equal(result[0].size, entry.size);
});

test('文件过滤: 关闭 .gitignore 开关时保留命中条目并增加浅色标记', () => {
  const entry = { name: 'debug.log', path: 'D:/repo/debug.log', isDirectory: false };
  const result = filterExcludedEntries([entry], 'D:/repo', {
    excludeMeta: true,
    useGitignore: false,
    gitignoreRules: parseGitignore('*.log'),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].isSoftHidden, true);
  assert.equal(result[0].isGitignored, true);
  assert.equal(result[0].path, entry.path);
});

test('文件过滤: 开关打开时过滤命中项，同时命中两条规则也只保留一个条目', () => {
  const entry = { name: '.git', path: 'D:/repo/.git', isDirectory: true };
  const result = filterExcludedEntries([entry], 'D:/repo', {
    excludeMeta: false,
    useGitignore: false,
    gitignoreRules: parseGitignore('.git'),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].isSoftHidden, true);

  const filtered = filterExcludedEntries([entry], 'D:/repo', {
    excludeMeta: true,
    useGitignore: true,
    gitignoreRules: parseGitignore('.git'),
  });
  assert.equal(filtered.length, 0);
});

test('文件过滤: 未命中规则的条目不带浅色标记', () => {
  const entry = { name: 'src', path: 'D:/repo/src', isDirectory: true };
  const result = filterExcludedEntries([entry], 'D:/repo', {
    excludeMeta: false,
    useGitignore: false,
    gitignoreRules: parseGitignore('*.log'),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].isSoftHidden, false);
});

test('文件过滤: 单一 .gitignore 开关同时控制元数据和忽略项', () => {
  const entries = [
    { name: '.git', path: 'D:/repo/.git', isDirectory: true },
    { name: 'debug.log', path: 'D:/repo/debug.log', isDirectory: false },
    { name: 'src', path: 'D:/repo/src', isDirectory: true },
  ];
  const gitignoreRules = parseGitignore('.git\n*.log');

  const filterEnabled = true;
  const hidden = filterExcludedEntries(entries, 'D:/repo', {
    excludeMeta: filterEnabled,
    useGitignore: filterEnabled,
    gitignoreRules,
  });
  assert.deepEqual(hidden.map((entry) => entry.path), ['D:/repo/src']);

  const filterDisabled = false;
  const visible = filterExcludedEntries(entries, 'D:/repo', {
    excludeMeta: filterDisabled,
    useGitignore: filterDisabled,
    gitignoreRules,
  });
  assert.deepEqual(
    visible.map((entry) => entry.path),
    entries.map((entry) => entry.path)
  );
  assert.equal(visible[0].isSoftHidden, true);
  assert.equal(visible[1].isSoftHidden, true);
  assert.equal(visible[2].isSoftHidden, false);
});
