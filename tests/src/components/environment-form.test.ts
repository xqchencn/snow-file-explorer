import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import type { TranslateFn } from "../../../src/types/panel-state.ts";
import { SHARED_ENVIRONMENT_NAME } from "../../../src/services/http-env.ts";

// 组件建节点用的是全局 document，所以先把 jsdom 挂上，再导入渲染模块。
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { createEnvironmentForm } = await import("../../../src/components/environment-form.ts");

/** 翻译桩：回兜底文案并补 `{{x}}` 插值。 */
const t = ((key: string, fallback?: string, values?: Record<string, string | number>) => {
  let text = fallback || key;
  for (const [name, value] of Object.entries(values || {})) text = text.replace(`{{${name}}}`, String(value));
  return text;
}) as TranslateFn;

/** 一段的入参形状，与组件声明一致（这里再写一遍是为了用例里能简短地造段）。 */
type Section = { name: string; variables: Array<{ key: string; value: string }> };

/**
 * 建一份表单并挂到文档上（焦点只长在真挂上去的树上）。
 * @param sections 摊开的这些段；`name` 为空串表示这一段待命名
 * @param takenNames 已占用的段名（新段查重用）
 * @param privateKeys 私密表里出现过的「段名/键名」
 * @param fileVariables 这篇文件的文件变量（摆第二页，只念）；不给就没有第二页
 */
function scene(
  sections: Section[] = [],
  takenNames: string[] = [],
  privateKeys: string[] = [],
  fileVariables: Array<{ name: string; value: string }> = []
) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const form = createEnvironmentForm({ t, sections, takenNames, privateKeys, fileVariables });
  host.appendChild(form.node);
  return { host, form };
}

/** 取某一段的根节点（按界面上的顺序）。 */
function sectionAt(host: HTMLElement, index: number): HTMLElement {
  return host.querySelectorAll<HTMLElement>(".sfe-env-form-section")[index]!;
}

test("环境弹窗: 一段都没有时进来就给一段待命名的，末尾那行空行就是加项的地方", () => {
  const { host } = scene();
  assert.equal(host.querySelectorAll(".sfe-env-form-section").length, 1);
  const section = sectionAt(host, 0);
  assert.notEqual(section.querySelector<HTMLInputElement>(".sfe-env-form-section-name"), null, "这一段的名字要能填");
  assert.equal(section.querySelectorAll(".sfe-env-form-row").length, 1, "末尾那一行空行就是「再加一项」");
  assert.equal(section.querySelector(".sfe-env-form-add"), null, "有空行等着填，「添加变量」那颗按钮就是多余的");
  assert.notEqual(host.querySelector(".sfe-env-form-add-section"), null, "整张表底下加一段");
  assert.equal(section.querySelector(".sfe-env-form-section-remove"), null, "还没生效的一段没有「删掉」可点");
});

/**
 * 空行自己就是入口：填了它再补一行，清空它又收回去。
 * @description 「每次多留一行空的」与「点一下添加变量」是同一件事的两种做法，前者省一次点击；
 *   但只补不收就会越敲越多，两头都要钉住。
 */
test("环境弹窗: 填末尾那行自动补一行，清空自动收掉，永远只留一行空的在最后", () => {
  const { host } = scene([{ name: "local", variables: [{ key: "host", value: "l.test" }] }]);
  const section = sectionAt(host, 0);
  const keys = (): HTMLInputElement[] => [...section.querySelectorAll<HTMLInputElement>(".sfe-env-form-key")];
  assert.equal(keys().length, 2, "既有的一行 + 末尾等着填的那一行");
  const blank = keys()[1];
  blank.value = "token";
  blank.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(keys().length, 3, "填了它就再补一行，不必点任何按钮");
  assert.equal(keys()[2].value, "", "补上来的那一行是空的");
  blank.value = "";
  blank.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(keys().length, 2, "清空它就收掉多出来的那一行，不堆空行");
});

