import type { SnowApi } from "../../../src/types/snow-api.ts";

/**
 * window 桩的形状：Node 测试环境没有 window，宿主契约里它必然存在。
 * @description 被测源码调用 snow 前都用 `typeof snow.xxx === "function"` 探测能力，
 *   桩只装 snow 一个字段，其余宿主成员保持整体缺失。
 */
export type SnowWindowStub = { snow: Partial<SnowApi> };

/** 装上 window 全局（Node 测试环境本没有它；用 defineProperty 装卸可控且可逆）。 */
export function installWindow(stub: SnowWindowStub): void {
  Object.defineProperty(globalThis, "window", {
    value: stub,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

/** 卸掉 window 全局，回到无 window 的状态。 */
export function uninstallWindow(): void {
  Reflect.deleteProperty(globalThis, "window");
}

/** 还原 window 全局：装桩前不存在就移除，否则按原值装回。 */
export function restoreWindow(previous: unknown): void {
  if (previous === undefined) uninstallWindow();
  else
    Object.defineProperty(globalThis, "window", {
      value: previous,
      configurable: true,
      writable: true,
      enumerable: true,
    });
}
