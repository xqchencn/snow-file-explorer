import test from "node:test";
import assert from "node:assert/strict";
import { parseHttpFile } from "../../../src/services/http-request-parser.ts";
import { runHttpRequest } from "../../../src/services/http-runner.ts";
import type { HttpFetch, HttpRunOptions } from "../../../src/services/http-runner.ts";
import type { PluginNetResponse } from "../../../src/types/plugin-runtime.ts";

/** 翻译桩：直接回兜底文案，并把 `{{x}}` 插值补上，断言读起来才是人话。 */
const t = ((key: string, fallback?: string, values?: Record<string, string | number>) => {
  let text = fallback || key;
  for (const [name, value] of Object.entries(values || {})) text = text.replace(`{{${name}}}`, String(value));
  return text;
}) as import("../../../src/types/panel-state.ts").TranslateFn;

/** 记录调用并固定回包的 fetch 替身。 */
function fakeFetch(response: Partial<PluginNetResponse>) {
  const calls: Array<{ url: string; options?: import("../../../src/types/plugin-runtime.ts").PluginNetRequestOptions }> = [];
  const fetch: HttpFetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      body: "",
      url,
      error: null,
      ...response,
    } as PluginNetResponse;
  };
  return { fetch, calls };
}

/** 取解析结果里的第一个请求。 */
function firstRequest(text: string) {
  const file = parseHttpFile(text);
  const request = file.requests[0];
  if (!request) throw new assert.AssertionError({ message: "用例文本应至少解析出一个请求" });
  return { file, request };
}

/** 组一份最小执行选项。 */
function runOptions(partial: Partial<HttpRunOptions> & { fetch: HttpFetch }): HttpRunOptions {
  return {
    scope: { fileVariables: new Map() },
    t,
    filePath: "D:/repo/api/users.http",
    rootPath: "D:/repo",
    ...partial,
  };
}

