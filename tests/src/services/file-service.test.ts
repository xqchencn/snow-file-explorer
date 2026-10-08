import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
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
  workspaceRelativePath,
  buildFileChatReference,
  buildFileSelectionChatMessage,
  appendChatText,
  renameFileSystemEntry,
  deleteFileSystemEntry,
  deleteFileSystemEntries,
} from '../../../src/services/file-service.ts';
import type { FileWriteResult, FileWriteRuntimeApi } from '../../../src/services/file-service.ts';
import {
  insertChatTextWithRetry,
  normalizeEmptyChatInput,
} from '../../../src/services/chat-input-service.ts';
import type { BatchWorkspaceDeleteResult } from '../../../src/types/host/host-workspace.ts';
import { installWindow, restoreWindow } from '../utils/window-stub.ts';

/**
 * 写通道桩记录到的 params。
 * @description FileWriteRuntimeApi 把 run 的 params 声明为可缺，记录类型跟着可缺，
 *   避免为通过编译而谎称它必有。
 */
type WriteCall = Record<string, unknown> | undefined;

/**
 * 取批量删除回传的 data。
 * @description 包装函数已按动作 id 把 data 收成宿主 BatchWorkspaceDeleteResult（类型层不再需要猜），
 *   这里仍在运行期真校验一遍：deleted / failed 都经 Array.isArray 判定，不过即断言失败，
 *   防的是桩或宿主给出的形状与声明不符，而不是为了通过编译。
 */
function deleteBatchData(result: FileWriteResult): BatchWorkspaceDeleteResult {
  const data: unknown = result.data;
  if (typeof data !== 'object' || data === null || !('deleted' in data) || !('failed' in data)) {
    throw new assert.AssertionError({ message: '批量删除的 data 应为 BatchWorkspaceDeleteResult' });
  }
  if (!Array.isArray(data.deleted) || !Array.isArray(data.failed)) {
    throw new assert.AssertionError({ message: '批量删除的 data 应为 BatchWorkspaceDeleteResult' });
  }
  return { deleted: data.deleted, failed: data.failed };
}

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

test('文件服务: 相对路径跟随工作区平台分隔符且拒绝越界', () => {
  const windowsRoot = 'D:/app/code/snow-file-explorer';
  assert.equal(workspaceRelativePath(windowsRoot, windowsRoot), 'snow-file-explorer');
  assert.equal(
    workspaceRelativePath(windowsRoot, 'D:/app/code/snow-file-explorer/tests'),
    'snow-file-explorer\\tests',
  );
  assert.equal(
    workspaceRelativePath(windowsRoot, 'D:/app/code/snow-file-explorer/tests/bundle.test.ts'),
    'snow-file-explorer\\tests\\bundle.test.ts',
  );

  const posixRoot = '/workspace/snow-file-explorer';
  assert.equal(
    workspaceRelativePath(posixRoot, '/workspace/snow-file-explorer/tests/bundle.test.ts'),
    'snow-file-explorer/tests/bundle.test.ts',
  );
  assert.equal(workspaceRelativePath(windowsRoot, 'D:/app/code/snow-file-explorer2/tests'), null);
  assert.equal(workspaceRelativePath(windowsRoot, 'D:/other/tests'), null);
});

test('文件服务: 文件对话框引用只含工作区路径和完整行范围', () => {
  const root = 'D:/app/code/snow-file-explorer';
  const file = 'D:/app/code/snow-file-explorer/tests/bundle.test.ts';
  const crlf = ['a', 'b', 'c'].join("\r\n");
  const lf = ['a', 'b', 'c'].join("\n");
  const cr = ['a', 'b', 'c'].join("\r");

  const separator = String.fromCharCode(92);
  const normalizePath = (value: string | null): string | null => value?.replaceAll(separator, "/") ?? null;
  const workspaceName = root.slice(root.lastIndexOf("/") + 1);
  const expectedPath = `${workspaceName}/tests/bundle.test.ts`;
  assert.equal(normalizePath(buildFileChatReference(root, file, crlf)), `${expectedPath} L1-L3`);
  assert.equal(normalizePath(buildFileChatReference(root, file, lf)), `${expectedPath} L1-L3`);
  assert.equal(normalizePath(buildFileChatReference(root, file, cr)), `${expectedPath} L1-L3`);
  assert.equal(normalizePath(buildFileChatReference(root, file, '')), `${expectedPath} L1-L1`);
  assert.equal(buildFileChatReference(root, 'D:/other/bundle.test.ts', 'secret body'), null);

  const message = buildFileChatReference(root, file, 'const value = 1;\nconst other = 2;')!;
  assert.equal(normalizePath(message), `${expectedPath} L1-L2`);
  assert.equal(message.includes('const value = 1;'), false);
  assert.equal(message.includes('1 const'), false);
});

