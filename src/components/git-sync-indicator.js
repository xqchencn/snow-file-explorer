/**
 * 顶栏 Git 同步指示器 (src/components/git-sync-indicator.js)
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

import { el } from "../utils/dom.js";
import { createActionIcon } from "../icons/action-icons.js";
import { gitSyncCounts } from "../services/git-service.js";

/**
 * 渲染顶栏同步指示器。
 * @param {HTMLElement} container 容器（工具栏内常驻）
 * @param {Object} options
 * @param {Function} options.t 翻译函数
 * @param {Function} options.getState 读取 { gitStatus, gitBusy, gitSyncBusy }
 * @param {Function} options.onSync 点击触发同步：(状态对象) => void
 * @returns {{sync: Function, dispose: Function}}
 */
export function renderGitSyncIndicator(container, { t, getState, onSync }) {
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

  function sync() {
    const { gitStatus, gitBusy, gitSyncBusy } = getState() || {};
    const isRepo = !!(gitStatus && gitStatus.isRepo);
    if (!isRepo) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;

    const { ahead, behind } = gitSyncCounts(gitStatus);
    const hasChanges = ahead > 0 || behind > 0;
    // 同步中：颜色交替动画 + 禁用，避免重复触发。
    const syncing = !!gitSyncBusy || gitBusy === "sync" || gitBusy === "pull" || gitBusy === "push";
    const busy = gitBusy !== null && gitBusy !== undefined;
    btn.classList.toggle("syncing", syncing);
    // 有未推送 / 未拉取即「待同步」→ 绿色高亮（不区分方向，方向看提示文案）。
    btn.classList.toggle("dirty", !syncing && hasChanges);
    // 无待同步（已是最新）或同步 / 忙碌中：不可点击；只有真正有待同步时才可点。
    btn.disabled = syncing || busy || !hasChanges;

    const parts = [];
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
