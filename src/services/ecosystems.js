/**
 * 生态辅助函数 (src/services/ecosystems.js)
 *
 * 提供各生态的命令生成纯逻辑，供 project-commands.js 组合：
 *   - Node：resolveNodeEntry / readNodeScripts（package.json scripts → 包管理器 run）。
 *   - Go / Wails：readTaskfileCommands（Taskfile 任务名 → `task <name>`）、
 *     readWails2Commands（wails.json → `wails dev|build`）、
 *     readWails3NativeCommands（wails3 原生命令）、readGoCommands（go build|test|vet|run）。
 *
 * 说明：原先的 ECOSYSTEMS 声明式注册表已移除——命令识别已改为「扫描标记文件」
 *   的模型（多级目录 / 多标记文件），根目录单项目只是它的一个特例，
 *   旧的「根目录命中即整体识别」注册表契约不再适用。
 *
 * 所有函数均为无 IO 纯函数：调用方负责读文件 / 列目录，本模块只做文本解析与命令拼装。
 */

/**
 * Node 根目录入口文件的兜底候选（package.json 无 main 字段时按序探测）。
 * @type {string[]}
 */
const NODE_ENTRY_CANDIDATES = ["index.js", "main.js", "app.js", "server.js"];

/** 支持的 Node 包管理器；框架命令最终都通过 package.json scripts 暴露。 */
const PACKAGE_MANAGERS = new Set(["npm", "yarn", "pnpm", "bun"]);

/** 锁文件优先级：显式 packageManager 仍然优先于锁文件。 */
const PACKAGE_MANAGER_LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
];

/**
 * 规范化包管理器名称，兼容 packageManager 的 `pnpm@9.0.0` 形式。
 * @param {unknown} value packageManager 字段、锁文件推断值或回退值
 * @returns {string|null} npm / yarn / pnpm / bun；未知值返回 null
 */
function normalizePackageManager(value) {
  const match = String(value || "").trim().toLowerCase().match(/^([a-z]+)(?:@.*)?$/);
  const name = match ? match[1] : "";
  return PACKAGE_MANAGERS.has(name) ? name : null;
}

/**
 * 从 package.json 与目录条目推断包管理器。
 * @description 显式 `packageManager` > 同目录锁文件 > 调用方传入的继承值 > npm。
 * @param {Object|null} packageJson 已解析的 package.json
 * @param {Array<{name: string, isDirectory?: boolean}>} entries 包目录直接条目
 * @param {string} [fallback="npm"] monorepo 子包继承的根包管理器
 * @returns {string} npm / yarn / pnpm / bun
 */
export function detectPackageManager(packageJson, entries, fallback = "npm") {
  const declared = normalizePackageManager(packageJson && packageJson.packageManager);
  if (declared) return declared;

  const names = new Set(
    (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && entry.isDirectory !== true && typeof entry.name === "string")
      .map((entry) => entry.name.toLowerCase())
  );
  for (const [lockfile, manager] of PACKAGE_MANAGER_LOCKFILES) {
    if (names.has(lockfile)) return manager;
  }
  return normalizePackageManager(fallback) || "npm";
}

/**
 * 为包管理器生成运行 scripts 的命令前缀。
 * @param {string} manager 包管理器
 * @returns {string}
 */
function runCommandPrefix(manager) {
  return normalizePackageManager(manager) || "npm";
}

/**
 * 从目录条目中挑选入口文件。
 * @description 优先 package.json 的 main 字段（仅支持根目录下的裸文件名，
 *   带子目录的 main 如 dist/index.js 一期不解析），其次按候选名探测。
 * @param {Object|null} packageJson 已解析的 package.json
 * @param {Array<{name: string, isDirectory?: boolean}>} entries 根目录条目
 * @returns {string|null} 入口文件名；未找到返回 null
 */
