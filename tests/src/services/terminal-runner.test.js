import test from "node:test";
import assert from "node:assert/strict";
import {
  createPtySession,
  isTerminalAvailable,
  resolveRunShell,
  shellExitCommand,
  DEFAULT_COLS,
  DEFAULT_ROWS,
} from "../../../src/services/terminal-runner.js";

const ESC = String.fromCharCode(27);

/**
 * 构造一个假的 window.snow 终端环境，并在用例结束后还原全局 window。
 * @param {Object} [overrides] 覆盖默认实现（如让 ptyCreate 抛错）
 * @returns {{snow: Object, restore: Function, emitted: Object, listenerCounts: Function}}
 */
function withSnow(overrides = {}) {
  const listeners = { output: [], exit: [] };
  const emitted = { writes: [], resizes: [], kills: [], created: [] };
  const snow = {
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
    ptyKill: (id) => {
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
    detectTerminals: async () => [],
    ...overrides,
  };
  const previous = globalThis.window;
  globalThis.window = { snow };
  return {
    snow,
    emitted,
    emitOutput: (data, id = "pty-1") => listeners.output.forEach((cb) => cb({ id, data })),
    emitExit: (exitCode, id = "pty-1") => listeners.exit.forEach((cb) => cb({ id, exitCode })),
    listenerCounts: () => ({ output: listeners.output.length, exit: listeners.exit.length }),
    restore: () => {
      if (previous === undefined) delete globalThis.window;
      else globalThis.window = previous;
    },
  };
}

test("isTerminalAvailable：宿主能力齐备为 true，缺任一项为 false", () => {
  const previous = globalThis.window;
  delete globalThis.window;
  try {
    assert.equal(isTerminalAvailable(), false, "无 window.snow 时为 false");
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
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
  delete globalThis.window;
  try {
    const result = await createPtySession({ cwd: "D:/proj" });
    assert.equal(result.ok, false);
    assert.match(result.error, /终端能力/);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test("createPtySession：使用默认 cols/rows 建 pty，并原样透传含 ANSI 的输出", async () => {
  const env = withSnow();
  try {
    const chunks = [];
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
    session.write("ls\r");
    session.resize(100, 30);
    assert.deepEqual(env.emitted.writes, [{ id: "pty-1", data: "ls\r" }]);
    assert.deepEqual(env.emitted.resizes, [{ id: "pty-1", cols: 100, rows: 30 }]);

    session.kill();
    assert.deepEqual(env.emitted.kills, ["pty-1"]);
  } finally {
    env.restore();
  }
});

test("createPtySession：onExit 只回调一次，kill 后真实退出事件不再触发", async () => {
  const env = withSnow();
  try {
    const exits = [];
    const session = await createPtySession({ onExit: (code) => exits.push(code) });

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
    const exits = [];
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
    const chunks = [];
    const exits = [];
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
    detectTerminals: async () => [{ name: "cmd", path: "C:/Windows/System32/cmd.exe", family: "cmd" }],
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
    detectTerminals: async () => [{ name: "cmd", path: "C:/Windows/System32/cmd.exe", family: "cmd" }],
  });
  try {
    const r = await resolveRunShell();
    assert.equal(r.shellPath, "C:/Windows/System32/cmd.exe");
    assert.equal(r.exitCommand, "exit");
  } finally {
    detected.restore();
  }

  // 3) 都拿不到 → shellPath undefined（交给宿主默认检测），裸 exit
  const fallback = withSnow({ getSystemSettingValue: async () => null, detectTerminals: async () => [] });
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
