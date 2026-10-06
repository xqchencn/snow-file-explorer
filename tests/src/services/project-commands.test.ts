import test from "node:test";
import assert from "node:assert/strict";
import { detectProjectCommands, flattenCommands, scanProjectCommands } from "../../../src/services/project-commands.ts";
import {
  resolveNodeEntry,
  readNodeScripts,
  readScriptCommands,
  nodeEntryFallback,
  detectPackageManager,
  readWails3Commands,
  readWails2Commands,
  readGoCommands,
  findJavaMainCandidates,
  readMavenCommands,
  readGradleCommands,
  detectPythonPackageManager,
  findPythonMainCandidates,
  readPythonCommands,
} from "../../../src/services/ecosystems.ts";
import type { EcosystemGroup, ProjectPackage } from "../../../src/services/project-commands.ts";
import type { PackageJson, ProjectEntry } from "../../../src/services/ecosystems.ts";
import type { DirectoryEntry, FileContentResult } from "../../../src/types/host/host-workspace.ts";
import { installWindow, restoreWindow } from "../utils/window-stub.ts";

/**
 * 目录条目桩（宿主 DirectoryEntry 四字段全必给）。
 * @description 扫描链路只读 name / path / isDirectory：`entry.size` 在
 *   project-commands.ts 与 ecosystems.ts 里从未被读取，故 size 固定填 0。
 */
function file(name: string, path: string): DirectoryEntry {
  return { name, path, isDirectory: false, size: 0 };
}

/** 目录桩，形状与 file() 同源（isDirectory 为 true）。 */
function directory(name: string, path: string): DirectoryEntry {
  return { name, path, isDirectory: true, size: 0 };
}

/**
 * readFileContent 桩的返回值（宿主 FileContentResult 七字段全必给）。
 * @description 被测的 readText 只取 `content` 并检查 `isBinary`，其余字段按「纯文本文件」自洽填充。
 */
function fileContent(content: string): FileContentResult {
  return {
    content,
    isBinary: false,
    isImage: false,
    isSvg: false,
    mimeType: "text/plain",
    encoding: "utf8",
    size: content.length,
  };
}

