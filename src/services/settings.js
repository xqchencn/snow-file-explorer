/**
 * 视图设置持久化模块 (src/services/settings.js)
 * 通过宿主 api.storage 保存插件私有开关，跨会话记忆用户选择。
 */

const STORAGE_KEY = "viewSettings";

/**
 * 视图开关默认值
 * @type {{excludeMeta: boolean, respectGitignore: boolean}}
 */
export const DEFAULT_VIEW_SETTINGS = Object.freeze({
  excludeMeta: true, // 排除 .git/.svn/.hg/CVS/.DS_Store/Thumbs.db
  respectGitignore: true, // 按 .gitignore 过滤
  onlyGitChanges: false, // 仅显示 Git 变更视图（默认关闭）
});

/**
 * 归一化任意输入为合法设置对象（缺省即默认值）
 * @param {Object|null} saved 持久化数据
 * @returns {{excludeMeta: boolean, respectGitignore: boolean, onlyGitChanges: boolean}}
 */
function normalize(saved) {
  const src = saved && typeof saved === "object" ? saved : {};
  return {
    excludeMeta: src.excludeMeta !== false,
    respectGitignore: src.respectGitignore !== false,
    onlyGitChanges: src.onlyGitChanges === true,
  };
}

/**
 * 读取视图开关设置（失败回退默认值）
 * @param {Object} api 宿主插件运行时 API
 * @returns {Promise<{excludeMeta: boolean, respectGitignore: boolean}>}
 */
export async function loadViewSettings(api) {
  try {
    if (api && api.storage && typeof api.storage.getJson === "function") {
      const saved = await api.storage.getJson(STORAGE_KEY);
      return normalize(saved);
    }
  } catch (err) {
    console.warn("[FileExplorer] 读取视图设置失败:", err);
  }
  return { ...DEFAULT_VIEW_SETTINGS };
}

/**
 * 保存视图开关设置（尽力而为，不抛异常）
 * @param {Object} api 宿主插件运行时 API
 * @param {{excludeMeta: boolean, respectGitignore: boolean}} settings 设置对象
 */
export function saveViewSettings(api, settings) {
  try {
    if (api && api.storage && typeof api.storage.setJson === "function") {
      api.storage.setJson(STORAGE_KEY, normalize(settings));
    }
  } catch (err) {
    console.warn("[FileExplorer] 保存视图设置失败:", err);
  }
}

const DIFF_MODE_KEY = "diffViewMode";

/**
 * 读取差异展示模式偏好（unified / split），默认 unified
 * @param {Object} api 宿主插件运行时 API
 * @returns {Promise<'unified'|'split'>}
 */
export async function loadDiffViewMode(api) {
  try {
    if (api && api.storage && typeof api.storage.getJson === "function") {
      const saved = await api.storage.getJson(DIFF_MODE_KEY);
      if (saved === "split" || saved === "unified") return saved;
    }
  } catch (err) {
    console.warn("[FileExplorer] 读取差异展示模式失败:", err);
  }
  return "unified";
}

/**
 * 保存差异展示模式偏好（尽力而为，不抛异常）
 * @param {Object} api 宿主插件运行时 API
 * @param {'unified'|'split'} mode 展示模式
 */
export function saveDiffViewMode(api, mode) {
  try {
    if (api && api.storage && typeof api.storage.setJson === "function") {
      api.storage.setJson(DIFF_MODE_KEY, mode === "split" ? "split" : "unified");
    }
  } catch (err) {
    console.warn("[FileExplorer] 保存差异展示模式失败:", err);
  }
}

const DIFF_SCOPE_MODE_KEY = "diffScopeMode";

/**
 * 读取差异范围模式偏好（full / hunks），默认 full（完整文件，对标 VS Code）
 * @param {Object} api 宿主插件运行时 API
 * @returns {Promise<'full'|'hunks'>}
 */
export async function loadDiffScopeMode(api) {
  try {
    if (api && api.storage && typeof api.storage.getJson === "function") {
      const saved = await api.storage.getJson(DIFF_SCOPE_MODE_KEY);
      if (saved === "hunks" || saved === "full") return saved;
    }
  } catch (err) {
    console.warn("[FileExplorer] 读取差异范围模式失败:", err);
  }
  return "full";
}

/**
 * 保存差异范围模式偏好（尽力而为，不抛异常）
 * @param {Object} api 宿主插件运行时 API
 * @param {'full'|'hunks'} mode 范围模式
 */
export function saveDiffScopeMode(api, mode) {
  try {
    if (api && api.storage && typeof api.storage.setJson === "function") {
      api.storage.setJson(DIFF_SCOPE_MODE_KEY, mode === "hunks" ? "hunks" : "full");
    }
  } catch (err) {
    console.warn("[FileExplorer] 保存差异范围模式失败:", err);
  }
}
