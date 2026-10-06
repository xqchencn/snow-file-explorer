/** 插件完整记录（管理 UI 与插件运行时使用）。 */
export type PluginRecord = {
  pluginId: string;
  /** 本地化名称 JSON：{"default": "...", "zh-CN": "..."} */
  name: string;
  /** 本地化描述 JSON。 */
  description: string;
  version: string;
  author: string;
  homepage: string;
  license: string;
  /** lucide:IconName / 相对路径 / URL */
  icon: string;
  /** "esm" | "iframe" */
  renderMode: string;
  entry: string;
  enabled: boolean;
  installPath: string;
  sourcePath: string;
  manifestJson: string;
  /** 面板定义 JSON 数组：[{ id, title, entry, icon, widthHint }] */
  panels: string;
  /** 语言包映射 JSON：{"zh-CN": "locales/zh-CN.json"} */
  locales: string;
  /** 需要注入的样式文件列表 JSON。 */
  styles: string;
  /** 声明使用的敏感数据域。 */
  privacy: string[];
  privacyNote: string;
  minAppVersion: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

/** 插件持久化 KV 条目。 */
export type PluginStorageValue = {
  key: string;
  value: string;
};

export type PluginHttpRequestOptions = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

export type PluginHttpResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  url: string;
  error: string | null;
};
