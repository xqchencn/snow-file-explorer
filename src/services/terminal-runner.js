/**
 * 终端运行服务 (src/services/terminal-runner.js)
 *
 * 职责：把宿主暴露的 window.snow 无头 PTY 能力封装成「启动命令 + 订阅输出 + 订阅退出 + 停止」的最小契约。
 *
 * 设计要点（KISS / 容错）：
 *   - 宿主 ptyCreate 的 cols / rows 为必填（缺失会抛参数错误），此处给默认值。
 *   - 先订阅输出/退出事件再写入命令，避免漏掉命令的首批输出。
 *   - onPtyExit 是进程退出的**真值**来源：用户 Ctrl+C、命令跑完、进程崩溃、被 kill 都会命中，
 *     因此调用方拿到的运行状态不是近似值。
 *   - 关键：宿主 ptyCreate 建的是**交互式登录 shell**（未指定 shell 时走 native.detectTerminals），
 *     命令跑完 shell 会停在提示符等待输入、自己不会退出，onPtyExit 永不派发。
 *     因此写入命令时追加一行 `exit`，让 shell 在命令结束后退出，退出事件才会到达。
 *   - 宿主能力缺失时返回 { ok:false, error }，绝不抛出，调用方无需 try/catch。
 *   - 终端输出含 ANSI 颜色/光标转义，插件面板是 <pre> 纯文本渲染，必须先净化。
 */

/** 默认伪终端尺寸（宿主 ptyCreate 的 cols/rows 为必填，缺失会抛参数错误）。 */
export const DEFAULT_COLS = 100;
export const DEFAULT_ROWS = 30;

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

// 用字符串拼接构造 RegExp，规避 ESLint no-control-regex 对正则字面量中控制字符的检查。
// 覆盖三类序列：CSI（颜色/光标）、OSC（标题/超链接）、其余两字符 ESC 序列。
const ANSI_PATTERNS = [
  // CSI：ESC [ 参数 中间 终止
  new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g"),
  // OSC：ESC ] ... (BEL | ESC \)
  new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g"),
  // 其余两字符 ESC 序列
  new RegExp(`${ESC}[@-Z\\-_]`, "g"),
];

/**
 * 把 CSI 序列（ESC [ 参数 中间 终止）按光标语义还原为可读文本。
 * @description 关键：交互式 shell（PSReadLine）重绘整行时发的是「光标定位序列」——
 *   `ESC[<n>G`（移到第 n 列）/`ESC[<r>;<c>H`（移到行列），**不带** \r。旧实现用一条正则
 *   把这些序列整个删掉，于是 N 帧重绘文本被首尾拼接成 `npm run buildnpm run build...`，
 *   用户误以为「同一条命令跑了多次」。此处把「光标定位」还原为 \r（回到本行开头），
 *   再由 overwriteLine 做逐列覆盖，得到该行最终内容；颜色/擦除等其余 CSI 无文本语义，丢弃。
 * @param {string} text 原始文本
 * @returns {string} 已把光标定位转为 \r 的文本
 */
function processCsi(text) {
  const CSI = ESC + "[";
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const idx = text.indexOf(CSI, i);
    if (idx < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, idx);
    let j = idx + 2;
    // 参数字节 0x30-0x3F，中间字节 0x20-0x2F
    while (j < n) {
      const c = text.charCodeAt(j);
      if ((c >= 0x30 && c <= 0x3f) || (c >= 0x20 && c <= 0x2f)) {
        j += 1;
        continue;
      }
      break;
    }
    if (j >= n) break; // 序列不完整：丢弃剩余
    const final = text[j];
    if (final >= "@" && final <= "~") {
      // 光标定位 → 回到本行开头（重绘帧几乎总是整行重写，按行首处理最稳妥）。
      if (final === "G" || final === "`" || final === "H" || final === "f") out += "\r";
      i = j + 1;
    } else {
      // 非法终止符：保留 ESC，避免吞掉后续内容。
      out += ESC;
      i = idx + 1;
    }
  }
  return out;
}

/**
 * 去除 ANSI 转义序列（颜色、光标控制等），保留可读文本。
 * @description 先把 CSI 光标定位还原为 \r，再移除 OSC 与其余两字符 ESC 序列。
 * @param {unknown} text 原始终端输出
 * @returns {string}
 */
