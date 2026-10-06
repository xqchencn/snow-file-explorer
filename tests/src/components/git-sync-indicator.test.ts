import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { GitSyncIndicatorHandle } from "../../../src/components/git-sync-indicator.ts";
import type { GitOperation, GitSyncSnapshot, TranslateFn } from "../../../src/types/panel-state.ts";
import type { GitStatusResult } from "../../../src/types/host/host-git.ts";

// 建立最小 DOM 环境后再导入渲染模块（node 环境无 DOM）。
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderGitSyncIndicator } = await import("../../../src/components/git-sync-indicator.ts");

/** 翻译桩：支持 {{name}} 占位替换（与宿主 api.t 一致）。 */
const t: TranslateFn = (_key, fallback, values) => {
  let out = fallback || _key;
  if (values) {
    for (const [k, v] of Object.entries(values)) out = out.split(`{{${k}}}`).join(String(v));
  }
  return out;
};

/** 仓库状态桩的入参：本文件只关心这三项，其余字段按宿主契约固定填空值。 */
type GitStatusStubInput = {
  /** 是否 git 仓库（指示器唯一的隐藏条件）。 */
  isRepo: boolean;
  /** 领先远端的提交数，缺省 0。 */
  ahead?: number;
  /** 落后远端的提交数，缺省 0。 */
  behind?: number;
};

/**
 * 构造 GitStatusResult 桩（宿主 `gitStatus()` 的返回形状，字段全部必填）。
 * @description 指示器只读 `isRepo` 与 `gitSyncCounts` 用到的 `ahead` / `behind`；
 *   其余字段给中性空值，避免桩缺字段掩盖组件的真实读取面。
 */
function gitStatus({ isRepo, ahead = 0, behind = 0 }: GitStatusStubInput): GitStatusResult {
  return {
    isRepo,
    currentBranch: "main",
    upstream: null,
    ahead,
    behind,
    files: [],
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    statusLimitHit: false,
  };
}

/** mount 接受的状态切片桩：组件读取的三个字段都可缺，缺省按「空闲」补齐（见 mount）。 */
type IndicatorStateStub = {
  /** 仓库状态；缺省按 null（尚未取到）处理。 */
  gitStatus?: GitStatusResult | null;
  /** Git 写操作队列动作；缺省按 null 处理，与原桩的 undefined 等价（组件对两者都判非忙碌）。 */
  gitBusy?: GitOperation | null;
  /** 顶栏「先拉后推」编排动作；缺省按 null 处理，同上。 */
  gitSyncBusy?: GitOperation | null;
};

/** mount 的返回：容器、控制句柄与指示器按钮本体。 */
type MountedIndicator = {
  /** 承载指示器的工具栏容器。 */
  wrap: HTMLDivElement;
  /** 组件返回的刷新 / 卸载句柄。 */
  controller: GitSyncIndicatorHandle;
  /** 指示器按钮（组件用 `<button class="sfe-git-sync-indicator">` 渲染）。 */
  btn: HTMLButtonElement;
};

function mount(getState: () => IndicatorStateStub, onSync: (snapshot: GitSyncSnapshot) => void = () => {}): MountedIndicator {
  const wrap = document.createElement("div");
  // 桩里省略的 gitBusy / gitSyncBusy 补成 null：组件用 `!== null && !== undefined` 判忙碌，
  // 两者等价，故补齐只是满足 GitSyncSnapshot 的必填形状，不改变渲染结果。
  const readState = (): GitSyncSnapshot => {
    const { gitStatus: status = null, gitBusy = null, gitSyncBusy = null } = getState();
    return { gitStatus: status, gitBusy, gitSyncBusy };
  };
  const controller = renderGitSyncIndicator(wrap, { t, getState: readState, onSync });
  // !: 按钮由 renderGitSyncIndicator 无条件创建，缺失即组件缺陷；用例随后直接解引用，运行时同样会抛。
  const btn = wrap.querySelector<HTMLButtonElement>(".sfe-git-sync-indicator")!;
  return { wrap, controller, btn };
}