test("HTTP 执行: URL、头部与正文里的变量都换完再发", async () => {
  const { file, request } = firstRequest(
    [
      "@host = a.test",
      "GET https://{{host}}/users?page=2",
      "Authorization: Bearer {{token}}",
      "",
      '{ "q": "{{host}}" }',
    ].join("\n")
  );
  const { fetch, calls } = fakeFetch({});
  const result = await runHttpRequest(request, file, runOptions({
    fetch,
    scope: { fileVariables: new Map([["token", "abc"]]) },
  }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://a.test/users?page=2");
  assert.equal(calls[0].options?.headers?.Authorization, "Bearer abc");
  assert.equal(calls[0].options?.body, '{ "q": "a.test" }');
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.attempted, true);
});

test("HTTP 执行: Content-Length 恒被剔除，交给宿主按最终正文重算", async () => {
  const { file, request } = firstRequest(["POST https://a.test", "Content-Length: 999", "", "abc"].join("\n"));
  const { fetch, calls } = fakeFetch({});
  await runHttpRequest(request, file, runOptions({ fetch }));
  assert.deepEqual(calls[0].options?.headers, {});
});

test("HTTP 执行: Host 头加根路径拼成绝对地址，443 走 https", async () => {
  const plain = firstRequest(["GET /api/users", "Host: example.com"].join("\n"));
  const first = fakeFetch({});
  const resultPlain = await runHttpRequest(plain.request, plain.file, runOptions({ fetch: first.fetch }));
  assert.equal(first.calls[0].url, "http://example.com/api/users");
  assert.equal(resultPlain.sent.headers.Host, undefined, "拼好地址后 Host 已删");

  const tls = firstRequest(["GET /api/users", "Host: example.com:443"].join("\n"));
  const second = fakeFetch({});
  await runHttpRequest(tls.request, tls.file, runOptions({ fetch: second.fetch }));
  assert.equal(second.calls[0].url, "https://example.com:443/api/users");
});

test("HTTP 执行: 非 http(s) 地址与宿主不收的方法在前置关就拦下", async () => {
  const ws = firstRequest("GET ws://a.test/live");
  const fake = fakeFetch({});
  const blocked = await runHttpRequest(ws.request, ws.file, runOptions({ fetch: fake.fetch }));
  assert.equal(blocked.attempted, false);
  assert.equal(fake.calls.length, 0, "被拦下时不该碰网络");
  assert.ok(blocked.error && blocked.error.includes("http(s)"), blocked.error || "无错误文案");
  assert.deepEqual(blocked.sent.url, "ws://a.test/live", "被拒的请求原文也要回给界面");

  const trace = firstRequest("TRACE https://a.test");
  const fake2 = fakeFetch({});
  const blockedMethod = await runHttpRequest(trace.request, trace.file, runOptions({ fetch: fake2.fetch }));
  assert.equal(blockedMethod.attempted, false);
  assert.ok(blockedMethod.error?.includes("TRACE"));
});

test("HTTP 执行: GraphQL 请求换成 query/operationName/variables 的 JSON 正文", async () => {
  const text = [
    "POST https://a.test/graphql",
    "X-Request-Type: GraphQL",
    "Content-Type: application/json",
    "",
    "query GetUser($id: ID!) { user(id: $id) { name } }",
    "",
    '{ "id": "7" }',
  ].join("\n");
  const { file, request } = firstRequest(text);
  const { fetch, calls } = fakeFetch({});
  await runHttpRequest(request, file, runOptions({ fetch }));
  const payload = JSON.parse(String(calls[0].options?.body));
  assert.equal(payload.operationName, "GetUser");
  assert.deepEqual(payload.variables, { id: "7" });
  assert.ok(payload.query.includes("user(id: $id)"));
  assert.equal(calls[0].options?.headers?.["X-Request-Type"], undefined, "标记头不外发");
  assert.equal(calls[0].options?.headers?.["Content-Type"], "application/json");
});

test("HTTP 执行: 请求体文件引用按工作区根与当前文件目录依次找", async () => {
  const { file, request } = firstRequest(["POST https://a.test", "Content-Type: application/xml", "", "< ./demo.xml", "tail"].join("\n"));
  const reads: string[] = [];
  const { fetch } = fakeFetch({});
  const result = await runHttpRequest(
    request,
    file,
    runOptions({
      fetch,
      readText: async (path) => {
        reads.push(path.replace(/\\/g, "/"));
        return path.endsWith("demo.xml") && path.includes("/api/")
          ? { text: "<a/>", isBinary: false }
          : path.endsWith("demo.xml")
            ? null
            : { text: "", isBinary: false };
      },
    })
  );
  assert.deepEqual(reads, ["D:/repo/demo.xml", "D:/repo/api/demo.xml"], "先工作区根，再当前 .http 文件目录");
  assert.equal(result.sent.body, "<a/>\ntail");
});

test("HTTP 执行: <@ 引用的文件内容还要再过一遍变量", async () => {
  const { file, request } = firstRequest(['POST https://a.test', "Content-Type: application/json", "", "<@ ./body.json"].join("\n"));
  const { fetch, calls } = fakeFetch({});
  await runHttpRequest(
    request,
    file,
    runOptions({
      fetch,
      scope: { fileVariables: new Map([["name", "Ada"]]) },
      readText: async () => ({ text: '{ "n": "{{name}}" }', isBinary: false }),
    })
  );
  assert.equal(calls[0].options?.body, '{ "n": "Ada" }');
});

test("HTTP 执行: 变量值带换行时，< 文件 仍落在它原来那一行", async () => {
  // `@multi = A\nB` 展开后多出一行，若先整体替换再按行号内联，文件内容会插到 A 那行、把 B 覆盖掉。
  const { file, request } = firstRequest(["@multi = A\\nB", "", "POST https://a.test/x", "", "{{multi}}", "< ./f.txt"].join("\n"));
  const { fetch, calls } = fakeFetch({});
  await runHttpRequest(
    request,
    file,
    runOptions({ fetch, scope: { fileVariables: new Map([["multi", "A\nB"]]) }, readText: async () => ({ text: "<FILE>", isBinary: false }) })
  );
  assert.equal(calls[0].options?.body, "A\nB\n<FILE>");
});

test("HTTP 执行: GraphQL 变量段里的变量也会替换", async () => {
  const { file, request } = firstRequest(
    ["@id = 7", "POST https://a.test/graphql", "X-Request-Type: GraphQL", "", "query Foo { a }", "", "{ \"id\": {{id}} }"].join("\n")
  );
  const { fetch, calls } = fakeFetch({});
  await runHttpRequest(request, file, runOptions({ fetch, scope: { fileVariables: new Map([["id", "7"]]) } }));
  assert.deepEqual(JSON.parse(String(calls[0].options?.body)), {
    query: "query Foo { a }",
    operationName: "Foo",
    variables: { id: 7 },
  });
});

test("HTTP 执行: 二进制正文引用被明确拒绝，而不是发一串乱码", async () => {
  const { file, request } = firstRequest(["POST https://a.test", "Content-Type: image/png", "", "< ./1.png"].join("\n"));
  const { fetch, calls } = fakeFetch({});
  const result = await runHttpRequest(request, file, runOptions({ fetch, readText: async () => ({ text: "x", isBinary: true }) }));
  assert.equal(result.attempted, false);
  assert.equal(calls.length, 0);
  assert.ok(result.error?.includes("1.png"), result.error || "无错误文案");
});

test("HTTP 执行: 正文文件读不到时只给提示，请求照发", async () => {
  const { file, request } = firstRequest(["POST https://a.test", "", "< ./missing.txt"].join("\n"));
  const { fetch, calls } = fakeFetch({});
  const result = await runHttpRequest(request, file, runOptions({ fetch, readText: async () => null }));
  assert.equal(calls.length, 1);
  assert.equal(result.sent.body, "< ./missing.txt", "读不到就保留原行");
  assert.equal(result.warnings.some((line) => line.includes("missing.txt")), true);
});

test("HTTP 执行: @no-redirect 与 @no-cookie-jar 报出宿主做不到的那条", async () => {
  const { file, request } = firstRequest(["# @no-redirect", "# @no-cookie-jar", "GET https://a.test"].join("\n"));
  const { fetch } = fakeFetch({});
  const result = await runHttpRequest(request, file, runOptions({ fetch }));
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.some((line) => line.includes("重定向")));
  assert.ok(result.warnings.some((line) => line.includes("cookie")));
});

