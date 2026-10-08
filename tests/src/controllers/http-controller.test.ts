/**
 * HTTP 控制器状态机测试 (tests/src/controllers/http-controller.test.ts)
 * @description 这里只钉住「用户能看见的后果」：发送按钮还能不能按、响应还认不认得出是这条请求的、
 *   切换视图后改动会不会落进空文档。三条阻断级缺陷都出在这个状态机里，之前一条覆盖都没有。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHttpController } from "../../../src/controllers/http-controller.ts";
import type { HttpControllerDeps } from "../../../src/controllers/http-controller.ts";
import { createPanelState } from "../../../src/state/panel-state.ts";
import { parseHttpFile } from "../../../src/services/http-request-parser.ts";
import { formValuesOfRequest } from "../../../src/services/http-serialize.ts";
import { installWindow, restoreWindow } from "../utils/window-stub.ts";
import { diskKey, listDiskChildren } from "../utils/virtual-disk.ts";
import { pluginConfigDirectory, ENVIRONMENT_FILE_NAME, PRIVATE_ENVIRONMENT_FILE_NAME, SHARED_ENVIRONMENT_NAME } from "../../../src/services/http-env.ts";

/** 翻译桩：按下标页面的 `{{name}}` 口径插值，否则断言里看到的是没换过的占位符。 */
const t = (key: string, fallback?: string, params?: Record<string, unknown>) => {
  const text = fallback || key;
  if (!params) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params[name] ?? ""));
};

/** 一次宿主响应的最小形状（PluginNetResponse）。 */
function netResponse(url: string, body = "", status = 200) {
  return { ok: true, status, statusText: "OK", headers: {}, body, url, error: null };
}

/** 一次「已打开某个 .http 文件」的面板状态与控制器的组装结果。 */
type Harness = {
  state: ReturnType<typeof createPanelState>;
  controller: ReturnType<typeof createHttpController>;
  /** 未自动应答时，挂在通道上的在飞请求；用例决定何时放行。 */
  pending: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }>;
  /** 通道实际收到的地址。 */
  calls: string[];
  /** 面板状态条收到的文案。 */
  statuses: string[];
};

/**
 * 搭一个「HTTP 视图已打开某个文件」的场景。
 * @param text 该 .http 文件的正文
 * @param fetchImpl 代发通道；缺省时把请求挂起，交用例用 pending 放行
 * @returns 状态、控制器与观测点
 */
function openDocument(text: string, fetchImpl?: (url: string) => Promise<unknown>, extra?: Partial<HttpControllerDeps>): Harness {
  const state = createPanelState();
  state.rootPath = "D:/proj";
  state.httpSelected = "D:/proj/api.http";
  state.preview = {
    kind: "text",
    name: "api.http",
    path: "D:/proj/api.http",
    text,
    isMarkdown: false,
    mode: "preview",
    html: "",
    editable: true,
    saveState: "idle",
    saveMessage: "",
  };
  const file = parseHttpFile(text);
  state.httpFile = file;
  state.httpForms = new Map(file.requests.map((request, index) => [index, formValuesOfRequest(request)]));

  const pending: Harness["pending"] = [];
  const calls: string[] = [];
  const statuses: string[] = [];
  const controller = createHttpController({
    state,
    t,
    api: {
      net: {
        fetch: (url: string) =>
          fetchImpl
            ? fetchImpl(url)
            : new Promise((resolve, reject) => {
                pending.push({ resolve, reject });
              }),
      },
    } as never,
    isDisposed: () => false,
    renderHttpPane: () => {},
    renderHttpPreview: () => {},
    previewFile: async () => {},
    savePreview: async () => {
      state.preview.saveState = "saved";
    },
    setStatus: (value) => statuses.push(value),
    ...extra,
  });
  return { state, controller, pending, calls, statuses };
}

