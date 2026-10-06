import test from "node:test";
import assert from "node:assert/strict";
import { findScriptLines } from "../../../src/services/package-scripts.ts";

test("findScriptLines：定位多行 scripts 各条目的 1 基行号", () => {
  const text = [
    "{", // 1
    '  "name": "demo",', // 2
    '  "scripts": {', // 3
    '    "dev": "vite",', // 4
    '    "build": "node build.js",', // 5
    '    "test": "node --test"', // 6
    "  },", // 7
    '  "dependencies": {}', // 8
    "}", // 9
  ].join("\n");

  assert.deepEqual(findScriptLines(text), [
    { name: "dev", line: 4 },
    { name: "build", line: 5 },
    { name: "test", line: 6 },
  ]);
});

test("findScriptLines：无 scripts / 空文本 / 非法内容返回空数组", () => {
  assert.deepEqual(findScriptLines(""), []);
  // 这条用例锁的就是实现对 null 的容错分支；签名已放宽为 string | null，无需断言。
  assert.deepEqual(findScriptLines(null), []);
  assert.deepEqual(findScriptLines('{ "name": "demo" }'), []);
  assert.deepEqual(findScriptLines("{ not valid json"), []);
});

test("findScriptLines：单行 JSON（scripts 与内容同行）返回空数组", () => {
  assert.deepEqual(findScriptLines('{"scripts":{"dev":"vite"}}'), []);
  assert.deepEqual(findScriptLines('{ "scripts": { "dev": "vite" } }'), []);
});

test("findScriptLines：跳过非字符串脚本值，其余条目仍正确定位", () => {
  const text = [
    "{", // 1
    '  "scripts": {', // 2
    '    "nested": { "x": 1 },', // 3
    '    "ok": "node ok.js"', // 4
    "  }", // 5
    "}", // 6
  ].join("\n");

  assert.deepEqual(findScriptLines(text), [{ name: "ok", line: 4 }]);
});

test("findScriptLines：scripts 值内的花括号不干扰区间扫描", () => {
  const text = [
    "{", // 1
    '  "scripts": {', // 2
    '    "echo": "node -e \\"console.log({})\\"",', // 3
    '    "next": "vite"', // 4
    "  }", // 5
    "}", // 6
  ].join("\n");

  assert.deepEqual(findScriptLines(text), [
    { name: "echo", line: 3 },
    { name: "next", line: 4 },
  ]);
});
