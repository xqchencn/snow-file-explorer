import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { TranslateFn } from "../../../src/types/panel-state.ts";
import { parseHttpFile } from "../../../src/services/http-request-parser.ts";
import { formValuesOfRequest } from "../../../src/services/http-serialize.ts";
import type { HttpParsedFile } from "../../../src/services/http-request-parser.ts";
import { SHARED_ENVIRONMENT_NAME } from "../../../src/services/http-env.ts";
import type { HttpEnvironmentSummary, HttpEnvironmentTable } from "../../../src/services/http-env.ts";
import type { HttpRunResult } from "../../../src/services/http-runner.ts";

// 组件建节点用的是全局 document，所以先把 jsdom 的 window/document 挂上，再导入渲染模块。
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderHttpRequestPanel } = await import("../../../src/components/http-request-panel.ts");

/** 翻译桩：回兜底文案并补 `{{x}}` 插值。 */
const t = ((key: string, fallback?: string, values?: Record<string, string | number>) => {
  let text = fallback || key;
  for (const [name, value] of Object.entries(values || {})) text = text.replace(`{{${name}}}`, String(value));
  return text;
}) as TranslateFn;

/** 一份没有环境表时的默认概况：用例只填自己关心的那几项。 */
function envOf(partial: Partial<HttpEnvironmentSummary> = {}): HttpEnvironmentSummary {
  return {
    names: [],
    active: "",
    hasShared: false,
    variables: new Map(),
    overriddenShared: [],
    files: [],
    directory: "",
    tables: new Map(),
    publicTables: new Map(),
    privateKeys: [],
    issues: [],
    dotenvPath: null,
    dotenvCount: 0,
    ...partial,
  };
}

/** 组一份面板选项：默认全展开、全摊开，用例只覆盖自己关心的回调。 */
function panelOptions(
  text: string,
  partial: Partial<Parameters<typeof renderHttpRequestPanel>[1]> = {}
): Parameters<typeof renderHttpRequestPanel>[1] {
  const file: HttpParsedFile = parseHttpFile(text);
  return {
    file,
    getForm: (index) => formValuesOfRequest(file.requests[index]),
    responses: new Map<number, HttpRunResult>(),
    runningIndex: null,
    expanded: new Set(["r0", "r1", "r2", "r3"]),
    collapsedBodies: new Set<number>(),
    onToggleBody: () => {},
    onToggle: () => {},
    dirty: false,
    onFormChange: () => {},
    onCommit: () => {},
    onSend: () => {},
    onPromptChange: () => {},
    getPromptValue: () => "",
    environment: envOf(),
    t,
    ...partial,
  } as Parameters<typeof renderHttpRequestPanel>[1];
}

/** 派发一个会冒泡的事件（jsdom 里 input/change 都要求显式 bubbles 才走得到卡片监听）。 */
function fire(node: EventTarget, type: string): void {
  node.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
}

test("HTTP 规范 GUI: 环境条列出可切环境并回传选择", () => {
  const host = document.createElement("div");
  const picked: string[] = [];
  renderHttpRequestPanel(
    host,
    panelOptions("GET https://a.test/{{host}}/x", {
      environment: envOf({
        names: ["local", "production"],
        active: "local",
        hasShared: true,
        files: ["D:/repo/.snow/.snow-file-explorer/env.json"],
        tables: new Map<string, HttpEnvironmentTable>([
          [SHARED_ENVIRONMENT_NAME, new Map([["version", "v1"]])],
          ["local", new Map([["host", "api.test"]])],
          ["production", new Map([["host", "prod.test"]])],
        ]),
      }),
      onEnvironmentChange: (name) => picked.push(name),
      onManageEnvironments: async () => {},
    })
  );
  const select = host.querySelector<HTMLSelectElement>(".sfe-http-env-select");
  assert.notEqual(select, null, "有环境表就要给切换入口");
  assert.deepEqual([...select!.options].map((option) => option.value), ["", "local", "production"]);
  assert.equal(select!.value, "local");
  select!.value = "production";
  fire(select!, "change");
  assert.deepEqual(picked, ["production"]);
  assert.notEqual(host.querySelector(".sfe-http-env-chip"), null, "$shared 标记要看得见");
  assert.notEqual(host.querySelector(".sfe-http-env-modify"), null, "改得动这件事要在区外就看得见");
});