export function resolveNodeEntry(packageJson, entries) {
  const items = Array.isArray(entries) ? entries : [];
  const fileNames = new Set(
    items.filter((e) => e && e.isDirectory !== true && typeof e.name === "string").map((e) => e.name)
  );

  const main =
    packageJson && typeof packageJson.main === "string" ? packageJson.main.trim().replace(/^\.\//, "") : "";
  if (main && !main.includes("/") && !main.includes("\\") && fileNames.has(main)) {
    return main;
  }
  for (const candidate of NODE_ENTRY_CANDIDATES) {
    if (fileNames.has(candidate)) return candidate;
  }
  return null;
}

/**
 * 由 package.json 的 scripts 生成可运行命令列表。
 * @description 保持 scripts 的定义顺序；每条 script 使用对应包管理器的 `<manager> run <name>`。
 *   标签**原样使用 script 名**（不汉化、不归类）：与 IDEA 一致，`dev` 就显示 `dev`，
 *   避免「开发 / 构建」这类改写造成与 package.json 定义不一致、难以对上号。
 * @param {Object|null} packageJson 已解析的 package.json
 * @param {{prefix?: string, packageManager?: string, entries?: Array}} [opts]
 *   - prefix：子包相对根目录的路径（如 `sub` / `sub/nested`），只用于命令归属和分组；
 *   - packageManager：已解析的包管理器；省略时从 package.json / entries 推断。
 * @returns {Array<{id: string, labelKey: null, labelFallback: string, cmd: string, packageManager: string}>}
 */
export function readNodeScripts(packageJson, opts = {}) {
  const scripts =
    packageJson && typeof packageJson === "object" && packageJson.scripts && typeof packageJson.scripts === "object"
      ? packageJson.scripts
      : null;
  if (!scripts) return [];

  const prefix = typeof opts.prefix === "string" ? opts.prefix.replace(/^\/+|\/+$/g, "") : "";
  const manager = runCommandPrefix(
    opts.packageManager || detectPackageManager(packageJson, opts.entries, "npm")
  );
  const commands = [];
  for (const name of Object.keys(scripts)) {
    if (!name || typeof scripts[name] !== "string") continue;
    commands.push({
      // id 带上包路径和包管理器，避免多包 / 多管理器的同名 script 冲突。
      id: prefix ? `${manager}:${prefix}:${name}` : `${manager}:${name}`,
      labelKey: null,
      // label：下拉项显示的**纯 script 名**（所属包由分组标题表达，条目里不重复路径）。
      label: name,
      // labelFallback：带包路径的完整名（工具栏当前配置按钮 / 右键菜单需区分多包同名命令）。
      labelFallback: prefix ? `${prefix}/${name}` : name,
      packageManager: manager,
      // 运行时会把 cwd 切到 package.json 所在目录，避免为不同包管理器维护 --prefix / --cwd 方言。
      cmd: `${manager} run ${name}`,
      // 运行配置图标：Node 用 npm 图标（lucide package）。
      icon: "package",
    });
  }
  return commands;
}

/**
 * 根包（package.json 无 scripts 时）的兜底命令：探测入口文件，生成 `node <entry>`。
 * @description 仅用于**工作区根目录**的 package.json（子包不走此兜底，避免 `node sub/index.js`
 *   这类相对 cwd 的入口命令在宿主 shell（cwd=根目录）里语义不清）。
 * @param {Object|null} packageJson 已解析的 package.json
 * @param {Array<{name: string, isDirectory?: boolean}>} entries 该包目录的直接子条目
 * @returns {Array<{id: string, labelKey: string, labelFallback: string, cmd: string}>}
 */
export function nodeEntryFallback(packageJson, entries) {
  const entry = resolveNodeEntry(packageJson, entries);
  if (!entry) return [];
  return [
    {
      id: "node:entry",
      labelKey: "run.nodeEntry",
      labelFallback: "Run entry",
      cmd: `node ${entry}`,
      icon: "package",
    },
  ];
}

/* ─────────────────────────── Python ─────────────────────────── */

const PYTHON_ENTRY_CANDIDATES = ["main.py", "app.py", "cli.py", "run.py", "server.py", "__main__.py"];
const PYTHON_PACKAGE_MANAGERS = new Set(["uv", "poetry", "pipenv", "pdm", "hatch"]);

function normalizePythonPackageManager(value) {
  const name = String(value || "").trim().toLowerCase();
  return PYTHON_PACKAGE_MANAGERS.has(name) ? name : "python";
}

/**
 * 根据项目标记判断 Python 包管理器；没有明确包管理器时回退到系统 Python。
 * @param {Array<{name: string, isDirectory?: boolean}>} entries 项目目录直接条目
 * @param {string} pyprojectText 已读取的 pyproject.toml 文本
 * @param {string} fallback 无锁文件时的回退值
 * @returns {string} python / uv / poetry / pipenv / pdm / hatch
 */
export function detectPythonPackageManager(entries, pyprojectText = "", fallback = "python") {
  const names = new Set(
    (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && entry.isDirectory !== true && typeof entry.name === "string")
      .map((entry) => entry.name.toLowerCase())
  );
  const text = String(pyprojectText || "");
  if (names.has("uv.lock")) return "uv";
  if (names.has("poetry.lock") || /\[tool\.poetry\]/.test(text)) return "poetry";
  if (names.has("pipfile") || names.has("pipfile.lock")) return "pipenv";
  if (names.has("pdm.lock") || /\[tool\.pdm\]/.test(text)) return "pdm";
  if (names.has("hatch.toml") || /\[tool\.hatch/.test(text)) return "hatch";
  return normalizePythonPackageManager(fallback);
}

/**
 * 识别 Python 可运行入口。入口只来自直接文件；包目录由扫描器显式传入 modules。
 * @param {Array<{name: string, path: string, isDirectory?: boolean}>} entries 项目目录条目
 * @param {{modules?: Array<{name: string, path?: string, sourcePath?: string}>}} opts 包入口
 * @returns {Array<{name: string, path: string, kind: "file"|"module", module?: string}>}
 */
export function findPythonMainCandidates(entries, opts = {}) {
  const items = Array.isArray(entries) ? entries : [];
  const files = new Map(
    items
      .filter((entry) => entry && entry.isDirectory !== true && typeof entry.name === "string")
      .map((entry) => [entry.name.toLowerCase(), entry])
  );
  const result = [];
  const seen = new Set();
  for (const name of PYTHON_ENTRY_CANDIDATES) {
    const entry = files.get(name.toLowerCase());
    if (!entry || seen.has(entry.path)) continue;
    seen.add(entry.path);
    result.push({ name: entry.name, path: entry.path, kind: "file" });
  }
  for (const module of Array.isArray(opts.modules) ? opts.modules : []) {
    if (!module || !module.name || !module.sourcePath || seen.has(module.sourcePath)) continue;
    seen.add(module.sourcePath);
    result.push({ name: module.name, path: module.sourcePath, kind: "module", module: module.name });
  }
  return result;
}

/**
 * 生成 Python 项目运行命令；包管理器只包裹解释器，不擅自生成安装命令。
 * @param {{prefix?: string, entries?: Array, pyprojectText?: string, packageManager?: string, modules?: Array}} opts
 * @returns {Array<Object>}
 */
export function readPythonCommands(opts = {}) {
  const prefix = normalizePrefix(opts.prefix);
  const manager = normalizePythonPackageManager(
    opts.packageManager || detectPythonPackageManager(opts.entries, opts.pyprojectText, "python")
  );
  const runner = {
    python: "python",
    uv: "uv run python",
    poetry: "poetry run python",
    pipenv: "pipenv run python",
    pdm: "pdm run python",
    hatch: "hatch run python",
  }[manager];
  const candidates = findPythonMainCandidates(opts.entries, { modules: opts.modules });
  return candidates.map((candidate) => {
    const target = candidate.kind === "module" ? `-m ${candidate.module}` : candidate.name;
    const label = candidate.kind === "module" ? candidate.module : candidate.name;
    return {
      id: prefix ? `python:${prefix}:${label}` : `python:${label}`,
      labelKey: null,
      label,
      labelFallback: prefix ? `${prefix}/${label}` : label,
      cmd: `${runner} ${target}`,
      icon: "python",
      packageManager: manager,
      runKind: "python",
      sourcePath: candidate.path,
    };
  });
}

/* ─────────────────────────── Go / Wails ─────────────────────────── */

/** 归一化命令前缀（相对根目录的 POSIX 路径）：去首尾斜杠。 */
function normalizePrefix(prefix) {
  return typeof prefix === "string" ? prefix.replace(/^\/+|\/+$/g, "") : "";
}

/**
 * 生成命令对象的公共外壳（与 readNodeScripts 产物同构，供渲染层统一消费）。
 * @param {string} kind 命令来源标识（go / wails / wails3），用作 id 前缀
 * @param {string} prefix 所属目录前缀（根目录为 ""）
 * @param {string} name 稳定名（用于 id，多项目同名不冲突）
 * @param {string} cmd 实际执行的命令文本
 * @param {string} [label] 显示名（缺省用 name）
 * @param {string} [icon] 运行配置图标名（go / wails / package）
 */
function makeCommand(kind, prefix, name, cmd, label = name, icon = "package") {
  return {
    id: prefix ? `${kind}:${prefix}:${name}` : `${kind}:${name}`,
    labelKey: null,
    label,
    labelFallback: prefix ? `${prefix}/${label}` : label,
    cmd,
    icon,
  };
}

/**
 * Wails v3 标准运行入口：固定的 `wails3 task dev` / `wails3 task package` / `wails3 task build`。
 * @description wails3 项目自带 Taskfile，这三个是标准任务。用 wails3 CLI 的 `task` 子命令执行
 *   （不依赖系统单独安装 go-task，wails3 内置）。不再解析 Taskfile 的全部任务，避免把
 *   run / setup:docker / build:server 等一次性 / CI 任务也塞进运行列表（用户要求精简）。
 * @param {{prefix?: string}} [opts]
 */
export function readWails3Commands(opts = {}) {
  const prefix = normalizePrefix(opts.prefix);
  return [
    ["dev", "wails3 task dev"],
    ["package", "wails3 task package"],
    ["build", "wails3 task build"],
  ].map(([name, cmd]) => makeCommand("wails3", prefix, name, cmd, cmd, "wails"));
}

/** Wails v2 命令：`wails dev` / `wails build`（图标同 Wails）。 */
export function readWails2Commands(opts = {}) {
  const prefix = normalizePrefix(opts.prefix);
  return [
    ["dev", "wails dev"],
    ["build", "wails build"],
  ].map(([name, cmd]) => makeCommand("wails", prefix, name, cmd, cmd, "wails"));
}

/**
 * 纯 Go 项目命令（图标用 Go）。
 * @description 两类作用域：
 *   - build / run：必须定位到 main 包入口（`go build ./cmd/server` 才产出可执行文件，
 *     `go build ./...` 不产出）。入口包：根 main.go → `.`；否则每个 `cmd/<name>/main.go` → `./cmd/<name>`。
 *   - test / vet：作用域是整个模块，保持 `./...`（`go test ./cmd/server` 只测入口包，会漏掉 internal 等库代码）。
 *   无 main 入口（纯库）时 build 也退化为 `./...`。
 * @param {Array<{name: string, isDirectory?: boolean}>} entries 项目目录直接条目
 * @param {{prefix?: string, cmdDirs?: string[]}} [opts] cmdDirs：cmd/ 下的子目录名（每个通常是一个 main 包）
 */
export function readGoCommands(entries, opts = {}) {
  const prefix = normalizePrefix(opts.prefix);
  const items = Array.isArray(entries) ? entries : [];
  const hasMain = items.some((e) => e && e.name === "main.go" && e.isDirectory !== true);
  const cmdDirs = (Array.isArray(opts.cmdDirs) ? opts.cmdDirs : []).filter((dir) => typeof dir === "string" && dir);

  // 入口 main 包列表：根 main.go → "."；否则每个 cmd/<name> → "./cmd/<name>"。
  const entryPackages = hasMain ? ["."] : cmdDirs.map((dir) => `./cmd/${dir}`);

  const specs = [];
  if (entryPackages.length) {
    for (const pkg of entryPackages) {
      // 多入口时用包路径作区分后缀，保证 id / label 不冲突（根入口用 root）。
      const tag = pkg === "." ? "root" : pkg.replace(/^\.\//, "").replace(/\//g, "-");
      specs.push([`build:${tag}`, `go build ${pkg}`]);
      specs.push([`run:${tag}`, `go run ${pkg}`]);
    }
  } else {
    // 无 main 入口（纯库）：build 也只能模块级。
    specs.push(["build", "go build ./..."]);
  }
  // test / vet 恒为模块级：覆盖全部包。
  specs.push(["test", "go test ./..."]);
  specs.push(["vet", "go vet ./..."]);
  return specs.map(([name, cmd]) => makeCommand("go", prefix, name, cmd, cmd, "go"));
}

/* ─────────────────────────── Java / Kotlin / JVM ─────────────────────────── */

/**
 * 去除 Java/Kotlin 注释但保留换行，确保行号稳定且注释中的 main 不会被识别。
 * 字符串和字符字面量不会把其中的 // 或 /* 当成注释起点。
 * @param {string} text Java 或 Kotlin 源码
 * @returns {string} 保留换行的可扫描源码
 */
function stripJvmComments(text) {
  const source = String(text == null ? "" : text);
  let output = "";
  let state = "code";
  let quote = "";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "line") {
      if (ch === "\n" || ch === "\r") {
        output += ch;
        state = "code";
      } else {
        output += " ";
      }
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        output += "  ";
        i += 1;
        state = "code";
      } else {
        output += ch === "\n" || ch === "\r" ? ch : " ";
      }
      continue;
    }
    if (state === "string") {
      output += ch === "\n" || ch === "\r" ? ch : " ";
      if (ch === "\\") {
        if (i + 1 < source.length) {
          output += source[i + 1] === "\n" || source[i + 1] === "\r" ? source[i + 1] : " ";
          i += 1;
        }
      } else if (ch === quote) {
        state = "code";
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      output += "  ";
      i += 1;
      state = "line";
    } else if (ch === "/" && next === "*") {
      output += "  ";
      i += 1;
      state = "block";
    } else if (ch === '"' || ch === "'") {
      output += " ";
      quote = ch;
      state = "string";
    } else {
      output += ch;
    }
  }
  return output;
}

function joinJvmName(pkg, name) {
  return pkg ? `${pkg}.${name}` : name;
}

/**
 * 识别 Java/Kotlin 的 main 声明，并返回可供构建工具运行的类名和源码行。
 * @param {string} text Java/Kotlin 源码
 * @param {string} fileName 源文件名（用于 Kotlin 顶层 main 的 FileNameKt）
 * @returns {Array<{mainClass: string, line: number, language: "java"|"kotlin"}>}
 */
export function findJavaMainCandidates(text, fileName = "Main.java") {
  const clean = stripJvmComments(text);
  const lines = clean.split(/\r\n|\r|\n/);
  const packageMatch = clean.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;?/m);
  const pkg = packageMatch ? packageMatch[1] : "";
  const base = String(fileName || "Main").replace(/^.*[\\/]/, "").replace(/\.(?:java|kt)$/i, "") || "Main";
  const candidates = [];
  const add = (mainClass, line, language) => {
    if (!mainClass || !line || candidates.some((item) => item.mainClass === mainClass && item.line === line)) return;
    candidates.push({ mainClass, line, language });
  };

  // Java 的 main 必须是静态 void 方法；类名取当前文件中最外层/首个声明类。
  let javaClass = null;
  for (const line of lines) {
    const match = /\b(?:public\s+)?(?:final\s+|abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (match) {
      javaClass = match[1];
      break;
    }
  }
  if (javaClass) {
    for (let index = 0; index < lines.length; index += 1) {
      if (/\b(?:public\s+)?static\s+void\s+main\s*\(\s*String(?:\s*\[\s*\]|\s+\w+\s*\[\s*\])/.test(lines[index])) {
        add(joinJvmName(pkg, javaClass), index + 1, "java");
      }
    }
  }

  // Kotlin 顶层函数编译为 FileNameKt；object/class 内的 main 运行所属对象/类。
  let currentObject = null;
  for (let index = 0; index < lines.length; index += 1) {
    const objectMatch = /\bobject\s+([A-Za-z_$][\w$]*)/.exec(lines[index]);
    if (objectMatch) currentObject = objectMatch[1];
    const classMatch = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(lines[index]);
    if (classMatch && !currentObject) currentObject = classMatch[1];
    if (/\bfun\s+main\s*\(\s*(?:args\s*:\s*Array\s*<\s*String\s*>\s*)?\)\s*(?::\s*Unit)?/.test(lines[index])) {
      add(joinJvmName(pkg, currentObject || `${base}Kt`), index + 1, "kotlin");
    }
  }
  return candidates;
}

function normalizeJvmPrefix(prefix) {
  return typeof prefix === "string" ? prefix.replace(/^\/+|\/+$/g, "") : "";
}

function wrapperCommand(wrapper, prefix, fallback) {
  const value = String(wrapper || "").trim();
  const command = String(fallback || "").trim();
  if (!value) return command || "mvn";
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value)) return value;
  if (!prefix || /[\\/]/.test(value.replace(/^\.\.?[\\/]/, ""))) return value;
  const depth = normalizeJvmPrefix(prefix).split("/").filter(Boolean).length;
  return `${"../".repeat(depth)}${value.replace(/^\.\//, "")}`;
}

