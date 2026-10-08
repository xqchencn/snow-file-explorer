/**
 * 文件树控制器的「新建文件」测试 (tests/src/controllers/tree-controller.test.ts)
 * @description 右键新建这条路上，插件自己守的边界（项目根以内、同名不覆盖）与宿主那层入参规矩
 *   是同一条链子：装机的宿主对门控写动作要求正文非空白，而这里建的正是空文件——
 *   上一轮就是栽在这道门上（弹窗说能建，落盘被拦，状态条只剩一句宿主的英文）。
 *   所以桩把两层都按装机版复刻，并额外记「这一笔走的是哪条通道」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTreeController } from "../../../src/controllers/tree-controller.ts";
import { createPanelState } from "../../../src/state/panel-state.ts";
import type { PluginRuntimeApi } from "../../../src/types/plugin-runtime.ts";
import type { SnowApi } from "../../../src/types/snow-api.ts";
import type { TranslateFn } from "../../../src/types/panel-state.ts";
import { installWindow, restoreWindow } from "../utils/window-stub.ts";
import { diskKey, listDiskChildren } from "../utils/virtual-disk.ts";

/** 翻译桩：回兜底文案并补 `{{x}}` 插值。 */
const t = ((key: string, fallback?: string, values?: Record<string, string | number>) => {
  let text = fallback || key;
  for (const [name, value] of Object.entries(values || {})) text = text.replace(`{{${name}}}`, String(value));
  return text;
}) as TranslateFn;

/**
 * 搭一块虚拟磁盘与一个文件树控制器。
 * @param options.files 初始内容（绝对路径 → 文本）
 * @param options.unreadable 列目录时抛错的目录（模拟「列不出来」）
 * @param options.writeError 给一句话时写通道 reject，用来验状态条带回的是宿主原话
 */
function harness(options: { files?: Record<string, string>; unreadable?: string[]; writeError?: string } = {}) {
  const previous = globalThis.window;
  const disks = new Map(Object.entries(options.files ?? {}).map(([path, text]) => [diskKey(path), text]));
  // 落盘的每一笔，连同它走的通道：raw = 宿主的原始写接口，gated = 受 privacy 门控的写动作。
  const writes: Array<{ filePath: string; content: string; via: "raw" | "gated" }> = [];
  const statuses: Array<{ ok: boolean; error: string }> = [];
  const previews: string[] = [];

  const snow = {
    readDirectoryEntries: async (dirPath: string) => {
      const dir = diskKey(dirPath).replace(/\/+$/, "");
      if ((options.unreadable || []).some((path) => diskKey(path) === dir)) throw new Error("Access is denied. (os error 5)");
      return listDiskChildren(disks, dir);
    },
    readFileContent: async (filePath: string) => {
      const text = disks.get(diskKey(filePath));
      // 宿主读一个不存在的文件是抛错，不是回空结果。
      if (text === undefined) throw new Error(`File does not exist: ${filePath}`);
      return { content: text, isBinary: false, isImage: false, isSvg: false, mimeType: "text/plain", encoding: "utf8", size: text.length };
    },
    writeFileContent: async (filePath: string, content: string) => {
      // 装机版这一层只要求「路径是非空白字符串、正文是字符串」，空正文照样落盘。
      if (typeof filePath !== "string" || !filePath.trim()) throw new Error("File path is required");
      if (typeof content !== "string") throw new Error("File content must be a string");
      if (options.writeError) throw new Error(options.writeError);
      const path = diskKey(filePath.trim());
      writes.push({ filePath: path, content, via: "raw" });
      disks.set(path, content);
    },
  } as unknown as SnowApi;

  const api = {
    write: {
      run: async (actionId: string, params: { filePath?: string; content?: string }) => {
        // 照装机版 admin.ts 的 filesystem.writeFile：两个入参都过 requireString，纯空白也抛。
        if (actionId === "filesystem.writeFile") {
          for (const name of ["filePath", "content"]) {
            const value = name === "filePath" ? params.filePath : params.content;
            if (typeof value !== "string" || !value.trim()) {
              return { ok: false, action: actionId, error: `Parameter '${name}' must be a non-empty string` };
            }
          }
          const gatedPath = diskKey(String(params.filePath));
          writes.push({ filePath: gatedPath, content: String(params.content), via: "gated" });
          disks.set(gatedPath, String(params.content));
          return { ok: true, action: actionId, data: { filePath: params.filePath } };
        }
        return { ok: false, action: actionId, error: "本用例只关心新建文件" };
      },
    },
  } as unknown as PluginRuntimeApi;

  const state = createPanelState();
  state.rootPath = "D:/proj";
  const controller = createTreeController({
    state,
    t,
    api,
    isDisposed: () => false,
    getLayout: () => null,
    snowApi: () => snow,
    renderTree: () => {},
    renderContextMenu: () => {},
    renderToolbar: () => {},
    applyTreeSelectionHighlight: () => {},
    closeContextMenu: () => {},
    openConfirmDialog: () => false,
    setOperationStatus: (ok, error) => statuses.push({ ok, error: error || "" }),
    previewFile: async (entry) => {
      previews.push(entry.path);
    },
    refreshGitAll: async () => {},
    resetPreviewForDeletedPaths: () => false,
    pruneSelectionForDeletedPaths: () => {},
    ensureIcons: async () => {},
  });
  installWindow({ snow });
  return { state, controller, writes, statuses, previews, restore: () => restoreWindow(previous) };
}

