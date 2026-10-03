/**
 * 代码生成器：从权威数据源产出两个「禁止手改」的生成文件
 *
 *   node tools/generate.mjs
 *
 * 产出：
 *   1. src/components/prism-langs.js —— Prism 全量语言注册 + 扩展名映射
 *      数据源：node_modules/prismjs/components.json（Prism 官方清单，权威）
 *   2. src/icons/icon-data.js —— Material Icon Theme 彩色文件图标数据
 *      数据源：node_modules/material-icon-theme/dist/material-icons.json（VSCode 官方图标主题，权威）
 *
 * 升级 prismjs / material-icon-theme 依赖后重新运行本脚本即可同步。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const write = (p, s) => fs.writeFileSync(path.join(ROOT, p), s);

const normList = (v) =>
  (v == null ? [] : Array.isArray(v) ? v : String(v).split(","))
    .map((s) => String(s).trim())
    .filter(Boolean);

// ---------------------------------------------------------------- prism 语言
const cj = JSON.parse(read("node_modules/prismjs/components.json"));
const L = cj.languages;
const ids = Object.keys(L).filter((k) => k !== "meta");

// prism 核心已内置的语言，无需再 import（重复定义会报错）
const CORE = ["markup", "css", "clike", "javascript"];

// components.json 的键序不是拓扑序（存在 26 处依赖倒序），必须拓扑排序
const deps = {};
for (const id of ids) deps[id] = normList(L[id].require).filter((r) => L[r]);
const ordered = [];
const seen = {};
const visit = (id) => {
  if (seen[id]) return;
  seen[id] = 1;
  for (const d of deps[id]) visit(d);
  seen[id] = 2;
  ordered.push(id);
};
for (const id of ids) visit(id);
const toImport = ordered.filter((id) => !CORE.includes(id));

// 扩展名 / 别名 → prism 语言名
const extMap = {};
for (const id of ids) {
  extMap[id] = id;
  for (const a of normList(L[id].alias)) extMap[a] = id;
}
extMap.html = "markup";
extMap.xml = "markup";
extMap.svg = "markup";
extMap.js = "javascript";
// 真实文件名习惯补充
Object.assign(extMap, {
  h: "c", hpp: "cpp", cc: "cpp", cxx: "cpp", "c++": "cpp", hxx: "cpp", "h++": "cpp",
  mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript",
  jsonc: "json", json5: "json", jsonl: "json", webmanifest: "json",
  scss: "css", sass: "css", less: "less", styl: "css", pcss: "css", postcss: "css",
  htm: "markup", xhtml: "markup", vue: "markup", astro: "markup", svelte: "markup",
  yml: "yaml", pyw: "python", pyi: "python", ipynb: "json",
  rb: "ruby", erb: "erb", rs: "rust", kt: "kotlin", kts: "kotlin",
  md: "markdown", mdx: "markdown", mkd: "markdown",
  sh: "bash", zsh: "bash", fish: "bash", ksh: "bash", ps1: "powershell", psm1: "powershell",
  bat: "batch", cmd: "batch", dockerfile: "docker", makefile: "makefile",
  gql: "graphql", toml: "toml", ini: "ini", cfg: "ini", conf: "ini", properties: "properties",
  tex: "latex", proto: "protobuf", sol: "solidity", rmd: "r",
  tsv: "csv", xlsx: "csv", xls: "csv", env: "bash", gitignore: "git", gitattributes: "git",
});

let prismCode = `/**
 * Prism 全量语言注册模块 (src/components/prism-langs.js)
 * 【生成文件 · 禁止手改】由 tools/generate.mjs 基于 node_modules/prismjs/components.json 产出。
 * 覆盖 prism 全部 ${ids.length} 种语言：核心已内置 ${CORE.join(" / ")}，
 * 其余 ${toImport.length} 种按依赖拓扑序 import（components.json 键序非拓扑序，顺序加载会有 26 处依赖倒序报错）。
 */

import Prism from "prismjs";

