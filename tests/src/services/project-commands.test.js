import test from "node:test";
import assert from "node:assert/strict";
import { detectProjectCommands, flattenCommands } from "../../../src/services/project-commands.js";
import { resolveNodeEntry, readNodeScripts } from "../../../src/services/ecosystems.js";

function file(name, path) {
  return { name, path, isDirectory: false };
}
function directory(name, path) {
  return { name, path, isDirectory: true };
}

test("detectProjectCommands：命中 package.json 时识别 Node 并逐条生成 npm run 命令", () => {
  const entries = [file("package.json", "D:/proj/package.json"), file("index.js", "D:/proj/index.js")];
  const result = detectProjectCommands(entries, {
    fileContents: {
      "package.json": JSON.stringify({ main: "index.js", scripts: { dev: "vite", test: "jest" } }),
    },
  });

  assert.equal(result.ecosystems.length, 1);
  const node = result.ecosystems[0];
  assert.equal(node.id, "node");
  assert.equal(node.label, "Node.js");
  assert.deepEqual(node.markers, ["package.json"]);
  assert.equal(node.entry, "index.js");
  // 保持 scripts 定义顺序，且命令为 npm run <name>
  assert.deepEqual(
    node.commands.map((c) => c.cmd),
    ["npm run dev", "npm run test"]
  );
  // 标签原样使用 script 名（不汉化、不归类）：dev 就显示 dev，与 IDEA 一致
  assert.equal(node.commands[0].labelKey, null);
  assert.equal(node.commands[0].labelFallback, "dev");
});

test("detectProjectCommands：未知脚本名原样作为标签，不强行归类", () => {
  const entries = [file("package.json", "D:/proj/package.json")];
  const result = detectProjectCommands(entries, {
    fileContents: { "package.json": JSON.stringify({ scripts: { deploy: "node deploy.js" } }) },
  });

  assert.equal(result.ecosystems[0].commands[0].labelKey, null);
  assert.equal(result.ecosystems[0].commands[0].labelFallback, "deploy");
  assert.equal(result.ecosystems[0].commands[0].cmd, "npm run deploy");
});

test("detectProjectCommands：package.json 解析失败时仅保留生态标签，不产命令", () => {
  const entries = [file("package.json", "D:/proj/package.json")];
  const result = detectProjectCommands(entries, { fileContents: { "package.json": "{ not valid json" } });

  assert.equal(result.ecosystems.length, 1);
  assert.equal(result.ecosystems[0].id, "node");
  assert.deepEqual(result.ecosystems[0].commands, []);
  assert.equal(result.ecosystems[0].entry, null);
});

test("detectProjectCommands：无 scripts 时回退为 node <entry>", () => {
  const entries = [file("package.json", "D:/proj/package.json"), file("index.js", "D:/proj/index.js")];
  const result = detectProjectCommands(entries, {
    fileContents: { "package.json": JSON.stringify({ name: "demo" }) },
  });

  assert.deepEqual(
    result.ecosystems[0].commands.map((c) => c.cmd),
    ["node index.js"]
  );
});

test("detectProjectCommands：无 scripts 且无入口时命令为空，但仍识别为 Node", () => {
  const entries = [file("package.json", "D:/proj/package.json"), file("README.md", "D:/proj/README.md")];
  const result = detectProjectCommands(entries, {
    fileContents: { "package.json": JSON.stringify({ name: "demo" }) },
  });

  assert.equal(result.ecosystems[0].id, "node");
  assert.deepEqual(result.ecosystems[0].commands, []);
});

test("detectProjectCommands：无任何标识文件时返回空生态列表", () => {
  const entries = [file("README.md", "D:/proj/README.md"), directory("src", "D:/proj/src")];
  const result = detectProjectCommands(entries, {});

  assert.deepEqual(result.ecosystems, []);
  assert.equal(typeof result.scannedAt, "number");
});

test("detectProjectCommands：目录名为 package.json（非文件）不触发识别", () => {
  const entries = [directory("package.json", "D:/proj/package.json")];
  const result = detectProjectCommands(entries, {});

  assert.deepEqual(result.ecosystems, []);
});

test("detectProjectCommands：空输入失败安全地返回空结果", () => {
  assert.deepEqual(detectProjectCommands(null).ecosystems, []);
  assert.deepEqual(detectProjectCommands([]).ecosystems, []);
});

test("resolveNodeEntry：优先 main 字段，其次候选名，再次返回 null", () => {
  const entries = [file("index.js", "D:/proj/index.js"), file("server.js", "D:/proj/server.js")];

  // main 指向存在的裸文件名 → 采用
  assert.equal(resolveNodeEntry({ main: "./index.js" }, entries), "index.js");
  // main 指向不存在的文件 → 回退候选（index.js 优先于 server.js）
  assert.equal(resolveNodeEntry({ main: "dist/bundle.js" }, entries), "index.js");
  // 无 main → 按候选顺序探测
  assert.equal(resolveNodeEntry({}, [file("app.js", "D:/proj/app.js")]), "app.js");
  // 都没有 → null
  assert.equal(resolveNodeEntry({}, [file("README.md", "D:/proj/README.md")]), null);
});

test("readNodeScripts：忽略非字符串脚本值，空 scripts 返回空数组", () => {
  assert.deepEqual(readNodeScripts(null), []);
  assert.deepEqual(readNodeScripts({}), []);
  const list = readNodeScripts({ scripts: { a: "x", b: 123 } });
  assert.deepEqual(list.map((c) => c.cmd), ["npm run a"]);
});

test("flattenCommands：汇总多生态命令并标注来源生态", () => {
  const flat = flattenCommands({
    ecosystems: [
      { id: "node", commands: [{ id: "npm:dev", cmd: "npm run dev", labelFallback: "Dev", labelKey: "run.script.dev" }] },
    ],
  });

  assert.equal(flat.length, 1);
  assert.equal(flat[0].ecosystem, "node");
  assert.equal(flat[0].cmd, "npm run dev");
  assert.deepEqual(flattenCommands(null), []);
});
