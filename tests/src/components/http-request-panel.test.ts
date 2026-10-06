import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { TranslateFn } from "../../../src/types/panel-state.ts";
import { parseHttpFile } from "../../../src/services/http-request-parser.ts";
import { formValuesOfRequest } from "../../../src/services/http-serialize.ts";
import type { HttpRunResult } from "../../../src/services/http-runner.ts";

// 建立最小 DOM 环境后再导入渲染模块
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderHttpRequestPanel } = await import("../../../src/components/http-request-panel.ts");
const { renderHttpResult, statusTone } = await import("../../../src/components/http-result-view.ts");

/** 翻译桩：回兜底文案并补 `{{x}}` 插值。 */
const t = ((key: string, fallback?: string, values?: Record<string, string | number>) => {
  let text = fallback || key;
  for (const [name, value] of Object.entries(values || {})) text = text.replace(`{{${name}}}`, String(value));
  return text;
}) as TranslateFn;

/** 一份典型请求文件：文件变量 + 一条 GET + 一条 POST。 */
const SAMPLE = [
  "@host = a.test",
  "",
  "GET https://{{host}}/users",
  "Accept: application/json",
  "",
  "###",
  "",
  "POST https://{{host}}/users",
  "Content-Type: application/json",
  "",
  '{ "name": "Ada" }',
].join("\n");

/** 组一份面板选项：用例只覆盖自己关心的回调。 */
function panelOptions(partial: Partial<Parameters<typeof renderHttpRequestPanel>[1]> = {}) {
  const file = parseHttpFile(SAMPLE);
  return {
    file,
    getForm: (index: number) => formValuesOfRequest(file.requests[index]),
    responses: new Map<number, HttpRunResult>(),
    runningIndex: null as number | null,
    // 默认全折叠，用例要看字段就自己把两张卡片摊开。
    expanded: new Set(["r0", "r1"]),
    // 没发过响应的请求默认摊开构建区（要看请求头/请求体）；用例要收起态就自己加下标。
    collapsedBodies: new Set<number>(),
    onToggleBody: () => {},
    onToggle: () => {},
    dirty: false,
    onFormChange: () => {},
    onCommit: () => {},
    onSend: () => {},
    onPromptChange: () => {},
    getPromptValue: () => "",
    t,
    ...partial,
  } as Parameters<typeof renderHttpRequestPanel>[1];
}

/** 一条成功的执行结果，够响应区渲染用。 */
function okResult(): HttpRunResult {
  return {
    sent: { method: "GET", url: "https://a.test/users", headers: {}, body: null },
    response: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: '{"id":1}',
      finalUrl: "https://a.test/users",
      ok: true,
      contentType: "application/json",
      elapsedMs: 12,
      bodyLength: 8,
    },
    error: null,
    unresolved: [],
    warnings: [],
    attempted: true,
  };
}

test("HTTP GUI: 每条请求一张卡片，字段按解析结果填好", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(host, panelOptions());
  const cards = host.querySelectorAll(".sfe-http-card");
  assert.equal(cards.length, 2);
  const first = cards[0] as HTMLElement;
  assert.equal(first.querySelector<HTMLSelectElement>(".sfe-http-method")!.value, "GET");
  assert.equal(first.querySelector<HTMLInputElement>(".sfe-http-url")!.value, "https://{{host}}/users");
  assert.equal(first.querySelectorAll(".sfe-http-header-row").length, 1);
  // 请求体默认是「可折叠 + 着色」视图（POST 那张），原文可从折叠视图里读到
  assert.equal(
    (cards[1] as HTMLElement).querySelector(".sfe-json-view")!.textContent!.includes('"name"'),
    true
  );
  // 文件变量条只读展示，改值仍回文本态。
  assert.equal(host.querySelector(".sfe-http-variable")!.textContent, "@host = a.test");
});

