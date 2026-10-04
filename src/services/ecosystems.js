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
