import test from "node:test";
import assert from "node:assert/strict";
import {
  createFileInDirectory,
  createFileRejectionMessage,
  directoryOf,
  isBuildableFileName,
  newFileNameProblem,
} from "../../../src/services/file-create.ts";
import type { CreateFileRejection, CreateFileResult } from "../../../src/services/file-create.ts";
import type { PluginRuntimeApi } from "../../../src/types/plugin-runtime.ts";
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
 * 搭一块虚拟磁盘，两层宿主都按装机版的规矩来：
 * 列目录走 `snow.readDirectoryEntries`，新建走 `snow.writeFileContent`（只要求正文是字符串，
 * 空串也收），门控写动作 `api.write.run` 装上探针——新建这条路一步都不该碰它，
 * 碰了就是把「正文不许为空白」那道检查又请回来。
 * @param options.files 初始内容（绝对路径 → 文本）
 * @param options.unreadable 列目录时抛错的目录（模拟「列不出来」）
 * @param options.writeError 给一句话时写通道 reject，用来验失败路径带回的是宿主原话
 */
function harness(options: { files?: Record<string, string>; unreadable?: string[]; writeError?: string } = {}) {
  const previous = globalThis.window;
  const disks = new Map(Object.entries(options.files ?? {}).map(([path, text]) => [diskKey(path), text]));
  const writes: Array<{ filePath: string; content: string }> = [];
  const gatedCalls: string[] = [];
  installWindow({
    snow: {
      readDirectoryEntries: async (dirPath: string) => {
        const dir = diskKey(dirPath).replace(/\/+$/, "");
        if ((options.unreadable || []).some((path) => diskKey(path) === dir)) throw new Error("Access is denied. (os error 5)");
        // 宿主的列目录把目录也当条目返回，插件的「这里有没有同名」和清单扫描都吃这一份。
        return listDiskChildren(disks, dir);
      },
      writeFileContent: async (filePath: string, content: string) => {
        // 照装机版宿主那两层：路径要是非空白字符串，正文只要求「是个字符串」，
        // 其余一律照它那样 reject，并把 trim 过的路径当作落点。
        if (typeof filePath !== "string" || !filePath.trim()) throw new Error("File path is required");
        if (typeof content !== "string") throw new Error("File content must be a string");
        if (options.writeError) throw new Error(options.writeError);
        const path = diskKey(filePath.trim());
        writes.push({ filePath: path, content });
        disks.set(path, content);
      },
    },
  });
  const api = {
    write: {
      run: async (actionId: string) => {
        gatedCalls.push(actionId);
        return { ok: false, action: actionId, error: "新建文件不该走门控写动作" };
      },
    },
  } as unknown as PluginRuntimeApi;
  return { api, writes, gatedCalls, restore: () => restoreWindow(previous) };
}

/**
 * 断言这一次确实被拦住了，并带回拦截结果。
 * @description 结果是个联合类型：写成功那支没有 `reason`。先在这里收一次，
 *   断言行里就能直接读原因，不用每条都写一遍 `if (!result.ok)`。
 */
function rejection(result: CreateFileResult) {
  if (result.ok) throw new Error(`本该拦住，却写成了 ${result.path}`);
  return result;
}

/** 每条拦截原因都得到一句用户看得懂的话；漏一条就是界面上一句 undefined。 */
test("新建文件: 每条拦截原因都有文案，撞名那句带上名字", () => {
  const reasons: CreateFileRejection[] = [
    "noRoot",
    "outsideRoot",
    "emptyName",
    "badName",
    "badExtension",
    "taken",
    "unreadableDirectory",
    "writeFailed",
  ];
  for (const reason of reasons) {
    const message = createFileRejectionMessage(t, reason, "users.rest");
    assert.equal(Boolean(message) && message !== "undefined", true, `${reason} 必须有一句话`);
  }
  assert.equal(createFileRejectionMessage(t, "taken", "users.rest"), "users.rest 已经在了，没有覆盖它");
  assert.equal(
    createFileRejectionMessage(t, "badExtension", "notes.txt", ".http / .rest"),
    "这里只建 .http / .rest 文件",
    "要说清这个入口收哪几类"
  );
});

