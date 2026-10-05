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
  const resolved = family || detectShellFamilyByName(shellPath);
  return resolved === "powershell" ? "exit $LASTEXITCODE" : "exit";
}

/**
 * 按可执行文件名推断 shell 家族（与宿主 native `detect_shell_family` 的规则对齐）。
 * @param {string} shellPath shell 可执行文件路径
 * @returns {string} powershell | cmd | wsl | gitbash | posix
 */
function detectShellFamilyByName(shellPath) {
  const name = String(shellPath || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .toLowerCase();
  if (/pwsh|powershell/.test(name)) return "powershell";
  if (/cmd/.test(name)) return "cmd";
  if (/wsl/.test(name)) return "wsl";
  if (/git/.test(name) && /(bash|sh)/.test(name)) return "gitbash";
  return "posix";
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
 * 脚本文件扩展名 → 运行它所需的 shell 家族。
 * @description bat/cmd 只能由 cmd 跑；ps1 只能由 powershell 跑；sh 需要 POSIX 兼容 shell
 *   （posix / gitbash / wsl）。family 是「能力」而非具体程序：任一 gitbash 都能跑 sh。
 */
const SCRIPT_EXTENSION_FAMILY = {
  bat: ["cmd"],
  cmd: ["cmd"],
  ps1: ["powershell"],
  sh: ["posix", "gitbash", "wsl"],
};

/** 扩展名 → 所需 shell 家族的展示名（提示文案用）。 */
const SCRIPT_FAMILY_LABEL = { cmd: "cmd", powershell: "PowerShell", posix: "sh", gitbash: "sh", wsl: "sh" };

/** 取脚本文件扩展名（小写，不含点）；无扩展名返回空串。 */
function scriptExtension(sourcePath) {
  const name = String(sourcePath || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** 在检测到的终端里挑出第一个家族匹配项。 */
function pickTerminalByFamilies(terminals, families) {
  for (const family of families) {
    const hit = terminals.find((item) => item && item.family === family && item.path);
    if (hit) return hit;
  }
  return null;
}

/**
 * 为一个脚本文件解析运行它所需的 shell。
 *
 * @description 脚本必须由**对应类型的解释器**执行（bat→cmd、ps1→powershell、sh→POSIX），
 *   不能用默认 shell 硬跑。返回的 shellPath 是「解释器本身」（ptyCreate 用它启动），
 *   runCommand 是要在该 shell 里敲入的执行行。
 *   解析顺序：用户显式配置的终端 shell（若类型匹配）→ 系统检测到的同类型终端 → 找不到则不支持。
 * @param {string} sourcePath 脚本文件绝对路径（据扩展名判定类型）
 * @returns {Promise<{supported: boolean, shellPath?: string, family?: string, runCommand?: string, exitCommand?: string, extension?: string, requiredLabel?: string}>}
 */
export async function resolveScriptShell(sourcePath) {
  const extension = scriptExtension(sourcePath);
  const families = SCRIPT_EXTENSION_FAMILY[extension];
  if (!families) return { supported: false, extension };
  const requiredLabel = SCRIPT_FAMILY_LABEL[families[0]];

  const snow = getSnow();
  // 用脚本所在目录的相对路径（cwd 即脚本目录）：cmd/ps 用 .\，POSIX 用 ./——
  // 避免把 Windows 绝对路径喂给 git-bash 导致无法解析。
  const baseName = String(sourcePath || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop();
  const runCommandFor = (family) => {
    if (family === "powershell") return `& ".\\${baseName}"`;
    if (family === "cmd") return `".\\${baseName}"`;
    return `"./${baseName}"`;
  };

  let terminals = [];
  try {
    if (snow && typeof snow.detectTerminals === "function") {
      const detected = await snow.detectTerminals();
      terminals = Array.isArray(detected) ? detected : [];
    }
  } catch {
    terminals = [];
  }

  // 1) 用户显式配置的终端 shell：类型匹配才用它跑脚本，否则继续找系统里的同类型终端。
  try {
    if (snow && typeof snow.getSystemSettingValue === "function") {
      const raw = await snow.getSystemSettingValue(TERMINAL_SETTING_CODE);
      const configured = raw ? (JSON.parse(raw) || {}).shellPath : "";
      if (typeof configured === "string" && configured.trim()) {
        const family = detectShellFamilyByName(configured);
        if (families.includes(family)) {
          return { supported: true, shellPath: configured, family, runCommand: runCommandFor(family), exitCommand: shellExitCommand(family), extension };
        }
      }
    }
  } catch {
    // 终端设置缺失 / 非法：继续用系统检测结果。
  }

  // 2) 系统检测到的同类型终端。
  const hit = pickTerminalByFamilies(terminals, families);
  if (hit) {
    const family = hit.family;
    return { supported: true, shellPath: hit.path, family, runCommand: runCommandFor(family), exitCommand: shellExitCommand(family), extension };
  }

  // 3) 找不到能跑该脚本的 shell：明确不支持。
  return { supported: false, extension, requiredLabel };
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
