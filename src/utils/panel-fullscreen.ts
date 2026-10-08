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
  // 宿主右面板有稳定的 data-snow-anchor；全屏时按钮仍在右面板的 tab actions 内。
  // React 重建 tab 区时短暂可能有两个同名按钮，必须优先取与当前 DOM 状态一致的那颗，
  // 否则“发送到对话框”会点击到旧节点，代码编辑器就会一直卡在全屏。
  const scopedButtons = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-snow-anchor="rightPanel"] .right-panel-fullscreen-btn, ' +
        '[data-snow-anchor="rightPanel"].right-panel-fullscreen-btn, ' +
        '[data-snow-anchor="rightPanel"] .right-panel .right-panel-fullscreen-btn, ' +
        '[data-snow-anchor="rightPanel"].right-panel .right-panel-fullscreen-btn',
    ),
  );
  // class 可能还没提交，但 React 已先把当前按钮改成 Exit；两种信号都要纳入判断，
  // 否则会从多个同名按钮里误点“进入全屏”的旧节点。全屏 class 已存在时，
  // 优先从当前全屏面板找按钮，不依赖 aria-label 的语言。
  const exiting =
    hasFullscreenClass() ||
    scopedButtons.some((button) => isFullscreenExitLabel(button.getAttribute("aria-label")));
  const activePanelButtons = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".right-panel.fullscreen .right-panel-fullscreen-btn, " +
        ".app-shell.right-panel-fullscreen .right-panel-fullscreen-btn",
    ),
  );
  const activePanelButton =
    activePanelButtons.find((button) => {
      const label = button.getAttribute("aria-label");
      return exiting ? isFullscreenExitLabel(label) : !isFullscreenExitLabel(label);
    }) || activePanelButtons[0];
  const currentStateButton = scopedButtons.find((button) => {
    const label = button.getAttribute("aria-label") || "";
    return exiting ? isFullscreenExitLabel(label) : !isFullscreenExitLabel(label);
  });
  const btn =
    activePanelButton ||
    currentStateButton ||
    scopedButtons[0] ||
    document.querySelector<HTMLElement>(
      ".right-panel.fullscreen .right-panel-fullscreen-btn",
    ) ||
    document.querySelector<HTMLElement>(
      ".right-panel .right-panel-fullscreen-btn",
    ) ||
    document.querySelector<HTMLElement>(".right-panel-fullscreen-btn");
  if (btn && typeof btn.click === "function") {
    btn.click();
    return true;
  }
  return false;
}

function isFullscreenExitLabel(label: string | null): boolean {
  return /\bexit\b|退出/i.test(label || "");
}

/**
 * 读取宿主当前是否已经把按钮切到“退出全屏”语义。
 * @description React 更新 class 与按钮 aria-label 不是同一个提交瞬间；按钮语义是退出路径的第二个可靠信号。
 */
function hasFullscreenExitButton(): boolean {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-snow-anchor="rightPanel"] .right-panel-fullscreen-btn, ' +
        '[data-snow-anchor="rightPanel"].right-panel-fullscreen-btn, ' +
        '[data-snow-anchor="rightPanel"] .right-panel .right-panel-fullscreen-btn, ' +
        '[data-snow-anchor="rightPanel"].right-panel .right-panel-fullscreen-btn, ' +
        '.right-panel .right-panel-fullscreen-btn',
    ),
  ).some((button) => isFullscreenExitLabel(button.getAttribute("aria-label")));
}

/**
 * 等待宿主 React 把全屏状态提交到 DOM。
 * @description click() 只同步派发事件，宿主 setState 的 class 更新不是同步副作用；
 *   固定只等几帧会在机器忙或 React 批处理时误报“退出失败”。
 */
async function waitForFullscreenState(expected: boolean): Promise<boolean> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (isRightPanelFullscreen() === expected) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
  return isRightPanelFullscreen() === expected;
}

/**
 * 等待退出动作完成。
 * @description 面板 class 是宿主真正控制布局的状态；旧 React 节点可能暂时仍保留 Exit 文案，
 *   不能把按钮文案当成退出失败条件，否则已退出的面板会被误报为失败。
 */
async function waitForFullscreenExit(requireButtonClear = false): Promise<boolean> {
  const deadline = Date.now() + 1000;
  let stableUntil = 0;
  while (Date.now() < deadline) {
    if (!hasFullscreenClass() && (!requireButtonClear || !hasFullscreenExitButton())) {
      // React 的 setState 可能还有一批依赖布局的更新；保持一小段稳定窗口，
      // 若异步停靠逻辑又切回全屏，交给外层安全重试，而不是过早报告成功。
      if (!stableUntil) stableUntil = Date.now() + 120;
      if (Date.now() >= stableUntil) return true;
    } else {
      stableUntil = 0;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
  return !hasFullscreenClass() && (!requireButtonClear || !hasFullscreenExitButton());
}

function hasFullscreenClass(): boolean {
  return !!document.querySelector(".right-panel.fullscreen, .app-shell.right-panel-fullscreen");
}

/**
 * 判断宿主右侧面板是否处于全屏态
 * @returns 是否全屏
 */
export function isRightPanelFullscreen(): boolean {
  // 这是布局真状态，必须只看宿主 class；按钮文案可能在 React 重建期间残留，
  // 不能让发送完成后的状态校验把“已退出”误判成仍全屏。
  return hasFullscreenClass();
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
  return waitForFullscreenState(true);
}

/**
 * 退出宿主右面板全屏（全屏按钮是切换钮：全屏态下点击即还原）。
 * @description 宿主全屏状态由 React 异步更新，点击按钮后必须等待 DOM class 摘除并确认结果。
 *   「发送到对话框」依赖聊天视图回位后输入框挂载，全屏态必须先退出（用户方案）。
 * @returns 是否已退出全屏（本就不在全屏也返回 true）
 */
export async function exitRightPanelFullscreen(): Promise<boolean> {
  // class 与 React 按钮文案可能短暂不同步；只要当前按钮明确是 Exit，就不能提前返回。
  const classSaysFullscreen = hasFullscreenClass();
  const buttonSaysExit = hasFullscreenExitButton();
  const needsExit = classSaysFullscreen || buttonSaysExit;
  if (!needsExit) return true;
  const requireButtonClear = !classSaysFullscreen && buttonSaysExit;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0 && !hasFullscreenClass() && !hasFullscreenExitButton()) return true;
    if (!requestRightPanelFullscreen()) return false;
    // 只有 class 尚未出现时，才需要等按钮自身完成卸载/切回；正常全屏路径只看 class，
    // 避免旧 React 节点残留 Exit 文案把已经退出的面板误报为失败。
    if (await waitForFullscreenExit(requireButtonClear)) return true;
  }
  return false;
}