/** 让已排队的微任务跑完（fetch 进入在飞状态）。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("HTTP 控制器: 发送途中失焦提交（重解析）后响应仍记账，且发送态复位", async () => {
  const { state, controller, pending } = openDocument("### 一\nGET https://a.test/one\n");
  const sending = controller.send(0);
  await tick();
  assert.equal(state.httpRunning, 0, "发送中");

  // 焦点离开卡片 → commit → 重解析：同一份正文、同一个文件，只是解析结果换了新对象。
  await controller.commit();
  assert.ok(state.httpFile, "重解析后解析结果还在");

  pending[0].resolve(netResponse("https://a.test/one", "{}"));
  await sending;
  assert.equal(state.httpRunning, null, "复位是「发送按钮还能不能再按」的唯一开关");
  assert.equal(state.httpResponses.size, 1, "同一个文件的重解析不该把在飞响应丢掉");
});

test("HTTP 控制器: 发送途中改字段后发送态仍复位（不再永久卡在发送中）", async () => {
  const { state, controller, pending } = openDocument("### 一\nGET https://a.test/one\n");
  const parsed = state.httpFile!;
  const sending = controller.send(0);
  await tick();

  controller.handleFormChange(0, { ...formValuesOfRequest(parsed.requests[0]), url: "https://a.test/edited" });
  pending[0].resolve(netResponse("https://a.test/one", "{}"));
  await sending;

  assert.equal(state.httpRunning, null);
  assert.equal(state.httpResponses.size, 0, "地址已经改过，旧请求的响应不该挂在这一格上");
});

test("HTTP 控制器: 代发通道抛错时收敛成结果，不复位丢失也不往外抛", async () => {
  const { state, controller } = openDocument("GET https://a.test/one\n", () => Promise.reject(new Error("boom")));
  await controller.send(0);
  assert.equal(state.httpRunning, null);
  assert.equal(state.httpResponses.get(0)?.error, "boom");
});

test("HTTP 控制器: 发送途中再点一次发送被挡下，同一时刻只发一条", async () => {
  const { controller, pending } = openDocument("GET https://a.test/one\n");
  const sending = controller.send(0);
  await tick();
  await controller.send(0);
  assert.equal(pending.length, 1, "变量作用域与响应表都按下标挂，并发两条只会互相踩");
  pending[0].resolve(netResponse("https://a.test/one"));
  await sending;
});

test("HTTP 控制器: 正文与清单不同源时整体清场，GUI 改动不再写进空缓冲", () => {
  const { state, controller } = openDocument("### 一\nGET https://a.test/one\n");
  // 模拟「切到文件视图打开了别的文件、再切回 HTTP 视图」：正文没了，解析结果还在。
  state.preview = { ...createPanelState().preview };

  assert.equal(controller.syncWithSelection(), true, "对不上就两边一起清");
  assert.equal(state.httpFile, null);

  controller.handleFormChange(0, { method: "GET", url: "https://x", headers: [], body: null });
  assert.equal(state.preview.text, "", "改动不该被写进一份不存在的正文");
  assert.equal(controller.isDirty(), false, "更不该留下一个永远清不掉的假「未保存」");
});

test("HTTP 控制器: 清单选中项与正文一致时不清场", () => {
  const { controller, state } = openDocument("### 一\nGET https://a.test/one\n");
  assert.equal(controller.syncWithSelection(), false);
  assert.ok(state.httpFile);
});

test("HTTP 控制器: 文本编辑让请求下标漂移后，旧响应不挂到别的请求上", async () => {
  const { state, controller, pending } = openDocument("### A\n# @name alpha\nGET https://a.test/alpha\n");
  const sending = controller.send(0);
  await tick();
  pending[0].resolve(netResponse("https://a.test/alpha", '{"token":"x"}'));
  await sending;
  assert.equal(state.httpResponses.size, 1);

  // 在原请求前面插一条：下标重排，alpha 从 #0 变成 #1。
  state.preview.text = "### X\nGET https://a.test/x\n\n### A\n# @name alpha\nGET https://a.test/alpha\n";
  state.httpDirty = true;
  await controller.commit();

  assert.equal(state.httpResponses.size, 0, "身份对不上的响应宁可丢掉，也不能让请求变量取到别人的响应体");
});

test("HTTP 控制器: # @prompt 没填就不当作已解析，原样发出并点名告警", async () => {
  const text = "### 要令牌\n# @prompt token 访问令牌\nGET https://a.test/me?t={{token}}\n";
  const { state, controller, calls } = openDocument(text, async (url) => {
    calls.push(url);
    return netResponse(url);
  });
  await controller.send(0);

  assert.equal(calls[0].includes("{{token}}"), true, "没填就该原样发（并说明），而不是把空值当已解析发出去");
  const result = state.httpResponses.get(0);
  assert.deepEqual(result?.unresolved, ["token"]);
  assert.equal(result?.warnings.some((warning) => warning.includes("token")), true, "告警要点名，用户才知道是哪个变量");
});

test("HTTP 控制器: 填了 # @prompt 的值就替换进地址", async () => {
  const text = "### 要令牌\n# @prompt token 访问令牌\nGET https://a.test/me?t={{token}}\n";
  const { controller, calls } = openDocument(text, async (url) => {
    calls.push(url);
    return netResponse(url);
  });
  controller.handlePromptChange(0, "token", "abc123");
  await controller.send(0);
  assert.equal(calls[0], "https://a.test/me?t=abc123");
});

test("HTTP 控制器: 正文里写出分节行会真的多出一条请求，并在状态条说明", () => {
  const { state, controller, statuses } = openDocument('POST https://a.test/x\n\n{"a":1}\n');
  const parsed = state.httpFile!;
  controller.handleFormChange(0, { ...formValuesOfRequest(parsed.requests[0]), body: '{"a":1}\n### 新一节\nmore' });
  assert.equal(state.httpFile?.requests.length, 2, "`###` 是文件格式的一部分，写出来就真的新开一节");
  assert.equal(statuses.some((text) => text.includes("###")), true, "得让用户知道多出来的那条不是界面出错");
});

test("HTTP 控制器: 文本态改动在状态条上常驻「有未保存的改动」", async () => {
  const { state, controller, statuses } = openDocument("### 一\nGET https://a.test/one\n");
  state.httpMode = "text";
  // 文本态没有 GUI 的脏条，改动的可见反馈只有面板状态条这一条。
  controller.markDirty();
  assert.equal(statuses[0]?.includes("未保存"), true, JSON.stringify(statuses));
});

test("HTTP 控制器: 文本态发送完把结果交给右分栏，不跳形态也不重建左栏", async () => {
  const persisted: string[] = [];
  let resultPanes = 0;
  let previews = 0;
  const { state, controller } = openDocument("### 一\nGET https://a.test/one\n", undefined, {
    api: {
      net: { fetch: async (url: string) => netResponse(url, '{"id":1}') },
      storage: {
        setJson: (_key: string, value: unknown) => {
          persisted.push(String(value));
          return Promise.resolve();
        },
      },
    } as never,
    renderHttpResultPane: () => {
      resultPanes += 1;
    },
    renderHttpPreview: () => {
      previews += 1;
    },
  });
  state.httpMode = "text";
  await controller.send(0);

  assert.equal(state.httpMode, "text", "文本态就用左右分栏摆结果，不必把用户甩去 GUI");
  assert.equal(controller.resultIndex(), 0, "右分栏要知道显示哪一条");
  assert.equal(resultPanes >= 1, true, "结果只刷右分栏");
  assert.equal(previews, 0, "左边代码查看器一动不动：重建会丢光标，也会摘掉刚点的 ▶");
  assert.deepEqual(persisted, [], "不该顺手改写用户的查看形态偏好");
});

test("HTTP 控制器: 提交不重建查看器（两种形态都一样）", async () => {
  let renders = 0;
  const { state, controller } = openDocument("### 一\nGET https://a.test/one\n", undefined, {
    renderHttpPreview: () => {
      renders += 1;
    },
  });
  // 让正文真的多出一条请求：这是「形状变了」的最强形态，重绘依然不该发生。
  state.preview.text = "### 新\nGET https://a.test/new\n\n### 一\nGET https://a.test/one\n";
  state.httpDirty = true;
  state.httpMode = "text";
  await controller.commit();
  assert.equal(renders, 0, "文本态重建会销毁 textarea，也会在 click 派发前把 ▶ 摘掉（表现为点了没反应）");

  state.httpMode = "gui";
  await controller.commit();
  assert.equal(renders, 0, "GUI 的清单刷新由 handleFormChange / 发送 / 折叠自己负责，提交不必重画");
  assert.equal(state.httpFile?.requests.length, 2, "但解析结果确实已经跟着正文更新了");
});

test("HTTP 控制器: 有未保存改动时换文件先问一句，用户拒绝就不换", async () => {
  const { state, controller } = openDocument("### 一\nGET https://a.test/one\n", undefined, {
    confirmDiscard: async () => false,
  });
  state.httpDirty = true;

  await controller.openFile({ name: "other.http", path: "D:/proj/other.http", relPath: "other.http", size: 10 });
  assert.equal(state.httpSelected, "D:/proj/api.http", "拒绝了就留在原文件");
  assert.ok(state.httpDirty, "改动还在");

  const { state: agreed, controller: agreeing } = openDocument("### 一\nGET https://a.test/one\n", undefined, {
    confirmDiscard: async () => true,
  });
  agreed.httpDirty = true;
  await agreeing.openFile({ name: "other.http", path: "D:/proj/other.http", relPath: "other.http", size: 10 });
  assert.equal(agreed.httpSelected, "D:/proj/other.http", "同意了才换");
});

test("HTTP 控制器: 没有未保存改动时不打扰用户", async () => {
  let asked = 0;
  const { controller } = openDocument("### 一\nGET https://a.test/one\n", undefined, {
    confirmDiscard: async () => {
      asked += 1;
      return true;
    },
  });
  await controller.openFile({ name: "other.http", path: "D:/proj/other.http", relPath: "other.http", size: 10 });
  assert.equal(asked, 0);
});

test("HTTP 控制器: 焦点离开卡片不会重建面板（否则刚点的输入框被销毁）", async () => {
  let renders = 0;
  const { state, controller } = openDocument("### 一\nGET https://a.test/one\n", undefined, {
    renderHttpPreview: () => {
      renders += 1;
    },
  });
  const parsed = state.httpFile!;
  // 改一个字段（写入缓冲）后失焦：清单形状没变，就不该重绘。
  controller.handleFormChange(0, { ...formValuesOfRequest(parsed.requests[0]), url: "https://a.test/edited" });
  state.httpDirty = true;
  await controller.commit();
  assert.equal(renders, 0, "重建会把用户刚要输入的框连焦点一起换掉");

  // 就算正文里插了一个分节行（清单真的多出一条），也不在这里重绘：
  // 那个时机的重绘会把正在点的 ▶ 一起摘掉，刷新交给发送/折叠/换文件那几条路径。
  state.preview.text = "### 二\nGET https://a.test/two\n\n### 一\nGET https://a.test/edited\n";
  state.httpDirty = true;
  await controller.commit();
  assert.equal(renders, 0);
  assert.equal(state.httpFile?.requests.length, 2, "解析结果本身照旧跟上");
});

test("HTTP 控制器: 一次只聚焦一条请求，展开新的会收起旧的，再点同一条回到列表", () => {
  const { state, controller } = openDocument("### 一\nGET https://a.test/one\n\n### 二\nGET https://a.test/two\n");
  controller.toggleExpand("r0");
  assert.deepEqual([...state.httpExpanded], ["r0"], "展开第一条即聚焦它");
  controller.toggleExpand("r1");
  assert.deepEqual([...state.httpExpanded], ["r1"], "聚焦第二条，第一条自动收起");
  controller.toggleExpand("r1");
  assert.deepEqual([...state.httpExpanded], [], "再点同一条收起，回到全是列表行");
});

test("HTTP 控制器: 发送时聚焦该条请求，且该条此后默认收起请求区（折叠再展开仍记得）", async () => {
  const { state, controller, pending } = openDocument("### 一\nGET https://a.test/one\n\n### 二\nGET https://a.test/two\n");
  const sending = controller.send(1);
  await tick();
  assert.deepEqual([...state.httpExpanded], ["r1"], "发送哪条就聚焦哪条");
  pending[0].resolve(netResponse("https://a.test/two", "{}"));
  await sending;
  assert.deepEqual([...state.httpExpanded], ["r1"], "响应回来后仍停在聚焦的那条");
  assert.equal(state.httpBodyCollapsed.has(1), true, "发完之后该条默认收起请求区，只留结果");

  // 关键回归：折叠卡片再展开，不能被「别的请求的展开」带偏——
  // 该条发过就仍是收起态，没发过的另一条仍是摊开态。
  controller.toggleExpand("r1");
  assert.deepEqual([...state.httpExpanded], [], "再点同一条收起");
  controller.toggleExpand("r0");
  assert.equal(state.httpBodyCollapsed.has(0), false, "0 号没发过，不收起请求区");
  controller.toggleExpand("r1");
  assert.equal(state.httpBodyCollapsed.has(1), true, "回到 1 号，它发过，仍是收起态");
});

test("HTTP 控制器: 手动重开请求区后，折叠再展开仍保持用户的选择", async () => {
  const { state, controller, pending } = openDocument("### 一\nGET https://a.test/one\n");
  const sending = controller.send(0);
  await tick();
  pending[0].resolve(netResponse("https://a.test/one", "{}"));
  await sending;
  assert.equal(state.httpBodyCollapsed.has(0), true, "发完默认收起");
  // 用户点「展开请求区」重开编辑
  controller.setRequestBodyOpen(0, true);
  assert.equal(state.httpBodyCollapsed.has(0), false, "重开后不再收起");
  controller.toggleExpand("r0");
  controller.toggleExpand("r0");
  assert.equal(state.httpBodyCollapsed.has(0), false, "折叠再展开仍保持用户重开的选择");
});

test("HTTP 控制器: 根目录尚未就绪时扫描是空操作，就绪后再扫必须扫得到", async () => {
  // 回归：面板挂载时侧边栏按钮先建好，根目录要等异步 IPC 才写入。
  // 用户在这段空窗里点「HTTP 请求」，那次 rescan 看到的是空 rootPath。
  // 它绝不能把「空根」当成「已扫过」记进缓存——否则根目录到位后补扫会被短路掉，
  // 列表永远空着，直到用户先切去文件视图再切回来（那才第二次触发扫描）。
  const previous = globalThis.window;
  installWindow({
    snow: {
      readDirectoryEntries: async (dirPath: string) =>
        dirPath === "D:/proj"
          ? [{ name: "api.http", path: "D:/proj/api.http", isDirectory: false, size: 12 }]
          : [],
      // 扫描器只在目录里真出现 .gitignore 时才读文件；本用例的根目录没有它，这个桩不会被调到。
      readFileContent: async () => ({
        content: "",
        isBinary: false,
        isImage: false,
        isSvg: false,
        mimeType: "text/plain",
        encoding: "utf8",
        size: 0,
      }),
    },
  });
  try {
    const state = createPanelState();
    state.rootPath = ""; // 根目录还没到位
    const controller = createHttpController({
      state,
      t,
      api: {} as never,
      isDisposed: () => false,
      renderHttpPane: () => {},
      renderHttpPreview: () => {},
      previewFile: async () => {},
      savePreview: async () => {},
    });

    await controller.rescan();
    assert.equal(state.httpFiles.length, 0, "空根扫描不出东西");

    // 根目录就绪：补扫必须真的扫，而不是被「本根已扫过」短路。
    state.rootPath = "D:/proj";
    await controller.rescan();
    assert.deepEqual(
      state.httpFiles.map((file) => file.relPath),
      ["api.http"],
      "根目录就绪后的补扫必须扫得到，否则列表永远空着"
    );
  } finally {
    restoreWindow(previous);
  }
});

/** 环境表该落的那个位置（写动作的落点断言都对着它）。 */
const ENV_TARGET = `${pluginConfigDirectory("D:/proj")}/${ENVIRONMENT_FILE_NAME}`;

