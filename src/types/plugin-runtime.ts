/**
 * 宿主注入给插件的运行时 API（`mount(container, api)` 的第二个参数）类型。
 *
 * 真源：Snow App `src/renderer/plugins/pluginApi.ts:80` 的 `PluginRuntimeApi`，
 * 挂载点在 `src/renderer/plugins/pluginRuntime.ts:162`。该文件含 `import * as React` 与
 * metadata 模块的运行时依赖，无法逐字快照，故本文件是**手写镜像**（不像 src/types/host/
 * 那样由 tools/sync-host-api.mjs 做校验和验证）；签名以宿主 commit 237b2bb 为准，
 * 宿主改动后需人工核对本文件。
 *
 * 文件写操作必须走 `api.write`：宿主在这里按 plugin.json 的 privacy scopes 做门控
 * （`describeWriteDomains`：`granted = !definition.scope || granted.has(scope)`），
 * 原始 `window.snow` 通道没有这层门控。
 */

import type {
  MetadataResponse,
  PluginView,
  SensitiveScope,
} from "./host/plugin-types.ts";
import type {
  PluginWriteDenied,
  PluginWriteDomainSummary,
  PluginWriteResponse,
} from "./host/plugin-writes-types.ts";
import type { Locale } from "./host/shared-locale.ts";
import type { BatchWorkspaceDeleteResult } from "./host/host-workspace.ts";

/** 宿主翻译模板的插值取值。 */
export type TranslationValues = Record<string, string | number>;

/** `api.t` 的选项。 */
export type TranslateOptions = {
  /** 词条缺失时使用的兜底文本；省略时返回 key 本身。 */
  defaultValue?: string;
  /** `{{name}}` 占位符的替换表。 */
  values?: TranslationValues;
};

/** 元数据采集入参（宿主 `src/renderer/plugins/metadata/index.ts:102`）。 */
export type MetadataCollectOptions = {
  /** 传给该域的查询参数，例如按目录过滤。 */
  params?: Record<string, unknown>;
};

/** 元数据订阅句柄（宿主 `src/renderer/plugins/metadata/index.ts:170`）。 */
export type MetadataSubscription = {
  /** 取消订阅；面板卸载时必须调用，否则宿主的轮询定时器会一直跑。 */
  unsubscribe: () => void;
};

/** 单个元数据域的能力描述（宿主 `src/renderer/plugins/metadata/index.ts:25-31`）。 */
export type MetadataDomainSummary = {
  /** 域标识，作为 `metadata.get` 的入参。 */
  id: string;
  /** 该域要求的隐私 scope；null 表示非敏感、任何插件都可读。 */
  scope: SensitiveScope | null;
  /** 当前插件是否已获得该域的读取授权。 */
  granted: boolean;
  /** 是否为实时域（宿主快照变化即重新推送）。 */
  live: boolean;
  /** 域内被识别为敏感的字段名到 scope 的映射。 */
  sensitiveFields: Record<string, SensitiveScope>;
};

/** `api.metadata`：只读地取宿主上下文快照。 */
export type PluginMetadataApi = {
  /**
   * 采集一个或多个元数据域。
   * @param domain 域标识或标识数组
   * @param options 采集参数
   * @returns `domains` 为已授权数据，`denied` 给出未授权原因，`withheld` 给出被裁剪的敏感字段
   */
  get: (
    domain: string | string[],
    options?: MetadataCollectOptions,
  ) => Promise<MetadataResponse>;
  /**
   * 订阅某元数据域的变化。
   * @param domain 域标识
   * @param listener 每次采集结果回调
   * @param options 采集参数；`intervalMs` 指定轮询间隔，省略且非实时域时只推一次初值
   */
  subscribe: (
    domain: string,
    listener: (response: MetadataResponse) => void,
    options?: MetadataCollectOptions & {
      /** 轮询间隔毫秒；实时域由宿主快照驱动，不需要该值。 */
      intervalMs?: number;
    },
  ) => Promise<MetadataSubscription>;
  /** 列出宿主当前提供的全部元数据域及其授权状态（同步，无 IO）。 */
  domains: () => MetadataDomainSummary[];
};

/** 插件私有 KV 存储；值必须是字符串，对象请用 `setJson`。 */
export type PluginStorageApi = {
  /**
   * 读一个键。
   * @description 宿主把全量值预载进内存缓存，这里同步命中，不会发起 IO。
   */
  get: (key: string) => Promise<string | null>;
  /** 写一个键：先更新内存缓存，再落宿主存储。 */
  set: (key: string, value: string) => Promise<void>;
  /** 删除一个键（缓存与宿主存储同时移除）。 */
  remove: (key: string) => Promise<void>;
  /** 取全部键值对快照。 */
  all: () => Promise<Record<string, string>>;
  /**
   * 按 JSON 读一个键。
   * @param fallback 键不存在或 JSON 解析失败时返回该值
   */
  getJson: <T>(key: string, fallback: T) => Promise<T>;
  /** 按 JSON 写一个键；`value` 为 undefined 时宿主序列化为 null。 */
  setJson: (key: string, value: unknown) => Promise<void>;
};