/** 请求文件那类入口收的名单（真源是扫描那份，这里按同样的形状造一份）。 */
const REQUEST_LIKE = ["http", "rest"];

test("新建文件: 扩展名只看最后那一段，没写的留给补的那一步", () => {
  assert.equal(isBuildableFileName("users", REQUEST_LIKE), true, "没写扩展名不算填错");
  assert.equal(isBuildableFileName("api.http", REQUEST_LIKE), true);
  assert.equal(isBuildableFileName("api.HtTp", REQUEST_LIKE), true, "大小写不算两种");
  assert.equal(isBuildableFileName("archive.tar.gz", REQUEST_LIKE), false, "只看最后那一段");
  assert.equal(isBuildableFileName("notes.txt", REQUEST_LIKE), false);
  // 点起头的名字（.env、.gitignore）在这里是「带了扩展名」，不是「没写」：
  // 把它当没写就会补出 `.env.http` 这种没人要的名字，而当带了扩展名才会拦下来。
  assert.equal(isBuildableFileName(".env", REQUEST_LIKE), false);
  assert.equal(isBuildableFileName("notes.txt", []), true, "空名单就是什么都收");
});

test("新建文件: 名字能不能交就判三条——空、带路径字符、扩展名不在名单", () => {
  assert.equal(newFileNameProblem(t, "", REQUEST_LIKE, ".http / .rest"), "文件名没给，建不了");
  assert.equal(newFileNameProblem(t, "   ", REQUEST_LIKE, ".http / .rest"), "文件名没给，建不了");
  assert.equal(String(newFileNameProblem(t, "a/b", REQUEST_LIKE)).includes("不能带这些字符"), true);
  assert.equal(newFileNameProblem(t, "notes.txt", REQUEST_LIKE, ".http / .rest"), "这里只建 .http / .rest 文件");
  // 没写扩展名不算填错：那一段由落盘那边补（补的就是名单里那一段）。
  assert.equal(newFileNameProblem(t, "users", REQUEST_LIKE, ".http / .rest"), null);
  assert.equal(newFileNameProblem(t, "users.REST", REQUEST_LIKE, ".http / .rest"), null, "扩展名不分大小写");
  assert.equal(newFileNameProblem(t, "api.http", REQUEST_LIKE, ".http / .rest"), null);
  // 不收名单的入口（文件树）什么都建得了：代码编辑器要建 .ts / .json / Dockerfile 这一类。
  assert.equal(newFileNameProblem(t, "notes.txt", []), null);
  assert.equal(newFileNameProblem(t, "Dockerfile", []), null);
});

test("新建文件: 名单外的扩展名不落盘，界面上没拦住也要拦住", async () => {
  const scene = harness({ files: { "D:/proj/api/keep.http": "GET https://a.test" } });
  try {
    const rejected = await createFileInDirectory({
      rootPath: "D:/proj",
      directoryPath: "D:/proj/api",
      fileName: "notes.txt",
      content: "x",
      extension: ".http",
      allowedExtensions: REQUEST_LIKE,
    });
    assert.equal(rejection(rejected).reason, "badExtension");
    assert.equal(rejected.name, "notes.txt", "说的就是用户打的那一个名字");
    assert.equal(scene.writes.length, 0, "拦下来就不该有任何写动作");

    const typed = await createFileInDirectory({
      rootPath: "D:/proj",
      directoryPath: "D:/proj/api",
      fileName: "users.rest",
      content: "GET https://a.test",
      extension: ".http",
      allowedExtensions: REQUEST_LIKE,
    });
    assert.equal(typed.ok && typed.name, "users.rest", "名单里的两种写法都收，且不许被补成 users.rest.http");

    const bare = await createFileInDirectory({
      rootPath: "D:/proj",
      directoryPath: "D:/proj/api",
      fileName: "orders",
      content: "GET https://a.test",
      extension: ".http",
      allowedExtensions: REQUEST_LIKE,
    });
    assert.equal(bare.ok && bare.name, "orders.http", "没写的补默认那一段");
  } finally {
    scene.restore();
  }
});