test('文件服务: 聊天追加文本只在已有草稿时添加换行', () => {
  assert.equal(appendChatText('', 'message'), 'message');
  assert.equal(appendChatText('\n', 'message'), 'message');
  assert.equal(appendChatText(' ', 'message'), 'message');
  assert.equal(appendChatText('draft', 'message'), '\nmessage');
  // contenteditable 可能把草稿末尾换行发布出来；不能再补第二个换行。
  assert.equal(appendChatText('draft\n', 'message'), 'message');
  // 选区 / 终端复制的边界换行只代表编辑器的末行分隔符，不能在对话框里变成空白段。
  assert.equal(appendChatText('', '\nmessage\n'), 'message');
  assert.equal(appendChatText('draft', '\nmessage\n'), '\nmessage');
});

test('聊天输入: 宿主残留单换行时先归一化为空输入', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const input = dom.window.document.createElement('div');
  input.contentEditable = 'true';
  input.dataset.empty = 'true';
  input.innerHTML = '<br>';
  let inputEvents = 0;
  input.addEventListener('input', () => {
    inputEvents += 1;
  });

  assert.equal(normalizeEmptyChatInput(input), true);
  assert.equal(input.innerHTML, '');
  assert.equal(inputEvents, 1);
  dom.window.close();
});

test('聊天追加真实时序: 未挂载可重试，快照延迟不得重复追加', async () => {
  let currentText: string | null = null;
  let reads = 0;
  const calls: string[] = [];

  const confirmed = await insertChatTextWithRetry('message', {
    readRuntime: async () => {
      reads += 1;
      // 第一次读取时输入框尚未挂载；下一次重试前模拟聊天视图完成挂载。
      if (reads === 2) currentText = '';
      return currentText === null ? null : { chatInput: { inputText: currentText } };
    },
    insertText: async (text) => {
      calls.push(text);
      currentText = `${currentText ?? ''}${text}`;
    },
    attempts: 3,
    retryDelayMs: 1,
    timeoutMs: 20,
    pollIntervalMs: 1,
  });
  assert.equal(confirmed, 'confirmed');
  assert.deepEqual(calls, ['message']);
  assert.equal(currentText, 'message');

  const published = 'draft';
  let actual = 'draft';
  let insertCount = 0;
  const delayed = await insertChatTextWithRetry('message', {
    readRuntime: async () => ({ chatInput: { inputText: published } }),
    insertText: async (text) => {
      insertCount += 1;
      actual += text;
    },
    attempts: 3,
    retryDelayMs: 1,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });
  assert.equal(delayed, 'unconfirmed');
  assert.equal(insertCount, 1, 'runtime 快照滞后时不得把同一消息再次追加');
  assert.equal(actual, 'draft\nmessage');
  assert.equal(published, 'draft');
});

test('聊天追加真实时序: 输入框未挂载时不能把陈旧 runtime 快照当成可写目标', async () => {
  const calls: string[] = [];
  const status = await insertChatTextWithRetry('message', {
    // 宿主在输入框卸载后仍保留最后一次 inputText；DOM 挂载探针才是真实边界。
    isInputMounted: () => false,
    readRuntime: async () => ({ chatInput: { inputText: 'stale draft' } }),
    insertText: async (text) => calls.push(text),
    attempts: 2,
    retryDelayMs: 1,
    timeoutMs: 1,
    pollIntervalMs: 1,
  });
  assert.equal(status, 'not-ready');
  assert.deepEqual(calls, []);
});

test('聊天追加真实时序: 真实输入框为空时忽略陈旧 runtime 草稿，不在路径前补空行', async () => {
  let inserted = '';
  const status = await insertChatTextWithRetry('repo\\request.rest L1-L1', {
    readRuntime: async () => ({ chatInput: { inputText: 'stale draft' } }),
    isInputMounted: () => true,
    readCurrentText: () => '',
    insertText: async (text) => {
      inserted = text;
    },
    attempts: 1,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });

  assert.equal(status, 'unconfirmed', '桩故意不更新 runtime，只验证写入载荷');
  assert.equal(inserted, 'repo\\request.rest L1-L1');
});

test('文件服务: 代码选区消息包含路径、行范围和原文，不添加围栏或伪造行号', () => {
  const root = 'D:/app/code/sno***************';
  const file = 'D:/app/code/sno***************/tmp/snow-file-explorer/.gitignore';
  const fullText = 'ignore\r\nfirst\r\nsecond\r\n';
  const selected = 'first\r\nsecond\r\n';
  // selectionStart 来自编辑态 textarea.selectionStart，而 textarea.value 的换行按 HTML 规范
  // 已归一为 LF：'ignore\n' 长 7，故真实偏移是 7（按 CRLF 数出来的 8 不是该函数接受的坐标）。
  const message = buildFileSelectionChatMessage(root, file, fullText, selected, 7);

  const separator = String.fromCharCode(92);
  const normalizePath = (value: string | null): string | null => value?.replaceAll(separator, "/") ?? null;
  const messageText = message ?? "";
  const headerEnd = messageText.indexOf("\n");
  const header = normalizePath(headerEnd >= 0 ? messageText.slice(0, headerEnd) : null);
  assert.equal(header?.endsWith(" L2-L3"), true);
  assert.equal(header?.includes("/tmp/"), true);
  assert.equal(header?.endsWith("/.gitignore L2-L3"), true);
  assert.equal(headerEnd >= 0 ? messageText.slice(headerEnd + 1) : null, selected);
  assert.equal(message?.includes('```'), false);
  assert.equal(message?.includes('2 first'), false);
  assert.equal(buildFileSelectionChatMessage(root, 'D:/other/.gitignore', fullText, selected), null);
  assert.equal(buildFileSelectionChatMessage(root, file, fullText, 'missing'), null);
});