function jvmMainLabel(mainClass) {
  const value = String(mainClass || "");
  return value.split(".").pop() || value;
}

function jvmCommand(kind, prefix, name, cmd, label, icon, metadata = {}) {
  return {
    id: prefix ? `${kind}:${prefix}:${name}` : `${kind}:${name}`,
    labelKey: null,
    label: label || name,
    labelFallback: prefix ? `${prefix}/${label || name}` : label || name,
    cmd,
    icon,
    ...metadata,
  };
}

/**
 * 生成 Maven 基础命令和源码 main 命令。调用方负责把 cwd 切到 prefix 对应模块。
 * @param {{prefix?: string, pomText?: string, mainCandidates?: Array, wrapper?: string, mvn?: string, springBoot?: boolean}} opts
 * @returns {Array<Object>}
 */
export function readMavenCommands(opts = {}) {
  const prefix = normalizeJvmPrefix(opts.prefix);
  const mvn = wrapperCommand(opts.wrapper, prefix, opts.mvn || "mvn");
  const commands = [
    jvmCommand("maven", prefix, "test", `${mvn} test`, "test", "java"),
    jvmCommand("maven", prefix, "package", `${mvn} package`, "package", "java"),
  ];
  const springBoot = opts.springBoot === true || /spring-boot-maven-plugin/.test(String(opts.pomText || ""));
  for (const candidate of Array.isArray(opts.mainCandidates) ? opts.mainCandidates : []) {
    if (!candidate || !candidate.mainClass) continue;
    const suffix = String(candidate.mainClass).replace(/[^A-Za-z0-9_$]+/g, "-");
    const cmd = springBoot
      ? `${mvn} spring-boot:run -Dspring-boot.run.main-class=${candidate.mainClass}`
      : `${mvn} compile exec:java -Dexec.mainClass=${candidate.mainClass}`;
    commands.push(
      jvmCommand(
        "maven",
        prefix,
        `main:${suffix}`,
        cmd,
        jvmMainLabel(candidate.mainClass),
        "java",
        {
          sourcePath: candidate.sourcePath,
          mainLine: candidate.line,
          mainClass: candidate.mainClass,
          runKind: springBoot ? "spring-boot" : "maven-exec",
        }
      )
    );
  }
  return commands;
}

