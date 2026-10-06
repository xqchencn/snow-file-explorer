/**
 * 跨进程共享的语言（Locale）定义与规范化。
 *
 * 桌面 Renderer（i18n）、Mobile 远控页（src/mobile）与主进程（远控服务注入
 * 桌面语言）都依赖同一份“支持哪些语言 + 如何把任意语言标记归一化”的规则，
 * 因此放在 shared 中，避免三处实现漂移。
 */

export const SUPPORTED_LOCALES = ["en", "zh-CN", "zh-TW"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** 浏览器 localStorage 中的语言键；桌面 Renderer 与 Mobile 页各自独立存储。 */
export const LOCALE_STORAGE_KEY = "snow.locale";

export const isSupportedLocale = (
  value: string | null | undefined,
): value is Locale => {
  return SUPPORTED_LOCALES.some((locale) => locale === value);
};

export const normalizeLocale = (
  value: string | null | undefined,
): Locale | null => {
  if (!value) {
    return null;
  }

  if (isSupportedLocale(value)) {
    return value;
  }

  const normalizedValue = value.toLowerCase();

  if (
    normalizedValue.startsWith("zh-tw") ||
    normalizedValue.startsWith("zh-hant")
  ) {
    return "zh-TW";
  }

  if (
    normalizedValue.startsWith("zh-cn") ||
    normalizedValue.startsWith("zh-hans") ||
    normalizedValue === "zh"
  ) {
    return "zh-CN";
  }

  if (normalizedValue.startsWith("en")) {
    return "en";
  }

  return null;
};
