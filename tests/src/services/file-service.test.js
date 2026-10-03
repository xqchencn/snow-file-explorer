import test from 'node:test';
import assert from 'node:assert/strict';
import { basename, extname, sortEntries, resolveActiveDirectoryPath } from '../../../src/services/file-service.js';

test('文件服务: basename 与 extname', () => {
  assert.equal(basename('/foo/bar/baz.js'), 'baz.js');
  assert.equal(basename('C:\\Users\\admin\\file.txt'), 'file.txt');
  assert.equal(basename('folder'), 'folder');

  assert.equal(extname('index.js'), 'js');
  assert.equal(extname('archive.tar.gz'), 'gz');
  assert.equal(extname('.gitignore'), 'gitignore');
  assert.equal(extname('no_ext'), '');
});

test('文件服务: sortEntries 文件夹优先与字母序', () => {
  const input = [
    { name: 'b.txt', isDirectory: false },
    { name: 'src', isDirectory: true },
    { name: 'a.txt', isDirectory: false },
    { name: 'build', isDirectory: true },
  ];
  const sorted = sortEntries(input);
  assert.deepEqual(
    sorted.map((e) => e.name),
    ['build', 'src', 'a.txt', 'b.txt']
  );
});

test('元数据契约: resolveActiveDirectoryPath 从包裹响应提取激活项目路径', () => {
  // 正确契约：api.metadata.get() 返回 { generatedAt, domains: { projects: { active } } }
  const wrapped = {
    generatedAt: 123,
    domains: {
      projects: {
        active: { directoryId: 'local:D:/repo', name: 'repo', path: 'D:/repo', pathState: 'ok' },
      },
    },
  };
  assert.equal(resolveActiveDirectoryPath(wrapped), 'D:/repo');

  // 回退：projects.active 缺失时改读 runtime.activeDirectory
  const runtimeOnly = {
    domains: { projects: { active: null }, runtime: { activeDirectory: { path: '/home/u/proj' } } },
  };
  assert.equal(resolveActiveDirectoryPath(runtimeOnly), '/home/u/proj');

  // 回归防护：旧代码误把包裹对象当裸数据读取的形态必须不再命中
  assert.equal(resolveActiveDirectoryPath({ path: 'D:/wrong', directoryPath: 'D:/wrong' }), '');
  assert.equal(resolveActiveDirectoryPath({ domains: {} }), '');
  assert.equal(resolveActiveDirectoryPath(null), '');
});