test("HTTP GUI: 改任一字段的键入都汇成一次完整表单值上交", () => {
  const host = document.createElement("div");
  const changes: Array<{ index: number; url: string; headerCount: number }> = [];
  renderHttpRequestPanel(
    host,
    panelOptions({
      onFormChange: (index, values) =>
        changes.push({ index, url: values.url, headerCount: values.headers.length }),
    })
  );
  const url = host.querySelector<HTMLInputElement>(".sfe-http-url")!;
  url.value = "https://a.test/people";
  url.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].index, 0);
  assert.equal(changes[0].url, "https://a.test/people");
  assert.equal(changes[0].headerCount, 1, "没动的头部也要一起交上去");

  // 请求体要先点「编辑」进编辑态才能改
  const postCard = host.querySelectorAll<HTMLElement>(".sfe-http-card")[1];
  (postCard.querySelector(".sfe-json-edit-btn") as HTMLElement).dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true })
  );
  const body = postCard.querySelector<HTMLTextAreaElement>(".sfe-http-body")!;
  body.value = "{ \"name\": \"Grace\" }";
  body.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(changes.length, 2);
  assert.equal(changes[1].index, 1);
});

test("HTTP GUI: 添加与删除头部行，上交的值随之变化", () => {
  const host = document.createElement("div");
  const changes: number[] = [];
  renderHttpRequestPanel(host, panelOptions({ onFormChange: (_index, values) => changes.push(values.headers.length) }));
  const card = host.querySelector<HTMLElement>(".sfe-http-card")!;
  (card.querySelector(".sfe-http-header-add") as HTMLElement).dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true })
  );
  assert.equal(card.querySelectorAll(".sfe-http-header-row").length, 2);
  assert.deepEqual(changes, [], "只加了一行空行，还没填，不该上交");

  const added = card.querySelectorAll<HTMLElement>(".sfe-http-header-row")[1];
  const name = added.querySelector<HTMLInputElement>(".sfe-http-header-name")!;
  name.value = "X-Trace";
  name.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(changes.length, 1);
  assert.equal(changes[0], 2, "空名行填上名字后才计入");

  (added.querySelector(".sfe-http-header-remove") as HTMLElement).dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true })
  );
  assert.equal(card.querySelectorAll(".sfe-http-header-row").length, 1);
  assert.equal(changes[changes.length - 1], 1);
});

test("HTTP GUI: 发送按钮交回下标，发送中只有一条能按", () => {
  const host = document.createElement("div");
  const sent: number[] = [];
  renderHttpRequestPanel(host, panelOptions({ onSend: (index) => sent.push(index) }));
  const buttons = host.querySelectorAll<HTMLButtonElement>(".sfe-http-send");
  assert.equal(buttons.length, 2);
  buttons[1].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(sent, [1]);

  const running = document.createElement("div");
  renderHttpRequestPanel(running, panelOptions({ runningIndex: 0 }));
  const runningButtons = running.querySelectorAll<HTMLButtonElement>(".sfe-http-send");
  assert.equal(runningButtons[0].disabled, true);
  assert.equal(runningButtons[0].textContent!.includes("发送中…"), true);

  const idle = document.createElement("div");
  renderHttpRequestPanel(idle, panelOptions());
  assert.equal(idle.querySelector<HTMLButtonElement>(".sfe-http-send")!.disabled, false);
});

test("HTTP GUI: 响应到账后卡片下方排出状态、耗时、响应头与正文", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(host, panelOptions({ responses: new Map([[0, okResult()]]) }));
  const cards = host.querySelectorAll(".sfe-http-card");
  assert.equal(cards[0].querySelector(".sfe-http-status")!.textContent, "200 OK");
  assert.equal(cards[0].querySelector(".sfe-http-status")!.classList.contains("ok"), true);
  // JSON 正文走可折叠视图：美化后的每一行都是一个行节点。
  const jsonView = cards[0].querySelector(".sfe-json-view")!;
  assert.ok(jsonView, "JSON 响应要交给折叠视图");
  const lines = Array.from(jsonView.querySelectorAll(".sfe-json-line")).map((node) => node.textContent || "");
  assert.equal(lines.length, 3);
  assert.equal(lines[0].startsWith("{"), true);
  assert.equal(lines[1], '  "id": 1', "JSON 美化");
  assert.equal(lines[2], "}");
  assert.equal(cards[1].querySelector(".sfe-http-result"), null, "没发过的那条不出现响应区");

  // 非 JSON 正文仍走等宽 pre，不做折叠
  const plain = document.createElement("div");
  renderHttpRequestPanel(
    plain,
    panelOptions({
      responses: new Map([
        [0, { ...okResult(), response: { ...okResult().response!, body: "hello", contentType: "text/plain" } }],
      ]),
    })
  );
  assert.equal(plain.querySelector(".sfe-http-response-body")!.textContent, "hello");
});