`;
for (const id of toImport) prismCode += `import "prismjs/components/prism-${id}.js";\n`;
prismCode += `
/** 文件扩展名 / 语言别名 → prism 语言名 */
export const EXT_TO_PRISM_LANG = ${JSON.stringify(extMap, null, 2)};

export default Prism;
`;
write("src/components/prism-langs.js", prismCode);

// ---------------------------------------------------------------- 文件图标
// 数据源：material-icon-theme 官方数据（VSCode 官方文件图标主题）
const MIT_DIR = "node_modules/material-icon-theme";
const mj = JSON.parse(read(`${MIT_DIR}/dist/material-icons.json`));

const iconExt = mj.fileExtensions || {};
const iconName = mj.fileNames || {};

// 收集被引用的图标 id（按需裁剪，避免内联全部 1128 个 SVG 造成体积浪费）
const iconIds = new Set(Object.values(iconExt));
for (const v of Object.values(iconName)) iconIds.add(v);
const ICON_FILE = mj.file || "file";
const ICON_FOLDER = mj.folder || "folder";
const ICON_FOLDER_OPEN = mj.folderExpanded || "folder-open";
iconIds.add(ICON_FILE);
iconIds.add(ICON_FOLDER);
iconIds.add(ICON_FOLDER_OPEN);

// 读取并压缩 SVG（去换行、压缩标签间空白）
// 文件夹图标统一为黄色：material-icon-theme 通用 folder/folder-open 默认是灰蓝 #90a4ae，
// 这里在生成阶段统一改色（不手改 dist，也不依赖 CSS 覆盖 SVG 内联 fill）。
const FOLDER_FILL = "#ffca28";
const folderIconIds = new Set([ICON_FOLDER, ICON_FOLDER_OPEN]);

const iconSvgs = {};
let iconMissing = 0;
for (const id of iconIds) {
  const def = mj.iconDefinitions[id];
  if (!def) {
    iconMissing++;
    continue;
  }
  const rel = path.join(MIT_DIR, "dist", def.iconPath.replace(/^\.\//, ""));
  if (!fs.existsSync(path.join(ROOT, rel))) {
    iconMissing++;
    continue;
  }
  let svg = read(rel).replace(/\r?\n/g, "").replace(/>\s+</g, "><").trim();
  if (folderIconIds.has(id)) {
    svg = svg.replace(/fill="#[0-9a-fA-F]{3,8}"/g, `fill="${FOLDER_FILL}"`);
  }
  iconSvgs[id] = svg;
}

let iconCode = `/**
 * Material Icon Theme 彩色文件图标数据 (src/icons/icon-data.js)
 * 【生成文件 · 禁止手改】由 tools/generate.mjs 基于 material-icon-theme 官方数据产出。
 * ${Object.keys(iconSvgs).length} 个彩色 SVG 图标（VSCode 官方文件图标主题），
 * 含 ${Object.keys(iconExt).length} 条扩展名映射与 ${Object.keys(iconName).length} 条特殊文件名映射。
 */

export const FILE = ${JSON.stringify(ICON_FILE)};
export const FOLDER = ${JSON.stringify(ICON_FOLDER)};
export const FOLDER_OPEN = ${JSON.stringify(ICON_FOLDER_OPEN)};

/** 扩展名（小写，不含点）→ 图标 id */
export const EXT_ICONS = ${JSON.stringify(iconExt)};

/** 完整文件名（小写）→ 图标 id */
export const NAME_ICONS = ${JSON.stringify(iconName)};

/** 图标 id → 压缩后的 SVG 字符串 */
export const ICON_SVGS = ${JSON.stringify(iconSvgs)};
`;
write("src/icons/icon-data.js", iconCode);

console.log("✅ 已生成:");
console.log(`   src/components/prism-langs.js  (${ids.length} 语言, import ${toImport.length}, 映射 ${Object.keys(extMap).length} 条)`);
console.log(`   src/icons/icon-data.js         (彩色图标 ${Object.keys(iconSvgs).length}, 扩展名 ${Object.keys(iconExt).length}, 文件名 ${Object.keys(iconName).length}, 缺失 ${iconMissing})`);