test("环境弹窗: 待命名那段空名字与带分隔符的名字是同一条拦截理由", () => {
  const { host, form } = scene();
  assert.equal(form.collect().error, "环境名不能为空，也不能带 / \\ 或 ..", "没填就要说清缺什么");
  host.querySelector<HTMLInputElement>(".sfe-env-form-section-name")!.value = "a/b";
  assert.equal(form.collect().error, "环境名不能为空，也不能带 / \\ 或 ..");
  assert.equal(form.collect().tables, undefined, "拦下来时不许半张表交出去");
});

test("环境弹窗: 新段撞了已有名字就点名那个名字，比较不分大小写", () => {
  const { host, form } = scene([], ["Staging"]);
  host.querySelector<HTMLInputElement>(".sfe-env-form-section-name")!.value = "staging";
  assert.equal(form.collect().error, "已经有叫 staging 的环境，换个名字", "名字最后要拼进文件，大小写撞了就是同一条");
});

test("环境弹窗: 一次加的两段互相撞名也拦，第一段的名字不算「已有环境」", () => {
  const { host, form } = scene([], []);
  const first = host.querySelector<HTMLInputElement>(".sfe-env-form-section-name")!;
  first.value = "qa";
  host.querySelector<HTMLButtonElement>(".sfe-env-form-add-section")!.click();
  const added = [...host.querySelectorAll<HTMLInputElement>(".sfe-env-form-section-name")].pop()!;
  added.value = "QA";
  assert.equal(form.collect().error, "已经有叫 QA 的环境，换个名字", "同一次保存里也不能写出两段同名");
  added.value = "perf";
  assert.deepEqual(
    form.collect().tables?.map((table) => table.name),
    ["qa", "perf"],
    "改了就能再点保存，不用重开弹窗"
  );
});

test("环境弹窗: 收表时段名 trim、空键的行丢掉、值原样留着", () => {
  const { host, form } = scene();
  host.querySelector<HTMLInputElement>(".sfe-env-form-section-name")!.value = "  staging  ";
  const section = sectionAt(host, 0);
  const first = section.querySelector<HTMLInputElement>(".sfe-env-form-key")!;
  first.value = "host";
  first.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const values = [...section.querySelectorAll<HTMLInputElement>(".sfe-env-form-value")];
  values[0].value = "https://a.test  ";
  // 自动补上来的那一行只填了值、没填名字：那是「还没填」，不算一项。
  values[1].value = "orphan";
  const result = form.collect();
  assert.equal(result.error, undefined);
  assert.deepEqual(result.tables, [
    { name: "staging", variables: [{ key: "host", value: "https://a.test  " }] },
  ], "值末尾的空格是有内容的，不许顺手 trim 掉");
});

test("环境弹窗: 多段按界面上的顺序整张交回去", () => {
  const { form } = scene([
    { name: SHARED_ENVIRONMENT_NAME, variables: [{ key: "version", value: "v1" }] },
    { name: "local", variables: [{ key: "host", value: "l.test" }] },
  ]);
  assert.deepEqual(form.collect().tables, [
    { name: SHARED_ENVIRONMENT_NAME, variables: [{ key: "version", value: "v1" }] },
    { name: "local", variables: [{ key: "host", value: "l.test" }] },
  ]);
});

test("环境弹窗: 已有段的名字只读，交回去的还是那一个", () => {
  const { host, form } = scene([{ name: "staging", variables: [{ key: "host", value: "s.test" }] }]);
  const section = sectionAt(host, 0);
  assert.equal(String(section.querySelector(".sfe-env-form-section-name-static")?.textContent), "staging");
  assert.equal(String(section.querySelector(".sfe-env-form-section-name-static")?.getAttribute("title")).includes("不能改"), true);
  assert.equal(section.querySelector(".sfe-env-form-section-name"), null, "改不动的名字不给摆能敲的框");
  assert.equal(form.collect().tables?.[0]?.name, "staging", "要换名字就删了这段再建一段");
});

