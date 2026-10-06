import test from "node:test";
import assert from "node:assert/strict";
import {
  createPtySession,
  isTerminalAvailable,
  resolveRunShell,
  resolveScriptShell,
  shellExitCommand,
  DEFAULT_COLS,
  DEFAULT_ROWS,
} from "../../../src/services/terminal-runner.ts";
import type { RuntimeTerminal } from "../../../src/services/terminal-runner.ts";
import type { SnowApi, PtyCreateOptions, PtyExitPayload, PtyOutputPayload } from "../../../src/types/snow-api.ts";
import type { DetectedTerminal } from "../../../src/types/host/host-settings.ts";
import { installWindow, uninstallWindow, restoreWindow } from "../utils/window-stub.ts";

const ESC = String.fromCharCode(27);

/**
 * 用例里替换 window.snow 的桩形状。
 * @description 宿主契约（src/types/snow-api.ts）声明 window.snow 的方法必给全，而被测源码
 *   在调用前一律用 `typeof snow.xxx === "function"` 探测能力（isTerminalAvailable 就是这套探测）；
 *   用例正是靠「某个方法整体缺失」覆盖降级分支，所以桩只能是 SnowApi 的一个子集。
 */
type SnowStub = Partial<SnowApi>;

/**
 * withSnow 记录到的宿主 PTY 调用流水。
 */
type EmittedCalls = {
  /** ptyCreate 收到的入参（宿主契约要求 cwd/cols/rows 必给）。 */
  created: PtyCreateOptions[];
  /** ptyWrite 收到的进程 id 与写入文本。 */
  writes: { id: string; data: string }[];
  /** ptyResize 收到的进程 id 与目标尺寸。 */
  resizes: { id: string; cols: number; rows: number }[];
  /** ptyKill 收到的进程 id。 */
  kills: string[];
};

/**
 * 事件订阅回调的收集槽，供 emitOutput / emitExit 手工派发。
 */
type PtyListeners = {
  /** onPtyOutput 已注册的回调（退订后从中移除）。 */
  output: ((data: PtyOutputPayload) => void)[];
  /** onPtyExit 已注册的回调（退订后从中移除）。 */
  exit: ((data: PtyExitPayload) => void)[];
};

/**
 * withSnow 的返回：桩本体、调用流水、事件派发器与还原函数。
 */
type SnowEnv = {
  /** 装入全局的 window.snow 桩（用例可据此断言方法是否存在）。 */
  snow: SnowStub;
  /** 宿主 PTY 调用流水。 */
  emitted: EmittedCalls;
  /** 派发一条 PTY 输出；id 默认对齐 ptyCreate 桩返回的 "pty-1"。 */
  emitOutput: (data: string, id?: string) => void;
  /** 派发一次 PTY 退出；id 同上。 */
  emitExit: (exitCode: number, id?: string) => void;
  /** 当前仍在册的输出/退出回调数（断言退订是否干净）。 */
  listenerCounts: () => { output: number; exit: number };
  /** 还原 window 全局，避免污染后续用例。 */
  restore: () => void;
};

/**
 * detectTerminals 桩的返回值收口。
 * @description 宿主 preload 类型 DetectedTerminal.family 只有 powershell/cmd/wsl/posix 四值，
 *   但宿主 native 实测会产出 gitbash——terminal-runner.ts 的注释与它自己的
 *   RuntimeTerminal.family: string 都已承认这点并「按字符串收口」。本文件的 sh 用例必须造出
 *   gitbash 条目，因此桩只能沿源码同一口径收口回 DetectedTerminal[]。
 *   真实缺陷在宿主类型声明（见报告），不是桩的问题。
 * as: string → 宿主四值联合的收口，与源码 RuntimeTerminal 的口径一致；桩数据由用例逐条断言校验。
 */
function detectedTerminals(terminals: RuntimeTerminal[]): DetectedTerminal[] {
  return terminals as DetectedTerminal[];
}