/** `api.net.fetch` 的入参。 */
export type PluginNetRequestOptions = {
  /** HTTP 方法，省略时由宿主按默认处理（通常为 GET）。 */
  method?: string;
  /** 请求头。 */
  headers?: Record<string, string>;
  /** 请求体文本。 */
  body?: string;
  /** 超时毫秒；超时以 `error` 字段返回而非 reject。 */
  timeoutMs?: number;
};

/** `api.net.fetch` 的返回：宿主代发请求的结果，网络失败不 reject。 */
export type PluginNetResponse = {
  /** HTTP 状态是否 2xx。 */
  ok: boolean;
  /** 响应状态码；请求未到达远端时为 0。 */
  status: number;
  /** 状态文本。 */
  statusText: string;
  /** 响应头。 */
  headers: Record<string, string>;
  /** 响应体文本。 */
  body: string;
  /** 实际请求到的 URL（重定向后）。 */
  url: string;
  /** 失败原因；成功时为 null。 */
  error: string | null;
};

/** 经宿主代发 HTTP，绕开渲染进程的 CORS 与混合内容限制。 */
export type PluginNetApi = {
  /**
   * 代发一次请求。
   * @param url 目标绝对地址
   * @param options 方法/请求头/请求体文本/超时毫秒；省略即用宿主默认值
   * @returns 宿主代发结果，网络与超时失败都落在返回的 `error` 字段上，本方法不 reject
   */
  fetch: (
    url: string,
    options?: PluginNetRequestOptions,
  ) => Promise<PluginNetResponse>;
};

/** `filesystem.rename` 的入参（宿主 `src/renderer/plugins/writes/domains/admin.ts:882-896`）。 */
export type FilesystemRenameParams = {
  /** 工作区根绝对路径，宿主用它校验操作没有越出工作区。 */
  rootPath: string;
  /** 被改名条目的绝对路径。 */
  entryPath: string;
  /** 新名称（仅名称，不含路径分隔符）。 */
  newName: string;
};

/** `filesystem.delete` 的入参（宿主 `src/renderer/plugins/writes/domains/admin.ts:899-912`）。 */
export type FilesystemDeleteParams = {
  /** 工作区根绝对路径。 */
  rootPath: string;
  /** 被删除条目的绝对路径。 */
  entryPath: string;
};

/** `filesystem.deleteBatch` 的入参（宿主 `src/renderer/plugins/writes/domains/admin.ts:915-927`）。 */
export type FilesystemDeleteBatchParams = {
  /** 工作区根绝对路径。 */
  rootPath: string;
  /** 待删除条目的绝对路径列表。 */
  entryPaths: string[];
};

/** `filesystem.writeFile` 的入参（宿主 `src/renderer/plugins/writes/domains/admin.ts:870-879`）。 */
export type FilesystemWriteFileParams = {
  /** 目标文件绝对路径。 */
  filePath: string;
  /** 完整文件内容（覆盖写，非追加）。 */
  content: string;
};

/** 文件写动作 id 到其 `data` 结构的映射，供 `ok` 分支窄化后使用。 */
export type FilesystemWriteData = {
  /** 宿主回传本次写入的文件路径。 */
  "filesystem.writeFile": { filePath: string };
  /** 宿主回传改名三要素。 */
  "filesystem.rename": FilesystemRenameParams;
  /** 宿主回传删除目标。 */
  "filesystem.delete": FilesystemDeleteParams;
  /** 批量删除直接透传宿主结果：`deleted` 成功项，`failed` 含逐项原因。 */
  "filesystem.deleteBatch": BatchWorkspaceDeleteResult;
};

/** 单个文件写动作的入参映射（键为宿主全名，值为该动作的请求体形状）。 */
export type FilesystemWriteParams = {
  /** 覆盖写文件内容：目标绝对路径 + 全文，宿主动作 `admin.ts:870-879`。 */
  "filesystem.writeFile": FilesystemWriteFileParams;
  /** 工作区内改名：根目录 + 条目路径 + 新名，宿主动作 `admin.ts:882-896`。 */
  "filesystem.rename": FilesystemRenameParams;
  /** 删除单个条目：根目录 + 条目路径，宿主动作 `admin.ts:899-912`。 */
  "filesystem.delete": FilesystemDeleteParams;
  /** 批量删除：根目录 + 条目路径数组，宿主动作 `admin.ts:915-927`。 */
  "filesystem.deleteBatch": FilesystemDeleteBatchParams;
};

