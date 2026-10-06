/**
 * 宿主右侧面板全屏辅助 (src/utils/panel-fullscreen.ts)
 * @description 宿主全屏按钮 className 恒为 "icon-btn ghost right-panel-fullscreen-btn"，
 *   全屏状态由 .right-panel.fullscreen / .app-shell.right-panel-fullscreen 承载。
 *   代码预览与右侧停靠的终端都要先进入全屏，左侧才是侧栏宽度、右侧才铺满。
 * @description 纯 DOM 函数，无面板状态依赖；从 index.ts 原样迁出。
 */

/**
 * 触发宿主右面板全屏模式切换
 * @returns 是否成功触发
 */
export function requestRightPanelFullscreen(): boolean {
  const btn = document.querySelector<HTMLElement>(".right-panel-fullscreen-btn");
  if (btn && typeof btn.click === "function") {
    btn.click();
    return true;
  }
  return false;
}

/**
 * 判断宿主右侧面板是否处于全屏态
 * @returns 是否全屏
 */
export function isRightPanelFullscreen(): boolean {
  return !!document.querySelector(".right-panel.fullscreen, .app-shell.right-panel-fullscreen");
}

/**
 * 等待浏览器完成下一帧渲染。
 * @returns 下一帧回调完成
 */
export function waitForNextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function"
    ) {
      // 断言只用于对齐 Promise executor 的 resolve 与 DOM 回调形状：
      // FrameRequestCallback 声明入参 time:number，本实现忽略入参，故先落成零参函数。
      window.requestAnimationFrame(resolve as () => void);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * 确保宿主右侧面板进入全屏。
 * @description 宿主全屏状态由 React 异步更新，点击按钮后必须等待 DOM class 更新并确认结果。
 * @returns 是否已进入全屏
 */
export async function ensureRightPanelFullscreen(): Promise<boolean> {
  if (isRightPanelFullscreen()) return true;
  if (!requestRightPanelFullscreen()) return false;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await waitForNextFrame();
    if (isRightPanelFullscreen()) return true;
  }

  return false;
}