/**
 * 搭一块虚拟磁盘：读文件与列目录走 window.snow，写盘走 api.write.run。
 * @description 创建与保存这两条路要看的正是「真实写到了哪个路径、写了什么内容」，
 *   所以写成功时把内容同步并进磁盘，后面的重读断言才有东西可读。
 *   读一个不存在的文件按宿主原话抛 `File does not exist: 路径`——它不是回一份空结果，
 *   「这里没有」这件事在宿主那边长得就像失败，桩必须一样，否则测不出真实形状。
 * @param options.files 初始磁盘内容（绝对路径 → 文本）
 * @param options.writeResult 给一个 ok:false 时，写通道原样回它，用来验失败路径
 * @param options.readFails 读盘通道整体坏掉（列目录也抛错），用来验「说不清就不许落盘」
 */
function writeHarness(options: { files?: Record<string, string>; writeResult?: unknown; readFails?: boolean } = {}) {
  const previous = globalThis.window;
  const key = diskKey;
  const disks = new Map(Object.entries(options.files ?? {}).map(([path, text]) => [key(path), text]));
  const writes: Array<{ filePath: string; content: string }> = [];
  // 落盘走的是哪一层：门控写动作（api.write.run）还是新建文件用的原始通道。
  // 两条路的入参规矩不一样（前者不许空正文，后者只要求「是个字符串」），
  // 混在一份清单里就看不出「新建其实撞了前者的门」。
  const via: string[] = [];
  const statuses: string[] = [];
  const renders: number[] = [];
  const previews: string[] = [];
  function fail(message: string): never {
    throw new Error(message);
  }
  installWindow({
    snow: {
      readDirectoryEntries: async (dirPath: string) => {
        if (options.readFails) fail("Access is denied. (os error 5)");
        // 目录条目也照宿主那样回：请求文件清单要能钻进子目录，新建完的文件才列得出来。
        return listDiskChildren(disks, key(dirPath));
      },
      readFileContent: async (filePath: string) => {
        if (options.readFails) fail("Access is denied. (os error 5)");
        const text = disks.get(key(filePath));
        if (text === undefined) fail(`File does not exist: ${filePath}`);
        return {
          content: text,
          isBinary: false,
          isImage: false,
          isSvg: false,
          mimeType: "application/json",
          encoding: "utf8",
          size: text.length,
        };
      },
      writeFileContent: async (filePath: string, content: string) => {
        // 装机版宿主这一层只要求「路径是非空白字符串、正文是字符串」，空正文照样落盘。
        if (typeof filePath !== "string" || !filePath.trim()) fail("File path is required");
        if (typeof content !== "string") fail("File content must be a string");
        const path = key(filePath.trim());
        writes.push({ filePath: path, content });
        via.push("raw");
        disks.set(path, content);
      },
    },
  });
  const state = createPanelState();
  state.rootPath = "D:/proj";
  state.httpSelected = "D:/proj/api.http";
  const controller = createHttpController({
    state,
    t,
    api: {
      net: { fetch: async () => netResponse("https://a.test/x") },
      write: {
        run: async (actionId: string, params: { filePath: string; content: string }) => {
          // 照装机版 admin.ts 的 filesystem.writeFile：两个入参都过 requireString，纯空白也抛。
          if (actionId === "filesystem.writeFile") {
            for (const name of ["filePath", "content"]) {
              const value = name === "filePath" ? params.filePath : params.content;
              if (typeof value !== "string" || !value.trim()) {
                return { ok: false, action: actionId, error: `Parameter '${name}' must be a non-empty string` };
              }
            }
          }
          const path = key(params.filePath);
          writes.push({ filePath: path, content: params.content });
          via.push("gated");
          if (options.writeResult && (options.writeResult as { ok?: boolean }).ok === false) return options.writeResult;
          disks.set(path, params.content);
          return { ok: true, action: actionId, data: { filePath: params.filePath } };
        },
      },
    } as never,
    isDisposed: () => false,
    renderHttpPane: () => {},
    renderHttpPreview: () => {
      renders.push(1);
    },
    previewFile: async (entry) => {
      previews.push(entry.path);
    },
    savePreview: async () => {},
    setStatus: (value) => statuses.push(value),
  });
  return { state, controller, writes, via, statuses, renders, previews, restore: () => restoreWindow(previous) };
}

