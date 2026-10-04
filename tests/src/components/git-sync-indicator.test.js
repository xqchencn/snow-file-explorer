import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// 建立最小 DOM 环境后再导入渲染模块（node 环境无 DOM）。
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderGitSyncIndicator } = await import("../../../src/components/git-sync-indicator.js");

/** 翻译桩：支持 {{name}} 占位替换（与宿主 api.t 一致）。 */
const t = (_key, fallback, values) => {
  let out = fallback || _key;
  if (values) {
    for (const [k, v] of Object.entries(values)) out = out.split(`{{${k}}}`).join(String(v));
  }
  return out;
};

function mount(getState, onSync = () => {}) {
  const wrap = document.createElement("div");
  const controller = renderGitSyncIndicator(wrap, { t, getState, onSync });
  return { wrap, controller, btn: wrap.querySelector(".sfe-git-sync-indicator") };
}

test("同步指示器: 非仓库时隐藏", () => {
  const { btn } = mount(() => ({ gitStatus: { isRepo: false } }));
  assert.equal(btn.hidden, true);
});

test("同步指示器: 仓库且全部同步 → 不着色、无动画、不可点击", () => {
  const { btn } = mount(() => ({ gitStatus: { isRepo: true, ahead: 0, behind: 0 } }));
  assert.equal(btn.hidden, false);
  assert.equal(btn.classList.contains("dirty"), false);
  assert.equal(btn.classList.contains("syncing"), false);
  assert.equal(btn.disabled, true, "无待同步时不可点击");
  assert.equal(btn.title, "已是最新");
});

test("同步指示器: 有未推送或有未拉取 → 绿色(.dirty) 且可点击", () => {
  const ahead = mount(() => ({ gitStatus: { isRepo: true, ahead: 2, behind: 0 } }));
  assert.equal(ahead.btn.classList.contains("dirty"), true);
  assert.equal(ahead.btn.disabled, false);
  assert.equal(ahead.btn.title, "2 个提交待推送");

  const behind = mount(() => ({ gitStatus: { isRepo: true, ahead: 0, behind: 3 } }));
  assert.equal(behind.btn.classList.contains("dirty"), true);
  assert.equal(behind.btn.disabled, false);
  assert.equal(behind.btn.title, "3 个提交待拉取");

  const both = mount(() => ({ gitStatus: { isRepo: true, ahead: 1, behind: 1 } }));
  assert.equal(both.btn.classList.contains("dirty"), true);
  assert.match(both.btn.title, /待推送/);
  assert.match(both.btn.title, /待拉取/);
});

test("同步指示器: 同步中播放颜色交替动画并禁用，结束后恢复", () => {
  let state = { gitStatus: { isRepo: true, ahead: 1, behind: 0 }, gitSyncBusy: null, gitBusy: null };
  const { btn, controller } = mount(() => state);

  state = { gitStatus: { isRepo: true, ahead: 1, behind: 0 }, gitSyncBusy: "sync", gitBusy: null };
  controller.sync();
  assert.equal(btn.classList.contains("syncing"), true);
  assert.equal(btn.disabled, true);
  assert.equal(btn.title, "正在同步…");

  state = { gitStatus: { isRepo: true, ahead: 1, behind: 0 }, gitSyncBusy: null, gitBusy: null };
  controller.sync();
  assert.equal(btn.classList.contains("syncing"), false);
  assert.equal(btn.disabled, false);
  assert.equal(btn.classList.contains("dirty"), true, "同步结束后仍有待同步 → 绿色");
});

test("同步指示器: gitBusy 为 pull/push 时同样视为同步中", () => {
  const pull = mount(() => ({ gitStatus: { isRepo: true, ahead: 0, behind: 1 }, gitBusy: "pull" }));
  assert.equal(pull.btn.classList.contains("syncing"), true);
  const push = mount(() => ({ gitStatus: { isRepo: true, ahead: 1, behind: 0 }, gitBusy: "push" }));
  assert.equal(push.btn.classList.contains("syncing"), true);
});

test("同步指示器: 点击触发 onSync（同步中/禁用时不触发）", () => {
  let calls = 0;
  let state = { gitStatus: { isRepo: true, ahead: 1, behind: 0 }, gitSyncBusy: null, gitBusy: null };
  const { btn, controller } = mount(() => state, () => (calls += 1));

  btn.click();
  assert.equal(calls, 1);

  state = { gitStatus: { isRepo: true, ahead: 1, behind: 0 }, gitSyncBusy: "sync", gitBusy: null };
  controller.sync();
  btn.click();
  assert.equal(calls, 1, "同步进行中点击不应重复触发");
});