test("环境弹窗: $shared 是保留名，不给删掉整段的入口", () => {
  const { host } = scene([
    { name: SHARED_ENVIRONMENT_NAME, variables: [] },
    { name: "local", variables: [] },
  ]);
  assert.equal(sectionAt(host, 0).querySelector(".sfe-env-form-section-remove"), null, "删掉它等于删掉「对所有环境可见」");
  assert.notEqual(sectionAt(host, 1).querySelector(".sfe-env-form-section-remove"), null, "普通段删得掉");
});

test("环境弹窗: 删掉的那一段整段从表里消失，剩下的照原顺序交回去", () => {
  const { host, form } = scene([
    { name: "local", variables: [{ key: "host", value: "l.test" }] },
    { name: "perf", variables: [{ key: "host", value: "p.test" }] },
  ]);
  sectionAt(host, 0).querySelector<HTMLButtonElement>(".sfe-env-form-section-remove")!.click();
  assert.equal(host.querySelectorAll(".sfe-env-form-section").length, 1, "摘掉的是整段，不只是段头");
  assert.deepEqual(form.collect().tables, [{ name: "perf", variables: [{ key: "host", value: "p.test" }] }]);
});

test("环境弹窗: 删掉的行不收进草稿，剩下的按界面上的顺序交出去", () => {
  const { host, form } = scene([
    {
      name: "local",
      variables: [
        { key: "host", value: "l.test" },
        { key: "token", value: "t" },
        { key: "version", value: "v1" },
      ],
    },
  ]);
  const section = sectionAt(host, 0);
  section.querySelectorAll<HTMLButtonElement>(".sfe-env-form-remove")[1]!.click();
  assert.deepEqual(
    form.collect().tables?.[0]?.variables.map((variable) => variable.key),
    ["host", "version"],
    "删掉的是中间那行，剩下的按界面上的顺序交出去"
  );
  assert.equal(section.querySelectorAll(".sfe-env-form-row").length, 3, "末尾那行空行还留着等着填");
});

test("环境弹窗: 把末尾那行空行删了也还留一行，不留一个填不进去的死角", () => {
  const { host } = scene([{ name: "local", variables: [{ key: "host", value: "l.test" }] }]);
  const section = sectionAt(host, 0);
  const removes = [...section.querySelectorAll<HTMLButtonElement>(".sfe-env-form-remove")];
  assert.equal(removes.length, 2, "既有的一行 + 末尾空行各有一颗删除");
  removes[1].click();
  const keys = [...section.querySelectorAll<HTMLInputElement>(".sfe-env-form-key")];
  assert.deepEqual(keys.map((input) => input.value), ["host", ""], "删完末尾，空行又补回来了");
});

test("环境弹窗: 私密表里也有的那一行点一句「改这里不生效」", () => {
  const { host } = scene(
    [
      {
        name: "staging",
        variables: [
          { key: "host", value: "s.test" },
          { key: "token", value: "pub" },
        ],
      },
    ],
    [],
    ["staging/token"]
  );
  const notes = [...host.querySelectorAll(".sfe-env-form-private:not([hidden])")];
  assert.equal(notes.length, 1, "没被盖住的那行别多占一句");
  assert.equal(String(notes[0].textContent).includes("staging/token"), true, "点名是哪一项");
  assert.equal(String(notes[0].textContent).includes("不生效"), true);

  // 新添的一行填上同一个键名，那一句也跟着出来：改了不顶用的坑要在填的时候就撞见。
  const { host: fresh } = scene([{ name: "staging", variables: [] }], [], ["staging/token"]);
  const key = fresh.querySelector<HTMLInputElement>(".sfe-env-form-key")!;
  key.value = "token";
  key.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(String(fresh.querySelector(".sfe-env-form-private")?.textContent).includes("token"), true);
});

