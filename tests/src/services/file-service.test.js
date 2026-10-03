import test from 'node:test';
import assert from 'node:assert/strict';
import {
  basename,
  extname,
  sortEntries,
  resolveActiveDirectoryPath,
  detectJavaProjectFromEntries,
} from '../../../src/services/file-service.js';

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

test('Java 项目检测: Maven/Gradle 构建文件是强信号', () => {
  const result = detectJavaProjectFromEntries([
    { name: 'pom.xml', isDirectory: false },
    { name: 'build.gradle', isDirectory: false },
  ]);

  assert.equal(result.isJavaProject, true);
  assert.equal(result.confidence, 'strong');
  assert.equal(result.buildSystem, 'mixed');
  assert.deepEqual(result.buildFiles, ['pom.xml', 'build.gradle']);
  assert.deepEqual(result.evidence, ['build-file']);
});

test('Java 项目检测: 标准源码根目录是强信号', () => {
  const result = detectJavaProjectFromEntries(
    [{ name: 'src', isDirectory: true }],
    ['D:/repo/src/main/java', 'D:/repo/src/test/java', 'D:/repo/src/main/java']
  );

  assert.equal(result.isJavaProject, true);
  assert.equal(result.confidence, 'strong');
  assert.deepEqual(result.sourceRoots, ['D:/repo/src/main/java', 'D:/repo/src/test/java']);
  assert.deepEqual(result.evidence, ['standard-source-root']);
});

test('Java 项目检测: 单个 Java 文件不足以把普通目录判成项目', () => {
  const result = detectJavaProjectFromEntries([
    { name: 'Example.java', isDirectory: false },
    { name: 'README.md', isDirectory: false },
  ]);

  assert.equal(result.isJavaProject, false);
  assert.equal(result.confidence, 'none');
  assert.equal(result.javaFileCount, 1);
  assert.deepEqual(result.evidence, []);
});

test('Java 项目检测: 多个根目录 Java 文件作为弱信号', () => {
  const result = detectJavaProjectFromEntries([
    { name: 'Main.java', isDirectory: false },
    { name: 'Utils.java', isDirectory: false },
  ]);

  assert.equal(result.isJavaProject, true);
  assert.equal(result.confidence, 'weak');
  assert.equal(result.javaFileCount, 2);
  assert.deepEqual(result.evidence, ['multiple-java-files']);
});

test('Java 项目检测: 忽略无效条目和大小写差异', () => {
  const result = detectJavaProjectFromEntries([
    null,
    { name: 'POM.XML', isDirectory: false },
    { name: '.java', isDirectory: false },
    { name: 'notes.txt', isDirectory: false },
  ]);

  assert.equal(result.isJavaProject, true);
  assert.deepEqual(result.buildFiles, ['POM.XML']);
  assert.equal(result.javaFileCount, 0);
});
