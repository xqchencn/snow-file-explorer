import test from "node:test";
import assert from "node:assert/strict";
import { parseHttpFile } from "../../../src/services/http-request-parser.ts";
import { applyHttpEdits, formValuesOfRequest, updateHttpText } from "../../../src/services/http-serialize.ts";
import type { HttpFormValues } from "../../../src/services/http-serialize.ts";

/** 复制一份表单值，用例改完再传回去，避免直接改动解析结果。 */
function cloneForm(values: HttpFormValues): HttpFormValues {
  return { ...values, headers: values.headers.map((header) => ({ ...header })) };
}

const SAMPLE = [
  "@host = a.test",
  "",
  "# @name listUsers",
  "GET https://{{host}}/users?page=2 HTTP/1.1",
  "Accept: application/json",
  "",
  "###",
  "",
  "POST https://{{host}}/users",
  "Content-Type: application/json",
  "",
  '{ "name": "Ada" }',
  "",
  "###",
  "",
  "# 末尾这条整块都不动",
  "GET https://{{host}}/health",
].join("\n");

test("HTTP 写回: 没有任何改动时产物与原文逐字符相同", () => {
  const file = parseHttpFile(SAMPLE);
  assert.equal(applyHttpEdits(SAMPLE, file, new Map()), SAMPLE);
  assert.equal(file.requests.length, 3);
});

test("HTTP 写回: 只改 URL 时只有那一段变，注释与 HTTP 版本都保住", () => {
  const file = parseHttpFile(SAMPLE);
  const values = cloneForm(formValuesOfRequest(file.requests[0]));
  values.url = "https://{{host}}/people";
  const out = applyHttpEdits(SAMPLE, file, new Map([[0, values]]));
  const lines = out.split("\n");
  assert.equal(lines[3], "GET https://{{host}}/people HTTP/1.1", "协议版本按原样补回");
  assert.equal(lines[0], "@host = a.test");
  assert.equal(lines[2], "# @name listUsers");
  assert.equal(lines[4], "Accept: application/json");
  assert.ok(out.includes('{ "name": "Ada" }'), "第二个请求块原封不动");
  assert.ok(out.includes("# 末尾这条整块都不动"));
});

test("HTTP 写回: 缩进成多行的查询串被合成一行", () => {
  const text = ["GET https://a.test/comments", "    ?page=2", "    &size=10", "Accept: text/plain"].join("\n");
  const file = parseHttpFile(text);
  const out = applyHttpEdits(text, file, new Map([[0, cloneForm(formValuesOfRequest(file.requests[0]))]]));
  assert.equal(out, ["GET https://a.test/comments?page=2&size=10", "Accept: text/plain"].join("\n"));
});

test("HTTP 写回: 加头部、删光头部、加正文、删正文四种形状都落得回去", () => {
  const text = ["GET https://a.test/x", "Accept: text/plain"].join("\n");
  const file = parseHttpFile(text);
  const base = formValuesOfRequest(file.requests[0]);

  const added = cloneForm(base);
  added.headers.push({ name: "X-Trace", value: "1" });
  assert.equal(
    applyHttpEdits(text, file, new Map([[0, added]])),
    ["GET https://a.test/x", "Accept: text/plain", "X-Trace: 1"].join("\n")
  );

  const stripped = cloneForm(base);
  stripped.headers = [];
  assert.equal(applyHttpEdits(text, file, new Map([[0, stripped]])), "GET https://a.test/x");

  const withBody = cloneForm(stripped);
  withBody.body = '{"a":1}';
  assert.equal(applyHttpEdits(text, file, new Map([[0, withBody]])), 'GET https://a.test/x\n\n{"a":1}');

  const bodyless = cloneForm(withBody);
  bodyless.body = "";
  assert.equal(applyHttpEdits(text, file, new Map([[0, bodyless]])), "GET https://a.test/x");
});

test("HTTP 写回: 多行正文整段替换，块与块之间的空行不丢", () => {
  const text = ["POST https://a.test", "Content-Type: text/plain", "", "line one", "line two", "", "###", "", "GET https://a.test/next"].join(
    "\n"
  );
  const file = parseHttpFile(text);
  const values = cloneForm(formValuesOfRequest(file.requests[0]));
  values.body = "only line";
  const out = applyHttpEdits(text, file, new Map([[0, values]]));
  assert.equal(
    out,
    ["POST https://a.test", "Content-Type: text/plain", "", "only line", "", "###", "", "GET https://a.test/next"].join("\n")
  );
});

test("HTTP 写回: CRLF 文件写回后仍是 CRLF", () => {
  const crlf = "GET https://a.test/x\r\nAccept: text/plain";
  const file = parseHttpFile(crlf);
  const values = cloneForm(formValuesOfRequest(file.requests[0]));
  values.method = "DELETE";
  const out = applyHttpEdits(crlf, file, new Map([[0, values]]));
  assert.equal(out, "DELETE https://a.test/x\r\nAccept: text/plain");
});

test("HTTP 写回: 同时改两个块，行号从后往前落位不串", () => {
  const file = parseHttpFile(SAMPLE);
  const first = cloneForm(formValuesOfRequest(file.requests[0]));
  first.url = "https://one";
  const second = cloneForm(formValuesOfRequest(file.requests[1]));
  second.body = '{ "name": "Grace" }';
  const out = applyHttpEdits(SAMPLE, file, new Map([
    [0, first],
    [1, second],
  ]));
  assert.ok(out.includes("GET https://one HTTP/1.1"));
  assert.ok(out.includes('{ "name": "Grace" }'));
  assert.ok(!out.includes('{ "name": "Ada" }'));
  assert.ok(out.includes("GET https://{{host}}/health"), "第三块没被行号串位吃掉");
});