test("环境弹窗: 该先聚焦的那个框——有待命名段是段名框，否则是第一行的变量名", () => {
  const { host, form } = scene();
  assert.equal(form.focusTarget, host.querySelector<HTMLInputElement>(".sfe-env-form-section-name"));
  const filled = scene([{ name: "local", variables: [{ key: "host", value: "l.test" }] }]);
  assert.equal(
    filled.form.focusTarget,
    sectionAt(filled.host, 0).querySelector<HTMLInputElement>(".sfe-env-form-key"),
    "已有段的名字改不动，焦点不该落在一个读就好的位置上"
  );
});

test("环境弹窗: 元素一次建好，重挂不换（用户刚打的字不能被抹掉）", () => {
  const { host, form } = scene();
  const name = host.querySelector<HTMLInputElement>(".sfe-env-form-section-name")!;
  name.value = "半截名字";
  const node = form.node;
  // 宿主重绘会连弹窗一起重建再挂一次：这里模拟「摘掉再挂回来」。
  node.remove();
  host.appendChild(node);
  assert.equal(host.querySelector<HTMLInputElement>(".sfe-env-form-section-name")?.value, "半截名字");
  assert.equal(form.collect().tables?.[0]?.name, "半截名字");
});

/** 取标签条上那两颗钮（按界面上的顺序）。 */
function tabsAt(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>(".sfe-env-form-tab")];
}

test("环境弹窗: 没有文件变量就不摆标签条——只剩一页可切的条是颗死控件", () => {
  const { host } = scene([{ name: "local", variables: [{ key: "host", value: "l.test" }] }]);
  assert.equal(host.querySelector(".sfe-env-form-tabs"), null);
  assert.equal(host.querySelector(".sfe-env-form-files"), null);
  assert.equal(host.querySelector<HTMLElement>(".sfe-env-form-tables")?.hidden, false, "环境表照旧直接摊开");
});

test("环境弹窗: 带文件变量时两个标签页，环境变量是第一页、进来就停在它上面", () => {
  const { host } = scene(
    [{ name: "local", variables: [{ key: "host", value: "l.test" }] }],
    [],
    [],
    [{ name: "host", value: "f.test" }]
  );
  assert.deepEqual(
    tabsAt(host).map((tab) => tab.textContent),
    ["环境变量", "文件变量"]
  );
  assert.equal(tabsAt(host)[0].getAttribute("aria-selected"), "true");
  assert.equal(tabsAt(host)[1].getAttribute("aria-selected"), "false");
  assert.equal(host.querySelector<HTMLElement>(".sfe-env-form-tables")?.hidden, false);
  assert.equal(host.querySelector<HTMLElement>(".sfe-env-form-files")?.hidden, true, "第二页收着，等点标签");
});

test("环境弹窗: 文件变量那一页只念，一行一个 @名字 与它的值", () => {
  const { host } = scene([], [], [], [
    { name: "host", value: "a.test" },
    { name: "token", value: "s3cr3t" },
  ]);
  const pane = host.querySelector<HTMLElement>(".sfe-env-form-files")!;
  const rows = [...pane.querySelectorAll<HTMLElement>(".sfe-env-form-file-row")];
  assert.deepEqual(
    rows.map((row) => [
      row.querySelector<HTMLElement>(".sfe-env-form-file-name")!.textContent,
      row.querySelector<HTMLElement>(".sfe-env-form-file-value")!.textContent,
    ]),
    [["@host", "a.test"], ["@token", "s3cr3t"]],
    "顺序照文件里的定义顺序，值原样"
  );
  assert.equal(pane.querySelectorAll("input, button").length, 0, "这一页一个能敲的都不给：改了不回文件，就是骗人敲一遍");
  assert.equal(String(pane.querySelector(".sfe-env-form-file-hint")?.textContent).includes("同名"), true, "要说清它和环境里的同名值谁生效");
});

