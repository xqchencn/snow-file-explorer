/**
 * Unified Diff 解析模块 (src/services/diff.js)
 * 将宿主 gitFileDiff 返回的 unified patch 文本解析为结构化 hunk 行，
 * 供插件自实现的轻量 diff 渲染器使用（不引入 @git-diff-view 等重依赖）。
 * 全部为纯函数、无 DOM 依赖，便于单元测试。
 */

/**
 * 解析 hunk 头：`@@ -oldStart[,oldLines] +newStart[,newLines] @@ [section]`
 * @param {string} line 待解析行
 * @returns {{oldStart:number, oldLines:number, newStart:number, newLines:number}|null}
 */
export function parseHunkHeader(line) {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(String(line || ""));
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    // 省略行数时按 unified diff 语义默认为 1
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4]),
  };
}

/**
 * 解析 unified diff 文本
 * @description 仅识别 hunk 及其正文行；文件级头（diff --git / index / --- / +++ /
 *   mode / rename 等）不参与渲染。行号游标按 +/-/空格前缀推进，删除行不占新行号、
 *   新增行不占旧行号，与 unified diff 规范一致。
 * @param {string} patch git diff 原始文本
 * @returns {{hunks:Array, additions:number, deletions:number, isBinary:boolean, hasHunks:boolean, raw:string}}
 */