test("HTTP 规范 GUI: 没用变量的普通文件也给环境入口，没环境表时那颗钮叫「添加环境」", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(
    host,
    panelOptions("GET https://a.test/x", { onManageEnvironments: async () => {} })
  );
  // 环境是项目级配置：入口常驻，一篇干净文件也得有地方创建第一份环境表。
  const modify = host.querySelector<HTMLButtonElement>(".sfe-http-env-modify");
  assert.notEqual(modify, null, "入口不在的话，干净文件永远开不了环境表");
  assert.equal(String(modify!.textContent).includes("添加"), true, "没有东西可改，词得是「添加」");
  assert.equal(host.querySelector(".sfe-http-env-hint"), null, "不缺值就不要摆引导吓人");
  assert.equal(host.querySelector(".sfe-http-env-select"), null, "没得切仍不摆只有「不选环境」的死下拉");
});

test("HTTP 规范 GUI: 变量取不到值时给引导，没环境表那颗钮叫「添加环境」", async () => {
  const host = document.createElement("div");
  let asked = 0;
  renderHttpRequestPanel(
    host,
    panelOptions("GET https://a.test/{{host}}/x", {
      onManageEnvironments: () => {
        asked += 1;
        return Promise.resolve();
      },
    })
  );
  assert.equal(host.querySelector(".sfe-http-env-select"), null, "没得切就不要摆一个只有「不选环境」的死下拉");
  const hint = host.querySelector(".sfe-http-env-hint");
  assert.notEqual(hint, null);
  assert.equal(String(hint!.textContent).includes("host"), true, "要点名是哪个变量没取值");
  assert.equal(String(hint!.textContent).includes("env.json"), false, "引导创建就够了，不必报文件名");
  const modify = host.querySelector<HTMLButtonElement>(".sfe-http-env-modify");
  assert.notEqual(modify, null);
  assert.equal(String(modify!.textContent).includes("添加"), true, "没有环境表时这颗钮是创建，不是修改");
  modify!.click();
  await Promise.resolve();
  assert.equal(asked, 1, "点它就弹出整张表，进来先给一段待命名的");
  assert.equal(host.querySelectorAll(".sfe-http-env button").length, 1, "引导态也不许多摆一颗");

  // 没给弹窗通道时不许摆一颗点了没反应的按钮。
  const quiet = document.createElement("div");
  renderHttpRequestPanel(quiet, panelOptions("GET https://a.test/{{host}}/x"));
  assert.equal(quiet.querySelector(".sfe-http-env-modify"), null);
});

test("HTTP 规范 GUI: 文件自己已经给了值，就不引导改环境，但入口照在", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(
    host,
    panelOptions(["@host = a.test", "", "GET https://{{host}}/x"].join("\n"), { onManageEnvironments: async () => {} })
  );
  assert.equal(host.querySelector(".sfe-http-env-hint"), null, "这一篇自己就取得到值，不必引导");
  assert.notEqual(host.querySelector(".sfe-http-env-modify"), null, "入口常驻：改环境这件事永远够得着");
});

test("HTTP 规范 GUI: 环境表读坏了要说清是哪一份", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(
    host,
    panelOptions("GET https://a.test/{{host}}/x", {
      environment: envOf({
        files: ["D:/repo/.snow/.snow-file-explorer/env.json"],
        issues: [{ code: "invalidJson", file: "env.json", name: null }],
      }),
    })
  );
  assert.equal(String(host.querySelector(".sfe-http-warning")?.textContent).includes("env.json"), true, "要说清是哪一份读坏了");
});