test("HTTP 写回: 连着改同一个请求（模拟逐字键入）不会把文本切坏", () => {
  let text = ["GET https://a.test/x", "Accept: text/plain", "", "###", "", "POST https://a.test/y", "", "body"].join("\n");
  let file = parseHttpFile(text);
  // 先在第一块里加一行头部（块行数变化），再连续改 URL 三次。
  const withHeader = cloneForm(formValuesOfRequest(file.requests[0]));
  withHeader.headers.push({ name: "X-Add", value: "1" });
  let state = updateHttpText(text, file, 0, withHeader);
  text = state.text;
  file = state.file;
  assert.equal(file.requests.length, 2);
  assert.deepEqual(file.requests[0].headers.map((header) => header.name), ["Accept", "X-Add"]);

  for (const suffix of ["/y", "/yz", "/zab"]) {
    const values = cloneForm(formValuesOfRequest(file.requests[0]));
    values.url = `https://a.test${suffix}`;
    state = updateHttpText(text, file, 0, values);
    text = state.text;
    file = state.file;
    assert.equal(file.requests.length, 2, `改成 ${suffix} 后仍应有两个请求`);
    assert.equal(file.requests[0].url, `https://a.test${suffix}`);
    assert.equal(file.requests[1].url, "https://a.test/y", "第二块始终不受影响");
  }
  assert.equal(
    text,
    ["GET https://a.test/zab", "Accept: text/plain", "X-Add: 1", "", "###", "", "POST https://a.test/y", "", "body"].join("\n")
  );
});

test("HTTP 写回: 表单值与原文等价（含首尾空格）时产物逐字符不变，改一个字符才变", () => {
  const file = parseHttpFile(SAMPLE);
  const base = formValuesOfRequest(file.requests[0]);
  const same = cloneForm(base);
  same.url = `  ${base.url}  `;
  assert.equal(applyHttpEdits(SAMPLE, file, new Map([[0, same]])), SAMPLE, "值没变就不该产生 diff");

  const changed = cloneForm(base);
  changed.url = base.url + "?x=1";
  assert.notEqual(applyHttpEdits(SAMPLE, file, new Map([[0, changed]])), SAMPLE);

  const headerChanged = cloneForm(base);
  headerChanged.headers[0].value = "text/html";
  assert.notEqual(applyHttpEdits(SAMPLE, file, new Map([[0, headerChanged]])), SAMPLE);
});

test("HTTP 写回: GraphQL 请求的变量段不因改动其它字段而丢失", () => {
  const text = [
    "### 查询",
    "POST https://a.test/graphql",
    "X-Request-Type: GraphQL",
    "",
    "query Foo { a }",
    "",
    '{"id": 1}',
    "",
  ].join("\n");
  const file = parseHttpFile(text);
  assert.equal(file.requests[0].graphQlVariables, '{"id": 1}');

  // 只改地址：变量段不在表单里可编，但它是请求体的一部分，必须原样留在文件里。
  const values = cloneForm(formValuesOfRequest(file.requests[0]));
  values.url = "https://a.test/v2/graphql";
  const next = updateHttpText(text, file, 0, values);
  assert.equal(parseHttpFile(next.text).requests[0].graphQlVariables, '{"id": 1}', "变量段被静默删掉就等于改了请求语义");
});

test("HTTP 写回: 地址清空后写回的行仍能往返解析（不再变成 url=HTTP/1.1）", () => {
  const text = "GET https://a.test/x HTTP/1.1\nAccept: */*\n";
  const file = parseHttpFile(text);
  const values = cloneForm(formValuesOfRequest(file.requests[0]));
  values.url = "";
  const next = updateHttpText(text, file, 0, values);
  const reparsed = parseHttpFile(next.text).requests[0];
  assert.equal(reparsed.url, "", "空地址就写回空地址");
  assert.equal(reparsed.httpVersion, null, "没有地址就不该把版本号孤零零留在请求行上");
});

test("HTTP 写回: 首行 BOM 原样保留，不被写回抹掉", () => {
  const text = "\uFEFF### 登录\nPOST https://a.test/login\n";
  const file = parseHttpFile(text);
  const values = cloneForm(formValuesOfRequest(file.requests[0]));
  values.url = "https://a.test/login2";
  const next = updateHttpText(text, file, 0, values);
  assert.equal(next.text.startsWith("\uFEFF"), true);
  assert.equal(parseHttpFile(next.text).requests[0].title, "登录");
});

test("HTTP 写回: 块内的注释行不因改一个字段被抹掉，且落回原来的相对位置", () => {
  const text = [
    "POST https://a.test/x",
    "# 头部区的说明",
    "Accept: application/json",
    "",
    "{",
    '  "a": 1,',
    "  // 正文里的说明",
    '  "b": 2',
    "}",
  ].join("\n");
  const file = parseHttpFile(text);
  const values = cloneForm(formValuesOfRequest(file.requests[0]));
  values.url = "https://a.test/y";
  const next = updateHttpText(text, file, 0, values);
  assert.equal(next.text.includes("# 头部区的说明"), true, "头部区的注释不能丢");
  assert.equal(next.text.includes("  // 正文里的说明"), true, "正文区的注释不能丢");
  assert.equal(
    next.text.includes('"a": 1,\n  // 正文里的说明\n  "b": 2'),
    true,
    `正文注释要回到原文里夹着的那两行之间：\n${next.text}`
  );
});
