/**
 * 终端会话服务 (src/services/terminal-runner.ts)
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

/**
 * 宿主原始 PTY 通道在本模块里的可见形状。
 */
import type { SnowApi } from "../types/snow-api.ts";
import type { DetectedTerminal } from "../types/host/host-settings.ts";

/** 默认伪终端尺寸（宿主 ptyCreate 的 cols/rows 为必填，缺失会抛参数错误）。 */
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

/**
 * shell 家族：宿主 `DetectedTerminal.family` 声明的 powershell / cmd / wsl / posix，
 * 加上本模块按可执行文件名兜底判出的 gitbash。
 * @description gitbash 不是本模块自创：宿主 native 层就产出它
 *   （snow-app `native/src/api/conversation/context.rs:474` 把家族列为
 *   powershell / cmd / gitbash / wsl / posix，`native/src/exports/terminal.rs` 实现 Git Bash 探测），
 *   而宿主 preload 类型 `src/preload/types/settings.ts:169` 只列了四值，
 *   宿主自己的 `src/main/native/types.ts:1648` 又写成 `family: string`——两处不一致，
 *   以 native 实际取值为准。
 */
export type ShellFamily = "powershell" | "cmd" | "wsl" | "gitbash" | "posix";

/**
 * 宿主 `detectTerminals` 返回的终端项在本模块眼里的形状。
 * @description 宿主那份 `DetectedTerminal` 的 family 是四值联合，不含 gitbash，
 *   而实测（以及本模块的脚本解释器匹配）会把 gitbash 当独立家族，故此处按字符串收口。
 */
export type RuntimeTerminal = {
  /** 终端展示名（如 "Git Bash"）；只用于提示文案，不参与匹配。 */
  name?: string;
  /** shell 可执行文件绝对路径；缺失的条目会被跳过。 */
  path: string;
  /** shell 家族（取值见 ShellFamily）；宿主未提供时按字符串透传，交给文件名兜底判定。 */
  family?: string;
};

/**
 * 模式 A 解析出的运行 shell。
 */
export type ResolvedRunShell = {
  /** 要显式传给 ptyCreate 的 shell 路径；undefined 表示交给宿主默认检测。 */
  shellPath: string | undefined;
  /** 命令跑完后要敲的退出指令（PowerShell 家族需 `exit $LASTEXITCODE` 才能带上退出码）。 */
  exitCommand: string;
};

/**
 * `createPtySession` 的入参：全部可缺，缺省走默认尺寸与宿主默认 shell。
 */
export type PtySessionOptions = {
  /** PTY 工作目录（绝对路径）；缺省空串，由宿主按进程默认目录处理。 */
  cwd?: string;
  /** 伪终端列数；缺省 DEFAULT_COLS。 */
  cols?: number;
  /** 伪终端行数；缺省 DEFAULT_ROWS。 */
  rows?: number;
  /** 指定 shell 可执行文件；省略时宿主按终端设置解析默认 shell。 */
  shellPath?: string;
  /** 原始输出回调（含 ANSI，需直接喂给 xterm，不做行切分）。 */
  onData?: (data: string) => void;
  /** 进程退出回调；exitCode 为 null 表示由本插件主动 kill、拿不到真实退出码。 */
  onExit?: (exitCode: number | null) => void;
};

/**
 * `createPtySession` 的结果：成功时带 PTY id 与三个会话方法，失败时只有 error。
 */
export type PtySessionResult = {
  /** 会话是否创建成功；false 时 write / resize / kill 均缺失。 */
  ok: boolean;
  /** 宿主 PTY 进程 id；仅成功时存在。 */
  ptyId?: string;
  /** 失败原因文本；仅 ok 为 false 时存在。 */
  error?: string;
  /** 向 shell 写入输入（含控制字符，如 Ctrl+C）；成功会话才提供。 */
  write?: (data: string) => void;
  /** 把终端尺寸同步给 PTY（ConPTY 依赖它正确换行与重绘）；成功会话才提供。 */
  resize?: (cols: number, rows: number) => void;
  /** 结束会话并触发一次 onExit(null)；成功会话才提供。 */
  kill?: () => void;
};

/**
 * 脚本文件运行方案的解析结果（`resolveScriptShell`）。
 */
