/**
 * 终端会话服务 (src/services/terminal-runner.js)
 *
 * 把宿主暴露的 window.snow 无头 PTY 能力封装成「交互式终端会话」的最小契约：
 *   建终端 → 双向读写 → resize → 关闭。
 *
 * 与旧版（已废弃的一次性命令回显）的关键差异：
 *   - 不再净化 ANSI、不再累积/裁剪输出字符串：输出**原样**交给 xterm 渲染
 *     （ANSI 颜色/光标由 xterm 解析，`ls --color`、进度条、TUI 都能正常显示）。
 *   - 不再写入 `exit`：会话是**常驻交互 shell**，用户可以连续敲命令（真终端语义）。
 *   - 暴露 write / resize：键盘输入与窗口尺寸变化能真正到达 shell。
 *
 * 宿主能力缺失时返回 { ok:false, error }，绝不抛出，调用方无需 try/catch。
 */

/** 默认伪终端尺寸（宿主 ptyCreate 的 cols/rows 为必填，缺失会抛参数错误）。 */
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

/**
 * 按 shell 家族给出「命令结束后退出 shell」的写法。
 *
 * @description 关键实测（本机 pwsh 7.6 / cmd，Windows）：
 *   - pwsh 裸 `exit` 恒返回 0，**不**继承上一条命令的退出码 → 必须 `exit $LASTEXITCODE`
 *     （`$LASTEXITCODE` 为 null 时该写法安全地得到 0，不报错）。
 *   - cmd 裸 `exit` 会继承上一条命令的退出码。
 *   - POSIX sh / bash / zsh / WSL 的 `exit` 继承 `$?`（规范行为）。
 *   因此只有 PowerShell 家族需要显式 `$LASTEXITCODE`，其余一律裸 `exit`。
 *
 * @param {string|null|undefined} family detectTerminals 的 family（powershell|cmd|wsl|posix）或 null
 * @param {string} [shellPath] shell 路径（family 缺失时按文件名兜底判定）
 * @returns {string} 退出指令
 */
export function shellExitCommand(family, shellPath) {
  if (family === "powershell") return "exit $LASTEXITCODE";
  if (family) return "exit";
  const name = String(shellPath || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .toLowerCase()
    .replace(/\.exe$/, "");
  return /^(pwsh|powershell)$/.test(name) ? "exit $LASTEXITCODE" : "exit";
}

/**
 * 读取宿主 window.snow（插件 ESM 在主世界执行，可直接访问）。
 * @returns {Object|null}
 */
function getSnow() {
  return typeof window !== "undefined" && window.snow ? window.snow : null;
}

/** 宿主终端设置的系统设置码（与宿主 TERMINAL_SETTING_CODE 同源）。 */
export const TERMINAL_SETTING_CODE = "terminal_settings";

/**
 * 解析模式 A 使用的 shell 与退出写法。
 *
 * @description 与宿主**同源**的解析链（见 snow-app useTerminalMcpCommandBridge.ts:93-100）：
 *   终端设置 `terminal_settings.shellPath` > `detectTerminals()[0]` > 宿主默认检测（传 undefined）。
 *   不写死 shell，从而兼容 Windows / macOS / Linux，并尊重用户在终端设置里配置的 shell。
 *   任一宿主查询缺失 / 失败都静默降级（该级视为未配置），绝不抛错。
 * @returns {Promise<{shellPath: string|undefined, exitCommand: string}>}
 */
export async function resolveRunShell() {
  const snow = getSnow();
  if (!snow) return { shellPath: undefined, exitCommand: "exit" };

  // 1) 终端设置里的 shellPath（用户显式配置，优先级最高）
  let configured = "";
  try {
    if (typeof snow.getSystemSettingValue === "function") {
      const raw = await snow.getSystemSettingValue(TERMINAL_SETTING_CODE);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.shellPath === "string") configured = parsed.shellPath.trim();
      }
    }
  } catch {
    // 终端设置缺失 / JSON 非法：降级到系统检测。
  }
  if (configured) return { shellPath: configured, exitCommand: shellExitCommand(null, configured) };

  // 2) 系统检测的第一个终端（跨平台，宿主 native.detectTerminals）
  let detected;
  try {
    if (typeof snow.detectTerminals === "function") detected = await snow.detectTerminals();
  } catch {
    // 检测失败：交给宿主默认检测（shellPath 传 undefined）。
  }
  const first = Array.isArray(detected) ? detected[0] : null;
  if (first && first.path) {
    return { shellPath: first.path, exitCommand: shellExitCommand(first.family, first.path) };
  }
  return { shellPath: undefined, exitCommand: "exit" };
}

