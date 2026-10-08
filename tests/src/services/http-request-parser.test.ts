import test from "node:test";
import assert from "node:assert/strict";
import {
  HTTP_REQUEST_METHODS,
  httpRequestTitle,
  isBraceStyleVariableLine,
  isHttpCommentLine,
  isHttpFileVariableLine,
  splitUrlQuery,
  buildUrlWithQuery,
  parseHttpFile,
} from "../../../src/services/http-request-parser.ts";
import type { HttpParsedRequest } from "../../../src/services/http-request-parser.ts";

/** 取第 n 个请求（0 基），越界即断言失败，省掉每个用例重复判长度。 */
function requestAt(requests: HttpParsedRequest[], index: number): HttpParsedRequest {
  const request = requests[index];
  if (!request) throw new assert.AssertionError({ message: `期望存在第 ${index + 1} 个请求` });
  return request;
}

test("HTTP 解析: 请求行的方法可缺省，尾部 HTTP 版本被剥离", () => {
  const withVersion = parseHttpFile("GET https://a.test/comments/1 HTTP/1.1");
  assert.equal(requestAt(withVersion.requests, 0).method, "GET");
  assert.equal(requestAt(withVersion.requests, 0).url, "https://a.test/comments/1");

  const urlOnly = parseHttpFile("https://a.test/comments/1");
  assert.equal(requestAt(urlOnly.requests, 0).method, "GET", "没写方法时按 GET 处理");
  assert.equal(requestAt(urlOnly.requests, 0).url, "https://a.test/comments/1");

  const post = parseHttpFile("post https://a.test HTTP/1.1");
  assert.equal(requestAt(post.requests, 0).method, "POST", "方法大小写不敏感，存为大写");
  assert.equal(requestAt(post.requests, 0).url, "https://a.test");
  assert.ok(HTTP_REQUEST_METHODS.includes("MKCALENDAR"), "WebDAV 一族方法也在方法表里");
});

test("HTTP 解析: 查询串续行并入 URL，且请求行占用的末行行号如实记录", () => {
  const file = ["GET https://a.test/comments", "    ?page=2", "    &pageSize=10", "Accept: application/json"].join("\n");
  const request = requestAt(parseHttpFile(file).requests, 0);
  assert.equal(request.url, "https://a.test/comments?page=2&pageSize=10");
  assert.equal(request.requestLineEnd, 2, "请求行占了 0..2 三行");
  assert.equal(request.headerStart, 3);
  assert.deepEqual(request.headers, [{ name: "Accept", value: "application/json", line: 3 }]);
});

test("HTTP 解析: 三个以上 # 分节，每节一个请求；无分隔行时整份文件即一节", () => {
  const three = parseHttpFile(["GET https://a.test", "###", "POST https://b.test"].join("\n"));
  assert.equal(three.requests.length, 2);
  assert.equal(requestAt(three.requests, 1).method, "POST");

  const four = parseHttpFile(["GET https://a.test", "####", "GET https://b.test"].join("\n"));
  assert.equal(four.requests.length, 2, "#### 同样是分节行");

  const single = parseHttpFile("GET https://a.test");
  assert.equal(single.requests.length, 1);
  assert.equal(requestAt(single.requests, 0).startLine, 0);
});

test("HTTP 解析: 头部读到首个空行为止，同名头部合并（Cookie 用分号）", () => {
  const file = [
    "GET https://a.test",
    "X-A: 1",
    "X-A: 2",
    "Cookie: a=1",
    "Cookie: b=2",
    "Broken-Header",
    "",
    "body text",
  ].join("\n");
  const request = requestAt(parseHttpFile(file).requests, 0);
  const byName = new Map(request.headers.map((header) => [header.name, header]));
  assert.equal(byName.get("X-A")!.value, "1,2");
  assert.equal(byName.get("X-A")!.line, 1, "同名合并保留首行的行号");
  assert.equal(byName.get("Cookie")!.value, "a=1;b=2");
  assert.equal(byName.get("Broken-Header")!.value, "", "没有冒号时值为空串");
  assert.equal(request.body, "body text");
  assert.equal(request.bodyStart, 7);
  assert.equal(request.bodyEnd, 7);
});