export function stripAnsi(text) {
  let out = processCsi(String(text == null ? "" : text));
  for (const pattern of ANSI_PATTERNS) out = out.replace(pattern, "");
  return out;
}

/**
 * 创建有状态的终端输出归一化器。
 * @description 为什么必须有状态：交互式 shell（PSReadLine）重绘整行时发「光标定位 + 整行」，
 *   这一帧可能被 pty 拆到多个事件里。逐 chunk 独立处理会把各帧首尾拼接成
 *   `npm run buildnpm run build…`（用户误以为命令跑了多次）；有状态才能跨 chunk 完成
 *   「光标回行首 + 整行覆盖」，还原出该行的最终内容。
 *   模型：按终端语义维护「当前行 + 光标列」，\r 回列首、\b 退一列、可打印字符按列覆盖；
 *   遇到 \n 才把该行**定稿**并交调用方追加。当前行在 flush() 前不输出。
 * @returns {{push: (raw: unknown) => string, flush: () => string}}
 */
export function createOutputNormalizer() {
  const state = { current: "", col: 0 };

  /** 在光标处写入一个字符（覆盖或追加），并把光标右移一列。 */
  function write(ch) {
    const line = state.current;
    state.current =
      state.col < line.length
        ? line.slice(0, state.col) + ch + line.slice(state.col + 1)
        : line + ch;
    state.col += 1;
  }

  return {
    /**
     * 处理一个原始 chunk，返回「本次定稿（遇到换行）的行」文本，供调用方增量追加。
     * @param {unknown} raw 原始终端输出（含 ANSI）
     * @returns {string} 只含已定稿行；无换行时返回空串
     */
    push(raw) {
      const text = stripAnsi(raw == null ? "" : raw);
      let out = "";
      let i = 0;
      const n = text.length;
      while (i < n) {
        const ch = text[i];
        if (ch === "\n") {
          out += state.current + "\n";
          state.current = "";
          state.col = 0;
          i += 1;
          continue;
        }
        if (ch === "\r") {
          state.col = 0;
          i += 1;
          continue;
        }
        if (ch === "\b") {
          if (state.col > 0) state.col -= 1;
          i += 1;
          continue;
        }
        // 收集一段连续可打印字符（保留 \t），避免逐字符拼接造成的 O(n²)。
        let j = i;
        while (j < n) {
          const c = text[j];
          const code = text.charCodeAt(j);
          if (c === "\n" || c === "\r" || c === "\b") break;
          if (code === 127 || (code < 32 && c !== "\t")) break;
          j += 1;
        }
        const seg = text.slice(i, j);
        if (j === i) {
          // 当前字符是被丢弃的控制字符（无文本语义）：前进一位，否则 i 不前进会死循环。
          i += 1;
          continue;
        }
        if (state.col >= state.current.length) {
          // 行尾追加态（最常见）：整段拼接，O(段长)。
          state.current += seg;
          state.col = state.current.length;
        } else {
          // 覆盖态（重绘帧）：逐字符按列覆盖，段通常很短。
          for (let k = 0; k < seg.length; k += 1) write(seg[k]);
        }
        i = j;
      }
      return out;
    },

    /**
     * 取出尚未定稿的当前行（进程结束时调用），避免丢掉最后一行无换行的输出。
     * @returns {string}
     */
    flush() {
      const line = state.current;
      state.current = "";
      state.col = 0;
      return line;
    },
  };
}

/**
 * 一次性归一化整段终端输出（等价于 createOutputNormalizer().push + flush）。
 * @description 供非流式场景与单测使用；流式场景请用 createOutputNormalizer 保留跨 chunk 状态。
 * @param {unknown} text 原始终端输出
 * @returns {string}
 */
export function normalizeOutput(text) {
  const normalizer = createOutputNormalizer();
  return normalizer.push(text) + normalizer.flush();
}

/**
 * 读取宿主 window.snow（插件 ESM 在主世界执行，可直接访问）。
 * @returns {Object|null}
 */
function getSnow() {
  return typeof window !== "undefined" && window.snow ? window.snow : null;
}

