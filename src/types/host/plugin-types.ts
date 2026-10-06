import type { PluginRecord } from "./host-plugins.ts";

export type { PluginRecord };

export type PluginRenderMode = "esm" | "iframe";

export type PluginLocalizedMap = Record<string, string>;

/** 插件可声明的敏感数据域（privacy 声明中的取值）。 */
export const SENSITIVE_SCOPES = [
  "apiKeys",
  "privacyConfig",
  "systemPrompts",
  "customHeaders",
  "mcpSecrets",
  "subAgents",
  "personalization",
  "conversations",
  "messages",
  "memos",
  "memory",
  "scheduledTasks",
  "checkpoints",
  "logs",
  "usage",
  "git",
  "ssh",
  "browserData",
  "userscripts",
  "remoteControl",
  "plugins",
  "terminal",
  "filesystem",
  "window",
  "storage",
  "updater",
  "toolApproval",
] as const;

export type SensitiveScope = (typeof SENSITIVE_SCOPES)[number];

export const isSensitiveScope = (value: string): value is SensitiveScope =>
  (SENSITIVE_SCOPES as readonly string[]).includes(value);

/** 插件面板定义（plugin.json 的 panels 项，已由 Rust 侧归一化）。 */
export type PluginPanelDefinition = {
  id: string;
  title: PluginLocalizedMap;
  entry: string;
  icon: string;
  widthHint: string;
};

/** 渲染层使用的插件视图模型（PluginRecord 解析后的形态）。 */
export type PluginView = {
  pluginId: string;
  name: PluginLocalizedMap;
  description: PluginLocalizedMap;
  version: string;
  author: string;
  homepage: string;
  license: string;
  icon: string;
  renderMode: PluginRenderMode;
  entry: string;
  panels: PluginPanelDefinition[];
  locales: Record<string, string>;
  styles: string[];
  privacy: SensitiveScope[];
  privacyNote: string;
  minAppVersion: string;
  enabled: boolean;
  installPath: string;
  sourcePath: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type PluginDeniedDomain = {
  reason: "privacy-declaration-missing";
  scope: SensitiveScope;
};

export type MetadataResponse = {
  generatedAt: number;
  domains: Record<string, unknown>;
  denied: Record<string, PluginDeniedDomain>;
  withheld: Record<string, string[]>;
  unknown: string[];
};

export type MetadataRequest = {
  domain: string;
  params?: Record<string, unknown>;
};