test("HTTP GUI: JSON 响应按语义着色（键/字符串/数字/布尔/null 各带类），不走代码高亮", () => {
  const body = JSON.stringify({ name: "Ada", age: 37, active: true, note: null }, null, 2);
  const host = document.createElement("div");
  renderHttpRequestPanel(
    host,
    panelOptions({ responses: new Map([[0, { ...okResult(), response: { ...okResult().response!, body } }]]) })
  );
  // 键着色："name": 里的 "name" 是键，不是普通字符串
  assert.equal(host.querySelector(".sfe-json-key")!.textContent, '"name"');
  assert.equal(host.querySelector(".sfe-json-string")!.textContent, '"Ada"');
  assert.equal(host.querySelector(".sfe-json-number")!.textContent, "37");
  assert.equal(host.querySelector(".sfe-json-boolean")!.textContent, "true");
  assert.equal(host.querySelector(".sfe-json-null")!.textContent, "null");
  // 不再产出代码高亮的 token 类（那是「代码美化」的残留）
  assert.equal(host.querySelector(".sfe-json-code .token"), null);
});

test("HTTP GUI: 响应正文默认展开（请求完成就是看结果），可整体收起", () => {
  const host = document.createElement("div");
  const body = JSON.stringify({ outer: { inner: [1, 2, 3] }, tail: true }, null, 2);
  renderHttpRequestPanel(
    host,
    panelOptions({
      responses: new Map([[0, { ...okResult(), response: { ...okResult().response!, body } }]]),
    })
  );
  const details = host.querySelector<HTMLDetailsElement>(".sfe-json-details")!;
  assert.equal(details.open, true, "响应正文默认展开——请求完成就是看结果");
  assert.equal(details.querySelector("summary")!.textContent!.includes("响应正文"), true);
  // 内部每个 {} / [] 都能单独折叠
  const nodes = host.querySelectorAll<HTMLElement>(".sfe-json-node");
  assert.ok(nodes.length >= 2, "嵌套对象与数组各算一个可折叠块");
  const toggle = nodes[0].querySelector<HTMLButtonElement>(".sfe-json-toggle")!;
  toggle.click();
  assert.equal(nodes[0].classList.contains("collapsed"), true, "点一下收起这一块");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  toggle.click();
  assert.equal(nodes[0].classList.contains("collapsed"), false);
  // 不再有「全部折叠 / 全部展开」这种粗粒度按钮
  assert.equal(host.querySelector(".sfe-json-bar"), null);
});

test("HTTP GUI: 响应区回显实际发出的请求", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(host, panelOptions({ responses: new Map([[0, okResult()]]) }));
  const details = host.querySelector<HTMLDetailsElement>(".sfe-http-sent")!;
  assert.equal(details.open, false, "默认收起，不抢响应正文的位置");
  const dump = details.querySelector(".sfe-http-sent-dump")!.textContent!;
  assert.equal(dump.includes("GET https://a.test/users"), true, "用户要能核对到底发了什么");
});

test("HTTP 结果视图: 实际发出的请求里的 JSON 正文也做语义着色", () => {
  const host = document.createElement("div");
  const result: HttpRunResult = {
    ...okResult(),
    sent: {
      method: "POST",
      url: "https://a.test/users",
      headers: { "content-type": "application/json" },
      body: '{ "name": "Ada", "age": 37 }',
    },
  };
  renderHttpResult(host, result, t);
  const body = host.querySelector<HTMLElement>(".sfe-http-sent-body")!;
  assert.equal(body.querySelector(".sfe-json-key")!.textContent, '"name"', "发出的正文里键有着色");
  assert.equal(body.querySelector(".sfe-json-string")!.textContent, '"Ada"');
  assert.equal(body.querySelector(".sfe-json-number")!.textContent, "37");
});