/** 文件写动作 id 的字面量联合，避免拼错动作名后静默失败。 */
export type FilesystemWriteActionId = keyof FilesystemWriteParams;

/**
 * filesystem 域的动作名，去掉 `filesystem.` 前缀的写法。
 * @description 从上面两张表的键反推（不是手写清单），所以加动作时只改表即可。
 *   `api.write.run` 要的是全名，插件内包装函数按全名索引 `FilesystemWriteParams`/`FilesystemWriteData`。
 */
export type FilesystemWriteActionName = FilesystemWriteActionId extends `filesystem.${infer TName}`
  ? TName
  : never;

/** `filesystem` 域的便捷方法集合（宿主按动作名自动挂出）。 */
export type FilesystemWriteApi = {
  /** 覆盖写入文件内容。 */
  writeFile: (params: FilesystemWriteFileParams) => Promise<PluginWriteResult<"filesystem.writeFile">>;
  /** 重命名工作区内的文件或目录。 */
  rename: (params: FilesystemRenameParams) => Promise<PluginWriteResult<"filesystem.rename">>;
  /** 删除工作区内的文件或目录。 */
  delete: (params: FilesystemDeleteParams) => Promise<PluginWriteResult<"filesystem.delete">>;
  /** 批量删除，逐项报告成败。 */
  deleteBatch: (params: FilesystemDeleteBatchParams) => Promise<PluginWriteResult<"filesystem.deleteBatch">>;
};

/**
 * 写动作的通用返回，在宿主 `PluginWriteResponse` 之上把 `data` 按动作 id 收窄。
 */
export type PluginWriteResult<TAction extends FilesystemWriteActionId = FilesystemWriteActionId> = {
  /** 是否执行成功；未授权与异常都为 false，不 reject。 */
  ok: boolean;
  /** 实际执行的 `domain.action` 标识。 */
  action: string;
  /** 动作成功时宿主回传的数据，结构由各动作定义。 */
  data?: FilesystemWriteData[TAction];
  /** 未授权或动作不存在时的拒绝原因。 */
  denied?: PluginWriteDenied;
  /** 失败原因文本；未提供时按动作各自的默认文案处理。 */
  error?: string;
};

/**
 * 写动作的通用返回直接复用宿主快照的 `PluginWriteResponse`（`src/types/host/plugin-writes-types.ts:40`），
 * 本文件不再另立同名类型——曾经重复定义过一次，字段虽一致，但两处会随宿主漂移。
 */

/**
 * `api.write`：受 privacy 门控的写通道。
 *
 * 宿主既提供通用 `run(actionId, params)`，也按 `WRITE_ACTION_IDS` 把每个动作挂成
 * `api.write.<domain>.<action>(params)`（宿主 `src/renderer/plugins/pluginApi.ts:109-132`），后者可获得类型检查。
 */
/**
 * `system` 域本插件实际调用的动作全名（宿主 `src/renderer/plugins/writes/domains/system.ts:46-71`）。
 * @description 这两个动作宿主只回 `data`、插件不读，所以不像 filesystem 那样建入参/返回映射表，
 *   只把 id 列成联合，好让 `api.write.run` 的 actionId 不是裸 string。
 */
export type SystemWriteActionId =
  | "system.writeClipboardText"
  | "system.showItemInFolder";

/** `system` 域动作名，去掉 `system.` 前缀（与 `FilesystemWriteActionName` 同一手法，从联合反推）。 */
export type SystemWriteActionName = SystemWriteActionId extends `system.${infer TName}`
  ? TName
  : never;

/** `api.write.run` 能接受的全名：filesystem 表反推 + system 两个动作。插件不声明 `terminal` 域动作。 */
export type WriteActionId = FilesystemWriteActionId | SystemWriteActionId;

export type PluginWriteApi = {
  /**
   * 通用入口：按 `domain.action` 执行写动作。
   * @param actionId 形如 `filesystem.rename`；只接受本文件列出的 filesystem/system 动作
   * @param params 动作参数
   */
  run: (
    actionId: WriteActionId,
    params?: Record<string, unknown>,
  ) => Promise<PluginWriteResponse>;
  /** 列出全部写域及其授权状态（同步）。 */
  domains: () => PluginWriteDomainSummary[];
  /** filesystem 域便捷方法；需要 plugin.json 声明 `filesystem` scope。 */
  filesystem: FilesystemWriteApi;
};