test("环境弹窗: 点标签只换「藏哪一页」，站在文件变量那页按保存也收得着整张环境表", () => {
  const { host, form } = scene(
    [{ name: "local", variables: [{ key: "host", value: "l.test" }] }],
    [],
    [],
    [{ name: "file", value: "f" }]
  );
  tabsAt(host)[1].click();
  assert.equal(host.querySelector<HTMLElement>(".sfe-env-form-tables")?.hidden, true);
  assert.equal(host.querySelector<HTMLElement>(".sfe-env-form-files")?.hidden, false);
  assert.equal(tabsAt(host)[1].getAttribute("aria-selected"), "true");
  assert.equal(tabsAt(host)[0].getAttribute("aria-selected"), "false");
  assert.deepEqual(form.collect().tables, [{ name: "local", variables: [{ key: "host", value: "l.test" }] }]);
});

test("环境弹窗: 在文件变量那页被拦下时自己切回环境表，要改的那一格才看得见", () => {
  const { host, form } = scene([], [], [], [{ name: "host", value: "a.test" }]);
  tabsAt(host)[1].click();
  // 这一段还没定名（一段都没有时组件就地给一段待命名的），拦的就是它。
  assert.notEqual(form.collect().error, undefined);
  assert.equal(host.querySelector<HTMLElement>(".sfe-env-form-tables")?.hidden, false);
  assert.equal(tabsAt(host)[0].getAttribute("aria-selected"), "true");
});

/** 取导航条上的环境 chips（按界面上的顺序）。 */
function chipsAt(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>(".sfe-env-form-chip")];
}

test("环境弹窗: 环境一次只露一段，点导航切换，藏起来的段照样收进草稿", () => {
  const { host, form } = scene([
    { name: SHARED_ENVIRONMENT_NAME, variables: [{ key: "version", value: "v1" }] },
    { name: "local", variables: [{ key: "host", value: "l.test" }] },
  ]);
  assert.deepEqual(chipsAt(host).map((chip) => chip.textContent), [SHARED_ENVIRONMENT_NAME, "local"]);
  const blocks = [...host.querySelectorAll<HTMLElement>(".sfe-env-form-section")];
  assert.equal(blocks[0].hidden, false, "第一段（$shared）进来就露着");
  assert.equal(blocks[1].hidden, true, "其余段收在导航条后面");
  chipsAt(host)[1].click();
  assert.equal(blocks[0].hidden, true, "切走的那段收起来");
  assert.equal(blocks[1].hidden, false, "点到谁露谁");
  // 眼前是 local，$shared 藏着：收表仍收整张，保存写的还是完整的表。
  assert.deepEqual(form.collect().tables, [
    { name: SHARED_ENVIRONMENT_NAME, variables: [{ key: "version", value: "v1" }] },
    { name: "local", variables: [{ key: "host", value: "l.test" }] },
  ]);
});

test("环境弹窗: 新段的导航名字跟着段名框实时走，空着就叫「新环境」", () => {
  const { host } = scene();
  const chip = chipsAt(host)[0];
  const name = host.querySelector<HTMLInputElement>(".sfe-env-form-section-name")!;
  assert.equal(chip.textContent, "新环境", "还没起名，导航上不能摆一颗写着空气的 chip");
  name.value = "staging";
  name.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(chip.textContent, "staging");
  name.value = "   ";
  name.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(chip.textContent, "新环境", "trim 完没名字就回落");
});

