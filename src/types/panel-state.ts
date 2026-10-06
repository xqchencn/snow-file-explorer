/**
 * 面板状态词汇（跨 index.ts 与组件层流转的形状）。
 *
 * 为什么单独成文件：这些形状的真源是 `src/index.ts` 里的 `state` 对象与 `runGitAction(busy, fn)`
 * 队列，组件只消费其中一部分切片。组件各自内联声明会漂，集中一处由我按调用点取证。
 *
 * Git 忙碌标签的取值来自 `src/index.ts` 的 `runGitAction` 调用点与顶栏同步编排；
 * 新增取值时同步更新本联合类型，否则组件里的比较会变成永假。
 */

import type { GitStatusResult } from "./host/host-git.ts";

/**
 * 正在执行的 Git 写操作标签，用于忙碌态互斥与按钮文案。
 *
 * 取值来源（逐个取自赋值点，不是设想）：`src/index.ts` 里 `runGitAction` 的实参 `stage` /
 * `unstage` / `stageAll` / `unstageAll` / `commit` / `commitAndPush` / `discard`，
 * `handleCommitAndPush` 内直赋的 `push`，以及只落到 `gitSyncBusy` 的 `sync`（`handleSync` 内）。
 * 拉取动作在 `src/services/git-actions.ts` 的 `gitPull` 里只作为同步编排的内部步骤存在，从不单独置忙碌态，
 * 所以本联合里没有 `pull`。
 */
export type GitOperation =
  | "stage"
  | "unstage"
  | "stageAll"
  | "unstageAll"
  | "commit"
  | "commitAndPush"
  | "push"
  | "discard"
  | "sync";

/** 顶栏同步指示器读取的状态切片（`getState()` 的返回）。 */
export type GitSyncSnapshot = {
  /** 最近一次拉取的仓库状态；未加载、非仓库或目录切换后为 null。 */
  gitStatus: GitStatusResult | null;
  /** Git 写操作队列当前正在执行的动作；空闲时为 null。 */
  gitBusy: GitOperation | null;
  /**
   * 顶栏「同步」（先 pull 后 push）编排的进行态。
   * @description 与 `gitBusy` 分开：单条拉取/推送走队列，整链路同步走顶栏按钮，
   *              两者叠加才算真正忙碌。空闲时为 null。
   */
  gitSyncBusy: GitOperation | null;
};

/**
 * 插件内部的翻译函数（对宿主 `api.t` 的一层包装，带兜底文案与插值取值）。
 * @description 组件层（diff-view / git-view / tree-view）此前各自内联同一份签名，
 *   漂移过一次（有的把 fallback 写成必填），一律改引本声明。
 *   `fallback` 可缺：宿主 `api.t` 在词条缺失时会依次退回 defaultValue、插件名、
 *   最后 key 本身（宿主 `src/renderer/plugins/pluginApi.ts:185-189`），所以只传 key 也能拿到字符串。
 *   `src/index.ts` 的包装函数在无宿主环境时按 `fallback ?? key` 回退，声明的 `string` 成立。
 */
export type TranslateFn = (
  /** 词条 key，如 `git.aheadCount`。 */
  key: string,
  /** 词条缺失时使用的兜底文案；省略时由宿主回退到 key 本身。 */
  fallback?: string,
  /** `{{name}}` 占位符的替换表；省略时不插值。 */
  values?: Record<string, string | number>,
) => string;

/**
 * 差异展示模式：跨层流转的视图选择，既是持久化开关（`services/settings.ts` 写 storage），
 * 也是渲染分派入参（`services/diff.ts`、`components/diff-view.ts`）。
 * @description 此前 settings.ts 与 diff.ts 各声明一份同形联合，改引本处为唯一真源。
 * - `unified`：单列，删除行在上、新增行在下。
 * - `split`：左右两栏配对。
 */
export type DiffViewMode = "unified" | "split";

/**
 * HTTP 请求文件的查看形态。
 * - `gui`：每条请求一张卡片（方法 / 地址 / 头部表 / 请求体 / 发送 / 响应）。
 * - `text`：走代码查看器看文件原文，可编辑可保存。
 * @description 与 `git` 的「差异 / 内容」、Markdown 的「预览 / 代码」同属查看器二级切换，
 *   持久化开关在 `services/settings.ts`。
 */
export type HttpViewerMode = "gui" | "text";