/**
 * 当前宿主是否提供完整的终端能力。
 * @description 事件订阅只能走 window.snow（插件 api 未暴露事件），故一并校验。
 * @returns {boolean}
 */
export function isTerminalAvailable() {
  const snow = getSnow();
  return !!(
    snow &&
    typeof snow.ptyCreate === "function" &&
    typeof snow.ptyWrite === "function" &&
    typeof snow.ptyKill === "function" &&
    typeof snow.onPtyOutput === "function" &&
    typeof snow.onPtyExit === "function"
  );
}

/**
 * 启动一条命令并订阅其输出与退出。
 * @param {string} command 命令行（如 `npm run dev`）
 * @param {Object} [options]
 * @param {string} [options.cwd] 工作目录
 * @param {number} [options.cols] 伪终端列数
 * @param {number} [options.rows] 伪终端行数
 * @param {(text: string) => void} [options.onData] 已净化的输出回调
 * @param {(exitCode: number|null, stopped: boolean) => void} [options.onExit] 进程退出回调（真值来源；stopped 表示是否由用户主动停止）
 * @returns {Promise<{ok: boolean, ptyId?: string, stop?: () => void, error?: string}>}
 */
export async function startCommand(command, options = {}) {
  const cmd = String(command == null ? "" : command).trim();
  if (!cmd) return { ok: false, error: "命令为空" };

  const snow = getSnow();
  if (!isTerminalAvailable()) return { ok: false, error: "当前宿主未提供终端能力" };

  const {
    cwd = "",
    cols = DEFAULT_COLS,
    rows = DEFAULT_ROWS,
    onData,
    onExit,
  } = options;

  let ptyId;
  try {
    ptyId = await snow.ptyCreate({ cwd, cols, rows });
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
  if (!ptyId) return { ok: false, error: "终端创建失败" };

  let finished = false;
  // 是否由用户主动停止：onExit 的第二参数据此让 UI 区分「已停止」与「已退出」。
  let stopRequested = false;
  // 本 pty 的有状态归一化器：跨 chunk 完成「光标回行首 + 整行覆盖」，
  // 否则 shell 的整行重绘帧会被拆到多个事件里、各自定稿后首尾拼接成重复命令。
  const normalizer = createOutputNormalizer();
  const emit = (text) => {
    if (text && typeof onData === "function") onData(text);
  };
  const offOutput =
    typeof snow.onPtyOutput === "function"
      ? snow.onPtyOutput((payload) => {
          if (!payload || payload.id !== ptyId) return;
          emit(normalizer.push(payload.data));
        })
      : null;
  const offExit =
    typeof snow.onPtyExit === "function"
      ? snow.onPtyExit((payload) => {
          if (!payload || payload.id !== ptyId) return;
          finish(typeof payload.exitCode === "number" ? payload.exitCode : null);
        })
      : null;

  // 退订：进程结束后必须释放，否则长会话会不断累积回调。
  const cleanup = () => {
    if (typeof offOutput === "function") offOutput();
    if (typeof offExit === "function") offExit();
  };
  // 收尾：保证 onExit 只回调一次（kill 与真实退出事件可能同时到达）。
  function finish(exitCode) {
    if (finished) return;
    finished = true;
    cleanup();
    // 进程结束时把未定稿的当前行取出，避免丢掉最后一行无换行的输出。
    emit(normalizer.flush());
    if (typeof onExit === "function") onExit(exitCode, stopRequested);
  }

  // 追加一行 exit：命令结束后 shell 立即退出，pty:exit 正常派发，UI 才会从「运行中」变为真值。
  // 长跑进程（如 dev server）运行期间 shell 不会读取该行，「运行中」状态不受影响。
  try {
    await snow.ptyWrite(ptyId, cmd + "\rexit\r");
  } catch (err) {
    cleanup();
    try {
      snow.ptyKill(ptyId);
    } catch {
      // 忽略：清理失败不应掩盖原始错误
    }
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }

  return {
    ok: true,
    ptyId,
    stop() {
      if (finished) return;
      stopRequested = true;
      try {
        snow.ptyKill(ptyId);
      } catch {
        // 忽略：进程可能已自然退出
      }
      // 兜底：若宿主 kill 后未派发 onPtyExit，也立即收尾并退订。
      finish(null);
    },
  };
}
