/**
 * 异步并发工具模块 (src/utils/async.ts)
 */

/**
 * 有限并发地按原顺序映射数组。
 * @description 目录扫描如果逐条 await，大仓库会被 IPC 往返拖住。
 *   结果按下标写回，调用方看到的顺序与串行遍历一致。
 * @param items 输入数组；非数组按空数组处理，避免宿主返回异常形态时抛错
 * @param limit 最大并发数，小于 1 时按 1 处理
 * @param fn 映射函数，可返回 Promise 或同步值
 * @returns 与输入等长、同序的结果数组
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> {
  const list = Array.isArray(items) ? items : [];
  const results = new Array<R>(list.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit || 1, list.length || 1));

  async function worker(): Promise<void> {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(list[index], index);
    }
  }

  if (!list.length) return results;
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