test("HTTP 规范 GUI: 参数表按地址生成，改一格就重写那一段查询串", () => {
  const host = document.createElement("div");
  const edits: string[] = [];
  renderHttpRequestPanel(
    host,
    panelOptions("GET https://a.test/c?page=2&pageSize=10", {
      onFormChange: (_index, values) => edits.push(values.url),
    })
  );
  const rows = host.querySelectorAll(".sfe-http-param-row");
  assert.equal(rows.length, 2);
  assert.deepEqual(
    [...rows].map((row) => row.querySelector<HTMLInputElement>(".sfe-http-param-name")?.value),
    ["page", "pageSize"]
  );
  const pageValue = rows[0].querySelector<HTMLInputElement>(".sfe-http-param-value")!;
  pageValue.value = "3";
  fire(pageValue, "input");
  assert.deepEqual(edits, ["https://a.test/c?page=3&pageSize=10"], "只动那一段，其余参数保持原位");
});

test("HTTP 规范 GUI: 参数表增删都跟着重写地址，空名字那一格不写进地址", () => {
  const host = document.createElement("div");
  const edits: string[] = [];
  renderHttpRequestPanel(
    host,
    panelOptions("GET https://a.test/c?a=1", {
      onFormChange: (_index, values) => edits.push(values.url),
    })
  );
  host.querySelector<HTMLButtonElement>(".sfe-http-param-add")!.click();
  assert.equal(edits.at(-1), "https://a.test/c?a=1", "刚加的空名字不该写出一个 `&=`");
  const rows = host.querySelectorAll(".sfe-http-param-row");
  assert.equal(rows.length, 2);
  const addedName = rows[1].querySelector<HTMLInputElement>(".sfe-http-param-name")!;
  addedName.value = "debug";
  fire(addedName, "input");
  assert.equal(edits.at(-1), "https://a.test/c?a=1&debug=");
  rows[0].querySelector<HTMLButtonElement>(".sfe-http-param-remove")!.click();
  assert.equal(edits.at(-1), "https://a.test/c?debug=");
});

test("HTTP 规范 GUI: 地址框直接改动时参数行跟着重画", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(host, panelOptions("GET https://a.test/c?a=1"));
  const url = host.querySelector<HTMLInputElement>(".sfe-http-url")!;
  url.value = "https://a.test/c?x=1&y=2";
  fire(url, "input");
  assert.deepEqual(
    [...host.querySelectorAll<HTMLInputElement>(".sfe-http-param-name")].map((input) => input.value),
    ["x", "y"]
  );
});

test("HTTP 规范 GUI: curl 一节只给只读投影，不摆改了没用的输入框", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(host, panelOptions(`curl -X POST https://a.test/x -H 'A: 1' -d '{"k":1}'`));
  assert.equal(host.querySelector(".sfe-http-url"), null, "地址框不该出现：写回会破坏 curl 命令");
  assert.equal(host.querySelectorAll(".sfe-http-param-row").length, 0);
  assert.notEqual(host.querySelector(".sfe-http-header-static"), null, "头部以只读行展示");
  assert.equal(String(host.querySelector(".sfe-http-hint")?.textContent).includes("curl"), true);
  assert.notEqual(host.querySelector(".sfe-http-send"), null, "发送仍然是真效果");
  assert.equal(String(host.querySelector(".sfe-http-header-static")?.textContent).startsWith("A: 1"), true);
});

test("HTTP 规范 GUI: 密码类提示变量掩码输入", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(
    host,
    panelOptions(["# @prompt username", "# @prompt password 你的验证码", "GET https://a.test/x"].join("\n"))
  );
  const inputs = [...host.querySelectorAll<HTMLInputElement>(".sfe-http-prompt-input")];
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].type, "text");
  assert.equal(inputs[1].type, "password", "写进掩码名单的名字要藏起来");
});

test("HTTP 规范 GUI: 选了环境后只在环境表里定义的变量不再报「没定义」", () => {
  const withoutEnv = document.createElement("div");
  renderHttpRequestPanel(withoutEnv, panelOptions("GET https://{{host}}/x"));
  assert.equal(String(withoutEnv.querySelector(".sfe-http-warning")?.textContent).includes("host"), true);

  const host = document.createElement("div");
  renderHttpRequestPanel(
    host,
    panelOptions("GET https://{{host}}/x", {
      environment: envOf({ variables: new Map([["host", "a.test"]]), files: ["D:/repo/.snow/.snow-file-explorer/env.json"] }),
    })
  );
  assert.equal(host.querySelector(".sfe-http-warning"), null, "环境里已经有值，不该再说这个变量没定义");
});

