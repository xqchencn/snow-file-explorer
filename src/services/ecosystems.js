/**
 * 生态辅助函数 (src/services/ecosystems.js)
 *
 * 提供 Node 生态的两段纯逻辑，供 project-commands.js 组合：
 *   - resolveNodeEntry：包清单没有 scripts 时挑一个入口文件（仅根包用）。
 *   - readNodeScripts：由 package.json 的 scripts 生成 `npm run` 命令，支持子包前缀。
 *
 * 说明：原先的 ECOSYSTEMS 声明式注册表已移除——命令识别已改为「扫描多个 package.json」
 *   的模型（支持多级目录 / 多个 package.json），根目录单包只是它的一个特例，
 *   旧的「根目录命中即整体识别」注册表契约不再适用。
 */

/**
 * Node 根目录入口文件的兜底候选（package.json 无 main 字段时按序探测）。
 * @type {string[]}
 */
const NODE_ENTRY_CANDIDATES = ["index.js", "main.js", "app.js", "server.js"];

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
 * @description 保持 scripts 的定义顺序；每条 script 生成 `npm run <name>`。
 *   标签**原样使用 script 名**（不汉化、不归类）：与 IDEA 一致，`dev` 就显示 `dev`，
 *   避免「开发 / 构建」这类改写造成与 package.json 定义不一致、难以对上号。
 * @param {Object|null} packageJson 已解析的 package.json
 * @param {{prefix?: string}} [opts]
 *   - prefix：子包相对根目录的路径（如 `sub` / `sub/nested`）。为空表示根包，
 *     生成 `npm run <name>`；非空则生成 `npm --prefix <prefix> run <name>`，
 *     使命令在宿主当前 shell（cwd=工作区根目录）里也能正确跑到子包。
 * @returns {Array<{id: string, labelKey: null, labelFallback: string, cmd: string}>}
 */
export function readNodeScripts(packageJson, opts = {}) {
  const scripts =
    packageJson && typeof packageJson === "object" && packageJson.scripts && typeof packageJson.scripts === "object"
      ? packageJson.scripts
      : null;
  if (!scripts) return [];

  const prefix = typeof opts.prefix === "string" ? opts.prefix.replace(/^\/+|\/+$/g, "") : "";
  const commands = [];
  for (const name of Object.keys(scripts)) {
    if (!name || typeof scripts[name] !== "string") continue;
    commands.push({
      // id 带上包路径前缀，避免多个包的同名 script 冲突。
      id: prefix ? `npm:${prefix}:${name}` : `npm:${name}`,
      labelKey: null,
      // label：下拉项显示的**纯 script 名**（所属包由分组标题表达，条目里不重复路径）。
      label: name,
      // labelFallback：带包路径的完整名（工具栏当前配置按钮 / 右键菜单需区分多包同名命令）。
      labelFallback: prefix ? `${prefix}/${name}` : name,
      cmd: prefix ? `npm --prefix ${prefix} run ${name}` : `npm run ${name}`,
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
    },
  ];
}
