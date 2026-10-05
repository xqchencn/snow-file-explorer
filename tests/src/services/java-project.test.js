import test from "node:test";
import assert from "node:assert/strict";
import { buildJavaPackageTree, buildJvmPackageTree } from "../../../src/services/java-project.js";

function directory(name, path, children = []) {
  return { name, path, isDirectory: true, children };
}

function file(name, path) {
  return { name, path, isDirectory: false };
}

test("Java 包树：合并没有文件的空中间包并保留真实路径", () => {
  const tree = buildJavaPackageTree([
    directory("com", "D:/src/com", [
      directory("example", "D:/src/com/example", [
        directory("demo", "D:/src/com/example/demo", [
          file("User.java", "D:/src/com/example/demo/User.java"),
        ]),
      ]),
    ]),
  ]);

  assert.equal(tree[0].displayName, "com.example.demo");
  assert.equal(tree[0].packageName, "com.example.demo");
  assert.equal(tree[0].path, "D:/src/com/example/demo");
  assert.equal(tree[0].isVirtualPackage, true);
  assert.equal(tree[0].children[0].path, "D:/src/com/example/demo/User.java");
});

test("Java 包树：有文件的中间包不合并且不丢失文件层级", () => {
  const tree = buildJavaPackageTree([
    directory("com", "D:/src/com", [
      file("package-info.java", "D:/src/com/package-info.java"),
      directory("example", "D:/src/com/example", [
        file("User.java", "D:/src/com/example/User.java"),
      ]),
    ]),
  ]);

  assert.equal(tree[0].displayName, "com");
  assert.equal(tree[0].path, "D:/src/com");
  assert.deepEqual(
    tree[0].children.map((entry) => entry.displayName || entry.name),
    ["example", "package-info.java"]
  );
  assert.equal(tree[0].children[0].path, "D:/src/com/example");
});

test("Java 包树：多个子包保留共同父包，不错误合并", () => {
  const tree = buildJavaPackageTree([
    directory("com", "D:/src/com", [
      directory("company", "D:/src/com/company", [
        file("Company.java", "D:/src/com/company/Company.java"),
      ]),
      directory("example", "D:/src/com/example", [
        file("User.java", "D:/src/com/example/User.java"),
      ]),
    ]),
  ]);

  assert.equal(tree[0].displayName, "com");
  assert.deepEqual(
    tree[0].children.map((entry) => entry.displayName),
    ["company", "example"]
  );
  assert.equal(tree[0].children[0].path, "D:/src/com/company");
  assert.equal(tree[0].children[1].path, "D:/src/com/example");
});

test("Java 包树：默认包文件与顶层包并列", () => {
  const tree = buildJavaPackageTree([
    file("Main.java", "D:/src/Main.java"),
    directory("com", "D:/src/com", [
      directory("example", "D:/src/com/example", [
        file("User.java", "D:/src/com/example/User.java"),
      ]),
    ]),
  ]);

  assert.deepEqual(
    tree.map((entry) => entry.displayName || entry.name),
    ["com.example", "Main.java"]
  );
  assert.equal(tree[0].path, "D:/src/com/example");
  assert.equal(tree[1].path, "D:/src/Main.java");
});

test("JVM 包树：Kotlin 文件复用同一套压缩包路径逻辑", () => {
  const tree = buildJvmPackageTree([
    directory("com", "D:/src/com", [
      directory("example", "D:/src/com/example", [
        file("Launcher.kt", "D:/src/com/example/Launcher.kt"),
      ]),
    ]),
  ]);

  assert.equal(tree[0].displayName, "com.example");
  assert.equal(tree[0].packageName, "com.example");
  assert.equal(tree[0].children[0].name, "Launcher.kt");
});
test("Java 包树：空输入失败安全地返回空数组", () => {
  assert.deepEqual(buildJavaPackageTree(null), []);
  assert.deepEqual(buildJavaPackageTree([]), []);
});