/**
 * 当前宿主是否提供完整的终端能力。
 * @description 事件订阅只能走 window.snow（插件 api 未暴露事件），故一并校验；
 *   resize 是交互终端必需（ConPTY 靠它正确换行/重绘），缺失则视为能力不完整；
 *   getSystemSettingValue 用于读取终端设置里的 shellPath，缺失则退回系统检测默认。
 * @returns {boolean}
 */
export function isTerminalAvailable() {
  const snow = getSnow();
  return !!(
    snow &&
    typeof snow.ptyCreate === "function" &&
    typeof snow.ptyWrite === "function" &&
    typeof snow.ptyResize === "function" &&
    typeof snow.ptyKill === "function" &&
    typeof snow.onPtyOutput === "function" &&
    typeof snow.onPtyExit === "function" &&
    typeof snow.getSystemSettingValue === "function"
  );
}

/**
 * 创建一个交互式终端会话。
 * @param {Object} [options]
 * @param {string} [options.cwd] 工作目录
 * @param {number} [options.cols] 伪终端列数
 * @param {number} [options.rows] 伪终端行数
 * @param {string} [options.shellPath] 指定 shell（省略则宿主按默认检测）
 * @param {(data: string) => void} [options.onData] 原始输出回调（含 ANSI，交给 xterm）
 * @param {(exitCode: number|null) => void} [options.onExit] 进程退出回调（真值来源）
 * @returns {Promise<{ok: boolean, ptyId?: string, write?: Function, resize?: Function, kill?: Function, error?: string}>}
 */
export async function createPtySession(options = {}) {
  const { cwd = "", cols = DEFAULT_COLS, rows = DEFAULT_ROWS, shellPath, onData, onExit } = options;

  const snow = getSnow();
  if (!isTerminalAvailable()) return { ok: false, error: "当前宿主未提供终端能力" };

  let ptyId;
  try {
    ptyId = await snow.ptyCreate(shellPath ? { cwd, cols, rows, shellPath } : { cwd, cols, rows });
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
  if (!ptyId) return { ok: false, error: "终端创建失败" };

  let finished = false;
  // 先订阅输出/退出再返回：调用方拿到会话即可写入，不会漏掉首批输出。
  const offOutput = snow.onPtyOutput((payload) => {
    if (!payload || payload.id !== ptyId || finished) return;
    if (typeof onData === "function") onData(payload.data);
  });
  const offExit = snow.onPtyExit((payload) => {
    if (!payload || payload.id !== ptyId) return;
    finish(typeof payload.exitCode === "number" ? payload.exitCode : null);
  });

  /** 退订：进程结束后必须释放，否则长会话会不断累积回调。 */
  function cleanup() {
    if (typeof offOutput === "function") offOutput();
    if (typeof offExit === "function") offExit();
  }
  /** 收尾：保证 onExit 只回调一次（kill 与真实退出事件可能同时到达）。 */
  function finish(exitCode) {
    if (finished) return;
    finished = true;
    cleanup();
    if (typeof onExit === "function") onExit(exitCode);
  }

  return {
    ok: true,
    ptyId,
    /** 把键盘输入原样写入 shell（含控制字符，如 Ctrl+C 的 \x03）。 */
    write(data) {
      if (finished) return;
      try {
        snow.ptyWrite(ptyId, String(data));
      } catch {
        // 忽略：进程可能已退出
      }
    },
    /** 通知 shell 终端尺寸变化（ConPTY 需要它才能正确换行与重绘）。 */
    resize(nextCols, nextRows) {
      if (finished) return;
      try {
        snow.ptyResize(ptyId, nextCols, nextRows);
      } catch {
        // 忽略：进程可能已退出
      }
    },
    /** 关闭会话：kill 后立即收尾（若宿主未派发 onPtyExit，状态也不会悬空）。 */
    kill() {
      if (finished) return;
      try {
        snow.ptyKill(ptyId);
      } catch {
        // 忽略：进程可能已自然退出
      }
      finish(null);
    },
  };
}
