import test from "node:test";
import assert from "node:assert/strict";
import { parseCurlCommand, isCurlCommandLine } from "../../../src/services/http-curl.ts";

/** 把头部清单拍平成 `名: 值` 行，断言读起来与文件里写的一样直观。 */
function headerLines(parts: ReturnType<typeof parseCurlCommand>): string[] {
  return parts.headers.map((header) => `${header.name}: ${header.value}`);
}

test("HTTP curl: 认得起头行，普通请求行不算 curl", () => {
  assert.equal(isCurlCommandLine("curl -X POST https://a.test"), true);
  assert.equal(isCurlCommandLine("   CURL https://a.test"), true, "大小写与前置空白都收");
  assert.equal(isCurlCommandLine("GET https://a.test/curl"), false);
  assert.equal(isCurlCommandLine("curlish https://a.test"), false, "curlish 这种前缀不该误认");
});

test("HTTP curl: 续行反斜杠并成一行，多个空格压一个", () => {
  const parts = parseCurlCommand("curl -X POST \\\n  'https://a.test/x'   \\\n  -d 'a=1'\n");
  assert.equal(parts.method, "POST");
  assert.equal(parts.url, "https://a.test/x");
  assert.equal(parts.body, "a=1");
});

test("HTTP curl: 选项的五种写法都能取值", () => {
  for (const text of [
    "curl -H 'A: 1' https://a.test",
    "curl -H'A: 1' https://a.test",
    "curl --header 'A: 1' https://a.test",
    "curl --header='A: 1' https://a.test",
    "curl --header: 'A: 1' https://a.test",
  ]) {
    const parts = parseCurlCommand(text);
    assert.deepEqual(headerLines(parts), ["A: 1"], text);
    assert.equal(parts.url, "https://a.test", text);
  }
});

test("HTTP curl: 多个 -H 保序，同名合并且 Cookie 用分号", () => {
  const parts = parseCurlCommand("curl https://a.test -H 'X-A: 1' -H 'X-B: 2' -H 'X-A: 3' -H 'Cookie: a=1' -H 'Cookie: b=2'");
  assert.deepEqual(headerLines(parts), ["X-A: 1,3", "X-B: 2", "Cookie: a=1;b=2"]);
});

test("HTTP curl: 方法取自 -X，-I 当 HEAD，多个 -d 用 & 连接", () => {
  assert.equal(parseCurlCommand("curl -XPUT https://a.test").method, "PUT");
  assert.equal(parseCurlCommand("curl -X PUT https://a.test").method, "PUT");
  assert.equal(parseCurlCommand("curl -I https://a.test").method, "HEAD");
  const data = parseCurlCommand("curl https://a.test -d a=1 -d 'b=2&c=3'");
  assert.equal(data.body, "a=1&b=2&c=3");
  assert.equal(data.method, "POST", "有正文又没写方法按 POST");
});

test("HTTP curl: 有正文却没写 Content-Type 时补表单类型", () => {
  const withType = parseCurlCommand("curl https://a.test -d 'a=1' -H 'Content-Type: application/json'");
  assert.deepEqual(headerLines(withType), ["Content-Type: application/json"], "写了就不补");
  const without = parseCurlCommand("curl https://a.test -d 'a=1'");
  assert.deepEqual(headerLines(without), ["Content-Type: application/x-www-form-urlencoded"]);
  const empty = parseCurlCommand("curl https://a.test -d ''");
  assert.equal(empty.method, "GET", "空正文按「没有正文」处理，方法因此还是 GET");
});

test("HTTP curl: -u 直接补成 base64 的 Basic 头部", () => {
  const parts = parseCurlCommand("curl https://a.test -u 'me:pw'");
  // `-u` 在这一层就写成 base64：值里的变量引用会连同花括号一起被编进去，之后那趟替换再也换不掉。
  assert.deepEqual(headerLines(parts), ["Authorization: Basic bWU6cHc="]);
  const utf8 = parseCurlCommand("curl https://a.test -u '用户:密码'");
  // 凭据可以是中文：要先按 UTF-8 取字节再 base64，只认单字节的编码在这里会当场抛错。
  assert.equal(`Basic ${Buffer.from("用户:密码", "utf8").toString("base64")}`, utf8.headers[0].value);
});

test("HTTP curl: -b 带等号才算 Cookie，-L/--url 可当地址来源", () => {
  assert.deepEqual(headerLines(parseCurlCommand("curl https://a.test -b 'sid=7'")), ["Cookie: sid=7"]);
  assert.deepEqual(headerLines(parseCurlCommand("curl https://a.test -b 'not-a-pair'")), [], "没有 = 的 cookie 串不是键值对，不合成头部");
  assert.equal(parseCurlCommand("curl -L https://a.test/x").url, "https://a.test/x");
  assert.equal(parseCurlCommand("curl --url https://a.test/y").url, "https://a.test/y");
  assert.equal(parseCurlCommand("curl https://a.test/z -L").url, "https://a.test/z", "位置参数优先于开关");
});

test("HTTP curl: -d @文件 摊成文件引用而不是正文文本", () => {
  const parts = parseCurlCommand("curl https://a.test -X POST -d @./payload.json");
  assert.equal(parts.body, null);
  assert.equal(parts.bodyFile, "./payload.json");
  assert.equal(parts.method, "POST");
});

test("HTTP curl: 正文里的变量与引号原样留着，不做替换也不展开 shell", () => {
  const parts = parseCurlCommand(`curl https://a.test -H 'X-T: {{$guid}}' -d '{"k":"$HOME {{name}}"}'`);
  assert.equal(parts.headers[0].value, "{{$guid}}");
  assert.equal(parts.body, '{"k":"$HOME {{name}}"}');
});

test("HTTP curl: 认不出的开关不吃掉后面的地址", () => {
  const parts = parseCurlCommand("curl -s --insecure -k https://a.test/x");
  assert.equal(parts.url, "https://a.test/x", "未知选项按开关处理，别把 URL 当它的值");
});
