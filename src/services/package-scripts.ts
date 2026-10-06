/**
 * package.json scripts 行定位 (src/services/package-scripts.ts)
 *
 * 职责：从 package.json 文本中找出 scripts 各条目所在的 1 基行号，
 *   供预览区在对应行旁渲染「运行」图标（对标 IDEA editor gutter 的 npm script 运行按钮：
 *   https://www.jetbrains.com/help/idea/installing-and-removing-external-software-using-node-package-manager.html
 *   「click in the gutter next to the script, and select Run <script_name>」）。
 *
 * 设计要点（KISS / DRY / 可单测）：
 *   - 纯函数，不触碰 DOM。
 *   - 只返回 { name, line }：命令对象由调用方按 name 到已识别的命令列表里查（id = `npm:<name>`），
 *     避免在此重复实现命令生成逻辑。
 *   - 单行 JSON（整个 package.json 写在一行）无法在「某一行旁」放图标，返回空数组。
 */

/** scripts 对象的字符区间（下标均为 package.json 全文的 0 基偏移）。 */
export type ScriptsBlockRange = {
  /** `{` 之后的第一个字符下标。 */
  start: number;
  /** 与之匹配的 `}` 下标。 */
  end: number;
};

/** 一条 npm script 在 package.json 中的位置。 */
export type ScriptLine = {
  /** 脚本名，已还原 JSON 转义；调用方按 `npm:<name>` 去命令列表里取命令对象。 */
  name: string;
  /** 该条目所在行的 1 基行号，用于在行旁 gutter 渲染运行图标。 */
  line: number;
};

/**
 * 定位 scripts 对象的内容区间。
 * @description 从 `"scripts"\s*:\s*\{` 之后开始做字符级深度扫描，跳过字符串内容，
 *   返回与之匹配的 `}` 位置。
 * @param raw package.json 文本
 * @returns 内容区间；未找到返回 null
 */
function scanScriptsBlock(raw: string): ScriptsBlockRange | null {
  const match = /"scripts"\s*:\s*\{/.exec(raw);
  if (!match) return null;
  const start = match.index + match[0].length;
  let depth = 1;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: i };
    }
  }
  return null;
}

/**
 * 找出 package.json 中 scripts 各条目的 1 基行号。
 * @param text package.json 文本；实现按 `text == null` 容错，宿主读文件失败时确实会传进来 null
 * @returns 按出现顺序返回；非 JSON / 无 scripts / 单行 JSON 返回 []
 */
export function findScriptLines(text: string | null): ScriptLine[] {
  const raw = String(text == null ? "" : text);
  if (!raw) return [];
  const block = scanScriptsBlock(raw);
  if (!block) return [];

  // 定位 block.start 所在行与行内偏移：直接数 raw 前缀里的换行符。
  // 原先按「各行长度 + 1」累加，CRLF 文件每行少算一个 \r，落点会漂到后面一行，
  // 于是 scripts 的第一条被当成 `{` 所在行吃掉（Windows 检出必现）。
  const lines = raw.split(/\r\n|\r|\n/);
  const head = raw.slice(0, block.start);
  const firstLine = (head.match(/\r\n|\r|\n/g) || []).length;
  const lastBreak = Math.max(head.lastIndexOf("\n"), head.lastIndexOf("\r"));
  const firstOffset = lastBreak < 0 ? block.start : block.start - lastBreak - 1;

  const out = [];
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = firstLine; i < lines.length; i += 1) {
    const lineText = lines[i];
    const from = i === firstLine ? firstOffset : 0;
    // 行首位于 scripts 对象顶层（depth === 0）时，尝试匹配 `"name": "cmd"`
    if (depth === 0) {
      const matched = /^\s*"((?:[^"\\]|\\.)*)"\s*:\s*"(?:[^"\\]|\\.)*"\s*,?\s*$/.exec(lineText.slice(from));
      if (matched) out.push({ name: matched[1].replace(/\\(.)/g, "$1"), line: i + 1 });
    }
    for (let j = from; j < lineText.length; j += 1) {
      const ch = lineText[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        if (depth === 0) return out; // scripts 对象闭合
        depth -= 1;
      }
    }
  }
  return out;
}
