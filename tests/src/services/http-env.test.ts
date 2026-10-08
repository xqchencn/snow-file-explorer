import test from "node:test";
import assert from "node:assert/strict";
import {
  parseEnvironmentJson,
  resolveActiveEnvironment,
  listEnvironmentNames,
  parseDotenv,
  loadEnvironmentStore,
  loadDotenvVariables,
  serializeEnvironmentJson,
  pluginConfigDirectory,
  SHARED_ENVIRONMENT_NAME,
  NO_ENVIRONMENT_NAME,
  ENVIRONMENT_FILE_NAME,
  PRIVATE_ENVIRONMENT_FILE_NAME,
} from "../../../src/services/http-env.ts";

/** 环境表该放的目录（读盘替身的键前缀）。 */
const CONFIG_DIR = pluginConfigDirectory("D:/repo");

/** 把 `{ 环境名: { 键: 值 } }` 收成 store 的形状。 */
function tablesOf(record: Record<string, Record<string, string>>) {
  return new Map(Object.entries(record).map(([name, table]) => [name, new Map(Object.entries(table))]));
}

/** 造一份只含环境表的 store，省掉每个用例都走一遍读盘。 */
function storeOf(environments: Record<string, Record<string, string>>, privateEnvironments: Record<string, Record<string, string>> = {}) {
  return {
    environments: tablesOf({ ...environments, ...privateEnvironments }),
    privateTables: tablesOf(privateEnvironments),
    publicTables: tablesOf(environments),
    files: [ENVIRONMENT_FILE_NAME],
    issues: [],
  };
}

/** 按路径表回文件的读盘替身。 */
function fakeFs(files: Record<string, string>) {
  return async (path: string) => (path in files ? files[path] : null);
}

test("HTTP 环境: 解析环境表 JSON，值只收文本档位", () => {
  const parsed = parseEnvironmentJson(
    JSON.stringify({ $shared: { version: "v1" }, local: { port: 8080, on: true, nested: { a: 1 }, nil: null } }),
    ENVIRONMENT_FILE_NAME
  );
  assert.equal(parsed.environments.get("local")?.get("port"), "8080", "数字转字符串");
  assert.equal(parsed.environments.get("local")?.get("on"), "true");
  assert.equal(parsed.environments.get("local")?.has("nested"), false, "对象不当值收");
  assert.deepEqual(
    parsed.issues.map((issue) => issue.code),
    ["skippedValue", "skippedValue"]
  );
});

test("HTTP 环境: JSON 坏了或形状不对都只登记问题，不抛错", () => {
  assert.deepEqual(parseEnvironmentJson("{ not json", "a.json").issues.map((i) => i.code), ["invalidJson"]);
  assert.deepEqual(parseEnvironmentJson("[]", "a.json").issues.map((i) => i.code), ["notObject"]);
  const nested = parseEnvironmentJson(JSON.stringify({ local: "oops" }), "a.json");
  assert.deepEqual(nested.issues.map((i) => i.code), ["notObject"]);
  assert.equal(nested.issues[0].name, "local", "要说清是哪个环境写错了");
});

test("HTTP 环境: 当前环境覆盖 $shared，不选环境时只剩 $shared", () => {
  const store = storeOf({
    [SHARED_ENVIRONMENT_NAME]: { version: "v1", host: "shared.test" },
    local: { version: "v2", token: "dev" },
  });
  const local = resolveActiveEnvironment(store, "local");
  assert.equal(local.variables.get("version"), "v2", "同名键当前环境优先");
  assert.equal(local.variables.get("host"), "shared.test", "没写的键从 $shared 拿");
  assert.deepEqual(local.overriddenShared, ["version"]);
  const none = resolveActiveEnvironment(store, NO_ENVIRONMENT_NAME);
  assert.deepEqual([...none.variables.keys()], ["version", "host"], "未选环境只有共享变量");
  assert.deepEqual(none.overriddenShared, []);
});