test("HTTP 结果视图: 实际发出的请求默认折叠（要看再展开）", () => {
  const host = document.createElement("div");
  renderHttpResult(host, okResult(), t);
  const details = host.querySelector<HTMLDetailsElement>(".sfe-http-sent")!;
  assert.equal(details.open, false, "默认收起，与响应头一致");
});

test("HTTP GUI: 状态码按档位着色，未发出与前置拒绝走同一条渲染", () => {
  const refused: HttpRunResult = { ...okResult(), response: null, error: "只能访问 http(s) 完整地址", attempted: false };
  const host = document.createElement("div");
  renderHttpRequestPanel(host, panelOptions({ responses: new Map([[0, refused]]) }));
  const status = host.querySelector(".sfe-http-status")!;
  assert.equal(status.textContent, "未发出");
  assert.equal(status.classList.contains("failed"), true);
  assert.equal(host.querySelector(".sfe-http-error")!.textContent, "只能访问 http(s) 完整地址");

  const clientError: HttpRunResult = {
    ...okResult(),
    response: { ...okResult().response!, status: 404, statusText: "Not Found", ok: false },
  };
  const second = document.createElement("div");
  renderHttpRequestPanel(second, panelOptions({ responses: new Map([[0, clientError]]) }));
  assert.equal(second.querySelector(".sfe-http-status")!.classList.contains("client"), true);
});

test("HTTP 结果视图: 状态码分档覆盖全部语义色，含 status<=0 这条回归守卫", () => {
  const withStatus = (status: number): HttpRunResult => ({
    ...okResult(),
    response: { ...okResult().response!, status },
  });
  assert.equal(statusTone(okResult()), "ok", "2xx 成功");
  assert.equal(statusTone(withStatus(204)), "ok", "无正文的 2xx 也是成功");
  assert.equal(statusTone(withStatus(301)), "redirect", "3xx 是提示档");
  assert.equal(statusTone(withStatus(404)), "client", "4xx 是警告档");
  assert.equal(statusTone(withStatus(500)), "server", "5xx 是错误档");
  // 关键回归：宿主断网 / 超时 / DNS 失败回的是 status 0 + error，
  // 算进成功档会在界面画出绿色的「0」，用户第一眼看到的是「成功了」。
  assert.equal(statusTone(withStatus(0)), "failed", "传输失败的 status 0 必须算失败，不能画成成功");
  assert.equal(statusTone(withStatus(-1)), "failed", "负值同样是失败");
  assert.equal(statusTone({ ...okResult(), response: null }), "failed", "没拿到响应即失败");
});

test("HTTP GUI: 变量没定义时给提示，@prompt 出现填写行", () => {
  const file = parseHttpFile(["# @prompt otp 邮箱验证码", "GET https://{{host}}/x"].join("\n"));
  const host = document.createElement("div");
  const prompts: Array<{ name: string; value: string }> = [];
  renderHttpRequestPanel(
    host,
    panelOptions({
      file,
      getForm: () => ({ method: "GET", url: "https://{{host}}/x", headers: [], body: null }),
      onPromptChange: (_index, name, value) => prompts.push({ name, value }),
    })
  );
  assert.equal(host.querySelector(".sfe-http-warning")!.textContent!.includes("host"), true);
  const input = host.querySelector<HTMLInputElement>(".sfe-http-prompt-input")!;
  assert.equal(input.placeholder, "otp");
  input.value = "123456";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.deepEqual(prompts, [{ name: "otp", value: "123456" }]);
});