test("HTTP 解析: 无请求体与多行请求体的行区间都对齐原文", () => {
  const noBody = requestAt(parseHttpFile("GET https://a.test\nAccept: text/plain").requests, 0);
  assert.equal(noBody.body, null);
  assert.equal(noBody.bodyStart, -1);

  const jsonBody = ['GET https://a.test', "Content-Type: application/json", "", "{", '  "a": 1', "}"].join("\n");
  const withBody = requestAt(parseHttpFile(jsonBody).requests, 0);
  assert.equal(withBody.body, "{\n  \"a\": 1\n}");
  assert.equal(withBody.bodyStart, 3);
  assert.equal(withBody.endLine, 5);
});

test("HTTP 解析: 元数据指令覆盖全集，`#` 与 `//` 都认", () => {
  const file = [
    "# @name login",
    "# @note 这会真的下单",
    "# @no-redirect",
    "// @no-cookie-jar",
    "# @prompt otp 邮箱里的一次性密码",
    "# @prompt username",
    "# @weird-key something",
    "POST https://a.test/login HTTP/1.1",
  ].join("\n");
  const request = requestAt(parseHttpFile(file).requests, 0);
  assert.equal(request.name, "login");
  assert.equal(request.note, "这会真的下单");
  assert.equal(request.noRedirect, true);
  assert.equal(request.noCookieJar, true);
  assert.deepEqual(request.prompts, [
    { name: "otp", description: "邮箱里的一次性密码" },
    { name: "username", description: null },
  ]);
  assert.deepEqual(request.unknownMetadata, ["weird-key"], "不认识的反向记法要留痕，而不是被当成请求行");
  assert.equal(request.startLine, 7, "前导注释与变量定义行都不属于请求块");
});

test("HTTP 解析: 元数据只认请求行之前的注释，请求体里的 @name 不算", () => {
  const file = ["GET https://a.test", "Content-Type: text/plain", "", "# @name injected", "body"].join("\n");
  const request = requestAt(parseHttpFile(file).requests, 0);
  assert.equal(request.name, null, "元数据只认请求行之前的连续注释，碰到别的内容就停");
  assert.deepEqual(request.variableRefs, []);
});

test("HTTP 解析: 文件变量整份文件可见，转义还原且同名后者覆盖", () => {
  const file = [
    "@hostname = api.example.com",
    "@port = 8080",
    "@host = {{hostname}}:{{port}}",
    "@multi = line1\\nline2",
    "@host = override.example.com",
    "",
    "GET https://{{host}}/authors/{{%name}}",
  ].join("\n");
  const parsed = parseHttpFile(file);
  const byName = new Map(parsed.variables.map((variable) => [variable.name, variable]));
  assert.equal(byName.get("host")!.value, "override.example.com");
  assert.equal(byName.get("host")!.line, 4);
  assert.equal(byName.get("multi")!.value, "line1\nline2", "变量值里只还原 \\n \\r \\t 三个转义");
  const request = requestAt(parsed.requests, 0);
  assert.deepEqual(request.variableRefs, ["host", "%name"]);
});

test("HTTP 解析: 只有注释与变量定义的节不产生请求", () => {
  const parsed = parseHttpFile(["# 只是说明", "@token = abc", "", "###", "GET https://a.test"].join("\n"));
  assert.equal(parsed.requests.length, 1);
  assert.equal(requestAt(parsed.requests, 0).url, "https://a.test");
  assert.equal(parsed.variables.length, 1);
});

test("HTTP 解析: GraphQL 请求按首个空行拆出查询与变量两段", () => {
  const file = [
    "POST https://a.test/graphql",
    "X-Request-Type: GraphQL",
    "",
    "query MyQuery($id: ID!) { node(id: $id) { id } }",
    "",
    '{ "id": "1" }',
  ].join("\n");
  const request = requestAt(parseHttpFile(file).requests, 0);
  assert.equal(request.graphQl, true);
  assert.equal(request.body, "query MyQuery($id: ID!) { node(id: $id) { id } }");
  assert.equal(request.graphQlVariables, '{ "id": "1" }');
});

