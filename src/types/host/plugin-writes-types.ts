import type { Locale } from "./shared-locale.ts";
import type { PluginView, SensitiveScope } from "./plugin-types.ts";

export type PluginWriteParams = Record<string, unknown>;

export type PluginWriteContext = {
  plugin: PluginView;
  locale: Locale;
  params: PluginWriteParams;
  log: (...args: unknown[]) => void;
};

export type PluginWriteActionDefinition = {
  domain: string;
  action: string;
  scope: SensitiveScope | null;
  summary: Record<Locale, string>;
  invoke: (context: PluginWriteContext) => Promise<unknown>;
};

export type PluginWriteActionSummary = {
  id: string;
  scope: SensitiveScope | null;
  granted: boolean;
  summary: string;
};

export type PluginWriteDomainSummary = {
  id: string;
  granted: boolean;
  actions: PluginWriteActionSummary[];
};

export type PluginWriteDenied = {
  reason:
    "write-declaration-missing" | "unknown-action" | "unsupported-runtime";
  scope?: SensitiveScope;
};

export type PluginWriteResponse = {
  ok: boolean;
  action: string;
  data?: unknown;
  denied?: PluginWriteDenied;
  error?: string;
};