test("HTTP 环境: 值里的 $shared 引用按第一处展开，命名环境自引用同理", () => {
  const store = storeOf({
    [SHARED_ENVIRONMENT_NAME]: { nonProdToken: "shared-nonprod", token: "{{$shared nonProdToken}}" },
    local: { prodToken: "p", token: "{{$shared nonProdToken}} 第二次 {{$shared nonProdToken}}" },
    sandbox: { host: "sandbox.test", url: "https://{{$sandbox host}}" },
  });
  assert.equal(resolveActiveEnvironment(store, NO_ENVIRONMENT_NAME).variables.get("token"), "shared-nonprod");
  // 展开引用的正则不带 g：一个值里只换最前面那一处，后面重复写的同名引用原样留着。
  assert.equal(
    resolveActiveEnvironment(store, "local").variables.get("token"),
    "shared-nonprod 第二次 {{$shared nonProdToken}}"
  );
  // 命名环境这一趟匹配的是 `{{$<环境名> 键}}`：`$` 是引用名的一部分，自引用少了它就换不开。
  const sandbox = resolveActiveEnvironment(store, "sandbox");
  assert.equal(sandbox.variables.get("url"), "https://sandbox.test", "命名环境自引用应被就地展开");
});

test("HTTP 环境: 引用找不到键时保留原样，不写成 undefined", () => {
  const store = storeOf({ [SHARED_ENVIRONMENT_NAME]: { a: "{{$shared nope}}" } });
  assert.equal(resolveActiveEnvironment(store, NO_ENVIRONMENT_NAME).variables.get("a"), "{{$shared nope}}");
});

test("HTTP 环境: 切环境不改原表，来回切值不会被越换越短", () => {
  const store = storeOf({
    [SHARED_ENVIRONMENT_NAME]: { nonProd: "shared" },
    local: { token: "{{$shared nonProd}}" },
    prod: { token: "{{$shared nonProd}}" },
  });
  assert.equal(resolveActiveEnvironment(store, "local").variables.get("token"), "shared");
  assert.equal(resolveActiveEnvironment(store, "prod").variables.get("token"), "shared");
  assert.equal(resolveActiveEnvironment(store, "local").variables.get("token"), "shared", "第二次切回来还是同一个值");
  assert.equal(store.environments.get("local")?.get("token"), "{{$shared nonProd}}", "原表一个字没动");
});

test("HTTP 环境: 环境名清单不含 $shared 且按名升序", () => {
  const store = storeOf({ [SHARED_ENVIRONMENT_NAME]: {}, staging: {}, local: {}, prod2: {}, prod10: {} });
  assert.deepEqual(listEnvironmentNames(store), ["local", "prod2", "prod10", "staging"]);
});

test("HTTP 环境: .env 文本解析支持引号、注释、export 与多行值", () => {
  const table = parseDotenv(
    [
      "# 注释行",
      "PLAIN=single",
      "  SPACED = trimmed  ",
      "export EXPORTED=yes",
      'DOUBLE="a b\\nc"',
      "SINGLE='raw \\n not-escape'",
      "TRAIL=value  # 行尾注释",
      "EMPTY=",
      'MULTI="line one',
      'line two"',
      "QUOTED.KEY=dot",
    ].join("\n")
  );
  assert.equal(table.get("PLAIN"), "single");
  assert.equal(table.get("SPACED"), "trimmed");
  assert.equal(table.get("EXPORTED"), "yes");
  assert.equal(table.get("DOUBLE"), "a b\nc", "双引号里还原 \\n");
  assert.equal(table.get("SINGLE"), "raw \\n not-escape", "单引号里不还原转义");
  assert.equal(table.get("TRAIL"), "value");
  assert.equal(table.get("EMPTY"), "");
  assert.equal(table.get("MULTI"), "line one\nline two", "引号值可以跨行");
  assert.equal(table.get("QUOTED.KEY"), "dot", "键名允许点");
});