/**
 * 构造一个假的 window.snow 终端环境，并在用例结束后还原全局 window。
 * @param overrides 覆盖默认实现（如让 ptyCreate 抛错、把某个方法置空以模拟宿主能力缺失）
 * @returns 桩本体与调用流水、事件派发器、还原函数
 */
function withSnow(overrides: SnowStub = {}): SnowEnv {
  const listeners: PtyListeners = { output: [], exit: [] };
  const emitted: EmittedCalls = { writes: [], resizes: [], kills: [], created: [] };
  const snow: SnowStub = {
    ptyCreate: async (params) => {
      emitted.created.push(params);
      return "pty-1";
    },
    ptyWrite: async (id, data) => {
      emitted.writes.push({ id, data });
    },
    ptyResize: async (id, cols, rows) => {
      emitted.resizes.push({ id, cols, rows });
    },
    // 宿主声明 ptyKill 回 Promise<void>，桩同步记录后即可（源码不 await 它）。
    ptyKill: async (id) => {
      emitted.kills.push(id);
    },
    onPtyOutput: (cb) => {
      listeners.output.push(cb);
      return () => {
        listeners.output = listeners.output.filter((fn) => fn !== cb);
      };
    },
    onPtyExit: (cb) => {
      listeners.exit.push(cb);
      return () => {
        listeners.exit = listeners.exit.filter((fn) => fn !== cb);
      };
    },
    // 模式 A 解析 shell 用：终端设置读取 + 跨平台终端检测（默认空实现，可被 overrides 覆盖）。
    getSystemSettingValue: async () => null,
    detectTerminals: async () => detectedTerminals([]),
    ...overrides,
  };
  const previous = globalThis.window;
  installWindow({ snow });
  return {
    snow,
    emitted,
    emitOutput: (data, id = "pty-1") => listeners.output.forEach((cb) => cb({ id, data })),
    emitExit: (exitCode, id = "pty-1") => listeners.exit.forEach((cb) => cb({ id, exitCode })),
    listenerCounts: () => ({ output: listeners.output.length, exit: listeners.exit.length }),
    restore: () => {
      restoreWindow(previous);
    },
  };
}

test("isTerminalAvailable：宿主能力齐备为 true，缺任一项为 false", () => {
  const previous = globalThis.window;
  uninstallWindow();
  try {
    assert.equal(isTerminalAvailable(), false, "无 window.snow 时为 false");
  } finally {
    restoreWindow(previous);
  }

  const env = withSnow();
  try {
    assert.equal(isTerminalAvailable(), true);
  } finally {
    env.restore();
  }

  // resize 是交互终端必需（ConPTY 靠它换行/重绘），缺失即视为能力不完整。
  const partial = withSnow({ ptyResize: undefined });
  try {
    assert.equal(isTerminalAvailable(), false);
  } finally {
    partial.restore();
  }

  // getSystemSettingValue 用于读取终端设置里的 shellPath（模式 A 解析 shell），缺失即视为不完整。
  const noSettings = withSnow({ getSystemSettingValue: undefined });
  try {
    assert.equal(isTerminalAvailable(), false);
  } finally {
    noSettings.restore();
  }
});

test("createPtySession：宿主未提供终端能力时返回失败，不抛异常", async () => {
  const previous = globalThis.window;
  uninstallWindow();
  try {
    const result = await createPtySession({ cwd: "D:/proj" });
    assert.equal(result.ok, false);
    // PtySessionResult.error 只在失败分支存在；断言它非空后才比对文本（成功分支本就不该走到这里）。
    assert.ok(result.error);
    assert.match(result.error, /终端能力/);
  } finally {
    restoreWindow(previous);
  }
});

