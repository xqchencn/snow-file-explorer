/**
 * 运行集合状态机 (src/services/run-store.js)
 *
 * 职责：维护「多个 run」的集合与当前激活项，全部为纯函数，便于单测。
 *
 * 为什么需要它：IDEA 的 Run 工具窗口一次运行占一个 tab、可同时存在多个 tab
 *   （见 https://www.jetbrains.com/help/idea/run-tool-window.html ），
 *   因此运行状态必须是**集合**而非单对象。把集合的增删改与激活项选择抽成纯函数后，
 *   index.js 只负责 IO 与渲染，测试无需 DOM。
 *
 * 约定：
 *   - run.id = 命令 id（如 `npm:dev`）——同一命令复用同一条目（IDEA：Rerun 复用同一 tab）。
 *   - status ∈ starting | running | exited | stopped | failed
 */

/** 视为「进行中」的状态（含启动中，用于防重复运行与计时）。 */
export function isActiveStatus(status) {
  return status === "running" || status === "starting";
}

/**
 * 新建一条运行记录（尚未启动）。
 * @param {{id?: string, cmd: string, labelKey?: string|null, labelFallback?: string, now?: number}} init
 * @returns {Object}
 */
export function createRun({ id, cmd, labelKey = null, labelFallback = "", now = Date.now() }) {
  return {
    id: String(id || cmd || ""),
    cmd: String(cmd || ""),
    // 标签本地化所需的两份信息：labelKey 命中时走 t()，否则用 labelFallback 原文。
    labelKey: labelKey || null,
    labelFallback: String(labelFallback || cmd || ""),
    status: "starting",
    exitCode: null,
    output: "",
    stop: null,
    ptyId: null,
    startTime: now,
    endTime: null,
  };
}

/**
 * 复位一条运行记录以重新运行：清空输出与上一次结果（IDEA 的 Rerun）。
 * @param {Object} run 运行记录
 * @param {number} [now] 当前时间戳
 * @returns {Object} 同一条记录
 */
export function resetRun(run, now = Date.now()) {
  run.status = "starting";
  run.exitCode = null;
  run.output = "";
  run.stop = null;
  run.ptyId = null;
  run.startTime = now;
  run.endTime = null;
  return run;
}

/**
 * 按 id 查找运行记录。
 * @param {Array<Object>} runs 运行集合
 * @param {string} id 运行 id
 * @returns {Object|null}
 */
export function findRun(runs, id) {
  if (!Array.isArray(runs) || !id) return null;
  return runs.find((r) => r && r.id === id) || null;
}

/**
 * 集合中是否存在进行中的 run。
 * @param {Array<Object>} runs 运行集合
 * @returns {boolean}
 */
export function hasActiveRun(runs) {
  return Array.isArray(runs) && runs.some((r) => r && isActiveStatus(r.status));
}

/**
 * 选择激活的 run id：优先保留 preferredId（仍存在时），否则取第一条；空集合返回 null。
 * @param {Array<Object>} runs 运行集合
 * @param {string|null} preferredId 期望保留的 id
 * @returns {string|null}
 */
export function pickActiveRunId(runs, preferredId) {
  const list = Array.isArray(runs) ? runs : [];
  if (!list.length) return null;
  if (preferredId && list.some((r) => r && r.id === preferredId)) return preferredId;
  return list[0].id;
}

/**
 * 移除一条运行记录（不负责停止进程，由调用方先停止）。
 * @param {Array<Object>} runs 运行集合
 * @param {string} id 运行 id
 * @returns {Object|null} 被移除的记录；不存在时返回 null
 */
export function removeRun(runs, id) {
  if (!Array.isArray(runs)) return null;
  const index = runs.findIndex((r) => r && r.id === id);
  if (index < 0) return null;
  return runs.splice(index, 1)[0];
}

/**
 * 创建「同命令启动去重」判定器（纯函数工厂，便于单测）。
 * @description 一次用户操作可能被派发成多次启动调用（双击 / 连点 / 事件重复 / 面板重复挂载），
 *   若每次都 startCommand 就会并发创建多个 pty，同一条命令被跑多遍（面板里命令与 exit 回显重复）。
 *   判定器按命令 id 记录最近一次「通过」的时间，窗口内的重复调用返回 true（调用方应跳过启动）；
 *   窗口之外的调用返回 false，视为明确的重新运行意图。
 *   注意：判定器是**有状态**的（内部 Map），但状态只与传入的 runId/now 有关，行为完全可预测、可单测。
 * @param {number} [windowMs=300] 去重窗口（毫秒）
 * @returns {(runId: string, now?: number) => boolean} 返回 true 表示本次启动应被跳过
 */
export function createCommandDedup(windowMs = 300) {
  const lastAt = new Map();
  return function shouldSkipDuplicateStart(runId, now = Date.now()) {
    if (!runId) return false;
    const prev = lastAt.get(runId);
    if (prev !== undefined && now - prev < windowMs) return true;
    lastAt.set(runId, now);
    return false;
  };
}

/**
 * 取运行记录的展示标签（优先本地化 labelKey，否则回退原文）。
 * @param {Object} run 运行记录
 * @param {Function} [t] 翻译函数
 * @returns {string}
 */
export function runLabel(run, t) {
  if (!run) return "";
  if (run.labelKey && typeof t === "function") return t(run.labelKey, run.labelFallback);
  return run.labelFallback || run.cmd || "";
}