export type ScriptShellResolution = {
  /** 是否找到能跑该脚本的解释器；false 时调用方应提示用户而不是硬跑。 */
  supported: boolean;
  /** 解释器可执行文件路径（作为 ptyCreate 的 shellPath）；supported 为 false 时缺失。 */
  shellPath?: string;
  /** 命中的 shell 家族（取值见 ShellFamily）；supported 为 false 时缺失。 */
  family?: string;
  /** 要在该 shell 里敲的执行行（按家族选 `.\` 或 `./` 前缀）；supported 为 false 时缺失。 */
  runCommand?: string;
  /** 执行完后让 shell 退出的写法；supported 为 false 时缺失。 */
  exitCommand?: string;
  /** 脚本扩展名（小写、不含点）；始终存在，供提示文案使用。 */
  extension?: string;
  /** 所需 shell 家族的展示名（如 sh / PowerShell）；仅不支持时存在。 */
  requiredLabel?: string;
};

/**
 * catch 到的失败对象的可窄化形状。
 * @description 宿主 IPC 失败既可能是 Error，也可能是带 message 的普通对象，
 *   故只声明 message，且允许缺失（用 `String(err)` 兜底）。
 */
type ErrorWithMessage = {
  /** 失败原因文本；非 Error 的失败对象可能没有这个字段。 */
  message?: string;
};

/**
 * 按 shell 家族给出「命令结束后退出 shell」的写法。
 *
 * @description 关键实测（本机 pwsh 7.6 / cmd，Windows）：
 *   - pwsh 裸 `exit` 恒返回 0，**不**继承上一条命令的退出码 → 必须 `exit $LASTEXITCODE`
 *     （`$LASTEXITCODE` 为 null 时该写法安全地得到 0，不报错）。
 *   - cmd 裸 `exit` 会继承上一条命令的退出码。
 *   - POSIX sh / bash / zsh / WSL 的 `exit` 继承 `$?`（规范行为）。
 *   因此只有 PowerShell 家族需要显式 `$LASTEXITCODE`，其余一律裸 `exit`。
 * @param family detectTerminals 的 family（powershell|cmd|wsl|gitbash|posix）或 null
 * @param shellPath shell 路径（family 缺失时按文件名兜底判定）
 * @returns 退出指令
 */
export function shellExitCommand(family: string | null | undefined, shellPath?: string): string {
  const resolved = family || detectShellFamilyByName(shellPath);
  return resolved === "powershell" ? "exit $LASTEXITCODE" : "exit";
}

/**
 * 按可执行文件名推断 shell 家族（与宿主 native `detect_shell_family` 的规则对齐）。
 * @param shellPath shell 可执行文件路径
 * @returns powershell | cmd | wsl | gitbash | posix
 */
