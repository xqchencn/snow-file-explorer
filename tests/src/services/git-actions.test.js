import test from "node:test";
import assert from "node:assert/strict";
import { gitSync } from "../../../src/services/git-actions.js";

/** 在不污染其他测试的前提下替换宿主 Git API。 */
async function withSnow(snow, callback) {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const previousWindow = globalThis.window;
  globalThis.window = { snow };
  try {
    return await callback();
  } finally {
    if (hadWindow) globalThis.window = previousWindow;
    else delete globalThis.window;
  }
}

const repoStatus = (overrides = {}) => ({
  isRepo: true,
  currentBranch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  ...overrides,
});

test("Git 同步: 有 upstream 时先 pull，刷新后仍 ahead 才 push", async () => {
  const calls = [];
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
  const calls = [];
  const result = await withSnow(
    {
      gitPull: async (...args) => {
        calls.push(["pull", ...args]);
        return { success: true };
      },
      gitPush: async (...args) => {
        calls.push(["push", ...args]);
        return { success: true };
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
  const calls = [];
  const result = await withSnow(
    {
      gitPull: async (...args) => {
        calls.push(["pull", ...args]);
        return { success: false, message: "网络错误" };
      },
      gitPush: async (...args) => {
        calls.push(["push", ...args]);
        return { success: true };
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
  const calls = [];
  const result = await withSnow(
    {
      gitPull: async (...args) => {
        calls.push(["pull", ...args]);
        return { success: true };
      },
      gitPush: async (...args) => {
        calls.push(["push", ...args]);
        return { success: true };
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
  const calls = [];
  const snow = {
    gitPull: async (...args) => calls.push(["pull", ...args]),
    gitPush: async (...args) => calls.push(["push", ...args]),
  };

  await withSnow(snow, async () => {
    const nonRepo = await gitSync("D:/repo", { isRepo: false }, async () => repoStatus());
    const noStatus = await gitSync("D:/repo", null, async () => repoStatus());
    assert.equal(nonRepo.success, false);
    assert.equal(noStatus.success, false);
  });

  assert.deepEqual(calls, []);
});