test("HTTP 控制器: 一份表都没有时第一次保存就把文件建出来，落点是配置目录", async () => {
  const scene = writeHarness();
  try {
    const saved = await scene.controller.saveEnvironmentTables([
      { name: "local", variables: [{ key: "host", value: "l.test" }] },
    ]);
    assert.equal(saved, true);
    assert.equal(scene.writes.length, 1, "只写公开表那一份");
    assert.equal(scene.writes[0].filePath, ENV_TARGET, "宿主的写动作连父目录一起建，落点必须在配置目录里");
    assert.deepEqual(scene.controller.environmentSummary().names, ["local"], "写完立刻重读，界面不用再点一次文件");
    assert.equal(scene.renders.length, 1, "写成了才重画：弹窗这时已经关了，没有正在敲的格子");
    assert.equal(
      scene.statuses.some((line) => line.includes("读不出") || line.includes("目录读不出")),
      false,
      "缺文件是宿主的正常回答，不许当成「读不通」报给用户"
    );
  } finally {
    scene.restore();
  }
});

test("HTTP 控制器: 保存只碰公开表，私密表那份原样留着", async () => {
  const privateTarget = `${pluginConfigDirectory("D:/proj")}/${PRIVATE_ENVIRONMENT_FILE_NAME}`;
  const scene = writeHarness({
    files: {
      [ENV_TARGET]: JSON.stringify({ local: { host: "mine.test" } }),
      [privateTarget]: JSON.stringify({ local: { token: "secret" } }),
    },
  });
  try {
    await scene.controller.saveEnvironmentTables([
      { name: "local", variables: [{ key: "host", value: "next.test" }] },
    ]);
    assert.deepEqual(scene.writes.map((write) => write.filePath), [ENV_TARGET], "一次都不该写到私密表那里");
    const summary = scene.controller.environmentSummary();
    assert.equal(summary.tables.get("local")?.get("host"), "next.test", "公开表写回来的就是弹窗那一份");
    assert.equal(summary.names.join(","), "local", "私密表里的段没被当成新增环境冒出来");
    assert.deepEqual(summary.privateKeys, ["local/token"], "私密表仍然盖着这个键，那份没被动过");
  } finally {
    scene.restore();
  }
});