test("createPtySession：使用默认 cols/rows 建 pty，并原样透传含 ANSI 的输出", async () => {
  const env = withSnow();
  try {
    const chunks: string[] = [];
    const result = await createPtySession({ cwd: "D:/proj", onData: (d) => chunks.push(d) });

    assert.equal(result.ok, true);
    assert.equal(result.ptyId, "pty-1");
    assert.equal(env.emitted.created[0].cwd, "D:/proj");
    assert.equal(env.emitted.created[0].cols, DEFAULT_COLS);
    assert.equal(env.emitted.created[0].rows, DEFAULT_ROWS);

    // 不净化：ANSI 颜色序列必须原样交给 xterm 解析（ls --color / 进度条 / TUI 依赖它）。
    const colored = `${ESC}[32mready${ESC}[0m`;
    env.emitOutput(colored);
    assert.deepEqual(chunks, [colored]);
  } finally {
    env.restore();
  }
});

test("createPtySession：自定义 cols/rows 与 shellPath 透传给 ptyCreate", async () => {
  const env = withSnow();
  try {
    await createPtySession({ cwd: "D:/p", cols: 120, rows: 40, shellPath: "pwsh.exe" });
    assert.equal(env.emitted.created[0].cols, 120);
    assert.equal(env.emitted.created[0].rows, 40);
    assert.equal(env.emitted.created[0].shellPath, "pwsh.exe");
  } finally {
    env.restore();
  }
});

test("createPtySession：write / resize / kill 转发到对应宿主 API", async () => {
  const env = withSnow();
  try {
    const session = await createPtySession({ cwd: "D:/p" });
    // PtySessionResult 的三个方法只在 ok 为 true 时存在，下面逐句断言其存在（原写法访问即抛）。
    assert.ok(session.write);
    session.write("ls\r");
    assert.ok(session.resize);
    session.resize(100, 30);
    assert.deepEqual(env.emitted.writes, [{ id: "pty-1", data: "ls\r" }]);
    assert.deepEqual(env.emitted.resizes, [{ id: "pty-1", cols: 100, rows: 30 }]);

    assert.ok(session.kill);
    session.kill();
    assert.deepEqual(env.emitted.kills, ["pty-1"]);
  } finally {
    env.restore();
  }
});

test("createPtySession：onExit 只回调一次，kill 后真实退出事件不再触发", async () => {
  const env = withSnow();
  try {
    const exits: (number | null)[] = [];
    const session = await createPtySession({ onExit: (code) => exits.push(code) });

    assert.ok(session.kill);
    session.kill();
    assert.deepEqual(exits, [null]);
    // kill 后已退订：后续真实退出不得再次回调，也不得残留监听。
    env.emitExit(0);
    assert.deepEqual(exits, [null]);
    assert.deepEqual(env.listenerCounts(), { output: 0, exit: 0 });
  } finally {
    env.restore();
  }
});

test("createPtySession：真实退出事件回传 exitCode 并退订", async () => {
  const env = withSnow();
  try {
    const exits: (number | null)[] = [];
    await createPtySession({ onExit: (code) => exits.push(code) });
    env.emitExit(2);
    assert.deepEqual(exits, [2]);
    assert.deepEqual(env.listenerCounts(), { output: 0, exit: 0 });
  } finally {
    env.restore();
  }
});

test("createPtySession：忽略非本 pty 的输出与退出事件", async () => {
  const env = withSnow();
  try {
    const chunks: string[] = [];
    const exits: (number | null)[] = [];
    await createPtySession({ onData: (d) => chunks.push(d), onExit: (c) => exits.push(c) });

    env.emitOutput("noise", "other-pty");
    env.emitExit(1, "other-pty");
    assert.deepEqual(chunks, []);
    assert.deepEqual(exits, []);
  } finally {
    env.restore();
  }
});

test("createPtySession：ptyCreate 抛错时返回失败信息，不抛异常", async () => {
  const env = withSnow({
    ptyCreate: async () => {
      throw new Error("cols must be a number");
    },
  });
  try {
    const result = await createPtySession({});
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.match(result.error, /cols/);
  } finally {
    env.restore();
  }
});

