import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff, parseHunkHeader, buildSplitRows, buildFullFileDiff, buildFullSplitRows, createFullDiffAccess } from '../../../src/services/diff.js';

test('diff 解析: hunk 头解析（含省略行数默认 1）', () => {
  assert.deepEqual(parseHunkHeader('@@ -1,3 +1,4 @@ function foo() {'), {
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 4,
  });
  // 省略行数时按 unified diff 语义默认 1
  assert.deepEqual(parseHunkHeader('@@ -5 +5,2 @@'), {
    oldStart: 5,
    oldLines: 1,
    newStart: 5,
    newLines: 2,
  });
  assert.equal(parseHunkHeader('+++ b/file.js'), null);
  assert.equal(parseHunkHeader(''), null);
});

test('diff 解析: 标准 patch 的行号游标与增删计数', () => {
  const patch = [
    'diff --git a/a.js b/a.js',
    'index 111..222 100644',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -1,3 +1,4 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' const d = 5;',
  ].join('\n');

  const res = parseUnifiedDiff(patch);
  assert.equal(res.hasHunks, true);
  assert.equal(res.isBinary, false);
  assert.equal(res.additions, 2);
  assert.equal(res.deletions, 1);
  assert.equal(res.hunks.length, 1);

  const lines = res.hunks[0].lines;
  assert.deepEqual(
    lines.map((l) => `${l.type}:${l.oldNo}:${l.newNo}:${l.text}`),
    [
      'context:1:1:const a = 1;',
      'del:2:null:const b = 2;',
      'add:null:2:const b = 3;',
      'add:null:3:const c = 4;',
      'context:3:4:const d = 5;',
    ]
  );
});

test('diff 解析: 多 hunk、行尾无换行标记与空 patch', () => {
  const patch = [
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
    '\\ No newline at end of file',
    '@@ -10,1 +10,1 @@',
    '-x',
    '+y',
  ].join('\n');
  const res = parseUnifiedDiff(patch);
  assert.equal(res.hunks.length, 2);
  assert.equal(res.hunks[0].lines[2].type, 'meta');
  assert.equal(res.hunks[0].lines[2].oldNo, null);
  assert.equal(res.hunks[1].oldStart, 10);

  // 空输入安全
  const empty = parseUnifiedDiff('');
  assert.equal(empty.hasHunks, false);
  assert.equal(empty.raw, '');
  assert.equal(parseUnifiedDiff(null).hunks.length, 0);
});

test('diff 解析: 二进制差异与仅文件级头（无 hunk）', () => {
  const binary = parseUnifiedDiff('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ');
  assert.equal(binary.isBinary, true);
  assert.equal(binary.hasHunks, false);

  // 仅 mode 变更：没有任何 hunk，交由渲染层显示「无文本差异」
  const modeOnly = parseUnifiedDiff('diff --git a/f.sh b/f.sh\nold mode 100644\nnew mode 100755');
  assert.equal(modeOnly.isBinary, false);
  assert.equal(modeOnly.hasHunks, false);
});

test('diff 分栏: 同一变更块的删除/新增一一配对，上下文左右同显', () => {
  const patch = [
    '@@ -1,4 +1,5 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' const d = 5;',
  ].join('\n');
  const hunk = parseUnifiedDiff(patch).hunks[0];
  const rows = buildSplitRows(hunk);

  // 上下文行左右同显；删除行占左、新增行占右；多出的新增行右栏有值、左栏为 null
  assert.deepEqual(
    rows.map((r) => `${r.left ? r.left.type + ':' + r.left.text : '-'} | ${r.right ? r.right.type + ':' + r.right.text : '-'}`),
    [
      'context:const a = 1; | context:const a = 1;',
      'del:const b = 2; | add:const b = 3;',
      '- | add:const c = 4;',
      'context:const d = 5; | context:const d = 5;',
    ]
  );
});

test('diff 分栏: 纯新增/纯删除块在对侧留空占位', () => {
  // 纯新增（左栏全空）
  const addOnly = parseUnifiedDiff('@@ -1,1 +1,3 @@\n ctx\n+new1\n+new2').hunks[0];
  const addRows = buildSplitRows(addOnly);
  assert.equal(addRows[0].left.type, 'context');
  assert.equal(addRows[1].left, null);
  assert.equal(addRows[1].right.text, 'new1');
  assert.equal(addRows[2].left, null);
  assert.equal(addRows[2].right.text, 'new2');

  // 纯删除（右栏全空）
  const delOnly = parseUnifiedDiff('@@ -1,3 +1,1 @@\n-old1\n-old2\n ctx').hunks[0];
  const delRows = buildSplitRows(delOnly);
  assert.equal(delRows[0].left.text, 'old1');
  assert.equal(delRows[0].right, null);
  assert.equal(delRows[1].left.text, 'old2');
  assert.equal(delRows[1].right, null);
  assert.equal(delRows[2].left.type, 'context');

  // 空 hunk 安全
  assert.deepEqual(buildSplitRows({ lines: [] }), []);
  assert.deepEqual(buildSplitRows(null), []);
});

test('全文件差异: 按需访问与全量展开的每一行一致', () => {
  const full = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;', 'const e = 5;'].join('\n');
  const patch = [
    '@@ -1,1 +1,1 @@',
    '-const a = 1;',
    '+const a = 9;',
    '@@ -4,1 +4,2 @@',
    '-const d = 4;',
    '+const d = 8;',
    '+const extra = 1;',
  ].join('\n');
  const result = parseUnifiedDiff(patch);
  const expected = buildFullFileDiff(result, full);
  const access = createFullDiffAccess(result, full, 'unified');
  assert.equal(access.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    assert.deepEqual(access.at(i).row, expected[i], `unified 第 ${i} 行`);
  }
  const splitExpected = buildFullSplitRows(expected);
  const split = createFullDiffAccess(result, full, 'split');
  assert.equal(split.length, splitExpected.length);
  for (let i = 0; i < splitExpected.length; i += 1) {
    assert.deepEqual(split.at(i).row, splitExpected[i], `split 第 ${i} 行`);
  }
  assert.equal(access.hunkStartRow.length, result.hunks.length);
  assert.equal(access.at(access.hunkStartRow[1]).row.type, 'del');
  assert.equal(access.at(access.hunkStartRow[1]).row.text, 'const d = 4;');
});
