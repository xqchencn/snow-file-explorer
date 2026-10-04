/**
 * 内嵌运行面板组件 (src/components/run-panel.js)
 *
 * 对标 IDEA 的 Run 工具窗口
 * （https://www.jetbrains.com/help/idea/run-tool-window.html ：
 *  「运行多个应用时，每个应用各占一个以其运行配置命名的标签页」）：
 *   - 一次运行占一个 tab，tab 名 = 运行配置（命令）名；多个运行 = 多个 tab；
 *   - tab 内 toolbar 只放当前运行的动作：Rerun / Stop / Clear（IDEA 的 Run toolbar）；
 *   - 输出区每个 tab 独立，切换 tab 时显示对应输出并恢复各自的滚动位置；
 *   - 面板只在存在运行记录时出现（IDEA：Run 窗口只在运行后出现）。
 *
 * 与旧版的差异（用户反馈「设计冗余、布局不合理」）：
 *   - 删掉常驻的「命令列表」按钮区——命令入口归右上角 Run 控件与右键菜单；
 *   - 删掉头部「项目类型 / 入口」信息条——tab 名已表达「在跑什么」。
 *
 * 组件不持有业务状态：运行集合由调用方（index.js 的 state.runs）持有，通过 getRuns() 读取。
 *
 * 为什么输出必须自渲染：宿主 ptyCreate 建的是无头 PTY，不创建可见终端标签页，
 *   插件也没有 API 让宿主开一个 attach 到该 ptyId 的标签页（见 docs/project-runner-design.md §6.3）。
 */

import { el } from "../utils/dom.js";
import { createActionIcon } from "../icons/action-icons.js";
import { runLabel } from "../services/run-store.js";

/** 输出区最多保留的字符数：超出则裁剪头部，避免长跑进程把内存吃满。 */
export const MAX_OUTPUT_CHARS = 200000;

/**
 * 裁剪触发阈值（> MAX_OUTPUT_CHARS）。
 * @description 若「超过 MAX 就立刻整体重写」，持续输出的长跑进程会每次追加都重写整块 DOM，
 *   退化成 O(n²)。允许先超额累积到本阈值再裁剪一次，两次重写之间至少新增
 *   (TRIM_THRESHOLD_CHARS - MAX_OUTPUT_CHARS) 字符，把重写成本摊销到接近 O(1)/字符。
 */
export const TRIM_THRESHOLD_CHARS = MAX_OUTPUT_CHARS + 40000;

/**
 * 判断输出容器是否已滚到底部附近（用于决定是否自动跟随）。
 * @param {HTMLElement} node 输出容器
 * @returns {boolean}
 */
function isNearBottom(node) {
  if (!node) return true;
  return node.scrollHeight - node.scrollTop - node.clientHeight < 48;
}

