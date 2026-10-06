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
    highlightedHtml: "",
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