test("新建文件: 没打开项目与越出项目根都不落盘", async () => {
  const scene = harness();
  try {
    const noRoot = await createFileInDirectory({ rootPath: "", directoryPath: "", fileName: "a.txt", content: "" });
    assert.deepEqual(noRoot, { ok: false, reason: "noRoot", name: "", error: null });

    const outside = await createFileInDirectory({
      rootPath: "D:/proj",
      directoryPath: "D:/elsewhere",
      fileName: "a.txt",
      content: "",
    });
    assert.equal(outside.ok, false);
    assert.equal(rejection(outside).reason, "outsideRoot");

    // 目录本身在根内、但结尾的 .. 会把落点带出去：两头都要查。
    const trailing = await createFileInDirectory({
      rootPath: "D:/proj",
      directoryPath: "D:/proj/../..",
      fileName: "a.txt",
      content: "",
    });
    assert.equal(rejection(trailing).reason, "outsideRoot");
    assert.equal(scene.writes.length, 0, "三次拒绝一次都不该写盘");
  } finally {
    scene.restore();
  }
});

test("新建文件: 空名字与脏名字都拦住", async () => {
  const scene = harness();
  try {
    const empty = await createFileInDirectory({ rootPath: "D:/proj", directoryPath: "", fileName: "   ", content: "" });
    assert.equal(rejection(empty).reason, "emptyName");
    for (const bad of ["a/b.txt", "a\\b.txt", "a:b.txt", "a?.txt", "..", "a..b.txt"]) {
      const rejected = await createFileInDirectory({ rootPath: "D:/proj", directoryPath: "", fileName: bad, content: "" });
      assert.equal(rejection(rejected).reason, "badName", `${bad} 不该被当成文件名`);
    }
    assert.equal(scene.writes.length, 0);
  } finally {
    scene.restore();
  }
});

test("新建文件: 没扩展名才补，已经带了的原样留着", async () => {
  const scene = harness();
  try {
    const added = await createFileInDirectory({
      rootPath: "D:/proj",
      directoryPath: "",
      fileName: "users",
      content: "x",
      extension: ".rest",
    });
    assert.equal(added.ok && added.name, "users.rest", "缺扩展名才补");

    const kept = await createFileInDirectory({
      rootPath: "D:/proj",
      directoryPath: "",
      fileName: "api.http",
      content: "x",
      extension: ".rest",
    });
    assert.equal(kept.ok && kept.name, "api.http", "已经带扩展名的不许补成 api.http.rest");

    const plain = await createFileInDirectory({ rootPath: "D:/proj", directoryPath: "", fileName: "notes", content: "x" });
    assert.equal(plain.ok && plain.name, "notes", "不给扩展名就不补");
  } finally {
    scene.restore();
  }
});

test("新建文件: 同名条目（含大小写不同）一律不覆盖", async () => {
  const scene = harness({ files: { "D:/proj/notes.txt": "已有内容" } });
  try {
    const taken = await createFileInDirectory({ rootPath: "D:/proj", directoryPath: "", fileName: "NOTES.TXT", content: "" });
    assert.equal(rejection(taken).reason, "taken", "撞名不分大小写");
    assert.equal(taken.name, "NOTES.TXT", "说的是用户那个名字的最终形状");
    assert.equal(scene.writes.length, 0, "撞名之后一个字都不该写");
    assert.equal(scene.writes.some((write) => write.filePath === "D:/proj/notes.txt"), false, "不许覆掉已有文件");
  } finally {
    scene.restore();
  }
});

/**
 * 新建文件的落点跟着刚点的那一处，而「那一处」常常是当前选中的那个文件——要的是它旁边那一个。
 * @description 空串是有意义的值（就是项目根），不是「没算出来」：调用方据此才不至于把根下的文件
 *   再往上一层放。
 */