test("HTTP 控制器: 整张写回时不许把私密表里的值抄进公开表", async () => {
  // 合并表里那些值本来就盖着公开表，拿合并表当草稿就等于把密钥抄进随仓库走的那一份。
  const privateTarget = `${pluginConfigDirectory("D:/proj")}/${PRIVATE_ENVIRONMENT_FILE_NAME}`;
  const scene = writeHarness({
    files: {
      [ENV_TARGET]: JSON.stringify({ local: { host: "mine.test" } }),
      [privateTarget]: JSON.stringify({ local: { token: "secret" }, staging: { host: "s.test" } }),
    },
  });
  try {
    await scene.controller.saveEnvironmentTables([
      {
        name: "local",
        variables: [
          { key: "host", value: "next.test" },
          { key: "port", value: "8080" },
        ],
      },
    ]);
    const content = scene.writes[0].content;
    assert.equal(content.includes("secret"), false, "私密表里那个 token 不该出现在公开表里");
    assert.equal(content.includes("s.test"), false, "只住在私密表里的那一段也不该被抄出来");
    assert.equal(content.includes("next.test"), true, "该写的还是照写");
  } finally {
    scene.restore();
  }
});

test("HTTP 控制器: 交回来的就是整张表，没给的段从文件里消失", async () => {
  // 弹窗一次管完整张表，所以「写什么」完全由草稿说了算：这里钉住这条契约，
  // 免得哪天又改成「先读盘当底稿再叠」——那样一来弹窗里删掉的段会被盘上那份复活。
  const scene = writeHarness();
  try {
    await scene.controller.saveEnvironmentTables([
      { name: "local", variables: [{ key: "host", value: "l.test" }] },
      { name: "production", variables: [{ key: "host", value: "p.test" }] },
    ]);
    await scene.controller.saveEnvironmentTables([
      { name: "local", variables: [{ key: "host", value: "l.test" }] },
      { name: "staging", variables: [{ key: "host", value: "s.test" }] },
    ]);
    assert.equal(scene.writes.length, 2);
    const last = JSON.parse(scene.writes[1].content) as Record<string, Record<string, string>>;
    assert.deepEqual(Object.keys(last).sort(), ["local", "staging"], "第二次写带着第一段、去掉第二段");
  } finally {
    scene.restore();
  }
});