test('文件服务: CRLF 磁盘原文与 LF 选区仍能定位（只读态发送到对话框不得返回 null）', () => {
  const root = 'D:/repo';
  const file = 'D:/repo/src/a.js';
  // 磁盘真实内容为 CRLF；浏览器 getSelection().toString() 跨行选区用 \n 连接。
  const diskText = 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n';
  const browserSelection = 'const b = 2;\nconst c = 3;\n';
  const lfText = diskText.replace(/\r\n/g, '\n');

  const fromCrlf = buildFileSelectionChatMessage(root, file, diskText, browserSelection);
  const fromLf = buildFileSelectionChatMessage(root, file, lfText, browserSelection);

  assert.equal(fromCrlf, 'repo\\src\\a.js L2-L3\nconst b = 2;\nconst c = 3;\n');
  assert.equal(fromCrlf, fromLf, 'CRLF 与 LF 原文必须得到同一条消息');
});

test('文件服务: 代码与 REST 选区边界换行不得制造正文首行空白', () => {
  const message = buildFileSelectionChatMessage(
    'D:/repo',
    'D:/repo/request.rest',
    '### 请求\nGET https://a.test\n',
    '\nGET https://a.test\n',
    6,
  );

  assert.equal(message, 'repo\\request.rest L2-L2\nGET https://a.test\n');
  assert.equal(message?.split('\n')[1], 'GET https://a.test');
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
  assert.ok(result.error);
  assert.match(result.error, /未提供文件写入能力/);
});

test('文件服务: 写入调用使用真实路径和完整文本，并透传成功结果', async () => {
  const calls: WriteCall[] = [];
  const api: FileWriteRuntimeApi = {
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
  assert.ok(result.error);
  assert.match(result.error, /未提供文件删除能力/);
});

test('文件服务: 删除调用使用真实工作区和条目路径，并透传成功结果', async () => {
  const calls: WriteCall[] = [];
  const api: FileWriteRuntimeApi = {
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

test('文件服务: 批量删除调用 filesystem.deleteBatch 并透传删除结果', async () => {
  const calls: WriteCall[] = [];
  const api: FileWriteRuntimeApi = {
    write: {
      run: async (action, params) => {
        assert.equal(action, 'filesystem.deleteBatch');
        calls.push(params);
        return { ok: true, data: { deleted: ['D:/repo/a.txt'], failed: [] } };
      },
    },
  };
  const result = await deleteFileSystemEntries(api, 'D:/repo', ['D:/repo/a.txt', 'D:/repo/b.txt']);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ rootPath: 'D:/repo', entryPaths: ['D:/repo/a.txt', 'D:/repo/b.txt'] }]);
  assert.deepEqual(deleteBatchData(result).deleted, ['D:/repo/a.txt']);
});

test('文件服务: 批量删除在宿主未提供能力时明确失败', async () => {
  const result = await deleteFileSystemEntries({}, 'D:/repo', ['D:/repo/a.txt']);
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.match(result.error, /未提供批量删除能力/);
});

test('文件服务: 重命名宿主未提供能力时明确失败', async () => {
  const result = await renameFileSystemEntry({}, 'D:/repo', 'D:/repo/a.txt', 'b.txt');
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.match(result.error, /未提供文件重命名能力/);
});

test('文件服务: 重命名调用使用真实工作区、条目路径与新名称，并透传成功结果', async () => {
  const calls: WriteCall[] = [];
  const api: FileWriteRuntimeApi = {
    write: {
      run: async (action, params) => {
        assert.equal(action, 'filesystem.rename');
        calls.push(params);
        return { ok: true, data: { rootPath: 'D:/repo', entryPath: 'D:/repo/a.txt', newName: 'b.txt' } };
      },
    },
  };
  const result = await renameFileSystemEntry(api, 'D:/repo', 'D:/repo/a.txt', 'b.txt');
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ rootPath: 'D:/repo', entryPath: 'D:/repo/a.txt', newName: 'b.txt' }]);
});

test('JVM 检测: 根目录没有构建文件或源文件时不读取子目录', async () => {
  const reads: string[] = [];
  const previous = globalThis.window;
  installWindow({
    snow: {
      readDirectoryEntries: async (dir) => {
        reads.push(dir);
        return [];
      },
    },
  });
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
    restoreWindow(previous);
  }
});

