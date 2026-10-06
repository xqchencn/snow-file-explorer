/**
 * 顶栏 Git 同步指示器 (src/components/git-sync-indicator.ts)
 *
 * 「文件夹名」右侧的极简同步控件（对齐 IDEA 顶栏同步图标）：
 *   - 只保留一组上下箭头（↑↓ 双向箭头），**不含数字**；
 *   - 有未推送 / 未拉取提交时变**绿色**（不区分方向，方向看悬停提示）；
 *   - 全部同步时回到默认颜色；
 *   - 正在同步（pull/push/sync）时**颜色在绿色与默认色之间来回交替**（循环闪烁）。
 *
 * 顶栏空间有限：只展示状态 + 点击触发同步（pull → push 编排，与 syncBusy 一致）；
 *   逐条拉取 / 推送仍可在 Git 变更视图内完成。
 */

import { el } from "../utils/dom.ts";
import { createActionIcon } from "../icons/action-icons.ts";
import { gitSyncCounts } from "../services/git-service.ts";
import type { GitSyncSnapshot, TranslateFn } from "../types/panel-state.ts";

/** 顶栏同步指示器的入参。 */
export type GitSyncIndicatorOptions = {
  /** 插件内部翻译函数（带兜底文案与插值）。 */
  t: TranslateFn;
  /** 读取当前 git 状态切片；真源是 src/index.ts 的 state。 */
  getState: () => GitSyncSnapshot;
  /** 点击同步时的编排入口，收到当前状态切片。 */
  onSync: (snapshot: GitSyncSnapshot) => void;
};

/** 指示器的控制句柄。 */
export type GitSyncIndicatorHandle = {
  /** 按最新状态重绘图标着色、可点性与悬停文案。 */
  sync: () => void;
  /** 清空容器（面板卸载或工具栏重建时调用）。 */
  dispose: () => void;
};

/**
 * 渲染顶栏同步指示器。
 * @param container 容器（工具栏内常驻）
 * @param options 翻译函数、状态读取与同步触发入口
 * @returns 手动刷新与卸载句柄
 */
export function renderGitSyncIndicator(
  container: HTMLElement,
  { t, getState, onSync }: GitSyncIndicatorOptions,
): GitSyncIndicatorHandle {
  container.replaceChildren();

  const btn = el("button", "sfe-git-sync-indicator");
  btn.type = "button";
  btn.hidden = true;
  // 一组上下箭头；方向 / 着色由 CSS 按 .push/.pull/.syncing 控制。
  btn.appendChild(createActionIcon("sync", 14));
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    if (typeof onSync === "function") onSync(getState());
  });
  container.appendChild(btn);

  function sync(): void {
    // getState 在宿主里总返回对象字面量；这里保留 `|| {}` 兜底，并用 Partial 承接「兜底时字段全缺」
    const { gitStatus, gitBusy, gitSyncBusy }: Partial<GitSyncSnapshot> = getState() || {};
    const isRepo = !!(gitStatus && gitStatus.isRepo);
    if (!isRepo) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;

    const { ahead, behind } = gitSyncCounts(gitStatus);
    const hasChanges = ahead > 0 || behind > 0;
    // 同步中：颜色交替动画 + 禁用，避免重复触发。
    // gitBusy 里不会出现 "sync"（那是 gitSyncBusy 的取值），所以这里只按整链路标记与单独推送判定。
    const syncing = !!gitSyncBusy || gitBusy === "push";
    const busy = gitBusy !== null && gitBusy !== undefined;
    btn.classList.toggle("syncing", syncing);
    // 有未推送 / 未拉取即「待同步」→ 绿色高亮（不区分方向，方向看提示文案）。
    btn.classList.toggle("dirty", !syncing && hasChanges);
    // 无待同步（已是最新）或同步 / 忙碌中：不可点击；只有真正有待同步时才可点。
    btn.disabled = syncing || busy || !hasChanges;

    const parts: string[] = [];
    if (ahead > 0) parts.push(t("git.aheadCount", "{{count}} 个提交待推送", { count: ahead }));
    if (behind > 0) parts.push(t("git.behindCount", "{{count}} 个提交待拉取", { count: behind }));
    const title = syncing
      ? t("git.syncing", "正在同步…")
      : parts.length
        ? parts.join(" · ")
        : t("git.synced", "已是最新");
    if (btn.title !== title) btn.title = title;
    btn.setAttribute("aria-label", title);
  }

  sync();
  return {
    sync,
    dispose() {
      container.replaceChildren();
    },
  };
}