test("HTTP 解析: 请求体里的文件引用行按 < 与 <@ 两种形态识别", () => {
  const file = [
    "POST https://a.test/upload",
    "Content-Type: application/xml",
    "",
    "< ./demo.xml",
    "<@latin1 ./other.xml",
    "<@ ./vars.xml",
    "<@ spaced ./x.xml",
    "plain text line",
  ].join("\n");
  const request = requestAt(parseHttpFile(file).requests, 0);
  assert.deepEqual(request.bodyFiles, [
    { line: 3, path: "./demo.xml", processVariables: false, encoding: null },
    { line: 4, path: "./other.xml", processVariables: true, encoding: "latin1" },
    { line: 5, path: "./vars.xml", processVariables: true, encoding: null },
    // 编码名要紧贴 @：`<@ spaced` 的 @ 后面接的不是词字符，整串就被当路径收下。
    { line: 6, path: "spaced ./x.xml", processVariables: true, encoding: null },
  ]);
});

test("HTTP 解析: 响应粘贴段整节跳过并记录起始行", () => {
  const file = ["GET https://a.test", "###", "HTTP/1.1 200 OK", "Content-Type: text/plain", "", "hello"].join("\n");
  const parsed = parseHttpFile(file);
  assert.equal(parsed.requests.length, 1, "第二段是响应记录，不是请求");
  assert.deepEqual(parsed.skippedResponseSections, [2]);
});

test("HTTP 解析: CRLF 与 LF 混用都行，行号按拆分后的行计", () => {
  const crlf = "GET https://a.test\r\nAccept: text/plain\r\n\r\nline1\r\nline2";
  const request = requestAt(parseHttpFile(crlf).requests, 0);
  assert.equal(request.headerStart, 1);
  assert.equal(request.bodyStart, 3);
  assert.equal(request.body, "line1\nline2", "请求体按行重组，不带 \\r");
});

test("HTTP 解析: 注释行与文件变量行的判定与解析内部一致", () => {
  assert.equal(isHttpCommentLine("  # x"), true);
  assert.equal(isHttpCommentLine("// x"), true);
  assert.equal(isHttpCommentLine("GET https://a.test"), false);
  assert.equal(isHttpFileVariableLine("@host = https://a.test"), true);
  assert.equal(isHttpFileVariableLine("@host=1"), true);
  assert.equal(isBraceStyleVariableLine("{{host}} = https://a.test"), true);
  assert.equal(isBraceStyleVariableLine("@host = https://a.test"), false);
});

test("HTTP 解析: 花括号写法的变量定义不被认成定义，也不被误当请求行", () => {
  const parsed = parseHttpFile(["{{host}} = https://a.test", "", "GET {{host}}/x"].join("\n"));
  assert.deepEqual(parsed.variables, [], "变量定义只认 @ 前缀");
  assert.deepEqual(parsed.braceStyleVariableLines, [0], "行号要留出来，界面才能说清哪行没生效");
  assert.equal(parsed.requests.length, 1);
  assert.equal(requestAt(parsed.requests, 0).url, "{{host}}/x");
});

test("HTTP 解析: 分隔行上写的标题被认成请求标题", () => {
  const parsed = parseHttpFile(
    ["### 登录", "POST https://a.test/login", "", "###", "GET https://a.test/users", "", "#### 查人（分页）", "GET https://a.test/people"].join("\n")
  );
  assert.equal(parsed.requests.length, 3);
  assert.equal(requestAt(parsed.requests, 0).title, "登录");
  assert.equal(requestAt(parsed.requests, 1).title, null, "光一个 ### 没有标题");
  assert.equal(requestAt(parsed.requests, 2).title, "查人（分页）", "四个井号同样算标题");
  assert.equal(httpRequestTitle(parsed.requests[0]), "登录");
  assert.equal(httpRequestTitle(parsed.requests[1]), null);
});