function detectShellFamilyByName(shellPath?: string): ShellFamily {
  // as: `split("/")` 恒返回至少一个元素，故 `pop()` 不会给出 undefined。
  const name = (String(shellPath || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop() as string)
    .toLowerCase();
  if (/pwsh|powershell/.test(name)) return "powershell";
  if (/cmd/.test(name)) return "cmd";
  if (/wsl/.test(name)) return "wsl";
  if (/git/.test(name) && /(bash|sh)/.test(name)) return "gitbash";
  return "posix";
}

/**
 * 读取宿主 window.snow（插件 ESM 在主世界执行，可直接访问）。
 * @returns 宿主原始 API；无 window（单测环境）时为 null
 */
function getSnow(): SnowApi | null {
  return typeof window !== "undefined" && window.snow ? window.snow : null;
}

/** 宿主终端设置的系统设置码（与宿主 TERMINAL_SETTING_CODE 同源）。 */
export const TERMINAL_SETTING_CODE = "terminal_settings";

/**
 * 解析模式 A 使用的 shell 与退出写法。
 *
 * @description 与宿主**同源**的解析链（见 snow-app src/renderer/components/rightPanel/terminal/useTerminalMcpCommandBridge.ts:93-100）：
 *   终端设置 `terminal_settings.shellPath` > `detectTerminals()[0]` > 宿主默认检测（传 undefined）。
 *   不写死 shell，从而兼容 Windows / macOS / Linux，并尊重用户在终端设置里配置的 shell。
 *   任一宿主查询缺失 / 失败都静默降级（该级视为未配置），绝不抛错。
 * @returns 解析出的 shell 路径与退出写法
 */
export async function resolveRunShell(): Promise<ResolvedRunShell> {
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
  // 宿主 detectTerminals 的返回（能力缺失时为 undefined）。
  let detected: DetectedTerminal[] | undefined;
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
const SCRIPT_EXTENSION_FAMILY: Record<string, ShellFamily[]> = {
  bat: ["cmd"],
  cmd: ["cmd"],
  ps1: ["powershell"],
  sh: ["posix", "gitbash", "wsl"],
};

/** 扩展名 → 所需 shell 家族的展示名（提示文案用）。 */
const SCRIPT_FAMILY_LABEL: Record<string, string> = { cmd: "cmd", powershell: "PowerShell", posix: "sh", gitbash: "sh", wsl: "sh" };

/** 取脚本文件扩展名（小写，不含点）；无扩展名返回空串。 */
function scriptExtension(sourcePath?: string): string {
  // as: `split("/")` 恒返回至少一个元素，故 `pop()` 不会给出 undefined。
  const name = String(sourcePath || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop() as string;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** 在检测到的终端里挑出第一个家族匹配项。 */
function pickTerminalByFamilies(terminals: RuntimeTerminal[], families: ShellFamily[]): RuntimeTerminal | null {
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
 * @param sourcePath 脚本文件绝对路径（据扩展名判定类型）
 * @returns 是否支持、用哪个 shell、执行行与退出写法
 */
export async function resolveScriptShell(sourcePath?: string): Promise<ScriptShellResolution> {
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
  const runCommandFor = (family?: string): string => {
    if (family === "powershell") return `& ".\\${baseName}"`;
    if (family === "cmd") return `".\\${baseName}"`;
    return `"./${baseName}"`;
  };

  let terminals: RuntimeTerminal[] = [];
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
 * @returns 宿主是否具备完整终端能力
 */
export function isTerminalAvailable(): boolean {
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
 * @param options 工作目录、初始尺寸、shell 选择与输出/退出回调
 * @returns 成功时带 ptyId 与 write / resize / kill，失败时只有 error
 */
export async function createPtySession(options: PtySessionOptions = {}): Promise<PtySessionResult> {
  const { cwd = "", cols = DEFAULT_COLS, rows = DEFAULT_ROWS, shellPath, onData, onExit } = options;

  const snow = getSnow();
  if (!isTerminalAvailable()) return { ok: false, error: "当前宿主未提供终端能力" };

  // 以下 snow 的非空性由 isTerminalAvailable() 保证（它内部已校验 window.snow 与全部方法存在）。
  let ptyId: string;
  try {
    ptyId = await snow!.ptyCreate(shellPath ? { cwd, cols, rows, shellPath } : { cwd, cols, rows });
  } catch (err) {
    return { ok: false, error: err && (err as ErrorWithMessage).message ? (err as ErrorWithMessage).message : String(err) };
  }
  if (!ptyId) return { ok: false, error: "终端创建失败" };

  let finished = false;
  // 先订阅输出/退出再返回：调用方拿到会话即可写入，不会漏掉首批输出。
  const offOutput = snow!.onPtyOutput((payload) => {
    if (!payload || payload.id !== ptyId || finished) return;
    if (typeof onData === "function") onData(payload.data);
  });
  const offExit = snow!.onPtyExit((payload) => {
    if (!payload || payload.id !== ptyId) return;
    finish(typeof payload.exitCode === "number" ? payload.exitCode : null);
  });

  /** 退订：进程结束后必须释放，否则长会话会不断累积回调。 */
  function cleanup(): void {
    if (typeof offOutput === "function") offOutput();
    if (typeof offExit === "function") offExit();
  }
  /** 收尾：保证 onExit 只回调一次（kill 与真实退出事件可能同时到达）。 */
  function finish(exitCode: number | null): void {
    if (finished) return;
    finished = true;
    cleanup();
    if (typeof onExit === "function") onExit(exitCode);
  }

  return {
    ok: true,
    ptyId,
    /** 把键盘输入原样写入 shell（含控制字符，如 Ctrl+C 的 \x03）。 */
    write(data: string): void {
      if (finished) return;
      try {
        // 偏离（已登记）：ptyWrite 返回 Promise，同步 try/catch 挡不住它的拒绝；
        // 「进程已退出」必须真被吞掉，否则每次向已退出的 shell 敲键都刷一条 unhandled rejection。
        snow!.ptyWrite(ptyId, String(data)).catch(() => {
          // 忽略：进程可能已退出
        });
      } catch {
        // 忽略：进程可能已退出
      }
    },
    /** 通知 shell 终端尺寸变化（ConPTY 需要它才能正确换行与重绘）。 */
    resize(nextCols: number, nextRows: number): void {
      if (finished) return;
      try {
        snow!.ptyResize(ptyId, nextCols, nextRows).catch(() => {
          // 忽略：进程可能已退出
        });
      } catch {
        // 忽略：进程可能已退出
      }
    },
    /** 关闭会话：kill 后立即收尾（若宿主未派发 onPtyExit，状态也不会悬空）。 */
    kill(): void {
      if (finished) return;
      try {
        snow!.ptyKill(ptyId).catch(() => {
          // 忽略：进程可能已自然退出
        });
      } catch {
        // 忽略：进程可能已自然退出
      }
      finish(null);
    },
  };
}