/**
 * 生成 Gradle/Kotlin DSL 命令。Android application 只生成 Android 任务，不把 Activity 当 main。
 * @param {{prefix?: string, buildText?: string, settingsText?: string, mainCandidates?: Array, wrapper?: string, gradle?: string, modulePath?: string}} opts
 * @returns {Array<Object>}
 */
export function readGradleCommands(opts = {}) {
  const prefix = normalizeJvmPrefix(opts.prefix);
  const buildText = String(opts.buildText || "");
  // `apply false` 只是根聚合器预声明插件，不代表当前项目是 Android application/library。
  // 只按同一行实际应用的插件判断，避免把 Gradle 根项目生成 Android 专用任务。
  const android = buildText
    .split(/\r\n|\r|\n/)
    .some((line) => /com\.android\.(?:application|library)/.test(line) && !/\bapply\s+false\b/.test(line));
  const application = !android && /(?:^|[\s"'`])(?:application|org\.gradle\.application)(?:[\s"'`]|$)/.test(buildText);
  const jvm = !android && /java|org\.jetbrains\.kotlin\.jvm|kotlin\("jvm"\)/.test(buildText);
  const modulePath = String(opts.modulePath || (prefix ? `:${prefix.split("/").join(":")}` : ""));
  // Gradle 的 `:module:task` 是根项目任务路径，必须从工作区根目录启动。
  // `command.dir` 仍保留模块目录用于分组和源码匹配，运行时改用 `runDir`。
  const runDir = "";
  const wrapper = wrapperCommand(opts.wrapper, runDir, opts.gradle || "gradle");
  const task = (name) => `${wrapper}${modulePath ? ` ${modulePath}:${name}` : ` ${name}`}`;
  const commands = [];
  if (android) {
    for (const name of ["assembleDebug", "testDebugUnitTest", "lint"]) {
      commands.push(jvmCommand("gradle", prefix, name, task(name), name, "java", { runKind: "android-task", runDir }));
    }
    return commands;
  }
  if (!jvm && !application && !opts.forceJvm) return commands;
  for (const name of ["build", "test"]) commands.push(jvmCommand("gradle", prefix, name, task(name), name, "java", { runDir }));
  if (application) {
    commands.push(jvmCommand("gradle", prefix, "run", task("run"), "run", "java", { runKind: "gradle-application", runDir }));
    for (const candidate of Array.isArray(opts.mainCandidates) ? opts.mainCandidates : []) {
      if (!candidate || !candidate.mainClass) continue;
      commands.push(
        jvmCommand(
          "gradle",
          prefix,
          `main:${String(candidate.mainClass).replace(/[^A-Za-z0-9_$]+/g, "-")}`,
          task("run"),
          jvmMainLabel(candidate.mainClass),
          "java",
          {
            runDir,
            sourcePath: candidate.sourcePath,
            mainLine: candidate.line,
            mainClass: candidate.mainClass,
            runKind: "gradle-application-main",
          }
        )
      );
    }
  }
  return commands;
}
