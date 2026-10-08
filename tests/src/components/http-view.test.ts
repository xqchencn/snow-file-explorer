import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { TranslateFn } from "../../../src/types/panel-state.ts";
import type { HttpRestFile } from "../../../src/services/http-file-scan.ts";

// 建立最小 DOM 环境后再导入渲染模块
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { buildHttpFileTree, countHttpTreeFiles, flattenHttpTree, renderHttpList } = await import(
  "../../../src/components/http-view.ts"
);

/** 翻译桩：只用到 key + 兜底文案，签名复用组件消费的 TranslateFn。 */
const t: TranslateFn = (_key, fallback) => fallback || _key;

/** 构造扫描结果桩：绝对路径按相对路径拼出来，够组件用。 */
function httpFile(relPath: string): HttpRestFile {
  const segments = relPath.split("/");
  return {
    name: segments[segments.length - 1],
    path: `D:/repo/${relPath}`,
    relPath,
    size: 12,
  };
}

/** renderHttpList 的最小选项：用例只覆盖自己关心的回调。 */
function options(partial: Partial<Parameters<typeof renderHttpList>[1]> = {}) {
  return {
    files: [] as HttpRestFile[],
    scanning: false,
    truncated: false,
    selectedPath: null as string | null,
    collapsed: new Set<string>(),
    t,
    ...partial,
  } as Parameters<typeof renderHttpList>[1];
}

/** 取列表行（含目录行与文件行）。 */
function rows(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(".sfe-http-row"));
}

test("HTTP 列表: 相对路径按目录成树，目录行带子树文件数", () => {
  const tree = buildHttpFileTree([httpFile("src/api/v1/users.http"), httpFile("src/order.rest"), httpFile("top.http")]);
  assert.deepEqual(
    tree.map((node) => [node.name, node.relPath, node.file !== undefined]),
    [
      ["src", "src", false],
      ["top.http", "top.http", true],
    ],
    "目录在前、同名按升序"
  );
  assert.equal(countHttpTreeFiles(tree[0]), 2);
  const api = tree[0].children[0];
  assert.equal(api.name, "api");
  assert.equal(flattenHttpTree(tree, new Set()).length, 6, "三个目录层（src/api/v1）+ 三个文件");
});

test("HTTP 列表: 折叠目录后其子树不出现在行序列里", () => {
  const tree = buildHttpFileTree([httpFile("src/api/users.http"), httpFile("docs/read.http")]);
  const open = flattenHttpTree(tree, new Set());
  const collapsed = flattenHttpTree(tree, new Set(["src"]));
  assert.deepEqual(
    collapsed.filter((row) => row.kind === "file").map((row) => (row.kind === "file" ? row.file.relPath : "")),
    ["docs/read.http"]
  );
  assert.ok(collapsed.length < open.length);
  const folderRow = collapsed.find((row) => row.kind === "folder" && row.node.relPath === "src");
  assert.equal(folderRow?.kind === "folder" ? folderRow.isExpanded : true, false);
});