test("HTTP GUI: 卡片默认折叠，只留标题行，点一下才摊开", () => {
  const file = parseHttpFile(["### 登录", "POST https://a.test/login", "", "### 查人", "GET https://a.test/users"].join("\n"));
  const host = document.createElement("div");
  const toggled: string[] = [];
  renderHttpRequestPanel(
    host,
    panelOptions({
      file,
      getForm: (index) => formValuesOfRequest(file.requests[index]),
      expanded: new Set(),
      onToggle: (key) => toggled.push(key),
    })
  );
  const cards = host.querySelectorAll(".sfe-http-card");
  assert.equal(cards.length, 2);
  assert.equal(cards[0].querySelector(".sfe-http-method"), null, "折叠态不该有表单字段");
  assert.equal(cards[0].querySelector(".sfe-http-card-name")!.textContent, "登录");
  assert.equal(cards[0].querySelector(".sfe-http-card-summary")!.textContent, "POST https://a.test/login");
  assert.equal(cards[1].querySelector(".sfe-http-card-name")!.textContent, "查人");
  (cards[0].querySelector(".sfe-http-card-fold") as HTMLElement).dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true })
  );
  assert.deepEqual(toggled, ["r0"], "折叠态按请求下标交回装配层");

  const open = document.createElement("div");
  renderHttpRequestPanel(
    open,
    panelOptions({ file, getForm: (index) => formValuesOfRequest(file.requests[index]), expanded: new Set(["r0"]) })
  );
  const openCards = open.querySelectorAll<HTMLElement>(".sfe-http-card");
  assert.equal(
    openCards[0].querySelector<HTMLInputElement>(".sfe-http-url")!.value,
    "https://a.test/login"
  );
  assert.equal(openCards[1].querySelector(".sfe-http-method"), null);
});

test("HTTP GUI: 焦点离开整张卡片才提交，卡内换字段不打扰", () => {
  const host = document.createElement("div");
  const committed: number[] = [];
  renderHttpRequestPanel(host, panelOptions({ onCommit: (index) => committed.push(index) }));
  const card = host.querySelector<HTMLElement>(".sfe-http-card")!;
  const url = card.querySelector<HTMLInputElement>(".sfe-http-url")!;
  const outside = document.createElement("button");
  host.appendChild(outside);

  url.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true, relatedTarget: card.querySelector(".sfe-http-header-name") }));
  assert.deepEqual(committed, [], "Tab 到同一张卡片的另一个字段不该写盘");

  url.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
  assert.deepEqual(committed, [0], "焦点真的离开卡片时提交这一条");
});

test("HTTP GUI: 未保存改动条按 dirty 出现，保存与放弃各自回调", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(host, panelOptions());
  assert.equal(host.querySelector<HTMLElement>(".sfe-http-dirty")!.hidden, true, "没改动时条收起");

  const saved: string[] = [];
  const dirtyHost = document.createElement("div");
  renderHttpRequestPanel(
    dirtyHost,
    panelOptions({
      dirty: true,
      onSave: () => saved.push("save"),
      onReload: () => saved.push("reload"),
    })
  );
  const bar = dirtyHost.querySelector(".sfe-http-dirty")!;
  assert.equal(bar.textContent!.includes("有未保存的改动"), true);
  const buttons = bar.querySelectorAll<HTMLButtonElement>(".sfe-http-dirty-btn");
  assert.equal(buttons.length, 2);
  buttons[1].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  buttons[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(saved, ["save", "reload"]);
});

test("HTTP GUI: 键入立刻在未保存条上反映，保存结果就地同步而不重建卡片", () => {
  const host = document.createElement("div");
  const url = () => host.querySelector<HTMLInputElement>(".sfe-http-url")!;
  renderHttpRequestPanel(host, panelOptions({ onFormChange: () => {} }));
  assert.equal(host.querySelector<HTMLElement>(".sfe-http-dirty")!.hidden, true);
  url().value = "https://a.test/x";
  url().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(host.querySelector<HTMLElement>(".sfe-http-dirty")!.hidden, false, "一改就出现");

  const sync = host.__sfeViewerChromeSync!;
  sync({ copied: false, saving: true, saveState: "saving", saveMessage: "" });
  assert.equal(host.querySelector(".sfe-http-dirty-label")!.textContent, "保存中…");
  sync({ copied: false, saving: false, saveState: "saved", saveMessage: "" });
  assert.equal(host.querySelector<HTMLElement>(".sfe-http-dirty")!.hidden, true, "写盘成功后收起");
  sync({ copied: false, saving: false, saveState: "failed", saveMessage: "磁盘只读" });
  assert.equal(host.querySelector<HTMLElement>(".sfe-http-dirty")!.hidden, false);
  assert.equal(host.querySelector(".sfe-http-dirty-label")!.textContent, "磁盘只读");
});

