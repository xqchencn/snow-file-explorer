/**
 * 编码小工具 (src/utils/encoding.ts)
 * @description HTTP 一路有两处要把凭据写成 base64（curl 的 `-u`、`Authorization: Basic 用户 密码`），
 *   两边共用这一个实现，不各写一份。
 */

/**
 * UTF-8 安全的 base64。
 * @param value 原文（可能含中文与 emoji）
 * @returns base64 串
 * @description 不能直接用 `btoa`：它只收 Latin-1，中文用户名会当场抛错。
 *   渲染进程有 btoa，纯 node 的测试环境没有，故两条路都备着。
 */
export function encodeBase64Utf8(value: string): string {
  const text = String(value ?? "");
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof globalThis.btoa === "function") return globalThis.btoa(binary);
  return Buffer.from(text, "utf8").toString("base64");
}