export function parseUnifiedDiff(patch) {
  const raw = String(patch == null ? "" : patch);
  const result = {
    hunks: [],
    additions: 0,
    deletions: 0,
    isBinary: false,
    hasHunks: false,
    raw,
  };
  if (!raw) return result;

  const lines = raw.split(/\r\n|\r|\n/);
  // split 后若原文以换行结尾会残留一个空串，它不是 diff 内容，直接丢弃
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  let current = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    // 1. 二进制差异：git 不产出 hunk，仅一行说明
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      result.isBinary = true;
      continue;
    }

    // 2. hunk 头：开启新 hunk 并重置行号游标
    const header = parseHunkHeader(line);
    if (header) {
      oldNo = header.oldStart;
      newNo = header.newStart;
      current = { header: line, ...header, lines: [] };
      result.hunks.push(current);
      continue;
    }

    // 3. hunk 之外的文件级头（diff --git / index / --- / +++ / mode 等）忽略
    if (!current) continue;

    // 4. `\ No newline at end of file` 等元信息行，不占行号
    if (line.startsWith("\\")) {
      current.lines.push({ type: "meta", text: line, oldNo: null, newNo: null });
      continue;
    }

    const marker = line.charAt(0);
    if (marker === "+") {
      current.lines.push({ type: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
      result.additions++;
    } else if (marker === "-") {
      current.lines.push({ type: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
      result.deletions++;
    } else if (marker === " ") {
      current.lines.push({ type: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (line === "") {
      // 极少数工具会裁掉上下文行的尾随空格，此处按空上下文行容错
      current.lines.push({ type: "context", text: "", oldNo: oldNo++, newNo: newNo++ });
    } else {
      // 既非 +/-/空格（如仅 mode 变更的说明行）：按元信息保留，不占行号
      current.lines.push({ type: "meta", text: line, oldNo: null, newNo: null });
    }
  }

  result.hasHunks = result.hunks.length > 0;
  return result;
}

/**
 * 将单个 hunk 的行序列配对为 split（左右分栏）行
 * @description 对齐宿主 diff 的 split 视图：
 *   - 上下文行左右同显（同一行内容）；
 *   - 一个变更块内，删除行占左栏、新增行占右栏，按顺序一一配对，
 *     多出的行在对侧留空（`null`）。
 *   unified diff 规范保证同一变更块内先输出全部 `-` 行、再输出全部 `+` 行，
 *   因此顺序收集即可正确配对，无需 LCS 对齐。
 * @param {{lines: Array}} hunk parseUnifiedDiff 的单个 hunk
 * @returns {Array<{left: Object|null, right: Object|null}>} 分栏行（left/right 为解析出的行或 null）
 */
export function buildSplitRows(hunk) {
  const lines = hunk && Array.isArray(hunk.lines) ? hunk.lines : [];
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "del" || line.type === "add") {
      const dels = [];
      const adds = [];
      // 收集连续的变更块（删除与新增，不夹上下文行）
      while (i < lines.length && (lines[i].type === "del" || lines[i].type === "add")) {
        if (lines[i].type === "del") dels.push(lines[i]);
        else adds.push(lines[i]);
        i++;
      }
      const n = Math.max(dels.length, adds.length);
      for (let j = 0; j < n; j++) {
        rows.push({ left: dels[j] || null, right: adds[j] || null });
      }
      continue;
    }
    // 上下文行与元信息行：左右同显
    rows.push({ left: line, right: line });
    i++;
  }
  return rows;
}

/**
 * 将 unified diff 差异数据与新版本文件的完整内容合成为全文件差异数据 (Full File Diff)
 * @description 解决仅显示截断 hunk 片段、无法看清文件全貌的问题。
 *   以整份文件的行流为基准：
 *   - hunk 之前的未改动行全部作为 context 行补齐；
 *   - hunk 之间的未改动行全部作为 context 行补齐；
 *   - hunk 之后的未改动行直到文件末尾全部补齐；
 *   - hunk 内部的增删行原样保留并带上对应行号与类型。
 * @param {Object} patchResult parseUnifiedDiff 解析出的差异对象
 * @param {string|null} fullContent 当前新版本文件的完整内容
 * @returns {Array<{type: 'context'|'add'|'del'|'meta', text: string, oldNo: number|null, newNo: number|null}>}
 */
export function buildFullFileDiff(patchResult, fullContent) {
  if (!patchResult) return [];
  // 无文本 hunk 时（如纯新增空文件或无改动），若有 fullContent 则直接全量呈现为 context
  if (!patchResult.hasHunks) {
    if (typeof fullContent === "string" && fullContent.length > 0) {
      const lines = fullContent.split(/\r\n|\r|\n/);
      return lines.map((text, idx) => ({
        type: "context",
        text,
        oldNo: idx + 1,
        newNo: idx + 1,
      }));
    }
    return [];
  }

  // 纯删除文件（fullContent 为空，改动全为删除）时直接展平所有 hunk 的行
  if (typeof fullContent !== "string" || fullContent.length === 0) {
    const lines = [];
    for (const hunk of patchResult.hunks) {
      lines.push(...hunk.lines);
    }
    return lines;
  }

  const fileLines = fullContent.split(/\r\n|\r|\n/);
  const fullLines = [];
  let curNewNo = 1;
  let curOldNo = 1;

  for (const hunk of patchResult.hunks) {
    const hunkNewStart = Number(hunk.newStart || 1);
    const hunkOldStart = Number(hunk.oldStart || 1);

    // 1. 补齐当前游标到 hunk 开头之间的所有未改动上下文行
    while (curNewNo < hunkNewStart && curNewNo <= fileLines.length) {
      fullLines.push({
        type: "context",
        text: fileLines[curNewNo - 1] ?? "",
        oldNo: curOldNo,
        newNo: curNewNo,
      });
      curOldNo++;
      curNewNo++;
    }

    // 2. 将游标对齐到当前 hunk 的起点（处理初始偏移或跨块调整）
    curOldNo = hunkOldStart;
    curNewNo = hunkNewStart;

    // 3. 输出当前 hunk 内的全部行
    for (const line of hunk.lines) {
      fullLines.push(line);
      if (line.type === "context") {
        curOldNo++;
        curNewNo++;
      } else if (line.type === "del") {
        curOldNo++;
      } else if (line.type === "add") {
        curNewNo++;
      }
    }

    // 4. 游标更新为 hunk 结束后的最新位置
    curOldNo = hunk.oldStart + hunk.oldLines;
    curNewNo = hunk.newStart + hunk.newLines;
  }

  // 5. 补齐最后一个 hunk 之后直至文件末尾的所有未改动上下文行
  while (curNewNo <= fileLines.length) {
    fullLines.push({
      type: "context",
      text: fileLines[curNewNo - 1] ?? "",
      oldNo: curOldNo,
      newNo: curNewNo,
    });
    curOldNo++;
    curNewNo++;
  }

  return fullLines;
}

/**
 * 将全文件差异行列表转换为 split（左右分栏）行列表
 * @param {Array<Object>} fullLines buildFullFileDiff 生成的完整行流
 * @returns {Array<{left: Object|null, right: Object|null}>}
 */
export function buildFullSplitRows(fullLines) {
  return buildSplitRows({ lines: fullLines });
}

/**
 * 统计与 String.split(/\\r\\n|\\r|\\n/) 相同的行数。空字符串为 0。
 * @param {string} text 全文
 * @returns {number}
 */
function countSplitLines(text) {
  if (!text) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 10) count += 1;
    else if (code === 13) {
      count += 1;
      if (text.charCodeAt(i + 1) === 10) i += 1;
    }
  }
  return count;
}

/**
 * 记录每行起点。只在读取某一行时切出那一行的字符串。
 * @param {string} text 全文
 * @returns {number[]}
 */
function buildLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 10) starts.push(i + 1);
    else if (code === 13) {
      if (text.charCodeAt(i + 1) === 10) i += 1;
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * 取出 1-based 行文本，不含行尾换行。
 * @param {string} text 全文
 * @param {number[]} starts 行起点
 * @param {number} lineNumber 行号
 * @returns {string}
 */
function lineTextAt(text, starts, lineNumber) {
  const index = lineNumber - 1;
  if (index < 0 || index >= starts.length) return "";
  const from = starts[index];
  const to = index + 1 < starts.length ? starts[index + 1] : text.length;
  let end = to;
  if (end > from && text.charCodeAt(end - 1) === 10) end -= 1;
  if (end > from && text.charCodeAt(end - 1) === 13) end -= 1;
  return text.slice(from, end);
}

/**
 * 全文件差异的按需访问器。长度与 buildFullFileDiff 一致，但只为当前下标创建行对象。
 * @param {Object|null} patchResult parseUnifiedDiff 的结果
 * @param {string|null} fullContent 新版本全文；空字符串或 null 表示按补丁行展开
 * @param {'unified'|'split'} [mode]
 * @returns {{length: number, hunkStartRow: number[], at: function}}
 */
export function createFullDiffAccess(patchResult, fullContent, mode) {
  const viewMode = mode === "split" ? "split" : "unified";
  const hunks = patchResult && Array.isArray(patchResult.hunks) ? patchResult.hunks : [];
  const text = typeof fullContent === "string" ? fullContent : "";
  const hasText = text.length > 0;
  const segments = [];
  const hunkStartRow = [];
  let length = 0;
  let hunkGroup = [];

  const flushHunkGroup = () => {
    const group = hunkGroup;
    hunkGroup = [];
    if (!group.length) return;
    if (viewMode !== "split") {
      for (const item of group) {
        const count = Array.isArray(item.hunk.lines) ? item.hunk.lines.length : 0;
        hunkStartRow[item.index] = length;
        segments.push({ kind: "hunk", hunk: item.hunk, count });
        length += count;
      }
      return;
    }
    const lines = [];
    const firstLineOffset = [];
    for (const item of group) {
      firstLineOffset.push(lines.length);
      if (Array.isArray(item.hunk.lines)) lines.push(...item.hunk.lines);
    }
    const rows = buildSplitRows({ lines });
    const rowOfLine = new Array(lines.length);
    let cursor = 0;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const cells = row.left === row.right ? [row.left] : [row.left, row.right];
      for (const cell of cells) {
        if (!cell || cursor >= lines.length || lines[cursor] !== cell) continue;
        if (rowOfLine[cursor] === undefined) rowOfLine[cursor] = rowIndex;
        cursor += 1;
      }
    }
    for (let i = 0; i < group.length; i += 1) {
      const lineOffset = firstLineOffset[i];
      hunkStartRow[group[i].index] = length + (rowOfLine[lineOffset] ?? 0);
    }
    segments.push({ kind: "rows", rows, count: rows.length });
    length += rows.length;
  };
  const pushGap = (newFrom, oldFrom, count) => {
    flushHunkGroup();
    if (count <= 0) return;
    segments.push({ kind: "gap", newFrom, oldFrom, count });
    length += count;
  };

  if (!patchResult || !patchResult.hasHunks) {
    if (hasText) pushGap(1, 1, countSplitLines(text));
  } else if (!hasText) {
    hunks.forEach((hunk, index) => hunkGroup.push({ hunk, index }));
    flushHunkGroup();
  } else {
    const lineCount = countSplitLines(text);
    let curNew = 1;
    let curOld = 1;
    hunks.forEach((hunk, index) => {
      const hunkNewStart = Number(hunk.newStart || 1);
      if (curNew < hunkNewStart && curNew <= lineCount) {
        pushGap(curNew, curOld, Math.min(hunkNewStart, lineCount + 1) - curNew);
      }
      hunkGroup.push({ hunk, index });
      curOld = hunk.oldStart + hunk.oldLines;
      curNew = hunk.newStart + hunk.newLines;
    });
    if (curNew <= lineCount) pushGap(curNew, curOld, lineCount - curNew + 1);
    else flushHunkGroup();
  }

  let starts = null;
  const contextLine = (newNo, oldNo) => {
    if (!starts) starts = buildLineStarts(text);
    return { type: "context", text: lineTextAt(text, starts, newNo), oldNo, newNo };
  };
  const locate = (index) => {
    let cursor = 0;
    for (const seg of segments) {
      if (index < cursor + seg.count) return { seg, offset: index - cursor };
      cursor += seg.count;
    }
    return null;
  };

  return {
    length,
    hunkStartRow,
    at(index) {
      const found = locate(index);
      if (!found) return { kind: "line", row: null };
      const { seg, offset } = found;
      if (seg.kind === "rows") return { kind: "line", row: seg.rows[offset] };
      if (seg.kind === "hunk") return { kind: "line", row: seg.hunk.lines[offset] };
      const line = contextLine(seg.newFrom + offset, seg.oldFrom + offset);
      if (viewMode === "split") return { kind: "line", row: { left: line, right: line } };
      return { kind: "line", row: line };
    },
  };
}
