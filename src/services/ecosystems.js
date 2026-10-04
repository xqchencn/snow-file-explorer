/**
 * 生态注册表 (src/services/ecosystems.js)
 *
 * 设计要点（KISS / 可扩展）：
 *   每个技术栈是注册表里的一条**声明式记录**，检测流程、UI、终端运行全部与生态解耦。
 *   新增生态 = 往 ECOSYSTEMS 追加一条记录，无需改动检测流程或渲染逻辑。
 *
 * 一期范围：仅实现 Node.js（命令定义在 package.json 内容里，是最复杂的形态；
 *   打通"读文件内容 → 生成命令"这条路径后，其余纯文件名判断的生态都是它的退化情形）。
 *   其余生态以注释形式预留 schema，待机制验证后再增量补齐。
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
 * @description 保持 scripts 的定义顺序；每条 script 生成一条 `npm run <name>`。
 *   标签**原样使用 script 名**（不汉化、不归类）：与 IDEA 一致，`dev` 就显示 `dev`，
 *   避免「开发 / 构建」这类改写造成与 package.json 定义不一致、难以对上号。
 * @param {Object|null} packageJson 已解析的 package.json
 * @returns {Array<{id: string, labelKey: null, labelFallback: string, cmd: string}>}
 */
export function readNodeScripts(packageJson) {
  const scripts =
    packageJson && typeof packageJson === "object" && packageJson.scripts && typeof packageJson.scripts === "object"
      ? packageJson.scripts
      : null;
  if (!scripts) return [];

  const commands = [];
  for (const name of Object.keys(scripts)) {
    if (!name || typeof scripts[name] !== "string") continue;
    commands.push({
      id: `npm:${name}`,
      labelKey: null,
      labelFallback: name,
      cmd: `npm run ${name}`,
    });
  }
  return commands;
}

/**
 * 生态注册表。
 * @description 每条记录字段：
 *   - id / label：生态标识与展示名
 *   - markers：判定该生态的标识文件名（根目录直接子文件，精确匹配）
 *   - entryCandidates：入口文件候选（可选，供无 package.json 元数据时兜底）
 *   - readFiles：需要读取内容的标识文件（一期仅 node 用到）
 *   - commands(ctx)：生成命令列表；ctx = { packageJson, entries, entry }
 *
 * @type {Array<Object>}
 */
export const ECOSYSTEMS = [
  {
    id: "node",
    label: "Node.js",
    markers: ["package.json"],
    entryCandidates: NODE_ENTRY_CANDIDATES,
    readFiles: ["package.json"],
    resolveEntry: resolveNodeEntry,
    commands: (ctx) => {
      const list = readNodeScripts(ctx.packageJson);
      if (list.length) return list;
      // 无 scripts 时回退：有入口文件就 node <entry>
      if (ctx.entry) {
        return [
          {
            id: "node:entry",
            labelKey: "run.nodeEntry",
            labelFallback: "Run entry",
            cmd: `node ${ctx.entry}`,
          },
        ];
      }
      return [];
    },
  },

  // ── 后续增量：纯文件名判断的生态，追加记录即可，无需改动检测流程 ──
  // {
  //   id: "go",
  //   label: "Go",
  //   markers: ["go.mod"],
  //   entryCandidates: ["main.go"],
  //   commands: () => [
  //     { id: "go:run", labelKey: "run.go.run", labelFallback: "Run", cmd: "go run ." },
  //     { id: "go:test", labelKey: "run.go.test", labelFallback: "Test", cmd: "go test ./..." },
  //   ],
  // },
  // {
  //   id: "rust",
  //   label: "Rust",
  //   markers: ["Cargo.toml"],
  //   entryCandidates: ["src/main.rs"],
  //   commands: () => [
  //     { id: "cargo:run", labelKey: "run.rust.run", labelFallback: "Run", cmd: "cargo run" },
  //     { id: "cargo:test", labelKey: "run.rust.test", labelFallback: "Test", cmd: "cargo test" },
  //   ],
  // },
  // {
  //   id: "python",
  //   label: "Python",
  //   markers: ["pyproject.toml", "requirements.txt"],
  //   entryCandidates: ["main.py", "app.py"],
  //   commands: (ctx) => (ctx.entry ? [{ id: "py:run", labelKey: null, labelFallback: "Run", cmd: `python ${ctx.entry}` }] : []),
  // },
];