test("HTTP 规范 GUI: 响应脚本与落盘行各挂一条说明 chip", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(
    host,
    panelOptions(["GET https://a.test/x", "Content-Type: text/plain", "", "> ./out.json", "> {%", "  client.log(1);", "%}"].join("\n"))
  );
  const chips = [...host.querySelectorAll(".sfe-http-chip.unknown")].map((chip) => chip.textContent);
  assert.equal(chips.includes("响应不落盘"), true, chips.join("/"));
  assert.equal(chips.includes("响应脚本不执行"), true, chips.join("/"));
});

/** 一份摊得开清单的环境概况：三段（$shared 打头），production/token 被私密表盖住。 */
function listedEnv(): HttpEnvironmentSummary {
  return envOf({
    names: ["local", "production"],
    active: "local",
    hasShared: true,
    files: ["D:/proj/.snow/.snow-file-explorer/env.json"],
    directory: "D:/proj/.snow/.snow-file-explorer",
    variables: new Map([
      ["version", "v1"],
      ["host", "local.test"],
    ]),
    tables: new Map<string, HttpEnvironmentTable>([
      [SHARED_ENVIRONMENT_NAME, new Map([["version", "v1"]])],
      ["local", new Map([["host", "local.test"]])],
      [
        "production",
        new Map([
          ["host", "api.test"],
          ["token", "secret"],
        ]),
      ],
    ]),
    publicTables: new Map<string, HttpEnvironmentTable>([
      [SHARED_ENVIRONMENT_NAME, new Map([["version", "v1"]])],
      ["local", new Map([["host", "local.test"]])],
      [
        "production",
        new Map([
          ["host", "api.test"],
          ["token", "pub"],
        ]),
      ],
    ]),
    privateKeys: ["production/token"],
  });
}

/**
 * 摆出环境区并记下那颗「修改」被叫到几次。
 * @param options.manage 点「修改」时的通道；给 null 表示干脆不给这条通道（读那颗钮摆不摆）
 * @param options.environment 环境概况；不给就是 listedEnv() 那一份
 */
function listPanel(
  options: { manage?: (() => Promise<void>) | null; environment?: HttpEnvironmentSummary } = {}
): { host: HTMLElement; managed: number } {
  const outcome = { managed: 0 };
  const host = document.createElement("div");
  const manage =
    options.manage === null
      ? undefined
      : options.manage ||
        (() => {
          outcome.managed += 1;
          return Promise.resolve();
        });
  renderHttpRequestPanel(
    host,
    panelOptions("GET https://a.test/{{host}}/x", {
      environment: options.environment || listedEnv(),
      onManageEnvironments: manage,
    })
  );
  // managed 是取数时才现算的计数器，提前解构会把它冻在 0。
  return { host, get managed() { return outcome.managed; } };
}

test("HTTP 环境区: 区外只有一颗「修改」，逐段清单不再摆出来", () => {
  const { host } = listPanel();
  assert.equal(host.querySelectorAll(".sfe-http-env button").length, 1, "整块环境区只许一颗按钮");
  assert.notEqual(host.querySelector(".sfe-http-env-modify"), null);
  assert.equal(String(host.querySelector(".sfe-http-env-modify")?.textContent).includes("修改"), true);
  for (const gone of [".sfe-http-env-list", ".sfe-http-env-item", ".sfe-http-env-edit", ".sfe-http-env-remove", ".sfe-http-env-create", ".sfe-http-env-reload"]) {
    assert.equal(host.querySelector(gone), null, `${gone} 这一类控件都不该在区外出现`);
  }
  assert.equal(host.querySelectorAll(".sfe-http-env input").length, 0, "什么也没点就不许出现一格能敲的地方");
});

test("HTTP 环境区: 点「修改」就是把弹窗那一脚交出去，别的一概不动", async () => {
  const panel = listPanel();
  panel.host.querySelector<HTMLButtonElement>(".sfe-http-env-modify")!.click();
  await Promise.resolve();
  // managed 是取数时才现算的计数器，提前解构会把它冻在 0。
  assert.equal(panel.managed, 1);
});