test("HTTP 解析: 节起始行含分隔行，标题优先于 @name", () => {
  const parsed = parseHttpFile(["@host = a.test", "", "### 登录接口", "# @name login", "GET https://{{host}}/users"].join("\n"));
  assert.equal(parsed.requests.length, 1);
  const request = requestAt(parsed.requests, 0);
  assert.equal(request.name, "login", "@name 仍是请求变量的键");
  assert.equal(request.title, "登录接口", "标题取自开启本节的那条分隔行");
  assert.equal(httpRequestTitle(request), "登录接口", "界面标题用人写的标题，没有才退到 @name");
  assert.equal(request.startLine, 4, "请求块本身仍从请求行起");
  assert.equal(request.sectionStart, 2, "本节从分隔行那行起，分块才不会把标题行落掉");

  // 元数据只在本节内生效：写在上一条分隔行之前，就归不到这条请求。
  const before = parseHttpFile(["# @name login", "### 登录接口", "GET https://a.test/users"].join("\n"));
  assert.equal(before.requests.length, 1);
  assert.equal(requestAt(before.requests, 0).name, null, "分隔行同样切断元数据：那行属于上一节末尾的说明");
  assert.equal(requestAt(before.requests, 0).title, "登录接口");

  const first = parseHttpFile("GET https://a.test/users");
  assert.equal(requestAt(first.requests, 0).sectionStart, 0, "没有分隔行时本节就是文件首行");
});

test("HTTP 解析: 请求块内的注释行不参与语法（注释掉的头部不会变成真头部）", () => {
  const text = [
    "POST https://a.test/x",
    "# Content-Type: application/json",
    "// X-Debug: 1",
    "Accept: text/plain",
    "",
    "{",
    "  // 正文里的注释行也要剥掉，否则 JSON 正文在服务端就是非法的",
    '  "a": 1',
    "}",
  ].join("\n");
  const request = requestAt(parseHttpFile(text).requests, 0);
  assert.deepEqual(
    request.headers.map((header) => `${header.name}: ${header.value}`),
    ["Accept: text/plain"],
    "注释行不是头部：`# Content-Type` 这种名字会被宿主按非法 header 拒掉"
  );
  assert.equal(request.headers[0].line, 3, "剥掉注释行后，行号仍指原文");
  assert.equal(request.body, '{\n  "a": 1\n}', "正文里的注释行同样不参与");
  assert.deepEqual(request.bodyLineNumbers, [5, 7, 8], "正文每一行都留着原文行号，写回才能落对位置");
});

test("HTTP 解析: 仅方法的请求行＝地址为空的请求（地址栏被清空后仍能往返）", () => {
  const request = requestAt(parseHttpFile("GET\n").requests, 0);
  assert.equal(request.method, "GET");
  assert.equal(request.url, "", "`GET` 单行不再被读成地址为 GET");
});

test("HTTP 解析: 首行 BOM 不影响分节与标题", () => {
  const parsed = parseHttpFile("\uFEFF### 登录\n# @name login\nPOST https://a.test/login\n");
  assert.equal(requestAt(parsed.requests, 0).title, "登录");
  assert.equal(requestAt(parsed.requests, 0).name, "login");
});

test("HTTP 解析: GraphQL 的行号表只对应查询段，不与变量段混在一起", () => {
  const text = ["POST https://a.test/graphql", "X-Request-Type: GraphQL", "", "query Foo { a }", "", '{"id": 1}'].join("\n");
  const request = requestAt(parseHttpFile(text).requests, 0);
  assert.equal(request.body, "query Foo { a }");
  assert.equal(request.graphQlVariables, '{"id": 1}');
  assert.deepEqual(request.bodyLineNumbers, [3], "行号表要与 body 的行数一致，否则正文文件引用会按错的下标落位");
});

test("HTTP 解析: curl 一节还原成请求，而不是把 -H 当成头部名", () => {
  const text = [
    "### curl 一条",
    "curl -X POST 'https://a.test/x' \\",
    "  -H 'Content-Type: application/json' \\",
    "  -H 'X-Trace: yes' \\",
    "  -d '{\"k\":1}'",
  ].join("\n");
  const request = requestAt(parseHttpFile(text).requests, 0);
  assert.equal(request.curl, true);
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://a.test/x");
  assert.equal(request.title, "curl 一条");
  assert.deepEqual(
    request.headers.map((header) => `${header.name}: ${header.value}`),
    ["Content-Type: application/json", "X-Trace: yes"]
  );
  assert.equal(request.body, '{"k":1}');
  // 关键回归：这些 `-H 'Content-Type` 之类曾经整串被当成头部名，宿主会因非法头部字符直接抛错。
  for (const header of request.headers) assert.equal(/^[A-Za-z][\w-]*$/.test(header.name), true, header.name);
});

