import test from "node:test";
import assert from "node:assert/strict";
import {
  HTTP_REST_EXTENSIONS,
  MAX_SCAN_DIRECTORIES,
  isHttpRestFileName,
  scanHttpRestFiles,
} from "../../../src/services/http-file-scan.ts";
import { parseGitignore } from "../../../src/services/file-filter.ts";
import type { DirectoryEntry, FileContentResult } from "../../../src/types/host/host-workspace.ts";
import { installWindow, restoreWindow } from "../utils/window-stub.ts";

const ROOT = "D:/repo";

/**
 * readFileContent 桩的返回值（宿主 FileContentResult 七字段全必给）。
 * @description 被测源码只取 `content` 并检查 `isBinary`，其余字段按「纯文本文件」自洽填充。
 */
function fileContent(content: string): FileContentResult {
  return {
    content,
    isBinary: false,
    isImage: false,
    isSvg: false,
    mimeType: "text/plain",
    encoding: "utf8",
    size: content.length,
  };
}

/** 虚拟工作区：目录索引 + 文件内容索引 + 两类读取的调用记录。 */
type VirtualFs = {
  /** 目录绝对路径 → 该层子条目，交给 readDirectoryEntries 桩。 */
  directories: Map<string, DirectoryEntry[]>;
  /** 文件绝对路径 → 文本内容，交给 readFileContent 桩。 */
  contents: Map<string, string>;
  /** 已发生过的列目录调用（绝对路径，按调用顺序）。 */
  dirsRead: string[];
  /** 已发生过的文件读取调用（绝对路径，按调用顺序）。 */
  filesRead: string[];
};

/**
 * 用「相对路径 → 内容」搭出虚拟目录树，缺的中间目录自动补全。
 * @param files 相对 ROOT 的文件路径与内容；键里出现的每一层都成为目录条目
 * @returns 供宿主桩消费的索引与调用记录
 */
function virtualFs(files: Record<string, string>): VirtualFs {
  const childMap = new Map<string, DirectoryEntry[]>();
  const contents = new Map<string, string>();
  const seen = new Set<string>([ROOT]);
  childMap.set(ROOT, []);

  for (const rel of Object.keys(files)) {
    const segments = rel.split("/").filter(Boolean);
    const name = segments[segments.length - 1];
    let dir = ROOT;
    for (const segment of segments.slice(0, -1)) {
      const next = `${dir}/${segment}`;
      if (!seen.has(next)) {
        seen.add(next);
        childMap.set(next, []);
        childMap.get(dir)!.push({ name: segment, path: next, isDirectory: true, size: 0 });
      }
      dir = next;
    }
    const abs = `${dir}/${name}`;
    contents.set(abs, files[rel]);
    const content = files[rel];
    childMap.get(dir)!.push({ name, path: abs, isDirectory: false, size: content.length });
  }
  return { directories: childMap, contents, dirsRead: [], filesRead: [] };
}

/**
 * 把虚拟工作区装进 window.snow 桩。
 * @param fs 虚拟工作区
 * @param [onDirectoryRead] 每次列目录完成后的副作用钩子（用例用它在中途宣布取消）
 * @returns 恢复函数：还原 window 全局
 */
function installFs(fs: VirtualFs, onDirectoryRead?: (dirPath: string) => void): () => void {
  const previous = globalThis.window;
  installWindow({
    snow: {
      readDirectoryEntries: async (dirPath) => {
        fs.dirsRead.push(dirPath);
        if (onDirectoryRead) onDirectoryRead(dirPath);
        return fs.directories.get(dirPath) || [];
      },
      readFileContent: async (filePath) => {
        fs.filesRead.push(filePath);
        return fileContent(fs.contents.get(filePath) || "");
      },
    },
  });
  return () => restoreWindow(previous);
}

/** 取扫描结果里的相对路径清单，便于逐用例断言。 */
function relPaths(files: Array<{ relPath: string }>): string[] {
  return files.map((file) => file.relPath);
}

test("HTTP 扫描: 只收 .http 与 .rest，其他扩展名不进结果", async () => {
  const fs = virtualFs({
    "top.http": "GET https://a.test\n\n",
    "alt.rest": "GET https://b.test\n\n",
    "UPPER.HTTP": "GET https://c.test\n\n",
    "readme.md": "# hi",
    "notes.txt": "x",
    ".gitignore": "",
  });
  const restore = installFs(fs);
  try {
    const result = await scanHttpRestFiles({ rootPath: ROOT });
    assert.deepEqual(relPaths(result.files), ["alt.rest", "top.http", "UPPER.HTTP"]);
    assert.equal(result.truncated, false);
    assert.equal(result.cancelled, false);
    assert.equal(result.directoriesVisited, 1);
  } finally {
    restore();
  }
});

