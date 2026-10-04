import test from "node:test";
import assert from "node:assert/strict";
import {
  stripAnsi,
  normalizeOutput,
  createOutputNormalizer,
  isTerminalAvailable,
  startCommand,
} from "../../../src/services/terminal-runner.js";

const ESC = String.fromCharCode(27);

/**
 * 构造一个假的 window.snow 终端环境，并在用例结束后还原全局 window。
 * @param {Object} [overrides] 覆盖默认实现（如让 ptyCreate 抛错）
 * @returns {{snow: Object, restore: Function, emitted: Object}}
 */
function withSnow(overrides = {}) {
  const listeners = { output: [], exit: [] };
  const emitted = { writes: [], kills: [], created: [] };
  const snow = {
    ptyCreate: async (params) => {
      emitted.created.push(params);
      return "pty-1";
    },
    ptyWrite: async (id, data) => {
      emitted.writes.push({ id, data });
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

test("stripAnsi：去除颜色/OSC，并把光标定位序列还原为回车", () => {
  const raw = `${ESC}[32mhello${ESC}[0m ${ESC}[1;31mworld${ESC}[0m`;
  assert.equal(stripAnsi(raw), "hello world");
  // OSC 序列（设置标题）也应被移除
  assert.equal(stripAnsi(`${ESC}]0;title${String.fromCharCode(7)}text`), "text");
  // 光标定位（移到行首/指定列）必须还原为 \r，而不是被删除——
  // 否则 shell 的整行重绘帧会被首尾拼接成「npm run buildnpm run build…」重复文本。
  assert.equal(stripAnsi(`${ESC}[Gabc`), "\rabc");
  assert.equal(stripAnsi(`${ESC}[1Gabc`), "\rabc");
  // 擦除类 CSI（ESC[K）无文本语义，直接丢弃
  assert.equal(stripAnsi(`abc${ESC}[K`), "abc");
});

test("normalizeOutput：统一换行、折叠回车重绘、剔除控制字符、保留制表符", () => {
  // \r\n 是真换行；行内裸 \r 按终端「光标回行首覆盖本行」折叠为最后一段。
  assert.equal(normalizeOutput("a\r\nb\rc"), "a\nc");
  assert.equal(normalizeOutput("a\tb"), "a\tb");
  // C0 控制字符（如 BEL）与 DEL 被丢弃
  assert.equal(normalizeOutput(`a${String.fromCharCode(7)}b${String.fromCharCode(127)}c`), "abc");
  assert.equal(normalizeOutput(null), "");
});

test("normalizeOutput：光标定位重绘只保留最终行，不堆叠成重复行", () => {
  // 复现真实故障：交互式 shell 重绘整行时发的是光标定位序列（ESC[G），不是裸 \r。
  // 期望：整行覆盖后只剩一行命令，而不是 7 段拼接。
  const G = `${ESC}[G`;
  assert.equal(
    normalizeOutput(`npm run build${G}npm run build${G}npm run build${G}\n`),
    "npm run build\n",
  );
  // 进度条回行首刷新：只保留最终百分比。
  assert.equal(normalizeOutput("10%\r50%\r100%\n"), "100%\n");
  // 逐列覆盖：短内容覆盖行首，原行尾部残留应保留。
  assert.equal(normalizeOutput("abcdef\rXY\n"), "XYcdef\n");
  // 退格只移动光标（真实终端语义），后续字符覆盖该列：abc 后光标退到 c，被 X 覆盖。
  assert.equal(normalizeOutput("abc\bX\n"), "abX\n");
});

test("createOutputNormalizer：跨 chunk 的整行重绘也能合并（重绘帧被 pty 拆分）", () => {
  // 一帧「光标回行首 + 整行」可能被拆到多个事件：若逐 chunk 独立处理会拼接成重复命令。
  const normalizer = createOutputNormalizer();
  assert.equal(normalizer.push(`npm run bu`), "");
  assert.equal(normalizer.push(`ild${ESC}[Gnpm run bu`), "");
  assert.equal(normalizer.push(`ild${ESC}[Gnpm run build\n`), "npm run build\n");
  // 未定稿的当前行由 flush 取出。
  normalizer.push("tail");
  assert.equal(normalizer.flush(), "tail");
});

test("isTerminalAvailable：无宿主终端能力时为 false，能力齐备时为 true", () => {
  assert.equal(isTerminalAvailable(), false);
  const env = withSnow();
  try {
    assert.equal(isTerminalAvailable(), true);
  } finally {
    env.restore();
  }
  const partial = withSnow({ ptyKill: undefined });
  try {
    assert.equal(isTerminalAvailable(), false);
  } finally {
    partial.restore();
  }
});

test("startCommand：宿主未提供终端能力时返回失败，不抛异常", async () => {
  const result = await startCommand("npm run dev", { cwd: "D:/proj" });
  assert.equal(result.ok, false);
  assert.match(result.error, /终端能力/);
});

test("startCommand：空命令直接失败", async () => {
  const env = withSnow();
  try {
    const result = await startCommand("   ", { cwd: "D:/proj" });
    assert.equal(result.ok, false);
  } finally {
    env.restore();
  }
});

test("startCommand：创建 pty、写入命令、净化输出并回传退出码", async () => {
  const env = withSnow();
  try {
    const chunks = [];
    let exitInfo = null;
    const result = await startCommand("npm run dev", {
      cwd: "D:/proj",
      onData: (text) => chunks.push(text),
      onExit: (code, stopped) => {
        exitInfo = { code, stopped };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ptyId, "pty-1");
    // cols/rows 必填，封装层必须给出默认值
    assert.equal(env.emitted.created[0].cwd, "D:/proj");
    assert.equal(env.emitted.created[0].cols, 100);
    assert.equal(env.emitted.created[0].rows, 30);
    // 命令以回车结尾写入，并追加一行 exit —— 命令跑完后 shell 退出，pty:exit 才会派发
    assert.equal(env.emitted.writes[0].data, "npm run dev\rexit\r");

    env.emitOutput(`${ESC}[32mready${ESC}[0m\n`);
    assert.deepEqual(chunks, ["ready\n"]);

    // 无换行的末尾输出在退出时由 flush 取出，不丢内容。
    env.emitOutput("partial");
    assert.deepEqual(chunks, ["ready\n"]);
    env.emitExit(0);
    assert.deepEqual(chunks, ["ready\n", "partial"]);
    assert.deepEqual(exitInfo, { code: 0, stopped: false });
    // 退出后退订，避免回调泄漏
    assert.deepEqual(env.listenerCounts(), { output: 0, exit: 0 });
  } finally {
    env.restore();
  }
});

test("startCommand：忽略非本 pty 的输出与退出事件", async () => {
  const env = withSnow();
  try {
    const chunks = [];
    let exited = false;
    await startCommand("node index.js", {
      onData: (text) => chunks.push(text),
      onExit: () => {
        exited = true;
      },
    });

    env.emitOutput("noise", "other-pty");
    env.emitExit(1, "other-pty");
    assert.deepEqual(chunks, []);
    assert.equal(exited, false);
  } finally {
    env.restore();
  }
});

test("startCommand：stop() 结束进程并以 stopped=true 收尾（仅回调一次）", async () => {
  const env = withSnow();
  try {
    let calls = 0;
    let exitInfo = null;
    const result = await startCommand("npm run dev", {
      onExit: (code, stopped) => {
        calls += 1;
        exitInfo = { code, stopped };
      },
    });

    result.stop();
    assert.deepEqual(env.emitted.kills, ["pty-1"]);
    assert.deepEqual(exitInfo, { code: null, stopped: true });

    // 后续真实退出事件不得再次回调
    env.emitExit(0);
    assert.equal(calls, 1);
    assert.deepEqual(env.listenerCounts(), { output: 0, exit: 0 });
  } finally {
    env.restore();
  }
});

test("startCommand：ptyCreate 抛错时返回失败信息，不抛异常", async () => {
  const env = withSnow({
    ptyCreate: async () => {
      throw new Error("cols must be a number");
    },
  });
  try {
    const result = await startCommand("npm run dev", {});
    assert.equal(result.ok, false);
    assert.match(result.error, /cols/);
  } finally {
    env.restore();
  }
});

test("startCommand：ptyWrite 失败时清理并杀掉 pty", async () => {
  const env = withSnow({
    ptyWrite: async () => {
      throw new Error("write failed");
    },
  });
  try {
    const result = await startCommand("npm run dev", {});
    assert.equal(result.ok, false);
    assert.match(result.error, /write failed/);
    assert.deepEqual(env.emitted.kills, ["pty-1"]);
    assert.deepEqual(env.listenerCounts(), { output: 0, exit: 0 });
  } finally {
    env.restore();
  }
});