test("HTTP GUI: 空文件给空态，元数据 chip 与未识别键都摆出来", () => {
  const empty = document.createElement("div");
  renderHttpRequestPanel(empty, panelOptions({ file: parseHttpFile("# 只有注释") }));
  assert.equal(empty.querySelector(".sfe-http-empty")!.textContent, "这个文件里没有请求");

  const meta = parseHttpFile(["# @note 会真的下单", "# @no-redirect", "# @legacy-flag on", "GET https://a.test"].join("\n"));
  const host = document.createElement("div");
  renderHttpRequestPanel(host, panelOptions({ file: meta }));
  const chips = Array.from(host.querySelectorAll(".sfe-http-chip"));
  assert.deepEqual(chips.map((chip) => chip.textContent), ["会真的下单", "不跟随重定向", "@legacy-flag"]);
  assert.equal(chips[2].classList.contains("unknown"), true);
});

test("HTTP GUI: 展开态把发送按钮收进地址行（Omnibar）", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(host, panelOptions());
  const card = host.querySelector<HTMLElement>(".sfe-http-card")!;
  const send = card.querySelector<HTMLElement>(".sfe-http-send")!;
  assert.equal(card.querySelector<HTMLElement>(".sfe-http-line")!.contains(send), true, "方法 / 地址 / 发送 同一条线");
  assert.equal(card.querySelector(".sfe-http-card-head")!.contains(send), false, "不再挂在标题行右上角");
});

test("HTTP GUI: 展开的卡片拆成「请求构建区 / 响应区」两段，响应独立成区", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(host, panelOptions({ responses: new Map([[0, okResult()]]) }));
  const card = host.querySelector<HTMLElement>(".sfe-http-card")!;
  const builder = card.querySelector<HTMLElement>(":scope > .sfe-http-builder")!;
  const response = card.querySelector<HTMLElement>(":scope > .sfe-http-response")!;
  assert.ok(builder, "请求构建区在卡片直属层");
  assert.ok(response, "响应区在卡片直属层");
  // 请求头/请求体进构建区，响应进响应区——不再全堆成一长条。
  assert.ok(builder.querySelector(".sfe-http-headers"));
  assert.ok(builder.querySelector(".sfe-http-body-host"));
  assert.ok(response.querySelector(".sfe-http-result"));
  assert.equal(builder.contains(response), false, "两区是并列的两段，不是套在一起");
});

test("HTTP GUI: 没发过的请求在响应区给空态提示", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(host, panelOptions());
  const response = host.querySelector<HTMLElement>(".sfe-http-card > .sfe-http-response")!;
  assert.equal(response.querySelector(".sfe-http-empty")!.textContent, "点发送，请求体与响应会显示在这里");
});

test("HTTP GUI: 请求体是「可折叠 + 语义着色」的视图，点编辑才切到 textarea", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(host, panelOptions());
  // 第二张卡片是 POST，请求体是 JSON
  const card = host.querySelectorAll<HTMLElement>(".sfe-http-card")[1];
  const fold = card.querySelector<HTMLDetailsElement>(".sfe-http-body-host .sfe-json-details")!;
  assert.ok(fold, "请求体默认是可折叠视图");
  assert.equal(fold.open, true, "请求体默认展开（操作型区块）");
  assert.equal(fold.querySelector("summary")!.textContent!.includes("请求体"), true);
  // 内部 JSON 已语义着色
  assert.equal(fold.querySelector(".sfe-json-key")!.textContent, '"name"');
  assert.equal(fold.querySelector(".sfe-json-string")!.textContent, '"Ada"');
  // 点「编辑」切到 textarea 编辑态
  (fold.querySelector(".sfe-json-edit-btn") as HTMLElement).dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true })
  );
  assert.ok(card.querySelector(".sfe-http-body-editor .sfe-http-body"), "编辑态出现 textarea");
});

