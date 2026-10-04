import test from "node:test";
import assert from "node:assert/strict";
import { detectProjectCommands, flattenCommands, scanProjectCommands } from "../../../src/services/project-commands.js";
import { resolveNodeEntry, readNodeScripts, nodeEntryFallback, detectPackageManager } from "../../../src/services/ecosystems.js";

function file(name, path) {
  return { name, path, isDirectory: false };
}
function directory(name, path) {
  return { name, path, isDirectory: true };
}

/** 构造一个「已发现的包」记录（与 scanProjectCommands 输出同构）。 */
function pkg(dir, packageJson, entries = null) {
  return { dir, packageJson, entries };
}

test("detectProjectCommands：根包生成 npm run 命令（无前缀）", () => {
  const result = detectProjectCommands([pkg("", { main: "index.js", scripts: { dev: "vite", test: "jest" } })]);

  assert.equal(result.ecosystems.length, 1);
  const node = result.ecosystems[0];
  assert.equal(node.id, "node");
  assert.deepEqual(
    node.commands.map((c) => c.cmd),
    ["npm run dev", "npm run test"]
  );
  // 标签原样使用 script 名（不汉化、不归类）
  assert.equal(node.commands[0].labelKey, null);
  assert.equal(node.commands[0].labelFallback, "dev");
  assert.equal(node.commands[0].id, "npm:dev");
});

test("detectProjectCommands：子包命令使用所属目录的 npm run，运行时由调用方切换 cwd", () => {
  const result = detectProjectCommands([pkg("sub", { scripts: { dev: "vite" } })]);

  assert.equal(result.ecosystems[0].id, "node:sub");
  assert.equal(result.ecosystems[0].label, "Node · sub");
  const cmd = result.ecosystems[0].commands[0];
  assert.equal(cmd.cmd, "npm run dev");
  assert.equal(cmd.id, "npm:sub:dev");
  assert.equal(cmd.labelFallback, "sub/dev");
  assert.equal(cmd.packageManager, "npm");
});

test("detectProjectCommands：多级子包路径保留层级", () => {
  const result = detectProjectCommands([pkg("packages/web", { scripts: { build: "tsc" } })]);
  assert.equal(result.ecosystems[0].commands[0].cmd, "npm run build");
  assert.equal(result.ecosystems[0].commands[0].id, "npm:packages/web:build");
});

test("detectProjectCommands：多个 package.json 各出一组命令", () => {
  const result = detectProjectCommands([
    pkg("", { scripts: { dev: "vite" } }),
    pkg("api", { scripts: { start: "node ." } }),
  ]);

  assert.equal(result.ecosystems.length, 2);
  const flat = flattenCommands(result);
  assert.deepEqual(
    flat.map((c) => c.cmd).sort(),
    ["npm run dev", "npm run start"].sort()
  );
  // 多包同名 script 的 id 不冲突
  const dup = detectProjectCommands([pkg("a", { scripts: { dev: "x" } }), pkg("b", { scripts: { dev: "y" } })]);
  const ids = flattenCommands(dup).map((c) => c.id);
  assert.equal(new Set(ids).size, 2);
});

test("detectProjectCommands：根包无 scripts 时回退 node <entry>，子包不回退", () => {
  const root = detectProjectCommands([pkg("", { name: "demo" }, [file("index.js", "D:/proj/index.js")])]);
  assert.deepEqual(root.ecosystems[0].commands.map((c) => c.cmd), ["node index.js"]);

  const sub = detectProjectCommands([pkg("sub", { name: "demo" }, [file("index.js", "D:/proj/sub/index.js")])]);
  assert.deepEqual(sub.ecosystems[0].commands, []);
});

test("detectProjectCommands：package.json 解析失败（null）时仅保留包标记，不产命令", () => {
  const result = detectProjectCommands([pkg("", null)]);
  assert.equal(result.ecosystems.length, 1);
  assert.equal(result.ecosystems[0].id, "node");
  assert.deepEqual(result.ecosystems[0].commands, []);
});

test("detectProjectCommands：空输入失败安全地返回空结果", () => {
  assert.deepEqual(detectProjectCommands(null).ecosystems, []);
  assert.deepEqual(detectProjectCommands([]).ecosystems, []);
  assert.deepEqual(detectProjectCommands([null, undefined]).ecosystems, []);
});

test("detectProjectCommands：无任何标识文件时返回空生态列表", () => {
  const result = detectProjectCommands([]);
  assert.deepEqual(result.ecosystems, []);
  assert.equal(typeof result.scannedAt, "number");
});

test("resolveNodeEntry：优先 main 字段，其次候选名，再次返回 null", () => {
  const entries = [file("index.js", "D:/proj/index.js"), file("server.js", "D:/proj/server.js")];
  assert.equal(resolveNodeEntry({ main: "./index.js" }, entries), "index.js");
  assert.equal(resolveNodeEntry({ main: "dist/bundle.js" }, entries), "index.js");
  assert.equal(resolveNodeEntry({}, [file("app.js", "D:/proj/app.js")]), "app.js");
  assert.equal(resolveNodeEntry({}, [file("README.md", "D:/proj/README.md")]), null);
});

test("nodeEntryFallback：有入口才产 node <entry>，无入口返回空数组", () => {
  assert.deepEqual(nodeEntryFallback({}, [file("index.js", "D:/proj/index.js")]).map((c) => c.cmd), ["node index.js"]);
  assert.deepEqual(nodeEntryFallback({}, [file("README.md", "D:/proj/README.md")]), []);
});

