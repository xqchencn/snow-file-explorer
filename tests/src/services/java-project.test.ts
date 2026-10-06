import test from "node:test";
import assert from "node:assert/strict";
import { buildJavaPackageTree, buildJvmPackageTree } from "../../../src/services/java-project.ts";
import type { JvmTreeNode } from "../../../src/services/java-project.ts";

/** 目录条目桩：name/path 用真实磁盘路径形状，children 交给用例逐层给出。 */
function directory(name: string, path: string, children: JvmTreeNode[] = []): JvmTreeNode {
  return { name, path, isDirectory: true, children };
}

/** 文件条目桩：与被测源码读到的宿主目录条目同构（不带 children）。 */
function file(name: string, path: string): JvmTreeNode {
  return { name, path, isDirectory: false };
}

/**
 * 取包节点的子节点数组。
 * @description JvmTreeNode.children 在类型上可缺（文件节点没有 children），而本文件断言的对象
 *   都是被测源码生成的目录/包节点，运行期必带该字段；缺失即断言失败，
 *   与原先直接读 children[i] 抛 TypeError 同效，不放宽期望。
 */
function childrenOf(node: JvmTreeNode): JvmTreeNode[] {
  if (!Array.isArray(node.children)) {
    throw new assert.AssertionError({ message: `期望 ${node.name} 带 children 数组` });
  }
  return node.children;
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
  assert.equal(childrenOf(tree[0])[0].path, "D:/src/com/example/demo/User.java");
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
    childrenOf(tree[0]).map((entry) => entry.displayName || entry.name),
    ["example", "package-info.java"]
  );
  assert.equal(childrenOf(tree[0])[0].path, "D:/src/com/example");
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
    childrenOf(tree[0]).map((entry) => entry.displayName),
    ["company", "example"]
  );
  assert.equal(childrenOf(tree[0])[0].path, "D:/src/com/company");
  assert.equal(childrenOf(tree[0])[1].path, "D:/src/com/example");
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
  assert.equal(childrenOf(tree[0])[0].name, "Launcher.kt");
});
test("Java 包树：空输入失败安全地返回空数组", () => {
  assert.deepEqual(buildJavaPackageTree(null), []);
  assert.deepEqual(buildJavaPackageTree([]), []);
});