test("HTTP 环境: 环境表只从插件配置目录读，别处的同名文件一概不算", async () => {
  const readText = fakeFs({
    "D:/repo/rest-client.env.json": JSON.stringify({ local: { host: "legacy.test" } }),
    "D:/repo/api/env.json": JSON.stringify({ local: { host: "sibling.test" } }),
    [`${CONFIG_DIR}/${ENVIRONMENT_FILE_NAME}`]: JSON.stringify({ local: { host: "config.test" } }),
  });
  const store = await loadEnvironmentStore({ rootPath: "D:/repo", readText });
  assert.deepEqual(store.files, [`${CONFIG_DIR}/${ENVIRONMENT_FILE_NAME}`], "只认这一处位置");
  assert.equal(store.environments.get("local")?.get("host"), "config.test");
});

test("HTTP 环境: 没有配置目录就是没有环境表，不报错也不猜", async () => {
  const store = await loadEnvironmentStore({ rootPath: "D:/repo", readText: fakeFs({}) });
  assert.deepEqual(store.files, []);
  assert.equal(store.environments.size, 0);
  assert.equal(store.privateTables.size, 0);
});

test("HTTP 环境: 私密表覆盖公开表同名键，两份都算来源并单独留一份原样", async () => {
  const readText = fakeFs({
    [`${CONFIG_DIR}/${ENVIRONMENT_FILE_NAME}`]: JSON.stringify({ local: { host: "public.test", token: "pub" } }),
    [`${CONFIG_DIR}/${PRIVATE_ENVIRONMENT_FILE_NAME}`]: JSON.stringify({ local: { token: "secret" }, staging: { host: "s.test" } }),
  });
  const store = await loadEnvironmentStore({ rootPath: "D:/repo", readText });
  assert.equal(store.files.length, 2);
  assert.equal(store.environments.get("local")?.get("token"), "secret", "私密表赢");
  assert.equal(store.environments.get("local")?.get("host"), "public.test", "没被覆盖的键留着");
  assert.equal(store.environments.has("staging"), true);
  assert.deepEqual([...store.privateTables.get("local")?.keys() ?? []], ["token"], "私密表原样那份不含公开表的键");
});

test("HTTP 环境: .env 只看工作区根，选了环境时 .env.<环境名> 赢", async () => {
  const readText = fakeFs({
    "D:/repo/.env": "USERNAME=plain\n",
    "D:/repo/.env.production": "USERNAME=prod\n",
    "D:/repo/api/.env": "USERNAME=near-level\n",
  });
  const picked = await loadDotenvVariables({ rootPath: "D:/repo", environment: "production", readText });
  assert.equal(picked.path, "D:/repo/.env.production");
  assert.equal(picked.variables.get("USERNAME"), "prod");
  const noEnv = await loadDotenvVariables({ rootPath: "D:/repo", environment: "", readText });
  assert.equal(noEnv.path, "D:/repo/.env", "没选环境时只找 .env");
  assert.equal(noEnv.variables.get("USERNAME"), "plain", "子目录那份不算");
});

test("HTTP 环境: 环境名带路径字符时不拼 .env.<环境名>，只回落 .env", async () => {
  const readText = fakeFs({
    "D:/repo/.env": "USERNAME=plain\n",
    "D:/repo/.env.a..b": "USERNAME=escaped\n",
  });
  const picked = await loadDotenvVariables({ rootPath: "D:/repo", environment: "a/../../b", readText });
  assert.equal(picked.variables.get("USERNAME"), "plain", "脏名字不该把读盘路径带出去");
});

test("HTTP 环境: 写回的表键序稳定，$shared 永远排最前", () => {
  const tables = new Map([
    ["production", new Map([["host", "api.test"], ["token", "p"]])],
    [SHARED_ENVIRONMENT_NAME, new Map([["version", "v1"]])],
    ["local", new Map([["host", "localhost"]])],
  ]);
  const text = serializeEnvironmentJson(tables);
  assert.deepEqual(Object.keys(JSON.parse(text)), [SHARED_ENVIRONMENT_NAME, "local", "production"], "键序按名升序，$shared 打头");
  const again = serializeEnvironmentJson(new Map([...tables].reverse()));
  assert.equal(again, text, "同一份表换个插入顺序也该写出同一串文本，否则 diff 会开花");
});