test("HTTP GUI: 请求体编辑态随键入重绘高亮层并上交新值", () => {
  const host = document.createElement("div");
  const changes: string[] = [];
  renderHttpRequestPanel(host, panelOptions({ onFormChange: (_index, values) => changes.push(String(values.body)) }));
  const card = host.querySelectorAll<HTMLElement>(".sfe-http-card")[1];
  (card.querySelector(".sfe-json-edit-btn") as HTMLElement).dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true })
  );
  const editor = card.querySelector<HTMLElement>(".sfe-http-body-editor")!;
  const highlight = editor.querySelector<HTMLElement>(".sfe-http-body-highlight")!;
  const body = editor.querySelector<HTMLTextAreaElement>(".sfe-http-body")!;
  body.value = '{ "count": 3 }';
  body.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(highlight.querySelector(".sfe-json-key")!.textContent, '"count"');
  assert.equal(highlight.querySelector(".sfe-json-number")!.textContent, "3");
  assert.equal(changes[changes.length - 1], '{ "count": 3 }', "新值照常上交装配层");
});

test("HTTP GUI: Ctrl+Enter 发送当前卡片，普通 Enter 不误发", () => {
  const host = document.createElement("div");
  const sent: number[] = [];
  renderHttpRequestPanel(host, panelOptions({ onSend: (index) => sent.push(index) }));
  const card = host.querySelector<HTMLElement>(".sfe-http-card")!;
  const url = card.querySelector<HTMLInputElement>(".sfe-http-url")!;
  url.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.deepEqual(sent, [], "光按 Enter 是换行/提交，不该发送");
  url.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  assert.deepEqual(sent, [0], "Ctrl+Enter 发送本条");
});

test("HTTP GUI: 请求发过之后构建区收起（只留结果），点摘要才重开配置区", () => {
  const host = document.createElement("div");
  const opened: Array<[number, boolean]> = [];
  // 0 号发过响应且已收起：发送之后的形态——卡片仍聚焦（结果可见），请求头 / 请求体不再占屏。
  renderHttpRequestPanel(
    host,
    panelOptions({
      responses: new Map([[0, okResult()]]),
      collapsedBodies: new Set([0]),
      onToggleBody: (index, open) => opened.push([index, open]),
    })
  );
  const card = host.querySelector<HTMLElement>(".sfe-http-card")!;
  // 配置区（请求头 / 请求体）整体不出现
  assert.equal(card.querySelector(".sfe-http-headers"), null, "构建区收起时不渲染请求头");
  assert.equal(card.querySelector(".sfe-http-body-host"), null, "构建区收起时不渲染请求体");
  // 只读摘要 + 发送按钮仍在这一行
  const toggle = card.querySelector<HTMLElement>(".sfe-http-builder-toggle")!;
  assert.ok(toggle, "收起态给一个展开按钮");
  assert.equal(toggle.textContent!.includes("GET https://{{host}}/users"), true, "按钮上带方法与地址摘要");
  assert.ok(card.querySelector(".sfe-http-send"), "发送按钮留在这一行");
  // 响应仍在（这就是「只剩结果」）
  assert.ok(card.querySelector(".sfe-http-response .sfe-http-result"));
  // 点它只摊开配置区，不收起卡片
  toggle.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(opened, [[0, true]], "点展开按钮只摊开这一条的构建区");
});

test("HTTP GUI: 没发过的请求构建区默认摊开（可直接编辑）", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(host, panelOptions({ responses: new Map() }));
  const card = host.querySelector<HTMLElement>(".sfe-http-card")!;
  assert.ok(card.querySelector(".sfe-http-headers"), "没发过就摊开供编辑");
  assert.equal(card.querySelector(".sfe-http-builder-toggle"), null);
});

test("HTTP 结果视图: 复制响应正文按钮与响应头条数计数", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(host, panelOptions({ responses: new Map([[0, okResult()]]) }));
  const copy = host.querySelector<HTMLElement>(".sfe-http-copy")!;
  assert.equal(copy.title, "复制响应正文");
  assert.equal(host.querySelector(".sfe-http-result-actions")!.contains(copy), true);
  // 响应头折叠条带上实际条数，不用点开才知道有几条。
  assert.equal(host.querySelector(".sfe-http-headers-details .sfe-http-count")!.textContent, "1");
});
