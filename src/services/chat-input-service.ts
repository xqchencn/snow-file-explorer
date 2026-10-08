/**
 * 聊天输入框追加事务。
 * @description 这里直接承载插件与宿主 runtime 之间的时序边界：
 *   先读当前内容，再计算本次实际追加文本，写入后只确认这一次追加。
 *   写入已发出但快照暂未更新时不能再次写，否则宿主最终会得到重复文本。
 */

import { appendChatText } from "./file-service.ts";

/** 宿主 runtime 中插件实际读取的聊天输入部分。 */
export type ChatInputRuntime = {
  chatInput?: {
    inputText?: string | null;
  } | null;
} | null;

/** 一次追加事务的结论。 */
export type ChatInputInsertStatus =
  | "confirmed"
  | "not-ready"
  | "unconfirmed"
  | "failed";

/** 追加事务的宿主适配器。 */
export type ChatInputInsertOptions = {
  readRuntime: () => Promise<ChatInputRuntime>;
  insertText: (text: string) => Promise<unknown>;
  /** 输入框真实挂载探针；宿主 runtime 会保留卸载前的旧快照，不能用它代替 DOM 状态。 */
  isInputMounted?: () => boolean;
  /**
   * 当前 contenteditable 的实时空值探针；返回 undefined 表示交给 runtime 提供正文，
   * 返回 null 表示输入框已卸载。runtime 只做状态确认，不能拿陈旧草稿决定首个分隔符。
   */
  readCurrentText?: () => string | null | undefined;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

/**
 * 清理宿主 contenteditable 的“视觉为空、内部仍是单个换行”状态。
 * @description 宿主会把单个换行标成 data-empty=true，但 insertText 仍按内部 value
 * 追加；先通过真实 input 事件同步空串，后续追加才不会从第二行开始。
 */
export function normalizeEmptyChatInput(input: HTMLElement): boolean {
  const content = input.textContent ?? "";
  const isSingleBreakEmpty =
    input.dataset.empty === "true" &&
    content.replace(/\n/g, "") === "" &&
    content.length <= 1;
  if (!isSingleBreakEmpty) return false;

  input.replaceChildren();
  const EventCtor = input.ownerDocument?.defaultView?.Event || Event;
  input.dispatchEvent(new EventCtor("input", { bubbles: true }));
  return true;
}

/**
 * 把文本追加到宿主聊天输入框，并确认本次追加已经落入 runtime。
 * @description `not-ready` 只表示输入框尚未挂载，调用方可以重新读取后重试；
 *   `unconfirmed` 表示写动作已经发出但快照未跟上，调用方必须停止追加，不能拿旧快照再次写入。
 */
export async function insertChatText(
  text: string,
  options: ChatInputInsertOptions,
): Promise<ChatInputInsertStatus> {
  // runtime.chatInput.inputText 在宿主输入区卸载后仍保留最后一次发布值。
  // 先看真实 DOM，避免全屏切换时把“旧草稿”误当成当前可写输入框。
  if (options.isInputMounted && !options.isInputMounted()) return "not-ready";
  const runtime = await options.readRuntime();
  const liveText = options.readCurrentText?.();
  if (liveText === null) return "not-ready";
  const currentText = liveText ?? runtime?.chatInput?.inputText;
  if (typeof currentText !== "string") return "not-ready";

  // 每一次尝试都基于本次读取的内容重新计算 appendedText；禁止复用上次尝试的值。
  const appendedText = appendChatText(currentText, text);
  try {
    await options.insertText(appendedText);
  } catch {
    return "failed";
  }

  const timeoutMs = options.timeoutMs ?? 1200;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    const nextRuntime = await options.readRuntime();
    const nextText = nextRuntime?.chatInput?.inputText;
    // 确认必须检查本次真正发出的 appendedText，而不是只看写动作返回成功。
    if (typeof nextText === "string" && nextText.endsWith(appendedText)) {
      return "confirmed";
    }
  }

  return "unconfirmed";
}

/**
 * 在输入框尚未挂载时重试追加；一旦写入已发出但未确认，立即停止重写。
 * @description 重试边界只由 `not-ready` / `failed` 打开；`unconfirmed` 不能重试，
 *   因为宿主事件可能已经同步改了真实输入框，只是 runtime effect 还没发布。
 */
export async function insertChatTextWithRetry(
  text: string,
  options: ChatInputInsertOptions & {
    attempts?: number;
    retryDelayMs?: number;
  },
): Promise<ChatInputInsertStatus> {
  const attempts = options.attempts ?? 3;
  let status: ChatInputInsertStatus = "not-ready";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    status = await insertChatText(text, options);
    if (status === "confirmed" || status === "unconfirmed") return status;
    if (attempt + 1 < attempts) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, options.retryDelayMs ?? 250),
      );
    }
  }
  return status;
}
