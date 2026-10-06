import test from "node:test";
import assert from "node:assert/strict";
import { pickJsonValue, resolveHttpVariables } from "../../../src/services/http-variables.ts";
import type { HttpResponseRecord } from "../../../src/services/http-variables.ts";

/** 固定时刻：2026-10-06T12:34:56.789Z。 */
const FIXED = new Date(Date.UTC(2026, 9, 6, 12, 34, 56, 789));

/** 只给文件变量的最小作用域。 */
function scopeOf(fileVariables: Record<string, string>, extra = {}) {
  return {
    fileVariables: new Map(Object.entries(fileVariables)),
    ...extra,
  };
}

/** 本机时区尾缀（`Z` / `+08:00` / `-05:00`），供 $localDatetime 断言用，不假设测试机时区。 */
function localOffsetTail(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  if (offsetMinutes === 0) return "Z";
  const pad = (value: number) => String(value).padStart(2, "0");
  const abs = Math.abs(offsetMinutes);
  return `${offsetMinutes > 0 ? "+" : "-"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

test("HTTP 变量: 文件变量直接替换，值里的引用再递归展开", () => {
  const result = resolveHttpVariables("https://{{host}}/authors", {
    fileVariables: new Map([
      ["host", "{{hostname}}:{{port}}"],
      ["hostname", "api.example.com"],
      ["port", "8080"],
    ]),
  });
  assert.equal(result.value, "https://api.example.com:8080/authors");
  assert.deepEqual(result.unresolved, []);
});

test("HTTP 变量: {{%name}} 走百分号编码，普通引用不编码", () => {
  const scope = scopeOf({ name: "Strunk & White" });
  assert.equal(resolveHttpVariables("{{%name}}", scope).value, "Strunk%20%26%20White");
  assert.equal(resolveHttpVariables("{{name}}", scope).value, "Strunk & White");
});

test("HTTP 变量: 解析不出来的引用原样留着，并报名给界面", () => {
  const result = resolveHttpVariables("GET https://{{host}}/{{missing}}/x", scopeOf({ host: "a.test" }));
  assert.equal(result.value, "GET https://a.test/{{missing}}/x");
  assert.deepEqual(result.unresolved, ["missing"]);
});

test("HTTP 变量: 文件变量互相引用成环时不把自己绕死", () => {
  const result = resolveHttpVariables("{{a}}", {
    fileVariables: new Map([
      ["a", "{{b}}"],
      ["b", "{{a}}"],
    ]),
  });
  // 环里的引用按「未解析」收口：值里保留花括号原文，但调用方拿到的是有限结果。
  assert.equal(result.value.includes("{{"), true);
  assert.ok(result.unresolved.length > 0, "成环至少要报一条");
});

test("HTTP 变量: 系统变量按注入的时钟与随机源取值", () => {
  const scope = {
    fileVariables: new Map(),
    randomizers: {
      now: () => FIXED,
      uuid: () => "0f8f0e9a-1a2b-4c3d-8e9f-001122334455",
      randomInt: () => 42,
    },
  };
  assert.equal(resolveHttpVariables("{{$guid}}", scope).value, "0f8f0e9a-1a2b-4c3d-8e9f-001122334455");
  assert.equal(resolveHttpVariables("{{$timestamp}}", scope).value, String(Math.floor(FIXED.getTime() / 1000)));
  assert.equal(resolveHttpVariables("{{$timestamp -1 d}}", scope).value, String(Math.floor(FIXED.getTime() / 1000) - 86400));
  assert.equal(resolveHttpVariables("{{$datetime rfc1123}}", scope).value, FIXED.toUTCString());
  assert.equal(resolveHttpVariables("{{$datetime iso8601}}", scope).value, FIXED.toISOString());
  const localValue = resolveHttpVariables("{{$localDatetime iso8601}}", scope).value;
  // 本地写法换的是展示时区，不该换时刻：按 ISO 解析回来必须还是同一个瞬间。
  assert.equal(new Date(localValue).getTime(), FIXED.getTime(), localValue);
  assert.equal(localValue.endsWith(localOffsetTail(FIXED)), true, localValue);
  assert.equal(resolveHttpVariables("{{$randomInt 1 100}}", scope).value, "42");
});

test("HTTP 变量: 系统变量写法不对就报未解析，不猜用户想干什么", () => {
  const scope = scopeOf({}, { randomizers: { now: () => FIXED } });
  // min >= max 不是上游接受的写法（要求 min < max）。
  assert.deepEqual(resolveHttpVariables("{{$randomInt 10 1}}", scope).unresolved, ["$randomInt 10 1"]);
  // 自定义格式串依赖 dayjs token 语义，本实现不支持。
  assert.deepEqual(resolveHttpVariables("{{$datetime 'yyyy-MM'}}", scope).unresolved, ["$datetime 'yyyy-MM'"]);
  // $processEnv / $dotenv 在插件渲染进程里没有对应来源，一律不解析。
  assert.deepEqual(resolveHttpVariables("{{$processEnv USERNAME}}", scope).unresolved, ["$processEnv USERNAME"]);
});

test("HTTP 变量: 偏移量按月加时钳到月末，与 dayjs 的历法加法一致", () => {
  const march31 = new Date(Date.UTC(2026, 2, 31, 0, 0, 0, 0));
  const scope = scopeOf({}, { randomizers: { now: () => march31 } });
  // 3-31 加一个月应为 4-30（4 月没有 31 号）。
  assert.equal(resolveHttpVariables("{{$datetime iso8601 1 M}}", scope).value, "2026-04-30T00:00:00.000Z");
  assert.equal(resolveHttpVariables("{{$datetime iso8601 -1 y}}", scope).value, "2025-03-31T00:00:00.000Z");
});

test("HTTP 变量: 请求变量从最近响应里取正文与头部", () => {
  const record: HttpResponseRecord = {
    status: 200,
    statusText: "OK",
    headers: { "Content-Type": "application/json", "X-Token": "abc123" },
    body: '{"id":"mock","nested":{"items":[{"name":"first"}]}}',
  };
  const scope = scopeOf({}, { responses: new Map([["login", record]]) });
  assert.equal(resolveHttpVariables("{{login.response.body.$.id}}", scope).value, "mock");
  assert.equal(resolveHttpVariables("{{login.response.body.$.nested.items[0].name}}", scope).value, "first");
  assert.equal(resolveHttpVariables("{{login.response.headers.X-Token}}", scope).value, "abc123");
  // 头部名大小写不敏感（上游同规则）。
  assert.equal(resolveHttpVariables("{{login.response.headers.x-token}}", scope).value, "abc123");
  // 不写选择器即整份正文。
  assert.equal(resolveHttpVariables("{{login.response.body}}", scope).value, record.body);
});

test("HTTP 变量: 请求变量没发过时报警告并保留原文", () => {
  const scope = scopeOf({}, { responses: new Map() });
  const result = resolveHttpVariables("{{login.response.body.$.id}}", scope);
  assert.equal(result.value, "{{login.response.body.$.id}}");
  assert.deepEqual(result.unresolved, ["login.response.body.$.id"]);
  // 告警是结构化的「哪一类 + 哪个名字」，句子由调用方按界面语言拼。
  assert.deepEqual(result.warnings, [{ code: "varNoResponse", name: "login" }]);
  assert.equal(resolveHttpVariables("{{login.response.body.$.id}}{{login.response.body.$.id}}", scope).warnings.length, 1, "同名同类只留一条");
});

test("HTTP 变量: 引用数远超 200 时也全部替换，不留静默漏替", () => {
  const count = 500;
  const text = Array.from({ length: count }, (_value, index) => `{{v${index}}}`).join(",");
  const scope = {
    fileVariables: new Map(Array.from({ length: count }, (_value, index) => [`v${index}`, `V${index}`])),
  };
  const result = resolveHttpVariables(text, scope);
  assert.equal(result.value.includes("{{"), false, "撞上硬上限就停手会把后半个文件原样发出去");
  assert.deepEqual(result.unresolved, []);
});

test("HTTP 变量: 大量未解析引用不爆栈，且每一处都如实报名", () => {
  const result = resolveHttpVariables("{{missing}}".repeat(9000), { fileVariables: new Map() });
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.value.includes("{{missing}}"), true, "解析不出来就原样保留");
});

test("HTTP 变量: 空引用不登记为未解析", () => {
  assert.deepEqual(resolveHttpVariables("{{}}", { fileVariables: new Map() }).unresolved, []);
});

test("HTTP 变量: 超长变量链不爆栈，超限处按未解析点名", () => {
  const chain = new Map<string, string>();
  for (let index = 0; index < 3000; index += 1) chain.set(`v${index}`, index === 2999 ? "end" : `{{v${index + 1}}}`);
  const result = resolveHttpVariables("{{v0}}", { fileVariables: chain });
  assert.equal(result.value.includes("{{v"), true, "超限就停手并保留原文，不能把调用栈打穿");
  assert.equal(result.warnings.some((warning) => warning.code === "varTooDeep"), true, "要说清楚是嵌套太深，而不是默默留个花括号");
});

test("HTTP 变量: JSONPath 取值不走原型链", () => {
  const scope = {
    fileVariables: new Map(),
    responses: new Map([["login", { status: 200, statusText: "OK", headers: {}, body: '{"a":1}' } as HttpResponseRecord]]),
  };
  assert.equal(resolveHttpVariables("{{login.response.body.$.constructor}}", scope).value, "", "没命中就是没命中");
  assert.equal(resolveHttpVariables("{{login.response.body.$.__proto__}}", scope).value, "");
  assert.equal(resolveHttpVariables("{{login.response.body.$.a}}", scope).value, "1", "正常键照旧");
});

test("HTTP 变量: @prompt 填进来的值优先级高于文件变量", () => {
  const scope = scopeOf({ otp: "from-file" }, { prompts: new Map([["otp", "typed"]]) });
  assert.equal(resolveHttpVariables("{{otp}}", scope).value, "typed");
});

test("HTTP 变量: 环境变量在文件变量之后兜底", () => {
  const scope = scopeOf({ host: "file.test" }, { environment: new Map([["token", "env-value"]]) });
  assert.equal(resolveHttpVariables("{{host}}/{{token}}", scope).value, "file.test/env-value");
});

test("HTTP 变量: JSONPath 子集只覆盖请求变量需要的形态", () => {
  const json = '{"a":{"b":[1,2]},"c-d":"dash","e":null,"f":{"g":1}}';
  assert.equal(pickJsonValue(json, "$"), json);
  assert.equal(pickJsonValue(json, "*"), json);
  assert.equal(pickJsonValue(json, "$.a.b[1]"), "2");
  assert.equal(pickJsonValue(json, '$["c-d"]'), "dash");
  assert.equal(pickJsonValue(json, "$.f"), '{"g":1}', "命中对象时回 JSON 文本");
  assert.equal(pickJsonValue(json, "$.missing"), null);
  assert.equal(pickJsonValue(json, "$.e"), null, "null 值按取不到处理");
  assert.equal(pickJsonValue("not json", "$.a"), null);
});