test("HTTP 控制器: 写回的 JSON 键序稳定，共享段打头", async () => {
  const scene = writeHarness();
  try {
    await scene.controller.saveEnvironmentTables([
      { name: "production", variables: [{ key: "host", value: "api.test" }] },
    ]);
    const saved = await scene.controller.saveEnvironmentTables([
      { name: "production", variables: [{ key: "host", value: "api.test" }] },
      { name: SHARED_ENVIRONMENT_NAME, variables: [{ key: "version", value: "v1" }] },
    ]);
    assert.equal(saved, true);
    assert.equal(scene.writes[1].filePath, ENV_TARGET);
    assert.equal(scene.writes[1].content.startsWith(`{\n  "${SHARED_ENVIRONMENT_NAME}"`), true, "共享段排在最前");
    assert.equal(scene.controller.environmentSummary().hasShared, true, "保存后重读，界面立刻看见新表");
  } finally {
    scene.restore();
  }
});

test("HTTP 控制器: 删一段就是从公开表里摘掉那一段，别段都留着", async () => {
  const scene = writeHarness({
    files: {
      [ENV_TARGET]: JSON.stringify({
        local: { host: "l.test" },
        production: { host: "p.test" },
      }),
    },
  });
  try {
    const removed = await scene.controller.saveEnvironmentTables([
      { name: "production", variables: [{ key: "host", value: "p.test" }] },
    ]);
    assert.equal(removed, true);
    assert.equal(scene.writes.length, 1);
    const written = JSON.parse(scene.writes[0].content) as Record<string, unknown>;
    assert.deepEqual(Object.keys(written), ["production"], "只少那一段");
    assert.deepEqual(scene.controller.environmentSummary().names, ["production"]);
    assert.equal(scene.renders.length, 1, "清单要跟着换掉那一行");
  } finally {
    scene.restore();
  }
});