test("createPtySession：ptyCreate 返回空值时返回失败", async () => {
  const env = withSnow({ ptyCreate: async () => "" });
  try {
    const result = await createPtySession({});
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.match(result.error, /终端创建失败/);
  } finally {
    env.restore();
  }
});

// ── 模式 A：shell 解析与退出写法（跨平台）────────────────────────────────

test("shellExitCommand：PowerShell 家族用 exit $LASTEXITCODE，其余用裸 exit", () => {
  assert.equal(shellExitCommand("powershell"), "exit $LASTEXITCODE");
  assert.equal(shellExitCommand("cmd"), "exit");
  assert.equal(shellExitCommand("posix"), "exit");
  assert.equal(shellExitCommand("wsl"), "exit");
  // family 缺失：按 shell 文件名兜底判定（PowerShell 才需要显式 $LASTEXITCODE）。
  assert.equal(shellExitCommand(null, "C:/Program Files/PowerShell/7/pwsh.exe"), "exit $LASTEXITCODE");
  assert.equal(
    shellExitCommand(null, "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
    "exit $LASTEXITCODE"
  );
  assert.equal(shellExitCommand(null, "/bin/bash"), "exit");
  assert.equal(shellExitCommand(undefined, "cmd.exe"), "exit");
});

test("resolveRunShell：优先终端设置 shellPath，其次系统检测，均无则交宿主默认", async () => {
  // 1) 终端设置里配了 shellPath → 优先，且按文件名判定退出写法（尊重用户配置的 shell）
  const configured = withSnow({
    getSystemSettingValue: async () => JSON.stringify({ shellPath: "C:/Program Files/PowerShell/7/pwsh.exe" }),
    detectTerminals: async () => detectedTerminals([{ name: "cmd", path: "C:/Windows/System32/cmd.exe", family: "cmd" }]),
  });
  try {
    const r = await resolveRunShell();
    assert.equal(r.shellPath, "C:/Program Files/PowerShell/7/pwsh.exe");
    assert.equal(r.exitCommand, "exit $LASTEXITCODE");
  } finally {
    configured.restore();
  }

  // 2) 无设置 → 用 detectTerminals()[0] 的 path + family
  const detected = withSnow({
    getSystemSettingValue: async () => null,
    detectTerminals: async () => detectedTerminals([{ name: "cmd", path: "C:/Windows/System32/cmd.exe", family: "cmd" }]),
  });
  try {
    const r = await resolveRunShell();
    assert.equal(r.shellPath, "C:/Windows/System32/cmd.exe");
    assert.equal(r.exitCommand, "exit");
  } finally {
    detected.restore();
  }

  // 3) 都拿不到 → shellPath undefined（交给宿主默认检测），裸 exit
  const fallback = withSnow({
    getSystemSettingValue: async () => null,
    detectTerminals: async () => detectedTerminals([]),
  });
  try {
    const r = await resolveRunShell();
    assert.equal(r.shellPath, undefined);
    assert.equal(r.exitCommand, "exit");
  } finally {
    fallback.restore();
  }

  // 4) 宿主查询抛错 → 静默降级，绝不抛
  const broken = withSnow({
    getSystemSettingValue: async () => {
      throw new Error("boom");
    },
    detectTerminals: async () => {
      throw new Error("boom");
    },
  });
  try {
    const r = await resolveRunShell();
    assert.equal(r.shellPath, undefined);
    assert.equal(r.exitCommand, "exit");
  } finally {
    broken.restore();
  }
});

test("resolveScriptShell：bat→cmd、ps1→powershell、sh→POSIX，按扩展名选对应解释器", async () => {
  const env = withSnow({
    getSystemSettingValue: async () => null,
    detectTerminals: async () =>
      detectedTerminals([
        { name: "PowerShell", path: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", family: "powershell" },
        { name: "Command Prompt", path: "C:/Windows/System32/cmd.exe", family: "cmd" },
        { name: "Git Bash", path: "C:/Program Files/Git/bin/bash.exe", family: "gitbash" },
      ]),
  });
  try {
    const bat = await resolveScriptShell("D:/repo/build.bat");
    assert.equal(bat.supported, true);
    assert.equal(bat.family, "cmd");
    assert.equal(bat.shellPath, "C:/Windows/System32/cmd.exe");
    assert.equal(bat.runCommand, '".\\build.bat"');
    assert.equal(bat.exitCommand, "exit");

    const ps1 = await resolveScriptShell("D:/repo/deploy.ps1");
    assert.equal(ps1.supported, true);
    assert.equal(ps1.family, "powershell");
    assert.equal(ps1.runCommand, '& ".\\deploy.ps1"');
    assert.equal(ps1.exitCommand, "exit $LASTEXITCODE");

    const sh = await resolveScriptShell("D:/repo/start.sh");
    assert.equal(sh.supported, true);
    assert.equal(sh.family, "gitbash");
    assert.equal(sh.shellPath, "C:/Program Files/Git/bin/bash.exe");
    assert.equal(sh.runCommand, '"./start.sh"');
  } finally {
    env.restore();
  }
});

test("resolveScriptShell：缺少对应解释器时返回不支持（macOS/Linux 无 cmd/powershell，Windows 无 sh）", async () => {
  // 类 Unix：只有 posix，没有 cmd / powershell
  const posixOnly = withSnow({
    getSystemSettingValue: async () => null,
    detectTerminals: async () => detectedTerminals([{ name: "zsh", path: "/bin/zsh", family: "posix" }]),
  });
  try {
    assert.equal((await resolveScriptShell("/repo/build.bat")).supported, false);
    assert.equal((await resolveScriptShell("/repo/deploy.ps1")).supported, false);
    const sh = await resolveScriptShell("/repo/start.sh");
    assert.equal(sh.supported, true);
    assert.equal(sh.family, "posix");
    assert.equal(sh.runCommand, '"./start.sh"');
  } finally {
    posixOnly.restore();
  }

  // Windows：只有 cmd / powershell，没有 POSIX → sh 不支持
  const windowsOnly = withSnow({
    getSystemSettingValue: async () => null,
    detectTerminals: async () =>
      detectedTerminals([
        { name: "PowerShell", path: "C:/pwsh.exe", family: "powershell" },
        { name: "Command Prompt", path: "C:/cmd.exe", family: "cmd" },
      ]),
  });
  try {
    const sh = await resolveScriptShell("D:/repo/start.sh");
    assert.equal(sh.supported, false);
    assert.equal(sh.extension, "sh");
    assert.equal(sh.requiredLabel, "sh");
  } finally {
    windowsOnly.restore();
  }
});

test("resolveScriptShell：显式配置的终端 shell 类型匹配时优先使用", async () => {
  const env = withSnow({
    getSystemSettingValue: async () => JSON.stringify({ shellPath: "C:/Program Files/PowerShell/7/pwsh.exe" }),
    detectTerminals: async () => detectedTerminals([{ name: "cmd", path: "C:/Windows/System32/cmd.exe", family: "cmd" }]),
  });
  try {
    // ps1 与配置的 pwsh 匹配 → 用配置的 pwsh
    const ps1 = await resolveScriptShell("D:/repo/deploy.ps1");
    assert.equal(ps1.shellPath, "C:/Program Files/PowerShell/7/pwsh.exe");
    // bat 与配置的 pwsh 不匹配 → 退回系统检测到的 cmd
    const bat = await resolveScriptShell("D:/repo/build.bat");
    assert.equal(bat.family, "cmd");
    assert.equal(bat.shellPath, "C:/Windows/System32/cmd.exe");
  } finally {
    env.restore();
  }
});