/**
 * 新建的就是「空文件」这一件事。
 * @description 正文一个换行是定的形状（真建一个零字节文件，编辑器与 Git 都会把它当异常）；
 *   走的必须是原始通道——门控那条不许空正文，一步都不该碰。
 */
test("文件树新建文件: 落盘的是一个换行，且不碰门控写动作", async () => {
  const scene = harness();
  try {
    const created = await scene.controller.createFileIn("D:/proj", "notes.txt");
    assert.equal(created, true);
    assert.deepEqual(scene.writes, [{ filePath: "D:/proj/notes.txt", content: "\n", via: "raw" }]);
    assert.deepEqual(scene.statuses, [{ ok: true, error: "" }], "建成了只在状态条报成功，不补一句「已创建」");
  } finally {
    scene.restore();
  }
});

/** 请求文件走与 HTTP 管理同一份模板（http-file-scan.newRequestFileTemplate），不再落空文件。 */
test("文件树新建文件: .http/.rest 落盘请求文件模板，与 HTTP 管理一致", async () => {
  const expected = "### 请求 1\nGET https://\n";
  for (const name of ["users.http", "orders.rest", "API.HTTP"]) {
    const scene = harness();
    try {
      const created = await scene.controller.createFileIn("D:/proj", name);
      assert.equal(created, true, name);
      assert.deepEqual(scene.writes, [{ filePath: `D:/proj/${name}`, content: expected, via: "raw" }]);
    } finally {
      scene.restore();
    }
  }
  // 对照：模板函数与 HTTP 控制器新建用的是同一份输出
  const { newRequestFileTemplate } = await import("../../../src/services/http-file-scan.ts");
  assert.equal(newRequestFileTemplate(t), expected, "模板唯一源输出一致");
});

/** 建完必须出现在树里并被预览，否则用户看到的是「点了没反应」。 */
test("文件树新建文件: 新文件进树、直接预览", async () => {
  const scene = harness({ files: { "D:/proj/api/orders.http": "GET https://a.test" } });
  try {
    const created = await scene.controller.createFileIn("D:/proj/api", "todo.md");
    assert.equal(created, true);
    assert.deepEqual(scene.previews, ["D:/proj/api/todo.md"], "预览的就是刚建出来的那一个");
    const dir = (scene.state.rootNodes || []).find((entry) => entry.name === "api");
    assert.equal(Boolean(dir && (dir.children || []).some((child) => child.path === "D:/proj/api/todo.md")), true, "树上得有这一行");
  } finally {
    scene.restore();
  }
});

/** 同名条目（文件与目录都算）不覆写；这条通道宿主不管覆盖，全靠插件自己拦。 */
test("文件树新建文件: 撞名与同名目录都不覆盖", async () => {
  const scene = harness({ files: { "D:/proj/notes.txt": "已有内容", "D:/proj/api/orders.http": "GET https://a.test" } });
  try {
    const taken = await scene.controller.createFileIn("D:/proj", "NOTES.TXT");
    assert.equal(taken, false, "撞名不分大小写");
    const directory = await scene.controller.createFileIn("D:/proj", "api");
    assert.equal(directory, false, "目录也占了这个位置");
    assert.deepEqual(scene.writes, [], "两次拒绝都不该往盘上落一个字");
    assert.equal(scene.statuses[0].error.includes("已经在了"), true, "要说清是没覆盖，不是建失败");
  } finally {
    scene.restore();
  }
});

/** 原始通道不校验落点，越出项目根这件事只能由插件判。 */
test("文件树新建文件: 项目根以外不建", async () => {
  const scene = harness();
  try {
    const escaped = await scene.controller.createFileIn("D:/elsewhere", "a.txt");
    assert.equal(escaped, false);
    assert.deepEqual(scene.writes, []);
    assert.equal(scene.statuses[0].ok, false);
    assert.equal(scene.statuses[0].error.includes("项目根"), true, "要说清是位置出了项目范围");
  } finally {
    scene.restore();
  }
});

/** 列目录失败时说不清有没有同名，必须停手——覆盖掉用户已有的内容比不建更糟。 */
test("文件树新建文件: 目录列不出来就不建", async () => {
  const scene = harness({ unreadable: ["D:/proj"] });
  try {
    const blocked = await scene.controller.createFileIn("D:/proj", "a.txt");
    assert.equal(blocked, false);
    assert.deepEqual(scene.writes, []);
    assert.equal(scene.statuses[0].error.includes("读不出"), true, "要说清是列不出来，不是写失败");
  } finally {
    scene.restore();
  }
});

test("文件树新建文件: 宿主写失败时把它那句原话放进状态条", async () => {
  const scene = harness({ writeError: "Access is denied. (os error 5)" });
  try {
    const failed = await scene.controller.createFileIn("D:/proj", "a.txt");
    assert.equal(failed, false);
    assert.equal(scene.statuses[0].error, "Access is denied. (os error 5)", "宿主的错误文案不自己编");
    assert.equal(scene.statuses[0].ok, false);
  } finally {
    scene.restore();
  }
});