/**
 * 把毫秒格式化为紧凑时长（1.2s / 1m02s / 1h02m）。
 * @param {number} ms 毫秒
 * @returns {string}
 */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalSec = ms / 1000;
  if (totalSec < 10) return `${totalSec.toFixed(1)}s`;
  const sec = Math.floor(totalSec);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${String(sec % 60).padStart(2, "0")}s`;
  const hour = Math.floor(min / 60);
  return `${hour}h${String(min % 60).padStart(2, "0")}m`;
}

/**
 * 计算运行耗时文案。
 * @description 运行中按 now 实时计算；已结束用 endTime - startTime 的固定值。
 * @param {Object|null} run 运行记录
 * @param {number} now 当前时间戳
 * @returns {string} 空串表示不展示
 */
function formatElapsed(run, now) {
  if (!run || !run.startTime) return "";
  const end = run.endTime || now;
  return formatDuration(end - run.startTime);
}

/**
 * 渲染运行面板（IDEA 式 tabs）。
 * @param {HTMLElement} container 面板容器（常驻 layout，不随视图切换重建）
 * @param {Object} options
 * @param {Function} options.t 翻译函数
 * @param {Function} options.getRuns 读取运行集合 Array<run>
 * @param {Function} options.getActiveId 读取当前激活的 run id
 * @param {Function} [options.onSelectTab] 点击 tab：(id) => void
 * @param {Function} [options.onRerun] 点击重新运行：(id) => void
 * @param {Function} [options.onStop] 点击停止：(id) => void
 * @param {Function} [options.onClear] 点击清空输出：(id) => void
 * @param {Function} [options.onClose] 关闭某个 tab（停止 + 移除）：(id) => void
 * @param {Function} [options.onMinimize] 最小化整个运行面板（不终止进程）
 * @param {Function} [options.onCloseAll] 关闭整个运行面板（清空运行记录；仍有任务运行时由调用方退化为最小化）
 * @returns {{appendOutput: (runId: string, text: string) => void, syncStatus: () => void, rebuild: () => void, captureScroll: () => void}}
 */
export function renderRunPanel(container, options) {
  const {
    t,
    getRuns,
    getActiveId,
    onSelectTab,
    onRerun,
    onStop,
    onClear,
    onClose,
    onMinimize,
    onCloseAll,
  } = options;

  container.replaceChildren();

  // ── tab 栏：每个运行一个 tab（tab 名 = 运行配置名）+ 右端「最小化 / 关闭」 ──
  const tabsBar = el("div", "sfe-run-tabs");
  const tabList = el("div", "sfe-run-tab-list");
  tabList.setAttribute("role", "tablist");
  tabsBar.appendChild(tabList);

  // 顶部两个独立按钮：关闭（清空全部运行记录）+ 最小化（始终保留）。
  //   用户诉求：即使全部任务已结束也要保留最小化按钮，且最小化按钮排在关闭按钮之后。
  //   最小化只隐藏面板、保留输出；关闭才清空记录（仍有任务运行时关闭退化为最小化，见 index.js 守卫）。
  const closeBtn = el("button", "sfe-run-collapse close");
  closeBtn.type = "button";
  closeBtn.appendChild(createActionIcon("close", 13));
  closeBtn.addEventListener("click", () => {
    if (typeof onCloseAll === "function") onCloseAll();
  });
  tabsBar.appendChild(closeBtn);

  const minimizeBtn = el("button", "sfe-run-collapse minimize");
  minimizeBtn.type = "button";
  minimizeBtn.appendChild(createActionIcon("minus", 13));
  minimizeBtn.addEventListener("click", () => {
    if (typeof onMinimize === "function") onMinimize();
  });
  tabsBar.appendChild(minimizeBtn);
  container.appendChild(tabsBar);

  // ── toolbar：当前 tab 的动作（对齐 IDEA Run toolbar 的 Rerun / Stop / Clear） ──
  const toolbar = el("div", "sfe-run-pane-toolbar");
  const badge = el("span", "sfe-run-badge");
  const currentCmd = el("code", "sfe-run-current");
  currentCmd.hidden = true;
  const elapsed = el("span", "sfe-run-elapsed");
  elapsed.hidden = true;
  toolbar.appendChild(badge);
  toolbar.appendChild(currentCmd);
  toolbar.appendChild(elapsed);

  const actions = el("div", "sfe-run-actions");
  const rerunBtn = makeAction("refresh", "run.restart", "重新运行");
  const stopBtn = makeAction("square", "run.stop", "停止");
  const clearBtn = makeAction("eraser", "run.clear", "清空输出");
  actions.appendChild(rerunBtn);
  actions.appendChild(stopBtn);
  actions.appendChild(clearBtn);
  toolbar.appendChild(actions);
  container.appendChild(toolbar);

  // ── 输出区：等宽、可滚动、可选中复制 ──
  const output = el("pre", "sfe-run-output");
  output.setAttribute("role", "log");
  output.setAttribute("aria-live", "polite");
  container.appendChild(output);

  /** 构造一个 toolbar 动作按钮（图标 + 文案）。 */
  function makeAction(icon, key, fallback) {
    const btn = el("button", "sfe-run-action");
    btn.type = "button";
    btn.title = t(key, fallback);
    btn.appendChild(createActionIcon(icon, 12));
    btn.appendChild(el("span", null, t(key, fallback)));
    return btn;
  }

  /** 当前运行集合（防御调用方返回非数组）。 */
  function runList() {
    const runs = typeof getRuns === "function" ? getRuns() : null;
    return Array.isArray(runs) ? runs : [];
  }

  /** 当前激活的 run：优先 activeId，否则退化为第一条。 */
  function activeRun() {
    const list = runList();
    const id = typeof getActiveId === "function" ? getActiveId() : null;
    return list.find((r) => r && r.id === id) || list[0] || null;
  }

  /** 状态徽章文案（复用 run.status.* 文案）。 */
  function statusText(run) {
    const status = run && run.status ? run.status : "idle";
    if (status === "starting") return t("run.status.starting", "启动中…");
    if (status === "running") return t("run.status.running", "运行中");
    if (status === "exited") return t("run.status.exited", "已退出（代码 {{code}}）", { code: run.exitCode });
    if (status === "stopped") return t("run.status.stopped", "已停止");
    if (status === "failed") return t("run.status.failed", "启动失败");
    return t("run.status.idle", "待运行");
  }

  // 每个 tab 的 DOM 引用：id → { tab, dot }（syncStatus 时按状态更新，不重建）。
  let tabNodes = new Map();
  // 当前输出区展示的 run id：appendOutput 只更新它，其他 run 的输出等切过去再显示。
  let outputRunId = null;
  // 当前输出区已累积的字符数。用于 O(1) 判断是否超限，避免每次追加都读取整块 DOM 文本。
  let outputChars = 0;
  // 启动期占位提示节点（无输出时显示「启动中…」，有输出即移除）。
  let idleHint = null;

  /** 重建 tab 栏（运行集合变化时才需要）。 */
  function renderTabs() {
    tabList.replaceChildren();
    tabNodes = new Map();
    for (const run of runList()) {
      const tab = el("button", "sfe-run-tab");
      tab.type = "button";
      tab.title = run.cmd;
      const dot = el("span", "sfe-run-tab-dot");
      const label = el("span", "sfe-run-tab-label", runLabel(run, t));
      const close = el("span", "sfe-run-tab-close");
      close.title = t("run.closeTab", "关闭");
      close.appendChild(createActionIcon("close", 10));
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        if (typeof onClose === "function") onClose(run.id);
      });
      tab.appendChild(dot);
      tab.appendChild(label);
      tab.appendChild(close);
      tab.addEventListener("click", () => {
        if (typeof onSelectTab === "function") onSelectTab(run.id);
      });
      tabNodes.set(run.id, { tab, dot });
      tabList.appendChild(tab);
    }
  }

  /** 同步 tab 的状态点与激活态（不重建 tab 栏，避免打断点击）。 */
  function syncTabs() {
    const active = activeRun();
    const currentId = active ? active.id : null;
    const list = runList();
    for (const [id, node] of tabNodes) {
      const run = list.find((r) => r && r.id === id);
      const status = run && run.status ? run.status : "idle";
      node.tab.className = `sfe-run-tab status-${status}`;
      node.tab.classList.toggle("active", id === currentId);
      node.tab.setAttribute("aria-selected", id === currentId ? "true" : "false");
    }
  }

  /** 同步 toolbar（徽章 / 命令 / 耗时 / 按钮显隐）与 tab 状态。 */
  function renderStatus() {
    const run = activeRun();
    const status = run && run.status ? run.status : "idle";
    badge.className = `sfe-run-badge status-${status}`;
    badge.textContent = statusText(run);

    const cmdText = run && run.cmd ? run.cmd : "";
    currentCmd.textContent = cmdText;
    currentCmd.title = cmdText;
    currentCmd.hidden = !cmdText;

    const active = status === "running" || status === "starting";
    // Rerun：有运行记录且不在运行中（运行中先停止，避免重复进程）。
    rerunBtn.hidden = !(run && run.cmd && !active);
    stopBtn.hidden = !active;
    // 无运行记录时清空按钮无意义。
    clearBtn.hidden = !run;

    const elapsedText = formatElapsed(run, Date.now());
    elapsed.textContent = elapsedText;
    elapsed.hidden = !elapsedText;

    syncPanelBtn();
    syncTabs();
    // 状态变化可能改变占位提示的显隐：starting→running 保持、running→exited 移除、
    // 启动失败(failed)且无输出时也必须移除（否则占位「启动中…」会一直挂在那里）。
    renderIdleHint();
  }

  /** 顶部按钮文案：最小化与关闭各固定语义，不再随任务状态互斥切换。 */
  function syncPanelBtn() {
    minimizeBtn.title = t("run.minimize", "最小化运行面板");
    minimizeBtn.setAttribute("aria-label", minimizeBtn.title);
    closeBtn.title = t("run.closeAll", "关闭运行面板");
    closeBtn.setAttribute("aria-label", closeBtn.title);
  }

  /**
   * 启动期占位提示：命令已发出但还没有任何输出时，显示「正在启动…」。
   * @description 为什么需要：pty 创建 + shell 冷启动 + npm 解析约 600~900ms，
   *   期间输出区全空白，用户会以为「点了没反应」。给出即时文案，交互才有反馈。
   *   只在「启动中/运行中 且 当前无任何输出」时显示，一旦有输出立即移除。
   */
  function renderIdleHint() {
    const run = activeRun();
    const empty = !run || !run.output;
    const active = !!run && (run.status === "running" || run.status === "starting");
    if (!empty || !active) {
      // 移除即可，无需 isConnected 守卫：remove() 对未挂载/已移除节点是安全幂等的。
      // 用 isConnected 做守卫会在节点未挂载时漏移除，留下幽灵占位。
      if (idleHint) idleHint.remove();
      idleHint = null;
      return;
    }
    // 判据用 parentNode 而非 isConnected：容器未挂到 document 时 isConnected 恒为 false，
    // 会导致每次状态刷新都重复新建占位节点。以「是否已在输出区内」为准才与挂载状态无关。
    if (!idleHint || idleHint.parentNode !== output) {
      idleHint = el("div", "sfe-run-output-hint");
      output.appendChild(idleHint);
    }
    idleHint.textContent = t("run.status.starting", "启动中…");
  }

  /** 全量重建：tab 栏 + 输出区（运行集合变化 / 切换 tab 时调用）。 */
  function rebuild() {
    renderTabs();
    const run = activeRun();
    outputRunId = run ? run.id : null;
    idleHint = null;
    const full = run ? run.output || "" : "";
    output.textContent = full;
    outputChars = full.length;
    // renderStatus 内部已同步占位提示（renderIdleHint），此处不再重复调用。
    renderStatus();
    if (run && Number.isFinite(run.scrollTop)) output.scrollTop = run.scrollTop;
    else output.scrollTop = output.scrollHeight;
  }

  // 首次渲染
  rebuild();

  rerunBtn.addEventListener("click", () => {
    const run = activeRun();
    if (run && typeof onRerun === "function") onRerun(run.id);
  });
  stopBtn.addEventListener("click", () => {
    const run = activeRun();
    if (run && typeof onStop === "function") onStop(run.id);
  });
  clearBtn.addEventListener("click", () => {
    const run = activeRun();
    if (run && typeof onClear === "function") onClear(run.id);
  });

  return {
    /**
     * 增量追加输出（仅更新当前展示的 tab；自动跟随到底部，用户已上滚时不打扰）。
     * @description 性能关键：绝不能写 `output.textContent = output.textContent + chunk`——
     *   那会读取整块已累积文本再整体回写，触发整个 <pre> 重新解析与布局，复杂度 O(n²)，
     *   输出越长每次追加越慢（实测 400KB 时慢 16 倍）。改为 appendChild(TextNode) 只触碰尾部，
     *   复杂度 O(chunk)，与已累积输出量无关。
     *   超限时才整体重写为尾部片段（低频操作，可接受一次性成本）。
     */
    appendOutput(runId, text) {
      const chunk = String(text == null ? "" : text);
      if (!chunk) return;
      if (runId !== outputRunId) return;
      // 有真实输出即移除启动期占位提示（remove() 幂等，无需 isConnected 守卫）。
      if (idleHint) {
        idleHint.remove();
        idleHint = null;
      }
      const follow = isNearBottom(output);
      if (outputChars + chunk.length > TRIM_THRESHOLD_CHARS) {
        // 达到裁剪阈值：整体重写为尾部片段（含本次 chunk），并提示已裁剪。
        // 用阈值而非 MAX 触发，保证两次重写之间至少新增 slack 字符，避免每次追加都重写。
        const merged = output.textContent + chunk;
        const tail = merged.slice(merged.length - MAX_OUTPUT_CHARS);
        output.textContent = t("run.outputTruncated", "[输出过长，已裁剪早期内容]\n") + tail;
        outputChars = tail.length;
      } else {
        // 增量：只在末尾追加文本节点，不触碰既有 DOM。
        output.appendChild(document.createTextNode(chunk));
        outputChars += chunk.length;
      }
      if (follow) output.scrollTop = output.scrollHeight;
    },
    /** 状态变化后刷新徽章、按钮与 tab 状态（不重建 DOM，保住滚动位置）。 */
    syncStatus: renderStatus,
    /** 重新读取运行集合与输出（清空、切换 tab 等场景）。 */
    rebuild,
    /** 切换 tab 前把当前输出区滚动位置写回对应 run，切回时可恢复。 */
    captureScroll() {
      const run = activeRun();
      if (run && outputRunId === run.id) run.scrollTop = output.scrollTop;
    },
  };
}