/** 插件资源访问。 */
export type PluginAssetsApi = {
  /**
   * 把插件目录内的相对路径解析为可加载 URL。
   * @returns 解析失败返回 null（例如文件不存在）
   */
  resolve: (relativePath: string) => Promise<string | null>;
};

/** 宿主借给插件的 UI 能力。 */
export type PluginUiApi = {
  /**
   * 宿主提供的 React 实例，用于与宿主共享 dispatcher。
   * @description 本插件是原生 DOM 实现，不消费该字段，故按 unknown 声明；
   *              若将来引入 React，需改为宿主版本类型并与宿主对齐。
   */
  React: unknown;
  /** 按名称取宿主图标（如 `lucide:FolderTree`），未命中返回 null。 */
  icon: (name: string) => unknown;
};

/** 宿主注入的插件运行时 API 全貌。 */
export type PluginRuntimeApi = {
  /** 插件 id，等同 plugin.json 的 `id`，也是 `snow.readPluginFile` 的第一个参数。 */
  id: string;
  /** 插件版本号，来自宿主已安装的 plugin.json。 */
  version: string;
  /** 当前语言下的插件显示名。 */
  name: string;
  /** 插件在宿主数据目录下的安装根，懒加载 chunk 的绝对路径由此拼出。 */
  installPath: string;
  /** 宿主当前语言。 */
  locale: Locale;
  /** 按宿主词条表翻译。 */
  t: (key: string, options?: TranslateOptions) => string;
  /** 宿主上下文元数据（只读）。 */
  metadata: PluginMetadataApi;
  /** 受权限门控的写通道。 */
  write: PluginWriteApi;
  /** 插件私有持久化 KV。 */
  storage: PluginStorageApi;
  /** 宿主代发 HTTP。 */
  net: PluginNetApi;
  /** 插件目录资源解析。 */
  assets: PluginAssetsApi;
  /** 宿主 UI 能力。 */
  ui: PluginUiApi;
  /** 带 `[plugin:<id>]` 前缀的日志输出，落到宿主控制台。 */
  log: (...args: unknown[]) => void;
};

/** 供 docs/host-api.md 引用的宿主侧视图类型，确认快照可用。 */
export type { PluginView };

/** 插件入口模块需要导出的形态（宿主 `src/renderer/plugins/pluginRuntime.ts:8-16` 的 `PluginModuleExports`）。 */
export type PluginModuleExports = {
  /** 宿主优先取具名 `mount`，其次 `render`，最后 `default.mount`。 */
  default?: unknown;
  /**
   * 面板挂载入口。
   * @param container 宿主分配的面板根容器，插件只在此容器内渲染
   * @param api 宿主注入的运行时 API
   * @returns 可返回卸载函数，或返回带 `unmount` 的对象；两者都不返回时宿主改用模块级 `unmount`
   */
  mount?: (
    container: HTMLElement,
    api: PluginRuntimeApi,
  ) => void | (() => void) | { unmount?: () => void };
  /** `mount` 的别名入口，宿主在 `mount` 缺失时使用。 */
  render?: (
    container: HTMLElement,
    api: PluginRuntimeApi,
  ) => void | (() => void) | { unmount?: () => void };
  /** 模块级卸载函数（宿主在 mount 未返回清理句柄时调用）。 */
  unmount?: () => void;
};

/**
 * 宿主在动态 import 插件入口**之前**挂到 window 上的全局作用域
 * （宿主 `src/renderer/plugins/pluginRuntime.ts:105-117`）。
 *
 * 懒加载 chunk 用 `plugin.id` 拼 `snow.readPluginFile` 的入参：chunk 经 blob URL 加载，
 * 拿不到入口闭包里的 `api`，只能从这个全局取插件 id。
 */
export type SnowAppPluginScope = {
  /** 宿主提供的 React 命名空间；本插件不使用。 */
  React: unknown;
  /** React.createElement 快捷方式；本插件不使用。 */
  createElement: unknown;
  /** 与入口 `mount` 第二参数同一个运行时 API 实例。 */
  api: PluginRuntimeApi;
  /** 宿主预加载的 lucide 图标表，键为图标名。 */
  icons: Record<string, unknown>;
  /** 宿主当前语言。 */
  locale: Locale;
  /** 已安装插件的身份信息。 */
  plugin: {
    /** 插件 id，等同 plugin.json 的 `id`。 */
    id: string;
    /** 插件版本号。 */
    version: string;
    /** 插件在宿主数据目录下的安装根。 */
    installPath: string;
  };
};

declare global {
  interface Window {
    /** 宿主注入的插件全局作用域；仅 ESM 面板插件可见，iframe 插件走另一套桥接。 */
    SnowAppPlugin?: SnowAppPluginScope;
  }
}