test("HTTP 扫描: 嵌套目录按相对路径数字感知升序，且列目录确实进到各层", async () => {
  const fs = virtualFs({
    "src/api/v10/users.http": "GET https://a.test\n\n",
    "src/api/v2/users.http": "GET https://a.test\n\n",
    "src/order.rest": "GET https://a.test\n\n",
    "docs/notes.md": "x",
  });
  const restore = installFs(fs);
  try {
    const result = await scanHttpRestFiles({ rootPath: ROOT });
    assert.deepEqual(relPaths(result.files), [
      "src/api/v2/users.http",
      "src/api/v10/users.http",
      "src/order.rest",
    ]);
    assert.ok(fs.dirsRead.includes(`${ROOT}/src/api/v2`), "应进到最深层目录");
    assert.equal(result.files[0].path, `${ROOT}/src/api/v2/users.http`);
    assert.equal(result.files[0].size, "GET https://a.test\n\n".length);
  } finally {
    restore();
  }
});

test("HTTP 扫描: 根目录自身的 .gitignore 生效（base 为空串这一层不能跳过）", async () => {
  const fs = virtualFs({
    ".gitignore": "generated/\nscratch.http\n",
    "generated/kept-looking.http": "GET https://a.test\n\n",
    "scratch.http": "GET https://a.test\n\n",
    "src/api.http": "GET https://a.test\n\n",
  });
  const restore = installFs(fs);
  try {
    const result = await scanHttpRestFiles({ rootPath: ROOT });
    assert.deepEqual(relPaths(result.files), ["src/api.http"]);
    assert.ok(!fs.dirsRead.includes(`${ROOT}/generated`), "被忽略目录应剪枝，不进入");
  } finally {
    restore();
  }
});

test("HTTP 扫描: 深层 .gitignore 的取反规则把文件放回，浅层规则继续生效", async () => {
  const fs = virtualFs({
    ".gitignore": "*.http\n",
    "top.http": "GET https://a.test\n\n",
    "api/.gitignore": "!keep.http\n",
    "api/keep.http": "GET https://a.test\n\n",
    "api/drop.http": "GET https://a.test\n\n",
  });
  const restore = installFs(fs);
  try {
    const result = await scanHttpRestFiles({ rootPath: ROOT });
    assert.deepEqual(relPaths(result.files), ["api/keep.http"]);
    assert.equal(result.gitignoreRules.length, 2, "两层规则都应回传给调用方");
  } finally {
    restore();
  }
});

test("HTTP 扫描: 忽略开关关闭时命中项照样列出，且完全不读 .gitignore", async () => {
  const fs = virtualFs({
    ".gitignore": "*.http\n",
    "top.http": "GET https://a.test\n\n",
    "keep.rest": "GET https://a.test\n\n",
  });
  const restore = installFs(fs);
  try {
    const result = await scanHttpRestFiles({ rootPath: ROOT, respectGitignore: false });
    assert.deepEqual(relPaths(result.files), ["keep.rest", "top.http"]);
    assert.deepEqual(fs.filesRead, [], "开关关闭时不该发生任何文件读取");
    assert.deepEqual(result.gitignoreRules, []);
  } finally {
    restore();
  }
});

test("HTTP 扫描: 复用调用方规则时逐层不再读盘，剪枝结果与自采一致", async () => {
  const fs = virtualFs({
    "generated/a.http": "GET https://a.test\n\n",
    "src/b.rest": "GET https://a.test\n\n",
  });
  const restore = installFs(fs);
  try {
    const rules = parseGitignore("generated/\n", "");
    const result = await scanHttpRestFiles({ rootPath: ROOT, gitignoreRules: rules });
    assert.deepEqual(relPaths(result.files), ["src/b.rest"]);
    assert.deepEqual(fs.filesRead, [], "已有全仓规则时不该再读 .gitignore");
    assert.deepEqual(result.gitignoreRules, []);
    assert.ok(!fs.dirsRead.includes(`${ROOT}/generated`), "复用规则同样要剪枝");
  } finally {
    restore();
  }
});

test("HTTP 扫描: .git 一类元数据目录恒剪枝，即使忽略开关关闭", async () => {
  const fs = virtualFs({
    ".git/hooks/leak.http": "GET https://a.test\n\n",
    "src/real.http": "GET https://a.test\n\n",
  });
  const restore = installFs(fs);
  try {
    const result = await scanHttpRestFiles({ rootPath: ROOT, respectGitignore: false });
    assert.deepEqual(relPaths(result.files), ["src/real.http"]);
    assert.ok(!fs.dirsRead.includes(`${ROOT}/.git`), "整仓扫描不该进 .git");
  } finally {
    restore();
  }
});

