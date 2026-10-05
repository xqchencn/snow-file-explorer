/**
 * 有限并发地按原顺序映射数组。
 * @description 目录扫描如果逐条 await，大仓库会被 IPC 往返拖住。
 *   结果按下标写回，调用方看到的顺序与串行遍历一致。
 * @param {Array} items 输入
 * @param {number} limit 最大并发
 * @param {(item: any, index: number) => Promise<any>} fn 映射函数
 * @returns {Promise<Array>}
 */
export async function mapPool(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit || 1, list.length || 1));

  async function worker() {
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