test("HTTP 环境区: 没给这条通道就不摆那颗钮，切换下拉照常在", () => {
  const { host } = listPanel({ manage: null });
  assert.equal(host.querySelector(".sfe-http-env-modify"), null, "点了没反应的按钮不摆");
  assert.notEqual(host.querySelector(".sfe-http-env-select"), null);
});

/** 一篇既定义了文件变量、又用到 `{{ }}` 的样例：环境那一行与变量条同屏。 */
const VARIABLES_TEXT = ["@host = a.test", "@port = 8080", "", "GET https://{{host}}/{{port}}/x"].join("\n");

test("HTTP 文件变量: 默认收起，折叠钮钉在环境那一行右侧并直接报出几项", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(
    host,
    panelOptions(VARIABLES_TEXT, { environment: listedEnv(), onToggleVariables: () => {} })
  );
  assert.equal(host.querySelectorAll(".sfe-http-variable").length, 0, "默认不占首屏");
  const fold = host.querySelector<HTMLButtonElement>(".sfe-http-env-fold");
  assert.notEqual(fold, null);
  assert.equal(String(fold!.textContent).includes("文件变量 2"), true, "钮上直接说有几项，收起也不觉得少了什么");
  assert.equal(fold!.getAttribute("aria-expanded"), "false");
  const line = host.querySelector(".sfe-http-env-line");
  assert.equal(line!.lastElementChild === fold, true, "就在环境那一行的最右一个位置");
});

test("HTTP 文件变量: 展开后才逐条列出来", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(
    host,
    panelOptions(VARIABLES_TEXT, { environment: listedEnv(), variablesCollapsed: false, onToggleVariables: () => {} })
  );
  assert.deepEqual(
    [...host.querySelectorAll(".sfe-http-variable")].map((chip) => chip.textContent),
    ["@host = a.test", "@port = 8080"]
  );
  assert.equal(host.querySelector<HTMLButtonElement>(".sfe-http-env-fold")!.getAttribute("aria-expanded"), "true");
});

test("HTTP 文件变量: 点折叠钮就交那一脚开合", () => {
  const host = document.createElement("div");
  let toggled = 0;
  renderHttpRequestPanel(
    host,
    panelOptions(VARIABLES_TEXT, {
      environment: listedEnv(),
      onToggleVariables: () => {
        toggled += 1;
      },
    })
  );
  host.querySelector<HTMLButtonElement>(".sfe-http-env-fold")!.click();
  assert.equal(toggled, 1);
});

test("HTTP 文件变量: 环境那一行没出现时折叠钮自己占一行，不留展开不了的死角", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(
    host,
    panelOptions(["@host = a.test", "", "GET https://a.test/x"].join("\n"), { onToggleVariables: () => {} })
  );
  assert.equal(host.querySelector(".sfe-http-env"), null, "这篇没用到要人给值的变量，环境那一行不出现");
  const head = host.querySelector(".sfe-http-variables-head");
  assert.notEqual(head, null, "折叠钮得有自己的位置");
  assert.notEqual(head!.querySelector(".sfe-http-env-fold"), null);
});

test("HTTP 文件变量: 没给开合通道就不摆钮，变量条照旧一直列着", () => {
  const host = document.createElement("div");
  renderHttpRequestPanel(host, panelOptions(VARIABLES_TEXT, { environment: listedEnv() }));
  assert.equal(host.querySelector(".sfe-http-env-fold"), null, "点了没反应的控件不摆");
  assert.equal(host.querySelectorAll(".sfe-http-variable").length, 2, "没有折叠入口就一直列着");
});

test("HTTP 环境区: 一个可选环境都没有时不摆死下拉，那颗「修改」照摆", () => {
  const onlyShared = envOf({
    hasShared: true,
    files: ["D:/proj/.snow/.snow-file-explorer/env.json"],
    tables: new Map<string, HttpEnvironmentTable>([[SHARED_ENVIRONMENT_NAME, new Map([["version", "v1"]])]]),
  });
  const { host } = listPanel({ environment: onlyShared });
  assert.equal(host.querySelector(".sfe-http-env-select"), null, "只剩「不选环境」的下拉是颗死控件");
  assert.notEqual(host.querySelector(".sfe-http-env-modify"), null, "没得切不等于没得改");
});