test("HTTP 列表: 单击文件行触发打开，且整列只留这一行高亮", () => {
  const host = document.createElement("div");
  const opened: string[] = [];
  renderHttpList(
    host,
    options({
      files: [httpFile("a.http"), httpFile("b.rest")],
      onOpenFile: (file) => opened.push(file.relPath),
    })
  );
  const listRows = rows(host);
  assert.equal(listRows.length, 2);
  listRows[1].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(opened, ["b.rest"]);
  assert.equal(listRows[1].classList.contains("selected"), true);
  assert.equal(listRows[0].classList.contains("selected"), false);

  // 再点第一行：上一行的高亮必须被清掉，而不是两行同时亮。
  listRows[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(listRows[0].classList.contains("selected"), true);
  assert.equal(listRows[1].classList.contains("selected"), false);
});

test("HTTP 列表: 重绘不重建头部与滚动容器，且选中态按选项回放", () => {
  const host = document.createElement("div");
  renderHttpList(host, options({ files: [httpFile("a.http")] }));
  const head = host.querySelector(".sfe-http-head");
  const scroll = host.querySelector(".sfe-http-scroll");
  assert.ok(head && scroll, "首次渲染建出头部与滚动容器");

  renderHttpList(host, options({ files: [httpFile("a.http"), httpFile("b.rest")], selectedPath: "D:/repo/b.rest" }));
  assert.equal(host.querySelector(".sfe-http-head"), head, "头部复用同一节点");
  assert.equal(host.querySelector(".sfe-http-scroll"), scroll, "滚动容器复用同一节点");
  assert.equal(host.querySelectorAll(".sfe-http-head").length, 1);
  const selected = Array.from(scroll.querySelectorAll(".sfe-http-row.selected"));
  assert.equal(selected.length, 1, "重建后按 selectedPath 回放高亮");
  assert.equal(selected[0].textContent!.includes("b.rest"), true);
  assert.equal(host.querySelector(".sfe-http-head-title")!.textContent!.includes("2"), true, "计数跟随清单");
});

test("HTTP 列表: 单击目录行只切折叠，不打开任何文件", () => {
  const host = document.createElement("div");
  const toggled: string[] = [];
  const opened: string[] = [];
  renderHttpList(
    host,
    options({
      files: [httpFile("src/a.http")],
      onToggleCollapse: (relPath) => toggled.push(relPath),
      onOpenFile: (file) => opened.push(file.relPath),
    })
  );
  const folder = rows(host).find((row) => row.classList.contains("sfe-http-folder-row"))!;
  folder.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(toggled, ["src"]);
  assert.deepEqual(opened, []);
});

test("HTTP 列表: 空态区分扫描中与确实没有，截断时追加一条说明", () => {
  const scanningHost = document.createElement("div");
  renderHttpList(scanningHost, options({ files: [], scanning: true }));
  assert.equal(scanningHost.querySelector(".sfe-http-empty-title")!.textContent, "正在查找请求文件…");
  // 扫描中说「这里展示的是什么」是废话：结论还没出来，别先解释这块是干嘛的。
  assert.equal(scanningHost.querySelector(".sfe-http-empty-hint"), null, "扫描中不出现说明行");

  const emptyHost = document.createElement("div");
  renderHttpList(emptyHost, options({ files: [] }));
  assert.equal(emptyHost.querySelector(".sfe-http-empty-title")!.textContent, "没有请求文件");
  // 确实没有时补一句这里是干嘛的：光说「没有」用户不知道这视图该装什么。
  assert.equal(
    emptyHost.querySelector(".sfe-http-empty-hint")!.textContent,
    "当前展示项目里的 REST 请求文件（.http / .rest）",
    "只说这块展示什么；新建入口已经在列表头上，不必再教用户去项目里手建再回来重扫"
  );

  const truncatedHost = document.createElement("div");
  renderHttpList(truncatedHost, options({ files: [httpFile("a.http")], truncated: true }));
  assert.equal(truncatedHost.querySelectorAll(".sfe-http-note").length, 1);
  assert.equal(truncatedHost.querySelector(".sfe-http-note")!.textContent, "目录过多，列表可能不完整");
});

test("HTTP 列表: 给了刷新回调才出现刷新按钮，点击即重扫", () => {
  const host = document.createElement("div");
  let rescanned = 0;
  renderHttpList(host, options({ files: [httpFile("a.http")], onRefresh: () => (rescanned += 1) }));
  const button = host.querySelector<HTMLButtonElement>(".sfe-http-head-action")!;
  assert.equal(button.title, "重新扫描");
  button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(rescanned, 1);

  const noRefresh = document.createElement("div");
  renderHttpList(noRefresh, options({ files: [httpFile("a.http")] }));
  assert.equal(noRefresh.querySelector(".sfe-http-head-action"), null);
});

test("HTTP 列表: 给了新建回调才出现「新建请求文件」，点击即发起", () => {
  const host = document.createElement("div");
  let created = 0;
  renderHttpList(host, options({ files: [httpFile("a.http")], onCreateRequestFile: () => (created += 1) }));
  const buttons = [...host.querySelectorAll<HTMLButtonElement>(".sfe-http-head-action")];
  assert.equal(buttons.length, 1, "只给新建时头部就只有这一颗按钮");
  assert.equal(buttons[0].title, "新建请求文件");
  buttons[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(created, 1);

  // 两颗都在时才并排；没给新建通道就别摆一颗点不动的按钮。
  const both = document.createElement("div");
  renderHttpList(both, options({ files: [httpFile("a.http")], onRefresh: () => {}, onCreateRequestFile: () => {} }));
  assert.deepEqual(
    [...both.querySelectorAll<HTMLButtonElement>(".sfe-http-head-action")].map((button) => button.title),
    ["新建请求文件", "重新扫描"]
  );
  const refreshOnly = document.createElement("div");
  renderHttpList(refreshOnly, options({ files: [httpFile("a.http")], onRefresh: () => {} }));
  assert.equal(refreshOnly.querySelectorAll(".sfe-http-head-action").length, 1);
});