test("同步指示器: 非仓库时隐藏", () => {
  const { btn } = mount(() => ({ gitStatus: gitStatus({ isRepo: false }) }));
  assert.equal(btn.hidden, true);
});

test("同步指示器: 仓库且全部同步 → 不着色、无动画、不可点击", () => {
  const { btn } = mount(() => ({ gitStatus: gitStatus({ isRepo: true, ahead: 0, behind: 0 }) }));
  assert.equal(btn.hidden, false);
  assert.equal(btn.classList.contains("dirty"), false);
  assert.equal(btn.classList.contains("syncing"), false);
  assert.equal(btn.disabled, true, "无待同步时不可点击");
  assert.equal(btn.title, "已是最新");
});

test("同步指示器: 有未推送或有未拉取 → 绿色(.dirty) 且可点击", () => {
  const ahead = mount(() => ({ gitStatus: gitStatus({ isRepo: true, ahead: 2, behind: 0 }) }));
  assert.equal(ahead.btn.classList.contains("dirty"), true);
  assert.equal(ahead.btn.disabled, false);
  assert.equal(ahead.btn.title, "2 个提交待推送");

  const behind = mount(() => ({ gitStatus: gitStatus({ isRepo: true, ahead: 0, behind: 3 }) }));
  assert.equal(behind.btn.classList.contains("dirty"), true);
  assert.equal(behind.btn.disabled, false);
  assert.equal(behind.btn.title, "3 个提交待拉取");

  const both = mount(() => ({ gitStatus: gitStatus({ isRepo: true, ahead: 1, behind: 1 }) }));
  assert.equal(both.btn.classList.contains("dirty"), true);
  assert.match(both.btn.title, /待推送/);
  assert.match(both.btn.title, /待拉取/);
});

test("同步指示器: 同步中播放颜色交替动画并禁用，结束后恢复", () => {
  let state: GitSyncSnapshot = { gitStatus: gitStatus({ isRepo: true, ahead: 1, behind: 0 }), gitSyncBusy: null, gitBusy: null };
  const { btn, controller } = mount(() => state);

  state = { gitStatus: gitStatus({ isRepo: true, ahead: 1, behind: 0 }), gitSyncBusy: "sync", gitBusy: null };
  controller.sync();
  assert.equal(btn.classList.contains("syncing"), true);
  assert.equal(btn.disabled, true);
  assert.equal(btn.title, "正在同步…");

  state = { gitStatus: gitStatus({ isRepo: true, ahead: 1, behind: 0 }), gitSyncBusy: null, gitBusy: null };
  controller.sync();
  assert.equal(btn.classList.contains("syncing"), false);
  assert.equal(btn.disabled, false);
  assert.equal(btn.classList.contains("dirty"), true, "同步结束后仍有待同步 → 绿色");
});

test("同步指示器: gitBusy 为 push 时同样视为同步中", () => {
  // gitBusy 的取值集合里没有 "pull"（拉取从不单独置忙碌态），所以这一例只覆盖真实存在的 push。
  const push = mount(() => ({ gitStatus: gitStatus({ isRepo: true, ahead: 1, behind: 0 }), gitBusy: "push" }));
  assert.equal(push.btn.classList.contains("syncing"), true);
});

test("同步指示器: 点击触发 onSync（同步中/禁用时不触发）", () => {
  let calls = 0;
  let state: GitSyncSnapshot = { gitStatus: gitStatus({ isRepo: true, ahead: 1, behind: 0 }), gitSyncBusy: null, gitBusy: null };
  const { btn, controller } = mount(() => state, () => (calls += 1));

  btn.click();
  assert.equal(calls, 1);

  state = { gitStatus: gitStatus({ isRepo: true, ahead: 1, behind: 0 }), gitSyncBusy: "sync", gitBusy: null };
  controller.sync();
  btn.click();
  assert.equal(calls, 1, "同步进行中点击不应重复触发");
});