test("新建文件: 选中的文件落在哪一层，就在那一层里建", () => {
  assert.equal(directoryOf("api/orders.http"), "api");
  assert.equal(directoryOf("a/b/c.http"), "a/b", "多层目录只刨掉最后那一段");
  assert.equal(directoryOf("orders.http"), "", "就在项目根下：空串就是根");
  assert.equal(directoryOf("api\\orders.http"), "api", "两种分隔符都认");
  assert.equal(directoryOf(""), "");
});

/**
 * 新建文件: 同名的目录也算占了位。
 * @description 往目录同名的位置写文件是另一种失败（宿主页面上报的不是「撞名」），
 *   列目录能认出目录，这里就得当场拦下来——拦不住就是让用户对着一个看不懂的错误码。
 */
test("新建文件: 目标目录里已有同名目录时也拦下", async () => {
  const scene = harness({ files: { "D:/proj/api/orders.http": "GET https://a.test" } });
  try {
    const taken = await createFileInDirectory({ rootPath: "D:/proj", directoryPath: "", fileName: "api", content: "" });
    assert.equal(rejection(taken).reason, "taken", "api 这个目录已经占了这个位置");
    assert.equal(scene.writes.length, 0);
  } finally {
    scene.restore();
  }
});

test("新建文件: 目录列不出来就停手，别把说不清当成没有", async () => {
  const scene = harness({ unreadable: ["D:/proj"] });
  try {
    const blocked = await createFileInDirectory({ rootPath: "D:/proj", directoryPath: "", fileName: "a.txt", content: "" });
    assert.equal(rejection(blocked).reason, "unreadableDirectory");
    assert.equal(scene.writes.length, 0);
  } finally {
    scene.restore();
  }
});

/**
 * 「空正文也建得出来」——新建文件走的就是这条断言。
 * @description 门控写动作对正文有一道「不许为空白」的检查，空文件会被它在写盘那一步挡下来，
 *   而弹窗早就说了「能建」，界面与落盘两头各判一套。换到原始写通道之后，
 *   这条路再也没碰过门控动作：探针（gatedCalls）与空正文都能同时成立才算改对。
 */
test("新建文件: 正文一个字符都没有也照样建出来，且不碰门控写动作", async () => {
  const scene = harness();
  try {
    const created = await createFileInDirectory({ rootPath: "D:/proj", directoryPath: "", fileName: "notes.txt", content: "" });
    assert.equal(created.ok, true, "空正文不是拦下来的理由");
    assert.deepEqual(scene.writes, [{ filePath: "D:/proj/notes.txt", content: "" }]);

    const oneLine = await createFileInDirectory({ rootPath: "D:/proj", directoryPath: "", fileName: "a.md", content: "\n" });
    assert.equal(oneLine.ok, true);
    assert.deepEqual(scene.writes[1], { filePath: "D:/proj/a.md", content: "\n" });
    assert.deepEqual(scene.gatedCalls, [], "新建一个字都不该走门控写动作");
  } finally {
    scene.restore();
  }
});

test("新建文件: 写失败时把宿主原话带回去，成功时路径与内容都对", async () => {
  const failed = harness({ writeError: "Access is denied. (os error 5)" });
  try {
    const result = await createFileInDirectory({ rootPath: "D:/proj", directoryPath: "", fileName: "a.txt", content: "x" });
    assert.equal(rejection(result).reason, "writeFailed");
    assert.equal(rejection(result).error, "Access is denied. (os error 5)", "宿主的错误原话留给状态条，不自己编");
  } finally {
    failed.restore();
  }

  const scene = harness({ files: { "D:/proj/api/users.rest": "GET https://a.test" } });
  try {
    const created = await createFileInDirectory({
      rootPath: "D:/proj",
      directoryPath: "D:/proj/api",
      fileName: "orders.rest",
      content: "### 新请求",
    });
    assert.equal(created.ok, true);
    assert.equal(created.ok && created.path, "D:/proj/api/orders.rest", "落在指定的目录里");
    assert.deepEqual(scene.writes, [{ filePath: "D:/proj/api/orders.rest", content: "### 新请求" }]);
  } finally {
    scene.restore();
  }
});