/** 构造一个「已发现的包」记录（与 scanProjectCommands 输出同构）。 */
function pkg(dir: string, packageJson: PackageJson | null, entries: ProjectEntry[] | null = null): ProjectPackage {
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

test("Python 生态：识别常见入口并生成系统 Python 命令", () => {
  const entries = [file("main.py", "D:/repo/main.py"), file("README.md", "D:/repo/README.md")];
  assert.deepEqual(findPythonMainCandidates(entries), [
    { name: "main.py", path: "D:/repo/main.py", kind: "file" },
  ]);
  const commands = readPythonCommands({ entries });
  assert.deepEqual(commands.map((command) => command.cmd), ["python main.py"]);
  assert.equal(commands[0].packageManager, "python");
  assert.equal(commands[0].icon, "python");
});

test("Python 生态：包管理器锁文件包裹 Python 入口，不生成安装命令", () => {
  const entries = [
    file("main.py", "D:/repo/main.py"),
    file("pyproject.toml", "D:/repo/pyproject.toml"),
    file("uv.lock", "D:/repo/uv.lock"),
  ];
  assert.equal(detectPythonPackageManager(entries), "uv");
  assert.deepEqual(readPythonCommands({ entries }).map((command) => command.cmd), ["uv run python main.py"]);
  assert.deepEqual(
    readPythonCommands({
      entries: [file("app.py", "D:/repo/app.py"), file("Pipfile", "D:/repo/Pipfile")],
    }).map((command) => command.cmd),
    ["pipenv run python app.py"]
  );
});

test("Python 生态：顶层包 __main__.py 生成 python -m 包名并保留源码路径", () => {
  const commands = readPythonCommands({
    prefix: "tools",
    entries: [],
    modules: [{ name: "demo_package", sourcePath: "D:/repo/tools/demo_package/__main__.py" }],
  });
  assert.equal(commands[0].cmd, "python -m demo_package");
  assert.equal(commands[0].labelFallback, "tools/demo_package");
  assert.equal(commands[0].sourcePath, "D:/repo/tools/demo_package/__main__.py");
});

test("detectProjectCommands：Python 项目进入生态列表并按所属目录运行", () => {
  const result = detectProjectCommands([
    {
      dir: "services/api",
      ecosystem: "python",
      entries: [file("main.py", "D:/repo/services/api/main.py"), file("poetry.lock", "D:/repo/services/api/poetry.lock")],
      packageManager: "poetry",
    },
  ]);
  const [command] = flattenCommands(result);
  assert.equal(result.ecosystems[0].id, "python:services/api");
  assert.equal(command.cmd, "poetry run python main.py");
  assert.equal(command.dir, "services/api");
  assert.equal(command.ecosystem, "python:services/api");
});

test("scanProjectCommands：Python 包只生成模块命令，不把包目录重复识别为项目", async () => {
  const root = "D:/python/repo";
  const packageDir = `${root}/demo_package`;
  const main = `${packageDir}/__main__.py`;
  const helper = `${packageDir}/helpers.py`;
  const directories = new Map([
    [root, [file("pyproject.toml", `${root}/pyproject.toml`), directory("demo_package", packageDir)]],
    [packageDir, [file("__main__.py", main), file("helpers.py", helper)]],
  ]);
  const contents = new Map([[`${root}/pyproject.toml`, "[project]\nname = 'demo'\n"]]);
  const previous = globalThis.window;
  installWindow({
    snow: {
      readDirectoryEntries: async (dirPath) => directories.get(dirPath) || [],
      readFileContent: async (filePath) => fileContent(contents.get(filePath) || ""),
    },
  });
  try {
    const result = await scanProjectCommands(root);
    const pythonPackages = result.packages.filter((item) => item.ecosystem === "python");
    const commands = flattenCommands(result);
    assert.deepEqual(pythonPackages.map((item) => item.dir), [""]);
    assert.deepEqual(commands.map((command) => command.cmd), ["python -m demo_package"]);
    assert.equal(commands[0].sourcePath, main);
    assert.ok(!commands.some((command) => command.cmd === "python __main__.py"));
    assert.ok(!result.packages.some((item) => item.dir === "demo_package"));
  } finally {
    restoreWindow(previous);
  }
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
  // EcosystemGroup / RunCommand 的必填字段全给齐（label、markers、dir、entry、icon）；
  // Node 生态的图标就是 readNodeScripts 用的 "package"，dir 与 id 保持自洽（子包 id 带目录）。
  const group = (id: string, dir: string, commands: EcosystemGroup["commands"]): EcosystemGroup => ({
    kind: "node",
    id,
    label: dir ? `Node · ${dir}` : "Node.js",
    markers: ["package.json"],
    dir,
    entry: null,
    commands,
  });
  const flat = flattenCommands({
    // packages / scannedAt 是 ProjectCommandsSummary 的必填字段；flattenCommands 只读 ecosystems。
    packages: [],
    scannedAt: 0,
    ecosystems: [
      group("node", "", [{ id: "npm:dev", cmd: "npm run dev", labelFallback: "dev", labelKey: null, icon: "package" }]),
      group("node:sub", "sub", [
        { id: "npm:sub:dev", cmd: "npm run dev", labelFallback: "sub/dev", labelKey: null, icon: "package" },
      ]),
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
  installWindow({
    snow: {
      readDirectoryEntries: async (dirPath) => directories.get(dirPath) || [],
      readFileContent: async (filePath) => fileContent(contents.get(filePath) || ""),
    },
  });
  try {
    const result = await scanProjectCommands(root);
    const [command] = flattenCommands(result).filter((item) => item.dir === "apps/web");
    assert.equal(command.packageManager, "pnpm");
    assert.equal(command.cmd, "pnpm run dev");
    assert.equal(command.dir, "apps/web");
  } finally {
    restoreWindow(previous);
  }
});

/* ─────────────────────── Script files 生态 ─────────────────────── */

test("readScriptCommands：为 bat/ps1/sh 生成运行命令（仅脚本路径，解释器交给运行层），忽略非脚本与目录", () => {
  const entries = [
    file("build.bat", "D:/repo/build.bat"),
    file("deploy.ps1", "D:/repo/deploy.ps1"),
    file("start.sh", "D:/repo/start.sh"),
    file("readme.md", "D:/repo/readme.md"),
    directory("scripts", "D:/repo/scripts"),
  ];
  const commands = readScriptCommands(entries);
  // 命令文本就是脚本文件名；解释器由运行层按扩展名选（bat→cmd / ps1→powershell / sh→POSIX）。
  assert.deepEqual(commands.map((c) => c.cmd), ["build.bat", "deploy.ps1", "start.sh"]);
  assert.deepEqual(commands.map((c) => c.label), ["build.bat", "deploy.ps1", "start.sh"]);
  assert.ok(commands.every((c) => c.runKind === "script" && c.icon === "terminal"));
  assert.equal(commands[0].id, "script:build.bat");
  assert.equal(commands[0].sourcePath, "D:/repo/build.bat");
});

test("readScriptCommands：prefix 只标记所属包目录并进入 id / labelFallback", () => {
  const [command] = readScriptCommands([file("run.sh", "D:/repo/tools/run.sh")], { prefix: "tools" });
  assert.equal(command.cmd, "run.sh");
  assert.equal(command.id, "script:tools:run.sh");
  assert.equal(command.labelFallback, "tools/run.sh");
  assert.equal(command.label, "run.sh");
});

test("detectProjectCommands：script 生态生成 Scripts 命令组", () => {
  const result = detectProjectCommands([
    { dir: "tools", ecosystem: "script", entries: [file("build.bat", "D:/repo/tools/build.bat")] },
  ]);
  const eco = result.ecosystems[0];
  assert.equal(eco.kind, "script");
  assert.equal(eco.id, "script:tools");
  assert.equal(eco.label, "Scripts · tools");
  assert.deepEqual(eco.commands.map((c) => c.cmd), ["build.bat"]);
});

test("scanProjectCommands：目录含脚本文件时识别为 script 包并保留 sourcePath", async () => {
  const root = "D:/repo";
  const directories = new Map([
    [root, [file("build.bat", `${root}/build.bat`), file("deploy.ps1", `${root}/deploy.ps1`)]],
  ]);
  const previous = globalThis.window;
  installWindow({
    snow: {
      readDirectoryEntries: async (dirPath) => directories.get(dirPath) || [],
      readFileContent: async () => fileContent(""),
    },
  });
  try {
    const result = await scanProjectCommands(root);
    assert.ok(result.packages.some((item) => item.ecosystem === "script"));
    // 脚本命令默认不进顶栏下拉，需 includeHidden 才出现在扁平列表里。
    assert.deepEqual(flattenCommands(result), []);
    const flat = flattenCommands(result, { includeHidden: true });
    assert.deepEqual(flat.map((c) => c.cmd).sort(), ["build.bat", "deploy.ps1"].sort());
    const batCommand = flat.find((c) => c.cmd === "build.bat");
    assert.ok(batCommand);
    assert.equal(batCommand.sourcePath, `${root}/build.bat`);
  } finally {
    restoreWindow(previous);
  }
});

/* ─────────────────────── Go / Wails 生态 ─────────────────────── */

test("readGoCommands：build/run 定位 main 包入口，test/vet 保持模块级", () => {
  // 无 main 入口（纯库）：build 也退化为模块级，无 run。
  assert.deepEqual(
    readGoCommands([]).map((c) => c.cmd),
    ["go build ./...", "go test ./...", "go vet ./..."]
  );
  // 根有 main.go：build/run 定位到 "."，test/vet 仍为 ./...
  assert.deepEqual(
    readGoCommands([file("main.go", "D:/g/main.go")]).map((c) => c.cmd),
    ["go build .", "go run .", "go test ./...", "go vet ./..."]
  );
  // 根无 main.go（入口在 cmd/<name>）：build/run 定位到 ./cmd/<name>，test/vet 仍为 ./...
  assert.deepEqual(
    readGoCommands([directory("cmd", "D:/g/cmd")], { cmdDirs: ["server"] }).map((c) => c.cmd),
    ["go build ./cmd/server", "go run ./cmd/server", "go test ./...", "go vet ./..."]
  );
  // 无 main.go 且无 cmdDirs：不给 run，build 退化为模块级
  assert.deepEqual(
    readGoCommands([directory("cmd", "D:/g/cmd")]).map((c) => c.cmd),
    ["go build ./...", "go test ./...", "go vet ./..."]
  );
  // 图标用 Go（而非 npm）
  assert.ok(readGoCommands([]).every((c) => c.icon === "go"));
});

test("readWails3Commands：固定 wails3 task dev/package/build 三命令，图标用 Wails", () => {
  const cmds = readWails3Commands({ prefix: "" });
  assert.deepEqual(
    cmds.map((c) => c.cmd),
    ["wails3 task dev", "wails3 task package", "wails3 task build"]
  );
  assert.deepEqual(
    cmds.map((c) => c.id),
    ["wails3:dev", "wails3:package", "wails3:build"]
  );
  assert.ok(cmds.every((c) => c.icon === "wails"));
});

test("readWails2Commands：wails dev/build，图标用 Wails", () => {
  const cmds = readWails2Commands();
  assert.deepEqual(
    cmds.map((c) => c.cmd),
    ["wails dev", "wails build"]
  );
  assert.ok(cmds.every((c) => c.icon === "wails"));
});

test("detectProjectCommands：wails3 项目固定 wails3 task dev/package/build", () => {
  const result = detectProjectCommands([
    { dir: "", ecosystem: "go", entries: [], hasWails3: true },
  ]);
  const eco = result.ecosystems[0];
  assert.equal(eco.kind, "go");
  assert.equal(eco.id, "go");
  assert.deepEqual(
    eco.commands.map((c) => c.cmd),
    ["wails3 task dev", "wails3 task package", "wails3 task build"]
  );
});

test("JVM 生态：识别 Java main、跳过注释中的伪 main，并生成 Maven 命令", () => {
  const source = [
    "package com.example;",
    "// public static void main(String[] args) {}",
    "public class App {",
    "  public static void main(String[] args) {}",
    "}",
  ].join("\n");
  const [candidate] = findJavaMainCandidates(source, "App.java");
  assert.deepEqual(candidate, { mainClass: "com.example.App", line: 4, language: "java" });
  const commands = readMavenCommands({
    prefix: "admin",
    wrapper: "mvnw.cmd",
    pomText: "<artifactId>app</artifactId><artifactId>spring-boot-maven-plugin</artifactId>",
    mainCandidates: [{ ...candidate, sourcePath: "D:/repo/admin/src/main/java/App.java" }],
  });
  assert.equal(commands[0].cmd, "../mvnw.cmd test");
  const run = commands.find((command) => command.mainClass === "com.example.App");
  assert.ok(run);
  assert.equal(run.cmd, "../mvnw.cmd spring-boot:run -Dspring-boot.run.main-class=com.example.App");
  assert.equal(run.runKind, "spring-boot");
  assert.equal(run.sourcePath, "D:/repo/admin/src/main/java/App.java");
});

test("JVM 生态：块注释结束后仍识别 Java main，避免 Javadoc 吞掉后续源码", () => {
  const source = [
    "/**",
    " * 文档中的伪 main：public static void main(String[] args)",
    " */",
    "package com.example;",
    "public class App {",
    "  public static void main(String[] args) {}",
    "}",
  ].join("\n");
  assert.deepEqual(findJavaMainCandidates(source, "App.java"), [
    { mainClass: "com.example.App", line: 6, language: "java" },
  ]);
});

test("JVM 生态：Gradle apply false 根聚合器不生成 Android 专用任务", () => {
  const commands = readGradleCommands({
    buildText: [
      "plugins {",
      '    id("com.android.application") version "9.2.0" apply false',
      "}",
    ].join("\n"),
  });
  assert.deepEqual(commands, []);
});

test("JVM 生态：识别 Kotlin 顶层和 object main，普通 Maven 使用 exec:java", () => {
  const top = findJavaMainCandidates("package demo\nfun main(args: Array<String>) {}", "Launcher.kt");
  assert.deepEqual(top, [{ mainClass: "demo.LauncherKt", line: 2, language: "kotlin" }]);
  const objectMain = findJavaMainCandidates("package demo\nobject Launcher {\n  fun main() {}\n}", "Launcher.kt");
  assert.deepEqual(objectMain, [{ mainClass: "demo.Launcher", line: 3, language: "kotlin" }]);
  const run = readMavenCommands({ prefix: "tools", mainCandidates: [{ ...top[0], sourcePath: "D:/repo/tools/Launcher.kt" }] }).find((command) => command.mainClass);
  assert.ok(run);
  assert.equal(run.cmd, "mvn compile exec:java -Dexec.mainClass=demo.LauncherKt");
  assert.equal(run.runKind, "maven-exec");
});

test("JVM 生态：Maven 无 wrapper 始终使用系统 mvn，不生成相对路径", () => {
  const commands = readMavenCommands({
    prefix: "admin",
    pomText: "<artifactId>spring-boot-maven-plugin</artifactId>",
    mainCandidates: [{ mainClass: "com.nzygyt.GytApplication", line: 12 }],
  });
  const commandTexts = commands.map((command) => command.cmd);

  assert.deepEqual(commandTexts, [
    "mvn test",
    "mvn package",
    "mvn spring-boot:run -Dspring-boot.run.main-class=com.nzygyt.GytApplication",
  ]);
  assert.ok(commandTexts.every((command) => !command.startsWith("../mvn ")));
});

test("JVM 生态：Gradle 无 wrapper 使用系统 gradle，真实 wrapper 从根目录调用", () => {
  const fallback = readGradleCommands({
    prefix: "tools",
    buildText: 'plugins { kotlin("jvm") ; application }',
  });
  assert.deepEqual(
    fallback.map((command) => command.cmd),
    ["gradle :tools:build", "gradle :tools:test", "gradle :tools:run"]
  );
  assert.ok(fallback.every((command) => !command.cmd.startsWith("../gradlew.bat ")));

  const wrapper = readGradleCommands({
    prefix: "tools",
    wrapper: "gradlew.bat",
    buildText: 'plugins { kotlin("jvm") ; application }',
  });
  assert.ok(wrapper.some((command) => command.cmd === "gradlew.bat :tools:build"));
});

test("Gradle：Android 只生成 Android 任务，JVM application 生成 module run 和 main 元数据", () => {
  const android = readGradleCommands({
    prefix: "app",
    wrapper: "gradlew.bat",
    buildText: 'plugins { id("com.android.application") }',
    mainCandidates: [{ mainClass: "com.example.MainActivity", line: 10 }],
  });
  assert.deepEqual(android.map((command) => command.cmd), [
    "gradlew.bat :app:assembleDebug",
    "gradlew.bat :app:testDebugUnitTest",
    "gradlew.bat :app:lint",
  ]);
  assert.ok(android.every((command) => command.runDir === ""), "根项目 Gradle 任务必须从根目录执行");
  assert.ok(android.every((command) => !command.mainClass), "Android Activity 不得被当成 main");

  const jvm = readGradleCommands({
    prefix: "tools",
    wrapper: "gradlew.bat",
    buildText: 'plugins { kotlin("jvm") ; application }',
    mainCandidates: [{ mainClass: "demo.LauncherKt", line: 3, sourcePath: "D:/repo/tools/Launcher.kt" }],
  });
  assert.ok(jvm.some((command) => command.cmd === "gradlew.bat :tools:build"));
  assert.ok(jvm.some((command) => command.cmd === "gradlew.bat :tools:run" && command.mainClass === "demo.LauncherKt"));
  assert.ok(jvm.every((command) => command.runDir === ""), "Gradle 根项目任务必须从根目录执行");
});

test("detectProjectCommands：Maven/Gradle 多模块保留 dir、id 和 JVM 命令组，但顶栏只显示根公共命令与模块入口", () => {
  const result = detectProjectCommands([
    { dir: "", ecosystem: "maven", pomText: "<packaging>pom</packaging>", mainCandidates: [] },
    { dir: "admin", ecosystem: "maven", pomText: "spring-boot-maven-plugin", mainCandidates: [{ mainClass: "demo.App", line: 2, sourcePath: "D:/repo/admin/App.java" }], wrapper: "mvnw.cmd" },
    { dir: "common", ecosystem: "maven", pomText: "", mainCandidates: [{ mainClass: "demo.Tool", line: 2, sourcePath: "D:/repo/common/Tool.java" }], wrapper: "mvnw.cmd" },
    { dir: "app", ecosystem: "gradle", buildText: 'plugins { id("com.android.application") }', mainCandidates: [], wrapper: "gradlew.bat", modulePath: ":app" },
  ]);
  const flat = flattenCommands(result);
  assert.deepEqual(
    flat.map((command) => `${command.group || "root"}:${command.label}`),
    ["root:test", "root:package", "admin:App", "app:assembleDebug", "app:testDebugUnitTest", "app:lint"]
  );
  assert.ok(flat.some((command) => command.id === "maven:admin:main:demo-App" && command.dir === "admin"));
  assert.ok(flat.every((command) => command.id && command.labelFallback && command.icon));
  assert.ok(!flat.some((command) => command.dir === "common"));
  assert.ok(flattenCommands(result, { includeHidden: true }).some((command) => command.mainClass === "demo.Tool"));
  // RunCommand.label 在类型上可缺（见 ecosystems 的 RunCommandCore），includes 的入参类型要跟着覆盖
  // undefined；字面量与判定本身一字未改。
  const rootCommonLabels: (string | undefined)[] = ["test", "package"];
  assert.ok(!flat.some((command) => command.dir === "admin" && rootCommonLabels.includes(command.label)));
});

test("detectProjectCommands：纯 Go 定位 main 包入口（build/run）+ 模块级 test/vet", () => {
  const result = detectProjectCommands([
    { dir: "server", ecosystem: "go", entries: [directory("cmd", "D:/g/server/cmd")], cmdDirs: ["server"] },
  ]);
  const eco = result.ecosystems[0];
  assert.equal(eco.id, "go:server");
  assert.deepEqual(
    eco.commands.map((c) => c.cmd),
    ["go build ./cmd/server", "go run ./cmd/server", "go test ./...", "go vet ./..."]
  );
});

test("detectProjectCommands：wails2 项目（wails.json）走 wails dev/build", () => {
  const result = detectProjectCommands([{ dir: "", ecosystem: "go", entries: [], hasWails2: true }]);
  assert.deepEqual(
    result.ecosystems[0].commands.map((c) => c.cmd),
    ["wails dev", "wails build"]
  );
});

test("排序规矩：同一目录下服务端（Go）展示在前端（Node）之前", () => {
  const result = detectProjectCommands([
    pkg("", { scripts: { dev: "vite" } }), // Node 先传入，仍应排后
    { dir: "", ecosystem: "go", entries: [], hasWails3: true },
  ]);
  const flat = flattenCommands(result);
  assert.deepEqual(
    flat.map((c) => c.cmd),
    ["wails3 task dev", "wails3 task package", "wails3 task build", "npm run dev"]
  );
  assert.equal(flat[0].ecosystem, "go");
});

test("排序规矩：父包层级优先于生态优先级（根 Node 仍排在子目录 Go 之前）", () => {
  const result = detectProjectCommands([
    pkg("", { scripts: { dev: "vite" } }),
    { dir: "backend", ecosystem: "go", entries: [] },
  ]);
  const flat = flattenCommands(result);
  assert.equal(flat[0].cmd, "npm run dev");
  assert.equal(flat[0].dir, "");
  assert.equal(flat[1].dir, "backend");
});

test("scanProjectCommands：根 Go module + frontend 子包，Go 居前且跳过独立 tests 模块", async () => {
  const root = "D:/go/ClamAV-LMD-GUI";
  const frontend = `${root}/frontend`;
  const tests = `${root}/tests`;
  const directories = new Map([
    [
      root,
      [
        file("go.mod", `${root}/go.mod`),
        file("Taskfile.yml", `${root}/Taskfile.yml`),
        file("main.go", `${root}/main.go`),
        directory("frontend", frontend),
        directory("tests", tests),
      ],
    ],
    [frontend, [file("package.json", `${frontend}/package.json`)]],
    // 独立 go 测试模块（自带 go.mod）：不应被识别为 go 包
    [tests, [file("go.mod", `${tests}/go.mod`)]],
  ]);
  const contents = new Map([
    [`${root}/go.mod`, "module clamav-lmd-gui\n\ngo 1.26.5\n\nrequire github.com/wailsapp/wails/v3 v3.0.0-alpha.99\n"],
    [`${root}/Taskfile.yml`, "version: '3'\n\ntasks:\n  dev:\n    cmds:\n      - wails3 dev\n  build:\n    cmds:\n      - x\n"],
    [`${frontend}/package.json`, JSON.stringify({ name: "frontend", scripts: { dev: "vite", build: "vite build" } })],
    [`${tests}/go.mod`, "module github.com/chencn/go-desktop/tests\n\ngo 1.26.5\n"],
  ]);
  const previous = globalThis.window;
  installWindow({
    snow: {
      readDirectoryEntries: async (dirPath) => directories.get(dirPath) || [],
      readFileContent: async (filePath) => fileContent(contents.get(filePath) || ""),
    },
  });
  try {
    const result = await scanProjectCommands(root);
    const flat = flattenCommands(result);
    // 根 Go（wails3）：固定 wails3 task dev/package/build，排在最前
    assert.deepEqual(flat[0].cmd, "wails3 task dev");
    assert.equal(flat[0].dir, "");
    assert.deepEqual(
      flat.filter((c) => c.dir === "").map((c) => c.cmd),
      ["wails3 task dev", "wails3 task package", "wails3 task build"]
    );
    // 独立测试模块被跳过
    assert.ok(!flat.some((c) => c.dir === "tests" || c.dir.startsWith("tests/")));
    // frontend 前端命令存在且排在根 Go 之后
    const frontendIdx = flat.findIndex((c) => c.dir === "frontend");
    const rootGoIdx = flat.findIndex((c) => c.dir === "" && c.cmd === "wails3 task dev");
    assert.ok(frontendIdx > rootGoIdx);
    assert.deepEqual(
      flat.filter((c) => c.dir === "frontend").map((c) => c.cmd),
      ["npm run dev", "npm run build"]
    );
  } finally {
    restoreWindow(previous);
  }
});

test("scanProjectCommands：根目录同时有 package.json 与 go.mod → Node 与 Wails 两个生态都识别", async () => {
  const root = "D:/go/gyt-treatment";
  const directories = new Map([
    [
      root,
      [
        file("package.json", `${root}/package.json`),
        file("go.mod", `${root}/go.mod`),
        file("Taskfile.yml", `${root}/Taskfile.yml`),
        file("main.go", `${root}/main.go`),
      ],
    ],
  ]);
  const contents = new Map([
    [`${root}/package.json`, JSON.stringify({ name: "gyt-treatment-shared", private: true, scripts: { dev: "vite" } })],
    [`${root}/go.mod`, "module nzygyt.com/gyt-treatment\n\ngo 1.26.5\n\nrequire github.com/wailsapp/wails/v3 v3.0.0-beta.20\n"],
    [`${root}/Taskfile.yml`, "version: '3'\n\ntasks:\n  dev:\n    cmds:\n      - wails3 dev\n"],
  ]);
  const previous = globalThis.window;
  installWindow({
    snow: {
      readDirectoryEntries: async (dirPath) => directories.get(dirPath) || [],
      readFileContent: async (filePath) => fileContent(contents.get(filePath) || ""),
    },
  });
  try {
    const result = await scanProjectCommands(root);
    const flat = flattenCommands(result);
    // 根目录既有 package.json 又有 go.mod：两个生态都必须产出（不能因有 package.json 就漏掉 Wails）。
    assert.ok(flat.some((c) => c.cmd === "wails3 task dev"), "应识别出 wails3 命令");
    assert.ok(flat.some((c) => c.cmd === "npm run dev"), "应识别出 Node 命令");
    // 服务端（Go/Wails）在前端（Node）之前
    const wailsIdx = flat.findIndex((c) => c.cmd === "wails3 task dev");
    const nodeIdx = flat.findIndex((c) => c.cmd === "npm run dev");
    assert.ok(wailsIdx < nodeIdx);
  } finally {
    restoreWindow(previous);
  }
});

test("scanProjectCommands：Maven 根聚合器与子模块读取标准源码 main，子模块使用根 wrapper 相对路径", async () => {
  const root = "D:/repo";
  const admin = `${root}/admin`;
  const src = `${admin}/src`;
  const main = `${src}/main`;
  const java = `${main}/java`;
  const app = `${java}/App.java`;
  const directories = new Map([
    [root, [file("pom.xml", `${root}/pom.xml`), file("mvnw.cmd", `${root}/mvnw.cmd`), directory("admin", admin)]],
    [admin, [file("pom.xml", `${admin}/pom.xml`), directory("src", src)]],
    [src, [directory("main", main)]],
    [main, [directory("java", java)]],
    [java, [file("App.java", app)]],
  ]);
  const contents = new Map([
    [`${root}/pom.xml`, "<packaging>pom</packaging><modules><module>admin</module></modules>"],
    [`${admin}/pom.xml`, "spring-boot-maven-plugin"],
    [app, ["package demo;", "public class App {", "  public static void main(String[] args) {}", "}"].join("\\n")],
  ]);
  const previous = globalThis.window;
  installWindow({
    snow: {
      readDirectoryEntries: async (dirPath) => directories.get(dirPath) || [],
      readFileContent: async (filePath) => fileContent(contents.get(filePath) || ""),
    },
  });
  try {
    const result = await scanProjectCommands(root);
    const adminRun = flattenCommands(result).find((command) => command.dir === "admin" && command.mainClass === "demo.App");
    assert.ok(adminRun);
    assert.equal(adminRun.cmd, "../mvnw.cmd spring-boot:run -Dspring-boot.run.main-class=demo.App");
    assert.equal(adminRun.sourcePath, app);
    assert.ok(result.ecosystems.some((eco) => eco.id === "maven"));
    assert.ok(result.ecosystems.some((eco) => eco.id === "maven:admin"));
  } finally {
    restoreWindow(previous);
  }
});