test("HTTP 扫描: 目录预算触顶即停并如实回报截断", async () => {
  const fs = virtualFs({
    "a/one.http": "GET https://a.test\n\n",
    "a/b/two.http": "GET https://a.test\n\n",
    "a/b/c/three.http": "GET https://a.test\n\n",
  });
  const restore = installFs(fs);
  try {
    // 预算 2：只够访问根与 a/，a/b 及更深层应在门口停下。
    const result = await scanHttpRestFiles({ rootPath: ROOT, maxDirectories: 2 });
    assert.equal(result.directoriesVisited, 2);
    assert.equal(result.truncated, true);
    assert.deepEqual(relPaths(result.files), ["a/one.http"]);
    assert.ok(!fs.dirsRead.includes(`${ROOT}/a/b`), "预算用尽后不再进新目录");
  } finally {
    restore();
  }
});

test("HTTP 扫描: 取消回调命中后停在半路并回报 cancelled", async () => {
  const fs = virtualFs({
    "a/one.http": "GET https://a.test\n\n",
    "b/two.http": "GET https://a.test\n\n",
  });
  // 根目录一列完就宣布取消：两个子目录都应在入口检查处退场，于是一个文件也收不到。
  let cancelled = false;
  const restore = installFs(fs, (dirPath) => {
    if (dirPath === ROOT) cancelled = true;
  });
  try {
    const result = await scanHttpRestFiles({ rootPath: ROOT, isCancelled: () => cancelled });
    assert.equal(result.cancelled, true);
    assert.deepEqual(result.files, []);
    assert.equal(result.directoriesVisited, 1, "只访问了根目录一层");
    assert.equal(result.truncated, false, "取消不该被记成截断");
  } finally {
    restore();
  }
});

test("HTTP 扫描: 没有工作区根目录时返回空结果且不碰宿主接口", async () => {
  const fs = virtualFs({ "a.http": "GET https://a.test\n\n" });
  const restore = installFs(fs);
  try {
    const result = await scanHttpRestFiles({ rootPath: "" });
    assert.deepEqual(result, {
      files: [],
      directoriesVisited: 0,
      truncated: false,
      failedDirectories: 0,
      cancelled: false,
      gitignoreRules: [],
    });
    assert.deepEqual(fs.dirsRead, []);
  } finally {
    restore();
  }
});

test("HTTP 扫描: 列目录失败的目录如实计数，不当成空目录", async () => {
  const fs = virtualFs({
    "a/one.http": "GET https://a.test\n\n",
    "denied/two.http": "GET https://a.test\n\n",
  });
  const previous = globalThis.window;
  installWindow({
    snow: {
      readDirectoryEntries: async (dirPath: string) => {
        fs.dirsRead.push(dirPath);
        // 权限之类的问题：宿主 reject，扫描层必须把它记成「没读到」而不是「这里没有」。
        if (dirPath === `${ROOT}/denied`) throw new Error("EPERM");
        return fs.directories.get(dirPath) || [];
      },
      readFileContent: async (filePath: string) => fileContent(fs.contents.get(filePath) || ""),
    },
  });
  try {
    const result = await scanHttpRestFiles({ rootPath: ROOT });
    assert.equal(result.failedDirectories, 1);
    assert.equal(result.truncated, false, "读失败不是预算截断，两者不能混成一条");
    assert.deepEqual(relPaths(result.files), ["a/one.http"]);
  } finally {
    restoreWindow(previous);
  }
});

test("HTTP 扫描: 目录数恰好等于预算且已访问完时不算截断", async () => {
  const fs = virtualFs({ "a/one.http": "GET https://a.test\n\n" });
  const restore = installFs(fs);
  try {
    // 只有根与 a/ 两个目录，预算给 2：全部访问完，不该平白报「列表可能不完整」。
    const result = await scanHttpRestFiles({ rootPath: ROOT, maxDirectories: 2 });
    assert.equal(result.directoriesVisited, 2);
    assert.equal(result.truncated, false);
    assert.deepEqual(relPaths(result.files), ["a/one.http"]);
  } finally {
    restore();
  }
});

test("HTTP 扫描: 扩展名判定覆盖大小写与无扩展名，收录表与判定同源", async () => {
  assert.equal(isHttpRestFileName("requests.http"), true);
  assert.equal(isHttpRestFileName("API.HTTP"), true);
  assert.equal(isHttpRestFileName("api.rest"), true);
  assert.equal(isHttpRestFileName("http"), false);
  assert.equal(isHttpRestFileName(".gitignore"), false);
  assert.equal(isHttpRestFileName(""), false);
  assert.deepEqual(Array.from(HTTP_REST_EXTENSIONS), ["http", "rest"]);
  assert.equal(MAX_SCAN_DIRECTORIES, 5000);
});