test("HTTP 控制器: 一字未改的整张表不再重抄，改了才写", async () => {
  // 弹窗现在也能只翻开看文件变量那一页，看完顺手点保存不该动一次盘
  // （动盘会改文件时间、在版本状态里凭空多一条没改过的记录，还白读一次）。
  const scene = writeHarness({ files: { [ENV_TARGET]: JSON.stringify({ local: { host: "l.test" } }) } });
  try {
    // 打开弹窗前现读一遍盘（askEnvironmentTables 就是这条回路），这样才有可比对的基准。
    await scene.controller.reloadEnvironment();
    const renders = scene.renders.length;
    const saved = await scene.controller.saveEnvironmentTables([
      { name: "local", variables: [{ key: "host", value: "l.test" }] },
    ]);
    assert.equal(saved, true, "本来就是这样也算保存成功");
    assert.equal(scene.writes.length, 0, "盘上已经是这一份，一个字都不必再写");
    assert.equal(scene.renders.length, renders + 1, "不写盘也要重画：界面等着这次保存的结果");
    await scene.controller.saveEnvironmentTables([
      { name: "local", variables: [{ key: "host", value: "next.test" }] },
    ]);
    assert.equal(scene.writes.length, 1, "真改了照样落盘");
    assert.equal(scene.controller.environmentSummary().publicTables.get("local")?.get("host"), "next.test");
  } finally {
    scene.restore();
  }
});

test("HTTP 控制器: 只住在私密表里的那一段动不了，那份文件一个字都不写", async () => {
  const privateTarget = `${pluginConfigDirectory("D:/proj")}/${PRIVATE_ENVIRONMENT_FILE_NAME}`;
  const scene = writeHarness({ files: { [privateTarget]: JSON.stringify({ ghost: { host: "g.test" } }) } });
  try {
    const saved = await scene.controller.saveEnvironmentTables([
      { name: "local", variables: [{ key: "host", value: "l.test" }] },
    ]);
    assert.equal(saved, true);
    assert.deepEqual(scene.writes.map((write) => write.filePath), [ENV_TARGET], "这里只管公开表那一份");
    assert.equal(scene.writes[0].content.includes("g.test"), false, "公开表里不该冒出私密表那段的内容");
    assert.equal(
      scene.controller.environmentSummary().tables.get("ghost")?.get("host"),
      "g.test",
      "私密表那一段照旧生效：它没被这次保存碰到"
    );
  } finally {
    scene.restore();
  }
});

test("HTTP 控制器: 环境表只认项目根那一份，深层目录里的请求文件也不例外", async () => {
  // 旧版本曾按请求文件所在目录放环境表，在 docs/ 下面写出过第二份 .snow/.snow-file-explorer/env.json。
  // 这条钉住两头：写只写根那一份，读也不把子目录里那份当环境表认回来。
  const nested = `${pluginConfigDirectory("D:/proj/docs/api")}/${ENVIRONMENT_FILE_NAME}`;
  const scene = writeHarness({
    files: {
      "D:/proj/docs/api/test.http": "GET https://a.test/{{host}}",
      [nested]: JSON.stringify({ ghost: { host: "from-nested" } }),
    },
  });
  try {
    scene.state.httpSelected = "D:/proj/docs/api/test.http";
    const saved = await scene.controller.saveEnvironmentTables([
      { name: "local", variables: [{ key: "host", value: "l.test" }] },
    ]);
    assert.equal(saved, true);
    assert.deepEqual(
      scene.writes.map((write) => write.filePath),
      [ENV_TARGET],
      "一次写盘都不该落在文件旁边或那个子目录里"
    );
    const summary = scene.controller.environmentSummary();
    assert.equal(summary.directory, pluginConfigDirectory("D:/proj"), "界面报的位置就是根那一份");
    assert.deepEqual(summary.files, [ENV_TARGET], "读回来的也只有根那一份");
    assert.equal(summary.names.includes("ghost"), false, "子目录那份里的环境不该被认成可用的环境");
  } finally {
    scene.restore();
  }
});

