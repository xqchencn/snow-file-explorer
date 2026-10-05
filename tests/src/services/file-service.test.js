import test from 'node:test';
import assert from 'node:assert/strict';
import {
  basename,
  extname,
  sortEntries,
  resolveActiveDirectoryPath,
  detectJavaProjectFromEntries,
  detectJvmProject,
  hasJvmRootMarker,
  writeFileContent,
  relativePath,
  renameFileSystemEntry,
  deleteFileSystemEntry,
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

test('文件服务: Windows 相对路径规范化且拒绝越界', () => {
  assert.equal(relativePath('D:/repo', 'D:/repo/src/index.js'), 'src/index.js');
  assert.equal(relativePath('D:\\repo', 'D:/repo\\src\\index.js'), 'src/index.js');
  assert.equal(relativePath('D:/repo', 'D:/repo'), '.');
  assert.equal(relativePath('D:/repo', 'D:/repo2/a.js'), null);
  assert.equal(relativePath('D:/repo', 'D:/other/a.js'), null);
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

test('JVM 项目检测: Kotlin 标准源码根目录和 Kotlin 文件纳入项目证据', () => {
  const result = detectJavaProjectFromEntries(
    [
      { name: 'build.gradle.kts', isDirectory: false },
      { name: 'Launcher.kt', isDirectory: false },
      { name: 'Utils.kt', isDirectory: false },
    ],
    ['D:/repo/src/main/kotlin', 'D:/repo/src/test/kotlin']
  );

  assert.equal(result.isJvmProject, true);
  assert.equal(result.isJavaProject, true);
  assert.equal(result.kotlinFileCount, 2);
  assert.equal(result.jvmFileCount, 2);
  assert.deepEqual(result.sourceRoots, ['D:/repo/src/main/kotlin', 'D:/repo/src/test/kotlin']);
  assert.ok(result.evidence.includes('multiple-kotlin-files'));
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


test('文件服务: 宿主无写入能力时明确失败，不伪造保存成功', async () => {
  const result = await writeFileContent({}, 'D:/repo/a.txt', 'new text');
  assert.equal(result.ok, false);
  assert.match(result.error, /未提供文件写入能力/);
});

test('文件服务: 写入调用使用真实路径和完整文本，并透传成功结果', async () => {
  const calls = [];
  const api = {
    write: {
      run: async (action, params) => {
        assert.equal(action, 'filesystem.writeFile');
        calls.push(params);
        return { ok: true, data: { bytes: 8 } };
      },
    },
  };
  const result = await writeFileContent(api, 'D:/repo/a.txt', '完整文本');
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ filePath: 'D:/repo/a.txt', content: '完整文本' }]);
});

test('文件服务: 删除宿主未提供能力时明确失败', async () => {
  const result = await deleteFileSystemEntry({}, 'D:/repo', 'D:/repo/a.txt');
  assert.equal(result.ok, false);
  assert.match(result.error, /未提供文件删除能力/);
});

test('文件服务: 删除调用使用真实工作区和条目路径，并透传成功结果', async () => {
  const calls = [];
  const api = {
    write: {
      run: async (action, params) => {
        assert.equal(action, 'filesystem.delete');
        calls.push(params);
        return { ok: true, data: { deleted: true } };
      },
    },
  };
  const result = await deleteFileSystemEntry(api, 'D:/repo', 'D:/repo/a.txt');
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ rootPath: 'D:/repo', entryPath: 'D:/repo/a.txt' }]);
});

test('JVM 检测: 根目录没有构建文件或源文件时不读取子目录', async () => {
  const reads = [];
  const previous = globalThis.window;
  globalThis.window = {
    snow: {
      readDirectoryEntries: async (dir) => {
        reads.push(dir);
        return [];
      },
    },
  };
  try {
    const entries = [
      { name: 'src', isDirectory: true, path: 'D:/repo/src' },
      { name: 'package.json', isDirectory: false, path: 'D:/repo/package.json' },
    ];
    assert.equal(hasJvmRootMarker(entries), false);
    assert.equal(hasJvmRootMarker([{ name: 'pom.xml', isDirectory: false }]), true);
    const result = await detectJvmProject('D:/repo', entries);
    assert.deepEqual(reads, []);
    assert.equal(result.isJvmProject, false);
    assert.deepEqual(result.sourceRoots, []);
  } finally {
    globalThis.window = previous;
  }
});

