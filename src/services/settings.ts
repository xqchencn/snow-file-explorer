/**
 * 视图设置持久化模块 (src/services/settings.ts)
 * 通过宿主 api.storage 保存插件私有开关，跨会话记忆用户选择。
 * 差异展示模式 `DiffViewMode` 的真源在 `src/types/panel-state.ts`（渲染层与持久化共用一份），本模块只引用不再声明。
 */

import type { PluginStorageApi } from "../types/plugin-runtime.ts";
import type { DiffViewMode } from "../types/panel-state.ts";

const STORAGE_KEY = "viewSettings";

/**
 * 视图开关设置（本模块的持久化契约，来源文件即本模块）。
 */
export type ViewSettings = {
  /** 是否隐藏 .git/.svn/.hg/CVS/.DS_Store/Thumbs.db 等元数据条目。 */
  excludeMeta: boolean;
  /** 是否按 .gitignore 规则过滤条目。 */
  respectGitignore: boolean;
  /** JVM 项目的源码根目录是否使用紧凑包视图。 */
  javaPackageView: boolean;
};

/**
 * 宿主 storage 里可能出现的残缺形态：历史版本可能少写某个开关，缺失一律按默认值 true。
 */
export type PersistedViewSettings = {
  /** 是否隐藏元数据条目；缺失按 true。 */
  excludeMeta?: boolean;
  /** 是否按 .gitignore 过滤；缺失按 true。 */
  respectGitignore?: boolean;
  /** 是否使用 JVM 包视图；缺失按 true。 */
  javaPackageView?: boolean;
};

/**
 * 本模块用到的宿主运行时 API 子集：只依赖插件私有 KV 的 JSON 读写。
 * @description 宿主版本差异下 storage 或单个方法可能整体缺失，故逐层可选，
 *   读取失败一律回退默认值；方法签名取自宿主镜像 `PluginStorageApi`，不再手抄，
 *   所以 `getJson` 的 `fallback` 与宿主一样必填，调用点必须显式给出。
 */
export type SettingsRuntimeApi = {
  /** 插件私有持久化 KV 存储；只用到 JSON 读写两个方法，都可能缺省。 */
  storage?: Partial<Pick<PluginStorageApi, "getJson" | "setJson">> | null;
};

/**
 * 视图开关默认值
 */
export const DEFAULT_VIEW_SETTINGS: ViewSettings = Object.freeze({
  excludeMeta: true, // 排除 .git/.svn/.hg/CVS/.DS_Store/Thumbs.db
  respectGitignore: true, // 按 .gitignore 过滤
  javaPackageView: true, // JVM 项目默认使用紧凑包视图
});

/**
 * 归一化任意输入为合法设置对象（缺省即默认值）
 * @param saved 持久化数据
 * @returns 三个开关都补齐后的设置对象
 */
function normalize(saved: unknown): ViewSettings {
  const src: PersistedViewSettings = saved && typeof saved === "object" ? saved : {};
  return {
    excludeMeta: src.excludeMeta !== false,
    respectGitignore: src.respectGitignore !== false,
    javaPackageView: src.javaPackageView !== false,
  };
}

/**
 * 读取视图开关设置（失败回退默认值）
 * @param api 宿主插件运行时 API
 * @returns 补齐默认值后的视图开关
 */
export async function loadViewSettings(api: SettingsRuntimeApi | null): Promise<ViewSettings> {
  try {
    if (api && api.storage && typeof api.storage.getJson === "function") {
      // 偏离（已登记）：fallback 是宿主必填项；缺键时由 undefined 变 null，同为假值，默认值分支不变。
      const saved: unknown = await api.storage.getJson<unknown>(STORAGE_KEY, null);
      return normalize(saved);
    }
  } catch (err) {
    console.warn("[FileExplorer] 读取视图设置失败:", err);
  }
  return { ...DEFAULT_VIEW_SETTINGS };
}

/**
 * 保存视图开关设置（尽力而为，不抛异常）
 * @param api 宿主插件运行时 API
 * @param settings 设置对象
 */
export function saveViewSettings(api: SettingsRuntimeApi | null, settings: ViewSettings): void {
  try {
    if (api && api.storage && typeof api.storage.setJson === "function") {
      // 偏离（已登记）：宿主 setJson 是 async，外层同步 try/catch 挡不住它的拒绝——
      // 写失败原本会逃逸成 unhandled rejection，那句本意的 console.warn 一次都不会打。
      // 改挂 .catch 落回同一条告警；外层 try 仍留着兜同步抛错。
      api.storage.setJson(STORAGE_KEY, normalize(settings)).catch((err) => {
        console.warn("[FileExplorer] 保存视图设置失败:", err);
      });
    }
  } catch (err) {
    console.warn("[FileExplorer] 保存视图设置失败:", err);
  }
}

const DIFF_MODE_KEY = "diffViewMode";

/**
 * 读取差异展示模式偏好（unified / split），默认 unified
 * @param api 宿主插件运行时 API
 * @returns 已持久化的展示模式；值非法或未持久化时为 unified
 */
export async function loadDiffViewMode(api: SettingsRuntimeApi | null): Promise<DiffViewMode> {
  try {
    if (api && api.storage && typeof api.storage.getJson === "function") {
      // 同上：fallback 必填，undefined→null 不改变假值判定。
      const saved: unknown = await api.storage.getJson<unknown>(DIFF_MODE_KEY, null);
      if (saved === "split" || saved === "unified") return saved;
    }
  } catch (err) {
    console.warn("[FileExplorer] 读取差异展示模式失败:", err);
  }
  return "unified";
}

/**
 * 保存差异展示模式偏好（尽力而为，不抛异常）
 * @param api 宿主插件运行时 API
 * @param mode 展示模式
 */
export function saveDiffViewMode(api: SettingsRuntimeApi | null, mode: DiffViewMode): void {
  try {
    if (api && api.storage && typeof api.storage.setJson === "function") {
      // 同上：拒绝必须在这里落地，否则外层 try 抓不到（偏离已登记）。
      api.storage.setJson(DIFF_MODE_KEY, mode === "split" ? "split" : "unified").catch((err) => {
        console.warn("[FileExplorer] 保存差异展示模式失败:", err);
      });
    }
  } catch (err) {
    console.warn("[FileExplorer] 保存差异展示模式失败:", err);
  }
}

// 差异范围固定显示完整文件，不再持久化范围切换偏好。