test("HTTP 控制器: 宿主写失败时照它的原话报，不许报成功也不重画", async () => {
  const scene = writeHarness({ writeResult: { ok: false, action: "filesystem.writeFile", error: "只读目录" } });
  try {
    const saved = await scene.controller.saveEnvironmentTables([
      { name: "local", variables: [{ key: "host", value: "x" }] },
    ]);
    assert.equal(saved, false);
    assert.equal(scene.statuses[scene.statuses.length - 1], "只读目录", "宿主的错误文案直接给用户看");
    assert.equal(scene.controller.environmentSummary().names.length, 0, "没写成就不能说环境表好了");
    assert.equal(scene.renders.length, 0, "没写成就不重画，否则界面像在报成功");
  } finally {
    scene.restore();
  }
});

test("HTTP 控制器: 新建请求文件补 .http 并落在所选目录，越界、脏名字与别的扩展名都拒绝", async () => {
  const scene = writeHarness();
  try {
    const built = await scene.controller.createRequestFile("D:/proj/api", "users");
    assert.equal(built, true);
    assert.equal(scene.writes[0].filePath, "D:/proj/api/users.http", "缺的扩展名补 .http，位置就用选中的目录");
    assert.equal(scene.writes[0].content, "### 请求 1\nGET https://\n", "建出来就该是一条能直接发的骨架");
    assert.deepEqual(scene.via, ["raw"], "新建走原始写通道：门控动作不许空正文，这条路建不出文件");
    assert.deepEqual(scene.previews, ["D:/proj/api/users.http"], "建完就把新文件打开，别只躺在清单里");

    const rest = await scene.controller.createRequestFile("D:/proj/api", "legacy.rest");
    assert.equal(rest, true, "另一种写法照样收");
    assert.equal(scene.writes[1].filePath, "D:/proj/api/legacy.rest", "写了 .rest 就不许补成 .rest.http");

    const escaped = await scene.controller.createRequestFile("D:/elsewhere", "x.rest");
    assert.equal(escaped, false, "项目根以外不建");
    const badName = await scene.controller.createRequestFile("D:/proj", "a/b.rest");
    assert.equal(badName, false, "名字里带分隔符等于把落点带出目录");
    const notRequest = await scene.controller.createRequestFile("D:/proj", "notes.txt");
    assert.equal(notRequest, false, "这一类入口只建请求文件");
    assert.equal(
      scene.statuses.some((line) => String(line).includes(".http / .rest")),
      true,
      "拦下来要说清这里收哪几类"
    );
    assert.equal(scene.writes.length, 2, "三次拒绝都不该真的写盘");
  } finally {
    scene.restore();
  }
});

test("HTTP 控制器: 新建撞上已有文件就不覆盖，空名字不建垃圾文件", async () => {
  const scene = writeHarness({ files: { "D:/proj/api.http": "GET https://a.test/one" } });
  try {
    const duplicate = await scene.controller.createRequestFile("D:/proj", "api.http");
    assert.equal(duplicate, false);
    assert.equal(scene.writes.length, 0, "已有文件一个字都不动");
    const empty = await scene.controller.createRequestFile("D:/proj", "   ");
    assert.equal(empty, false, "没给名字就建不了，不留 untitled 空文件");
  } finally {
    scene.restore();
  }
});

test("HTTP 控制器: 列不出目录时不新建请求文件，只在状态条说清", async () => {
  // 读盘通道整体坏掉时，新建请求文件必须停手——那里可能已经有同名文件。
  const scene = writeHarness({ readFails: true });
  try {
    const built = await scene.controller.createRequestFile("D:/proj", "users.rest");
    assert.equal(built, false);
    assert.equal(scene.writes.length, 0, "说不清那里有没有文件，就不能覆掉用户可能已有的内容");
    assert.equal(scene.statuses.some((line) => line.includes("目录读不出")), true, "要说清是目录列不出来，不是写失败");
  } finally {
    scene.restore();
  }
});

test("HTTP 控制器: 开合文件变量只翻折叠态并重画面板，一个字都不写盘", () => {
  const scene = writeHarness();
  try {
    assert.equal(scene.state.httpVariablesCollapsed, true, "默认收起");
    scene.controller.toggleVariablesCollapsed();
    assert.equal(scene.state.httpVariablesCollapsed, false);
    assert.equal(scene.renders.length, 1, "面板要跟着换，否则点了就是没反应");
    scene.controller.toggleVariablesCollapsed();
    assert.equal(scene.state.httpVariablesCollapsed, true);
    assert.deepEqual(scene.writes, [], "开合不碰磁盘");
  } finally {
    scene.restore();
  }
});

test("HTTP 控制器: 环境表缺失时概况是空的，界面据此才给创建入口", async () => {
  // 宿主读一个不存在的文件是抛错，文案长得就像失败：概况只报「读到几份表」，不猜为什么读不到。
  const scene = writeHarness();
  try {
    await scene.controller.reloadEnvironment();
    const summary = scene.controller.environmentSummary();
    assert.deepEqual(summary.files, [], "空项目里一份表都没有");
    assert.equal(summary.names.length, 0);
    assert.equal(scene.writes.length, 0, "光是读一遍不该写盘");
    assert.equal(scene.statuses.some((line) => line.includes("读不出")), false, "缺文件不是失败，别报给用户");
  } finally {
    scene.restore();
  }
});