test("HTTP 执行: 请求变量从上一次响应里取值", async () => {
  const { file, request } = firstRequest(["GET https://a.test/me", "Authorization: Bearer {{login.response.body.$.token}}"].join("\n"));
  const { fetch, calls } = fakeFetch({});
  const result = await runHttpRequest(
    request,
    file,
    runOptions({
      fetch,
      scope: {
        fileVariables: new Map(),
        responses: new Map([
          ["login", { status: 200, statusText: "OK", headers: {}, body: '{"token":"t-1"}' }],
        ]),
      },
    })
  );
  assert.equal(calls[0].options?.headers?.Authorization, "Bearer t-1");
  assert.deepEqual(result.unresolved, []);
});

test("HTTP 执行: 响应字段按宿主回包映射，失败原因原样透传", async () => {
  const { file, request } = firstRequest("GET https://a.test/x");
  const { fetch } = fakeFetch({
    ok: false,
    status: 404,
    statusText: "Not Found",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: '{"e":1}',
    url: "https://a.test/x?redirected=1",
    error: "404",
  });
  const result = await runHttpRequest(request, file, runOptions({ fetch }));
  assert.equal(result.response?.status, 404);
  assert.equal(result.response?.ok, false);
  assert.equal(result.response?.contentType, "application/json; charset=utf-8");
  assert.equal(result.response?.finalUrl, "https://a.test/x?redirected=1");
  assert.equal(result.response?.bodyLength, 7);
  assert.equal(result.error, "404");
  assert.equal(result.attempted, true);
});

test("HTTP 执行: 通道抛错也算发过，错误文案取自异常本身", async () => {
  const { file, request } = firstRequest("GET https://a.test/x");
  const result = await runHttpRequest(
    request,
    file,
    runOptions({
      fetch: async () => {
        throw new Error("net::ERR_NAME_NOT_RESOLVED");
      },
    })
  );
  assert.equal(result.attempted, true);
  assert.equal(result.response, null);
  assert.equal(result.error, "net::ERR_NAME_NOT_RESOLVED");
});