test("readNodeScripts：忽略非字符串脚本值，空 scripts 返回空数组；prefix 仅标记包目录", () => {
  assert.deepEqual(readNodeScripts(null), []);
  assert.deepEqual(readNodeScripts({}), []);
  const list = readNodeScripts({ scripts: { a: "x", b: 123 } });
  assert.deepEqual(list.map((c) => c.cmd), ["npm run a"]);

  const prefixed = readNodeScripts({ scripts: { a: "x" } }, { prefix: "sub" });
  assert.deepEqual(prefixed.map((c) => c.cmd), ["npm run a"]);
  assert.equal(prefixed[0].labelFallback, "sub/a");
});

test("flattenCommands：汇总多包命令并标注来源生态", () => {
  const flat = flattenCommands({
    ecosystems: [
      { id: "node", commands: [{ id: "npm:dev", cmd: "npm run dev", labelFallback: "dev", labelKey: null }] },
      { id: "node:sub", commands: [{ id: "npm:sub:dev", cmd: "npm run dev", labelFallback: "sub/dev", labelKey: null }] },
    ],
  });

  assert.equal(flat.length, 2);
  assert.equal(flat[0].ecosystem, "node");
  assert.equal(flat[1].ecosystem, "node:sub");
  assert.deepEqual(flattenCommands(null), []);
});

test("flattenCommands：命令按包分组、父包排在子包前，并携带 dir/group", () => {
  // 传入顺序刻意打乱（子包在前、父包在后），验证排序而非依赖输入顺序
  const result = detectProjectCommands([
    pkg("packages/web", { scripts: { build: "tsc" } }),
    pkg("", { scripts: { dev: "vite" } }),
    pkg("api", { scripts: { start: "node ." } }),
  ]);
  const flat = flattenCommands(result);
  // 根包（0 段）→ api（1 段）→ packages/web（2 段）
  assert.deepEqual(
    flat.map((c) => c.cmd),
    ["npm run dev", "npm run start", "npm run build"]
  );
  // 分组字段：根包 group=null（渲染层用「根目录」文案），子包为目录路径
  assert.deepEqual(flat.map((c) => c.group), [null, "api", "packages/web"]);
  assert.deepEqual(flat.map((c) => c.dir), ["", "api", "packages/web"]);
});

test("detectPackageManager：packageManager 优先，其次锁文件，最后继承或回退 npm", () => {
  assert.equal(
    detectPackageManager({ packageManager: "yarn@4.0.0" }, [file("pnpm-lock.yaml", "D:/repo/pnpm-lock.yaml")]),
    "yarn"
  );
  assert.equal(detectPackageManager({}, [file("pnpm-lock.yaml", "D:/repo/pnpm-lock.yaml")]), "pnpm");
  assert.equal(detectPackageManager({}, [file("yarn.lock", "D:/repo/yarn.lock")]), "yarn");
  assert.equal(detectPackageManager({}, [file("bun.lock", "D:/repo/bun.lock")]), "bun");
  assert.equal(detectPackageManager({}, [], "pnpm"), "pnpm");
  assert.equal(detectPackageManager({}, []), "npm");
});

test("readNodeScripts：npm/yarn/pnpm/bun 都生成同一套 run 语义", () => {
  for (const manager of ["npm", "yarn", "pnpm", "bun"]) {
    const [command] = readNodeScripts(
      { packageManager: `${manager}@9.0.0`, scripts: { check: "node check.js" } },
      { prefix: "apps/web" }
    );
    assert.equal(command.cmd, `${manager} run check`);
    assert.equal(command.id, `${manager}:apps/web:check`);
    assert.equal(command.packageManager, manager);
  }
});

test("detectProjectCommands：保留包管理器并让运行层按包目录切换 cwd", () => {
  const result = detectProjectCommands([
    pkg("apps/web", { packageManager: "pnpm@9.0.0", scripts: { dev: "vite" } }),
  ]);
  const command = result.ecosystems[0].commands[0];
  assert.equal(result.ecosystems[0].packageManager, "pnpm");
  assert.equal(command.cmd, "pnpm run dev");
  assert.equal(command.packageManager, "pnpm");
  assert.equal(command.id, "pnpm:apps/web:dev");
});

test("scanProjectCommands：workspace 子包继承根目录 packageManager 并保留真实目录", async () => {
  const root = "D:/repo";
  const paths = {
    root,
    apps: `${root}/apps`,
    web: `${root}/apps/web`,
  };
  const directories = new Map([
    [paths.root, [file("package.json", `${paths.root}/package.json`), file("pnpm-lock.yaml", `${paths.root}/pnpm-lock.yaml`), directory("apps", paths.apps)]],
    [paths.apps, [directory("web", paths.web)]],
    [paths.web, [file("package.json", `${paths.web}/package.json`)]],
  ]);
  const contents = new Map([
    [`${paths.root}/package.json`, JSON.stringify({ private: true, packageManager: "pnpm@9.0.0", workspaces: ["apps/*"] })],
    [`${paths.web}/package.json`, JSON.stringify({ name: "web", scripts: { dev: "vite" } })],
  ]);
  const previous = globalThis.window;
  globalThis.window = {
    snow: {
      readDirectoryEntries: async (dirPath) => directories.get(dirPath) || [],
      readFileContent: async (filePath) => ({ content: contents.get(filePath) || "", isBinary: false }),
    },
  };
  try {
    const result = await scanProjectCommands(root);
    const [command] = flattenCommands(result).filter((item) => item.dir === "apps/web");
    assert.equal(command.packageManager, "pnpm");
    assert.equal(command.cmd, "pnpm run dev");
    assert.equal(command.dir, "apps/web");
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