test("HTTP 解析: curl 里 -d @文件 摊成正文文件引用", () => {
  const request = requestAt(parseHttpFile(["curl https://a.test -d @./body.json"].join("\n")).requests, 0);
  assert.equal(request.body, "< ./body.json");
  assert.deepEqual(request.bodyFiles.map((ref) => ref.path), ["./body.json"]);
  assert.deepEqual(request.bodyLineNumbers, [request.endLine], "行号表要指回那一行，发送层才能按行内联");
});

test("HTTP 解析: 响应脚本从正文里摘走，不留成非法头部", () => {
  const afterHeaders = requestAt(
    parseHttpFile(["POST https://a.test/h", "Content-Type: application/json", "", '{"a":1}', "> {%", "  client.global.set('t', response.body.t);", "%}"].join("\n")).requests,
    0
  );
  assert.equal(afterHeaders.body, '{"a":1}', "脚本不进正文");
  assert.equal(afterHeaders.responseHandler, "client.global.set('t', response.body.t);");
  assert.deepEqual(afterHeaders.headers.map((header) => header.name), ["Content-Type"]);

  // 紧贴头部写（没空行）时脚本也不再被切成头部行。
  const tight = requestAt(
    parseHttpFile(["GET https://a.test/h", "> {% client.log(1); %}"].join("\n")).requests,
    0
  );
  assert.deepEqual(tight.headers, [], "一行版脚本不该变成名为 `> {% client.log(1); %}` 的头部");
  assert.equal(tight.responseHandler, "client.log(1);");
  assert.equal(tight.body, null);
});

test("HTTP 解析: `> 文件` 认成响应落盘路径而不是正文", () => {
  const request = requestAt(
    parseHttpFile(["GET https://a.test/o", "Content-Type: text/plain", "", "> ./out/response.json"].join("\n")).requests,
    0
  );
  assert.equal(request.outputRedirect, "./out/response.json");
  assert.equal(request.body, null);
});

test("HTTP 解析: 查询串拆成参数表，值里的变量原样留着", () => {
  const request = requestAt(
    parseHttpFile(["GET https://a.test/c?page=2", "    &pageSize=10", "    &q={{name}}"].join("\n")).requests,
    0
  );
  assert.deepEqual(request.queryParams, [
    { name: "page", value: "2" },
    { name: "pageSize", value: "10" },
    { name: "q", value: "{{name}}" },
  ]);
  const noQuery = requestAt(parseHttpFile("GET https://a.test/c").requests, 0);
  assert.deepEqual(noQuery.queryParams, []);
  const flag = requestAt(parseHttpFile("GET https://a.test/c?debug").requests, 0);
  assert.deepEqual(flag.queryParams, [{ name: "debug", value: "" }], "只有名字没有等号也算一个参数");
});

test("HTTP 解析: 拆出去的查询串能拼回同一个地址", () => {
  for (const url of ["https://a.test/c", "https://a.test/c?a=1", "https://a.test/c?a=1&b={{x}}", "https://a.test/c?a=&b=2"]) {
    const { base, params } = splitUrlQuery(url);
    assert.equal(buildUrlWithQuery(base, params), url, url);
  }
  // 只有名字的参数按「空值」处理：拆出来是 {name:'flag',value:''}，拼回去写成 `flag=`。
  const flag = splitUrlQuery("https://a.test/c?flag");
  assert.deepEqual(flag.params, [{ name: "flag", value: "" }]);
  assert.equal(buildUrlWithQuery(flag.base, flag.params), "https://a.test/c?flag=");
  assert.equal(buildUrlWithQuery("https://a.test/c", []), "https://a.test/c", "参数清空不该留一个光秃秃的 ?");
  assert.equal(buildUrlWithQuery("https://a.test/c?", [{ name: "a", value: "1" }]), "https://a.test/c?a=1");
});

test("HTTP 解析: 分隔行之后的粘贴响应段也如实计入跳过数", () => {
  const parsed = parseHttpFile(["### 一条请求", "GET https://a.test/x", "### 这是粘贴的响应", "HTTP/1.1 200 OK", "", '{"ok":true}'].join("\n"));
  assert.equal(parsed.requests.length, 1, "响应段不该被当成请求");
  assert.equal(parsed.skippedResponseSections.length, 1, "界面上要说清跳过了几段，之前这里恒报 0");
});