test("环境弹窗: 删掉眼前那段就有人接台——$shared 优先，否则第一个剩下的；导航也少一颗", () => {
  const plain = scene([
    { name: "local", variables: [] },
    { name: "perf", variables: [] },
  ]);
  chipsAt(plain.host)[0].click();
  sectionAt(plain.host, 0).querySelector<HTMLButtonElement>(".sfe-env-form-section-remove")!.click();
  const left = [...plain.host.querySelectorAll<HTMLElement>(".sfe-env-form-section")];
  assert.equal(left.length, 1, "摘掉的是整段");
  assert.equal(left[0].hidden, false, "删了眼前这段，剩下的接台");
  assert.equal(String(left[0].querySelector(".sfe-env-form-section-name-static")?.textContent), "perf");
  assert.deepEqual(
    chipsAt(plain.host).map((chip) => chip.textContent),
    ["perf"],
    "导航条上不留已删环境的名字"
  );

  const withShared = scene([
    { name: SHARED_ENVIRONMENT_NAME, variables: [] },
    { name: "local", variables: [] },
    { name: "perf", variables: [] },
  ]);
  chipsAt(withShared.host)[1].click();
  sectionAt(withShared.host, 1).querySelector<HTMLButtonElement>(".sfe-env-form-section-remove")!.click();
  const blocks = [...withShared.host.querySelectorAll<HTMLElement>(".sfe-env-form-section")];
  assert.equal(blocks.length, 2, "摘掉的是整段");
  assert.equal(blocks[0].hidden, false, "$shared 是公共底，它在就由它接台");
  assert.equal(blocks[1].hidden, true, "没轮到的照旧收着");
});

test("环境弹窗: 保存被拦时切到出错那段，交出的框就是那段的名字栏", () => {
  // takenNames 照宿主的口径给全：已有段名全算占用，撞名查的就是这一份。
  const { host, form } = scene(
    [
      { name: SHARED_ENVIRONMENT_NAME, variables: [] },
      { name: "local", variables: [] },
    ],
    [SHARED_ENVIRONMENT_NAME, "local"]
  );
  chipsAt(host)[1].click(); // 眼前是 local，出错的那段（还没建）不在眼前
  host.querySelector<HTMLButtonElement>(".sfe-env-form-add-section")!.click();
  const nameInput = [...host.querySelectorAll<HTMLInputElement>(".sfe-env-form-section-name")].pop()!;
  nameInput.value = "local";
  const result = form.collect();
  assert.equal(result.error, "已经有叫 local 的环境，换个名字");
  const blocks = [...host.querySelectorAll<HTMLElement>(".sfe-env-form-section")];
  assert.equal(blocks[2].hidden, false, "出错的那段被切到眼前，不用自己去一堆段里翻");
  assert.equal(result.offender, nameInput, "焦点该去的那一格原样交出来");
});

/** 弹窗那一份样式：显隐是组件（改 hidden）与 CSS（给不给让位）两半合起来才成立的，只测组件测不到另一半。 */
const menuCss = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src/styles/menu.css"),
  "utf8"
);

/**
 * 凡是「组件靠 hidden 收起、样式又给它设了 display」的类，都必须有一条 `[hidden]{display:none}` 让位规则。
 * @description 作者样式的 display 优先级盖得住 UA 那条 `[hidden]{display:none}`，缺了让位规则就是
 *   「该隐藏的却一直画出来」——两页同时摊开过一次，就是这个原因。
 */
for (const collapsible of ["sfe-env-form-tables", "sfe-env-form-files", "sfe-env-form-chips"]) {
  test(`环境弹窗: .${collapsible} 设了 display，就必须自带 [hidden] 让位规则`, () => {
    const setsDisplay = new RegExp(`\\.${collapsible}[\\s,{][^{}]*\\{[^}]*display\\s*:\\s*(?!none)`).test(menuCss);
    assert.equal(setsDisplay, true, "这一条是防自己写空：这个类确实要靠 display 排版，才谈得上让位");
    // 让位规则可能写在一条选择器列表里（`.a[hidden], .b[hidden] {`），所以按规则块逐条查，不能只认每块第一个选择器。
    const yields = menuCss.split("}").some((chunk) => {
      const at = chunk.indexOf("{");
      if (at < 0) return false;
      return new RegExp(`\\.${collapsible}\\[hidden\\](?![\\w-])`).test(chunk.slice(0, at)) && /display\s*:\s*none/.test(chunk.slice(at + 1));
    });
    assert.equal(yields, true, `缺 .${collapsible}[hidden] { display: none; }：hidden 会被上面的 display 盖掉`);
  });
}
