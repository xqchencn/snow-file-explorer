import test from "node:test";
import assert from "node:assert/strict";
import { gitSync } from "../../../src/services/git-actions.ts";
import type { GitStatusResult } from "../../../src/types/host/host-git.ts";
import type { SnowApi } from "../../../src/types/snow-api.ts";
import { installWindow, uninstallWindow, restoreWindow } from "../utils/window-stub.ts";

/**
 * 用例里替换 window.snow 的桩形状。
 * @description src/types/snow-api.ts 把宿主 window.snow 声明为「方法必给全」，但被测源码
 *   （git-actions.ts 的每个方法）调用前都用 `typeof snow.xxx === "function"` 探测能力，
 *   用例只给被测链路用到的那几个方法，其余保持整体缺失。
 */
type SnowStub = Partial<SnowApi>;

/** 在不污染其他测试的前提下替换宿主 Git API。 */
async function withSnow<T>(snow: SnowStub, callback: () => Promise<T>): Promise<T> {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const previousWindow = globalThis.window;
  installWindow({ snow });
  try {
    return await callback();
  } finally {
    if (hadWindow) restoreWindow(previousWindow);
    else uninstallWindow();
  }
}

/**
 * GitStatusResult 桩：宿主契约要求下面 10 个字段全部必给，用例只覆写自己关心的那几个。
 * @description gitSync 实际只读 isRepo / upstream / currentBranch / ahead；
 *   files 与三个计数按「无变更」填充，statusLimitHit 按未截断填充。
 */
function repoStatus(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    isRepo: true,
    currentBranch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    files: [],
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    statusLimitHit: false,
    ...overrides,
  };
}

test("Git 同步: 有 upstream 时先 pull，刷新后仍 ahead 才 push", async () => {
  const calls: unknown[][] = [];
  const result = await withSnow(
    {
      gitPull: async (...args) => {
        calls.push(["pull", ...args]);
        return { success: true, message: "" };
      },
      gitPush: async (...args) => {
        calls.push(["push", ...args]);
        return { success: true, message: "" };
      },
    },
    () =>
      gitSync("D:/repo", repoStatus({ ahead: 1, behind: 2 }), async () =>
        repoStatus({ ahead: 1, behind: 0 })
      )
  );

  assert.deepEqual(calls, [
    ["pull", "D:/repo", "origin", "main"],
    ["push", "D:/repo", "origin", "main", false],
  ]);
  assert.equal(result.success, true);
  assert.equal(result.pulled, true);
  assert.equal(result.pushed, true);
});

test("Git 同步: pull 后 ahead 归零时不 push", async () => {
  const calls: unknown[][] = [];
  const result = await withSnow(
    {
      gitPull: async (...args) => {
        calls.push(["pull", ...args]);
        // GitPushPullResult 的 message 必给；成功链路不读它（gitSync 只在失败分支取 message）。
        return { success: true, message: "" };
      },
      gitPush: async (...args) => {
        calls.push(["push", ...args]);
        return { success: true, message: "" };
      },
    },
    () => gitSync("D:/repo", repoStatus({ ahead: 1 }), async () => repoStatus())
  );

  assert.deepEqual(calls, [["pull", "D:/repo", "origin", "main"]]);
  assert.equal(result.success, true);
  assert.equal(result.pulled, true);
  assert.equal(result.pushed, false);
});

test("Git 同步: pull 失败时不继续 push", async () => {
  const calls: unknown[][] = [];
  const result = await withSnow(
    {
      gitPull: async (...args) => {
        calls.push(["pull", ...args]);
        return { success: false, message: "网络错误" };
      },
      gitPush: async (...args) => {
        calls.push(["push", ...args]);
        return { success: true, message: "" };
      },
    },
    () => gitSync("D:/repo", repoStatus({ ahead: 1 }), async () => repoStatus({ ahead: 1 }))
  );

  assert.deepEqual(calls, [["pull", "D:/repo", "origin", "main"]]);
  assert.equal(result.success, false);
  assert.equal(result.pulled, false);
  assert.equal(result.pushed, false);
  assert.equal(result.message, "网络错误");
});

test("Git 同步: 无 upstream 且有本地提交时直接设置 upstream 推送", async () => {
  const calls: unknown[][] = [];
  const result = await withSnow(
    {
      gitPull: async (...args) => {
        calls.push(["pull", ...args]);
        return { success: true, message: "" };
      },
      gitPush: async (...args) => {
        calls.push(["push", ...args]);
        return { success: true, message: "" };
      },
    },
    () =>
      gitSync(
        "D:/repo",
        repoStatus({ upstream: "", ahead: 2 }),
        async () => repoStatus({ upstream: "", ahead: 2 })
      )
  );

  assert.deepEqual(calls, [["push", "D:/repo", undefined, "main", true]]);
  assert.equal(result.success, true);
  assert.equal(result.pulled, false);
  assert.equal(result.pushed, true);
});

test("Git 同步: 非仓库或没有状态时失败且不调用远端 API", async () => {
  const calls: unknown[][] = [];
  // 这两个桩在本用例里必须一次都不被调用（末尾 calls 为空断言负责把关），
  // 返回值只为满足 SnowApi 的响应形状；原写法返回 push 的下标数组，不是宿主响应。
  const snow: SnowStub = {
    gitPull: async (...args) => {
      calls.push(["pull", ...args]);
      return { success: true, message: "" };
    },
    gitPush: async (...args) => {
      calls.push(["push", ...args]);
      return { success: true, message: "" };
    },
  };

  await withSnow(snow, async () => {
    const nonRepo = await gitSync("D:/repo", repoStatus({ isRepo: false }), async () => repoStatus());
    const noStatus = await gitSync("D:/repo", null, async () => repoStatus());
    assert.equal(nonRepo.success, false);
    assert.equal(noStatus.success, false);
  });

  assert.deepEqual(calls, []);
});
